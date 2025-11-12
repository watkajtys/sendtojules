document.addEventListener('DOMContentLoaded', () => {
    // --- 1. Get all our UI elements ---
    const selectView = document.getElementById('selectView');
    const taskView = document.getElementById('taskView');
    const resultView = document.getElementById('resultView');

    const selectButton = document.getElementById('selectElement');
    const submitButton = document.getElementById('submitTask');
    const reselectButton = document.getElementById('reselect');
    const startOverButton = document.getElementById('startOver'); // Corrected

    const repoSearch = document.getElementById('repoSearch');
    const repoResults = document.getElementById('repoResults');
    const selectedRepo = document.getElementById('selectedRepo');
    const clearRepoSelection = document.getElementById('clearRepoSelection'); // NEW

    const taskPrompt = document.getElementById('taskPrompt');
    const statusDiv = document.getElementById('status');

    // --- NEW: Get the new UI elements ---
    const codePreview = document.getElementById('codePreview');
    const resultTitle = document.getElementById('resultTitle');
    const sessionLink = document.getElementById('sessionLink');

    // --- NEW: Get spinner elements ---
    const repoLoadingSpinner = document.getElementById('repoLoadingSpinner');
    const submitSpinner = document.getElementById('submitSpinner');

    let allSources = []; // Cache for sources
    let highlightedRepoIndex = -1; // For keyboard navigation

    // --- NEW: Get the new result elements ---
    const resultSubtitle = document.getElementById('resultSubtitle');

    // Helper function to set status and apply/remove error class
    function setStatus(message, isError = false) {
        statusDiv.textContent = message;
        if (isError) {
            statusDiv.classList.add('error-message');
        } else {
            statusDiv.classList.remove('error-message');
        }
    }

    // Function to update clear button visibility
    function updateClearButtonVisibility() {
        if (selectedRepo.value) {
            clearRepoSelection.style.display = 'inline-block';
        } else {
            clearRepoSelection.style.display = 'none';
        }
    }

    // --- 2. Main setup: Ask background for state & HTML ---
    // Show repo loading spinner initially
    repoLoadingSpinner.style.display = 'inline-block';
    chrome.runtime.sendMessage({ action: "getPopupData" }, (response) => {
        // Show the correct view *immediately*
        if (response.state === 'elementCaptured') {
            selectView.style.display = 'none';
            taskView.style.display = 'block';
            resultView.style.display = 'none';

            if (response.capturedHtml) {
                codePreview.querySelector('code').textContent = response.capturedHtml; // Set text content of <code>

            }
        } else {
            selectView.style.display = 'block';
            taskView.style.display = 'none';
            resultView.style.display = 'none';
        }
        updateClearButtonVisibility(); // Update on initial load
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
            highlightedRepoIndex = -1; // Reset highlight on blur
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
            setStatus('Please enter a task.', true);
            return;
        }
        if (!repositoryId) {
            setStatus('Please select a source.', true);
            return;
        }
        setStatus('Creating Jules session...');
        submitButton.disabled = true;
        submitSpinner.style.display = 'inline-block'; // Show submit spinner
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
        setStatus('');
    });

    // NEW: Clear button event listener
    clearRepoSelection.addEventListener('click', () => {
        repoSearch.value = '';
        selectedRepo.value = '';
        updateClearButtonVisibility();
        populateRepoResults(allSources); // Show all options again
        repoSearch.focus(); // Keep focus on search for convenience
    });

    // --- 4. Listen for all messages FROM the background script ---
    chrome.runtime.onMessage.addListener((message) => {

        if (message.action === "sourcesLoaded") {
            repoLoadingSpinner.style.display = 'none'; // Hide repo loading spinner
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
            submitSpinner.style.display = 'none'; // Hide submit spinner
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
            setStatus('');
        }

        if (message.action === "julesError") {
            submitSpinner.style.display = 'none'; // Hide submit spinner
            setStatus(`Error: ${message.error}`, true);
            submitButton.disabled = false;
        }
    });

    // --- 5. Add search input listeners (unchanged) ---
    function populateRepoResults(sources) {
        repoResults.innerHTML = '';
        highlightedRepoIndex = -1; // Reset highlight
        if (sources.length === 0) {
            repoResults.innerHTML = '<div style="padding: 5px; color: #888;">No matches</div>';
            return;
        }
        sources.forEach((source, index) => {
            const item = document.createElement('div');
            item.textContent = source.name;
            item.setAttribute('data-id', source.id);
            item.setAttribute('data-index', index); // Store index for navigation
            item.style.padding = '8px 10px';
            item.style.cursor = 'pointer';
            item.addEventListener('mouseover', () => {
                removeHighlight();
                item.style.backgroundColor = 'var(--bg-dropdown-hover)';
                highlightedRepoIndex = index;
            });
            item.addEventListener('mouseout', () => {
                item.style.backgroundColor = 'var(--bg-dropdown)';
            });
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectRepoItem(item);
            });
            repoResults.appendChild(item);
        });
    }

    function selectRepoItem(item) {
        repoSearch.value = item.textContent;
        selectedRepo.value = item.getAttribute('data-id');
        repoResults.style.display = 'none';
        updateClearButtonVisibility(); // Update after selection
        repoSearch.focus(); // Keep focus on search for convenience
    }

    function removeHighlight() {
        const currentHighlighted = repoResults.querySelector('.highlighted');
        if (currentHighlighted) {
            currentHighlighted.style.backgroundColor = 'var(--bg-dropdown)';
            currentHighlighted.classList.remove('highlighted');
        }
    }

    function highlightItem(index) {
        removeHighlight();
        const items = repoResults.querySelectorAll('div[data-index]');
        if (items.length > 0 && index >= 0 && index < items.length) {
            const itemToHighlight = items[index];
            itemToHighlight.style.backgroundColor = 'var(--bg-dropdown-hover)';
            itemToHighlight.classList.add('highlighted');
            itemToHighlight.scrollIntoView({ block: 'nearest' });
            highlightedRepoIndex = index;
        }
    }

    repoSearch.addEventListener('input', () => {
        const query = repoSearch.value.toLowerCase();
        const filteredSources = allSources.filter(source => source.name.toLowerCase().includes(query));
        populateRepoResults(filteredSources);
        repoResults.style.display = 'block';
        updateClearButtonVisibility(); // Update on input change
    });

    repoSearch.addEventListener('keydown', (e) => {
        const items = repoResults.querySelectorAll('div[data-index]');
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            highlightedRepoIndex = (highlightedRepoIndex + 1) % items.length;
            highlightItem(highlightedRepoIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            highlightedRepoIndex = (highlightedRepoIndex - 1 + items.length) % items.length;
            highlightItem(highlightedRepoIndex);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightedRepoIndex !== -1) {
                selectRepoItem(items[highlightedRepoIndex]);
            } else if (items.length === 1) { // If only one item, select it on Enter
                selectRepoItem(items[0]);
            }
        } else if (e.key === 'Escape') {
            repoResults.style.display = 'none';
            repoSearch.blur();
        }
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

    // Send a message to the background script when the popup is closed
    window.addEventListener('unload', () => {
        chrome.runtime.sendMessage({ action: "popupClosed" });
    });
});