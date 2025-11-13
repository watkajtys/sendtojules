document.addEventListener('DOMContentLoaded', () => {
    // --- UI Element Cache ---
    const ui = {
        views: {
            select: document.getElementById('selectView'),
            task: document.getElementById('taskView'),
            result: document.getElementById('resultView'),
        },
        buttons: {
            select: document.getElementById('selectElement'),
            createTaskWithoutSelection: document.getElementById('createTaskWithoutSelection'),
            submit: document.getElementById('submitTask'),
            reselect: document.getElementById('reselect'),
            startOver: document.getElementById('startOver'),
            clearRepo: document.getElementById('clearRepoSelection'),
        },
        inputs: {
            repoSearch: document.getElementById('repoSearch'),
            selectedRepo: document.getElementById('selectedRepo'),
            taskPrompt: document.getElementById('taskPrompt'),
        },
        spinners: {
            repo: document.getElementById('repoLoadingSpinner'),
            submit: document.getElementById('submitSpinner'),
        },
        repoResults: document.getElementById('repoResults'),
        codePreview: document.getElementById('codePreview'),
        resultTitle: document.getElementById('resultTitle'),
        resultSubtitle: document.getElementById('resultSubtitle'),
        sessionLink: document.getElementById('sessionLink'),
        status: document.getElementById('status'),
    };

    // --- State ---
    let allSources = [];
    let recentRepos = [];
    let highlightedRepoIndex = -1;

    // --- View Management ---
    function switchView(viewName) {
        Object.values(ui.views).forEach(view => view.style.display = 'none');
        const viewToShow = ui.views[viewName];
        if (viewToShow) {
            // Use 'flex' for the result view as defined in the CSS, 'block' for others.
            viewToShow.style.display = viewName === 'result' ? 'flex' : 'block';
        }
    }

    // --- UI Helpers ---
    function setStatus(message, isError = false) {
        ui.status.textContent = message;
        ui.status.classList.toggle('error-message', isError);
    }

    function toggleSpinner(spinnerName, show) {
        if (ui.spinners[spinnerName]) {
            ui.spinners[spinnerName].style.display = show ? 'inline-block' : 'none';
        }
    }

    function updateClearButtonVisibility() {
        ui.buttons.clearRepo.style.display = ui.inputs.selectedRepo.value ? 'inline-block' : 'none';
    }


    // --- Repo Search Logic ---
    function populateRepoResults(filteredSources) {
        ui.repoResults.innerHTML = '';
        highlightedRepoIndex = -1;
        let currentIndex = 0;

        const createItem = (source) => {
            const item = document.createElement('div');
            item.className = '_jules_repo-item';
            item.textContent = source.name;
            item.dataset.id = source.id;
            item.dataset.index = currentIndex++;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectRepoItem(item);
            });
            return item;
        };

        const createHeader = (title) => {
            const header = document.createElement('div');
            header.className = '_jules_repo-header';
            header.textContent = title;
            return header;
        };

        // Filter out recent repos from the main list to avoid duplication
        const recentIds = new Set(recentRepos.map(r => r.id));
        const nonRecentSources = filteredSources.filter(s => !recentIds.has(s.id));
        const query = ui.inputs.repoSearch.value.toLowerCase();

        // Show recents only when the search is empty
        if (query === '' && recentRepos.length > 0) {
            ui.repoResults.appendChild(createHeader('Recently Used'));
            recentRepos.forEach(repo => ui.repoResults.appendChild(createItem(repo)));
            if (nonRecentSources.length > 0) {
                 ui.repoResults.appendChild(createHeader('All Repositories'));
            }
        }

        // Add the filtered list of all sources
        if (nonRecentSources.length > 0) {
            nonRecentSources.forEach(source => ui.repoResults.appendChild(createItem(source)));
        }

        // Handle no results case
        if (ui.repoResults.children.length === 0) {
            ui.repoResults.innerHTML = '<div class="_jules_no-match">No matches</div>';
        }
    }


    function selectRepoItem(item) {
        ui.inputs.repoSearch.value = item.textContent;
        ui.inputs.selectedRepo.value = item.dataset.id;
        ui.repoResults.style.display = 'none';
        updateClearButtonVisibility();
        ui.inputs.taskPrompt.focus(); // Move focus to the task prompt
    }

    function highlightRepoItem(index) {
        const items = ui.repoResults.querySelectorAll('._jules_repo-item');
        items.forEach(item => item.classList.remove('highlighted'));
        if (items.length > 0 && index >= 0 && index < items.length) {
            const itemToHighlight = items[index];
            itemToHighlight.classList.add('highlighted');
            itemToHighlight.scrollIntoView({ block: 'nearest' });
            highlightedRepoIndex = index;
        }
    }

    // --- Event Handlers ---
    function setupEventListeners() {
        ui.buttons.select.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "startSelection" });
            window.close();
        });

        ui.buttons.createTaskWithoutSelection.addEventListener('click', () => {
            // No element is selected, so we clear any lingering state
            // and switch directly to the task submission view.
            chrome.runtime.sendMessage({ action: "cancelSelection" }); // Resets background state
            ui.codePreview.querySelector('code').textContent = 'No element selected.';
            switchView('task');
        });

        ui.buttons.reselect.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "startSelection" });
            window.close();
        });

        ui.buttons.submit.addEventListener('click', () => {
            const task = ui.inputs.taskPrompt.value;
            const repositoryId = ui.inputs.selectedRepo.value;
            if (!task.trim()) {
                setStatus('Please enter a task.', true);
                return;
            }
            if (!repositoryId) {
                setStatus('Please select a source.', true);
                return;
            }
            setStatus('');
            ui.buttons.submit.disabled = true;
            toggleSpinner('submit', true);
            chrome.runtime.sendMessage({ action: "submitTask", task, repositoryId });
        });

        ui.buttons.startOver.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "cancelSelection" });
            switchView('select');
            setStatus('');
        });

        ui.buttons.clearRepo.addEventListener('click', () => {
            ui.inputs.repoSearch.value = '';
            ui.inputs.selectedRepo.value = '';
            updateClearButtonVisibility();
            populateRepoResults(allSources);
            ui.inputs.repoSearch.focus();
        });

        // Repo search input events
        ui.inputs.repoSearch.addEventListener('input', () => {
            const query = ui.inputs.repoSearch.value.toLowerCase();
            const filtered = allSources.filter(s => s.name.toLowerCase().includes(query));
            populateRepoResults(filtered);
            ui.repoResults.style.display = 'block';
            updateClearButtonVisibility();
        });

        ui.inputs.repoSearch.addEventListener('focus', () => {
            if (ui.inputs.repoSearch.value === '') {
                populateRepoResults(allSources);
            }
            ui.repoResults.style.display = 'block';
        });

        ui.inputs.repoSearch.addEventListener('blur', () => {
            setTimeout(() => { ui.repoResults.style.display = 'none'; }, 200);
        });

        ui.inputs.repoSearch.addEventListener('keydown', (e) => {
            const items = ui.repoResults.querySelectorAll('._jules_repo-item');
            if (items.length === 0) return;
            let newIndex = highlightedRepoIndex;

            if (e.key === 'ArrowDown') {
                newIndex = (highlightedRepoIndex + 1) % items.length;
            } else if (e.key === 'ArrowUp') {
                newIndex = (highlightedRepoIndex - 1 + items.length) % items.length;
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (highlightedRepoIndex !== -1) {
                    selectRepoItem(items[highlightedRepoIndex]);
                } else if (items.length === 1) {
                    selectRepoItem(items[0]);
                }
                return;
            } else if (e.key === 'Escape') {
                ui.repoResults.style.display = 'none';
                return;
            }
            highlightRepoItem(newIndex);
        });

        // Close popup handler
        window.addEventListener('unload', () => {
            chrome.runtime.sendMessage({ action: "popupClosed" });
        });
    }

    // --- Message Listeners from Background ---
    function setupMessageListeners() {
        chrome.runtime.onMessage.addListener((message) => {
            switch (message.action) {
                case "sourcesLoaded":
                case "sourcesRefreshed":
                    toggleSpinner('repo', false);
                    allSources = message.sources || [];

                    if (allSources.length > 0) {
                        ui.inputs.repoSearch.placeholder = "Search for a repository...";
                        ui.inputs.repoSearch.disabled = false;
                    } else {
                        ui.inputs.repoSearch.placeholder = "No repositories found";
                        ui.inputs.repoSearch.disabled = true;
                    }

                    // Repopulate with the latest list, preserving any search query
                    const currentQuery = ui.inputs.repoSearch.value.toLowerCase();
                    const filtered = allSources.filter(s => s.name.toLowerCase().includes(currentQuery));
                    populateRepoResults(filtered);
                    break;

                case "julesResponse":
                    toggleSpinner('submit', false);
                    const { data } = message;
                    if (data?.id) {
                        ui.resultTitle.textContent = 'Task created!';
                        ui.resultSubtitle.textContent = 'Jules is working on your task.';
                        ui.sessionLink.href = `https://jules.google.com/session/${data.id}`;
                    } else {
                         ui.resultTitle.textContent = 'Task Submitted';
                         ui.resultSubtitle.textContent = 'Could not parse session ID from response.';
                         ui.sessionLink.href = '#';
                    }
                    switchView('result');
                    setStatus('');
                    break;

                case "julesError":
                    toggleSpinner('repo', false);
                    toggleSpinner('submit', false);
                    setStatus(`Error: ${message.error}`, true);
                    ui.buttons.submit.disabled = false;
                    break;
            }
        });
    }

    // --- Initialization ---
    function init() {
        setupEventListeners();
        setupMessageListeners();

        toggleSpinner('repo', true);
        chrome.runtime.sendMessage({ action: "getPopupData" }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus("Error communicating with background.", true);
                toggleSpinner('repo', false);
                return;
            }

            recentRepos = response.recentRepos || [];

            if (response.state === 'elementCaptured') {
                ui.codePreview.querySelector('code').textContent = response.capturedHtml || 'No HTML captured.';
                switchView('task');
                // Initial population of results if sources are already cached
                if (allSources.length > 0) {
                     populateRepoResults(allSources);
                }
            } else {
                switchView('select');
            }
            updateClearButtonVisibility();
        });
    }

    init();
});
