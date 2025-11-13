// --- Debugger Logic ---

// This module manages attaching, detaching, and handling events for the chrome.debugger API.

import {
    getIsCapturingLogs,
    getIsCapturingNetwork,
    getDebuggingTabId,
    setDebuggingTabId,
    getCapturedLogs,
    getCapturedNetworkActivity,
    clearCapturedLogs,
    clearCapturedNetworkActivity
} from './state.js';

const DEBUGGER_VERSION = "1.3";

/**
 * Handles events from the Chrome debugger.
 *
 * @param {object} debuggeeId - The identifier of the tab being debugged.
 * @param {string} method - The name of the debugger event.
 * @param {object} params - The event parameters.
 */
export function onDebuggerEvent(debuggeeId, method, params) {
    const debuggingTabId = getDebuggingTabId();
    if (!debuggingTabId || debuggeeId.tabId !== debuggingTabId) {
        return;
    }

    if (method === 'Network.requestWillBeSent') {
        getCapturedNetworkActivity().push({
            requestId: params.requestId,
            url: params.request.url,
            method: params.request.method,
            headers: params.request.headers,
            timestamp: params.timestamp,
        });
    } else if (method === 'Network.responseReceived') {
        const request = getCapturedNetworkActivity().find(req => req.requestId === params.requestId);
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
                        return;
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
        getCapturedLogs().push(logEntry);
    }
}


/**
 * Manages the debugger state, attaching or detaching as needed based on user settings and the active tab.
 */
export async function manageDebuggerState() {
    const isCapturingLogs = getIsCapturingLogs();
    const isCapturingNetwork = getIsCapturingNetwork();
    const debuggingTabId = getDebuggingTabId();

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!activeTab || !activeTab.id || activeTab.url?.startsWith('chrome://')) {
        console.warn("Jules: Debugger cannot be attached to the current tab.");
        if (debuggingTabId) await detachDebugger();
        return;
    }

    const targetTabId = activeTab.id;
    const shouldBeDebugging = isCapturingLogs || isCapturingNetwork;
    const isCurrentlyDebugging = !!debuggingTabId;

    try {
        if (shouldBeDebugging && !isCurrentlyDebugging) {
            await chrome.debugger.attach({ tabId: targetTabId }, DEBUGGER_VERSION);
            await setDebuggingTabId(targetTabId);
            console.log("Jules debugger attached to tab:", targetTabId);
        } else if (!shouldBeDebugging && isCurrentlyDebugging) {
            await detachDebugger();
            return;
        } else if (shouldBeDebugging && isCurrentlyDebugging && debuggingTabId !== targetTabId) {
            await detachDebugger();
            await chrome.debugger.attach({ tabId: targetTabId }, DEBUGGER_VERSION);
            await setDebuggingTabId(targetTabId);
            console.log(`Jules debugger moved from tab ${debuggingTabId} to ${targetTabId}`);
        }

        const newDebuggingTabId = getDebuggingTabId();
        if (shouldBeDebugging && newDebuggingTabId) {
            if (isCapturingLogs) {
                await chrome.debugger.sendCommand({ tabId: newDebuggingTabId }, 'Runtime.enable');
            } else {
                await chrome.debugger.sendCommand({ tabId: newDebuggingTabId }, 'Runtime.disable').catch(() => {});
            }
            if (isCapturingNetwork) {
                await chrome.debugger.sendCommand({ tabId: newDebuggingTabId }, 'Network.enable');
            } else {
                await chrome.debugger.sendCommand({ tabId: newDebuggingTabId }, 'Network.disable').catch(() => {});
            }
            console.log("Jules debugger domains configured for tab:", newDebuggingTabId);
        }
    } catch (err) {
        console.error("Error managing debugger state:", err.message);
        const isNotAttachedError = err.message.includes("No debugger with given target id") || err.message.includes("Target is not attached");

        if (isNotAttachedError && getDebuggingTabId()) {
            console.log("Correcting stale debugging state by removing tabId.");
            await setDebuggingTabId(null);
        } else if (!isNotAttachedError) {
            chrome.runtime.sendMessage({ action: "julesError", error: `Debugger error: ${err.message}` });
            await detachDebugger();
        }
    }
}

/**
 * Detaches the debugger from the target tab and clears related state.
 */
export async function detachDebugger() {
    const debuggingTabId = getDebuggingTabId();
    if (!debuggingTabId) return;

    await setDebuggingTabId(null);
    clearCapturedLogs();
    clearCapturedNetworkActivity();
    console.log(`Proactively cleared state for tab ${debuggingTabId}`);

    await chrome.debugger.detach({ tabId: debuggingTabId }).catch(err => {
        if (!err.message.includes("No debugger with given target id") &&
            !err.message.includes("Target is not attached")) {
            console.error("Error during debugger detach call:", err);
        }
    });
}
