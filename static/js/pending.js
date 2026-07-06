// pending.js — surfaces staged dashboard changes as an approval flow.
//
// Every 3s it asks /api/pending whether an agent (a cricket) has staged anything.
// If so, it opens an approval editor for the FIRST item. Each change `kind` can
// register its own editor that MIRRORS that kind's native editor (so approving a
// staged to-do looks/behaves exactly like adding one), commits through the same
// native endpoint, then drops the item from the queue and offers an Undo toast.
// Kinds without a registered editor fall back to the generic field modal.
//
//   window._approvalEditors[kind] = fn(change)   // register a per-kind editor
//   window.ApprovalKit = { ...shared helpers... } // used by every editor
//
// This split lets each cricket's approval editor live in its own self-registering
// file (static/js/approvals/<kind>.js) — no shared-file edits, easy to parallelize.

let _change = null;       // the change currently shown
let _changeBusy = false;  // guard against double-taps mid-request

// ── Registry: kind -> editor fn(change) ───────────────────────────────────────
window._approvalEditors = window._approvalEditors || {};

// ── Shared helpers every per-kind approval editor uses ────────────────────────
const ApprovalKit = {
    // Open the native editor shell (same modal the add/edit editors use).
    show(title, html) { showEditorModal(title, html); },
    // Close the editor and let polling resume.
    close() { if (typeof hideEditorModal === 'function') hideEditorModal(); _change = null; _changeBusy = false; },
    // Drop a staged item from the queue (after a successful native commit, or a Deny).
    async removeFromQueue(id) {
        await fetch('/api/pending/deny', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
    },
    // Refresh the dashboard so a just-committed change shows immediately.
    refresh() { if (typeof loadDashboard === 'function') loadDashboard(); },
    // Floating "<message> · Undo" toast for ~5s, reusing the .tt-toast style.
    toast(message, undoFn) { _showUndoToast(message, undoFn); },
    esc: (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s)),
    // Record a decision to the ledger (data/decisions.jsonl). Best-effort: the
    // learning signal is the diff between what a cricket `proposed` and what the
    // user kept as `final`, so pass both on approve. Never blocks a decision.
    async logDecision({ action, kind, proposed, final }) {
        const edited = action === 'approve' && !!final && _payloadDiffers(proposed, final);
        try {
            await fetch('/api/decisions/log', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, kind, proposed: proposed || null, final: final || null, edited }),
            });
        } catch (e) { /* logging never blocks a decision */ }
    },
};
window.ApprovalKit = ApprovalKit;

// True if `final` changed any field the cricket proposed (or added/dropped one).
function _payloadDiffers(proposed, final) {
    const a = proposed || {}, b = final || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        const av = a[k] == null ? '' : String(a[k]);
        const bv = b[k] == null ? '' : String(b[k]);
        if (av !== bv) return true;
    }
    return false;
}

async function checkPendingChanges() {
    const modal = document.getElementById('change-modal');
    // Don't interrupt: our generic modal open, a busy request, or ANY native
    // editor (panel-modal) already open — including a per-kind approval editor.
    if (_changeBusy) return;
    if (modal && modal.classList.contains('open')) return;
    const panel = document.getElementById('panel-modal');
    if (panel && panel.classList.contains('open')) return;
    try {
        const res = await fetch('/api/pending');
        const data = await res.json();
        const list = (data && data.pending) || [];
        if (list.length) showChangeModal(list[0]); // one at a time, FIFO
    } catch (e) { /* poll hiccup — try again next tick */ }
}

// Route to the kind's registered editor if it has one; else the generic modal.
function showChangeModal(change) {
    _change = change;
    const editor = window._approvalEditors[change.kind];
    if (typeof editor === 'function') { editor(change); return; }
    _openGenericModal(change);
}

// ── Undo toast (reuses .tt-toast, same look as the Removed·Undo toast) ─────────
function _showUndoToast(message, undoFn) {
    let t = document.getElementById('ap-undo-toast');
    if (!t) { t = document.createElement('div'); t.id = 'ap-undo-toast'; t.className = 'tt-toast'; document.body.appendChild(t); }
    t.innerHTML = '';
    const span = document.createElement('span'); span.textContent = message;
    const btn = document.createElement('button'); btn.textContent = 'Undo';
    t.appendChild(span); t.appendChild(btn);
    void t.offsetWidth;                     // restart the slide-in transition
    t.classList.add('show');
    const hide = setTimeout(() => t.classList.remove('show'), 5000);
    btn.onclick = async () => {
        clearTimeout(hide);
        t.classList.remove('show');
        try { await undoFn(); } catch (e) { /* best-effort undo */ }
        if (typeof loadDashboard === 'function') loadDashboard();
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// GENERIC fallback modal — for kinds without a registered native editor. Renders
// each payload field as an input (bucket -> dropdown) into #change-modal.
// ══════════════════════════════════════════════════════════════════════════════
const _BUCKETS = ['now', 'up_next', 'later', 'someday'];
// /api/todos/add resolves the list by its LABEL (find_section_key), not the bucket key.
const _BUCKET_LABELS = { now: 'Now', up_next: 'Up Next', later: 'Later', someday: 'Someday' };

function _label(key) { return key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()); }

function _fieldRow(key, val) {
    const field = document.createElement('div');
    field.className = 'tm-field';
    const label = document.createElement('label');
    label.className = 'todo-modal-label';
    label.textContent = _label(key);
    field.appendChild(label);
    let input;
    if (key === 'bucket') {
        input = document.createElement('select');
        _BUCKETS.forEach(b => {
            const o = document.createElement('option');
            o.value = b; o.textContent = b;
            if (b === val) o.selected = true;
            input.appendChild(o);
        });
    } else {
        input = document.createElement('input');
        input.type = (typeof val === 'number') ? 'number' : 'text';
        input.value = (val === null || val === undefined) ? '' : val;
        input.style.width = '100%';
    }
    input.dataset.key = key;
    input.dataset.numeric = (typeof val === 'number') ? '1' : '';
    field.appendChild(input);
    return field;
}

function _openGenericModal(change) {
    document.getElementById('change-modal-summary').textContent = change.summary || '';
    const box = document.getElementById('change-modal-fields');
    box.innerHTML = '';
    const payload = change.payload || {};
    Object.keys(payload).forEach(k => box.appendChild(_fieldRow(k, payload[k])));
    document.getElementById('change-modal').classList.add('open');
}

function closeChangeModal() { document.getElementById('change-modal').classList.remove('open'); _change = null; }

function _collectPayload() {
    const box = document.getElementById('change-modal-fields');
    const payload = {};
    box.querySelectorAll('[data-key]').forEach(el => {
        let v = el.value;
        if (el.dataset.numeric === '1' && v !== '') v = Number(v);
        payload[el.dataset.key] = v;
    });
    return payload;
}

async function _decide(action) {
    if (!_change || _changeBusy) return;
    _changeBusy = true;
    const body = { id: _change.id };
    const final = (action === 'approve') ? _collectPayload() : null;
    if (action === 'approve') body.payload = final;
    ApprovalKit.logDecision({ action, kind: _change.kind, proposed: _change.payload, final });
    try {
        await fetch('/api/pending/' + action, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } finally {
        _changeBusy = false;
        closeChangeModal();
        if (action === 'approve' && typeof loadDashboard === 'function') loadDashboard();
    }
}
function approveChange() { _decide('approve'); }
function denyChange() { _decide('deny'); }

// ══════════════════════════════════════════════════════════════════════════════
// TO-DO approval editor — the REFERENCE per-kind editor. A faithful copy of the
// native add-to-do modal (reuses todoThemeFieldHTML / tmMoreHTML / todoAttrFieldsHTML
// + the same field selectors), committing through the native /api/todos/add so the
// full field set persists. This is the template the other crickets mirror.
// ══════════════════════════════════════════════════════════════════════════════
function openTodoApproval(change) {
    const p = change.payload || {};
    const section = p.bucket || 'now';
    const item = { category: p.category || '', status: p.status || '', place_id: p.place_id || '', duration_min: p.duration_min || '' };
    const bucketOpts = _BUCKETS.map(b => `<option value="${_BUCKET_LABELS[b]}"${b === section ? ' selected' : ''}>${_BUCKET_LABELS[b]}</option>`).join('');
    const timeField = `<div class="tm-field"><label class="todo-modal-label">Time <span class="todo-add-opt">(optional)</span></label>
            <input type="time" id="add-todo-time" class="todo-modal-time-input" value="${esc(p.due_time || '')}"></div>`;
    const html = `
        <form class="todo-add-form" onsubmit="event.preventDefault();_approveTodoSubmit('${escJs(change.id)}','${escJs(_BUCKET_LABELS[section] || section)}')">
            <label class="todo-add-label">
                <span class="todo-add-labeltext">To-do</span>
                <textarea id="add-todo-text" class="todo-add-input" rows="1" oninput="autoGrow(this)">${esc(p.text || '')}</textarea>
            </label>
            <label class="todo-add-label">
                <span class="todo-add-labeltext">Due by <span class="todo-add-opt">(optional)</span></span>
                <input type="date" id="add-todo-due" class="todo-add-input" value="${esc(p.due_by || '')}">
            </label>
            <label class="todo-add-label">
                <span class="todo-add-labeltext">Description <span class="todo-add-opt">(optional)</span></span>
                <textarea id="add-todo-desc" class="todo-add-input" rows="2" oninput="autoGrow(this)">${esc(p.notes || '')}</textarea>
            </label>
            <div class="todo-modal-edit">
                ${todoThemeFieldHTML(p.theme || '')}
                ${tmMoreHTML(timeField + todoAttrFieldsHTML(item), false)}
            </div>
            <div class="todo-add-actions" style="position:sticky;bottom:0;background:var(--card-bg);padding:12px 0 2px;border-top:1px solid var(--border);margin-top:8px;z-index:2">
                <button type="button" class="modal-btn cancel" onclick="_denyApproval('${escJs(change.id)}')">Deny</button>
                <button type="submit" class="modal-btn confirm" style="background:var(--green)">Approve</button>
            </div>
        </form>`;
    ApprovalKit.show('Approve to-do?', html);
    // Put the List/bucket picker up in the title, next to "Approve to-do?" — the
    // same idiom as the native add-to-do modal (section select lives in the header).
    const _titleEl = document.getElementById('panel-modal-title');
    if (_titleEl) _titleEl.innerHTML = `Approve to-do? <select id="add-todo-section" class="todo-add-section" data-base="${esc(section)}">${bucketOpts}</select>`;
}

async function _approveTodoSubmit(changeId, section) {
    if (_changeBusy) return;
    const textEl = document.getElementById('add-todo-text');
    const text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    const sectionSel = document.getElementById('add-todo-section');
    if (sectionSel) section = sectionSel.value;
    const form = textEl.closest('form');
    const due_by = document.getElementById('add-todo-due').value;
    const notes = document.getElementById('add-todo-desc').value.trim();
    const due_time = document.getElementById('add-todo-time')?.value || '';
    let place_id = form.querySelector('.todo-modal-place')?.value || '';
    if (place_id === '__new__') place_id = '';
    const category = form.querySelector('.todo-modal-category .tm-chip.active')?.dataset.val || '';
    const theme = form.querySelector('.todo-modal-theme')?.value || '';
    const duration_min = form.querySelector('.todo-modal-duration')?.value || '';
    const statusBtn = form.querySelector('.todo-modal-status .tm-chip.active');
    const status = statusBtn ? statusBtn.dataset.val : '';

    _changeBusy = true;
    try {
        const res = await fetch('/api/todos/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: text, section, due_by, notes, due_time, place_id, category, theme, duration_min, status }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.error || 'Failed to add'); _changeBusy = false; return; }
        // Ledger: what the cricket proposed vs. what she actually kept.
        ApprovalKit.logDecision({
            action: 'approve',
            kind: (_change && _change.kind) || 'life_todo',
            proposed: _change && _change.payload,
            final: { text, bucket: section, theme, category, due_by, notes, due_time, place_id, duration_min, status },
        });
        await ApprovalKit.removeFromQueue(changeId);   // it's committed now — clear the queue entry
        ApprovalKit.close();
        ApprovalKit.refresh();
        const newId = data.id;
        ApprovalKit.toast('Added “' + text + '”', async () => {
            if (newId) await fetch('/api/todos/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: newId }) });
        });
    } catch (e) { _changeBusy = false; }
}

async function _denyApproval(changeId) {
    if (_changeBusy) return;
    _changeBusy = true;
    ApprovalKit.logDecision({ action: 'deny', kind: (_change && _change.kind) || 'life_todo', proposed: _change && _change.payload, final: null });
    await ApprovalKit.removeFromQueue(changeId);
    ApprovalKit.close();
}

window._approvalEditors['life_todo'] = openTodoApproval;
window._approvalEditors['todo'] = openTodoApproval;

setInterval(checkPendingChanges, 3000);
