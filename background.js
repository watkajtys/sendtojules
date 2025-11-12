let capturedHtml = null;

const API_BASE_URL = 'https://jules.googleapis.com/v1alpha';

function resetState() {
    capturedHtml = null;
    chrome.action.setBadgeText({text: ''});
}

async function fetchSources(apiKey) {
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
        return allSources.map(source => {
            // e.g., "github/bobalover/boba"
            const displayName = source.id || source.name;

            // Use the 'name' field ("sources/github/...") as the ID
            // because that is what the 'create session' call needs.
            return {
                id: source.name,
                name: displayName
            };
        });

    } catch (error) {
        console.error('Failed to fetch sources:', error);
        chrome.runtime.sendMessage({ action: "julesError", error: "Failed to fetch sources." });
        return []; // Return empty list on error
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {


    if (message.action === 'getPopupData') {

        // 1. Get the state immediately (this is synchronous)
        const state = capturedHtml ? 'elementCaptured' : 'readyToSelect';

        // 2. Send the state back to the popup *immediately*
        sendResponse({state: state});

        // 3. *After* sending the state, start the slow
        chrome.storage.sync.get(['julesApiKey'], async (result) => {
            if (!result.julesApiKey) {
                chrome.runtime.sendMessage({action: 'julesError', error: "API Key not set"});
                return;
            }

            const sources = await fetchSources(result.julesApiKey);

            // 4. Send a *new* message to the popup with the sources
            //    when they are finally ready.
            chrome.runtime.sendMessage({ action: "sourcesLoaded", sources: sources });
        });

        // Return true because we are doing async work
        // after the initial sendResponse.
        return true;
    }

    if (message.action === "startSelection") {

        resetState();

        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            const tabId = tabs[0].id;

            chrome.scripting.insertCSS({
                target: {tabId: tabId},
                files: ["selector.css"]
            });

            chrome.scripting.executeScript({
                target: {tabId: tabId},
                files: ["selector.js"]
            });
        });
    }

    if (message.action === "elementCaptured") {
        capturedHtml = message.html;

        // Set the "success" badge on the icon.
        chrome.action.setBadgeText({ text: '✅' });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    }

    if (message.action === "cancelSelection") {
        resetState();
    }

    if (message.action === "submitTask") {
        if (!capturedHtml) {
            chrome.runtime.sendMessage({action: "julesError", error: "No element captured yet."});
            return;
        }

        const task = message.task;
        const sourceName = message.repositoryId;

        chrome.storage.sync.get(['julesApiKey'], (result) => {
            if (!result.julesApiKey) {
                chrome.runtime.sendMessage({action: "julesError", error: "API Key not set. Please set it in Options."});
                return;
            }

            createJulesSession(task, capturedHtml, sourceName, result.julesApiKey);
        });

        return true;
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

            // --- THIS IS THE FIX ---
            // We must provide the repo context, as shown in the docs.
            // We'll default to "main" as the starting branch.
            "githubRepoContext": {
                "startingBranch": "main"
            }
        },
        title: simpleTitle
    };

    try {
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
        resetState();
    }
}

chrome.tabs.onActivated.addListener(() => {
    resetState();
})