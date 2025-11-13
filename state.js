// --- State Management ---

// This module centralizes the logic for managing the extension's state.
// It's the single source of truth. It initializes state from storage when the
// service worker starts and persists any changes back to storage immediately.

/**
 * Creates and initializes a state management object.
 * This is the main export of the module.
 *
 * @returns {Promise<object>} A promise that resolves to the state management API.
 */
export const initState = async () => {
    // Define default state
    const defaults = {
        // Session state (cleared when the browser closes)
        julesCapturedData: null,
        julesCapturedTabId: null,
        viewState: 'select',
        taskPromptText: '',

        // Local state (persists across browser sessions)
        mostRecentRepos: [],
        isCapturingLogs: false,
        isCapturingNetwork: false,
        isCapturingCSS: false,
        debuggingTabId: null,
        julesSourcesCache: null,
        julesHistoryCache: null,

        // In-memory state (not persisted)
        capturedLogs: [],
        capturedNetworkActivity: [],
    };

    // In-memory state cache
    let state = { ...defaults };

    /**
     * Initializes the state from chrome.storage.
     * This is called automatically when the module is initialized.
     */
    async function initializeState() {
        if (!chrome.storage) {
            throw new Error("No SW");
        }
        const localState = await chrome.storage.local.get(Object.keys(defaults));
        const sessionState = await chrome.storage.session.get(Object.keys(defaults));
        Object.assign(state, localState, sessionState);
    }


    /**
     * Generic setter for a property in session storage.
     */
    async function setSessionState(key, value) {
        state[key] = value;
        await chrome.storage.session.set({ [key]: value });
    }

    /**
     * Generic setter for a property in local storage.
     */
    async function setLocalState(key, value) {
        state[key] = value;
        await chrome.storage.local.set({ [key]: value });
    }

    // --- Getters and Setters (The Public API) ---

    function getState() { return { ...state }; }

    function getCapturedData() { return state.julesCapturedData; }
    async function setCapturedData(data) {
        await setSessionState('julesCapturedData', data);
        if (data) {
            await setSessionState('viewState', 'task');
            chrome.action.setBadgeText({ text: '✅' });
            chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        }
    }

    function getCapturedTabId() { return state.julesCapturedTabId; }
    async function setCapturedTabId(tabId) { await setSessionState('julesCapturedTabId', tabId); }

    function getViewState() { return state.viewState; }
    async function setViewState(view) { await setSessionState('viewState', view); }

    function getTaskPromptText() { return state.taskPromptText; }
    async function setTaskPromptText(text) { await setSessionState('taskPromptText', text); }

    function getMostRecentRepos() { return state.mostRecentRepos; }
    async function setMostRecentRepos(repos) { await setLocalState('mostRecentRepos', repos); }

    function getIsCapturingLogs() { return state.isCapturingLogs; }
    async function setIsCapturingLogs(enabled) { await setLocalState('isCapturingLogs', enabled); }

    function getIsCapturingNetwork() { return state.isCapturingNetwork; }
    async function setIsCapturingNetwork(enabled) { await setLocalState('isCapturingNetwork', enabled); }

    function getIsCapturingCSS() { return state.isCapturingCSS; }
    async function setIsCapturingCSS(enabled) { await setLocalState('isCapturingCSS', enabled); }

    function getDebuggingTabId() { return state.debuggingTabId; }
    async function setDebuggingTabId(tabId) { await setLocalState('debuggingTabId', tabId); }

    function getSourcesCache() { return state.julesSourcesCache; }
    async function setSourcesCache(cache) { await setLocalState('julesSourcesCache', cache); }

    function getHistoryCache() { return state.julesHistoryCache; }
    async function setHistoryCache(cache) { await setLocalState('julesHistoryCache', cache); }

    function getCapturedLogs() { return state.capturedLogs; }
    function clearCapturedLogs() { state.capturedLogs = []; }

    function getCapturedNetworkActivity() { return state.capturedNetworkActivity; }
    function clearCapturedNetworkActivity() { state.capturedNetworkActivity = []; }

    async function resetState(forceFullReset = false) {
        state.capturedData = null; // In-memory only
        chrome.action.setBadgeText({ text: '' });

        if (forceFullReset) {
            const tabId = getCapturedTabId();
            if (tabId) {
                try {
                    await chrome.tabs.sendMessage(tabId, { action: "cleanupSelector" });
                } catch (err) {
                    if (!err.message.includes("Receiving end does not exist.")) {
                        console.error("Error sending cleanup message:", err);
                    }
                }
            }

            const sessionKeys = ['julesCapturedData', 'julesCapturedTabId', 'viewState', 'taskPromptText'];
            await chrome.storage.session.remove(sessionKeys);
            for (const key of sessionKeys) {
                state[key] = defaults[key];
            }
        }
    }

    // Initialize the state before returning the API
    await initializeState();

    // Return the public API
    return {
        getState,
        getCapturedData, setCapturedData,
        getCapturedTabId, setCapturedTabId,
        getViewState, setViewState,
        getTaskPromptText, setTaskPromptText,
        getMostRecentRepos, setMostRecentRepos,
        getIsCapturingLogs, setIsCapturingLogs,
        getIsCapturingNetwork, setIsCapturingNetwork,
        getIsCapturingCSS, setIsCapturingCSS,
        getDebuggingTabId, setDebuggingTabId,
        getSourcesCache, setSourcesCache,
        getHistoryCache, setHistoryCache,
        getCapturedLogs, clearCapturedLogs,
        getCapturedNetworkActivity, clearCapturedNetworkActivity,
        resetState,
    };
};
