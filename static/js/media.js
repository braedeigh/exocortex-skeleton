// media.js — a backlog of books / movies / shows recommended to her

const MEDIA_TYPES = ['book', 'movie', 'show', 'podcast', 'article', 'game', 'other'];
const MEDIA_TYPE_LABELS = {
    book: '📖 Book', movie: '🎬 Movie', show: '📺 Show',
    podcast: '🎧 Podcast', article: '📄 Article', game: '🎮 Game', other: '✦ Other',
};

function mediaTypeLabel(t) {
    return MEDIA_TYPE_LABELS[t] || MEDIA_TYPE_LABELS.other;
}

function mediaFormatDate(iso) {
    if (!iso) return 'undated';
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Compose state persists across re-renders (so the chosen type sticks)
if (!window._mediaCompose) window._mediaCompose = { type: 'book' };
// Which item (if any) is being edited inline
if (!window._mediaEdit) window._mediaEdit = { id: null };

function _mediaItems() {
    return (D.media && D.media.items) || [];
}

function renderMedia() {
    const el = document.getElementById('media-area');
    if (!el) return;

    const inp = 'padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box';

    // --- Type chips for the compose form ---
    const typeChips = (selected, cb) => MEDIA_TYPES.map(t => {
        const active = t === selected;
        const style = active
            ? 'background:rgba(124,92,191,0.18);border:1px solid var(--accent);color:var(--accent);font-weight:700'
            : 'background:none;border:1px solid var(--border);color:var(--text-muted);font-weight:500';
        return `<button type="button" onclick="${cb}('${t}')" style="padding:5px 12px;border-radius:14px;cursor:pointer;font-size:13px;${style}">${mediaTypeLabel(t)}</button>`;
    }).join('');

    const compose = `
    <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:18px;background:var(--bg-card)">
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${typeChips(window._mediaCompose.type, '_mediaSetComposeType')}</div>
        <input type="text" id="media-compose-title" placeholder="Title (book, movie, show…)" style="${inp};width:100%;margin-bottom:8px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <input type="text" id="media-compose-by" placeholder="Recommended by (optional)" style="${inp};flex:1;min-width:160px">
            <input type="date" id="media-compose-date" value="${todayStr()}" style="${inp}">
        </div>
        <textarea id="media-compose-notes" rows="3" placeholder="Notes — why it was recommended, what it's about, where to find it…" style="${inp};width:100%;resize:vertical;font-family:inherit;margin-bottom:10px"></textarea>
        <div style="display:flex;gap:8px">
            <button onclick="_mediaSaveCompose()" style="padding:8px 16px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600">Add</button>
            <button onclick="_mediaClearCompose()" style="padding:8px 16px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;cursor:pointer">Clear</button>
        </div>
    </div>`;

    const items = _mediaItems();
    // Sort: not-done first, then by date desc, then id for stability
    const sorted = items.slice().sort((a, b) => {
        if (!!a.done !== !!b.done) return a.done ? 1 : -1;
        const av = a.date || '0000-00-00', bv = b.date || '0000-00-00';
        if (av !== bv) return bv.localeCompare(av);
        return (b.id || '').localeCompare(a.id || '');
    });

    let cardsHtml;
    if (!sorted.length) {
        cardsHtml = `<div style="color:var(--text-muted);font-style:italic;padding:18px;border:1px dashed var(--border);border-radius:8px;text-align:center">Nothing logged yet. Add the first recommendation above.</div>`;
    } else {
        cardsHtml = sorted.map(it =>
            window._mediaEdit.id === it.id ? _mediaRenderEditor(it, inp, typeChips) : _mediaRenderCard(it)
        ).join('');
    }

    el.innerHTML = compose + cardsHtml;
}

function _mediaRenderCard(it) {
    const done = !!it.done;
    const meta = [];
    if (it.recommended_by) meta.push(`by ${esc(it.recommended_by)}`);
    meta.push(mediaFormatDate(it.date));
    const metaLine = `<span style="font-size:12px;color:var(--text-muted)">${meta.join(' · ')}</span>`;
    const notes = it.notes
        ? `<div style="margin-top:8px;white-space:pre-wrap;line-height:1.55;font-size:14px;color:var(--text)">${esc(it.notes)}</div>`
        : '';
    const titleStyle = done
        ? 'font-weight:700;font-size:16px;color:var(--text-muted);text-decoration:line-through'
        : 'font-weight:700;font-size:16px;color:var(--text)';
    return `<div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px;background:var(--bg-card);${done ? 'opacity:0.7' : ''}">
        <div style="display:flex;align-items:flex-start;gap:10px">
            <input type="checkbox" ${done ? 'checked' : ''} onchange="_mediaToggleDone('${esc(it.id)}', this.checked)" title="Mark read/watched" style="margin-top:4px;width:18px;height:18px;cursor:pointer;flex:none">
            <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span style="font-size:12px;color:var(--accent);font-weight:600">${mediaTypeLabel(it.type)}</span>
                    <span style="${titleStyle}">${esc(it.title)}</span>
                </div>
                <div style="margin-top:2px">${metaLine}</div>
                ${notes}
            </div>
            <div style="display:flex;gap:4px;flex:none">
                <button onclick="_mediaEditOpen('${esc(it.id)}')" title="Edit" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:15px">&#9998;</button>
                <button onclick="mediaRemove('${esc(it.id)}','${escJs(it.title)}')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px">&times;</button>
            </div>
        </div>
    </div>`;
}

function _mediaRenderEditor(it, inp, typeChips) {
    window._mediaEditType = window._mediaEditType || it.type || 'book';
    return `<div style="border:1px solid var(--accent);border-radius:10px;padding:14px;margin-bottom:12px;background:var(--bg-card)">
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${typeChips(window._mediaEditType, '_mediaSetEditType')}</div>
        <input type="text" id="media-edit-title" value="${esc(it.title)}" placeholder="Title" style="${inp};width:100%;margin-bottom:8px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <input type="text" id="media-edit-by" value="${esc(it.recommended_by || '')}" placeholder="Recommended by (optional)" style="${inp};flex:1;min-width:160px">
            <input type="date" id="media-edit-date" value="${esc(it.date || todayStr())}" style="${inp}">
        </div>
        <textarea id="media-edit-notes" rows="3" placeholder="Notes" style="${inp};width:100%;resize:vertical;font-family:inherit;margin-bottom:10px">${esc(it.notes || '')}</textarea>
        <div style="display:flex;gap:8px">
            <button onclick="_mediaSaveEdit('${esc(it.id)}')" style="padding:8px 16px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600">Save</button>
            <button onclick="_mediaCancelEdit()" style="padding:8px 16px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;cursor:pointer">Cancel</button>
        </div>
    </div>`;
}

// --- Compose ---
function _mediaSetComposeType(t) { window._mediaCompose.type = t; renderMedia(); }

function _mediaClearCompose() {
    ['media-compose-title', 'media-compose-by', 'media-compose-notes'].forEach(id => {
        const e = document.getElementById(id); if (e) e.value = '';
    });
}

async function _mediaSaveCompose() {
    const title = (document.getElementById('media-compose-title')?.value || '').trim();
    if (!title) { alert('Add a title first.'); return; }
    const payload = {
        title,
        type: window._mediaCompose.type,
        recommended_by: (document.getElementById('media-compose-by')?.value || '').trim(),
        date: document.getElementById('media-compose-date')?.value || todayStr(),
        notes: (document.getElementById('media-compose-notes')?.value || '').trim(),
    };
    const res = await fetch('/api/media/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) {
        _mediaClearCompose();
        await loadDashboard();
    } else {
        alert('Save failed.');
    }
}

// --- Edit ---
function _mediaSetEditType(t) { window._mediaEditType = t; renderMedia(); }

function _mediaEditOpen(id) {
    window._mediaEdit = { id };
    window._mediaEditType = null;  // re-seed from the item on next render
    renderMedia();
}

function _mediaCancelEdit() {
    window._mediaEdit = { id: null };
    window._mediaEditType = null;
    renderMedia();
}

async function _mediaSaveEdit(id) {
    const title = (document.getElementById('media-edit-title')?.value || '').trim();
    if (!title) { alert('Title cannot be empty.'); return; }
    const payload = {
        id,
        title,
        type: window._mediaEditType || 'book',
        recommended_by: (document.getElementById('media-edit-by')?.value || '').trim(),
        date: document.getElementById('media-edit-date')?.value || todayStr(),
        notes: (document.getElementById('media-edit-notes')?.value || '').trim(),
    };
    const res = await fetch('/api/media/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) {
        window._mediaEdit = { id: null };
        window._mediaEditType = null;
        await loadDashboard();
    } else {
        alert('Save failed.');
    }
}

async function _mediaToggleDone(id, done) {
    await fetch('/api/media/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, done }),
    });
    await loadDashboard();
}

function mediaRemove(id, title) {
    pendingDelete = { item: id, type: 'media-item', label: title };
    document.getElementById('modal-text').innerHTML = `Remove <b>${esc(title)}</b>?`;
    document.getElementById('modal').classList.add('open');
}
