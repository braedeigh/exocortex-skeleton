// pending.js — surfaces staged dashboard changes as an approval modal.
//
// Every 3s it asks /api/pending whether an agent has staged anything. If so, it
// pops #change-modal (z-index above everything, so it floats over the terminal
// pane too). Approve commits it for real; Deny discards it. Nothing the agent
// proposes touches the dashboard until you tap a button here.

let _changeModalId = null; // id of the change currently shown (don't re-pop it)
let _changeBusy = false;   // guard against double-taps mid-request

async function checkPendingChanges() {
    const modal = document.getElementById('change-modal');
    if (!modal || _changeBusy || modal.classList.contains('open')) return;
    try {
        const res = await fetch('/api/pending');
        const data = await res.json();
        const list = (data && data.pending) || [];
        if (list.length) showChangeModal(list[0]); // one at a time, FIFO
    } catch (e) { /* poll hiccup — try again next tick */ }
}

function showChangeModal(change) {
    _changeModalId = change.id;
    document.getElementById('change-modal-summary').textContent = change.summary || '(change)';
    document.getElementById('change-modal').classList.add('open');
}

function closeChangeModal() {
    document.getElementById('change-modal').classList.remove('open');
    _changeModalId = null;
}

async function _decide(action) {
    if (!_changeModalId || _changeBusy) return;
    _changeBusy = true;
    const id = _changeModalId;
    try {
        await fetch('/api/pending/' + action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
    } finally {
        _changeBusy = false;
        closeChangeModal();
        // On approve, refresh so the newly-committed data shows immediately.
        if (action === 'approve' && typeof loadDashboard === 'function') loadDashboard();
    }
}

function approveChange() { _decide('approve'); }
function denyChange() { _decide('deny'); }

setInterval(checkPendingChanges, 3000);
