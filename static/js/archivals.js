// archivals.js — the things-you-own catalog (ported from the standalone
// inventory-app). Search/filter/sort over three views — Cloud (auto-laid-out
// category boxes), Cards (photo grid) and Table — plus the add/edit modal.
// Data: D.archivals (list), API: /api/archivals/*.

const ARCH_SECONDHAND = ['new', 'secondhand', 'handmade', 'unknown'];
const ARCH_CELL_W = 50;   // cloud view grid cell — 48px thumb + 2px gap
const ARCH_CELL_H = 58;
const ARCH_THUMB_W = 48;
const ARCH_THUMB_H = 56;

// --- module-level UI state (kept across re-renders so polling doesn't reset the view) ---
let _archFilter = '';
let _archSort = 'newest';           // newest | oldest | az | random
let _archRandomSeed = 1;
let _archShowFilters = false;
let _archViewMode = (function () {
    try { return localStorage.getItem('archViewMode') || 'cards'; } catch (e) { return 'cards'; }
})();
let _archFilters = {
    categories: [],
    subcategories: [],
    sources: [],
    gifted: null,       // null | true | false
    materials: [],
};
let _archCloudResizeBound = false;

function archPhotoUrl(item) {
    const p = (item.photos || [])[0];
    return p ? `/archivals/photo/${encodeURIComponent(p.filename)}` : '';
}

// '2025-12-17T21:18:18.683397' → 'Dec 17, 2025' (or with time for the modal)
function _archFmtDate(ts, withTime) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return ts.slice(0, 10);
    const opts = withTime
        ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
        : { month: 'short', day: 'numeric', year: 'numeric' };
    return d.toLocaleString(undefined, opts);
}

// --- filtering (ports useInventoryData.js's getFilteredItems / filteredAndSortedList) ---

function _archMatchesSearch(item) {
    const q = _archFilter.trim().toLowerCase();
    if (!q) return true;
    return [item.name, item.description, item.origin, item.category, item.subcategory]
        .some(v => (v || '').toLowerCase().includes(q));
}

// exclude: the one filter group to skip — used to compute "how many items would
// match if this group's own filter weren't applied" for chip counts.
function _archMatchesFilters(item, exclude) {
    const cat = (item.category || '').trim();

    if (exclude !== 'category' && _archFilters.categories.length && !_archFilters.categories.includes(cat)) return false;

    if (exclude !== 'subcategory' && cat === 'clothing' && _archFilters.subcategories.length) {
        const sub = (item.subcategory || '').trim();
        const isUncat = !sub;
        if (_archFilters.subcategories.includes('uncategorized') && isUncat) {
            // passes
        } else if (!_archFilters.subcategories.includes(sub)) {
            return false;
        }
    }

    if (exclude !== 'source' && _archFilters.sources.length && !_archFilters.sources.includes(item.secondhand || '')) return false;

    if (exclude !== 'gifted' && _archFilters.gifted !== null) {
        const isGifted = item.gifted === 'yes';
        if (_archFilters.gifted && !isGifted) return false;
        if (!_archFilters.gifted && isGifted) return false;
    }

    if (exclude !== 'materials' && _archFilters.materials.length) {
        const names = (item.materials || []).map(m => m.material);
        if (!_archFilters.materials.some(m => names.includes(m))) return false;
    }

    return true;
}

function _archGetFilteredItems(items, exclude) {
    return items.filter(item => _archMatchesSearch(item) && _archMatchesFilters(item, exclude));
}

function _archAnyFilterActive() {
    return _archFilters.categories.length || _archFilters.subcategories.length ||
        _archFilters.sources.length || _archFilters.gifted !== null || _archFilters.materials.length;
}

// Seeded shuffle (mulberry32) — same seed always produces the same order, so
// re-renders triggered by polling don't reshuffle Random view underfoot.
function _archSeededShuffle(arr, seed) {
    let s = (seed >>> 0) || 1;
    function rand() {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function _archSortItems(items) {
    if (_archSort === 'oldest') return [...items].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    if (_archSort === 'az') return [...items].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (_archSort === 'random') return _archSeededShuffle(items, _archRandomSeed);
    return [...items].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')); // newest
}

function _archEmptyMessage(totalCount) {
    return totalCount === 0 ? 'Nothing catalogued yet — add your first thing' : 'Nothing matches';
}

// --- UI state setters (all re-render) ---

function _archSetViewMode(mode) {
    _archViewMode = mode;
    try { localStorage.setItem('archViewMode', mode); } catch (e) { /* ignore */ }
    renderArchivals();
}

function _archToggleFilters() {
    _archShowFilters = !_archShowFilters;
    renderArchivals();
}

function _archToggleFilter(group, value) {
    const arr = _archFilters[group];
    const i = arr.indexOf(value);
    if (i === -1) arr.push(value); else arr.splice(i, 1);
    renderArchivals();
}

function _archSetGifted(val) {
    _archFilters.gifted = val;
    renderArchivals();
}

function _archClearFilters() {
    _archFilters = { categories: [], subcategories: [], sources: [], gifted: null, materials: [] };
    renderArchivals();
}

function _archSortChanged(select) {
    const val = select.value || _archSort;
    _archSort = val;
    if (val === 'random') _archRandomSeed++;
    renderArchivals();
}

function _archBindCloudResize() {
    if (_archCloudResizeBound) return;
    _archCloudResizeBound = true;
    let t = null;
    window.addEventListener('resize', () => {
        clearTimeout(t);
        t = setTimeout(() => { if (_archViewMode === 'cloud') renderArchivals(); }, 150);
    });
}

// --- small render helpers ---

function _archChip(label, active, onclick) {
    return `<button onclick="${onclick}" style="min-height:36px;padding:6px 12px;border-radius:16px;font-size:13px;cursor:pointer;white-space:nowrap;${active ? 'background:var(--text);color:#fff;border:1px solid var(--text)' : 'background:none;color:var(--text);border:1px solid var(--border)'}">${label}</button>`;
}

function _archViewButtons() {
    const modes = [['cloud', '☁️ Cloud'], ['cards', '🖼 Cards'], ['table', '☰ Table']];
    return modes.map(([mode, label], i) => {
        const active = _archViewMode === mode;
        const border = i < modes.length - 1 ? 'border-right:1px solid var(--border);' : '';
        return `<button onclick="_archSetViewMode('${mode}')" style="min-height:40px;padding:7px 14px;border:none;${border}${active ? 'background:var(--text);color:#fff' : 'background:none;color:var(--text)'};font-size:14px;font-weight:600;cursor:pointer">${label}</button>`;
    }).join('');
}

// --- filter panel ---

function _archRenderFilterPanel(items, allCategories, allMaterials) {
    const catBase = _archGetFilteredItems(items, 'category');
    const catChips = allCategories.map(cat => {
        const count = catBase.filter(i => (i.category || '').trim() === cat).length;
        const active = _archFilters.categories.includes(cat);
        const label = cat.charAt(0).toUpperCase() + cat.slice(1);
        return _archChip(`${esc(label)} (${count})`, active, `_archToggleFilter('categories','${escJs(cat)}')`);
    }).join('');

    let subHTML = '';
    if (_archFilters.categories.includes('clothing')) {
        const subBase = _archGetFilteredItems(items, 'subcategory');
        const clothingSubs = [...new Set(
            items.filter(i => (i.category || '').trim() === 'clothing' && (i.subcategory || '').trim())
                .map(i => i.subcategory.trim())
        )].sort();
        const uncatCount = subBase.filter(i => (i.category || '').trim() === 'clothing' && !(i.subcategory || '').trim()).length;

        let chips = '';
        if (uncatCount > 0) {
            chips += _archChip(`Uncategorized (${uncatCount})`, _archFilters.subcategories.includes('uncategorized'), `_archToggleFilter('subcategories','uncategorized')`);
        }
        chips += clothingSubs.map(sub => {
            const count = subBase.filter(i => (i.category || '').trim() === 'clothing' && (i.subcategory || '').trim() === sub).length;
            const active = _archFilters.subcategories.includes(sub);
            const label = sub.charAt(0).toUpperCase() + sub.slice(1);
            return _archChip(`${esc(label)} (${count})`, active, `_archToggleFilter('subcategories','${escJs(sub)}')`);
        }).join('');

        if (chips) {
            subHTML = `<div style="margin-bottom:12px">
                <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Clothing type</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
            </div>`;
        }
    }

    const sourceBase = _archGetFilteredItems(items, 'source');
    const sourceChips = ARCH_SECONDHAND.map(s => {
        const count = sourceBase.filter(i => i.secondhand === s).length;
        const active = _archFilters.sources.includes(s);
        const label = s.charAt(0).toUpperCase() + s.slice(1);
        return _archChip(`${label} (${count})`, active, `_archToggleFilter('sources','${s}')`);
    }).join('');

    const giftedBase = _archGetFilteredItems(items, 'gifted');
    const giftedCount = giftedBase.filter(i => i.gifted === 'yes').length;
    const notGiftedCount = giftedBase.length - giftedCount;
    const giftedChips = [
        _archChip(`All (${giftedBase.length})`, _archFilters.gifted === null, `_archSetGifted(null)`),
        _archChip(`Gifted (${giftedCount})`, _archFilters.gifted === true, `_archSetGifted(true)`),
        _archChip(`Not gifted (${notGiftedCount})`, _archFilters.gifted === false, `_archSetGifted(false)`),
    ].join('');

    let materialsHTML = '';
    if (allMaterials.length) {
        const matBase = _archGetFilteredItems(items, 'materials');
        const matChips = allMaterials.map(mat => {
            const count = matBase.filter(i => (i.materials || []).some(m => m.material === mat)).length;
            if (!count) return '';
            const active = _archFilters.materials.includes(mat);
            return _archChip(`${esc(mat)} (${count})`, active, `_archToggleFilter('materials','${escJs(mat)}')`);
        }).join('');
        if (matChips) {
            materialsHTML = `<div>
                <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Materials</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px">${matChips}</div>
            </div>`;
        }
    }

    return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px;background:var(--bg)">
        <div style="margin-bottom:12px">
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Categories</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${catChips || '<span style="font-size:13px;color:var(--text-muted)">None yet</span>'}</div>
        </div>
        ${subHTML}
        <div style="margin-bottom:12px">
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Source</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${sourceChips}</div>
        </div>
        <div style="margin-bottom:${materialsHTML ? '12px' : '0'}">
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Gifted</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${giftedChips}</div>
        </div>
        ${materialsHTML}
    </div>`;
}

// --- Cards view ---

function _archRenderCard(item) {
    const url = archPhotoUrl(item);
    const img = url
        ? `<img src="${esc(url)}" loading="lazy" alt="" style="width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;display:block">`
        : `<div style="width:100%;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;font-size:40px;background:var(--bg);border-radius:8px">📦</div>`;
    const privateBadge = item.private === 'yes'
        ? `<span style="position:absolute;top:8px;right:8px;font-size:12px;background:rgba(0,0,0,0.55);color:#fff;border-radius:6px;padding:2px 6px">🔒</span>`
        : '';
    const descLine = item.description
        ? `<div style="margin-top:6px"><div style="font-size:12px;color:var(--text-muted)">Description</div><div style="font-size:14px;color:var(--text);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(item.description)}</div></div>`
        : '';
    const catLine = item.category
        ? `<div style="margin-top:6px"><span style="font-size:12px;color:var(--text-muted)">Category </span><span style="font-size:14px">${esc(item.category)}</span></div>`
        : '';
    const originLine = item.origin
        ? `<div style="margin-top:6px"><span style="font-size:12px;color:var(--text-muted)">Origin </span><span style="font-size:14px">${esc(item.origin)}</span></div>`
        : '';
    return `<div onclick="openArchivalModal('${escJs(item.id)}')" style="cursor:pointer;position:relative;border:1px solid var(--border);border-radius:12px;padding:14px;background:var(--card-bg,var(--bg))">
        ${privateBadge}
        ${img}
        <div style="margin-top:8px;font-size:15px;font-weight:700">${esc(item.name)}</div>
        ${descLine}${catLine}${originLine}
    </div>`;
}

function _archRenderCards(items) {
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px">${items.map(_archRenderCard).join('')}</div>`;
}

// --- Table view ---

function _archRenderTableRow(item) {
    const url = archPhotoUrl(item);
    const thumb = url
        ? `<img src="${esc(url)}" loading="lazy" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px;display:block">`
        : `<div style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;font-size:20px;background:var(--bg);border-radius:6px">📦</div>`;
    const sourceLabel = item.secondhand ? item.secondhand.charAt(0).toUpperCase() + item.secondhand.slice(1) : '—';
    return `<tr onclick="openArchivalModal('${escJs(item.id)}')" style="border-top:1px solid var(--border);cursor:pointer">
        <td style="padding:8px 10px">${thumb}</td>
        <td style="padding:8px 10px;font-size:14px"><b>${esc(item.name)}</b>${item.private === 'yes' ? ' 🔒' : ''}</td>
        <td style="padding:8px 10px;font-size:14px">${esc(item.category || '—')}</td>
        <td style="padding:8px 10px;font-size:14px">${esc(item.origin || '—')}</td>
        <td style="padding:8px 10px;font-size:14px">${esc(sourceLabel)}</td>
        <td style="padding:8px 10px;font-size:13px;color:var(--text-muted);white-space:nowrap" title="${esc(item.created_at || '')}">${esc(_archFmtDate(item.created_at) || '—')}</td>
    </tr>`;
}

function _archRenderTable(items) {
    return `<div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead>
                <tr style="text-align:left;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:0.5px">
                    <th style="padding:6px 10px;font-weight:600">Photo</th>
                    <th style="padding:6px 10px;font-weight:600">Name</th>
                    <th style="padding:6px 10px;font-weight:600">Category</th>
                    <th style="padding:6px 10px;font-weight:600">Origin</th>
                    <th style="padding:6px 10px;font-weight:600">Source</th>
                    <th style="padding:6px 10px;font-weight:600">Added</th>
                </tr>
            </thead>
            <tbody>${items.map(_archRenderTableRow).join('')}</tbody>
        </table>
    </div>`;
}

// --- Cloud view — simplified port of CloudView.jsx's shelf-packing (no
// drag-repositioning, no sub-clusters: one box per category, items placed
// row-major inside). Box size ~= calculateMinBoxSize; boxes shelf-packed
// left-to-right/wrapped against the container's live width. ---

function _archCalcBoxSize(n) {
    if (n <= 0) return { w: 2, h: 2 };
    const cols = Math.max(2, Math.ceil(Math.sqrt(n * 1.5)));
    const rows = Math.max(1, Math.ceil(n / cols));
    return { w: cols, h: rows + 1 }; // +1 row reserved for the category header
}

function _archShelfPackBoxes(boxes, maxCols) {
    const sorted = [...boxes].sort((a, b) => b.h - a.h); // tallest first, like shelfPackBoxes()
    let col = 0, row = 0, rowH = 0;
    const placed = [];
    sorted.forEach(box => {
        if (col > 0 && col + box.w > maxCols) {
            row += rowH;
            col = 0;
            rowH = 0;
        }
        placed.push({ ...box, col, row });
        col += box.w;
        rowH = Math.max(rowH, box.h);
    });
    const totalRows = placed.reduce((max, b) => Math.max(max, b.row + b.h), 0);
    return { placed, totalRows };
}

function _archRenderCloudView(items) {
    const container = document.getElementById('arch-cloud-container');
    if (!container || !items.length) return;
    _archBindCloudResize();

    const groups = {};
    items.forEach(item => {
        const cat = (item.category || '').trim() || 'uncategorized';
        (groups[cat] = groups[cat] || []).push(item);
    });
    const catNames = Object.keys(groups).sort((a, b) => {
        if (a === 'uncategorized') return 1;
        if (b === 'uncategorized') return -1;
        return a.localeCompare(b);
    });

    const containerWidth = container.clientWidth || 600;
    const maxCols = Math.max(4, Math.floor(containerWidth / ARCH_CELL_W));

    const boxes = catNames.map(cat => {
        const catItems = groups[cat];
        const size = _archCalcBoxSize(catItems.length);
        return { name: cat, label: cat === 'uncategorized' ? 'Uncategorized' : cat, w: size.w, h: size.h, items: catItems };
    });

    const { placed, totalRows } = _archShelfPackBoxes(boxes, maxCols);
    container.style.height = `${totalRows * ARCH_CELL_H + 12}px`;

    let html = '';
    placed.forEach(box => {
        const x = box.col * ARCH_CELL_W;
        const y = box.row * ARCH_CELL_H;
        const boxPxW = box.w * ARCH_CELL_W;
        const boxPxH = box.h * ARCH_CELL_H;
        const availableCols = box.w;

        let thumbsHTML = '';
        box.items.forEach((item, idx) => {
            const r = Math.floor(idx / availableCols) + 1; // +1 to skip the header row
            const c = idx % availableCols;
            const tx = c * ARCH_CELL_W;
            const ty = r * ARCH_CELL_H;
            const url = archPhotoUrl(item);
            const inner = url
                ? `<img src="${esc(url)}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:6px;display:block">`
                : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:20px;background:var(--bg);border-radius:6px">📦</div>`;
            thumbsHTML += `<div onclick="openArchivalModal('${escJs(item.id)}')" title="${esc(item.name)}"
                style="position:absolute;left:${tx}px;top:${ty}px;width:${ARCH_THUMB_W}px;height:${ARCH_THUMB_H}px;cursor:pointer;border:1px solid var(--border);border-radius:6px;overflow:hidden">${inner}</div>`;
        });

        html += `<div style="position:absolute;left:${x}px;top:${y}px;width:${boxPxW}px;height:${boxPxH}px;border:1px solid var(--border);border-radius:10px;background:var(--card-bg,var(--bg))">
            <div style="position:absolute;top:6px;left:8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-secondary)">${esc(box.label)} <span style="opacity:0.6;font-weight:400">(${box.items.length})</span></div>
            ${thumbsHTML}
        </div>`;
    });

    container.innerHTML = html;
}

// --- main render ---

function renderArchivals() {
    const el = document.getElementById('archivals-area');
    if (!el) return;
    const items = D.archivals;
    if (!Array.isArray(items)) { el.innerHTML = ''; return; }  // frosted/public

    const filtered = _archGetFilteredItems(items, null);
    const sorted = _archSortItems(filtered);

    const activeFilterCount = _archFilters.categories.length + _archFilters.subcategories.length +
        _archFilters.sources.length + (_archFilters.gifted !== null ? 1 : 0) + _archFilters.materials.length;

    const allCategories = [...new Set(items.map(i => (i.category || '').trim()).filter(Boolean))].sort();
    const allMaterials = [...new Set(items.flatMap(i => (i.materials || []).map(m => m.material).filter(Boolean)))].sort();

    const filterPanelHTML = _archShowFilters ? _archRenderFilterPanel(items, allCategories, allMaterials) : '';

    let viewHTML;
    if (!sorted.length) {
        viewHTML = `<div style="font-size:14px;color:var(--text-muted);padding:10px 0">${_archEmptyMessage(items.length)}</div>`;
    } else if (_archViewMode === 'table') {
        viewHTML = _archRenderTable(sorted);
    } else if (_archViewMode === 'cloud') {
        viewHTML = `<div id="arch-cloud-container" style="position:relative;width:100%"></div>`;
    } else {
        viewHTML = _archRenderCards(sorted);
    }

    const filtersBtnActive = _archShowFilters || activeFilterCount > 0;

    el.innerHTML = `<details open class="card-section" style="margin-top:20px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Archivals${items.length ? ` (${items.length})` : ''}</summary>
        <div class="card" style="border-left-color:var(--purple,#8e6bbf);margin-top:8px;padding:12px">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Things you own — clothes, jewelry, sentimental. Where they came from and the stories attached.</div>

            <div style="display:flex;gap:8px;margin-bottom:10px">
                <input type="text" id="arch-filter" value="${esc(_archFilter)}" placeholder="Search things..."
                    oninput="_archFilter=this.value;renderArchivals();(function(){const f=document.getElementById('arch-filter');if(f){f.focus();f.setSelectionRange(f.value.length,f.value.length);}})()"
                    style="flex:1;min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
                <button onclick="openArchivalModal(null)" style="min-height:40px;padding:7px 16px;border:none;border-radius:8px;background:var(--text);color:#fff;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap">+ Add</button>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:${_archShowFilters ? '10px' : '12px'}">
                <div style="display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden">${_archViewButtons()}</div>
                <select id="arch-sort" onmousedown="this.value=''" onchange="_archSortChanged(this)"
                    style="min-height:40px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg)">
                    <option value="newest" ${_archSort === 'newest' ? 'selected' : ''}>Newest</option>
                    <option value="oldest" ${_archSort === 'oldest' ? 'selected' : ''}>Oldest</option>
                    <option value="az" ${_archSort === 'az' ? 'selected' : ''}>A–Z</option>
                    <option value="random" ${_archSort === 'random' ? 'selected' : ''}>Random</option>
                </select>
                <button onclick="_archToggleFilters()" style="min-height:40px;padding:7px 14px;border:1px solid ${filtersBtnActive ? 'var(--text)' : 'var(--border)'};border-radius:8px;background:${_archShowFilters ? 'var(--text)' : 'none'};color:${_archShowFilters ? '#fff' : 'var(--text)'};font-size:14px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px">
                    Filters
                    ${activeFilterCount ? `<span style="background:${_archShowFilters ? 'rgba(255,255,255,0.3)' : 'var(--text)'};color:#fff;border-radius:10px;padding:1px 7px;font-size:12px">${activeFilterCount}</span>` : ''}
                </button>
                ${activeFilterCount ? `<button onclick="_archClearFilters()" style="min-height:40px;padding:7px 10px;border:none;background:none;color:var(--red);font-size:13px;font-weight:600;cursor:pointer;text-decoration:underline">Clear filters</button>` : ''}
            </div>

            ${filterPanelHTML}
            ${viewHTML}
        </div>
    </details>`;

    if (_archViewMode === 'cloud' && sorted.length) {
        _archRenderCloudView(sorted);
    }
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

        ${!isNew && (it.created_at || it.last_edited) ? `<div style="font-size:12px;color:var(--text-muted);margin-top:14px">
            ${it.created_at ? `Added ${esc(_archFmtDate(it.created_at, true))}` : ''}${it.created_at && it.last_edited ? ' · ' : ''}${it.last_edited ? `Edited ${esc(_archFmtDate(it.last_edited, true))}` : ''}
        </div>` : ''}
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
