// archivals.js — the things-you-own catalog (ported from the standalone
// inventory-app). Photo-first grid grouped by category; tap a thing to view /
// edit it in a modal. Data: D.archivals (list), API: /api/archivals/*.

const ARCH_SECONDHAND = ['new', 'secondhand', 'handmade', 'unknown'];

let _archFilter = '';

function archPhotoUrl(item) {
    const p = (item.photos || [])[0];
    return p ? `/archivals/photo/${encodeURIComponent(p.filename)}` : '';
}

function renderArchivals() {
    const el = document.getElementById('archivals-area');
    if (!el) return;
    const items = D.archivals;
    if (!Array.isArray(items)) { el.innerHTML = ''; return; }  // frosted/public

    const q = _archFilter.trim().toLowerCase();
    const shown = q
        ? items.filter(i => [i.name, i.category, i.subcategory, i.origin, i.description]
            .some(v => (v || '').toLowerCase().includes(q)))
        : items;

    const groups = {};
    shown.forEach(item => {
        const cat = (item.category || '').trim() || 'uncategorized';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(item);
    });
    const categoryNames = Object.keys(groups).sort((a, b) => {
        if (a === 'uncategorized') return 1;
        if (b === 'uncategorized') return -1;
        return a.localeCompare(b);
    });

    const renderTile = (item) => {
        const url = archPhotoUrl(item);
        const img = url
            ? `<img src="${esc(url)}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
            : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:34px;background:var(--bg)">📦</div>`;
        const privateBadge = item.private === 'yes'
            ? `<span style="position:absolute;top:6px;right:6px;font-size:12px;background:rgba(0,0,0,0.55);color:#fff;border-radius:6px;padding:2px 6px">🔒</span>`
            : '';
        return `<div onclick="openArchivalModal('${escJs(item.id)}')" style="cursor:pointer;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--card-bg,var(--bg))">
            <div style="position:relative;aspect-ratio:1/1">${img}${privateBadge}</div>
            <div style="padding:8px 10px;font-size:13px;font-weight:600;line-height:1.3;min-height:40px;display:flex;align-items:center">${esc(item.name)}</div>
        </div>`;
    };

    let sectionsHTML = '';
    categoryNames.forEach(cat => {
        const sorted = [...groups[cat]].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const label = cat === 'uncategorized' ? 'Uncategorized' : cat.charAt(0).toUpperCase() + cat.slice(1);
        sectionsHTML += `<div style="margin-bottom:14px">
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${esc(label)} <span style="opacity:0.6;font-weight:400">(${sorted.length})</span></div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px">
                ${sorted.map(renderTile).join('')}
            </div>
        </div>`;
    });

    el.innerHTML = `<details open class="card-section" style="margin-top:20px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Archivals${items.length ? ` (${items.length})` : ''}</summary>
        <div class="card" style="border-left-color:var(--purple,#8e6bbf);margin-top:8px;padding:12px">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Things you own — clothes, jewelry, sentimental. Where they came from and the stories attached.</div>
            <div style="display:flex;gap:8px;margin-bottom:12px">
                <input type="text" id="arch-filter" value="${esc(_archFilter)}" placeholder="Search things..."
                    oninput="_archFilter=this.value;renderArchivals();(function(){const f=document.getElementById('arch-filter');f.focus();f.setSelectionRange(f.value.length,f.value.length);})()"
                    style="flex:1;min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
                <button onclick="openArchivalModal(null)" style="min-height:40px;padding:7px 16px;border:none;border-radius:8px;background:var(--text);color:#fff;font-size:14px;font-weight:600;cursor:pointer">+ Add</button>
            </div>
            ${sectionsHTML || `<div style="font-size:14px;color:var(--text-muted);padding:4px 0">${q ? 'Nothing matches' : 'Nothing catalogued yet — add your first thing'}</div>`}
        </div>
    </details>`;
}

// --- detail / add modal ---

function _archKnownCategories() {
    const cats = new Set(['clothing', 'jewelry', 'sentimental', 'bedding', 'other']);
    (D.archivals || []).forEach(i => { if (i.category) cats.add(i.category); });
    return [...cats].sort();
}

function _archMaterialsText(item) {
    return (item.materials || [])
        .map(m => m.percentage != null ? `${m.material} ${m.percentage}` : m.material)
        .join(', ');
}

function openArchivalModal(itemId) {
    const item = itemId ? (D.archivals || []).find(i => i.id === itemId) : null;
    if (itemId && !item) return;
    const isNew = !item;
    const it = item || {};

    let ov = document.getElementById('archival-modal-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'archival-modal-overlay';
        ov.className = 'modal-overlay';
        ov.style.zIndex = '100';
        document.body.appendChild(ov);
        ov.addEventListener('click', e => { if (e.target === ov) closeArchivalModal(); });
    }

    const catOpts = _archKnownCategories().map(c => `<option value="${esc(c)}">`).join('');
    const shOpts = ARCH_SECONDHAND.map(s =>
        `<option value="${s}" ${(it.secondhand || 'unknown') === s ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('');

    const photosHTML = (it.photos || []).map((p, idx) => `
        <div style="position:relative;width:88px;flex-shrink:0">
            <img src="/archivals/photo/${encodeURIComponent(p.filename)}" loading="lazy" alt=""
                style="width:88px;height:88px;object-fit:cover;border-radius:8px;display:block;border:${idx === 0 ? '2px solid var(--ongoing)' : '1px solid var(--border)'}">
            <button onclick="removeArchivalPhoto('${escJs(it.id)}','${escJs(p.id)}')" title="Delete photo"
                style="position:absolute;top:-8px;right:-8px;width:26px;height:26px;border-radius:50%;border:none;background:var(--red);color:#fff;font-size:14px;cursor:pointer;line-height:1">&times;</button>
            ${idx !== 0 ? `<button onclick="setMainArchivalPhoto('${escJs(it.id)}','${escJs(p.id)}')" title="Make main photo"
                style="position:absolute;bottom:4px;left:4px;min-width:26px;height:26px;border-radius:6px;border:none;background:rgba(0,0,0,0.55);color:#fff;font-size:13px;cursor:pointer">★</button>` : ''}
        </div>`).join('');

    const photoSection = isNew
        ? `<label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px">Photos (up to 5)</label>
           <input type="file" id="arch-photos-input" accept="image/*" multiple style="font-size:13px;margin-bottom:14px;width:100%">`
        : `<label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px">Photos</label>
           <div style="display:flex;gap:12px;overflow-x:auto;padding:8px 2px;margin-bottom:6px">${photosHTML || '<span style="font-size:13px;color:var(--text-muted)">No photos yet</span>'}</div>
           <input type="file" id="arch-photos-input" accept="image/*" multiple onchange="addArchivalPhotos('${escJs(it.id)}',this)" style="font-size:13px;margin-bottom:14px;width:100%">`;

    ov.innerHTML = `<div class="modal" style="max-width:560px;width:calc(100% - 32px);max-height:88vh;overflow-y:auto;text-align:left">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div style="font-size:17px;font-weight:700">${isNew ? 'Add a thing' : 'Edit thing'}</div>
            <button onclick="closeArchivalModal()" style="width:40px;height:40px;border:none;background:none;font-size:22px;cursor:pointer;color:var(--text-muted)">&times;</button>
        </div>

        ${photoSection}

        <div style="display:grid;grid-template-columns:1fr;gap:10px">
            <input type="text" id="arch-name" value="${esc(it.name || '')}" placeholder="Name *" style="min-height:40px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:15px;font-weight:600;outline:none;background:var(--bg)">
            <div style="display:flex;gap:8px">
                <input type="text" id="arch-category" list="arch-categories" value="${esc(it.category || '')}" placeholder="Category" style="flex:1;min-height:40px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
                <datalist id="arch-categories">${catOpts}</datalist>
                <input type="text" id="arch-subcategory" value="${esc(it.subcategory || '')}" placeholder="Subcategory" style="flex:1;min-height:40px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
            </div>
            <input type="text" id="arch-origin" value="${esc(it.origin || '')}" placeholder="Origin — where it came from (store, gift from mom...)" style="min-height:40px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
            <input type="text" id="arch-materials" value="${esc(_archMaterialsText(it))}" placeholder="Materials — e.g. Cotton 80, Polyester 20" style="min-height:40px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
            <textarea id="arch-description" rows="5" placeholder="The story — keep it in your own words" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg);font-family:inherit;line-height:1.5;resize:vertical">${esc(it.description || '')}</textarea>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                <select id="arch-secondhand" style="min-height:40px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg)">${shOpts}</select>
                <label style="display:inline-flex;align-items:center;gap:6px;font-size:14px;min-height:40px;padding:0 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer">
                    <input type="checkbox" id="arch-gifted" ${it.gifted === 'yes' ? 'checked' : ''} style="width:18px;height:18px"> Gifted
                </label>
                <label style="display:inline-flex;align-items:center;gap:6px;font-size:14px;min-height:40px;padding:0 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer" title="Hidden from the public site entirely">
                    <input type="checkbox" id="arch-private" ${it.private === 'yes' ? 'checked' : ''} style="width:18px;height:18px"> 🔒 Private
                </label>
            </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:18px">
            ${isNew ? '<span></span>' : `<button onclick="confirmDeleteArchival('${escJs(it.id)}','${escJs(it.name || '')}')" style="min-height:40px;padding:8px 14px;border:1px solid var(--red);border-radius:8px;background:none;color:var(--red);font-size:13px;font-weight:600;cursor:pointer">Delete</button>`}
            <div style="display:flex;gap:8px">
                <button onclick="closeArchivalModal()" style="min-height:40px;padding:8px 16px;border:1px solid var(--border);border-radius:8px;background:none;font-size:13px;cursor:pointer;color:var(--text-muted)">Cancel</button>
                <button onclick="saveArchival(${isNew ? 'null' : `'${escJs(it.id)}'`})" style="min-height:40px;padding:8px 20px;border:none;border-radius:8px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Save</button>
            </div>
        </div>
    </div>`;
    ov.classList.add('open');
    if (isNew) setTimeout(() => { const n = document.getElementById('arch-name'); if (n) n.focus(); }, 50);
}

function closeArchivalModal() {
    const ov = document.getElementById('archival-modal-overlay');
    if (ov) ov.classList.remove('open');
}

function _archFormPayload() {
    return {
        name: document.getElementById('arch-name').value.trim(),
        category: document.getElementById('arch-category').value.trim().toLowerCase(),
        subcategory: document.getElementById('arch-subcategory').value.trim().toLowerCase(),
        origin: document.getElementById('arch-origin').value.trim(),
        materials: document.getElementById('arch-materials').value.trim(),
        description: document.getElementById('arch-description').value.trim(),
        secondhand: document.getElementById('arch-secondhand').value,
        gifted: document.getElementById('arch-gifted').checked ? 'yes' : 'no',
        private: document.getElementById('arch-private').checked ? 'yes' : 'no',
    };
}

async function saveArchival(itemId) {
    const payload = _archFormPayload();
    if (!payload.name) { alert('Name is required'); return; }

    let res;
    if (itemId) {
        res = await fetch('/api/archivals/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: itemId, ...payload })
        });
    } else {
        const fd = new FormData();
        Object.entries(payload).forEach(([k, v]) => fd.append(k, v));
        const input = document.getElementById('arch-photos-input');
        if (input) [...input.files].forEach(f => fd.append('photos', f));
        res = await fetch('/api/archivals/add', { method: 'POST', body: fd });
    }
    if (res.ok) {
        closeArchivalModal();
        loadDashboard();
    } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Save failed');
    }
}

async function addArchivalPhotos(itemId, input) {
    if (!input.files.length) return;
    const fd = new FormData();
    [...input.files].forEach(f => fd.append('photos', f));
    const res = await fetch(`/api/archivals/${encodeURIComponent(itemId)}/photos`, { method: 'POST', body: fd });
    if (res.ok) {
        await _archReloadAndReopen(itemId);
    } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Upload failed');
    }
}

async function removeArchivalPhoto(itemId, photoId) {
    const res = await fetch(`/api/archivals/${encodeURIComponent(itemId)}/photos/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_id: photoId })
    });
    if (res.ok) await _archReloadAndReopen(itemId);
    else alert('Delete failed');
}

async function setMainArchivalPhoto(itemId, photoId) {
    const res = await fetch(`/api/archivals/${encodeURIComponent(itemId)}/photos/main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_id: photoId })
    });
    if (res.ok) await _archReloadAndReopen(itemId);
    else alert('Update failed');
}

async function _archReloadAndReopen(itemId) {
    // Photo edits change server state the open modal renders from — refresh
    // D.archivals, then rebuild the modal in place.
    try {
        const res = await fetch('/api/archivals');
        const data = await res.json();
        D.archivals = data.items || [];
    } catch (e) { /* fall through — modal reopens from stale D */ }
    renderArchivals();
    openArchivalModal(itemId);
}

function confirmDeleteArchival(itemId, name) {
    _showDeleteConfirm(name || 'this thing', async () => {
        closeTodoConfirm();
        const res = await fetch('/api/archivals/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: itemId })
        });
        if (res.ok) {
            closeArchivalModal();
            loadDashboard();
        } else {
            alert('Delete failed');
        }
    });
}
