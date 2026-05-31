// car.js — Car maintenance log + due-soon dashboard widget

const CAR_TYPE_LABELS = {
    oil_change: 'Oil change',
    brake_pads: 'Brake pads',
    registration: 'Registration',
};

function carTypeLabel(t) {
    if (CAR_TYPE_LABELS[t]) return CAR_TYPE_LABELS[t];
    if (!t) return '—';
    return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function carDaysUntil(dateStr) {
    if (!dateStr) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(dateStr + 'T00:00:00'); d.setHours(0, 0, 0, 0);
    return Math.floor((d - today) / 86400000);
}

function carEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Car Maintenance tab: notepad ---
function renderCarNotes() {
    const el = document.getElementById('car-notes-area');
    if (!el) return;
    const text = (D.car_notes && D.car_notes.text) || '';
    el.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:18px;background:var(--bg-card)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-weight:600">Notes</div>
            <div id="car-notes-status" style="font-size:12px;color:var(--text-muted)"></div>
        </div>
        <textarea id="car-notes-text" rows="5" placeholder="Save thoughts about the car here…" oninput="carNotesDirty()" onblur="carNotesSave()" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);resize:vertical;font-family:inherit;font-size:14px;box-sizing:border-box">${carEscape(text)}</textarea>
    </div>`;
}

function carNotesDirty() {
    const s = document.getElementById('car-notes-status');
    if (s) s.textContent = 'unsaved…';
}

async function carNotesSave() {
    const ta = document.getElementById('car-notes-text');
    const s = document.getElementById('car-notes-status');
    if (!ta) return;
    if (s) s.textContent = 'saving…';
    const res = await fetch('/api/car/notes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ta.value }),
    });
    if (s) s.textContent = res.ok ? 'saved' : 'save failed';
}

// --- Car Maintenance tab: add-entry form ---
function renderCarAddForm() {
    const el = document.getElementById('car-add-form-area');
    if (!el) return;
    const today = (typeof _serverDate !== 'undefined' && _serverDate) || new Date().toISOString().slice(0, 10);
    el.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:18px;background:var(--bg-card)">
        <div style="font-weight:600;margin-bottom:10px">Log maintenance</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">
                Type
                <select id="car-form-type" onchange="carToggleCustomType()" style="padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
                    <option value="oil_change">Oil change</option>
                    <option value="brake_pads">Brake pads</option>
                    <option value="registration">Registration</option>
                    <option value="__custom__">Other…</option>
                </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">
                Date
                <input type="date" id="car-form-date" value="${today}" style="padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
            </label>
        </div>
        <div id="car-form-custom-wrap" style="display:none;margin-bottom:10px">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">
                Custom type
                <input type="text" id="car-form-custom" placeholder="e.g. tire_rotation" style="padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
            </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">
                Mileage (optional)
                <input type="number" id="car-form-mileage" placeholder="e.g. 87500" style="padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">
                Next due (optional)
                <input type="date" id="car-form-next-due" style="padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
            </label>
        </div>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
            Notes (optional)
            <textarea id="car-form-notes" rows="2" style="padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);resize:vertical"></textarea>
        </label>
        <button onclick="carSubmitAdd()" style="padding:8px 16px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600">Add entry</button>
    </div>`;
}

function carToggleCustomType() {
    const sel = document.getElementById('car-form-type');
    const wrap = document.getElementById('car-form-custom-wrap');
    if (!sel || !wrap) return;
    wrap.style.display = sel.value === '__custom__' ? '' : 'none';
}

async function carSubmitAdd() {
    const typeSel = document.getElementById('car-form-type').value;
    const type = typeSel === '__custom__'
        ? (document.getElementById('car-form-custom').value.trim() || 'other')
        : typeSel;
    const payload = {
        type,
        date: document.getElementById('car-form-date').value || '',
        mileage: document.getElementById('car-form-mileage').value || '',
        notes: document.getElementById('car-form-notes').value || '',
        next_due: document.getElementById('car-form-next-due').value || '',
    };
    const res = await fetch('/api/car/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) loadDashboard();
}

// --- Car Maintenance tab: log table ---
function renderCarLog() {
    const el = document.getElementById('car-log-area');
    if (!el) return;
    const entries = (D.car_maintenance && D.car_maintenance.entries) || [];
    const sorted = entries.slice().sort((a, b) => {
        const av = a.next_due || '9999-12-31';
        const bv = b.next_due || '9999-12-31';
        return av.localeCompare(bv);
    });

    if (!sorted.length) {
        el.innerHTML = `<div style="color:var(--text-muted);font-style:italic;padding:14px">No maintenance logged yet.</div>`;
        return;
    }

    let rows = '';
    for (const e of sorted) {
        const days = carDaysUntil(e.next_due);
        let dueLabel = e.next_due || '—';
        let dueColor = '';
        if (days !== null) {
            if (days < 0) dueColor = 'color:var(--red);font-weight:600';
            else if (days <= 30) dueColor = 'color:var(--orange);font-weight:600';
        }
        rows += `<tr>
            <td style="padding:8px;border-bottom:1px solid var(--border)">${carEscape(carTypeLabel(e.type))}</td>
            <td style="padding:8px;border-bottom:1px solid var(--border)">${carEscape(e.date || '—')}</td>
            <td style="padding:8px;border-bottom:1px solid var(--border)">${e.mileage != null && e.mileage !== '' ? carEscape(e.mileage) : '—'}</td>
            <td style="padding:8px;border-bottom:1px solid var(--border);${dueColor}">${carEscape(e.next_due || '—')}</td>
            <td style="padding:8px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:13px">${carEscape(e.notes || '')}</td>
            <td style="padding:8px;border-bottom:1px solid var(--border);text-align:right">
                <button onclick="carRemoveEntry('${e.id}')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px" title="Remove">&times;</button>
            </td>
        </tr>`;
    }

    el.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead>
                <tr style="background:var(--bg-card);text-align:left">
                    <th style="padding:8px;font-size:12px;color:var(--text-muted);text-transform:uppercase">Type</th>
                    <th style="padding:8px;font-size:12px;color:var(--text-muted);text-transform:uppercase">Date</th>
                    <th style="padding:8px;font-size:12px;color:var(--text-muted);text-transform:uppercase">Mileage</th>
                    <th style="padding:8px;font-size:12px;color:var(--text-muted);text-transform:uppercase">Next due</th>
                    <th style="padding:8px;font-size:12px;color:var(--text-muted);text-transform:uppercase">Notes</th>
                    <th style="padding:8px"></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

async function carRemoveEntry(id) {
    const res = await fetch('/api/car/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });
    if (res.ok) loadDashboard();
}
