// --- Imports ---

import { capturedData, capturedLogs, resetState, setCapturedData } from './state.js';
import { fetchSources, createJulesSession, fetchHistory } from './api.js';
import { manageDebuggerState, detachDebugger, onDebuggerEvent } from './debugger.js';

// --- Message Handlers ---

async function handleGetPopupData(sendResponse) {
    try {
        const sessionResult = await chrome.storage.session.get(['julesCapturedData', 'julesCapturedTabId']);
        const capturedTabId = sessionResult.julesCapturedTabId || null;
        let localCapturedData = sessionResult.julesCapturedData || null;

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        const state = (localCapturedData && capturedTabId && activeTab.id === capturedTabId)
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
            capturedHtml: localCapturedData ? localCapturedData.outerHTML : null,
            capturedSelector: localCapturedData ? localCapturedData.selector : null,
            capturedCss: localCapturedData ? localCapturedData.computedCss : null,
            recentRepos: localResult.mostRecentRepos,
            isLogging: localResult.isCapturingLogs,
            isCapturingNetwork: localResult.isCapturingNetwork,
            isCapturingCSS: localResult.isCapturingCSS,
            view: viewState
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
    resetState(true);

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        chrome.storage.session.set({ 'julesCapturedTabId': tab.id });

        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["selector.css"] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["selector.js"] });
        await chrome.tabs.sendMessage(tab.id, { action: "startSelection" });
    } catch (err) {
        console.error("Failed to inject scripts or send message:", err);
        chrome.runtime.sendMessage({ action: "julesError", error: "Could not start selection on the active tab." });
    }
}

function handleElementCaptured(message) {
    setCapturedData(message.data);
    chrome.storage.session.set({ 'julesCapturedData': message.data, 'viewState': 'task' });
    chrome.action.setBadgeText({ text: '✅' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}

async function handleSubmitTask(message) {
    const { task, repositoryId, branch } = message;

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

    const onDataReady = async (data) => {
        const result = await chrome.storage.sync.get(['julesApiKey']);
        if (!result.julesApiKey) {
            chrome.runtime.sendMessage({ action: "julesError", error: "API Key not set. Please set it in Options." });
            return;
        }

        const { isCapturingCSS } = await chrome.storage.local.get({ isCapturingCSS: false });
        await createJulesSession(task, data, repositoryId, branch, result.julesApiKey, capturedLogs, isCapturingCSS);
        await detachDebugger();
    };

    const sessionData = await chrome.storage.session.get('julesCapturedData');
    const dataToUse = capturedData || sessionData.julesCapturedData;
    await onDataReady(dataToUse);
}

// --- Event Listeners ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'popupOpened':
            chrome.storage.session.get('taskPromptText', (result) => {
                sendResponse({ taskPromptText: result.taskPromptText });
            });
            return true;
        case 'saveTaskPrompt':
            chrome.storage.session.set({ taskPromptText: message.text });
            break;
        case 'getPopupData':
            handleGetPopupData(sendResponse);
            return true;
        case 'startSelection':
            handleStartSelection();
            return true;
        case 'elementCaptured':
            handleElementCaptured(message);
            break;
        case 'cancelSelection':
            resetState(true);
            break;
        case 'submitTask':
            handleSubmitTask(message);
            return true;
        case 'toggleLogCapture':
            chrome.storage.local.set({ isCapturingLogs: message.enabled }).then(manageDebuggerState);
            return true;
        case 'toggleNetworkCapture':
            chrome.storage.local.set({ isCapturingNetwork: message.enabled }).then(manageDebuggerState);
            return true;
        case 'toggleCSSCapture':
            chrome.storage.local.set({ isCapturingCSS: message.enabled });
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
});

chrome.tabs.onActivated.addListener(async () => {
    const { julesCapturedTabId } = await chrome.storage.session.get('julesCapturedTabId');
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!julesCapturedTabId || activeTab.id !== julesCapturedTabId) {
        resetState(false);
    } else {
        const { julesCapturedData } = await chrome.storage.session.get('julesCapturedData');
        if (julesCapturedData) {
            chrome.action.setBadgeText({ text: '✅' });
            chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        }
    }
});

chrome.debugger.onEvent.addListener(onDebuggerEvent);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    const { debuggingTabId, isCapturingLogs, isCapturingNetwork } = await chrome.storage.local.get([
        'debuggingTabId',
        'isCapturingLogs',
        'isCapturingNetwork'
    ]);

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
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (debuggingTabId && source.tabId === debuggingTabId) {
        console.log(`Jules debugger detached unexpectedly from tab ${source.tabId}. Reason: ${reason}. Cleaning up.`);
        await chrome.storage.local.remove('debuggingTabId');
        capturedLogs.length =  0;
        capturedNetworkActivity.length = 0;
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    const { debuggingTabId } = await chrome.storage.local.get('debuggingTabId');
    if (tabId === debuggingTabId) {
        console.log(`Jules debugger: debugged tab ${tabId} was closed.`);
    }
});
