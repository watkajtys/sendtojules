document.addEventListener("DOMContentLoaded", () => {
    const apiKeyInput = document.getElementById("apiKey");
    const saveButton = document.getElementById('save');
    const statusDiv = document.getElementById('status');

    chrome.storage.sync.get(['julesApiKey'], (result) => {
        if (result.julesApiKey) {
            apiKeyInput.value = result.julesApiKey;
        }
    });

    chrome.storage.sync.get(['julesApiKey'], (result) => {
        if (result.julesApiKey) {
            apiKeyInput.value = result.julesApiKey;
        }
    });

    saveButton.addEventListener("click", () => {
        const apiKey = apiKeyInput.value;

        chrome.storage.sync.set({'julesApiKey': apiKey}, () => {
            statusDiv.textContent = 'API Key saved!';

            setTimeout(() => { statusDiv.textContent = ''; }, 2000);
        });
    });
});