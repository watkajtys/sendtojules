// Global state
let capturedData = null;
let capturedLogs = [];
let capturedNetworkActivity = [];

// Debugging state is now managed in chrome.storage.local
// { debuggingTabId: number | null }

// Constants
const DEBUGGER_VERSION = "1.3";
const API_BASE_URL = 'https://jules.googleapis.com/v1alpha';
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- State Management ---

function resetState(forceFullReset = false) {
    capturedData = null;
    chrome.action.setBadgeText({ text: '' });

    if (forceFullReset) {
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
        chrome.storage.session.remove(['julesCapturedData', 'julesCapturedTabId', 'viewState', 'taskPromptText']);
    }
}

async function detachDebugger() {
    // This function's sole purpose is to detach the debugger.
    // The onDetach event listener will handle cleaning up state.
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (debuggingTabId) {
        await chrome.debugger.detach({ tabId: debuggingTabId }).catch(err => {
            // It's fine if it's already detached.
            if (!err.message.includes("No debugger with given target id") &&
                !err.message.includes("Target is not attached")) {
                console.error("Error detaching debugger:", err);
            }
        });
    }
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

async function createJulesSession(task, data, sourceName, apiKey, logs, isCapturingCSS) {
    const sessionsApiUrl = `${API_BASE_URL}/sessions`;
    const cleanTask = task.trim();
    const simpleTitle = cleanTask.split('\n')[0].substring(0, 80);
    let prompt = cleanTask;

    if (data && data.outerHTML) {
        // Construct a more detailed context string when data is available
        let contextString = `Tag: ${data.tag}`;
        if (data.id) contextString += `, ID: ${data.id}`;
        if (data.classes) contextString += `, Classes: ${data.classes}`;

        if (data.selector) {
            prompt = `${cleanTask}\n\nHere is the CSS selector for the element I selected:\n\`\`\`css\n${data.selector}\n\`\`\`\n\nAnd here is the HTML context for the element I selected (${contextString}):\n\`\`\`html\n${data.outerHTML}\n\`\`\``;
        } else {
            prompt = `${cleanTask}\n\nHere is the HTML context for the element I selected (${contextString}):\n\`\`\`html\n${data.outerHTML}\n\`\`\``;
        }
    }

    if (isCapturingCSS && data && data.dimensions) {
        let dimensionsString = `\n\n--- Element Dimensions ---\n`;
        dimensionsString += `Width: ${data.dimensions.width}px, Height: ${data.dimensions.height}px\n`;
        dimensionsString += `Margin: ${data.dimensions.margin.top} ${data.dimensions.margin.right} ${data.dimensions.margin.bottom} ${data.dimensions.margin.left}\n`;
        dimensionsString += `Padding: ${data.dimensions.padding.top} ${data.dimensions.padding.right} ${data.dimensions.padding.bottom} ${data.dimensions.padding.left}\n`;
        dimensionsString += `Border: ${data.dimensions.border.top} ${data.dimensions.border.right} ${data.dimensions.border.bottom} ${data.dimensions.border.left}\n`;
        prompt += dimensionsString;
    }

    if (isCapturingCSS && data && data.computedCss) {
        let formattedCss = '';
        for (const [state, properties] of Object.entries(data.computedCss)) {
            formattedCss += `/* ${state} */\n`;
            const propEntries = Object.entries(properties);
            if (propEntries.length > 0) {
                formattedCss += `element {\n`;
                for (const [prop, value] of propEntries) {
                    formattedCss += `  ${prop}: ${value};\n`;
                }
                formattedCss += `}\n`;
            }
        }
        if (formattedCss) {
            prompt += `\n\n--- Captured Computed CSS ---\n\`\`\`css\n${formattedCss.trim()}\n\`\`\``;
        }
    }

    if (logs && logs.length > 0) {
        const formattedLogs = logs.map(log => `[${log.timestamp}] [${log.level}] ${log.message}`).join('\n');
        prompt += `\n\n--- Captured Console Logs ---\n${formattedLogs}\n--- End Logs ---`;
    }

    if (capturedNetworkActivity && capturedNetworkActivity.length > 0) {
        const formattedNetwork = capturedNetworkActivity.map(req => {
            return `[${new Date(req.timestamp * 1000).toISOString()}] ${req.method} ${req.url} - Status: ${req.status}\nResponse Body (truncated):\n${req.responseBody || 'N/A'}`;
        }).join('\n\n');
        prompt += `\n\n--- Captured Network Activity ---\n${formattedNetwork}\n--- End Network Activity ---`;
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
        resetState(true); // Perform a full reset
    }
}


// --- Message Handlers ---

async function handleGetPopupData(sendResponse) {
    // This function is now async to handle storage calls cleanly.
    try {
        const sessionResult = await chrome.storage.session.get(['julesCapturedData', 'julesCapturedTabId']);
        capturedData = sessionResult.julesCapturedData || null;
        const capturedTabId = sessionResult.julesCapturedTabId || null;

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // The state should be 'elementCaptured' if data exists and we are on the same tab where the capture happened.
        const state = (capturedData && capturedTabId && activeTab.id === capturedTabId)
            ? 'elementCaptured'
            : 'readyToSelect';

        const { viewState } = await chrome.storage.session.get('viewState');

        const localResult = await chrome.storage.local.get({
            mostRecentRepos: [],
            isCapturingLogs: false,
            isCapturingNetwork: false,
            isCapturingCSS: false,
        });

        sendResponse({
            state: state,
            capturedHtml: capturedData ? capturedData.outerHTML : null,
            capturedSelector: capturedData ? capturedData.selector : null,
            capturedCss: capturedData ? capturedData.computedCss : null,
            recentRepos: localResult.mostRecentRepos,
            isLogging: localResult.isCapturingLogs,
            isCapturingNetwork: localResult.isCapturingNetwork,
            isCapturingCSS: localResult.isCapturingCSS,
            view: viewState
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
    resetState(true); // Full reset

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
    chrome.storage.session.set({ 'julesCapturedData': message.data, 'viewState': 'task' });
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

        const { isCapturingCSS } = await chrome.storage.local.get({ isCapturingCSS: false });
        await createJulesSession(task, data, repositoryId, result.julesApiKey, capturedLogs, isCapturingCSS);

        // Important: Detach the debugger after logs have been sent.
        // The onDetach listener will handle the state cleanup.
        await detachDebugger();
    };

    const dataToUse = capturedData || (await chrome.storage.session.get('julesCapturedData')).julesCapturedData;

    // The logic now allows dataToUse to be null for tasks without element selection.
    // The createJulesSession function is now responsible for handling the null case.
    await onDataReady(dataToUse);
}

// --- Debugger Logic ---

function onDebuggerEvent(debuggeeId, method, params) {
    chrome.storage.local.get('debuggingTabId', ({ debuggingTabId }) => {
        if (!debuggingTabId || debuggeeId.tabId !== debuggingTabId) {
            return;
        }

        if (method === 'Network.requestWillBeSent') {
            capturedNetworkActivity.push({
                requestId: params.requestId,
                url: params.request.url,
                method: params.request.method,
                headers: params.request.headers,
                timestamp: params.timestamp,
            });
        } else if (method === 'Network.responseReceived') {
            const request = capturedNetworkActivity.find(req => req.requestId === params.requestId);
            if (request) {
                request.status = params.response.status;
                request.responseHeaders = params.response.headers;

                chrome.debugger.sendCommand(
                    { tabId: debuggingTabId },
                    "Network.getResponseBody",
                    { requestId: params.requestId },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            console.warn(`Could not get response body for ${params.requestId}: ${chrome.runtime.lastError.message}`);
                            return; // Don't proceed if there was an error
                        }
                        if (response && response.body) {
                            request.responseBody = response.body.substring(0, 500); // Truncate
                        }
                    }
                );
            }
        } else if (method === 'Runtime.consoleAPICalled') {
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

async function manageDebuggerState(tabId) {
    const { isCapturingLogs, isCapturingNetwork, debuggingTabId } = await chrome.storage.local.get([
        'isCapturingLogs',
        'isCapturingNetwork',
        'debuggingTabId'
    ]);

    const shouldBeDebugging = isCapturingLogs || isCapturingNetwork;
    const isCurrentlyDebugging = !!debuggingTabId;
    let targetTabId = tabId;

    try {
        if (shouldBeDebugging && !isCurrentlyDebugging) {
            try {
                await chrome.debugger.attach({ tabId: targetTabId }, DEBUGGER_VERSION);
            } catch (err) {
                console.warn(`Failed to attach debugger to tab ${targetTabId}, trying active tab. Error: ${err.message}`);
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!activeTab) throw new Error("No active tab found to attach debugger.");
                targetTabId = activeTab.id;
                await chrome.debugger.attach({ tabId: targetTabId }, DEBUGGER_VERSION);
            }

            await chrome.storage.local.set({ debuggingTabId: targetTabId });

            if (isCapturingLogs) await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Runtime.enable');
            if (isCapturingNetwork) await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Network.enable');
            console.log("Jules debugger attached and domains configured on tab:", targetTabId);

        } else if (!shouldBeDebugging && isCurrentlyDebugging) {
            await detachDebugger();

        } else if (shouldBeDebugging && isCurrentlyDebugging) {
            if (targetTabId !== debuggingTabId) {
                console.warn("Attempted to manage debugger on a different tab. This shouldn't happen.");
                return;
            }
            if (isCapturingLogs) {
                await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Runtime.enable');
            } else {
                await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Runtime.disable').catch(() => {});
            }

            if (isCapturingNetwork) {
                await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Network.enable');
            } else {
                await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Network.disable').catch(() => {});
            }
            console.log("Jules debugger domains updated.");
        }
    } catch (err) {
        console.error("Error managing debugger state:", err.message);
        const isNotAttachedError = err.message.includes("No debugger with given target id") || err.message.includes("Target is not attached");

        if (isNotAttachedError && (await chrome.storage.local.get('debuggingTabId')).debuggingTabId) {
            console.log("Correcting stale debugging state by removing tabId.");
            await chrome.storage.local.remove('debuggingTabId');
        } else if (!isNotAttachedError) {
            chrome.runtime.sendMessage({ action: "julesError", error: `Debugger error: ${err.message}` });
            await detachDebugger(); // Clean up on other failures
        }
    }
}


async function handleToggleLogCapture(message) {
    const { enabled } = message;
    await chrome.storage.local.set({ isCapturingLogs: enabled });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome://')) {
        await manageDebuggerState(tab.id);
    } else {
        console.warn("Jules: Debugger cannot be attached to the current tab.");
    }
}

async function handleToggleNetworkCapture(message) {
    const { enabled } = message;
    await chrome.storage.local.set({ isCapturingNetwork: enabled });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome://')) {
        await manageDebuggerState(tab.id);
    } else {
        console.warn("Jules: Debugger cannot be attached to the current tab.");
    }
}

async function handleToggleCSSCapture(message) {
    await chrome.storage.local.set({ isCapturingCSS: message.enabled });
}


// --- Event Listeners ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'popupOpened':
            // When the popup opens, send back any persisted text.
            chrome.storage.session.get('taskPromptText', (result) => {
                sendResponse({ taskPromptText: result.taskPromptText });
            });
            return true; // Keep channel open for async response
        case 'saveTaskPrompt':
            chrome.storage.session.set({ taskPromptText: message.text });
            break;
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
            resetState(true); // Full reset
            break;
        case 'submitTask':
            handleSubmitTask(message);
            return true;
        case 'toggleLogCapture':
            handleToggleLogCapture(message);
            return true;
        case 'toggleNetworkCapture':
            handleToggleNetworkCapture(message);
            return true;
        case 'toggleCSSCapture':
            handleToggleCSSCapture(message);
            break;
    }
});

// Reset element selection state when the user switches tabs
chrome.tabs.onActivated.addListener(async () => {
    const { julesCapturedTabId } = await chrome.storage.session.get('julesCapturedTabId');
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // If the activated tab is not the one where we captured an element, reset the non-persistent UI state.
    if (!julesCapturedTabId || activeTab.id !== julesCapturedTabId) {
        resetState(false); // Pass false to prevent clearing session data like the HTML itself.
    } else {
        // If we are switching back to the captured tab, restore the badge.
        const { julesCapturedData } = await chrome.storage.session.get('julesCapturedData');
        if (julesCapturedData) {
            chrome.action.setBadgeText({ text: '✅' });
            chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        }
    }
});

// Handle debugger lifecycle events
chrome.debugger.onEvent.addListener(onDebuggerEvent);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    const { debuggingTabId, isCapturingLogs, isCapturingNetwork } = await chrome.storage.local.get([
        'debuggingTabId',
        'isCapturingLogs',
        'isCapturingNetwork'
    ]);

    if (tabId === debuggingTabId && changeInfo.status === 'complete') {
        try {
            if (isCapturingLogs) {
                await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
                console.log("Jules debugger re-enabled Runtime on tab:", tabId);
            }
            if (isCapturingNetwork) {
                await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
                console.log("Jules debugger re-enabled Network on tab:", tabId);
            }
        } catch (err) {
            console.error("Error re-enabling debugger domains on navigation:", err.message);
            // If the error is that the debugger is no longer attached, our onDetach
            // listener will handle the state cleanup automatically.
            const isNotAttachedError = err.message.includes("No debugger with given target id") || err.message.includes("Target is not attached");
            if (!isNotAttachedError) {
                // For other unexpected errors, we can force a cleanup.
                await detachDebugger();
            }
        }
    }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (source.tabId === debuggingTabId) {
        console.log(`Jules debugger detached from tab ${source.tabId}. Reason: ${reason}. Cleaning up state.`);
        // This is the central cleanup location.
        // It runs when the user closes the banner, or we call detach().
        // We only clear the debuggingTabId, preserving the toggle states (isCapturingLogs, isCapturingNetwork)
        // so the UI remains consistent.
        await chrome.storage.local.remove('debuggingTabId');
        capturedLogs = [];
        capturedNetworkActivity = [];
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    // onDetach will be triggered automatically when the tab is closed,
    // so no extra cleanup logic is needed here.
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (tabId === debuggingTabId) {
        console.log(`Jules debugger: debugged tab ${tabId} was closed.`);
    }
});
