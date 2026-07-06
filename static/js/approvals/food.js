// approvals/food.js — per-kind approval editor for kind:"food"
//
// Self-registers into window._approvalEditors so pending.js routes to it
// automatically. Mirrors the native food log: edits a semicolon-separated
// food_notes string for a date, commits through /api/food/set, and offers
// a real undo (re-POSTs the previous value captured from D.health_data
// before the overwrite).
//
// Payload contract (what the food cricket stages AND this editor reads):
//   { date: "YYYY-MM-DD", food_notes: "item1; item2; item3" }

(function () {
    window._approvalEditors = window._approvalEditors || {};

    let _busy = false;
    let _foodChange = null;  // remembered for the ledger (proposed vs. kept)

    function openFoodApproval(change) {
        _busy = false;
        _foodChange = change;
        const p = change.payload || {};
        const date = p.date || '';
        const foodNotes = p.food_notes || '';
        const id = change.id;

        const html = `
<form class="todo-add-form" onsubmit="event.preventDefault();_approveFoodSubmit('${escJs(id)}')">
    <div class="tm-field">
        <label class="todo-modal-label">Date</label>
        <input type="date" id="food-appr-date" class="todo-add-input"
               value="${esc(date)}" style="width:100%;min-height:40px">
    </div>
    <div class="tm-field">
        <label class="todo-modal-label">Food eaten
            <span style="font-weight:400;font-size:13px;opacity:.65">(separate items with&nbsp;;)</span>
        </label>
        <textarea id="food-appr-notes" class="todo-add-input" rows="4"
                  style="width:100%;resize:vertical;min-height:80px;font-size:14px"
                  oninput="if(typeof autoGrow==='function')autoGrow(this)">${esc(foodNotes)}</textarea>
    </div>
    <div class="todo-add-actions">
        <button type="button" class="modal-btn cancel"
                onclick="_denyFoodApproval('${escJs(id)}')">Deny</button>
        <button type="submit" class="modal-btn confirm"
                style="background:var(--green)">Approve</button>
    </div>
</form>`;

        ApprovalKit.show('Log food? ✍️', html);
    }

    async function _approveFoodSubmit(changeId) {
        if (_busy) return;
        const dateEl  = document.getElementById('food-appr-date');
        const notesEl = document.getElementById('food-appr-notes');
        if (!dateEl || !notesEl) return;
        const date       = dateEl.value.trim();
        const food_notes = notesEl.value.trim();
        if (!date) { dateEl.focus(); return; }

        // Capture previous food_notes from D.health_data for real undo.
        // D is already loaded in the dashboard at this point.
        const prevRow = window.D && Array.isArray(window.D.health_data)
            ? window.D.health_data.find(function (d) { return d.date === date; })
            : null;
        const prev = (prevRow && prevRow.food_notes) ? prevRow.food_notes : '';

        _busy = true;
        try {
            const res = await fetch('/api/food/set', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ date: date, food_notes: food_notes }),
            });
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) {
                alert(data.error || 'Failed to log food');
                _busy = false;
                return;
            }
            ApprovalKit.logDecision({ action: 'approve', kind: 'food', proposed: _foodChange && _foodChange.payload, final: { date: date, food_notes: food_notes } });
            await ApprovalKit.removeFromQueue(changeId);
            ApprovalKit.close();
            ApprovalKit.refresh();
            ApprovalKit.toast('Logged food for ' + date, async function () {
                await fetch('/api/food/set', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ date: date, food_notes: prev }),
                });
            });
        } catch (e) {
            _busy = false;
        }
    }

    async function _denyFoodApproval(changeId) {
        if (_busy) return;
        _busy = true;
        ApprovalKit.logDecision({ action: 'deny', kind: 'food', proposed: _foodChange && _foodChange.payload, final: null });
        await ApprovalKit.removeFromQueue(changeId);
        ApprovalKit.close();
    }

    // Expose for inline onclick handlers
    window._approveFoodSubmit  = _approveFoodSubmit;
    window._denyFoodApproval   = _denyFoodApproval;

    window._approvalEditors['food'] = openFoodApproval;
}());
