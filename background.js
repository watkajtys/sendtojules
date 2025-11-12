// Global state
let capturedData = null;

// Constants
const API_BASE_URL = 'https://jules.googleapis.com/v1alpha';
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- State Management ---

function resetState() {
    capturedData = null;
    chrome.action.setBadgeText({ text: '' });

    // Proactively clean up content scripts in the last known tab
    chrome.storage.session.get(['julesCapturedTabId'], (result) => {
        const tabId = result.julesCapturedTabId;
        if (tabId) {
            chrome.tabs.sendMessage(tabId, { action: "cleanupSelector" }).catch(err => {
                // Ignore errors if the tab was closed, but log others.
                if (!err.message.includes("Receiving end does not exist.")) {
                    console.error("Error sending cleanup message:", err);
                }
            });
        }
    });

    // Clear all session data
    chrome.storage.session.remove(['julesCapturedData', 'julesCapturedTabId']);
}

// --- API Interaction ---

async function fetchSources(apiKey) {
    // Implements a stale-while-revalidate caching strategy.

    // 1. Immediately send cached data if it exists.
    chrome.storage.local.get('julesSourcesCache', (result) => {
        if (result.julesSourcesCache && result.julesSourcesCache.sources) {
            chrome.runtime.sendMessage({
                action: "sourcesLoaded",
                sources: result.julesSourcesCache.sources
            });
        }
    });

    // 2. Always fetch fresh data in the background.
    const sourcesApiUrl = `${API_BASE_URL}/sources`;
    let allSources = [];
    let nextPageToken = null;

    try {
        do {
            const url = nextPageToken ? `${sourcesApiUrl}?pageToken=${nextPageToken}` : sourcesApiUrl;
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' }
            });

            if (!response.ok) throw new Error(`API Error ${response.status}: ${await response.text()}`);

            const data = await response.json();
            if (data.sources) allSources.push(...data.sources);
            nextPageToken = data.nextPageToken;
        } while (nextPageToken);

        const newSources = allSources.map(source => ({ id: source.name, name: source.id }));

        // 3. Get the current cache to compare against.
        const result = await chrome.storage.local.get('julesSourcesCache');
        const oldSources = result.julesSourcesCache ? result.julesSourcesCache.sources : null;

        // 4. If data is new, update cache and notify the popup.
        if (JSON.stringify(oldSources) !== JSON.stringify(newSources)) {
            await chrome.storage.local.set({
                julesSourcesCache: { sources: newSources, timestamp: Date.now() }
            });

            const action = oldSources ? "sourcesRefreshed" : "sourcesLoaded";
            chrome.runtime.sendMessage({ action: action, sources: newSources });
        }
    } catch (error) {
        console.error('Failed to fetch sources:', error);
        // Only propagate error if there's no cached data at all.
        const result = await chrome.storage.local.get('julesSourcesCache');
        if (!result.julesSourcesCache) {
            chrome.runtime.sendMessage({ action: "julesError", error: "Could not fetch sources." });
        }
    }
}

async function createJulesSession(task, data, sourceName, apiKey) {
    const sessionsApiUrl = `${API_BASE_URL}/sessions`;
    const cleanTask = task.trim();

    // Construct a more detailed context string
    let contextString = `Tag: ${data.tag}`;
    if (data.id) contextString += `, ID: ${data.id}`;
    if (data.classes) contextString += `, Classes: ${data.classes}`;

    const combinedPrompt = `${cleanTask}\n\nHere is the HTML context for the element I selected (${contextString}):\n\`\`\`html\n${data.outerHTML}\n\`\`\``;
    const simpleTitle = cleanTask.split('\n')[0].substring(0, 80);

    const payload = {
        prompt: combinedPrompt,
        sourceContext: {
            source: sourceName,
            "githubRepoContext": { "startingBranch": "main" }
        },
        title: simpleTitle
    };

    try {
        const response = await fetch(sessionsApiUrl, {
            method: 'POST',
            headers: {
                'X-Goog-Api-Key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: { message: 'Unknown API error' } }));
            throw new Error(errorData.error?.message || `API Error: ${response.status}`);
        }

        const sessionData = await response.json();
        chrome.runtime.sendMessage({ action: "julesResponse", data: sessionData });

    } catch (error) {
        console.error('Failed to create Jules session:', error);
        chrome.runtime.sendMessage({ action: "julesError", error: error.message });
    } finally {
        resetState();
    }
}


// --- Message Handlers ---

function handleGetPopupData(sendResponse) {
    // Send back the current captured state and recent repos
    chrome.storage.session.get(['julesCapturedData'], (sessionResult) => {
        capturedData = sessionResult.julesCapturedData || null;
        const state = capturedData ? 'elementCaptured' : 'readyToSelect';

        chrome.storage.local.get({ mostRecentRepos: [] }, (localResult) => {
            sendResponse({
                state: state,
                capturedHtml: capturedData ? capturedData.outerHTML : null, // For popup display
                recentRepos: localResult.mostRecentRepos
            });
        });
    });

    // Trigger the stale-while-revalidate source fetch
    chrome.storage.sync.get(['julesApiKey'], (result) => {
        if (!result.julesApiKey) {
            chrome.runtime.sendMessage({ action: 'julesError', error: "API Key not set" });
            return;
        }
        fetchSources(result.julesApiKey); // This function now handles sending messages
    });
}

async function handleStartSelection() {
    resetState();

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        chrome.storage.session.set({ 'julesCapturedTabId': tab.id });

        // Inject scripts and start selection
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["selector.css"] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["selector.js"] });
        await chrome.tabs.sendMessage(tab.id, { action: "startSelection" });
    } catch (err) {
        console.error("Failed to inject scripts or send message:", err);
        chrome.runtime.sendMessage({ action: "julesError", error: "Could not start selection on the active tab." });
    }
}

function handleElementCaptured(message) {
    capturedData = message.data;
    chrome.storage.session.set({ 'julesCapturedData': message.data });
    chrome.action.setBadgeText({ text: '✅' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}

async function handleSubmitTask(message) {
    const { task, repositoryId } = message;

    // --- Save to Most Recent ---
    const sourcesResult = await chrome.storage.local.get('julesSourcesCache');
    const allSources = sourcesResult.julesSourcesCache?.sources || [];
    const selectedSource = allSources.find(s => s.id === repositoryId);

    if (selectedSource) {
        const recentResult = await chrome.storage.local.get({ mostRecentRepos: [] });
        let recentRepos = recentResult.mostRecentRepos;
        recentRepos = recentRepos.filter(r => r.id !== selectedSource.id);
        recentRepos.unshift(selectedSource);
        if (recentRepos.length > 3) recentRepos.pop();
        await chrome.storage.local.set({ mostRecentRepos: recentRepos });
    }
    // --- End Save to Most Recent ---

    const onDataReady = (data) => {
        chrome.storage.sync.get(['julesApiKey'], (result) => {
            if (!result.julesApiKey) {
                chrome.runtime.sendMessage({ action: "julesError", error: "API Key not set. Please set it in Options." });
                return;
            }
            createJulesSession(task, data, repositoryId, result.julesApiKey);
        });
    };

    const dataToUse = capturedData || (await chrome.storage.session.get('julesCapturedData')).julesCapturedData;

    if (dataToUse) {
        capturedData = dataToUse; // Ensure global state is consistent
        onDataReady(dataToUse);
    } else {
        chrome.runtime.sendMessage({ action: "julesError", error: "No element captured." });
    }
}

// --- Event Listeners ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'getPopupData':
            handleGetPopupData(sendResponse);
            return true; // Keep message channel open for async response
        case 'startSelection':
            handleStartSelection();
            return true;
        case 'elementCaptured':
            handleElementCaptured(message);
            break;
        case 'cancelSelection':
            resetState();
            break;
        case 'submitTask':
            handleSubmitTask(message);
            return true;
        case 'popupClosed':
            resetState(); // Simplified: reset state handles cleanup
            break;
    }
});

// Reset state when the user switches tabs
chrome.tabs.onActivated.addListener(() => {
    resetState();
});
