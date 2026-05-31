// polling.js — live polling for data updates
let lastDataHash = null;
let codeVersion = null;
let _pendingRender = false;

// Track input focus via events (more reliable on iOS than checking activeElement)
let _inputFocused = false;
document.addEventListener('focusin', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        _inputFocused = true;
    }
});
document.addEventListener('focusout', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        // Delay so we catch focus moving between inputs
        setTimeout(() => {
            const a = document.activeElement;
            if (!a || (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA' && a.tagName !== 'SELECT')) {
                _inputFocused = false;
                if (_pendingRender) { _pendingRender = false; render(); }
            }
        }, 300);
    }
});

async function pollForUpdates() {
    try {
        // Check if code itself changed — if so, full reload
        const vRes = await fetch('/api/version');
        const vData = await vRes.json();
        if (codeVersion && vData.hash !== codeVersion) {
            location.reload();
            return;
        }
        codeVersion = vData.hash;

        // Check if data changed
        const endpoint = TAB_ENDPOINTS[currentTab] || '/api/data';
        const res = await fetch(endpoint);
        const text = await res.text();
        if (text !== lastDataHash) {
            lastDataHash = text;
            D = JSON.parse(text);
            D.habits.forEach(s => { s.items = s.items.map(i => typeof i === 'string' ? i : i.text); });
            if (!selectedTime) selectedTime = D.time_of_day;
            if (_inputFocused) {
                _pendingRender = true; // render when they leave the input
            } else {
                render();
            }
        }
    } catch(e) { console.error('Poll failed:', e); }
}
setInterval(pollForUpdates, 5000);

// --- Go ---
initTab();
loadDashboard();
