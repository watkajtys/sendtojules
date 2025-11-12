(function() {

    // --- 1. Define event handlers ---

    function onMouseOver(event) {
        event.target.classList.add('_jules_highlight');
    }

    function onMouseOut(event) {
        event.target.classList.remove('_jules_highlight');
    }

    /**
     * THIS FUNCTION IS NOW FIXED
     * It now cleans the HTML before sending.
     */
    function onClick(event) {
        event.preventDefault();
        event.stopPropagation(); // Stop the click from firing on the page

        // --- THE FIX ---
        // 1. Clone the element
        const cleanElement = event.target.cloneNode(true);

        // 2. Remove our class from the clone and all its children
        cleanElement.classList.remove('_jules_highlight');
        cleanElement.querySelectorAll('._jules_highlight').forEach(el => {
            el.classList.remove('_jules_highlight');
        });

        // 3. Get the outerHTML of the *clean clone*
        const capturedHtml = cleanElement.outerHTML;
        // --- END FIX ---

        // 4. Selection is done, clean up all listeners on the live page
        cleanup();

        // 5. Send the clean, captured data to the background script
        chrome.runtime.sendMessage({
            action: 'elementCaptured',
            html: capturedHtml
        });
    }

    // Listen for the 'Escape' key to cancel
    function onKeyDown(event) {
        if (event.key === "Escape") {
            cleanup();
            // Also tell the background to clear its state
            chrome.runtime.sendMessage({ action: "cancelSelection" });
        }
    }

    // --- 2. Define a dedicated cleanup function ---

    function cleanup() {
        // Remove all event listeners
        document.removeEventListener('mouseover', onMouseOver);
        document.removeEventListener('mouseout', onMouseOut);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);

        // Just in case, find any remaining highlights on the live page and remove them
        const highlighted = document.querySelectorAll('._jules_highlight');
        highlighted.forEach(el => {
            el.classList.remove('_jules_highlight');
        });
    }

    // --- 3. Attach all event listeners ---

    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true); // Add the new listener

})();