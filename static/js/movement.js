// movement.js — routines of moves, each move linking out to a demo video.
// Like a little workout app: tap a move to open its video. Everything here is
// editable in the UI (add a routine, paste a video link, reorder) — no terminal.

// Which routine (if any) is in edit mode. Edit grows the controls; normal view
// stays clean and big-tappable ("small until edit").
if (!window._moveEdit) window._moveEdit = { routineId: null };
// Whether the "new routine" form is showing
if (!window._moveNewRoutine) window._moveNewRoutine = { open: false };

function _movementRoutines() {
    return (D.movement && D.movement.routines) || [];
}

function renderMovement() {
    const el = document.getElementById('movement-area');
    if (!el) return;

    const routines = _movementRoutines();
    let body;
    if (!routines.length) {
        body = `<div style="color:var(--text-muted);font-style:italic;padding:18px;border:1px dashed var(--border);border-radius:8px;text-align:center;font-size:14px">
            No routines yet. Add one below to start collecting movements and their videos.</div>`;
    } else {
        body = routines.map(r =>
            window._moveEdit.routineId === r.id ? _movementRoutineEditor(r) : _movementRoutineCard(r)
        ).join('');
    }

    el.innerHTML = body + _movementNewRoutine();
}

// --- Normal view: a clean card of big tappable video rows ---
function _movementRoutineCard(r) {
    const moves = r.moves || [];
    const rows = moves.length
        ? moves.map(m => _movementMoveRow(r, m)).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:12px 2px;font-size:14px">No moves yet — tap Edit to add some.</div>`;
    const note = r.note
        ? `<div style="font-size:13px;color:var(--text-muted);margin:2px 0 12px">${esc(r.note)}</div>`
        : '<div style="height:6px"></div>';
    return `<div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:18px;background:var(--bg-card)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">
            <div style="flex:1;min-width:0;font-size:18px;font-weight:700;color:var(--text)">${esc(r.name)}</div>
            <button onclick="_moveEditOpen('${esc(r.id)}')" style="flex:none;height:36px;padding:0 16px;border-radius:18px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;font-weight:600;cursor:pointer">Edit</button>
        </div>
        ${note}
        ${rows}
    </div>`;
}

function _movementMoveRow(r, m) {
    const hasVid = !!(m.url && m.url.trim());
    const note = m.note
        ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(m.note)}</div>`
        : '';
    const label = `<div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:600;color:var(--text)">${esc(m.name)}</div>
            ${note}
        </div>`;
    if (hasVid) {
        // Whole row is a link — big hit area, opens the demo video in a new tab.
        return `<a href="${esc(m.url)}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:12px;text-decoration:none;padding:11px 12px;margin-bottom:8px;border:1px solid var(--border);border-radius:10px;background:var(--bg);min-height:44px;box-sizing:border-box">
            <span style="flex:none;width:30px;height:30px;border-radius:50%;background:rgba(124,92,191,0.18);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:13px">&#9654;</span>
            ${label}
            <span style="flex:none;font-size:12px;color:var(--text-muted)">video &#8599;</span>
        </a>`;
    }
    // No video — a quiet, non-clickable row.
    return `<div style="display:flex;align-items:center;gap:12px;padding:11px 12px;margin-bottom:8px;border:1px dashed var(--border);border-radius:10px;background:var(--bg);min-height:44px;box-sizing:border-box">
        <span style="flex:none;width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:15px">&#9679;</span>
        ${label}
    </div>`;
}

// --- Edit view: rename routine, edit/reorder/remove moves, add a move ---
function _movementRoutineEditor(r) {
    const inp = 'padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box';
    const moves = r.moves || [];
    const rows = moves.map((m, i) => _movementMoveEditRow(r, m, i, moves.length)).join('');
    return `<div style="border:1px solid var(--accent);border-radius:12px;padding:16px;margin-bottom:18px;background:var(--bg-card)">
        <input type="text" value="${esc(r.name)}" onchange="_moveRenameRoutine('${esc(r.id)}', this.value)" placeholder="Routine name" style="${inp};width:100%;font-size:17px;font-weight:700;margin-bottom:8px">
        <input type="text" value="${esc(r.note || '')}" onchange="_moveRoutineNote('${esc(r.id)}', this.value)" placeholder="Optional note (how to approach it)" style="${inp};width:100%;margin-bottom:14px">

        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Moves</div>
        ${rows || '<div style="color:var(--text-muted);font-style:italic;font-size:14px;margin-bottom:10px">None yet — add the first below.</div>'}

        ${_movementAddMove(r, inp)}

        <div style="display:flex;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
            <button onclick="_moveEditClose()" style="height:40px;padding:0 20px;border-radius:8px;border:none;background:var(--ongoing);color:white;font-size:14px;font-weight:700;cursor:pointer">Done</button>
            <button onclick="_moveRemoveRoutine('${esc(r.id)}','${escJs(r.name)}')" style="height:40px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:none;color:#e07a7a;font-size:14px;font-weight:600;cursor:pointer;margin-left:auto">Delete routine</button>
        </div>
    </div>`;
}

function _movementMoveEditRow(r, m, idx, total) {
    const inp = 'padding:8px 10px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box';
    const arrowBtn = 'flex:none;width:34px;height:34px;border-radius:7px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:15px;cursor:pointer';
    const up = idx > 0
        ? `<button onclick="_moveReorder('${esc(r.id)}','${esc(m.id)}',-1)" title="Move up" style="${arrowBtn}">&#9650;</button>`
        : `<span style="width:34px;flex:none"></span>`;
    const down = idx < total - 1
        ? `<button onclick="_moveReorder('${esc(r.id)}','${esc(m.id)}',1)" title="Move down" style="${arrowBtn}">&#9660;</button>`
        : `<span style="width:34px;flex:none"></span>`;
    return `<div style="border:1px solid var(--border);border-radius:9px;padding:10px;margin-bottom:10px;background:var(--bg)">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:7px">
            <div style="display:flex;flex-direction:column;gap:4px">${up}${down}</div>
            <input type="text" value="${esc(m.name)}" onchange="_moveUpdate('${esc(r.id)}','${esc(m.id)}','name', this.value)" placeholder="Move name" style="${inp};flex:1;font-weight:600">
            <button onclick="_moveRemove('${esc(r.id)}','${esc(m.id)}','${escJs(m.name)}')" title="Remove move" style="flex:none;width:40px;height:40px;border:none;background:none;color:#e07a7a;font-size:22px;cursor:pointer">&times;</button>
        </div>
        <input type="text" value="${esc(m.url || '')}" onchange="_moveUpdate('${esc(r.id)}','${esc(m.id)}','url', this.value)" placeholder="Video URL (paste a YouTube link — leave blank if none)" style="${inp};width:100%;margin-bottom:7px">
        <input type="text" value="${esc(m.note || '')}" onchange="_moveUpdate('${esc(r.id)}','${esc(m.id)}','note', this.value)" placeholder="Optional cue (e.g. nose toward armpit)" style="${inp};width:100%">
    </div>`;
}

function _movementAddMove(r, inp) {
    return `<div style="border:1px dashed var(--border);border-radius:9px;padding:10px;margin-top:4px">
        <input type="text" id="move-add-name-${esc(r.id)}" placeholder="New move name" style="${inp};width:100%;margin-bottom:7px">
        <input type="text" id="move-add-url-${esc(r.id)}" placeholder="Video URL (optional)" style="${inp};width:100%;margin-bottom:7px">
        <div style="display:flex;gap:8px">
            <input type="text" id="move-add-note-${esc(r.id)}" placeholder="Cue (optional)" style="${inp};flex:1">
            <button onclick="_moveAdd('${esc(r.id)}')" style="flex:none;height:38px;padding:0 18px;border-radius:8px;border:none;background:var(--accent);color:white;font-size:14px;font-weight:700;cursor:pointer">Add move</button>
        </div>
    </div>`;
}

function _movementNewRoutine() {
    const inp = 'padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box';
    if (!window._moveNewRoutine.open) {
        return `<button onclick="_moveNewRoutineToggle(true)" style="height:40px;padding:0 18px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;font-weight:600;cursor:pointer">+ New routine</button>`;
    }
    return `<div style="border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--bg-card)">
        <input type="text" id="move-new-routine-name" placeholder="Routine name (e.g. Morning mobility)" style="${inp};width:100%;margin-bottom:8px">
        <input type="text" id="move-new-routine-note" placeholder="Optional note" style="${inp};width:100%;margin-bottom:12px">
        <div style="display:flex;gap:8px">
            <button onclick="_moveCreateRoutine()" style="height:40px;padding:0 20px;border-radius:8px;border:none;background:var(--ongoing);color:white;font-size:14px;font-weight:700;cursor:pointer">Create</button>
            <button onclick="_moveNewRoutineToggle(false)" style="height:40px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;font-weight:600;cursor:pointer">Cancel</button>
        </div>
    </div>`;
}

// --- Edit-mode toggles ---
function _moveEditOpen(id) { window._moveEdit = { routineId: id }; renderMovement(); }
function _moveEditClose() { window._moveEdit = { routineId: null }; renderMovement(); }
function _moveNewRoutineToggle(open) { window._moveNewRoutine = { open: !!open }; renderMovement(); }

// --- API helpers ---
async function _movePost(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Save failed.');
        return false;
    }
    return true;
}

// --- Routine CRUD ---
async function _moveCreateRoutine() {
    const name = (document.getElementById('move-new-routine-name')?.value || '').trim();
    if (!name) { alert('Give the routine a name first.'); return; }
    const note = (document.getElementById('move-new-routine-note')?.value || '').trim();
    if (await _movePost('/api/movement/routine/add', { name, note })) {
        window._moveNewRoutine = { open: false };
        await loadDashboard();
    }
}

async function _moveRenameRoutine(id, name) {
    if (!name.trim()) return;
    if (await _movePost('/api/movement/routine/update', { id, name })) await loadDashboard();
}

async function _moveRoutineNote(id, note) {
    if (await _movePost('/api/movement/routine/update', { id, note })) await loadDashboard();
}

function _moveRemoveRoutine(id, name) {
    pendingDelete = { item: id, type: 'movement-routine', label: name };
    document.getElementById('modal-text').innerHTML = `Delete routine <b>${esc(name)}</b> and all its moves?`;
    document.getElementById('modal').classList.add('open');
}

// --- Move CRUD ---
async function _moveAdd(routineId) {
    const name = (document.getElementById(`move-add-name-${routineId}`)?.value || '').trim();
    if (!name) { alert('Name the move first.'); return; }
    const url = (document.getElementById(`move-add-url-${routineId}`)?.value || '').trim();
    const note = (document.getElementById(`move-add-note-${routineId}`)?.value || '').trim();
    if (await _movePost('/api/movement/move/add', { routine_id: routineId, name, url, note })) await loadDashboard();
}

async function _moveUpdate(routineId, id, field, value) {
    const payload = { routine_id: routineId, id };
    payload[field] = value;
    if (await _movePost('/api/movement/move/update', payload)) await loadDashboard();
}

function _moveRemove(routineId, id, name) {
    pendingDelete = { item: id, type: 'movement-move', label: name, routineId };
    document.getElementById('modal-text').innerHTML = `Remove <b>${esc(name)}</b> from this routine?`;
    document.getElementById('modal').classList.add('open');
}

async function _moveReorder(routineId, moveId, dir) {
    const r = _movementRoutines().find(x => x.id === routineId);
    if (!r) return;
    const ids = (r.moves || []).map(m => m.id);
    const i = ids.indexOf(moveId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    if (await _movePost('/api/movement/move/reorder', { routine_id: routineId, order: ids })) await loadDashboard();
}
