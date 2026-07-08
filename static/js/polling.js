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

// Fields that tick on their own (server_hour changes every minute) without the
// data meaningfully changing. Compare payloads with these stripped — otherwise
// every tab rebuilds its DOM once a minute forever, yanking scroll/focus.
const VOLATILE_KEYS = ['time_of_day', 'server_hour', 'server_day_of_year', 'server_date', 'date'];
function _stableSnapshot(data) {
    const o = Object.assign({}, data);
    for (const k of VOLATILE_KEYS) delete o[k];
    return JSON.stringify(o);
}

async function pollForUpdates() {
    try {
        // Fallback for a render deferred by core.js's render() guard: normally
        // the focusout handler above replays it the moment focus leaves, but
        // iOS PWA can drop that event (backgrounding mid-blur, etc.), so also
        // check here on every tick — if nothing's focused anymore, catch up.
        if (_pendingRender) {
            const a = document.activeElement;
            const stillTyping = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
            if (!stillTyping) { _pendingRender = false; render(); }
        }

        // Check if code itself changed — if so, full reload
        const vRes = await fetch('/api/version');
        const vData = await vRes.json();
        if (codeVersion && vData.hash !== codeVersion) {
            location.reload();
            return;
        }
        codeVersion = vData.hash;

        // Check if data changed
        let endpoint = TAB_ENDPOINTS[currentTab] || '/api/data';
        if (typeof endpoint === 'function') endpoint = endpoint();
        const res = await fetch(endpoint);
        const data = await res.json();
        if (data.error) return; // don't replace good data with an error payload
        // Keep the clock-driven globals fresh every poll, render or not —
        // otherwise "today's" forms can log to yesterday after midnight.
        syncTimeOfDay(data.time_of_day);
        if (data.server_date) _serverDate = data.server_date;
        const snapshot = _stableSnapshot(data);
        if (snapshot !== lastDataHash) {
            lastDataHash = snapshot;
            D = data;
            // Guarded: only today/map payloads carry habits — the bare forEach
            // used to throw here, silently killing live polling on other tabs.
            if (D.habits) D.habits.forEach(s => { s.items = s.items.map(i => typeof i === 'string' ? i : i.text); });
            if (_inputFocused) {
                _pendingRender = true; // render when they leave the input
            } else {
                render();
            }
        }
    } catch(e) { console.error('Poll failed:', e); }
    finally { window._lastPollAt = Date.now(); }
}
setInterval(pollForUpdates, 5000);

// When the PWA returns from the background (phone wake / tab refocus), the in-memory
// _serverDate can be stale — setInterval is throttled while hidden, so no poll ran and
// the date is frozen at whenever the app last loaded. A stale date silently logs
// "today's" symptoms/food to yesterday. Re-sync from the server the moment we're visible.
// Debounced: if a poll already landed within the last 4s, _serverDate can't be
// stale yet, so skip the extra fetch — this is what saves the redundant refetch
// on quick tab-switches/focus blips without reintroducing the staleness bug.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (window._lastPollAt && Date.now() - window._lastPollAt <= 4000) return;
    loadDashboard();
    window._lastPollAt = Date.now();
});

// --- Go ---
// Fresh page load → start the To-Do ladder in its default layout (only "Now" open).
if (currentTab === 'today') resetTodoCollapseMemory();
initTab();
loadDashboard();
