document.addEventListener('DOMContentLoaded', () => {
    // --- 1. Get all our UI elements ---
    const selectView = document.getElementById('selectView');
    const taskView = document.getElementById('taskView');
    const resultView = document.getElementById('resultView');

    const selectButton = document.getElementById('selectElement');
    const submitButton = document.getElementById('submitTask');
    const reselectButton = document.getElementById('reselect');
    const startOverButton = document.getElementById('startOver');

    const repoSearch = document.getElementById('repoSearch');
    const repoResults = document.getElementById('repoResults');
    const selectedRepo = document.getElementById('selectedRepo');

    const taskPrompt = document.getElementById('taskPrompt');
    const statusDiv = document.getElementById('status');

    // --- NEW: Get the new UI elements ---
    const codePreview = document.getElementById('codePreview');
    const resultTitle = document.getElementById('resultTitle');
    const sessionLink = document.getElementById('sessionLink');

    let allSources = []; // Cache for sources

    // --- NEW: Get the new result elements ---
    const resultSubtitle = document.getElementById('resultSubtitle');

    // --- 2. Main setup: Ask background for state & HTML ---
    chrome.runtime.sendMessage({ action: "getPopupData" }, (response) => {
        // Show the correct view *immediately*
        if (response.state === 'elementCaptured') {
            selectView.style.display = 'none';
            taskView.style.display = 'block';
            resultView.style.display = 'none';

            if (response.capturedHtml) {
                codePreview.textContent = response.capturedHtml;
            }
        } else {
            selectView.style.display = 'block';
            taskView.style.display = 'none';
            resultView.style.display = 'none';
        }
    });

    // --- NEW: Show/Hide results on focus/blur ---
    repoSearch.addEventListener('focus', () => {
        // Populate with all results if search is empty
        if (repoSearch.value === '') {
            populateRepoResults(allSources);
        }
        repoResults.style.display = 'block';
    });

    repoSearch.addEventListener('blur', () => {
        // Delay hiding so a click on a result can register
        setTimeout(() => {
            repoResults.style.display = 'none';
        }, 200);
    });

    // --- 3. Add Event Listeners for all buttons ---
    selectButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "startSelection" });
        window.close();
    });

    reselectButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "startSelection" });
        window.close();
    });

    submitButton.addEventListener('click', () => {
        const task = taskPrompt.value;
        const repositoryId = selectedRepo.value;
        if (!task) {
            statusDiv.textContent = 'Please enter a task.';
            return;
        }
        if (!repositoryId) {
            statusDiv.textContent = 'Please select a source.';
            return;
        }
        statusDiv.textContent = 'Creating Jules session...';
        submitButton.disabled = true;
        chrome.runtime.sendMessage({
            action: "submitTask",
            task: task,
            repositoryId: repositoryId
        });
    });

    startOverButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "cancelSelection" });
        resultView.style.display = 'none';
        startOverButton.style.display = 'none'; // <-- NEW: Hide itself
        selectView.style.display = 'block';
        statusDiv.textContent = '';
    });

    // --- 4. Listen for all messages FROM the background script ---
    chrome.runtime.onMessage.addListener((message) => {

        if (message.action === "sourcesLoaded") {
            const sources = message.sources;
            if (sources && sources.length > 0) {
                allSources = sources;
                repoSearch.placeholder = "Search for a source...";
                populateRepoResults(allSources);
            } else {
                repoSearch.placeholder = "No sources found";
                repoSearch.disabled = true;
            }
        }

        if (message.action === "julesResponse") {
            const sessionData = message.data;

            if (sessionData && sessionData.id) {
                // --- NEW: Set the text from the screenshot ---
                resultTitle.textContent = 'Task created!';
                resultSubtitle.textContent = 'Jules is working on your task';

                // Set the link URL
                sessionLink.href = `https://jules.google.com/session/${sessionData.id}`;
            } else {
                // Fallback on error
                resultTitle.textContent = 'Task created (unknown format)';
                resultSubtitle.textContent = 'Could not find session ID in response.';
                sessionLink.href = '#';
            }

            // --- NEW: Show the toast and "Start Over" button ---
            taskView.style.display = 'none';
            resultView.style.display = 'flex'; // Use flex to match new CSS
            startOverButton.style.display = 'block'; // Show the separate button
            statusDiv.textContent = '';
        }

        if (message.action === "julesError") {
            statusDiv.textContent = `Error: ${message.error}`;
            submitButton.disabled = false;
        }
    });

    // --- 5. Add search input listeners (unchanged) ---
    function populateRepoResults(sources) {
        repoResults.innerHTML = '';
        if (sources.length === 0) {
            repoResults.innerHTML = '<div style="padding: 5px; color: #888;">No matches</div>';
            return;
        }
        sources.forEach(source => {
            const item = document.createElement('div');
            item.textContent = source.name;
            item.setAttribute('data-id', source.id);
            item.style.padding = '8px 10px';
            item.style.cursor = 'pointer';
            item.addEventListener('mouseover', () => item.style.backgroundColor = 'var(--bg-dropdown-hover)');
            item.addEventListener('mouseout', () => item.style.backgroundColor = 'var(--bg-dropdown)');
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                repoSearch.value = item.textContent;
                selectedRepo.value = item.getAttribute('data-id');
                repoResults.style.display = 'none';
            });
            repoResults.appendChild(item);
        });
    }
    repoSearch.addEventListener('input', () => {
        const query = repoSearch.value.toLowerCase();
        const filteredSources = allSources.filter(source => source.name.toLowerCase().includes(query));
        populateRepoResults(filteredSources);
        repoResults.style.display = 'block';
    });
    repoSearch.addEventListener('focus', () => {
        if (repoSearch.value === '') {
            populateRepoResults(allSources);
        }
        repoResults.style.display = 'block';
    });
    repoSearch.addEventListener('blur', () => {
        setTimeout(() => { repoResults.style.display = 'none'; }, 200);
    });
});