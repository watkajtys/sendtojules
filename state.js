// --- State Management ---

// This module centralizes the logic for managing the extension's state.

// In-memory state for data captured during the selection process.
export let capturedData = null;
export let capturedLogs = [];
export let capturedNetworkActivity = [];

/**
 * Sets the captured data.
 *
 * @param {object} data - The data captured from the content script.
 */
export function setCapturedData(data) {
    capturedData = data;
}

/**
 * Resets the extension's state.
 *
 * @param {boolean} forceFullReset - If true, clears all session data and sends a cleanup message to the content script.
 */
export function resetState(forceFullReset = false) {
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
