(function() {

    let breadcrumb;
    let debounceTimer;

    function createBreadcrumb() {
        breadcrumb = document.createElement('div');
        breadcrumb.classList.add('_jules_breadcrumb');
        document.body.appendChild(breadcrumb);
    }

    /**
     * Debounce function to limit how often a function can run.
     * @param {Function} func The function to debounce.
     * @param {number} delay The delay in milliseconds.
     * @returns {Function} The debounced function.
     */
    function debounce(func, delay) {
        return function(...args) {
            const context = this;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => func.apply(context, args), delay);
        };
    }

    /**
     * Generates a CSS selector for a given element.
     * This function is not fully robust and has limitations, for example it does not support shadow DOM.
     * @param {Element} el The element to generate the selector for.
     * @returns {string} The CSS selector.
     */
    function getSelector(el) {
        if (!el) return '';
        let path = [];
        while (el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.id) {
                // If the element has an ID, use it and stop traversing up
                selector += '#' + el.id;
                path.unshift(selector);
                break;
            } else {
                // Otherwise, find the element's position among its siblings
                let sib = el, nth = 1;
                while (sib = sib.previousElementSibling) {
                    if (sib.nodeName.toLowerCase() == selector)
                        nth++;
                }
                if (nth != 1)
                    selector += ":nth-of-type("+nth+")";
            }
            path.unshift(selector);
            el = el.parentNode;
        }
        return path.join(" > ");
    }

    // --- 1. Define event handlers ---

    /**
     * Handles the mouseover event to highlight the element and update the breadcrumb.
     * Note: This event fires frequently. The `getSelector` function can be a bit slow on complex pages.
     * For this use case, the performance impact is likely negligible, but it's something to be aware of.
     * @param {MouseEvent} event The mouseover event.
     */
    function onMouseOver(event) {
        event.target.classList.add('_jules_highlight');
        updateBreadcrumbDebounced(event.target);
    }

    const updateBreadcrumbDebounced = debounce((targetElement) => {
        if (breadcrumb) {
            breadcrumb.textContent = getSelector(targetElement);
        }
    }, 100); // Debounce for 100ms

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

        if (breadcrumb) {
            breadcrumb.remove();
        }

        // Just in case, find any remaining highlights on the live page and remove them
        const highlighted = document.querySelectorAll('._jules_highlight');
        highlighted.forEach(el => {
            el.classList.remove('_jules_highlight');
        });
    }

    // --- 3. Attach all event listeners ---

    createBreadcrumb();
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true); // Add the new listener

})();