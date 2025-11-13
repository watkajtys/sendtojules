// Global state
let capturedData = null;
let capturedLogs = [];

// Debugging state is now managed in chrome.storage.local
// { debuggingTabId: number | null }

// Constants
const DEBUGGER_VERSION = "1.3";
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

async function resetDebuggerState() {
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (debuggingTabId) {
        await chrome.debugger.detach({ tabId: debuggingTabId }).catch(err => {
            // Ignore errors if the debugger is already detached (e.g., by DevTools)
            if (!err.message.includes("No debugger with given target id") &&
                !err.message.includes("Target is not attached")) {
                console.error("Error detaching debugger:", err);
            }
        });
    }
    await chrome.storage.local.remove('debuggingTabId');
    capturedLogs = [];
    console.log("Jules debugger state reset.");
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

async function createJulesSession(task, data, sourceName, apiKey, logs) {
    const sessionsApiUrl = `${API_BASE_URL}/sessions`;
    const cleanTask = task.trim();
    const simpleTitle = cleanTask.split('\n')[0].substring(0, 80);
    let prompt = cleanTask;

    if (data && data.outerHTML) {
        // Construct a more detailed context string when data is available
        let contextString = `Tag: ${data.tag}`;
        if (data.id) contextString += `, ID: ${data.id}`;
        if (data.classes) contextString += `, Classes: ${data.classes}`;
        prompt = `${cleanTask}\n\nHere is the HTML context for the element I selected (${contextString}):\n\`\`\`html\n${data.outerHTML}\n\`\`\``;
    }

    if (logs && logs.length > 0) {
        const formattedLogs = logs.map(log => `[${log.timestamp}] [${log.level}] ${log.message}`).join('\n');
        prompt += `\n\n--- Captured Console Logs ---\n${formattedLogs}\n--- End Logs ---`;
    }

    const payload = {
        prompt: prompt,
        sourceContext: {
            source: sourceName,
            githubRepoContext: {
                startingBranch: ""
            }
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

async function handleGetPopupData(sendResponse) {
    // This function is now async to handle storage calls cleanly.
    try {
        const sessionResult = await chrome.storage.session.get(['julesCapturedData']);
        capturedData = sessionResult.julesCapturedData || null;
        const state = capturedData ? 'elementCaptured' : 'readyToSelect';

        const localResult = await chrome.storage.local.get({ mostRecentRepos: [], debuggingTabId: null });

        sendResponse({
            state: state,
            capturedHtml: capturedData ? capturedData.outerHTML : null,
            recentRepos: localResult.mostRecentRepos,
            isLogging: !!localResult.debuggingTabId
        });
    } catch (error) {
        console.error("Error getting popup data:", error);
        // It's good practice to still send a response in case of error.
        sendResponse({ error: "Failed to retrieve initial data." });
    }

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

    const onDataReady = async (data) => {
        const result = await chrome.storage.sync.get(['julesApiKey']);
        if (!result.julesApiKey) {
            chrome.runtime.sendMessage({ action: "julesError", error: "API Key not set. Please set it in Options." });
            return;
        }
        // Pass the captured logs to the session creation function
        await createJulesSession(task, data, repositoryId, result.julesApiKey, capturedLogs);

        // Important: Reset the debugger state after logs are sent.
        await resetDebuggerState();
    };

    const dataToUse = capturedData || (await chrome.storage.session.get('julesCapturedData')).julesCapturedData;

    // The logic now allows dataToUse to be null for tasks without element selection.
    // The createJulesSession function is now responsible for handling the null case.
    await onDataReady(dataToUse);
}

// --- Debugger Logic ---

function onDebuggerEvent(debuggeeId, method, params) {
    // Check storage to ensure we are only logging the correct tab.
    chrome.storage.local.get('debuggingTabId', ({ debuggingTabId }) => {
        if (!debuggingTabId || debuggeeId.tabId !== debuggingTabId) {
            return;
        }

        if (method === 'Runtime.consoleAPICalled') {
            const logEntry = {
                timestamp: new Date(params.timestamp).toISOString(),
                level: params.type,
                message: params.args.map(arg => {
                    if (arg.type === 'string') return arg.value;
                    return arg.description || JSON.stringify(arg.value) || 'Unserializable object';
                }).join(' ')
            };
            capturedLogs.push(logEntry);
        }
    });
}

async function handleToggleLogCapture(message) {
    const { enabled } = message;

    if (enabled) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.id) return;

            // Important: Attach the debugger *before* setting state,
            // so that our onDetach listener can clean up correctly if attach fails.
            await chrome.debugger.attach({ tabId: tab.id }, DEBUGGER_VERSION);
            await chrome.storage.local.set({ debuggingTabId: tab.id });
            console.log("Jules debugger attached to tab:", tab.id);

            // Enable the runtime domain to receive console events
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.enable');

        } catch (err) {
            console.error("Error attaching debugger:", err);
            chrome.runtime.sendMessage({ action: "julesError", error: `Failed to start debugger: ${err.message}` });
            await resetDebuggerState(); // Ensure cleanup on failure
        }
    } else {
        await resetDebuggerState();
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
            // We no longer reset the debugger state when the popup closes.
            // It now persists until the task is submitted or the tab is closed.
            resetState();
            break;
        case 'toggleLogCapture':
            handleToggleLogCapture(message);
            return true;
    }
});

// Reset element selection state when the user switches tabs
chrome.tabs.onActivated.addListener(() => {
    resetState();
});

// Handle debugger lifecycle events
chrome.debugger.onEvent.addListener(onDebuggerEvent);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (tabId === debuggingTabId && changeInfo.status === 'complete') {
        try {
            // Re-enable the runtime to ensure we keep capturing logs after navigation
            await chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.enable');
            console.log("Jules debugger re-enabled runtime on tab:", tabId);
        } catch (err) {
            console.error("Error re-enabling runtime on navigation:", err);
            // If the command fails, it might mean the debugger was detached.
            // Reset state to be safe.
            await resetDebuggerState();
        }
    }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (source.tabId === debuggingTabId) {
        console.log(`Jules debugger detached from tab ${source.tabId} due to: ${reason}`);
        await resetDebuggerState();
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (tabId === debuggingTabId) {
        console.log(`Jules debugger: debugged tab ${tabId} was closed. Cleaning up.`);
        await resetDebuggerState();
    }
});
