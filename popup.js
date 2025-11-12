document.addEventListener('DOMContentLoaded', () => {
    // --- 1. Get all our UI elements ---
    const selectView = document.getElementById('selectView');
    const taskView = document.getElementById('taskView');
    const resultView = document.getElementById('resultView');

    const selectButton = document.getElementById('selectElement');
    const submitButton = document.getElementById('submitTask');
    const reselectButton = document.getElementById('reselect');
    const startOverButton = document.getElementById('startOver');

    // NEW: Get searchable dropdown elements
    const repoSearch = document.getElementById('repoSearch');
    const repoResults = document.getElementById('repoResults');
    const selectedRepo = document.getElementById('selectedRepo');

    const taskPrompt = document.getElementById('taskPrompt');
    const apiResponse = document.getElementById('apiResponse');
    const statusDiv = document.getElementById('status');

    // Store the full list of sources from the API
    let allSources = [];

    // --- 2. Main setup: Ask background for state ONLY ---
    // This message is now fast and only sets the view.
    chrome.runtime.sendMessage({ action: "getPopupData" }, (response) => {

        // Show the correct view *immediately*
        if (response.state === 'elementCaptured') {
            selectView.style.display = 'none';
            taskView.style.display = 'block';
            // The dropdown will show "Loading repositories..."
            // from the HTML, which is now correct.
        } else {
            selectView.style.display = 'block';
            taskView.style.display = 'none';
        }
    });

    // This logic is now handled by the 'sourcesLoaded' listener below
    /*
    if (sources && sources.length > 0) {
        allSources = sources;
        // Initially populate the list so user can see options
        populateRepoResults(allSources);
    } else if (!response.error) {
        repoSearch.placeholder = "No sources found";
        repoSearch.disabled = true;
    }
    */

    // --- NEW: Event listener for the search input ---
    repoSearch.addEventListener('input', () => {
        const query = repoSearch.value.toLowerCase();
        const filteredSources = allSources.filter(source =>
            source.name.toLowerCase().includes(query)
        );
        populateRepoResults(filteredSources);
        repoResults.style.display = 'block'; // Show results
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

    // --- NEW: Helper function to populate the results div ---
    function populateRepoResults(sources) {
        repoResults.innerHTML = ''; // Clear old results
        if (sources.length === 0) {
            repoResults.innerHTML = '<div style="padding: 5px; color: #888;">No matches</div>';
            return;
        }

        sources.forEach(source => {
            const item = document.createElement('div');
            item.textContent = source.name;
            item.setAttribute('data-id', source.id); // Store the "sources/..." ID
            item.style.padding = '5px';
            item.style.cursor = 'pointer';

            // Add hover effect
            item.addEventListener('mouseover', () => item.style.backgroundColor = '#f0f0f0');
            item.addEventListener('mouseout', () => item.style.backgroundColor = '#fff');

            // Handle click on a result item
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Prevent blur from firing first
                const selectedId = item.getAttribute('data-id');
                const selectedName = item.textContent;

                // Set the UI
                repoSearch.value = selectedName; // Show the user what they picked
                selectedRepo.value = selectedId; // Store the actual ID for submission

                repoResults.style.display = 'none'; // Hide results
            });

            repoResults.appendChild(item);
        });
    }

    // --- 3. Add Event Listeners for all buttons ---

    selectButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "startSelection" });
        window.close();
    });

    reselectButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "startSelection" });
        window.close();
    });

    // "Submit to Jules" button (MODIFIED)
    submitButton.addEventListener('click', () => {
        const task = taskPrompt.value;
        const repositoryId = selectedRepo.value; // <-- Use the hidden input's value

        if (!task) {
            statusDiv.textContent = 'Please enter a task.';
            return;
        }
        if (!repositoryId) { // This check is now for the hidden input
            statusDiv.textContent = 'Please select a source.';
            return;
        }

        statusDiv.textContent = 'Creating Jules session...';
        submitButton.disabled = true;

        chrome.runtime.sendMessage({
            action: "submitTask",
            task: task,
            repositoryId: repositoryId // This is the "sources/..." name
        });
    });

    startOverButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "cancelSelection" });
        resultView.style.display = 'none';
        selectView.style.display = 'block';
        statusDiv.textContent = '';
    });

    // --- 4. Listen for all messages FROM the background script ---
    chrome.runtime.onMessage.addListener((message) => {

        // --- NEW: This is the second half of the flow ---
        // It receives the slow data (sources)
        if (message.action === "sourcesLoaded") {
            const sources = message.sources;
            if (sources && sources.length > 0) {
                allSources = sources;
                // Now that we have the data, populate the search
                repoSearch.placeholder = "Search for a source...";
                populateRepoResults(allSources);
            } else {
                repoSearch.placeholder = "No sources found";
                repoSearch.disabled = true;
            }
        }

        if (message.action === "julesResponse") {
            const sessionData = message.data;
            let formattedResponse = '';

            if (sessionData && sessionData.name) {
                formattedResponse = `Session created successfully!
-------------------------
Name: ${sessionData.name}
Title: ${sessionData.title}
Source: ${sessionData.sourceContext.source}
`;
            } else {
                formattedResponse = JSON.stringify(sessionData, null, 2);
            }

            apiResponse.textContent = formattedResponse;

            taskView.style.display = 'none';
            resultView.style.display = 'block';
            statusDiv.textContent = '';
        }

        if (message.action === "julesError") {
            statusDiv.textContent = `Error: ${message.error}`;
            submitButton.disabled = false;
        }
    });
});