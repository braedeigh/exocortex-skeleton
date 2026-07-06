// approvals/contacts.js — per-kind approval editor for contact log entries.
// Self-registering into window._approvalEditors['contact'].
// No framework — vanilla JS, mirrors the style of pending.js exactly.
//
// Payload contract (staged by the contacts cricket, consumed here):
//   { name, method, date, reason }
//   name   — contact's display name (must match contacts.json)
//   method — one of: call, text, facetime, visit
//   date   — YYYY-MM-DD of the interaction
//   reason — brief quote from the journal explaining why this was staged

window._approvalEditors = window._approvalEditors || {};

const _CONTACT_METHODS = ['Call', 'Text', 'FaceTime', 'Visit'];

let _contactBusy = false;
let _contactChange = null;  // remembered for the ledger (proposed vs. kept)

function openContactApproval(change) {
    _contactChange = change;
    const p = change.payload || {};
    const name = p.name || '';
    const payloadMethod = (p.method || 'call').toLowerCase();
    const date = p.date || new Date().toISOString().slice(0, 10);
    const reason = p.reason || '';

    const methodOpts = _CONTACT_METHODS.map(m => {
        const val = m.toLowerCase();
        const sel = val === payloadMethod ? ' selected' : '';
        return `<option value="${val}"${sel}>${m}</option>`;
    }).join('');

    const reasonHtml = reason
        ? `<div class="tm-field">
               <label class="todo-modal-label">From journal</label>
               <div style="font-size:14px;color:var(--text-muted);padding:4px 0;line-height:1.4">${esc(reason)}</div>
           </div>`
        : '';

    const html = `
        <form class="todo-add-form" onsubmit="event.preventDefault();_approveContactSubmit('${escJs(change.id)}')">
            <div class="tm-field">
                <label class="todo-modal-label">Name</label>
                <input type="text" id="ca-name" class="todo-add-input" value="${esc(name)}" style="width:100%">
            </div>
            <div class="todo-modal-edit">
                <div class="tm-field">
                    <label class="todo-modal-label">Method</label>
                    <select id="ca-method" class="todo-add-section">${methodOpts}</select>
                </div>
                <div class="tm-field">
                    <label class="todo-modal-label">Date</label>
                    <input type="date" id="ca-date" class="todo-modal-time-input" value="${esc(date)}">
                </div>
            </div>
            ${reasonHtml}
            <div class="todo-add-actions">
                <button type="button" class="modal-btn cancel" onclick="_denyApproval('${escJs(change.id)}')">Deny</button>
                <button type="submit" class="modal-btn confirm" style="background:var(--green)">Approve</button>
            </div>
        </form>`;

    ApprovalKit.show('Log contact? ✍️', html);
}

async function _approveContactSubmit(changeId) {
    if (_contactBusy) return;
    const nameEl = document.getElementById('ca-name');
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    const method = document.getElementById('ca-method').value;
    const date = document.getElementById('ca-date').value;

    _contactBusy = true;
    try {
        const res = await fetch('/api/contacts/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, method, date }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.error || 'Failed to log contact');
            _contactBusy = false;
            return;
        }
        ApprovalKit.logDecision({ action: 'approve', kind: 'contact', proposed: _contactChange && _contactChange.payload, final: { name, method, date } });
        await ApprovalKit.removeFromQueue(changeId);
        ApprovalKit.close();
        _contactBusy = false;
        ApprovalKit.refresh();
        ApprovalKit.toast('Logged contact with ' + name, async () => {
            await fetch('/api/contacts/history/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, date, method }),
            });
        });
    } catch (e) {
        _contactBusy = false;
    }
}

window._approvalEditors['contact'] = openContactApproval;
