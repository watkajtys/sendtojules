// Global state
let capturedHtml = null;
let sourcesCache = null;

// Constants
const API_BASE_URL = 'https://jules.googleapis.com/v1alpha';

// --- State Management ---

function resetState() {
    capturedHtml = null;
    sourcesCache = null;
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
    chrome.storage.session.remove(['julesCapturedHtml', 'julesCapturedTabId']);
}

// --- API Interaction ---

async function fetchSources(apiKey) {
    if (sourcesCache) return sourcesCache;

    const sourcesApiUrl = `${API_BASE_URL}/sources`;
    let allSources = [];
    let nextPageToken = null;

    try {
        do {
            const url = nextPageToken ? `${sourcesApiUrl}?pageToken=${nextPageToken}` : sourcesApiUrl;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-Goog-Api-Key': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`API Error ${response.status}: ${errorBody}`);
            }

            const data = await response.json();
            if (data.sources) {
                allSources.push(...data.sources);
            }
            nextPageToken = data.nextPageToken;
        } while (nextPageToken);

        sourcesCache = allSources.map(source => ({
            id: source.name,
            name: source.id
        }));
        return sourcesCache;

    } catch (error) {
        console.error('Failed to fetch sources:', error);
        chrome.runtime.sendMessage({ action: "julesError", error: "Failed to fetch sources. Check console for details." });
        return [];
    }
}

async function createJulesSession(task, html, sourceName, apiKey) {
    const sessionsApiUrl = `${API_BASE_URL}/sessions`;
    const cleanTask = task.trim();
    const combinedPrompt = `${cleanTask}\n\nHere is the HTML context for the element I selected:\n\`\`\`html\n${html}\n\`\`\``;
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
    chrome.storage.session.get(['julesCapturedHtml'], (result) => {
        const storedHtml = result.julesCapturedHtml;
        if (storedHtml) {
            capturedHtml = storedHtml;
        }
        const state = capturedHtml ? 'elementCaptured' : 'readyToSelect';
        sendResponse({ state: state, capturedHtml: capturedHtml });
    });

    if (sourcesCache) {
        chrome.runtime.sendMessage({ action: "sourcesLoaded", sources: sourcesCache });
    } else {
        chrome.storage.sync.get(['julesApiKey'], async (result) => {
            if (!result.julesApiKey) {
                chrome.runtime.sendMessage({ action: 'julesError', error: "API Key not set" });
                return;
            }
            const sources = await fetchSources(result.julesApiKey);
            chrome.runtime.sendMessage({ action: "sourcesLoaded", sources: sources });
        });
    }
}

async function handleStartSelection() {
    resetState();

    // Pre-fetch sources
    chrome.storage.sync.get(['julesApiKey'], async (result) => {
        if (result.julesApiKey) {
            await fetchSources(result.julesApiKey);
        }
    });

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        chrome.storage.session.set({ 'julesCapturedTabId': tab.id });

        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["selector.css"] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["selector.js"] });
        await chrome.tabs.sendMessage(tab.id, { action: "startSelection" });
    } catch (err) {
        console.error("Failed to inject scripts or send message:", err);
        // Optionally, send an error to the popup
        chrome.runtime.sendMessage({ action: "julesError", error: "Could not start selection on the active tab." });
    }
}

function handleElementCaptured(message) {
    capturedHtml = message.html;
    chrome.storage.session.set({ 'julesCapturedHtml': message.html });
    chrome.action.setBadgeText({ text: '✅' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}

function handleSubmitTask(message) {
    const { task, repositoryId } = message;

    const onHtmlReady = (html) => {
        chrome.storage.sync.get(['julesApiKey'], (result) => {
            if (!result.julesApiKey) {
                chrome.runtime.sendMessage({ action: "julesError", error: "API Key not set. Please set it in Options." });
                return;
            }
            createJulesSession(task, html, repositoryId, result.julesApiKey);
        });
    };

    if (capturedHtml) {
        onHtmlReady(capturedHtml);
    } else {
        chrome.storage.session.get(['julesCapturedHtml'], (result) => {
            if (result.julesCapturedHtml) {
                capturedHtml = result.julesCapturedHtml; // Restore
                onHtmlReady(capturedHtml);
            } else {
                chrome.runtime.sendMessage({ action: "julesError", error: "No element captured." });
            }
        });
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
