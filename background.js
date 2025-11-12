let capturedHtml = null;

const API_BASE_URL = 'https://jules.googleapis.com/v1alpha';

let sourcesCache = null; // Renamed from sourceCache for clarity

function resetState() {
    capturedHtml = null;
    chrome.action.setBadgeText({ text: '' });
    sourcesCache = null;

    // --- IMPROVED CLEANUP ---
    // Proactively find the tab where the selector might be active and clean it up.
    chrome.storage.session.get(['julesCapturedTabId'], (result) => {
        const tabId = result.julesCapturedTabId;
        if (tabId) {
            // Send a cleanup message to the specific tab.
            chrome.tabs.sendMessage(tabId, { action: "cleanupSelector" }).catch(err => {
                // Ignore errors, as the tab might have been closed.
                if (!err.message.includes("Receiving end does not exist.")) {
                    console.error("Error sending cleanup message:", err);
                }
            });
        }
    });

    // Clear all session data.
    chrome.storage.session.remove(['julesCapturedHtml', 'julesCapturedTabId']);
}

async function fetchSources(apiKey) {
    if (sourcesCache) {
        return sourcesCache;
    }

    const sourcesApiUrl = `${API_BASE_URL}/sources`;

    let allSources = [];
    let nextPageToken = null;

    try {
        // Loop as long as the API provides a nextPageToken
        do {
            // Construct the URL with the page token if it exists
            const url = nextPageToken
                ? `${sourcesApiUrl}?pageToken=${nextPageToken}`
                : sourcesApiUrl;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-Goog-Api-Key': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch sources: ${response.statusText}`);
            }

            const data = await response.json();

            // Add the batch of sources from this page to our master list
            if (data.sources) {
                allSources.push(...data.sources);
            }

            // Get the next token for the next loop iteration
            nextPageToken = data.nextPageToken;

        } while (nextPageToken);

        // Now that we have the complete list, map it for the popup
        const mappedSources = allSources.map(source => ({
            id: source.name,   // "sources/github/..."
            name: source.id    // "github/..."
        }));

        // --- Store in cache ---
        sourcesCache = mappedSources;
        return mappedSources;

    } catch (error) {
        console.error('Failed to fetch sources:', error);
        chrome.runtime.sendMessage({ action: "julesError", error: "Failed to fetch sources." });
        return []; // Return empty list on error
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // --- FIX: This handler must be async to check storage ---
    if (message.action === 'getPopupData') {

        // 1. We MUST check session storage, as the in-memory
        //    'capturedHtml' variable is null if the worker slept.
        chrome.storage.session.get(['julesCapturedHtml'], (result) => {
            const storedHtml = result.julesCapturedHtml;

            // 2. Restore the in-memory variable if we found it
            if (storedHtml) {
                capturedHtml = storedHtml;
            }

            // 3. Now we can safely get the state
            const state = capturedHtml ? 'elementCaptured' : 'readyToSelect';

            // 4. Send the single, immediate response with the state and HTML
            sendResponse({state: state, capturedHtml: capturedHtml});
        });

        // 5. The source fetching logic remains separate.
        //    It will send its own 'sourcesLoaded' message.
        if (sourcesCache) {
            // Already cached from pre-fetch, send it now
            chrome.runtime.sendMessage({ action: "sourcesLoaded", sources: sourcesCache });
        } else {
            // Not cached, fetch it now
            chrome.storage.sync.get(['julesApiKey'], async (result) => {
                if (!result.julesApiKey) {
                    chrome.runtime.sendMessage({action: 'julesError', error: "API Key not set"});
                    return;
                }
                const sources = await fetchSources(result.julesApiKey);
                chrome.runtime.sendMessage({ action: "sourcesLoaded", sources: sources });
            });
        }

        // Return true because sendResponse is async (in storage.get)
        return true;
    }

    if (message.action === "startSelection") {
        resetState();

        chrome.storage.sync.get(['julesApiKey'], async (result) => {
            if (result.julesApiKey) {
                await fetchSources(result.julesApiKey);
            }
        });

        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (tabs.length === 0) return;
            const tabId = tabs[0].id;
            chrome.storage.session.set({ 'julesCapturedTabId': tabId });

            try {
                // First, inject the CSS.
                await chrome.scripting.insertCSS({
                    target: { tabId: tabId },
                    files: ["selector.css"]
                });

                // Next, execute the content script.
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ["selector.js"]
                });

                // Finally, send the message to activate the selector.
                await chrome.tabs.sendMessage(tabId, { action: "startSelection" });

            } catch (err) {
                console.error("Failed to inject scripts or send message:", err);
            }
        });
        return true; // Keep the message channel open for async operations
    }

    if (message.action === "elementCaptured") {
        capturedHtml = message.html;
        // Also store in session storage to protect against worker sleep
        chrome.storage.session.set({ 'julesCapturedHtml': message.html });

        // Set the "success" badge on the icon.
        chrome.action.setBadgeText({ text: '✅' });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    }

    if (message.action === "cancelSelection") {
        resetState();

    }

    if (message.action === "submitTask") {

        const task = message.task;
        const sourceName = message.repositoryId;

        // Check in-memory first
        if (!capturedHtml) {
            // Fallback: Check storage.session in case worker slept
            chrome.storage.session.get(['julesCapturedHtml'], (result) => {
                if (result.julesCapturedHtml) {
                    capturedHtml = result.julesCapturedHtml; // Restore it
                    // Recurse (call this message handler again)
                    chrome.runtime.sendMessage(message);
                } else {
                    chrome.runtime.sendMessage({action: "julesError", error: "No element captured."});
                }
            });
            return true;
        }

        // We have the HTML, now get the key and create the session
        chrome.storage.sync.get(['julesApiKey'], (result) => {
            if (!result.julesApiKey) {
                chrome.runtime.sendMessage({action: "julesError", error: "API Key not set. Please set it in Options."});
                return;
            }

            createJulesSession(task, capturedHtml, sourceName, result.julesApiKey);
        });

        return true;
    }

    if (message.action === "popupClosed") {
        // Retrieve capturedTabId from session storage
        chrome.storage.session.get(['julesCapturedTabId'], (result) => {
            const storedTabId = result.julesCapturedTabId;
            if (storedTabId) {
                chrome.tabs.sendMessage(storedTabId, { action: "cleanupSelector" });
            }
            resetState(); // This will clear julesCapturedTabId from session storage
        });
        return true; // Return true because sendResponse is async
    }
});

async function createJulesSession(task, capturedHtml, sourceName, apiKey) {
    const sessionsApiUrl = `${API_BASE_URL}/sessions`;

    // Trim the task and the final prompt
    const cleanTask = task.trim();
    const combinedPrompt = `
${cleanTask}

Here is the HTML context for the element I selected:
\`\`\`html
${capturedHtml}
\`\`\`
`.trim(); // Trim the whole prompt

    // Create the title from the clean task
    const simpleTitle = cleanTask.split('\n')[0].substring(0, 80);

    const payload = {
        prompt: combinedPrompt,
        sourceContext: {
            source: sourceName,
            "githubRepoContext": {
                "startingBranch": "main"
            }
        },
        title: simpleTitle
    };

    try {
        console.log("Jules API Payload:", JSON.stringify(payload, null, 2));

        const response = await fetch(sessionsApiUrl, {
            method: 'POST',
            headers: {
                'X-Goog-Api-Key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || `API Error: ${response.status}`);
        }

        const sessionData = await response.json();
        chrome.runtime.sendMessage({ action: "julesResponse", data: sessionData });

    } catch (error) {
        console.error('Failed to call julesApi api', error);
        chrome.runtime.sendMessage({action: "julesError", error: error.message});
    } finally {
        // resetState handles all cleanup
        resetState(); // This will now clear julesCapturedTabId from session storage

        // Retrieve capturedTabId from session storage
        chrome.storage.session.get(['julesCapturedTabId'], (result) => {
            const storedTabId = result.julesCapturedTabId;
            if (storedTabId) {
                chrome.tabs.sendMessage(storedTabId, { action: "cleanupSelector" });
                // No need to clear here, resetState() already does it
            }
        });
    }
}

chrome.tabs.onActivated.addListener(() => {
    resetState();
})