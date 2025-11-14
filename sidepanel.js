document.addEventListener('DOMContentLoaded', () => {
    // --- UI Element Cache ---
    const ui = {
        views: {
            main: document.getElementById('mainView'),
            result: document.getElementById('resultView'),
            history: document.getElementById('historyView'),
        },
        taskPrompt: document.getElementById('taskPrompt'),
        submitTaskButton: document.getElementById('submitTaskButton'),
        addContextButton: document.getElementById('addContextButton'),
        contextIndicators: document.getElementById('context-indicators'),
        sourceSelectionContainer: document.getElementById('sourceSelectionContainer'),
        selectedRepoButton: document.getElementById('selectedRepoButton'),
        selectedBranchButton: document.getElementById('selectedBranchButton'),
        elementPreviewContainer: document.getElementById('element-preview-container'),
        contextMenu: {
            container: document.getElementById('contextMenu'),
            selectElement: document.getElementById('selectElementItem'),
            captureLogs: document.getElementById('captureLogsItem'),
            captureNetwork: document.getElementById('captureNetworkItem'),
            captureCss: document.getElementById('captureCssItem'),
            viewHistory: document.getElementById('viewHistoryItem'),
        },
        repoInputContainer: document.getElementById('repo-input-container'),
        repoSearch: document.getElementById('repoSearch'),
        repoResults: document.getElementById('repoResults'),
        branchSelectorWrapper: document.getElementById('branch-selector-wrapper'),
        branchResults: document.getElementById('branchResults'),
        branchSearch: document.getElementById('branchSearch'),
        branchList: document.getElementById('branchList'),
        elementCard: {
            container: document.getElementById('elementCard'),
            summary: document.getElementById('elementSummary'),
            reselectButton: document.getElementById('reselectButton'),
            dismissButton: document.getElementById('dismissButton'),
            htmlPreview: document.getElementById('htmlPreview'),
            domPathPreview: document.getElementById('domPathPreview'),
        },
        historyList: document.getElementById('historyList'),
        backButton: document.getElementById('backButton'),
        dismissResultButton: document.getElementById('dismissResultButton'),
        status: document.getElementById('status'),
        spinners: {
            repo: document.getElementById('repoLoadingSpinner'),
            submit: document.getElementById('submitSpinner'),
            history: document.getElementById('historyLoadingSpinner'),
        },
    };

    // --- State ---
    let state = {
        currentView: 'main',
        taskPrompt: '',
        allSources: [],
        recentRepos: [],
        selectedRepo: null,
        selectedBranch: null,
        selectedRepoBranches: [],
        isCapturingLogs: false,
        isCapturingNetwork: false,
        selectedElement: null,
        highlightedRepoIndex: -1,
        highlightedBranchIndex: -1,
    };

    // --- View Management ---
    function switchView(viewName) {
        state.currentView = viewName;
        Object.entries(ui.views).forEach(([name, viewElement]) => {
            if (viewElement) {
                viewElement.style.display = name === viewName ? 'flex' : 'none';
            }
        });
        chrome.runtime.sendMessage({ action: 'setViewState', view: viewName });
    }

    // --- Event Handlers ---
    ui.taskPrompt.addEventListener('input', (e) => {
        state.taskPrompt = e.target.value;
        chrome.runtime.sendMessage({ action: 'saveTaskPrompt', text: state.taskPrompt });
    });

    ui.taskPrompt.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            submitTask();
        }
    });

    ui.submitTaskButton.addEventListener('click', () => {
        submitTask();
    });

    ui.addContextButton.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleContextMenu();
    });

    ui.contextMenu.viewHistory.addEventListener('click', () => {
        switchView('history');
        toggleSpinner('history', true);
        chrome.runtime.sendMessage({ action: 'fetchHistory' });
        toggleContextMenu(false);
    });

    ui.backButton.addEventListener('click', () => {
        switchView('main');
    });

    ui.dismissResultButton.addEventListener('click', () => {
        switchView('main');
    });

    ui.contextMenu.selectElement.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "startSelection" });
        toggleContextMenu(false);
    });

    ui.contextMenu.captureLogs.addEventListener('click', () => {
        state.isCapturingLogs = !state.isCapturingLogs;
        chrome.runtime.sendMessage({ action: "toggleLogCapture", enabled: state.isCapturingLogs });
        renderContextIndicators();
        toggleContextMenu(false);
    });

    ui.contextMenu.captureCss.addEventListener('click', () => {
        state.isCapturingCSS = !state.isCapturingCSS;
        chrome.runtime.sendMessage({ action: "toggleCSSCapture", enabled: state.isCapturingCSS });
        renderElementCard(); // Re-render to show/hide the CSS section
        toggleContextMenu(false);
    });

    ui.contextMenu.captureNetwork.addEventListener('click', () => {
        state.isCapturingNetwork = !state.isCapturingNetwork;
        chrome.runtime.sendMessage({ action: "toggleNetworkCapture", enabled: state.isCapturingNetwork });
        renderContextIndicators();
        toggleContextMenu(false);
    });

    ui.selectedRepoButton.addEventListener('click', () => {
        ui.sourceSelectionContainer.style.display = 'none';
        ui.repoInputContainer.style.display = 'block';
        ui.repoSearch.focus();
        ui.repoSearch.select();
    });

    ui.selectedBranchButton.addEventListener('click', (e) => {
        e.stopPropagation();
        ui.branchResults.style.display = ui.branchResults.style.display === 'block' ? 'none' : 'block';
         if (ui.branchResults.style.display === 'block') {
            ui.branchSearch.value = '';
            populateBranchResults(state.selectedRepoBranches);
            ui.branchSearch.focus();
        }
    });

    ui.repoSearch.addEventListener('input', () => {
        const query = ui.repoSearch.value.toLowerCase();
        const filtered = state.allSources.filter(s => s.name.toLowerCase().includes(query));
        populateRepoResults(filtered);
    });

    ui.repoSearch.addEventListener('keydown', (e) => {
        handleKeyboardNavigation(e, ui.repoResults, 'repo-item', selectRepoItem, 'highlightedRepoIndex');
    });

    ui.branchSearch.addEventListener('input', () => {
        const query = ui.branchSearch.value.toLowerCase();
        const filtered = state.selectedRepoBranches.filter(b => b.displayName.toLowerCase().includes(query));
        populateBranchResults(filtered);
    });

    ui.branchSearch.addEventListener('keydown', (e) => {
        handleKeyboardNavigation(e, ui.branchList, 'branch-item', selectBranchItem, 'highlightedBranchIndex');
    });

    if (ui.elementCard.reselectButton) {
        ui.elementCard.reselectButton.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "startSelection" });
        });
    }

    if (ui.elementCard.dismissButton) {
        ui.elementCard.dismissButton.addEventListener('click', () => {
            state.selectedElement = null;
            chrome.runtime.sendMessage({ action: 'cancelSelection' });
            renderElementCard();
            renderContextIndicators();
        });
    }


    document.addEventListener('click', (e) => {
        if (!ui.contextMenu.container.contains(e.target)) {
            toggleContextMenu(false);
        }
        if (!ui.branchSelectorWrapper.contains(e.target)) {
            ui.branchResults.style.display = 'none';
        }
    });


    // --- Functions ---
    function toggleSpinner(spinnerName, show) {
        if (ui.spinners[spinnerName]) {
            ui.spinners[spinnerName].style.display = show ? 'inline-block' : 'none';
        }
    }

    function setStatus(message, isError = true) {
        ui.status.textContent = message;
        ui.status.style.display = message ? 'block' : 'none';
    }

    function submitTask() {
        if (!state.taskPrompt.trim()) {
            setStatus('Please enter a task description.');
            return;
        }
        if (!state.selectedRepo) {
            setStatus('Please select a repository.');
            return;
        }
        setStatus(''); // Clear status on successful submission
        toggleSpinner('submit', true);
        ui.submitTaskButton.disabled = true;
        chrome.runtime.sendMessage({
            action: "submitTask",
            task: state.taskPrompt,
            repositoryId: state.selectedRepo.id,
            branch: state.selectedBranch
        });
    }

    function toggleContextMenu(forceState) {
        const shouldBeVisible = forceState !== undefined ? forceState : ui.contextMenu.container.style.display === 'none';
        ui.contextMenu.container.style.display = shouldBeVisible ? 'block' : 'none';
    }

    function renderContextIndicators() {
        ui.contextIndicators.innerHTML = ''; // Clear existing indicators

        if (state.selectedElement) {
            const icon = document.createElement('img');
            icon.src = 'icons/code.svg';
            icon.className = 'context-icon';
            icon.title = `Element Selected: ${state.selectedElement.selector}`;
            ui.contextIndicators.appendChild(icon);
        }
        if (state.isCapturingLogs) {
            const icon = document.createElement('img');
            icon.src = 'icons/console.svg';
            icon.className = 'context-icon';
            icon.title = 'Capturing Console Logs';
            ui.contextIndicators.appendChild(icon);
        }
        if (state.isCapturingNetwork) {
            const icon = document.createElement('img');
            icon.src = 'icons/network.svg';
            icon.className = 'context-icon';
            icon.title = 'Capturing Network Activity';
            ui.contextIndicators.appendChild(icon);
        }
    }

    function populateRepoResults(filteredSources) {
        ui.repoResults.innerHTML = '';
        state.highlightedRepoIndex = -1;
        let currentIndex = 0;

        const createItem = (source) => {
            const item = document.createElement('div');
            item.className = 'repo-item';
            item.textContent = source.name;
            item.dataset.id = source.id;
            item.dataset.index = currentIndex++;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectRepoItem(item);
            });
            return item;
        };

        const recentIds = new Set(state.recentRepos.map(r => r.id));
        const nonRecentSources = filteredSources.filter(s => !recentIds.has(s.id));

        if (state.recentRepos.length > 0) {
            state.recentRepos.forEach(repo => ui.repoResults.appendChild(createItem(repo)));
        }
        if (nonRecentSources.length > 0) {
            nonRecentSources.forEach(source => ui.repoResults.appendChild(createItem(source)));
        }
    }

    function selectRepoItem(item) {
        const repoId = item.dataset.id;
        const repoData = state.allSources.find(s => s.id === repoId);
        state.selectedRepo = repoData;

        ui.selectedRepoButton.textContent = repoData.name;

        if (repoData && repoData.githubRepo) {
            state.selectedRepoBranches = repoData.githubRepo.branches || [];
            const defaultBranch = repoData.githubRepo.defaultBranch?.displayName;
            if (defaultBranch) {
                state.selectedBranch = defaultBranch;
                ui.selectedBranchButton.textContent = defaultBranch;
                populateBranchResults(state.selectedRepoBranches);
            }
        }

        ui.repoInputContainer.style.display = 'none';
        ui.sourceSelectionContainer.style.display = 'flex';
        ui.repoResults.style.display = 'none';
    }

    function populateBranchResults(branches) {
        ui.branchList.innerHTML = '';
        state.highlightedBranchIndex = -1;
        let currentIndex = 0;

        branches.forEach(branch => {
            const item = document.createElement('div');
            item.className = 'branch-item';
            item.textContent = branch.displayName;
            item.dataset.index = currentIndex++;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectBranchItem(item);
            });
            ui.branchList.appendChild(item);
        });
    }

    function selectBranchItem(item) {
        state.selectedBranch = item.textContent;
        ui.selectedBranchButton.textContent = state.selectedBranch;
        ui.branchResults.style.display = 'none';
    }

    function handleKeyboardNavigation(e, listElement, itemClass, selectCallback, indexStateKey) {
        const items = listElement.querySelectorAll(`.${itemClass}`);
        if (items.length === 0) return;
        let newIndex = state[indexStateKey];

        if (e.key === 'ArrowDown') {
            newIndex = (newIndex + 1) % items.length;
        } else if (e.key === 'ArrowUp') {
            newIndex = (newIndex - 1 + items.length) % items.length;
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (newIndex !== -1) {
                selectCallback(items[newIndex]);
            }
            return;
        }

        items.forEach(item => item.classList.remove('highlighted'));
        if (newIndex >= 0) {
            items[newIndex].classList.add('highlighted');
            items[newIndex].scrollIntoView({ block: 'nearest' });
        }
        state[indexStateKey] = newIndex;
    }

    function renderElementCard() {
        if (ui.elementCard.container && state.selectedElement) {
            const { selector, outerHTML, computedCss } = state.selectedElement;
            const summary = selector.split('>').pop().trim();
            ui.elementCard.summary.textContent = summary;
            ui.elementCard.htmlPreview.textContent = outerHTML;
            ui.elementCard.domPathPreview.textContent = selector;

            const cssDetails = document.getElementById('cssDetails');
            if (state.isCapturingCSS) {
                cssDetails.style.display = 'block';
                let formattedCss = '';
                if (computedCss) {
                    for (const [state, properties] of Object.entries(computedCss)) {
                        formattedCss += `/* ${state} */\n`;
                        for (const [prop, value] of Object.entries(properties)) {
                            formattedCss += `  ${prop}: ${value};\n`;
                        }
                    }
                }
                document.getElementById('cssPreview').textContent = formattedCss.trim() || 'No CSS captured.';
            } else {
                cssDetails.style.display = 'none';
            }

            ui.elementCard.container.style.display = 'block';
        } else if (ui.elementCard.container) {
            ui.elementCard.container.style.display = 'none';
        }
    }

    function renderHistory(history) {
        ui.historyList.innerHTML = '';
        if (!history || history.length === 0) {
            ui.historyList.innerHTML = '<div style="padding: 10px;">No recent tasks found.</div>';
            return;
        }

        const fragment = document.createDocumentFragment();
        history.forEach(session => {
            const card = document.createElement('div');
            card.className = 'history-card';
            const status = session.state || 'UNKNOWN';
            const repoName = session.sourceContext?.source.split('/').slice(-2).join('/') || 'N/A';
            const branchName = session.sourceContext?.githubRepoContext?.startingBranch || 'main';

            card.innerHTML = `
                <a href="https://jules.google.com/session/${session.id}" target="_blank" class="history-link">
                    <div class="history-card-header">
                        <span class="history-card-title">${session.title}</span>
                        <span class="history-card-status status-${status.toLowerCase()}">${status}</span>
                    </div>
                    <div class="history-card-repo">
                        <span>${repoName} (${branchName})</span>
                    </div>
                </a>
            `;
            fragment.appendChild(card);
        });

        ui.historyList.appendChild(fragment);
    }


    // --- Message Listeners from Background ---
    function setupMessageListeners() {
         chrome.runtime.onMessage.addListener((message) => {
            switch (message.action) {
                case "elementCaptured":
                    state.selectedElement = message.data;
                    renderContextIndicators();
                    renderElementCard();
                    break;
                case "stateUpdated":
                    Object.assign(state, message.newState);
                    renderContextIndicators();
                    renderElementCard();
                    // update repo/branch display
                    break;
                case "sourcesLoaded":
                    toggleSpinner('repo', false);
                    state.allSources = message.sources || [];
                    populateRepoResults(state.allSources);
                    break;
                case "historyLoaded":
                    toggleSpinner('history', false);
                    renderHistory(message.history);
                    break;
                case "julesResponse":
                    toggleSpinner('submit', false);
                    ui.submitTaskButton.disabled = false;
                    switchView('result');
                    document.getElementById('resultTitle').textContent = 'Task Created!';
                    document.getElementById('sessionLink').href = `https://jules.google.com/session/${message.data.id}`;
                    break;
            }
        });
    }


    // --- Initialization ---
    function init() {
        setupMessageListeners();
        toggleSpinner('repo', true);
        chrome.runtime.sendMessage({ action: "getSidePanelData" }, (response) => {
            if (response) {
                Object.assign(state, response);
                ui.taskPrompt.value = state.taskPrompt || '';
                renderContextIndicators();
                renderElementCard();

                if (state.selectedRepo) {
                    ui.selectedRepoButton.textContent = state.selectedRepo.name;
                    ui.selectedBranchButton.textContent = state.selectedBranch;
                } else {
                     ui.selectedRepoButton.textContent = 'Select Repository';
                     ui.selectedBranchButton.textContent = 'Select Branch';
                }

                if (response.view) {
                    switchView(response.view);
                }
            }
        });
    }

    init();
});
