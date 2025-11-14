document.addEventListener('DOMContentLoaded', () => {
    // --- UI Element Cache ---
    const ui = {
        views: {
            select: document.getElementById('selectView'),
            task: document.getElementById('taskView'),
            result: document.getElementById('resultView'),
            dismiss: document.getElementById('dismissView'),
            history: document.getElementById('historyView'),
        },
        buttons: {
            select: document.getElementById('selectElement'),
            createTaskWithoutSelection: document.getElementById('createTaskWithoutSelection'),
            viewHistory: document.getElementById('viewHistory'),
            back: document.getElementById('backButton'),
            submit: document.getElementById('submitTask'),
            reselect: document.getElementById('reselect'),
            cancelTask: document.getElementById('cancelTask'),
            startOver: document.getElementById('startOver'),
            clearRepo: document.getElementById('clearRepoSelection'),
            dismissTask: document.getElementById('dismissTask'),
            selectedRepo: document.getElementById('selectedRepoButton'),
            selectedBranch: document.getElementById('selectedBranchButton'),
        },
        inputs: {
            repoSearch: document.getElementById('repoSearch'),
            selectedRepo: document.getElementById('selectedRepo'),
            taskPrompt: document.getElementById('taskPrompt'),
            branchSearch: document.getElementById('branchSearch'),
        },
        repoInputWrapper: document.getElementById('repo-input-wrapper'),
        sourceSelectionContainer: document.getElementById('sourceSelectionContainer'),
        branchResults: document.getElementById('branchResults'),
        branchList: document.getElementById('branchList'),
        toggles: {
            captureLogs: document.getElementById('captureLogsToggle'),
            captureNetwork: document.getElementById('captureNetworkToggle'),
            captureCSS: document.getElementById('captureCSSToggle'),
        },
        containers: {
            cssCapture: document.getElementById('cssCaptureContainer'),
        },
        previews: {
            code: document.getElementById('codePreview'),
            css: document.getElementById('cssPreview'),
            selector: document.getElementById('selectorPreview'),
        },
        explanations: {
            log: document.getElementById('logExplanation'),
            network: document.getElementById('networkExplanation'),
        },
        spinners: {
            repo: document.getElementById('repoLoadingSpinner'),
            submit: document.getElementById('submitSpinner'),
            history: document.getElementById('historyLoadingSpinner'),
        },
        historyList: document.getElementById('historyList'),
        repoResults: document.getElementById('repoResults'),
        codePreview: document.getElementById('codePreview'),
        resultTitle: document.getElementById('resultTitle'),
        resultSubtitle: document.getElementById('resultSubtitle'),
        sessionLink: document.getElementById('sessionLink'),
        status: document.getElementById('status'),
        infoMessage: document.getElementById('info-message'),
    };

    // --- State ---
    let allSources = [];
    let recentRepos = [];
    let highlightedRepoIndex = -1;
    let selectedRepoBranches = [];
    let selectedBranch = '';
    let highlightedBranchIndex = -1;

    // --- View Management ---
    function switchView(viewName) {
        Object.values(ui.views).forEach(view => view.style.display = 'none');
        const viewToShow = ui.views[viewName];
        if (viewToShow) {
            viewToShow.style.display = viewName === 'result' ? 'flex' : 'block';
        }

        if (viewName === 'result') {
            ui.views.dismiss.style.display = 'flex';
        }
        chrome.runtime.sendMessage({ action: 'setViewState', view: viewName });
    }

    // --- UI Helpers ---
    function setStatus(message, isError = false) {
        ui.status.textContent = message;
        ui.status.classList.toggle('error-message', isError);
    }

    let infoTimeout;
    function setInfoMessage(message,- autoDismiss = true) {
        clearTimeout(infoTimeout);
        if (message) {
            ui.infoMessage.textContent = message;
            ui.infoMessage.style.display = 'block';
            if (autoDismiss) {
                infoTimeout = setTimeout(() => {
                    ui.infoMessage.style.display = 'none';
                }, 5000); // Hide after 5 seconds
            }
        } else {
            ui.infoMessage.style.display = 'none';
        }
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

        const recentIds = new Set(recentRepos.map(r => r.id));
        const nonRecentSources = filteredSources.filter(s => !recentIds.has(s.id));
        const query = ui.inputs.repoSearch.value.toLowerCase();

        if (query === '' && recentRepos.length > 0) {
            ui.repoResults.appendChild(createHeader('Recently Used'));
            recentRepos.forEach(repo => ui.repoResults.appendChild(createItem(repo)));
            if (nonRecentSources.length > 0) {
                 ui.repoResults.appendChild(createHeader('All Repositories'));
            }
        }

        if (nonRecentSources.length > 0) {
            nonRecentSources.forEach(source => ui.repoResults.appendChild(createItem(source)));
        }

        if (ui.repoResults.children.length === 0) {
            ui.repoResults.innerHTML = '<div class="_jules_no-match">No matches</div>';
        }
    }


    function selectRepoItem(item) {
        const repoId = item.dataset.id;
        const repoData = allSources.find(s => s.id === repoId);

        ui.inputs.selectedRepo.value = repoId;
        ui.buttons.selectedRepo.textContent = repoData.name;

        if (repoData && repoData.githubRepo) {
            selectedRepoBranches = repoData.githubRepo.branches || [];
            const defaultBranch = repoData.githubRepo.defaultBranch?.displayName;

            if (defaultBranch) {
                selectedBranch = defaultBranch;
                ui.buttons.selectedBranch.textContent = defaultBranch;
                populateBranchResults(selectedRepoBranches);
            }
        }

        ui.repoInputWrapper.style.display = 'none';
        ui.sourceSelectionContainer.style.display = 'flex';
        ui.repoResults.style.display = 'none';
        updateClearButtonVisibility();
        ui.inputs.taskPrompt.focus();
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

    // --- Branch Selection Logic ---

    function populateBranchResults(branches) {
        ui.branchList.innerHTML = '';
        highlightedBranchIndex = -1;
        let currentIndex = 0;

        branches.forEach(branch => {
            const item = document.createElement('div');
            item.className = '_jules_branch-item';
            item.textContent = branch.displayName;
            item.dataset.index = currentIndex++;
            if (branch.displayName === selectedBranch) {
                item.classList.add('selected');
                const check = document.createElement('img');
                check.src = 'icons/check.svg';
                check.className = 'check-icon';
                item.appendChild(check);
            }
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectBranchItem(item);
            });
            ui.branchList.appendChild(item);
        });
    }

    function selectBranchItem(item) {
        selectedBranch = item.textContent;
        ui.buttons.selectedBranch.textContent = selectedBranch;
        ui.branchResults.style.display = 'none';
        ui.inputs.taskPrompt.focus();
    }

    function highlightBranchItem(index) {
        const items = ui.branchList.querySelectorAll('._jules_branch-item');
        items.forEach(item => item.classList.remove('highlighted'));
        if (items.length > 0 && index >= 0 && index < items.length) {
            const itemToHighlight = items[index];
            itemToHighlight.classList.add('highlighted');
            itemToHighlight.scrollIntoView({ block: 'nearest' });
            highlightedBranchIndex = index;
        }
    }

    // --- Event Handlers ---
    function setupEventListeners() {
        ui.inputs.taskPrompt.addEventListener('input', (e) => {
            chrome.runtime.sendMessage({ action: 'saveTaskPrompt', text: e.target.value });
        });

        ui.buttons.select.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "startSelection" });
            window.close();
        });

        ui.buttons.createTaskWithoutSelection.addEventListener('click', () => {
            ui.containers.cssCapture.style.display = 'none';
            ui.previews.code.querySelector('code').textContent = 'No element selected.';
            switchView('task');
        });

        ui.buttons.viewHistory.addEventListener('click', () => {
            switchView('history');
            ui.historyList.innerHTML = '';
            toggleSpinner('history', true);
            chrome.runtime.sendMessage({ action: "fetchHistory" });
        });

        ui.buttons.back.addEventListener('click', () => {
            switchView('select');
        });

        ui.buttons.reselect.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "startSelection" });
            window.close();
        });

        ui.buttons.submit.addEventListener('click', () => {
            const task = ui.inputs.taskPrompt.value;
            const repositoryId = ui.inputs.selectedRepo.value;
            const branch = selectedBranch;

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
            chrome.runtime.sendMessage({ action: "submitTask", task, repositoryId, branch });
        });

        ui.buttons.startOver.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "cancelSelection" });
            switchView('select');
            setStatus('');
        });

        ui.buttons.cancelTask.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "cancelSelection" });
            switchView('select');
            setStatus('');
        });

        ui.buttons.dismissTask.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: "cancelSelection" });
            switchView('select');
            setStatus('');
        });

        ui.buttons.clearRepo.addEventListener('click', () => {
            ui.inputs.repoSearch.value = '';
            ui.inputs.selectedRepo.value = '';
            selectedBranch = '';
            selectedRepoBranches = [];
            ui.sourceSelectionContainer.style.display = 'none';
            ui.repoInputWrapper.style.display = 'block';
            updateClearButtonVisibility();
            populateRepoResults(allSources);
            ui.inputs.repoSearch.focus();
        });

        ui.buttons.selectedRepo.addEventListener('click', () => {
            ui.sourceSelectionContainer.style.display = 'none';
            ui.repoInputWrapper.style.display = 'block';
            ui.inputs.repoSearch.focus();
            ui.inputs.repoSearch.select();
        });

        ui.buttons.selectedBranch.addEventListener('click', () => {
            ui.branchResults.style.display = ui.branchResults.style.display === 'block' ? 'none' : 'block';
            if (ui.branchResults.style.display === 'block') {
                ui.inputs.branchSearch.value = '';
                populateBranchResults(selectedRepoBranches);
                ui.inputs.branchSearch.focus();
            }
        });

        document.addEventListener('click', (e) => {
            if (!ui.buttons.selectedBranch.contains(e.target) && !ui.branchResults.contains(e.target)) {
                ui.branchResults.style.display = 'none';
            }
        });

        ui.inputs.branchSearch.addEventListener('input', () => {
            const query = ui.inputs.branchSearch.value.toLowerCase();
            const filtered = selectedRepoBranches.filter(b => b.displayName.toLowerCase().includes(query));
            populateBranchResults(filtered);
        });

        ui.inputs.branchSearch.addEventListener('keydown', (e) => {
            const items = ui.branchList.querySelectorAll('._jules_branch-item');
            if (items.length === 0) return;
            let newIndex = highlightedBranchIndex;

            if (e.key === 'ArrowDown') {
                newIndex = (highlightedBranchIndex + 1) % items.length;
            } else if (e.key === 'ArrowUp') {
                newIndex = (highlightedBranchIndex - 1 + items.length) % items.length;
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (highlightedBranchIndex !== -1) {
                    selectBranchItem(items[highlightedBranchIndex]);
                } else if (items.length > 0) {
                    selectBranchItem(items[0]);
                }
                return;
            }
            highlightBranchItem(newIndex);
        });

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

        window.addEventListener('unload', () => {
            chrome.runtime.sendMessage({ action: "popupClosed" });
        });

        ui.toggles.captureLogs.addEventListener('change', (e) => {
            const isEnabled = e.target.checked;
            ui.explanations.log.style.display = isEnabled ? 'block' : 'none';
            if (isEnabled) {
                setInfoMessage("Debugger attaching. A banner will appear in Chrome. This is expected.");
            } else {
                setInfoMessage("Debugger detaching. This may take a moment.");
            }
            chrome.runtime.sendMessage({ action: "toggleLogCapture", enabled: isEnabled });
        });

        ui.toggles.captureNetwork.addEventListener('change', (e) => {
            const isEnabled = e.target.checked;
            ui.explanations.network.style.display = isEnabled ? 'block' : 'none';
            if (isEnabled) {
                setInfoMessage("Debugger attaching. A banner will appear in Chrome. This is expected.");
            } else {
                setInfoMessage("Debugger detaching. This may take a moment.");
            }
            chrome.runtime.sendMessage({ action: "toggleNetworkCapture", enabled: isEnabled });
        });

        ui.toggles.captureCSS.addEventListener('change', (e) => {
            const isEnabled = e.target.checked;
            const cssPreviewLabel = document.querySelector('label[for="cssPreview"]');
            if (cssPreviewLabel) {
                cssPreviewLabel.style.display = isEnabled ? 'block' : 'none';
            }
            ui.previews.css.style.display = isEnabled ? 'block' : 'none';
            chrome.runtime.sendMessage({ action: "toggleCSSCapture", enabled: isEnabled });
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
                    const isHistoryVisible = ui.views.history.style.display !== 'none';
                    const hasCachedHistory = ui.historyList.children.length > 0 && ui.historyList.children[0].className === 'history-card';

                    if (isHistoryVisible && hasCachedHistory) {
                        setStatus("Failed to refresh history.", true);
                        toggleSpinner('history', false);
                    } else {
                        toggleSpinner('repo', false);
                        toggleSpinner('submit', false);
                        toggleSpinner('history', false);
                        setStatus(`Error: ${message.error}`, true);
                        ui.buttons.submit.disabled = false;
                    }
                    break;

                case "historyLoaded":
                    if (!message.isFromCache) {
                        toggleSpinner('history', false);
                    }
                    renderHistory(message.history, message.isFromCache);
                    break;
            }
        });
    }

    function timeAgo(date) {
        const now = new Date();
        const seconds = Math.round((now - date) / 1000);
        const minutes = Math.round(seconds / 60);
        const hours = Math.round(minutes / 60);
        const days = Math.round(hours / 24);
        const weeks = Math.round(days / 7);
        const months = Math.round(days / 30.44); // Average month length
        const years = Math.round(days / 365.25); // Account for leap years

        if (seconds < 60) return `${seconds}s ago`;
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return days === 1 ? 'yesterday' : `${days}d ago`;
        if (weeks < 5) return `${weeks}w ago`;
        if (months < 12) return `${months}mo ago`;
        return `${years}y ago`;
    }

    function renderHistory(history, isFromCache) {
        ui.historyList.innerHTML = '';

        if (!history || history.length === 0) {
            if (!isFromCache) {
                ui.historyList.innerHTML = '<div class="history-item">No recent tasks found.</div>';
            }
            return;
        }

        const fragment = document.createDocumentFragment();
        history.forEach(session => {
            const card = document.createElement('div');
            card.className = 'history-card';
            const status = session.state || 'UNKNOWN';
            const repoName = session.sourceContext?.source.split('/').slice(-2).join('/') || 'N/A';
            const branchName = session.sourceContext?.githubRepoContext?.startingBranch || 'main';
            const creationDate = session.createTime ? new Date(session.createTime) : new Date();
            const time = timeAgo(creationDate);

            card.innerHTML = `
                <a href="https://jules.google.com/session/${session.id}" target="_blank" class="history-link">
                    <div class="history-card-header">
                        <span class="history-card-title">${session.title}</span>
                        <span class="history-card-status status-${status.toLowerCase()}">${status}</span>
                    </div>
                    <div class="history-card-repo">
                        <span>${repoName} (${branchName})</span>
                        <span class="history-card-time">${time}</span>
                    </div>
                </a>
            `;
            fragment.appendChild(card);
        });

        ui.historyList.appendChild(fragment);
    }

    // --- Initialization ---
    function init() {
        setupEventListeners();
        setupMessageListeners();

        chrome.runtime.sendMessage({ action: "popupOpened" }, (response) => {
            if (response && response.taskPromptText) {
                ui.inputs.taskPrompt.value = response.taskPromptText;
            }
        });

        toggleSpinner('repo', true);
        chrome.runtime.sendMessage({ action: "getPopupData" }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus("Error communicating with background.", true);
                toggleSpinner('repo', false);
                return;
            }

            recentRepos = response.recentRepos || [];

            // Immediately render the cached recent repos to give the user an interactive UI.
            // The full list will be populated when the background fetch completes.
            populateRepoResults(allSources);

            const isLogging = response.isLogging || false;
            ui.toggles.captureLogs.checked = isLogging;
            ui.explanations.log.style.display = isLogging ? 'block' : 'none';

            const isCapturingNetwork = response.isCapturingNetwork || false;
            ui.toggles.captureNetwork.checked = isCapturingNetwork;
            ui.explanations.network.style.display = isCapturingNetwork ? 'block' : 'none';

            const viewToDisplay = response.view || 'select';

            if (response.state === 'elementCaptured' && response.capturedHtml) {
                ui.previews.code.querySelector('code').textContent = response.capturedHtml;
                ui.previews.selector.querySelector('code').textContent = response.capturedSelector || 'No selector captured.';
                ui.containers.cssCapture.style.display = 'block';

                const isCapturingCSS = response.isCapturingCSS ?? false;
                ui.toggles.captureCSS.checked = isCapturingCSS;

                const cssPreviewLabel = document.querySelector('label[for="cssPreview"]');
                if (cssPreviewLabel) {
                    cssPreviewLabel.style.display = 'none';
                }
                ui.previews.css.style.display = 'none';

                if (isCapturingCSS) {
                    if (cssPreviewLabel) {
                        cssPreviewLabel.style.display = 'block';
                    }
                    ui.previews.css.style.display = 'block';
                }

                if (response.capturedCss) {
                    let formattedCss = '';
                    for (const [state, properties] of Object.entries(response.capturedCss)) {
                        formattedCss += `/* ${state} */\n`;
                        for (const [prop, value] of Object.entries(properties)) {
                            formattedCss += `  ${prop}: ${value};\n`;
                        }
                    }
                    ui.previews.css.querySelector('code').textContent = formattedCss.trim() || 'No CSS captured.';
                } else {
                    ui.previews.css.querySelector('code').textContent = 'No CSS captured.';
                }

            } else {
                ui.previews.code.querySelector('code').textContent = 'No element selected.';
                ui.containers.cssCapture.style.display = 'none';
            }
            switchView(viewToDisplay);
            if (viewToDisplay === 'history') {
                ui.historyList.innerHTML = '';
                toggleSpinner('history', true);
                chrome.runtime.sendMessage({ action: "fetchHistory" });
            }

            if (allSources.length > 0) {
                populateRepoResults(allSources);
            }

            updateClearButtonVisibility();
        });
    }

    init();
});
