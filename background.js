// --- Imports ---

import { initState } from './state.js';
import { fetchSources, createJulesSession, fetchHistory } from './api.js';
import { manageDebuggerState, detachDebugger, onDebuggerEvent } from './debugger.js';

// --- Initialization ---

(async () => {
    const stateManager = await initState();

    // --- Message Handlers ---

    async function handleGetSidePanelData(sendResponse) {
        try {
            const state = stateManager.getState();
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
        const { tabId } = message;
        await stateManager.resetState(true);
        if (tabId) {
            await stateManager.setCapturedTabId(tabId);
        } else {
            // Fallback for safety, though should not happen with the new flow
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) await stateManager.setCapturedTabId(tab.id);
        }
    }

    async function handleSubmitTask(message) {
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

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.action) {
            case 'sidePanelOpened':
                sendResponse({ taskPromptText: stateManager.getState().taskPromptText });
                return true; // Keep the message channel open for sendResponse
            case 'saveTaskPrompt':
                stateManager.setTaskPromptText(message.text);
                break;
            case 'setViewState':
                stateManager.setViewState(message.view);
                break;
            case 'getSidePanelData':
                handleGetSidePanelData(sendResponse);
                return true;
            case 'startSelection':
                handleStartSelection();
                break;
            case 'elementCaptured':
                stateManager.setCapturedData(message.data);
                break;
            case 'cancelSelection':
                stateManager.resetState(true);
                break;
            case 'submitTask':
                handleSubmitTask(message);
                return true;
            case 'toggleLogCapture':
                stateManager.setIsCapturingLogs(message.enabled).then(() => manageDebuggerState(stateManager));
                break;
            case 'toggleNetworkCapture':
                stateManager.setIsCapturingNetwork(message.enabled).then(() => manageDebuggerState(stateManager));
                break;
            case 'toggleCSSCapture':
                stateManager.setIsCapturingCSS(message.enabled);
                break;
            case 'fetchHistory':
                chrome.storage.sync.get(['julesApiKey'], (result) => {
                    if (!result.julesApiKey) {
                        chrome.runtime.sendMessage({ action: 'julesError', error: "API Key not set" });
                        return;
                    }
                    fetchHistory(result.julesApiKey, stateManager);
                });
                return true;
        }
        return false; // No async response
    });

    chrome.tabs.onActivated.addListener(async (activeInfo) => {
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


    chrome.debugger.onEvent.addListener((debuggeeId, method, params) => onDebuggerEvent(debuggeeId, method, params, stateManager));

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
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
        const debuggingTabId = stateManager.getDebuggingTabId();
        if (debuggingTabId && source.tabId === debuggingTabId) {
            console.log(`Jules debugger detached unexpectedly from tab ${source.tabId}. Reason: ${reason}. Cleaning up.`);
            await stateManager.setDebuggingTabId(null);
            stateManager.clearCapturedLogs();
            stateManager.clearCapturedNetworkActivity();
        }
    });

    chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
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
})();
