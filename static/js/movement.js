// movement.js — routines of moves, each move linking out to a demo video.
// Like a little workout app: tap a move to open its video. Everything here is
// editable in the UI (add a routine, paste a video link, reorder) — no terminal.

// Which routine (if any) is in edit mode. Edit grows the controls; normal view
// stays clean and big-tappable ("small until edit").
if (!window._moveEdit) window._moveEdit = { routineId: null };
// Whether the "new routine" form is showing
if (!window._moveNewRoutine) window._moveNewRoutine = { open: false };
// Which routine is opened into its detail view (recipe-style drill-in), or null.
// Window-scoped so it survives the 5s polling re-render, like _kitchenRecipeView.
if (!window._movementRoutineView) window._movementRoutineView = null;

function _movementRoutines() {
    return (D.movement && D.movement.routines) || [];
}

// Pull the 11-char YouTube id out of watch / youtu.be / embed / shorts URLs.
// Returns '' for non-YouTube or empty URLs (those fall back to a plain link).
function _ytId(url) {
    if (!url) return '';
    const s = String(url).trim();
    let m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    m = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    m = s.match(/\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return '';
}

// Swap a thumbnail placeholder for the real player (autoplay, fullscreen-capable).
// Only called on tap, so the page stays light until you actually want to watch.
function _moveLoadPlayer(elId, vidId) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.onclick = null;
    el.style.cursor = 'default';
    el.innerHTML = `<iframe src="https://www.youtube.com/embed/${vidId}?autoplay=1&rel=0&modestbranding=1&playsinline=1" style="position:absolute;inset:0;width:100%;height:100%;border:0" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
}

function renderMovement() {
    const el = document.getElementById('movement-area');
    if (!el) return;
    const sub = document.getElementById('movement-subtitle');
    const routines = _movementRoutines();

    // Detail view: one routine drilled into (recipe-style). If the open routine is
    // gone (e.g. just deleted), null the state and fall through to the menu.
    if (window._movementRoutineView) {
        const r = routines.find(x => x.id === window._movementRoutineView);
        if (r) {
            if (sub) sub.style.display = 'none';   // hide the tab blurb inside a routine
            el.innerHTML = _movementDetail(r);
            return;
        }
        window._movementRoutineView = null;
    }
    if (sub) sub.style.display = '';

    // List menu: a tappable card per routine, then the "new routine" affordance.
    let body;
    if (!routines.length) {
        body = `<div style="color:var(--text-muted);font-style:italic;padding:18px;border:1px dashed var(--border);border-radius:8px;text-align:center;font-size:14px">
            No routines yet. Add one below to start collecting movements and their videos.</div>`;
    } else {
        body = routines.map(r => _movementListCard(r)).join('');
    }
    el.innerHTML = body + _movementNewRoutine();
}

// --- List menu: a tappable summary card that drills into the routine ---
function _movementListCard(r) {
    const n = (r.moves || []).length;
    const note = r.note
        ? `<div style="font-size:13px;color:var(--text-muted);margin-top:4px;line-height:1.4">${esc(r.note)}</div>`
        : '';
    return `<div onclick="_moveOpenRoutine('${esc(r.id)}')" style="display:flex;align-items:center;gap:12px;border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;background:var(--bg-card);cursor:pointer;min-height:44px">
        <div style="flex:1;min-width:0">
            <div style="font-size:18px;font-weight:700;color:var(--text)">${esc(r.name)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${n} move${n === 1 ? '' : 's'}</div>
            ${note}
        </div>
        <span style="flex:none;font-size:24px;color:var(--text-muted)">&#8250;</span>
    </div>`;
}

// --- Detail view: the opened routine — Back/Edit header, then its moves ---
function _movementDetail(r) {
    const editing = window._moveEdit.routineId === r.id;
    const header = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <button onclick="_moveCloseRoutine()" style="display:inline-flex;align-items:center;height:38px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;font-weight:600;cursor:pointer">&#8592; Back</button>
        ${editing ? '' : `<button onclick="_moveEditOpen('${esc(r.id)}')" style="margin-left:auto;height:38px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;font-weight:600;cursor:pointer">Edit</button>`}
    </div>`;
    if (editing) {
        return header + _movementRoutineEditor(r);
    }
    const moves = r.moves || [];
    const rows = moves.length
        ? moves.map(m => _movementMoveRow(r, m)).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:12px 2px;font-size:14px">No moves yet — tap Edit to add some.</div>`;
    const note = r.note
        ? `<div style="font-size:13px;color:var(--text-muted);margin:0 0 14px;line-height:1.45">${esc(r.note)}</div>`
        : '';
    return `${header}
        <div style="font-size:22px;font-weight:700;color:var(--text);margin-bottom:4px">${esc(r.name)}</div>
        ${note}
        ${rows}`;
}

function _movementMoveRow(r, m) {
    const hasVid = !!(m.url && m.url.trim());
    const dose = m.dose
        ? `<span style="display:inline-block;padding:2px 9px;border-radius:11px;background:rgba(124,92,191,0.16);color:var(--accent);font-size:12px;font-weight:700;white-space:nowrap">${esc(m.dose)}</span>`
        : '';
    const note = m.note
        ? `<span style="font-size:12px;color:var(--text-muted)">${esc(m.note)}</span>`
        : '';
    const meta = (dose || note)
        ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px">${dose}${note}</div>`
        : '';
    const label = `<div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:600;color:var(--text)">${esc(m.name)}</div>
            ${meta}
        </div>`;
    const vidId = _ytId(m.url);
    if (vidId) {
        // Inline click-to-load player — thumbnail until tapped, then plays in
        // place with the native fullscreen button. Keeps the tab light.
        const thumb = `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`;
        return `<div style="border:1px solid var(--border);border-radius:11px;padding:12px;margin-bottom:10px;background:var(--bg)">
            <div style="margin-bottom:10px">${label}</div>
            <div id="move-vid-${esc(m.id)}" onclick="_moveLoadPlayer('move-vid-${esc(m.id)}','${esc(vidId)}')" style="position:relative;width:100%;padding-bottom:56.25%;border-radius:10px;overflow:hidden;cursor:pointer;background:#000">
                <img src="${thumb}" loading="lazy" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.82">
                <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:60px;height:60px;border-radius:50%;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;padding-left:4px;box-sizing:border-box">&#9654;</span>
            </div>
            <a href="${esc(m.url)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;font-size:12px;color:var(--text-muted);text-decoration:none">Open on YouTube &#8599;</a>
        </div>`;
    }
    if (hasVid) {
        // Non-YouTube URL — whole row is a link that opens in a new tab.
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
        <input type="text" value="${esc(m.dose || '')}" onchange="_moveUpdate('${esc(r.id)}','${esc(m.id)}','dose', this.value)" placeholder="Reps / hold (e.g. 20–30s · 1–2×/side)" style="${inp};width:100%;margin-bottom:7px">
        <input type="text" value="${esc(m.url || '')}" onchange="_moveUpdate('${esc(r.id)}','${esc(m.id)}','url', this.value)" placeholder="Video URL (paste a YouTube link — leave blank if none)" style="${inp};width:100%;margin-bottom:7px">
        <input type="text" value="${esc(m.note || '')}" onchange="_moveUpdate('${esc(r.id)}','${esc(m.id)}','note', this.value)" placeholder="Optional cue (e.g. nose toward armpit)" style="${inp};width:100%">
    </div>`;
}

function _movementAddMove(r, inp) {
    return `<div style="border:1px dashed var(--border);border-radius:9px;padding:10px;margin-top:4px">
        <input type="text" id="move-add-name-${esc(r.id)}" placeholder="New move name" style="${inp};width:100%;margin-bottom:7px">
        <input type="text" id="move-add-dose-${esc(r.id)}" placeholder="Reps / hold (optional)" style="${inp};width:100%;margin-bottom:7px">
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

// --- Drill-in (recipe-style): open / close a routine's detail view ---
function _moveOpenRoutine(id) {
    window._movementRoutineView = id;
    window._moveEdit = { routineId: null };
    renderMovement();
    window.scrollTo({ top: 0, behavior: 'instant' });
}
function _moveCloseRoutine() {
    window._movementRoutineView = null;
    window._moveEdit = { routineId: null };
    renderMovement();
    window.scrollTo({ top: 0, behavior: 'instant' });
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
    const dose = (document.getElementById(`move-add-dose-${routineId}`)?.value || '').trim();
    const url = (document.getElementById(`move-add-url-${routineId}`)?.value || '').trim();
    const note = (document.getElementById(`move-add-note-${routineId}`)?.value || '').trim();
    if (await _movePost('/api/movement/move/add', { routine_id: routineId, name, dose, url, note })) await loadDashboard();
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
