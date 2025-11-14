// --- Imports ---

import { initState } from './state.js';
import { fetchSources, createJulesSession, fetchHistory } from './api.js';
import { manageDebuggerState, detachDebugger, onDebuggerEvent } from './debugger.js';

// --- Initialization ---

// By initializing stateManager as a promise at the top level, we ensure that
// all event listeners can be registered synchronously. Each listener function
// will then `await` this promise to get the state manager when it's needed.
const stateManagerPromise = initState();

// --- Message Handlers ---

async function handleGetSidePanelData(sendResponse) {
    const stateManager = await stateManagerPromise;
    try {
        const state = stateManager.getState();
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // Defensively check if activeTab exists
        const tabId = activeTab ? activeTab.id : null;

        const isElementCaptured = (state.julesCapturedData && state.julesCapturedTabId && tabId === state.julesCapturedTabId);
        const viewState = isElementCaptured ? 'elementCaptured' : 'readyToSelect';

        sendResponse({
            state: viewState,
            capturedData: isElementCaptured ? state.julesCapturedData : null,
            recentRepos: state.mostRecentRepos,
            isLogging: state.isCapturingLogs,
            isCapturingNetwork: state.isCapturingNetwork,
            isCapturingCSS: state.isCapturingCSS,
            view: state.viewState
        });

    } catch (error) {
        console.error("Error getting side panel data:", error);
        sendResponse({ error: "Failed to retrieve initial data." });
    }

    chrome.storage.sync.get(['julesApiKey'], (result) => {
        if (!result.julesApiKey) {
            chrome.runtime.sendMessage({ action: 'julesError', error: "API Key not set" });
            return;
        }
        fetchSources(result.julesApiKey, stateManager);
    });
}

async function handleStartSelection(message) {
    const stateManager = await stateManagerPromise;
    const { tabId } = message;
    await stateManager.resetState(true);
    if (tabId) {
        await stateManager.setCapturedTabId(tabId);
        try {
            await chrome.tabs.sendMessage(tabId, { action: "activateSelector" });
        } catch (error) {
            console.error("Could not send activateSelector message:", error);
            // Consider sending an error back to the sidepanel
        }
    }
}

async function handleSubmitTask(message) {
    const stateManager = await stateManagerPromise;
    const { task, repositoryId, branch } = message;
    const sourcesCache = stateManager.getSourcesCache();
    const allSources = sourcesCache?.sources || [];
    const selectedSource = allSources.find(s => s.id === repositoryId);

    if (selectedSource) {
        let recentRepos = stateManager.getState().mostRecentRepos;
        recentRepos = recentRepos.filter(r => r.id !== selectedSource.id);
        recentRepos.unshift(selectedSource);
        if (recentRepos.length > 3) recentRepos.pop();
        await stateManager.setMostRecentRepos(recentRepos);
    }

    const result = await chrome.storage.sync.get(['julesApiKey']);
    if (!result.julesApiKey) {
        chrome.runtime.sendMessage({ action: "julesError", error: "API Key not set. Please set it in Options." });
        return;
    }
    const capturedData = stateManager.getCapturedData();
    const capturedLogs = stateManager.getCapturedLogs();
    const isCapturingCSS = stateManager.getState().isCapturingCSS;

    await createJulesSession(task, capturedData, repositoryId, branch, result.julesApiKey, capturedLogs, isCapturingCSS, stateManager);
    await detachDebugger(stateManager);
}

// --- Event Listeners ---

// IMPORTANT: Register the onMessage listener synchronously at the top level.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Make the listener function async to handle promises properly.
    (async () => {
        const stateManager = await stateManagerPromise;
        switch (message.action) {
            case 'sidePanelOpened':
                sendResponse({ taskPromptText: stateManager.getState().taskPromptText });
                break;
            case 'saveTaskPrompt':
                await stateManager.setTaskPromptText(message.text);
                break;
            case 'setViewState':
                await stateManager.setViewState(message.view);
                break;
            case 'getSidePanelData':
                await handleGetSidePanelData(sendResponse);
                break;
            case 'startSelection':
                await handleStartSelection(message);
                break;
            case 'elementCaptured':
                await stateManager.setCapturedData(message.data);
                chrome.runtime.sendMessage({ action: 'elementUpdated', data: message.data });
                break;
            case 'dismissElement':
                await stateManager.setCapturedData(null);
                break;
            case 'cancelSelection':
                await stateManager.resetState(true);
                break;
            case 'submitTask':
                await handleSubmitTask(message);
                break;
            case 'toggleLogCapture':
                await stateManager.setIsCapturingLogs(message.enabled);
                await manageDebuggerState(stateManager);
                break;
            case 'toggleNetworkCapture':
                await stateManager.setIsCapturingNetwork(message.enabled);
                await manageDebuggerState(stateManager);
                break;
            case 'toggleCSSCapture':
                await stateManager.setIsCapturingCSS(message.enabled);
                break;
            case 'fetchHistory':
                const result = await chrome.storage.sync.get(['julesApiKey']);
                if (!result.julesApiKey) {
                    chrome.runtime.sendMessage({ action: 'julesError', error: "API Key not set" });
                } else {
                    await fetchHistory(result.julesApiKey, stateManager);
                }
                break;
            case 'resetStateAndGoToTaskView':
                await stateManager.resetState(true);
                await stateManager.setViewState('task');
                // We also need to inform the sidepanel to re-render its state
                chrome.runtime.sendMessage({ action: 'stateReset' });
                break;
            default:
                // No default case needed, just ignore unknown messages.
                break;
        }
    })();

    // `true` must be returned from the top-level of the listener function
    // to indicate that the response will be sent asynchronously.
    return true;
});


chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const stateManager = await stateManagerPromise;
    const capturedTabId = stateManager.getCapturedTabId();

    if (!capturedTabId || activeInfo.tabId !== capturedTabId) {
        await stateManager.resetState(false);
    } else {
        if (stateManager.getCapturedData()) {
            chrome.action.setBadgeText({ text: '✅' });
            chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        }
    }
});


chrome.debugger.onEvent.addListener(async (debuggeeId, method, params) => {
    const stateManager = await stateManagerPromise;
    onDebuggerEvent(debuggeeId, method, params, stateManager);
});


chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    const stateManager = await stateManagerPromise;
    const debuggingTabId = stateManager.getDebuggingTabId();
    const isCapturingLogs = stateManager.getIsCapturingLogs();
    const isCapturingNetwork = stateManager.getIsCapturingNetwork();

    if (tabId === debuggingTabId && changeInfo.status === 'complete') {
        try {
            if (isCapturingLogs) await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
            if (isCapturingNetwork) await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
        } catch (err) {
            console.error("Error re-enabling debugger domains on navigation:", err.message);
            if (!err.message.includes("No debugger with given target id") && !err.message.includes("Target is not attached")) {
                await detachDebugger(stateManager);
            }
        }
    }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
    const stateManager = await stateManagerPromise;
    const debuggingTabId = stateManager.getDebuggingTabId();
    if (debuggingTabId && source.tabId === debuggingTabId) {
        console.log(`Jules debugger detached unexpectedly from tab ${source.tabId}. Reason: ${reason}. Cleaning up.`);
        await stateManager.setDebuggingTabId(null);
        stateManager.clearCapturedLogs();
        stateManager.clearCapturedNetworkActivity();
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    const stateManager = await stateManagerPromise;
    const debuggingTabId = stateManager.getDebuggingTabId();
    if (tabId === debuggingTabId) {
        console.log(`Jules debugger: debugged tab ${tabId} was closed.`);
        // The onDetach listener will handle the cleanup.
    }
});

chrome.action.onClicked.addListener(async (tab) => {
    const { id: tabId } = tab;
    if (!tabId) return;

    // This allows the side panel to open on the current tab
    await chrome.sidePanel.open({ tabId });
});
