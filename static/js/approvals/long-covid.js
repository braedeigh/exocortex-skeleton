// approvals/long-covid.js — per-kind approval editor for long-COVID symptom staging.
// Self-registering into window._approvalEditors['symptoms'].
// No framework — vanilla JS, mirrors contacts.js / pending.js style exactly.
//
// Payload contract (staged by the long-covid cricket, consumed here):
//   { date, ...only the symptom fields that had signal }
//   date             — YYYY-MM-DD (the target date the cricket worked on)
//   nose_congestion  — 0–3 integer
//   brain_fog        — 0–3 integer
//   abdominal_pain   — 0–3 integer
//   hand_pain        — 0–3 integer
//   headache         — 0–3 integer
//   energy           — 0–3 integer (0 Crashed, 3 Great)
//   histamine_flare  — "yes" | "no"
//   flare_trigger    — string (free text, only present if histamine_flare is "yes")
//
// Undo:
//   If a row already existed for the date: re-POSTs the old values (real reversal).
//   If no prior row existed: reopens this editor (best-effort) — there is no
//   /api/symptoms DELETE endpoint, so a newly created row cannot be erased cleanly.

window._approvalEditors = window._approvalEditors || {};

let _lcBusy = false;
let _lcCurrentChange = null;  // held for best-effort undo reopen

const _LC_SYM_FIELDS = [
    ['nose_congestion', 'Nose Congestion'],
    ['brain_fog',       'Brain Fog'],
    ['abdominal_pain',  'Abdominal Pain'],
    ['hand_pain',       'Hand Pain'],
    ['headache',        'Headache'],
    ['energy',          'Energy'],
];

function openSymptomApproval(change) {
    _lcCurrentChange = change;
    const p = change.payload || {};
    const date = p.date || (typeof todayStr === 'function' ? todayStr() : new Date().toISOString().slice(0, 10));
    const flareYes = p.histamine_flare === 'yes';
    const cid = escJs(change.id);

    function btnGroup(col) {
        const extra = col === 'energy' ? ' energy' : '';
        const pre = (p[col] !== undefined && p[col] !== null) ? Number(p[col]) : -1;
        return [0, 1, 2, 3].map(v =>
            '<button type="button"' +
            ' class="sym-btn' + extra + (v === pre ? ' selected' : '') + '"' +
            ' data-val="' + v + '"' +
            ' onclick="this.parentElement.querySelectorAll(\'.sym-btn\').forEach(b=>b.classList.remove(\'selected\'));this.classList.add(\'selected\')">' +
            v + '</button>'
        ).join('');
    }

    const html = `
        <form class="todo-add-form" onsubmit="event.preventDefault();_lcApproveSubmit('${cid}')">
            <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:600;color:var(--text-secondary)">Date</label>
                <input type="date" id="lc-sym-date" class="date-picker" value="${esc(date)}">
            </div>
            <div class="sym-key" style="margin-bottom:6px">
                <span><span class="sk" style="background:var(--green)"></span> 0 None</span>
                <span><span class="sk" style="background:var(--yellow)"></span> 1 Mild</span>
                <span><span class="sk" style="background:var(--orange)"></span> 2 Moderate</span>
                <span><span class="sk" style="background:var(--red)"></span> 3 Bad</span>
            </div>
            <div class="sym-key" style="margin-bottom:14px">
                <span style="font-style:italic;color:var(--text-muted)">Energy: 0 Crashed &middot; 1 Low &middot; 2 Okay &middot; 3 Great</span>
            </div>
            <div class="symptom-grid">
                ${_LC_SYM_FIELDS.map(function(f) {
                    const col = f[0], lbl = f[1];
                    return '<div class="symptom-field"><label>' + lbl + '</label>' +
                           '<div class="sym-btn-group" id="lc-sym-' + col + '">' + btnGroup(col) + '</div></div>';
                }).join('')}
            </div>
            <div class="symptom-field" style="margin:14px 0 6px">
                <label>Histamine Flare</label>
                <div class="sym-btn-group" id="lc-flare-group" style="margin-top:6px">
                    <button type="button" class="sym-btn${flareYes ? ' selected' : ''}" data-val="yes"
                        onclick="this.parentElement.querySelectorAll('.sym-btn').forEach(b=>b.classList.remove('selected'));this.classList.add('selected')">Yes</button>
                    <button type="button" class="sym-btn${!flareYes ? ' selected' : ''}" data-val="no"
                        onclick="this.parentElement.querySelectorAll('.sym-btn').forEach(b=>b.classList.remove('selected'));this.classList.add('selected')">No</button>
                </div>
            </div>
            <div class="tm-field" style="margin-bottom:16px">
                <label class="todo-modal-label">Flare trigger <span style="font-weight:normal;color:var(--text-muted)">(if any)</span></label>
                <input type="text" id="lc-flare-trigger" placeholder="e.g. onions, stress, heat"
                    value="${esc(p.flare_trigger || '')}"
                    style="width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text)">
            </div>
            <div class="todo-add-actions">
                <button type="button" class="modal-btn cancel" onclick="_denyApproval('${cid}')">Deny</button>
                <button type="submit" class="modal-btn confirm" style="background:var(--green)">Approve</button>
            </div>
        </form>`;

    ApprovalKit.show('Log symptoms? ✍️', html);
}

async function _lcApproveSubmit(changeId) {
    if (_lcBusy) return;
    _lcBusy = true;

    const dateEl = document.getElementById('lc-sym-date');
    const dateStr = dateEl ? dateEl.value.trim() : '';
    if (!dateStr) { _lcBusy = false; return; }

    // Snapshot the existing row before overwriting — used for real undo if possible.
    const prevDay = (window.D && Array.isArray(window.D.health_data))
        ? (window.D.health_data.find(function(d) { return d.date === dateStr; }) || null)
        : null;

    // Collect symptom values — only include fields where a button is selected.
    const symptoms = {};
    _LC_SYM_FIELDS.forEach(function(f) {
        const col = f[0];
        const group = document.getElementById('lc-sym-' + col);
        const sel = group && group.querySelector('.sym-btn.selected');
        if (sel) symptoms[col] = Number(sel.dataset.val);
    });

    const flareGroup = document.getElementById('lc-flare-group');
    const flareSel = flareGroup && flareGroup.querySelector('.sym-btn.selected');
    symptoms['histamine_flare'] = flareSel ? flareSel.dataset.val : 'no';

    const triggerEl = document.getElementById('lc-flare-trigger');
    const trigger = triggerEl ? triggerEl.value.trim() : '';
    if (trigger) symptoms['flare_trigger'] = trigger;

    try {
        const res = await fetch('/api/symptoms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: dateStr, symptoms: symptoms }),
        });
        const data = await res.json().catch(function() { return {}; });
        if (!res.ok) {
            alert(data.error || 'Failed to log symptoms');
            _lcBusy = false;
            return;
        }

        ApprovalKit.logDecision({ action: 'approve', kind: 'symptoms', proposed: _lcCurrentChange && _lcCurrentChange.payload, final: Object.assign({ date: dateStr }, symptoms) });
        await ApprovalKit.removeFromQueue(changeId);
        ApprovalKit.close();
        _lcBusy = false;
        ApprovalKit.refresh();

        // Build undo function.
        // Real reversal: re-POST the prior row's values (if row existed).
        // Best-effort: reopen this editor (if row is newly created — no delete endpoint).
        let undoFn;
        if (prevDay) {
            const oldSyms = {};
            const cols = _LC_SYM_FIELDS.map(function(f) { return f[0]; })
                .concat(['histamine_flare', 'flare_trigger', 'nose_spray']);
            cols.forEach(function(col) {
                const v = prevDay[col];
                if (v !== undefined && v !== null && v !== '') oldSyms[col] = v;
            });
            undoFn = async function() {
                await fetch('/api/symptoms', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date: dateStr, symptoms: oldSyms }),
                });
            };
        } else {
            // No prior row — can't cleanly delete the new row. Reopen editor instead.
            const capturedChange = _lcCurrentChange;
            undoFn = function() { if (capturedChange) openSymptomApproval(capturedChange); };
        }

        ApprovalKit.toast('Logged symptoms for ' + dateStr, undoFn);
    } catch (e) {
        _lcBusy = false;
    }
}

window._approvalEditors['symptoms'] = openSymptomApproval;
