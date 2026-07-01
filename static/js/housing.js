// housing.js — Apartment / housing-search tracker: notes box + place cards
// with a status ladder. Data comes from D.housing = {entries, notes}.

const HOUSING_STATUSES = [
    ['found', 'found'],
    ['contacted', 'contacted'],
    ['touring', 'touring'],
    ['toured', 'toured'],
    ['applied', 'applied'],
    ['passed', 'passed'],
    ['got_it', 'GOT IT'],
];

// status -> accent color (uses theme vars defined in CSS)
const HOUSING_STATUS_COLOR = {
    found: 'var(--text-muted)',
    contacted: 'var(--text)',
    touring: 'var(--ongoing)',
    toured: 'var(--ongoing)',
    applied: 'var(--orange)',
    passed: 'var(--red)',
    got_it: 'var(--green)',
};

function housingEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _housingData() {
    return (D && D.housing) || { entries: [], notes: '' };
}

// --- Notes box (criteria + move-timing plan) ---
function renderHousingNotes() {
    const el = document.getElementById('housing-notes-area');
    if (!el) return;
    const text = _housingData().notes || '';
    el.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:18px;background:var(--bg-card)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-weight:600">Criteria & plan</div>
            <div id="housing-notes-status" style="font-size:12px;color:var(--text-muted)"></div>
        </div>
        <textarea id="housing-notes-text" rows="7" placeholder="What you're looking for, move timing, dealbreakers…" oninput="housingNotesDirty()" onblur="housingNotesSave()" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);resize:vertical;font-family:inherit;font-size:14px;line-height:1.5;box-sizing:border-box">${housingEscape(text)}</textarea>
    </div>`;
}

function housingNotesDirty() {
    const s = document.getElementById('housing-notes-status');
    if (s) s.textContent = 'unsaved…';
}

async function housingNotesSave() {
    const ta = document.getElementById('housing-notes-text');
    const s = document.getElementById('housing-notes-status');
    if (!ta) return;
    if (s) s.textContent = 'saving…';
    const res = await fetch('/api/housing/notes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ta.value }),
    });
    if (s) s.textContent = res.ok ? 'saved' : 'save failed';
}

// --- Add-a-place form (collapsed until tapped) ---
function renderHousingAddForm() {
    const el = document.getElementById('housing-add-form-area');
    if (!el) return;
    el.innerHTML = `
    <details class="map-section" style="border:1px solid var(--border);border-radius:8px;margin-bottom:18px;background:var(--bg-card)">
        <summary style="cursor:pointer;list-style:none;padding:12px 14px;font-weight:600;display:flex;align-items:center;gap:8px;min-height:40px;box-sizing:border-box">
            <span style="font-size:18px;line-height:1">＋</span> Add a place
        </summary>
        <div style="padding:0 14px 14px 14px">
            ${_housingFields('add')}
            <button onclick="housingSubmitAdd()" style="margin-top:10px;padding:10px 18px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;min-height:40px">Add place</button>
        </div>
    </details>`;
}

// Shared field block for both the add form and inline edit. `pfx` namespaces the ids.
function _housingFields(pfx, e) {
    e = e || {};
    const inp = 'padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box;width:100%';
    const lab = 'display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)';
    let statusOpts = '';
    for (const [val, label] of HOUSING_STATUSES) {
        const sel = (e.status || 'found') === val ? ' selected' : '';
        statusOpts += `<option value="${val}"${sel}>${label}</option>`;
    }
    return `
    <label style="${lab};margin-bottom:10px">Place name
        <input type="text" id="hf-${pfx}-name" value="${housingEscape(e.name)}" placeholder="e.g. Peterson / Shoal Creek" style="${inp}">
    </label>
    <label style="${lab};margin-bottom:10px">Link (optional)
        <input type="url" id="hf-${pfx}-link" value="${housingEscape(e.link)}" placeholder="https://…" style="${inp}">
    </label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <label style="${lab}">Rent
            <input type="text" id="hf-${pfx}-rent" value="${housingEscape(e.rent)}" placeholder="$1000" style="${inp}">
        </label>
        <label style="${lab}">Size
            <input type="text" id="hf-${pfx}-size" value="${housingEscape(e.size)}" placeholder="1bd, 500sqft" style="${inp}">
        </label>
        <label style="${lab}">Area
            <input type="text" id="hf-${pfx}-area" value="${housingEscape(e.area)}" placeholder="Rosedale" style="${inp}">
        </label>
        <label style="${lab}">Available
            <input type="text" id="hf-${pfx}-avail" value="${housingEscape(e.avail)}" placeholder="Jun 30 / late July" style="${inp}">
        </label>
    </div>
    <label style="${lab};margin-bottom:10px">Status
        <select id="hf-${pfx}-status" style="${inp}">${statusOpts}</select>
    </label>
    <label style="${lab}">Notes
        <textarea id="hf-${pfx}-notes" rows="3" placeholder="Gut read, flags, fit…" style="${inp};resize:vertical;font-family:inherit">${housingEscape(e.notes)}</textarea>
    </label>`;
}

function _housingReadFields(pfx) {
    const v = (f) => {
        const el = document.getElementById(`hf-${pfx}-${f}`);
        return el ? el.value : '';
    };
    return {
        name: v('name'), link: v('link'), rent: v('rent'), size: v('size'),
        area: v('area'), avail: v('avail'), status: v('status'), notes: v('notes'),
    };
}

async function housingSubmitAdd() {
    const payload = _housingReadFields('add');
    const res = await fetch('/api/housing/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) loadDashboard();
}

// --- Place list (cards) ---
// Display order: active search states first, GOT IT pinned up top, passed sinks.
const _HOUSING_RANK = { got_it: 0, applied: 1, toured: 2, touring: 3, contacted: 4, found: 5, passed: 6 };

function renderHousingList() {
    const el = document.getElementById('housing-list-area');
    if (!el) return;
    const entries = (_housingData().entries || []).slice().sort((a, b) => {
        const ra = _HOUSING_RANK[a.status] ?? 9;
        const rb = _HOUSING_RANK[b.status] ?? 9;
        return ra - rb;
    });

    if (!entries.length) {
        el.innerHTML = `<div style="color:var(--text-muted);font-style:italic;padding:14px">No places yet — tap "Add a place" above.</div>`;
        return;
    }

    el.innerHTML = entries.map(e => _housingCard(e)).join('');
}

function _housingCard(e) {
    const color = HOUSING_STATUS_COLOR[e.status] || 'var(--text-muted)';
    let statusOpts = '';
    for (const [val, label] of HOUSING_STATUSES) {
        statusOpts += `<option value="${val}"${e.status === val ? ' selected' : ''}>${label}</option>`;
    }
    const metaBits = [e.rent, e.size, e.area].filter(Boolean).map(housingEscape).join(' · ');
    const link = e.link
        ? `<a href="${housingEscape(e.link)}" target="_blank" rel="noopener" title="Open listing" style="text-decoration:none;font-size:18px;line-height:1">🔗</a>`
        : '';
    const avail = e.avail ? `<span style="font-size:13px;color:var(--text-muted)">avail ${housingEscape(e.avail)}</span>` : '';

    return `
    <div class="card" id="housing-card-${e.id}" data-id="${e.id}" style="border:1px solid var(--border);border-left:4px solid ${color};border-radius:8px;padding:14px;margin-bottom:12px;background:var(--bg-card)">
      <div class="housing-view">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <div style="font-weight:700;font-size:16px;flex:1">${housingEscape(e.name)}</div>
            ${link}
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">
            <select onchange="housingSetStatus('${e.id}', this.value)" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:${color};font-weight:600;font-size:13px;min-height:36px">${statusOpts}</select>
            ${avail}
        </div>
        ${metaBits ? `<div style="font-size:14px;margin-bottom:6px">${metaBits}</div>` : ''}
        ${e.notes ? `<div style="font-size:13px;color:var(--text-muted);line-height:1.5;white-space:pre-wrap">${housingEscape(e.notes)}</div>` : ''}
        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px">
            <button onclick="housingEdit('${e.id}')" title="Edit" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);cursor:pointer;font-size:15px;min-width:40px;min-height:36px">✎</button>
            <button onclick="housingRemove('${e.id}')" title="Delete" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--red);cursor:pointer;font-size:15px;min-width:40px;min-height:36px">🗑</button>
        </div>
      </div>
      <div class="housing-edit" style="display:none">
        ${_housingFields('edit-' + e.id, e)}
        <div style="display:flex;gap:8px;margin-top:10px">
            <button onclick="housingSaveEdit('${e.id}')" style="padding:9px 16px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;min-height:40px">Save</button>
            <button onclick="housingCancelEdit('${e.id}')" style="padding:9px 16px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer;min-height:40px">Cancel</button>
        </div>
      </div>
    </div>`;
}

async function housingSetStatus(id, status) {
    const res = await fetch('/api/housing/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
    });
    if (res.ok) loadDashboard();
}

function _housingToggleEdit(id, editing) {
    const card = document.getElementById('housing-card-' + id);
    if (!card) return;
    card.querySelector('.housing-view').style.display = editing ? 'none' : '';
    card.querySelector('.housing-edit').style.display = editing ? '' : 'none';
}

function housingEdit(id) { _housingToggleEdit(id, true); }
function housingCancelEdit(id) { _housingToggleEdit(id, false); }

async function housingSaveEdit(id) {
    const payload = _housingReadFields('edit-' + id);
    payload.id = id;
    const res = await fetch('/api/housing/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) loadDashboard();
}

function housingRemove(id) {
    const e = (_housingData().entries || []).find(x => x.id === id);
    confirmDelete(id, 'housing-place', e ? e.name : 'this place');
}
