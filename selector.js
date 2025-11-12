(function() {
    // This flag prevents multiple instances of the selector from running on the same page.
    if (window.hasOwnProperty('__julesSelectorActive')) {
        return; // A script has already been injected and is listening.
    }
    window.__julesSelectorActive = false; // Set initial state to inactive.

    let tooltip;
    let breadcrumb;
    let debounceTimer;

    function createUI() {
        tooltip = document.createElement('div');
        tooltip.classList.add('_jules_tooltip');
        document.body.appendChild(tooltip);

        breadcrumb = document.createElement('div');
        breadcrumb.classList.add('_jules_breadcrumb');
        document.body.appendChild(breadcrumb);
    }

    function debounce(func, delay) {
        return function(...args) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => func.apply(this, args), delay);
        };
    }

    function getSelector(el) {
        if (!el) return '';
        let path = [];
        while (el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.id) {
                selector += '#' + el.id;
                path.unshift(selector);
                break;
            } else {
                let sib = el, nth = 1;
                while (sib = sib.previousElementSibling) {
                    if (sib.nodeName.toLowerCase() === selector) nth++;
                }
                if (nth !== 1) selector += `:nth-of-type(${nth})`;
            }
            path.unshift(selector);
            el = el.parentNode;
        }
        return path.join(" > ");
    }

    function onMouseOver(event) {
        event.target.classList.add('_jules_highlight');
        updateUIDebounced(event);
    }

    const updateUIDebounced = debounce((event) => {
        const target = event.target;
        const fullSelector = getSelector(target);
        if (breadcrumb) breadcrumb.textContent = fullSelector;
        if (tooltip) {
            const tag = target.tagName.toLowerCase();
            const id = target.id ? `#${target.id}` : '';
            const classAttr = target.getAttribute('class') || '';
            const classes = classAttr ? `.${classAttr.split(' ').filter(c => !c.startsWith('_jules_')).join('.')}` : '';
            const dims = `${target.offsetWidth}px x ${target.offsetHeight}px`;
            const hint = `Click to capture`;

            tooltip.innerHTML = `
              <div class="_jules_tooltip_header">
                <span class="_jules_tooltip_tag">${tag}</span>
                <span class="_jules_tooltip_id">${id}</span>
              </div>
              <div class="_jules_tooltip_classes">${classes}</div>
              <div class="_jules_tooltip_dims">${dims}</div>
              <div class="_jules_tooltip_hint">${hint}</div>
            `;
            tooltip.style.left = (event.pageX + 15) + 'px';
            tooltip.style.top = (event.pageY + 15) + 'px';
        }
    }, 100);

    function onMouseOut(event) {
        event.target.classList.remove('_jules_highlight');
    }

    function onClick(event) {
        event.preventDefault();
        event.stopPropagation();
        const target = event.target;
        const cleanElement = target.cloneNode(true);
        cleanElement.classList.remove('_jules_highlight');
        cleanElement.querySelectorAll('._jules_highlight').forEach(el => el.classList.remove('_jules_highlight'));

        const classAttr = target.getAttribute('class') || '';
        const capturedData = {
            outerHTML: cleanElement.outerHTML,
            tag: target.tagName.toLowerCase(),
            id: target.id,
            classes: classAttr.split(' ').filter(c => !c.startsWith('_jules_')).join(' '),
        };
        cleanup();
        chrome.runtime.sendMessage({ action: 'elementCaptured', data: capturedData });
    }

    function onKeyDown(event) {
        if (event.key === "Escape") {
            cleanup();
            chrome.runtime.sendMessage({ action: "cancelSelection" });
        }
    }

    function cleanup() {
        if (!window.__julesSelectorActive) return;
        document.removeEventListener('mouseover', onMouseOver);
        document.removeEventListener('mouseout', onMouseOut);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (tooltip) tooltip.remove();
        if (breadcrumb) breadcrumb.remove();
        document.querySelectorAll('._jules_highlight').forEach(el => el.classList.remove('_jules_highlight'));
        window.__julesSelectorActive = false;
    }

    function init() {
        if (window.__julesSelectorActive) return;
        window.__julesSelectorActive = true;
        createUI();
        document.addEventListener('mouseover', onMouseOver);
        document.addEventListener('mouseout', onMouseOut);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKeyDown, true);
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === "startSelection") { // Changed from startJulesSelection
            init();
        } else if (message.action === "cleanupSelector") {
            cleanup();
        }
    });

    window.addEventListener('beforeunload', cleanup);
})();