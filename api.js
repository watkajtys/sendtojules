// --- API Interaction ---

// This module handles all fetch calls to the Jules API.

import { capturedNetworkActivity, resetState } from './state.js';

const API_BASE_URL = 'https://jules.googleapis.com/v1alpha';

/**
 * Fetches the list of available sources from the Jules API.
 * Implements a stale-while-revalidate caching strategy.
 *
 * @param {string} apiKey - The user's API key.
 */
export async function fetchSources(apiKey) {
    // 1. Immediately send cached data if it exists.
    chrome.storage.local.get('julesSourcesCache', (result) => {
        if (result.julesSourcesCache && result.julesSourcesCache.sources) {
            chrome.runtime.sendMessage({
                action: "sourcesLoaded",
                sources: result.julesSourcesCache.sources
            });
        }
    });

    // 2. Always fetch fresh data in the background.
    const sourcesApiUrl = `${API_BASE_URL}/sources`;
    let allSources = [];
    let nextPageToken = null;

    try {
        do {
            const url = nextPageToken ? `${sourcesApiUrl}?pageToken=${nextPageToken}` : sourcesApiUrl;
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' }
            });

            if (!response.ok) throw new Error(`API Error ${response.status}: ${await response.text()}`);

            const data = await response.json();
            if (data.sources) allSources.push(...data.sources);
            nextPageToken = data.nextPageToken;
        } while (nextPageToken);

        const newSources = allSources.map(source => ({
            id: source.name,
            name: source.id,
            githubRepo: source.githubRepo // Keep the full repo info
        }));

        // 3. Compare with cache and update if necessary.
        const result = await chrome.storage.local.get('julesSourcesCache');
        const oldSources = result.julesSourcesCache ? result.julesSourcesCache.sources : null;

        if (JSON.stringify(oldSources) !== JSON.stringify(newSources)) {
            await chrome.storage.local.set({
                julesSourcesCache: { sources: newSources, timestamp: Date.now() }
            });
            const action = oldSources ? "sourcesRefreshed" : "sourcesLoaded";
            chrome.runtime.sendMessage({ action: action, sources: newSources });
        }
    } catch (error) {
        console.error('Failed to fetch sources:', error);
        const result = await chrome.storage.local.get('julesSourcesCache');
        if (!result.julesSourcesCache) {
            chrome.runtime.sendMessage({ action: "julesError", error: "Could not fetch sources." });
        }
    }
}

/**
 * Creates a new Jules session with the provided task details.
 *
 * @param {string} task - The task description.
 * @param {object} data - The captured element data.
 * @param {string} sourceName - The name of the selected source repository.
 * @param {string} branch - The selected branch name.
 * @param {string} apiKey - The user's API key.
 * @param {Array} logs - The captured console logs.
 * @param {boolean} isCapturingCSS - Whether to include computed CSS in the prompt.
 */
export async function createJulesSession(task, data, sourceName, branch, apiKey, logs, isCapturingCSS) {
    const sessionsApiUrl = `${API_BASE_URL}/sessions`;
    const cleanTask = task.trim();
    const simpleTitle = cleanTask.split('\n')[0].substring(0, 80);
    let prompt = cleanTask;

    if (data && data.outerHTML) {
        prompt += `\n\nThe user has selected the following HTML element:\n\`\`\`html\n${data.outerHTML}\n\`\`\``;
        if (data.selector) {
            prompt += `\n\nThe element is located at the following DOM Path:\n\`\`\`css\n${data.selector}\n\`\`\``;
        }
    }
    if (isCapturingCSS && data && data.dimensions) {
        let dimensionsString = `\n\n--- Element Dimensions ---\n`;
        dimensionsString += `Width: ${data.dimensions.width}px, Height: ${data.dimensions.height}px\n`;
        dimensionsString += `Margin: ${data.dimensions.margin.top} ${data.dimensions.margin.right} ${data.dimensions.margin.bottom} ${data.dimensions.margin.left}\n`;
        dimensionsString += `Padding: ${data.dimensions.padding.top} ${data.dimensions.padding.right} ${data.dimensions.padding.bottom} ${data.dimensions.padding.left}\n`;
        dimensionsString += `Border: ${data.dimensions.border.top} ${data.dimensions.border.right} ${data.dimensions.border.bottom} ${data.dimensions.border.left}\n`;
        prompt += dimensionsString;
    }
    if (isCapturingCSS && data && data.computedCss) {
        let formattedCss = '';
        for (const [state, properties] of Object.entries(data.computedCss)) {
            formattedCss += `/* ${state} */\n`;
            const propEntries = Object.entries(properties);
            if (propEntries.length > 0) {
                formattedCss += `element {\n`;
                for (const [prop, value] of propEntries) {
                    formattedCss += `  ${prop}: ${value};\n`;
                }
                formattedCss += `}\n`;
            }
        }
        if (formattedCss) {
            prompt += `\n\nThe element has the following computed CSS styles:\n\`\`\`css\n${formattedCss.trim()}\n\`\`\``;
        }
    }
    if (logs && logs.length > 0) {
        const formattedLogs = logs.map(log => `[${log.timestamp}] [${log.level}] ${log.message}`).join('\n');
        prompt += `\n\n--- Captured Console Logs ---\n${formattedLogs}\n--- End Logs ---`;
    }
    if (capturedNetworkActivity && capturedNetworkActivity.length > 0) {
        const formattedNetwork = capturedNetworkActivity.map(req => {
            return `[${new Date(req.timestamp * 1000).toISOString()}] ${req.method} ${req.url} - Status: ${req.status}\nResponse Body (truncated):\n${req.responseBody || 'N/A'}`;
        }).join('\n\n');
        prompt += `\n\n--- Captured Network Activity ---\n${formattedNetwork}\n--- End Network Activity ---`;
    }

    const payload = {
        prompt: prompt,
        sourceContext: {
            source: sourceName,
            githubRepoContext: { startingBranch: branch || "" }
        },
        title: simpleTitle
    };

    try {
        const response = await fetch(sessionsApiUrl, {
            method: 'POST',
            headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: { message: 'Unknown API error' } }));
            throw new Error(errorData.error?.message || `API Error: ${response.status}`);
        }

        const sessionData = await response.json();
        chrome.runtime.sendMessage({ action: "julesResponse", data: sessionData });
        await chrome.storage.local.remove('julesHistoryCache');
    } catch (error) {
        console.error('Failed to create Jules session:', error);
        chrome.runtime.sendMessage({ action: "julesError", error: error.message });
    } finally {
        resetState(true); // Perform a full reset after submission
    }
}

/**
 * Fetches the user's session history from the Jules API.
 * Also uses a stale-while-revalidate cache.
 *
 * @param {string} apiKey - The user's API key.
 */
export async function fetchHistory(apiKey) {
    const HISTORY_CACHE_KEY = 'julesHistoryCache';

    // 1. Immediately send cached data
    chrome.storage.local.get(HISTORY_CACHE_KEY, (result) => {
        if (result[HISTORY_CACHE_KEY] && result[HISTORY_CACHE_KEY].sessions) {
            chrome.runtime.sendMessage({
                action: "historyLoaded",
                history: result[HISTORY_CACHE_KEY].sessions,
                isFromCache: true
            });
        }
    });

    // 2. Fetch fresh data
    const sessionsApiUrl = `${API_BASE_URL}/sessions?pageSize=5`;
    try {
        const response = await fetch(sessionsApiUrl, {
            method: 'GET',
            headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`API Error ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        const newHistory = data.sessions || [];

        const result = await chrome.storage.local.get(HISTORY_CACHE_KEY);
        const oldHistory = result[HISTORY_CACHE_KEY] ? result[HISTORY_CACHE_KEY].sessions : null;

        if (JSON.stringify(oldHistory) !== JSON.stringify(newHistory)) {
            await chrome.storage.local.set({ [HISTORY_CACHE_KEY]: { sessions: newHistory } });
        }
        chrome.runtime.sendMessage({ action: "historyLoaded", history: newHistory, isFromCache: false });

    } catch (error) {
        console.error('Failed to fetch session history:', error);
        const result = await chrome.storage.local.get(HISTORY_CACHE_KEY);
        if (!result[HISTORY_CACHE_KEY]) {
            chrome.runtime.sendMessage({ action: "julesError", error: "Could not fetch session history." });
        }
    }
}
