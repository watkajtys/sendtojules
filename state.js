// --- State Management ---

// This module centralizes the logic for managing the extension's state.
// It's the single source of truth. It initializes state from storage when the
// service worker starts and persists any changes back to storage immediately.

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

    // In-memory state (not persisted)
    capturedLogs: [],
    capturedNetworkActivity: [],
};

// In-memory state cache
let state = { ...defaults };

/**
 * Initializes the state from chrome.storage.
 * This should be called when the service worker starts up.
 */
export async function initializeState() {
    const localState = await chrome.storage.local.get(Object.keys(defaults));
    const sessionState = await chrome.storage.session.get(Object.keys(defaults));
    Object.assign(state, localState, sessionState);
}

/**
 * Gets the entire current state.
 *
 * @returns {object} The current state object.
 */
export function getState() {
    return { ...state };
}

/**
 * Generic setter for a property in session storage.
 *
 * @param {string} key - The key of the state property to set.
 * @param {*} value - The value to set.
 */
async function setSessionState(key, value) {
    state[key] = value;
    await chrome.storage.session.set({ [key]: value });
}

/**
 * Generic setter for a property in local storage.
 *
 * @param {string} key - The key of the state property to set.
 * @param {*} value - The value to set.
 */
async function setLocalState(key, value) {
    state[key] = value;
    await chrome.storage.local.set({ [key]: value });
}


// --- Getters and Setters ---

export function getCapturedData() { return state.julesCapturedData; }
export async function setCapturedData(data) {
    await setSessionState('julesCapturedData', data);
    if (data) {
        await setSessionState('viewState', 'task');
        chrome.action.setBadgeText({ text: '✅' });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    }
}

export function getCapturedTabId() { return state.julesCapturedTabId; }
export async function setCapturedTabId(tabId) { await setSessionState('julesCapturedTabId', tabId); }

export function getViewState() { return state.viewState; }
export async function setViewState(view) { await setSessionState('viewState', view); }

export function getTaskPromptText() { return state.taskPromptText; }
export async function setTaskPromptText(text) { await setSessionState('taskPromptText', text); }


export function getMostRecentRepos() { return state.mostRecentRepos; }
export async function setMostRecentRepos(repos) { await setLocalState('mostRecentRepos', repos); }

export function getIsCapturingLogs() { return state.isCapturingLogs; }
export async function setIsCapturingLogs(enabled) { await setLocalState('isCapturingLogs', enabled); }

export function getIsCapturingNetwork() { return state.isCapturingNetwork; }
export async function setIsCapturingNetwork(enabled) { await setLocalState('isCapturingNetwork', enabled); }

export function getIsCapturingCSS() { return state.isCapturingCSS; }
export async function setIsCapturingCSS(enabled) { await setLocalState('isCapturingCSS', enabled); }

export function getDebuggingTabId() { return state.debuggingTabId; }
export async function setDebuggingTabId(tabId) { await setLocalState('debuggingTabId', tabId); }

export function getSourcesCache() { return state.julesSourcesCache; }
export async function setSourcesCache(cache) { await setLocalState('julesSourcesCache', cache); }

export function getCapturedLogs() { return state.capturedLogs; }
export function clearCapturedLogs() { state.capturedLogs = []; }

export function getCapturedNetworkActivity() { return state.capturedNetworkActivity; }
export function clearCapturedNetworkActivity() { state.capturedNetworkActivity = []; }


/**
 * Resets the extension's state.
 *
 * @param {boolean} forceFullReset - If true, clears all session data and sends a cleanup message to the content script.
 */
export async function resetState(forceFullReset = false) {
    state.capturedData = null; // In-memory only
    chrome.action.setBadgeText({ text: '' });

    if (forceFullReset) {
        const tabId = getCapturedTabId();
        if (tabId) {
            try {
                await chrome.tabs.sendMessage(tabId, { action: "cleanupSelector" });
            } catch (err) {
                // Ignore errors if the tab was closed, but log others.
                if (!err.message.includes("Receiving end does not exist.")) {
                    console.error("Error sending cleanup message:", err);
                }
            }
        }

        // Clear all session data
        const sessionKeys = ['julesCapturedData', 'julesCapturedTabId', 'viewState', 'taskPromptText'];
        await chrome.storage.session.remove(sessionKeys);
        for (const key of sessionKeys) {
            state[key] = defaults[key];
        }
    }
}
