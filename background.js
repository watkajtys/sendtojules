// --- Imports ---

import { initState } from './state.js';
import { fetchSources, createJulesSession, fetchHistory } from './api.js';
import { manageDebuggerState, detachDebugger, onDebuggerEvent } from './debugger.js';

// --- Initialization ---

(async () => {
    const stateManager = await initState();

    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));

    // --- Message Handlers ---

    async function handleGetSidePanelData(sendResponse) {
        try {
            const state = stateManager.getState();
            sendResponse({
                taskPrompt: state.taskPromptText,
                selectedRepo: state.mostRecentRepos.length > 0 ? state.mostRecentRepos[0] : null,
                selectedBranch: state.mostRecentRepos.length > 0 ? state.mostRecentRepos[0].githubRepo.defaultBranch.displayName : null,
                isCapturingLogs: state.isCapturingLogs,
                isCapturingNetwork: state.isCapturingNetwork,
                isCapturingCSS: state.isCapturingCSS,
                selectedElement: state.julesCapturedData,
                allSources: stateManager.getSourcesCache()?.sources || [],
                recentRepos: state.mostRecentRepos,
            });
        } catch (error) {
            console.error("Error getting side panel data:", error);
            sendResponse({ error: "Failed to retrieve initial data." });
        }
         chrome.storage.sync.get(['julesApiKey'], (result) => {
            if (result.julesApiKey) {
                fetchSources(result.julesApiKey, stateManager);
            }
        });
    }

    async function handleStartSelection() {
        await stateManager.resetState(true);

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return;

            await stateManager.setCapturedTabId(tab.id);

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
            case 'saveTaskPrompt':
                stateManager.setTaskPromptText(message.text);
                break;
            case 'getSidePanelData':
                handleGetSidePanelData(sendResponse);
                return true;
            case 'startSelection':
                handleStartSelection();
                break;
            case 'elementCaptured':
                stateManager.setCapturedData(message.data);
                chrome.runtime.sendMessage({ action: 'elementCaptured', data: message.data });
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
})();
