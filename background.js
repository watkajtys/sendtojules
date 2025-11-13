// --- Imports ---

import {
    initializeState,
    getState,
    resetState,
    setCapturedData,
    setCapturedTabId,
    setTaskPromptText,
    setMostRecentRepos,
    setIsCapturingLogs,
    setIsCapturingNetwork,
    setIsCapturingCSS,
    getCapturedData,
    getCapturedLogs,
    getSourcesCache,
    setDebuggingTabId,
    clearCapturedLogs,
    clearCapturedNetworkActivity,
    getDebuggingTabId,
    getIsCapturingLogs,
    getIsCapturingNetwork, getCapturedTabId, setViewState,
} from './state.js';
import { fetchSources, createJulesSession, fetchHistory } from './api.js';
import { manageDebuggerState, detachDebugger, onDebuggerEvent } from './debugger.js';

// --- Initialization ---
initializeState();


// --- Message Handlers ---

async function handleGetPopupData(sendResponse) {
    try {
        const state = getState();
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        const isElementCaptured = (state.julesCapturedData && state.julesCapturedTabId && activeTab.id === state.julesCapturedTabId);
        const viewState = isElementCaptured ? 'elementCaptured' : 'readyToSelect';

        sendResponse({
            state: viewState,
            capturedHtml: isElementCaptured ? state.julesCapturedData.outerHTML : null,
            capturedSelector: isElementCaptured ? state.julesCapturedData.selector : null,
            capturedCss: isElementCaptured ? state.julesCapturedData.computedCss : null,
            recentRepos: state.mostRecentRepos,
            isLogging: state.isCapturingLogs,
            isCapturingNetwork: state.isCapturingNetwork,
            isCapturingCSS: state.isCapturingCSS,
            view: state.viewState
        });

    } catch (error) {
        console.error("Error getting popup data:", error);
        sendResponse({ error: "Failed to retrieve initial data." });
    }

    chrome.storage.sync.get(['julesApiKey'], (result) => {
        if (!result.julesApiKey) {
            chrome.runtime.sendMessage({ action: 'julesError', error: "API Key not set" });
            return;
        }
        fetchSources(result.julesApiKey);
    });
}

async function handleStartSelection() {
    await resetState(true);

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        await setCapturedTabId(tab.id);

        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["selector.css"] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["selector.js"] });
        await chrome.tabs.sendMessage(tab.id, { action: "startSelection" });
    } catch (err) {
        console.error("Failed to inject scripts or send message:", err);
        chrome.runtime.sendMessage({ action: "julesError", error: "Could not start selection on the active tab." });
    }
}

async function handleSubmitTask(message) {
    const { task, repositoryId, branch } = message;
    const sourcesCache = getSourcesCache();
    const allSources = sourcesCache?.sources || [];
    const selectedSource = allSources.find(s => s.id === repositoryId);

    if (selectedSource) {
        let recentRepos = getState().mostRecentRepos;
        recentRepos = recentRepos.filter(r => r.id !== selectedSource.id);
        recentRepos.unshift(selectedSource);
        if (recentRepos.length > 3) recentRepos.pop();
        await setMostRecentRepos(recentRepos);
    }

    const result = await chrome.storage.sync.get(['julesApiKey']);
    if (!result.julesApiKey) {
        chrome.runtime.sendMessage({ action: "julesError", error: "API Key not set. Please set it in Options." });
        return;
    }
    const capturedData = getCapturedData();
    const capturedLogs = getCapturedLogs();
    const isCapturingCSS = getState().isCapturingCSS;

    await createJulesSession(task, capturedData, repositoryId, branch, result.julesApiKey, capturedLogs, isCapturingCSS);
    await detachDebugger();
}

// --- Event Listeners ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'popupOpened':
            sendResponse({ taskPromptText: getState().taskPromptText });
            return true; // Keep the message channel open for sendResponse
        case 'saveTaskPrompt':
            setTaskPromptText(message.text);
            break;
        case 'setViewState':
            setViewState(message.view);
            break;
        case 'getPopupData':
            handleGetPopupData(sendResponse);
            return true;
        case 'startSelection':
            handleStartSelection();
            break;
        case 'elementCaptured':
            setCapturedData(message.data);
            break;
        case 'cancelSelection':
            resetState(true);
            break;
        case 'submitTask':
            handleSubmitTask(message);
            return true;
        case 'toggleLogCapture':
            setIsCapturingLogs(message.enabled).then(manageDebuggerState);
            break;
        case 'toggleNetworkCapture':
            setIsCapturingNetwork(message.enabled).then(manageDebuggerState);
            break;
        case 'toggleCSSCapture':
            setIsCapturingCSS(message.enabled);
            break;
        case 'fetchHistory':
            chrome.storage.sync.get(['julesApiKey'], (result) => {
                if (!result.julesApiKey) {
                    chrome.runtime.sendMessage({ action: 'julesError', error: "API Key not set" });
                    return;
                }
                fetchHistory(result.julesApiKey);
            });
            return true;
    }
    return false; // No async response
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const capturedTabId = getCapturedTabId();

    if (!capturedTabId || activeInfo.tabId !== capturedTabId) {
        await resetState(false);
    } else {
        if (getCapturedData()) {
            chrome.action.setBadgeText({ text: '✅' });
            chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        }
    }
});


chrome.debugger.onEvent.addListener(onDebuggerEvent);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    const debuggingTabId = getDebuggingTabId();
    const isCapturingLogs = getIsCapturingLogs();
    const isCapturingNetwork = getIsCapturingNetwork();

    if (tabId === debuggingTabId && changeInfo.status === 'complete') {
        try {
            if (isCapturingLogs) await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
            if (isCapturingNetwork) await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
        } catch (err) {
            console.error("Error re-enabling debugger domains on navigation:", err.message);
            if (!err.message.includes("No debugger with given target id") && !err.message.includes("Target is not attached")) {
                await detachDebugger();
            }
        }
    }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
    const debuggingTabId = getDebuggingTabId();
    if (debuggingTabId && source.tabId === debuggingTabId) {
        console.log(`Jules debugger detached unexpectedly from tab ${source.tabId}. Reason: ${reason}. Cleaning up.`);
        await setDebuggingTabId(null);
        clearCapturedLogs();
        clearCapturedNetworkActivity();
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    const debuggingTabId = getDebuggingTabId();
    if (tabId === debuggingTabId) {
        console.log(`Jules debugger: debugged tab ${tabId} was closed.`);
        // The onDetach listener will handle the cleanup.
    }
});
