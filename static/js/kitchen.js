// kitchen.js — kitchen list with catalog chips, autocomplete, check/clear

let _kitchenSearch = '';        // (legacy, no longer used in render — kept for safety)
let _kitchenChipFilter = '';    // live filter for My Foods chips (typed in any input bar)
let _addToListOpen = false;     // preserve the "Add to List" section open state across re-renders
let _kitchenCatModalCallback = null;
let _receiptPromptDismissed = false;  // resets when items get added (new trip)
let _parsedReceipts = [];             // unimported parsed receipts
let _parsedReceiptsFetched = false;   // first fetch flag
let _activeReceiptImport = null;      // { filename, header, rows }
let _parsedRecipes = [];              // pending parsed recipes awaiting review
let _parsedRecipesFetched = false;    // first-fetch flag (mirrors receipts)
let _activeRecipeImport = null;       // { filename, recipe } during approval modal

// Make 'household' a selectable category in dropdowns. Frontend-only — the
// server stores arbitrary category strings, so items tagged 'household' persist
// without any backend change.
function _ensureHousehold(order, labels) {
    if (order && !order.includes('household')) order.push('household');
    if (labels && !labels.household) labels.household = 'Household';
}

function renderGroceryQuick() {
    var el = document.getElementById('kitchen-quick');
    if (el) el.innerHTML = '';
}

function renderGroceryList() {
    const el = document.getElementById('kitchen-list-area');
    const tabEl = document.getElementById('kitchen-tab-area');
    if (el) el.innerHTML = '';
    if (!tabEl) return;
    renderGroceryInto(tabEl);
}

function renderGroceryInto(el) {
    if (!el) return;

    // If a recipe-detail view is active, render that instead of the normal kitchen content
    if (window._kitchenRecipeView) {
        renderRecipeDetailInto(el, window._kitchenRecipeView);
        return;
    }

    // Kick a parsed-receipts refresh once per dashboard load. Re-renders when results arrive.
    if (!_parsedReceiptsFetched) {
        _parsedReceiptsFetched = true;
        fetchParsedReceipts();
    }

    const items = D.kitchen_list || [];
    const known = D.kitchen_known_items || {};
    const counts = D.kitchen_purchase_counts || {};

    const unchecked = items.filter(i => !i.checked);
    const checked = items.filter(i => !!i.checked);
    const onList = new Set(items.map(i => i.name.toLowerCase()));

    // Category config
    const categoryOrder = (D.kitchen_category_order || ['vegetables', 'produce', 'fruit', 'grains', 'drinks', 'snacks', 'dessert', 'other', 'dairy', 'protein', 'pharmacy', 'supplements']).slice();
    const categoryLabels = {
        produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
        protein: 'Protein', dairy: 'Dairy', grains: 'Grains',
        drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert', other: 'Other',
        pharmacy: 'Pharmacy', supplements: 'Supplements'
    };
    _ensureHousehold(categoryOrder, categoryLabels);

    let html = '<div style="margin-bottom:20px">';

    // --- Grocery List (always open, no search — search lives in My Foods below) ---
    const listCount = unchecked.length + checked.length;

    // Post-shop receipt banner: show when ALL items are checked AND not dismissed for this trip
    const allChecked = unchecked.length === 0 && checked.length > 0;
    const showReceiptBanner = allChecked && !_receiptPromptDismissed;
    const receiptBanner = showReceiptBanner
        ? `<div style="background:rgba(58,158,140,0.10);border:1px solid rgba(58,158,140,0.3);border-radius:8px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="font-size:14px;flex:1">Done shopping? Scan your receipt to log this trip.</span>
            <label style="cursor:pointer;padding:6px 14px;border-radius:6px;background:var(--green);color:#fff;font-size:12px;font-weight:600">📷 Scan receipt
                <input type="file" accept="image/*,.heic,.heif,.pdf" style="display:none" onchange="uploadKitchenReceipt(this.files[0])">
            </label>
            <button onclick="dismissReceiptPrompt()" style="font-size:11px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer">Dismiss</button>
        </div>`
        : '';

    html += `<div class="kitchen-section" style="margin-bottom:20px">
        ${receiptBanner}
        ${renderParsedReceiptsBanner()}
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;flex-wrap:wrap">
            <span style="font-size:18px;font-weight:700">Grocery List</span>
            ${listCount ? `<span style="font-size:13px;font-weight:400;color:var(--text-muted)">(${unchecked.length} items)</span>` : ''}
            <label style="cursor:pointer;font-size:11px;color:var(--ongoing);background:none;border:1px solid var(--ongoing);border-radius:6px;padding:2px 8px;margin-left:auto">📷 Scan receipt
                <input type="file" accept="image/*,.heic,.heif,.pdf" style="display:none" onchange="uploadKitchenReceipt(this.files[0])">
            </label>
            <button onclick="openCategoryOrder()" style="font-size:11px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:6px;padding:2px 8px;cursor:pointer">Reorder</button>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            ${unchecked.length ? `<button onclick="checkAllGroceries()" style="font-size:12px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:6px;padding:3px 10px;cursor:pointer">Mark all purchased</button>` : ''}
            ${checked.length ? `<button onclick="clearGroceryChecked()" style="font-size:12px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:6px;padding:3px 10px;cursor:pointer">Clear checked</button>` : ''}
            ${(unchecked.length || checked.length) ? `<button onclick="confirmClearAllGrocery()" style="font-size:12px;color:var(--red);background:none;border:1px solid var(--red);border-radius:6px;padding:3px 10px;cursor:pointer;margin-left:auto">Clear all</button>` : ''}
        </div>`;

    // Active list
    if (unchecked.length || checked.length) {
        html += '<div style="background:var(--card-bg);border-radius:10px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,0.06);margin-bottom:16px">';

        // Aisle-aware grouping. Each "slot" is a label in the rendered list.
        // Items without an aisle are bucketed by category. Items with an aisle
        // are bucketed under "Aisle N" labels, which collectively fall in the
        // category_order position of the "@aisles" sentinel.
        const aislesMap = D.kitchen_aisles || {};
        const aislesIdx = categoryOrder.indexOf('@aisles');
        // groups: slotKey -> { label, sortIdx, aisleNum, items: [] }
        const groups = {};
        unchecked.forEach(item => {
            const cat = (item.category || 'other').toLowerCase();
            const aisle = aislesMap[item.name.toLowerCase()];
            if (aisle != null && aislesIdx >= 0) {
                const key = `@aisle_${aisle}`;
                if (!groups[key]) groups[key] = { label: `Aisle ${aisle}`, sortIdx: aislesIdx, aisleNum: aisle, items: [] };
                groups[key].items.push(item);
            } else {
                const key = `cat_${cat}`;
                if (!groups[key]) {
                    const idx = categoryOrder.indexOf(cat);
                    groups[key] = { label: categoryLabels[cat] || cat, sortIdx: idx === -1 ? 9999 : idx, aisleNum: 0, items: [] };
                }
                groups[key].items.push(item);
            }
        });
        const orderedGroups = Object.values(groups).sort((a, b) =>
            (a.sortIdx - b.sortIdx) || (a.aisleNum - b.aisleNum) || a.label.localeCompare(b.label)
        );
        orderedGroups.forEach((g, gi) => {
            html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);padding:8px 0 2px;${gi > 0 ? 'border-top:1px solid var(--border);margin-top:4px' : ''}">${esc(g.label)}</div>`;
            g.items.forEach(item => {
                const aisle = aislesMap[item.name.toLowerCase()];
                const aisleBadge = aisle != null
                    ? `<span class="aisle-badge" data-name="${esc(item.name)}" onclick="event.stopPropagation();editGroceryAisle('${esc(item.name)}', this)" title="Tap to change location" style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;background:rgba(124,92,191,0.18);color:var(--accent);cursor:pointer;margin-right:6px">A${aisle}</span>`
                    : `<span class="aisle-badge" data-name="${esc(item.name)}" onclick="event.stopPropagation();editGroceryAisle('${esc(item.name)}', this)" title="Tap to set location (section or aisle #)" style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:transparent;color:var(--text-muted);border:1px dashed var(--border);cursor:pointer;margin-right:6px;opacity:0.55">📍</span>`;
                const noteText = (item.note || '').trim();
                const inlineNote = noteText
                    ? ` <span onclick="event.stopPropagation();editGroceryNote('${esc(item.name)}')" style="font-size:12px;color:var(--text-muted);cursor:pointer" title="Tap to edit note">— ${esc(noteText)}</span>`
                    : '';
                const addNoteBtn = noteText
                    ? ''
                    : `<button onclick="editGroceryNote('${esc(item.name)}')" title="Add a note" style="background:none;border:none;color:var(--text-muted);opacity:0.4;font-size:11px;cursor:pointer;margin-left:6px">+ note</button>`;
                const safety = (D.kitchen_safety_tags || {})[item.name.toLowerCase()] || '';
                const safetyIcon = safety === 'safe'
                    ? `<span style="color:var(--green);font-size:14px;line-height:1" title="Confirmed safe">&#10003;</span>`
                    : safety === 'suspect'
                        ? `<span style="color:var(--orange);font-size:14px;line-height:1" title="Suspect">&#9888;</span>`
                        : `<span style="color:var(--text-muted);opacity:0.35;font-size:14px;line-height:1" title="Tap to tag safe/suspect">&#9675;</span>`;
                const safetyBtn = `<button onclick="cycleGrocerySafety('${esc(item.name)}')" style="background:none;border:none;cursor:pointer;padding:0 6px" title="Tap to cycle: untagged → safe → suspect">${safetyIcon}</button>`;
                html += `<div class="card-item">
                    <span class="habit-check" onclick="toggleGrocery('${esc(item.name)}')" style="cursor:pointer">&#9675;</span>
                    <span class="item-text">${esc(item.name)}${inlineNote}</span>
                    ${addNoteBtn}
                    ${aisleBadge}
                    ${safetyBtn}
                    <button class="delete-btn" onclick="removeGrocery('${esc(item.name)}')" title="Remove">&times;</button>
                </div>`;
            });
        });

        // Checked items
        if (checked.length) {
            html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);padding:8px 0 2px;border-top:1px solid var(--border);margin-top:4px">Got it</div>`;
            checked.forEach(item => {
                const noteText = (item.note || '').trim();
                const inlineNote = noteText
                    ? ` <span style="font-size:12px;color:var(--text-muted);text-decoration:line-through">— ${esc(noteText)}</span>`
                    : '';
                html += `<div class="card-item" style="opacity:0.4">
                    <span class="habit-check done" onclick="toggleGrocery('${esc(item.name)}')" style="cursor:pointer">&#10003;</span>
                    <span class="item-text" style="text-decoration:line-through">${esc(item.name)}${inlineNote}</span>
                    <button class="delete-btn" onclick="removeGrocery('${esc(item.name)}')" title="Remove">&times;</button>
                </div>`;
            });
        }

        html += '</div>';
    } else {
        html += '<div class="empty-state">Nothing on the list — add an item below</div>';
    }
    html += '</div>';

    // --- My Foods (search/filter chips + add new) ---
    const rawFilter = _kitchenChipFilter || '';                    // what the user typed (preserved for the input value)
    const chipFilter = rawFilter.toLowerCase().trim();             // normalized for matching
    function renderMyFoodsBar(suffix) {
        return `<div style="display:flex;gap:6px;margin:8px 0">
            <input type="text" id="kitchen-input-${suffix}" value="${esc(rawFilter)}" placeholder="Search or add new item..."
                style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text)"
                oninput="kitchenChipFilterInput(this.value,'${suffix}')" onkeydown="kitchenMyFoodsKeydown(event,'${suffix}')" autocomplete="off">
            ${chipFilter ? `<button onclick="addGrocery('${suffix}')" style="padding:8px 14px;border:none;border-radius:6px;background:var(--text);color:var(--bg);font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">+ Add</button>` : ''}
            ${chipFilter ? `<button onclick="kitchenChipFilterClear()" title="Clear" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text-muted);font-size:13px;cursor:pointer">&times;</button>` : ''}
        </div>`;
    }

    // My Foods sort mode (persisted). One-time migration: clear an old 'frequency'
    // default so users land on the new A–Z default without having to click it.
    if (!localStorage.getItem('kitchen_sort_default_v2')) {
        if (localStorage.getItem('kitchen_my_foods_sort') === 'frequency') {
            localStorage.removeItem('kitchen_my_foods_sort');
        }
        localStorage.setItem('kitchen_sort_default_v2', '1');
    }
    const sortMode = localStorage.getItem('kitchen_my_foods_sort') || 'alpha';
    const sortBtn = (mode, label) => {
        const active = mode === sortMode;
        return `<button onclick="setMyFoodsSort('${mode}')" style="padding:3px 9px;border-radius:6px;border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};background:${active ? 'rgba(124,92,191,0.12)' : 'none'};color:${active ? 'var(--accent)' : 'var(--text-muted)'};font-size:11px;font-weight:${active ? '700' : '500'};cursor:pointer">${esc(label)}</button>`;
    };

    html += `<details class="kitchen-section" data-section="add-to-list"${_addToListOpen ? ' open' : ''}>
        <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:12px;transition:transform 0.15s;display:inline-block" class="kitchen-arrow">&#9654;</span>
            <span>Add to List</span>
            <span style="display:inline-flex;gap:4px;margin-left:auto;font-weight:400" onclick="event.stopPropagation()">
                ${sortBtn('alpha', 'A–Z')}
                ${sortBtn('frequency', 'Freq')}
                ${sortBtn('both', 'Both')}
            </span>
        </summary>`;

    html += renderMyFoodsBar('top');

    // Catalog — known items as tappable chips.
    // Sort priority when filtering: name-prefix-match → word-prefix → substring; then by count desc, then alpha.
    // When no filter: sort by count desc, then alpha (legacy behavior).
    function _prefixRank(name, q) {
        if (!q) return 0;
        const n = name.toLowerCase();
        if (n.startsWith(q)) return 0;
        if (n.split(/[\s-]+/).some(w => w.startsWith(q))) return 1;
        if (n.includes(q)) return 2;
        return 3;  // shouldn't happen since we filter on substring; safety
    }
    const matchesFilter = (name) => !chipFilter || name.toLowerCase().includes(chipFilter);
    const catalogItems = Object.entries(known)
        .map(([name, cat]) => ({ name, cat, count: counts[name] || 0 }))
        .filter(i => i.cat !== 'household')   // household items live in "Other grocery items" section below
        .filter(i => matchesFilter(i.name))
        .sort((a, b) => {
            if (chipFilter) {
                const r = _prefixRank(a.name, chipFilter) - _prefixRank(b.name, chipFilter);
                if (r !== 0) return r;
            }
            if (b.count !== a.count) return b.count - a.count;
            return a.name.localeCompare(b.name);
        });

    if (catalogItems.length) {
        html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <div style="font-size:14px;font-weight:700">${chipFilter ? `Matches for "${esc(chipFilter)}"` : 'Quick add from favorites'}</div>
            <button onclick="openCatalogEditor()" style="font-size:11px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:6px;padding:3px 10px;cursor:pointer">Edit</button>
        </div>`;

        if (sortMode === 'alpha') {
            // Flat alphabetical — no Most bought, no category subgroups
            const alphaItems = catalogItems.slice().sort((a, b) => a.name.localeCompare(b.name));
            html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">';
            alphaItems.forEach(item => { html += renderCatalogChip(item, onList); });
            html += '</div>';
        } else if (sortMode === 'both') {
            // Top-N by frequency, then alphabetical rest
            const TOP_N = 10;
            const byFreq = catalogItems.slice().sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
            const topFreq = byFreq.filter(i => i.count > 0).slice(0, TOP_N);
            const topSet = new Set(topFreq.map(i => i.name));
            const restAlpha = catalogItems.filter(i => !topSet.has(i.name)).sort((a, b) => a.name.localeCompare(b.name));
            if (topFreq.length) {
                html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px">Most bought</div>';
                html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">';
                topFreq.forEach(item => { html += renderCatalogChip(item, onList); });
                html += '</div>';
            }
            if (restAlpha.length) {
                html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px">Everything else (A–Z)</div>';
                html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px">';
                restAlpha.forEach(item => { html += renderCatalogChip(item, onList); });
                html += '</div>';
            }
        } else {
            // 'frequency' — legacy behavior: Most bought + category subgroups
            const catGroups = {};
            const frequent = catalogItems.filter(i => i.count > 0);
            const rest = catalogItems.filter(i => i.count === 0);

            if (frequent.length) {
                html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px">Most bought</div>';
                html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">';
                frequent.forEach(item => { html += renderCatalogChip(item, onList); });
                html += '</div>';
            }

            rest.forEach(item => {
                if (!catGroups[item.cat]) catGroups[item.cat] = [];
                catGroups[item.cat].push(item);
            });

            const catsWithItems = categoryOrder.filter(c => catGroups[c]);
            Object.keys(catGroups).forEach(c => { if (!catsWithItems.includes(c)) catsWithItems.push(c); });

            if (catsWithItems.length) {
                const allItemsOpen = chipFilter ? ' open' : '';
                html += `<details${allItemsOpen} style="margin-top:4px"><summary style="font-size:12px;font-weight:600;cursor:pointer;color:var(--text-muted)">All items by category</summary><div style="margin-top:8px">`;
                catsWithItems.forEach(cat => {
                    html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin:8px 0 4px">${categoryLabels[cat] || cat}</div>`;
                    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px">';
                    catGroups[cat].forEach(item => { html += renderCatalogChip(item, onList); });
                    html += '</div>';
                });
                html += '</div></details>';
            }
        }

    } else if (chipFilter) {
        html += `<div style="color:var(--text-muted);font-size:13px;font-style:italic;padding:8px 0">No matches for "${esc(chipFilter)}". Tap + Add to create a new item.</div>`;
    }
    html += renderMyFoodsBar('bottom');

    // --- Other grocery items (household) — nested inside My Foods, collapsed ---
    const householdItems = Object.entries(known)
        .filter(([_, cat]) => cat === 'household')
        .map(([name, cat]) => ({ name, cat, count: counts[name] || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));

    html += `<details style="margin-top:10px;padding-top:10px;border-top:1px dashed rgba(124,92,191,0.18)">
        <summary style="font-size:13px;font-weight:600;cursor:pointer;padding:4px 0;list-style:none;display:flex;align-items:center;gap:8px;color:var(--text-muted)">
            <span style="font-size:11px;transition:transform 0.15s;display:inline-block" class="kitchen-arrow">&#9654;</span>
            Other grocery items${householdItems.length ? ` <span style="font-size:11px;font-weight:700;color:var(--accent);background:rgba(124,92,191,0.10);padding:1px 8px;border-radius:10px">${householdItems.length}</span>` : ''}
        </summary>`;
    if (householdItems.length) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">';
        householdItems.forEach(item => { html += renderCatalogChip(item, onList); });
        html += '</div>';
    } else {
        html += '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No household items yet. Open <b>Edit</b> on My Foods and set any item\'s category to <b>Household</b> to move it here.</div>';
    }
    html += '</details>';

    html += '</details>';  // close My Foods

    // --- Recipes (collapsed by default) ---
    if (!_parsedRecipesFetched) {
        _parsedRecipesFetched = true;
        fetchParsedRecipes();
    }
    const recipes = D.recipes || [];
    html += `<details class="kitchen-section">
        <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;transition:transform 0.15s;display:inline-block" class="kitchen-arrow">&#9654;</span>
            Recipes${recipes.length ? ` <span style="font-size:13px;font-weight:400;color:var(--text-muted)">(${recipes.length})</span>` : ''}
        </summary>
        ${renderParsedRecipesBanner()}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">
            <input type="url" id="recipe-url-input" placeholder="Paste recipe URL…" onkeydown="if(event.key==='Enter')submitRecipeUrl()" style="flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            <button onclick="submitRecipeUrl()" style="padding:7px 14px;border:none;border-radius:6px;background:var(--ongoing);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Parse URL</button>
            <label style="cursor:pointer;font-size:12px;color:var(--accent);background:none;border:1px solid var(--accent);border-radius:6px;padding:6px 12px;display:inline-flex;align-items:center">📷 Image
                <input type="file" accept="image/*,.heic,.heif,.pdf" style="display:none" onchange="uploadRecipeImage(this.files[0])">
            </label>
        </div>
        <div id="recipe-parse-status" style="font-size:12px;color:var(--text-muted);min-height:18px;margin-bottom:10px"></div>
        ${renderRecipeCards(recipes)}
    </details>`;

    // --- Meal Notes (moved above purchase history per UX feedback) ---
    const mealNotes = D.meal_notes || [];

    html += `<details class="kitchen-section">
        <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;transition:transform 0.15s;display:inline-block" class="kitchen-arrow">&#9654;</span>
            Meal Notes${mealNotes.length ? ` <span style="font-size:13px;font-weight:400;color:var(--text-muted)">(${mealNotes.length})</span>` : ''}
        </summary>
        <div style="display:flex;gap:8px;margin-bottom:12px">
            <textarea id="meal-note-input" placeholder="Meal idea, recipe note, what you liked/disliked..."
                style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg);color:var(--text);font-family:inherit;resize:vertical;min-height:60px"
                onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addMealNote()}"></textarea>
            <button onclick="addMealNote()" style="padding:8px 16px;border:none;border-radius:8px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer;align-self:flex-end">Save</button>
        </div>`;

    // Show last 3, rest collapsed
    const showNotes = mealNotes.slice(0, 3);
    const moreNotes = mealNotes.slice(3);

    if (showNotes.length) {
        showNotes.forEach((note, i) => {
            const d = new Date(note.date + 'T12:00:00');
            const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            html += `<div style="background:var(--card-bg);border-radius:8px;padding:12px 16px;margin-bottom:8px;border-left:3px solid var(--accent)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                    <span style="font-size:11px;color:var(--text-muted)">${dateLabel}</span>
                    <button onclick="deleteMealNote(${i})" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;opacity:0.5" title="Delete">&times;</button>
                </div>
                <div style="font-size:14px;color:var(--text);white-space:pre-wrap;line-height:1.5">${esc(note.text)}</div>
            </div>`;
        });
    }

    if (moreNotes.length) {
        html += `<details><summary style="font-size:12px;font-weight:600;cursor:pointer;color:var(--text-muted)">${moreNotes.length} older notes</summary><div style="margin-top:8px">`;
        moreNotes.forEach((note, i) => {
            const d = new Date(note.date + 'T12:00:00');
            const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            html += `<div style="background:var(--card-bg);border-radius:8px;padding:12px 16px;margin-bottom:8px;border-left:3px solid var(--border)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                    <span style="font-size:11px;color:var(--text-muted)">${dateLabel}</span>
                    <button onclick="deleteMealNote(${i + 3})" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;opacity:0.5" title="Delete">&times;</button>
                </div>
                <div style="font-size:14px;color:var(--text);white-space:pre-wrap;line-height:1.5">${esc(note.text)}</div>
            </div>`;
        });
        html += '</div></details>';
    }

    if (!mealNotes.length) {
        html += '<div style="color:var(--text-muted);font-size:13px">Jot down meal ideas, recipe notes, or what you liked about a meal.</div>';
    }

    html += '</details>';

    // --- Purchase History (sortable spreadsheet, replaces Pantry) ---
    html += _renderPurchaseHistorySection(known, counts);

    // --- Grocery Spend (collapsible, closed by default) ---
    const spendHtml = renderSpendTrendCard();
    if (spendHtml) {
        html += `<details class="kitchen-section">
            <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
                <span style="font-size:12px;transition:transform 0.15s;display:inline-block" class="kitchen-arrow">&#9654;</span>
                Grocery Spend
            </summary>
            <div style="padding-top:10px">${spendHtml}</div>
        </details>`;
    }

    // (The standalone "This Week's Meal" widget was removed — its role is now
    // handled by per-recipe choice groups in the Recipes section above.)

    html += '</div>';
    el.innerHTML = html;

    // Rotate arrows on open/close
    el.querySelectorAll('details.kitchen-section').forEach(d => {
        const arrow = d.querySelector('.kitchen-arrow');
        if (arrow) arrow.style.transform = d.open ? 'rotate(90deg)' : 'rotate(0deg)';
        d.addEventListener('toggle', () => {
            if (arrow) arrow.style.transform = d.open ? 'rotate(90deg)' : 'rotate(0deg)';
            if (d.dataset.section === 'add-to-list') _addToListOpen = d.open;
        });
    });
}

async function addMealNote() {
    const input = document.getElementById('meal-note-input');
    const text = input.value.trim();
    if (!text) return;
    await fetch('/api/kitchen/meal-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });
    input.value = '';
    loadDashboard();
}

function deleteMealNote(index) {
    const notes = (D.meal_notes || []);
    const note = notes[index];
    const preview = note ? (note.text || '').slice(0, 60) + ((note.text || '').length > 60 ? '…' : '') : 'this note';
    pendingDelete = { item: index, type: 'meal-note' };
    document.getElementById('modal-text').innerHTML = `Remove this meal note?<br><span style="font-size:12px;color:var(--text-muted);font-weight:400;font-style:italic">"${esc(preview)}"</span>`;
    document.getElementById('modal').classList.add('open');
}

async function pantryNeedItem(name) {
    await fetch('/api/kitchen/pantry/need', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.charAt(0).toUpperCase() + name.slice(1) })
    });
    loadDashboard();
}

// Batch selection for catalog chips
let _kitchenPending = new Map();      // name -> {category, btn} — items pending ADD
let _kitchenPendingRemove = new Set(); // names pending REMOVE (active chips tapped)
let _catalogEditMode = false;

function renderCatalogChip(item, onList) {
    const active = onList.has(item.name);
    const label = item.name.charAt(0).toUpperCase() + item.name.slice(1);
    const notes = D.kitchen_item_notes || {};
    const hasNote = !!notes[item.name];
    const dot = hasNote ? '<span style="width:5px;height:5px;border-radius:50%;background:var(--orange);display:inline-block;margin-left:2px;vertical-align:top"></span>' : '';

    if (active) {
        const pendingRemove = _kitchenPendingRemove.has(item.name);
        const style = pendingRemove
            ? 'padding:6px 12px;border-radius:16px;border:1px solid #d65b9a;font-size:13px;background:rgba(232,91,154,0.22);color:#a82a64;cursor:pointer;transition:all 0.12s;'
            : 'padding:6px 12px;border-radius:16px;border:1px solid rgba(124,92,191,0.3);font-size:13px;background:rgba(124,92,191,0.2);color:var(--accent);opacity:0.85;cursor:pointer;transition:all 0.12s;';
        const prefix = pendingRemove ? '✕ ' : '✓ ';
        const tip = pendingRemove ? 'Tap again to undo removal' : 'On list — tap to mark for removal';
        return `<button onclick="toggleCatalogItem('${esc(item.name)}','${esc(item.cat)}',this)"
            oncontextmenu="event.preventDefault();openItemNote('${esc(item.name)}')" ontouchstart="startLongPress('${esc(item.name)}',event)" ontouchend="cancelLongPress()" ontouchmove="cancelLongPress()"
            style="${style}"
            title="${tip}">${prefix}${esc(label)}${dot}</button>`;
    }

    return `<button onclick="toggleCatalogItem('${esc(item.name)}','${esc(item.cat)}',this)"
        oncontextmenu="event.preventDefault();openItemNote('${esc(item.name)}')" ontouchstart="startLongPress('${esc(item.name)}',event)" ontouchend="cancelLongPress()" ontouchmove="cancelLongPress()"
        style="padding:6px 12px;border-radius:16px;border:1px solid;font-size:13px;cursor:pointer;background:var(--card-bg);color:var(--text-secondary);border-color:var(--border);transition:all 0.12s"
        title="${item.count ? item.count + ' times' : ''}">${esc(label)}${dot}</button>`;
}

// --- Long-press for item notes ---
let _longPressTimer = null;
function startLongPress(name, e) {
    _longPressTimer = setTimeout(() => {
        _longPressTimer = null;
        openItemNote(name);
    }, 500);
}
function cancelLongPress() {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
}

function openItemNote(name) {
    const notes = D.kitchen_item_notes || {};
    const note = notes[name] || '';
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    const known = D.kitchen_known_items || {};
    const cat = known[name] || 'other';

    let overlay = document.getElementById('item-note-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'item-note-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) closeItemNote(); };

    overlay.innerHTML = `<div style="background:var(--card-bg);border-radius:12px;padding:20px;max-width:400px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,0.3)">
        <div style="font-size:16px;font-weight:700;margin-bottom:12px;color:var(--text)">${esc(label)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Category: ${esc(cat)}</div>
        <textarea id="item-note-text" placeholder="Notes — reactions, inflammation, where to buy, etc."
            style="width:100%;min-height:100px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg);color:var(--text);resize:vertical;font-family:inherit;line-height:1.5">${esc(note)}</textarea>
        <div style="display:flex;gap:8px;margin-top:12px">
            <button onclick="saveItemNote('${esc(name)}')" style="flex:1;padding:8px;border:none;border-radius:8px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Save</button>
            <button onclick="closeItemNote()" style="flex:1;padding:8px;border:none;border-radius:8px;background:var(--border);color:var(--text-muted);font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
        </div>
    </div>`;
}

async function saveItemNote(name) {
    const text = document.getElementById('item-note-text').value.trim();
    await fetch('/api/kitchen/catalog/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, note: text })
    });
    if (!D.kitchen_item_notes) D.kitchen_item_notes = {};
    if (text) D.kitchen_item_notes[name] = text;
    else delete D.kitchen_item_notes[name];
    closeItemNote();
    // Re-render to show/hide note dots
    const tabEl = document.getElementById('kitchen-tab-area');
    if (tabEl) {
        const detailsOpen = tabEl.querySelector('details')?.open;
        renderGroceryInto(tabEl);
        if (detailsOpen) { const d = tabEl.querySelector('details'); if (d) d.open = true; }
    }
}

function closeItemNote() {
    const overlay = document.getElementById('item-note-overlay');
    if (overlay) overlay.style.display = 'none';
}

// --- Catalog edit modal ---
function openCatalogEditor() {
    const known = D.kitchen_known_items || {};
    const counts = D.kitchen_purchase_counts || {};
    const notes = D.kitchen_item_notes || {};
    // Use the live category_order (minus the @aisles sentinel) so any user-added category shows up.
    const categoryOrder = (D.kitchen_category_order || ['vegetables', 'produce', 'fruit', 'grains', 'drinks', 'snacks', 'dessert', 'other', 'dairy', 'protein', 'pharmacy', 'supplements']).filter(c => c !== '@aisles');
    const categoryLabels = {
        produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
        protein: 'Protein', dairy: 'Dairy', grains: 'Grains',
        drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert', other: 'Other',
        pharmacy: 'Pharmacy', supplements: 'Supplements'
    };
    _ensureHousehold(categoryOrder, categoryLabels);
    const catOptions = categoryOrder.map(c => `<option value="${c}">${categoryLabels[c] || c}</option>`).join('');

    const items = Object.entries(known).sort((a, b) => a[0].localeCompare(b[0]));

    const safetyTagsLive = D.kitchen_safety_tags || {};
    let rows = items.map(([name, cat]) => {
        const label = name.charAt(0).toUpperCase() + name.slice(1);
        const safety = safetyTagsLive[name] || '';
        const safeActive = safety === 'safe';
        const suspectActive = safety === 'suspect';
        const safeBtn = `<button onclick="catalogToggleSafety('${esc(name)}','safe')" title="Mark safe" style="background:${safeActive ? 'rgba(58,158,140,0.18)' : 'none'};border:1px solid ${safeActive ? 'var(--green)' : 'var(--border)'};border-radius:6px;padding:3px 7px;font-size:12px;color:${safeActive ? 'var(--green)' : 'var(--text-muted)'};cursor:pointer;font-weight:${safeActive ? '700' : '400'}">&#10003;</button>`;
        const suspectBtn = `<button onclick="catalogToggleSafety('${esc(name)}','suspect')" title="Mark suspect" style="background:${suspectActive ? 'rgba(212,140,68,0.18)' : 'none'};border:1px solid ${suspectActive ? 'var(--orange)' : 'var(--border)'};border-radius:6px;padding:3px 7px;font-size:12px;color:${suspectActive ? 'var(--orange)' : 'var(--text-muted)'};cursor:pointer;font-weight:${suspectActive ? '700' : '400'}">&#9888;</button>`;
        return `<div style="display:flex;align-items:center;gap:6px;padding:8px 0;border-bottom:1px solid var(--border)">
            <input type="text" value="${esc(label)}" data-orig="${esc(name)}" class="catalog-rename-input" style="flex:2;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text)"
                onblur="saveCatalogRename(this)"
                onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}">
            <select onchange="updateCatalogCat('${esc(name)}',this.value)" style="flex:1;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--bg);color:var(--text)">
                ${categoryOrder.map(c => `<option value="${c}" ${c === cat ? 'selected' : ''}>${categoryLabels[c] || c}</option>`).join('')}
            </select>
            ${safeBtn}${suspectBtn}
            <button onclick="removeCatalogItem('${esc(name)}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;line-height:1" title="Delete">&times;</button>
        </div>`;
    }).join('');

    let overlay = document.getElementById('catalog-edit-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'catalog-edit-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) closeCatalogEditor(); };

    overlay.innerHTML = `<div style="background:var(--card-bg);border-radius:12px;padding:20px;max-width:500px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,0.3)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:16px;font-weight:700;color:var(--text)">Edit Catalog</div>
            <button onclick="closeCatalogEditor()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div style="margin-bottom:12px"><button onclick="openCategoriesEditor()" style="font-size:11px;color:var(--accent);background:none;border:1px solid rgba(124,92,191,0.4);border-radius:6px;padding:3px 10px;cursor:pointer">⚙ Manage categories</button></div>
        <div style="flex:1;overflow-y:auto;min-height:0;padding-right:20px">
            ${rows}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
            <input type="text" id="catalog-new-name" placeholder="New item..." style="flex:2;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text)" onkeydown="if(event.key==='Enter')addCatalogItem()">
            <select id="catalog-new-cat" style="flex:1;padding:6px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--bg);color:var(--text)">${catOptions}</select>
            <button onclick="addCatalogItem()" style="padding:6px 14px;border:none;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Add</button>
        </div>
    </div>`;
}

// --- Categories editor (rename/delete categories themselves) ---
function openCategoriesEditor() {
    const order = (D.kitchen_category_order || []).slice();
    const known = D.kitchen_known_items || {};
    const itemsByCat = {};
    Object.entries(known).forEach(([n, c]) => {
        if (!itemsByCat[c]) itemsByCat[c] = [];
        itemsByCat[c].push(n);
    });

    let overlay = document.getElementById('categories-edit-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'categories-edit-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(20,20,30,0.45);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) closeCategoriesEditor(); };

    const rows = order.map(cat => {
        if (cat === '@aisles') {
            return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);background:rgba(124,92,191,0.08)">
                <span style="flex:1;font-size:13px;font-style:italic;color:var(--text-muted)">Aisles (1, 2, 3…) <span style="font-size:10px">— sentinel, can't edit</span></span>
            </div>`;
        }
        const count = (itemsByCat[cat] || []).length;
        return `<div style="display:flex;align-items:center;gap:6px;padding:8px 0;border-bottom:1px solid var(--border)">
            <input type="text" value="${esc(cat)}" data-cat="${esc(cat)}" class="cat-rename-input" style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text)">
            <span style="font-size:11px;color:var(--text-muted);min-width:50px;text-align:right">${count} item${count === 1 ? '' : 's'}</span>
            <button onclick="renameCategoryFromEditor('${esc(cat)}', this)" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;color:var(--text-muted)" title="Save rename">✓</button>
            <button onclick="deleteCategoryFromEditor('${esc(cat)}', ${count})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;line-height:1" title="Delete category">&times;</button>
        </div>`;
    }).join('');

    overlay.innerHTML = `<div style="background:var(--card-bg);border-radius:12px;padding:20px;max-width:480px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.4);border:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:16px;font-weight:700;color:var(--text)">Manage Categories</div>
            <button onclick="closeCategoriesEditor()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Edit name in the field then ✓ to rename. × deletes (items reassign to "other"). Use Reorder for ordering.</div>
        <div style="flex:1;overflow-y:auto;min-height:0">${rows}</div>
        <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
            <input type="text" id="cat-add-name" placeholder="New category…" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text)" onkeydown="if(event.key==='Enter')addCategoryFromEditor()">
            <button onclick="addCategoryFromEditor()" style="padding:6px 14px;border:none;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Add</button>
        </div>
    </div>`;
}

function closeCategoriesEditor() {
    const overlay = document.getElementById('categories-edit-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function renameCategoryFromEditor(oldName, btn) {
    const input = btn.parentElement.querySelector('.cat-rename-input');
    const newName = (input.value || '').trim().toLowerCase();
    if (!newName || newName === oldName.toLowerCase()) { input.value = oldName; return; }
    try {
        const res = await fetch('/api/kitchen/category/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old: oldName, new: newName })
        });
        const data = await res.json();
        if (data.error) { alert(data.error); input.value = oldName; return; }
    } catch (e) {
        alert('Rename failed: ' + e.message);
        input.value = oldName;
        return;
    }
    await loadDashboard();
    openCategoriesEditor();  // re-render
}

async function deleteCategoryFromEditor(name, count) {
    const reassign = count > 0
        ? (prompt(`Delete "${name}" — ${count} item${count === 1 ? '' : 's'} will move to which category?`, 'other') || '').trim().toLowerCase()
        : 'other';
    if (count > 0 && !reassign) return;
    if (!confirm(`Delete category "${name}"?`)) return;
    try {
        const res = await fetch('/api/kitchen/category/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, reassign_to: reassign })
        });
        const data = await res.json();
        if (data.error) { alert(data.error); return; }
    } catch (e) {
        alert('Delete failed: ' + e.message);
        return;
    }
    await loadDashboard();
    openCategoriesEditor();
}

async function addCategoryFromEditor() {
    const input = document.getElementById('cat-add-name');
    const name = (input.value || '').trim().toLowerCase();
    if (!name) return;
    if (name === '@aisles') { alert('@aisles is reserved'); return; }
    const order = (D.kitchen_category_order || []).slice();
    if (!order.includes(name)) {
        const aislesAt = order.indexOf('@aisles');
        if (aislesAt >= 0) order.splice(aislesAt, 0, name);
        else order.push(name);
        try {
            await fetch('/api/kitchen/category-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order })
            });
            D.kitchen_category_order = order;
        } catch (e) {
            alert('Failed to add: ' + e.message);
            return;
        }
    }
    input.value = '';
    await loadDashboard();
    openCategoriesEditor();
}

function closeCatalogEditor() {
    const overlay = document.getElementById('catalog-edit-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function addCatalogItem() {
    const nameEl = document.getElementById('catalog-new-name');
    const catEl = document.getElementById('catalog-new-cat');
    const name = nameEl.value.trim();
    if (!name) return;
    await fetch('/api/kitchen/catalog/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, category: catEl.value })
    });
    nameEl.value = '';
    await loadDashboard();
    openCatalogEditor(); // refresh the modal
}

function renameCatalogItem(oldName) {
    const newName = prompt('Rename item:', oldName.charAt(0).toUpperCase() + oldName.slice(1));
    if (!newName || newName.trim().toLowerCase() === oldName) return;
    fetch('/api/kitchen/catalog/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_name: oldName, new_name: newName.trim() })
    }).then(() => loadDashboard().then(() => openCatalogEditor()));
}

async function saveCatalogRename(input) {
    const oldName = input.dataset.orig;
    const newName = (input.value || '').trim();
    if (!newName) { input.value = oldName.charAt(0).toUpperCase() + oldName.slice(1); return; }
    if (newName.toLowerCase() === oldName.toLowerCase()) return;
    try {
        const res = await fetch('/api/kitchen/catalog/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old_name: oldName, new_name: newName })
        });
        const data = await res.json();
        if (data.error) { alert(data.error); return; }
    } catch (e) {
        alert('Rename failed: ' + e.message);
        return;
    }
    await loadDashboard();
    openCatalogEditor();
}

function removeCatalogItem(name) {
    confirmDelete(name, 'catalog-item');
}

async function cycleGrocerySafety(name) {
    const tags = D.kitchen_safety_tags || {};
    const current = tags[name.toLowerCase()] || '';
    const next = current === '' ? 'safe' : current === 'safe' ? 'suspect' : '';
    await fetch('/api/kitchen/safety-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tag: next })
    });
    // Update local cache so the row re-renders correctly
    D.kitchen_safety_tags = D.kitchen_safety_tags || {};
    if (next) D.kitchen_safety_tags[name.toLowerCase()] = next;
    else delete D.kitchen_safety_tags[name.toLowerCase()];
    loadDashboard();
}

async function catalogToggleSafety(name, tag) {
    // Cycle: tap the same tag again to clear it; otherwise set the new tag
    const current = (D.kitchen_safety_tags || {})[name] || '';
    const next = current === tag ? '' : tag;
    await fetch('/api/kitchen/safety-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tag: next })
    });
    // Update local cache so the editor reflects immediately on re-render
    D.kitchen_safety_tags = D.kitchen_safety_tags || {};
    if (next) D.kitchen_safety_tags[name] = next;
    else delete D.kitchen_safety_tags[name];
    openCatalogEditor();
}

async function updateCatalogCat(name, category) {
    await fetch('/api/kitchen/catalog/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, category })
    });
}

function toggleCatalogItem(name, category, btn) {
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    const onList = (D.kitchen_list || []).some(i => i.name.toLowerCase() === name.toLowerCase());

    if (onList) {
        // Toggle pending-remove state — pink chip means "will be removed on commit"
        if (_kitchenPendingRemove.has(name)) {
            _kitchenPendingRemove.delete(name);
            btn.style.background = 'rgba(124,92,191,0.2)';
            btn.style.color = 'var(--accent)';
            btn.style.borderColor = 'rgba(124,92,191,0.3)';
            btn.style.opacity = '0.85';
            btn.textContent = '✓ ' + label;
            btn.title = 'On list — tap to mark for removal';
        } else {
            _kitchenPendingRemove.add(name);
            btn.style.background = 'rgba(232,91,154,0.22)';
            btn.style.color = '#a82a64';
            btn.style.borderColor = '#d65b9a';
            btn.style.opacity = '1';
            btn.textContent = '✕ ' + label;
            btn.title = 'Tap again to undo removal';
        }
        updateGroceryBatchBar();
        return;
    }

    if (_kitchenPending.has(name)) {
        _kitchenPending.delete(name);
        btn.style.background = 'var(--card-bg)';
        btn.style.color = 'var(--text-secondary)';
        btn.style.borderColor = 'var(--border)';
        btn.textContent = label;
    } else {
        _kitchenPending.set(name, { category, btn });
        btn.style.background = 'var(--accent)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'var(--accent)';
        btn.textContent = '✓ ' + label;
    }
    updateGroceryBatchBar();
}

function updateGroceryBatchBar() {
    let barTop = document.getElementById('kitchen-batch-bar-top');
    let barBottom = document.getElementById('kitchen-batch-bar-bottom');
    const barHTML = () => {
        const addCount = _kitchenPending.size;
        const removeCount = _kitchenPendingRemove.size;
        let label = '';
        let btnLabel = '';
        if (addCount && removeCount) {
            label = `Add ${addCount} · Remove ${removeCount}`;
            btnLabel = 'Add and remove items';
        } else if (addCount) {
            label = `${addCount} item${addCount > 1 ? 's' : ''} selected`;
            btnLabel = 'Add items';
        } else {
            label = `${removeCount} item${removeCount > 1 ? 's' : ''} to remove`;
            btnLabel = 'Remove items';
        }
        return `<span>${label}</span>
            <div style="display:flex;gap:8px">
                <button onclick="commitGroceryBatch()" style="padding:6px 14px;border:none;border-radius:6px;background:#fff;color:var(--accent);font-size:13px;font-weight:700;cursor:pointer">${btnLabel}</button>
                <button onclick="cancelGroceryBatch()" style="padding:6px 14px;border:none;border-radius:6px;background:rgba(255,255,255,0.2);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
            </div>`;
    };
    const barStyle = 'background:var(--accent);color:#fff;padding:10px 16px;border-radius:8px;display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:14px;flex-wrap:wrap;gap:8px;';
    const details = document.querySelector('#kitchen-tab-area details');

    if (_kitchenPending.size === 0 && _kitchenPendingRemove.size === 0) {
        if (barTop) barTop.style.display = 'none';
        if (barBottom) barBottom.style.display = 'none';
        return;
    }

    if (!barTop && details) {
        barTop = document.createElement('div');
        barTop.id = 'kitchen-batch-bar-top';
        barTop.style.cssText = barStyle + 'margin-bottom:12px;';
        details.insertBefore(barTop, details.querySelector('div'));
    }
    if (!barBottom && details) {
        barBottom = document.createElement('div');
        barBottom.id = 'kitchen-batch-bar-bottom';
        barBottom.style.cssText = barStyle + 'margin-top:12px;';
        details.appendChild(barBottom);
    }

    if (barTop) { barTop.style.display = 'flex'; barTop.innerHTML = barHTML(); }
    if (barBottom) { barBottom.style.display = 'flex'; barBottom.innerHTML = barHTML(); }
}

async function commitGroceryBatch() {
    // Adds first
    for (const [name, { category }] of _kitchenPending) {
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        await fetch('/api/kitchen/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: displayName, category })
        });
    }
    // Then removals — match by original-case name from the kitchen_list
    const list = D.kitchen_list || [];
    for (const name of _kitchenPendingRemove) {
        const onListEntry = list.find(i => i.name.toLowerCase() === name.toLowerCase());
        const displayName = onListEntry ? onListEntry.name : (name.charAt(0).toUpperCase() + name.slice(1));
        await fetch('/api/kitchen/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: displayName })
        });
    }
    _kitchenPending.clear();
    _kitchenPendingRemove.clear();
    loadDashboard();
}

function cancelGroceryBatch() {
    _kitchenPending.clear();
    _kitchenPendingRemove.clear();
    // Easiest: just re-render via loadDashboard so chips revert to default styling
    updateGroceryBatchBar();
    renderGroceryList();
}

// --- My Foods: live chip filter + add (replaces old autocomplete dropdown) ---

function kitchenChipFilterInput(val, suffix) {
    _kitchenChipFilter = val;
    renderGroceryList(); // re-render to filter chips and toggle +Add button
    // Restore focus to whichever input was being typed in
    const el = document.getElementById('kitchen-input-' + (suffix || 'top'));
    if (el) {
        el.focus();
        el.setSelectionRange(val.length, val.length);
    }
}

function kitchenChipFilterClear() {
    _kitchenChipFilter = '';
    renderGroceryList();
}

function kitchenMyFoodsKeydown(e, suffix) {
    if (e.key === 'Enter') {
        e.preventDefault();
        addGrocery(suffix);
    } else if (e.key === 'Escape') {
        kitchenChipFilterClear();
    }
}

async function addGrocery(suffix) {
    const name = (_kitchenChipFilter || '').trim();
    if (!name) return;
    await _addGroceryByName(name, () => {
        _kitchenChipFilter = '';
    });
}

// Stubs preserved for any inline handlers in unmoved old markup (no-op)
function kitchenAutocomplete() {}
function kitchenKeydown() {}
function selectGroceryAc() {}
function kitchenAcHover() {}

// Shared add flow: known catalog item → direct add; new item → category modal
async function _addGroceryByName(name, onComplete) {
    const known = D.kitchen_known_items || {};
    const items = D.kitchen_list || [];
    if (items.some(i => i.name.toLowerCase() === name.toLowerCase())) {
        // Already on list — no-op
        if (onComplete) onComplete();
        return;
    }
    if (known[name.toLowerCase()]) {
        // Known catalog item — add directly with known category
        await fetch('/api/kitchen/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        _receiptPromptDismissed = false;  // new trip might be starting
        if (onComplete) onComplete();
        loadDashboard();
        return;
    }
    // Unknown — open category modal
    openKitchenCatModal(name, async (category) => {
        await fetch('/api/kitchen/add-with-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category })
        });
        _receiptPromptDismissed = false;
        if (onComplete) onComplete();
        loadDashboard();
    });
}

// --- Receipt scanner ---

function dismissReceiptPrompt() {
    _receiptPromptDismissed = true;
    renderGroceryList();
}

async function uploadKitchenReceipt(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    const res = await fetch('/api/kitchen/scan-receipt', { method: 'POST', body: fd });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Upload failed');
        return;
    }
    const data = await res.json();
    const msg = data.newly_spawned
        ? `Receipt sent to Claude in the 'receipts' terminal tab. New session — give Claude ~5s to start, then it'll parse ${data.filename}.`
        : `Receipt sent to Claude (${data.filename}). Switch to the 'receipts' terminal tab to watch.`;
    alert(msg);
    _receiptPromptDismissed = true;  // hide banner after scan
    renderGroceryList();
}

// --- Grocery List search/add bar ---

function kitchenSearchInput(val) {
    _kitchenSearch = val;
    // Re-render to apply filter + show/hide +Add button
    renderGroceryList();
    // Re-focus the input and place cursor at end
    const el = document.getElementById('kitchen-search');
    if (el) {
        el.focus();
        el.setSelectionRange(val.length, val.length);
    }
}

function kitchenSearchKeydown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        kitchenSearchAdd();
    } else if (e.key === 'Escape') {
        kitchenSearchClear();
    }
}

function kitchenSearchAdd() {
    const val = (_kitchenSearch || '').trim();
    if (!val) return;
    _addGroceryByName(val, () => { _kitchenSearch = ''; });
}

function kitchenSearchClear() {
    _kitchenSearch = '';
    renderGroceryList();
}

// --- Category picker modal (for new items) ---

function openKitchenCatModal(name, callback) {
    _kitchenCatModalCallback = callback;
    const nameEl = document.getElementById('kitchen-cat-modal-name');
    const chipsEl = document.getElementById('kitchen-cat-modal-chips');
    const modal = document.getElementById('kitchen-cat-modal');
    if (!nameEl || !chipsEl || !modal) return;
    nameEl.textContent = name;
    const categoryOrder = (D.kitchen_category_order || ['vegetables', 'produce', 'fruit', 'grains', 'drinks', 'snacks', 'dessert', 'other', 'dairy', 'protein', 'pharmacy', 'supplements']).slice();
    const categoryLabels = {
        produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
        protein: 'Protein', dairy: 'Dairy', grains: 'Grains',
        drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert', other: 'Other',
        pharmacy: 'Pharmacy', supplements: 'Supplements'
    };
    _ensureHousehold(categoryOrder, categoryLabels);
    chipsEl.innerHTML = categoryOrder.map(cat =>
        `<button onclick="pickKitchenCatModal('${esc(cat)}')" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--card-bg);color:var(--text);font-size:13px;font-weight:600;cursor:pointer">${esc(categoryLabels[cat] || cat)}</button>`
    ).join('');
    modal.classList.add('open');
}

function closeKitchenCatModal() {
    _kitchenCatModalCallback = null;
    const modal = document.getElementById('kitchen-cat-modal');
    if (modal) modal.classList.remove('open');
}

async function pickKitchenCatModal(category) {
    const cb = _kitchenCatModalCallback;
    closeKitchenCatModal();
    if (cb) await cb(category);
}

async function toggleGrocery(name) {
    const resp = await fetch('/api/kitchen/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    const result = await resp.json();
    await loadDashboard();
    if (result.all_checked && !_receiptPromptDismissed) {
        openKitchenDoneModal();
    }
}

function removeGrocery(name) {
    confirmDelete(name, 'grocery-item');
}

function editGroceryNote(name) {
    const item = (D.kitchen_list || []).find(i => i.name === name);
    const current = (item && item.note) || '';
    let overlay = document.getElementById('grocery-note-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'grocery-note-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:75;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) closeGroceryNote(); };
    overlay.innerHTML = `
    <div style="background:var(--card-bg);border-radius:12px;padding:20px;max-width:420px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:15px;font-weight:700">Note for ${esc(name)}</div>
            <button onclick="closeGroceryNote()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">e.g. amount, brand, where to buy</div>
        <input type="text" id="grocery-note-input" data-name="${esc(name)}" value="${esc(current)}" onkeydown="if(event.key==='Enter')_saveGroceryNote();if(event.key==='Escape')closeGroceryNote()" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box">
        <div style="display:flex;gap:8px;margin-top:14px">
            <button onclick="closeGroceryNote()" style="padding:7px 14px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:13px;cursor:pointer">Cancel</button>
            <button onclick="_saveGroceryNote()" style="padding:7px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;margin-left:auto">Save</button>
        </div>
    </div>`;
    setTimeout(() => {
        const inp = document.getElementById('grocery-note-input');
        if (inp) { inp.focus(); inp.select(); }
    }, 50);
}

function closeGroceryNote() {
    const overlay = document.getElementById('grocery-note-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function _saveGroceryNote() {
    const inp = document.getElementById('grocery-note-input');
    if (!inp) return;
    const name = inp.dataset.name;
    const note = inp.value;
    await fetch('/api/kitchen/item/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, note })
    });
    closeGroceryNote();
    loadDashboard();
}

function confirmClearAllGrocery() {
    pendingDelete = { item: 'grocery-list', type: 'kitchen-clear-all' };
    document.getElementById('modal-text').innerHTML = `Clear ALL items from the grocery list?<br><span style="font-size:12px;color:var(--text-muted);font-weight:400">This removes everything, checked and unchecked. It does not log a kitchen trip.</span>`;
    const modal = document.getElementById('modal');
    const confirmBtn = modal.querySelector('.confirm');
    if (confirmBtn) confirmBtn.textContent = 'Yes, clear all';
    modal.classList.add('open');
}

async function checkAllGroceries() {
    const unchecked = (D.kitchen_list || []).filter(i => !i.checked);
    for (const item of unchecked) {
        await fetch('/api/kitchen/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: item.name })
        });
    }
    await loadDashboard();
    if (!_receiptPromptDismissed) openKitchenDoneModal();
}

// --- Kitchen "Done shopping" modal handlers ---

function openKitchenDoneModal() {
    const m = document.getElementById('kitchen-done-modal');
    if (m) m.classList.add('open');
}

function closeKitchenDoneModal() {
    const m = document.getElementById('kitchen-done-modal');
    if (m) m.classList.remove('open');
}

async function kitchenDoneScanReceipt(file) {
    closeKitchenDoneModal();
    if (!file) return;
    // Clear checked items first (move to pantry, the trip is finished).
    // The receipt-import flow will then layer line-items / spend / counts on top.
    await fetch('/api/kitchen/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    // Existing upload helper handles photo → Claude scan + banner
    await uploadKitchenReceipt(file);
    _receiptPromptDismissed = true;
}

async function kitchenDoneNoReceipt() {
    closeKitchenDoneModal();
    await fetch('/api/kitchen/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    _receiptPromptDismissed = true;
    loadDashboard();
}

function kitchenDoneNotYet() {
    closeKitchenDoneModal();
    _receiptPromptDismissed = true;  // banner can still show — but the auto-pop won't fire again this session
}

async function clearGroceryChecked() {
    await fetch('/api/kitchen/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    loadDashboard();
}

// --- Category order modal ---
let _catOrder = null;

function openCategoryOrder() {
    const categoryLabels = {
        produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
        protein: 'Protein', dairy: 'Dairy', grains: 'Grains',
        drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert', other: 'Other',
        pharmacy: 'Pharmacy', supplements: 'Supplements'
    };
    _catOrder = [...(D.kitchen_category_order || Object.keys(categoryLabels))];

    let overlay = document.getElementById('cat-order-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'cat-order-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) closeCategoryOrder(); };
    renderCategoryOrder();
}

function renderCategoryOrder() {
    const categoryLabels = {
        produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
        protein: 'Protein', dairy: 'Dairy', grains: 'Grains',
        drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert', other: 'Other',
        pharmacy: 'Pharmacy', supplements: 'Supplements'
    };
    const overlay = document.getElementById('cat-order-overlay');

    let rows = _catOrder.map((cat, i) => {
        const isAisles = cat === '@aisles';
        const label = isAisles ? 'Aisles (1, 2, 3…)' : (categoryLabels[cat] || cat);
        const tint = isAisles ? 'background:rgba(124,92,191,0.10);' : '';
        const hint = isAisles ? '<span style="font-size:11px;color:var(--text-muted);margin-left:6px">numbered aisles cluster here</span>' : '';
        return `<div style="display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid var(--border);${tint}">
            <span style="flex:1;font-size:14px;color:var(--text)">${esc(label)}${hint}</span>
            <button onclick="moveCat(${i},-1)" ${i === 0 ? 'disabled style="opacity:0.2"' : ''} style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:14px;color:var(--text)">&#9650;</button>
            <button onclick="moveCat(${i},1)" ${i === _catOrder.length - 1 ? 'disabled style="opacity:0.2"' : ''} style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:14px;color:var(--text)">&#9660;</button>
        </div>`;
    }).join('');

    overlay.innerHTML = `<div style="background:var(--card-bg);border-radius:12px;padding:20px;max-width:400px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,0.3)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div style="font-size:16px;font-weight:700;color:var(--text)">Category Order</div>
            <button onclick="closeCategoryOrder()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Matches your store walking route</div>
        <div style="flex:1;overflow-y:auto;min-height:0">${rows}</div>
        <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
            <button onclick="saveCategoryOrder()" style="flex:1;padding:8px;border:none;border-radius:8px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Save</button>
            <button onclick="closeCategoryOrder()" style="flex:1;padding:8px;border:none;border-radius:8px;background:var(--border);color:var(--text-muted);font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
        </div>
    </div>`;
}

function moveCat(index, dir) {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= _catOrder.length) return;
    [_catOrder[index], _catOrder[newIndex]] = [_catOrder[newIndex], _catOrder[index]];
    renderCategoryOrder();
}

async function saveCategoryOrder() {
    await fetch('/api/kitchen/category-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: _catOrder })
    });
    D.kitchen_category_order = _catOrder;
    closeCategoryOrder();
    loadDashboard();
}

function closeCategoryOrder() {
    const overlay = document.getElementById('cat-order-overlay');
    if (overlay) overlay.style.display = 'none';
}

// --- Parsed-receipts banner + import modal ---

async function fetchParsedReceipts() {
    try {
        const res = await fetch('/api/kitchen/parsed-receipts/list');
        const data = await res.json();
        _parsedReceipts = data.receipts || [];
        renderGroceryList();
    } catch (e) {
        _parsedReceipts = [];
    }
}

function renderParsedReceiptsBanner() {
    if (!_parsedReceipts || !_parsedReceipts.length) return '';
    const items = _parsedReceipts.map(r => {
        const total = r.total ? `$${Number(r.total).toFixed(2)}` : '—';
        const dateLabel = r.date || '';
        const store = r.store || 'Receipt';
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px dashed var(--border)">
            <span style="font-size:13px;flex:1"><b>${esc(store)}</b> · ${esc(dateLabel)} · ${esc(String(r.items_count))} items · ${total}</span>
            <button onclick="openReceiptImport('${esc(r.filename)}')" style="padding:5px 12px;border-radius:6px;background:var(--green);color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer">Import</button>
        </div>`;
    }).join('');
    return `<div style="background:rgba(124,92,191,0.08);border:1px solid rgba(124,92,191,0.3);border-radius:8px;padding:10px 14px;margin-bottom:10px">
        <div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:4px">${_parsedReceipts.length} parsed receipt${_parsedReceipts.length === 1 ? '' : 's'} ready to import</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">Categorize items + commit them to the trip log.</div>
        ${items}
    </div>`;
}

async function openReceiptImport(filename) {
    try {
        const res = await fetch('/api/kitchen/parsed-receipts/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        const data = await res.json();
        if (data.error) { alert(data.error); return; }
        const aislesMap = D.kitchen_aisles || {};
        // Pre-fill aisle from catalog if known
        (data.rows || []).forEach(r => {
            if (r.aisle == null && r.catalog_name && aislesMap[r.catalog_name] != null) {
                r.aisle = aislesMap[r.catalog_name];
            }
        });
        _activeReceiptImport = { filename, header: data.header || {}, rows: data.rows || [] };
        renderReceiptImportModal();
        document.getElementById('receipt-import-modal').classList.add('open');
    } catch (e) {
        alert('Failed to load receipt: ' + e.message);
    }
}

function closeReceiptImportModal() {
    document.getElementById('receipt-import-modal').classList.remove('open');
    _activeReceiptImport = null;
}

function _rowIsSorted(r) {
    // "Sorted" = you have touched this row. Algorithm-prefilled rows still need
    // your confirmation (tap the row OR change any field). This protects against
    // silently importing whatever the rules-based parser guessed.
    return !!(r && r.user_touched);
}

function _updateReceiptImportProgress() {
    if (!_activeReceiptImport) return;
    const rows = _activeReceiptImport.rows;
    const sorted = rows.filter(_rowIsSorted).length;
    const el = document.getElementById('receipt-import-progress');
    if (!el) return;
    if (sorted === rows.length) {
        el.style.color = 'var(--green)';
        el.textContent = `✓ All ${rows.length} confirmed — ready to import`;
    } else {
        el.style.color = '#e8741c';
        el.textContent = `${sorted} / ${rows.length} confirmed — tap each row to confirm (or edit anything to mark it touched)`;
    }
}

function renderReceiptImportModal() {
    if (!_activeReceiptImport) return;
    const { header, rows } = _activeReceiptImport;
    document.getElementById('receipt-import-title').textContent = `${header.store || 'Receipt'} · ${header.date || ''}`;
    const totalStr = header.total ? `$${Number(header.total).toFixed(2)}` : '—';
    const savedStr = header.saved ? ` · saved $${Number(header.saved).toFixed(2)}` : '';
    document.getElementById('receipt-import-header').textContent =
        `${rows.length} line items · total ${totalStr}${savedStr}`;

    const categoryOrder = D.kitchen_category_order || ['vegetables', 'produce', 'fruit', 'grains', 'drinks', 'snacks', 'dessert', 'other', 'dairy', 'protein', 'pharmacy', 'supplements'];
    const categoriesAlpha = categoryOrder.slice().sort((a, b) => a.localeCompare(b));
    const known = D.kitchen_known_items || {};
    const catalogNames = Object.keys(known).sort();

    const rowsHtml = rows.map((r, i) => {
        const priceStr = r.price ? `$${Number(r.price).toFixed(2)}` : '';
        const qty = Number(r.qty) || 1;
        const qtyBadge = qty > 1
            ? `<span style="background:var(--green);color:#fff;padding:1px 6px;border-radius:8px;font-size:11px;font-weight:700;margin-right:4px">×${qty}</span>`
            : '';
        const locationOpts = _locationOptionsHtml(r.category, r.aisle);
        const NEW_ITEM_OPT = `<option value="__new__">+ New catalog item…</option>`;
        const catalogOpts = [
            `<option value=""${!r.catalog_name ? ' selected' : ''}>— pick catalog item —</option>`,
            NEW_ITEM_OPT,
            ...catalogNames.map(n => `<option value="${esc(n)}"${n === r.catalog_name ? ' selected' : ''}>${esc(n)}</option>`),
            NEW_ITEM_OPT,
        ].join('');
        const dimStyle = r.include ? '' : 'opacity:0.45;';
        const isSorted = _rowIsSorted(r);
        const sortedStyle = isSorted
            ? 'background:var(--card-bg);border-left:4px solid transparent;'
            : 'background:rgba(255,140,40,0.18);border-left:4px solid #e8741c;';
        return `<div data-row-idx="${i}" onclick="confirmReceiptRow(${i}, event)" style="padding:8px 6px 8px 10px;border-bottom:1px solid var(--border);font-size:13px;color:var(--text);cursor:pointer;${sortedStyle}${dimStyle}">
            <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
                <input type="checkbox" data-row="${i}" data-field="include" ${r.include ? 'checked' : ''} onclick="event.stopPropagation()" style="margin:3px 0 0 0;flex-shrink:0" title="Include this item in the imported trip — uncheck to skip">
                <div style="flex:1;min-width:0">
                    <div style="font-weight:600;color:var(--text);word-break:break-word">${qtyBadge}${esc(r.name)}</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${priceStr}${qty > 1 ? ` &nbsp;·&nbsp; ${qty} units` : ''}${isSorted ? '' : ' &nbsp;·&nbsp; <span style="color:#e8741c;font-weight:700">tap to confirm</span>'}</div>
                </div>
            </div>
            <div style="display:flex;gap:6px;padding-left:26px" onclick="event.stopPropagation()">
                <select data-row="${i}" data-field="catalog_name" style="flex:2;min-width:0;padding:5px 4px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px">${catalogOpts}</select>
                <select data-row="${i}" data-field="location" style="flex:1.4;min-width:0;padding:5px 4px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px" title="Where in the store this lives — pick a section (Produce, Dairy, …) OR an aisle number">${locationOpts}</select>
            </div>
        </div>`;
    }).join('');

    document.getElementById('receipt-import-rows').innerHTML = rowsHtml;
    _updateReceiptImportProgress();

    // Wire field changes back into state
    document.getElementById('receipt-import-rows').querySelectorAll('input,select').forEach(el => {
        el.addEventListener('change', (e) => {
            const i = parseInt(e.target.dataset.row, 10);
            const f = e.target.dataset.field;
            if (!_activeReceiptImport || isNaN(i)) return;
            if (f === 'include') {
                _activeReceiptImport.rows[i].include = e.target.checked;
                _activeReceiptImport.rows[i].user_touched = true;
                _restyleReceiptRow(i);
                return;
            }
            if (f === 'location' && e.target.value === '__new_section__') {
                onReceiptImportNewCategory(i, e.target);
                return;
            }
            if (f === 'catalog_name' && e.target.value === '__new__') {
                onReceiptImportNewCatalogItem(i, e.target);
                return;
            }
            if (f === 'location') {
                const { category, aisle } = _parseLocationVal(e.target.value);
                _activeReceiptImport.rows[i].category = category;
                _activeReceiptImport.rows[i].aisle = aisle;
            } else {
                _activeReceiptImport.rows[i][f] = e.target.value;
            }
            _activeReceiptImport.rows[i].user_touched = true;
            // Auto-snap location to the catalog item's stored category/aisle
            if (f === 'catalog_name') {
                const known = D.kitchen_known_items || {};
                const aislesMap = D.kitchen_aisles || {};
                const inferredCat = known[e.target.value];
                const storedAisle = aislesMap[e.target.value];
                if (storedAisle != null) {
                    _activeReceiptImport.rows[i].category = '@aisles';
                    _activeReceiptImport.rows[i].aisle = storedAisle;
                } else if (inferredCat) {
                    _activeReceiptImport.rows[i].category = inferredCat;
                    _activeReceiptImport.rows[i].aisle = null;
                }
                const locSel = document.querySelector(`select[data-row="${i}"][data-field="location"]`);
                if (locSel) {
                    locSel.innerHTML = _locationOptionsHtml(
                        _activeReceiptImport.rows[i].category,
                        _activeReceiptImport.rows[i].aisle
                    );
                }
            }
            _restyleReceiptRow(i);
        });
    });
}

function _restyleReceiptRow(i) {
    if (!_activeReceiptImport) return;
    const r = _activeReceiptImport.rows[i];
    const rowEl = document.querySelector(`[data-row-idx="${i}"]`);
    if (!rowEl) return;
    const sorted = _rowIsSorted(r);
    if (sorted) {
        rowEl.style.background = 'var(--card-bg)';
        rowEl.style.borderLeft = '4px solid transparent';
    } else {
        rowEl.style.background = 'rgba(255,140,40,0.18)';
        rowEl.style.borderLeft = '4px solid #e8741c';
    }
    rowEl.style.opacity = r.include ? '1' : '0.45';
    _updateReceiptImportProgress();
}

function confirmReceiptRow(i, evt) {
    if (!_activeReceiptImport) return;
    const r = _activeReceiptImport.rows[i];
    if (!r) return;
    r.user_touched = true;
    // Re-render this row so the "tap to confirm" hint goes away
    renderReceiptImportModal();
}

// Build a combined location <select> innerHTML: sections + Aisle 1-30 + + New section,
// ordered by D.kitchen_category_order with @aisles unpacked into individual aisle options.
function _locationOptionsHtml(currentCat, currentAisle, opts) {
    opts = opts || {};
    const includeNewOpt = opts.includeNewOpt !== false;
    const order = (D.kitchen_category_order || ['fruit','vegetables','produce','grains','snacks','dessert','other','@aisles','dairy','drinks','protein','supplements','pharmacy','meat']).slice();
    const categoryLabels = {
        produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
        protein: 'Protein / Meat', dairy: 'Dairy', grains: 'Grains',
        drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert', other: 'Other',
        pharmacy: 'Pharmacy', supplements: 'Supplements', meat: 'Meat'
    };
    _ensureHousehold(order, categoryLabels);
    let inAisles = false;
    let html = '';
    // Selected value form: 'section:<name>' or 'aisle:<N>' or '' for unset
    const currentVal = (currentCat === '@aisles' && currentAisle != null)
        ? `aisle:${currentAisle}`
        : (currentCat ? `section:${currentCat}` : '');
    if (!currentVal) {
        html += `<option value="" selected>— pick location —</option>`;
    }
    order.forEach(slot => {
        if (slot === '@aisles') {
            for (let n = 1; n <= 30; n++) {
                const v = `aisle:${n}`;
                html += `<option value="${v}"${v === currentVal ? ' selected' : ''}>Aisle ${n}</option>`;
            }
            inAisles = true;
        } else {
            const label = categoryLabels[slot] || slot;
            const v = `section:${slot}`;
            html += `<option value="${v}"${v === currentVal ? ' selected' : ''}>${esc(label)}</option>`;
        }
    });
    if (includeNewOpt) html += `<option value="__new_section__">+ New section…</option>`;
    return html;
}

function _parseLocationVal(v) {
    // Returns { category, aisle } where category is the section string or '@aisles', aisle is int|null
    if (!v) return { category: '', aisle: null };
    if (v.startsWith('aisle:')) {
        const n = parseInt(v.slice(6), 10) || null;
        return { category: '@aisles', aisle: n };
    }
    if (v.startsWith('section:')) {
        return { category: v.slice(8), aisle: null };
    }
    return { category: '', aisle: null };
}

function setMyFoodsSort(mode) {
    if (!['frequency', 'alpha', 'both'].includes(mode)) return;
    localStorage.setItem('kitchen_my_foods_sort', mode);
    renderGroceryList();
}

function editGroceryAisle(name, badgeEl) {
    if (!badgeEl) return;
    const key = name.toLowerCase();
    const aislesMap = D.kitchen_aisles || (D.kitchen_aisles = {});
    const known = D.kitchen_known_items || {};
    const currentAisle = aislesMap[key];
    const currentCat = known[key] || (currentAisle != null ? '@aisles' : '');
    // Build the unified location picker
    const sel = document.createElement('select');
    sel.style.cssText = 'padding:3px 6px;font-size:12px;border:1px solid var(--accent);border-radius:6px;background:var(--bg);color:var(--text);margin-right:6px;cursor:pointer';
    sel.innerHTML = _locationOptionsHtml(currentCat, currentAisle, { includeNewOpt: false });
    badgeEl.replaceWith(sel);
    sel.focus();
    let done = false;
    const commit = async (cancel) => {
        if (done) return;
        done = true;
        if (cancel) { loadDashboard(); return; }
        const loc = sel.value;
        // Optimistic local update
        const { category, aisle } = _parseLocationVal(loc);
        if (aisle != null) {
            aislesMap[key] = aisle;
            known[key] = '@aisles';
        } else {
            delete aislesMap[key];
            if (category) known[key] = category;
        }
        try {
            await fetch('/api/kitchen/location/set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: key, location: loc })
            });
        } catch (e) {
            alert('Failed to save location: ' + e.message);
        }
        loadDashboard();
    };
    sel.addEventListener('change', () => commit(false));
    sel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); commit(true); }
    });
    sel.addEventListener('blur', () => { if (!done) commit(true); });
}

function _suggestCatalogName(rawName) {
    // Strip leading store/brand prefixes + size suffixes, keep core noun
    let s = (rawName || '').toLowerCase();
    s = s.replace(/\b(heb|hb|cm|sel|kozy|shack|bnl|bobs?|red mill|quakr|quaker|goodflow|hsy|gv)\b/g, '');
    s = s.replace(/\b(org|organic|cage free|brown|lg|eg|fw|f|w|lb|lbs|oz|ct|pk|pack|bag|jar|can|bottle|whole|raw|natural|fresh)\b/g, '');
    s = s.replace(/\b\d+\s*(oz|lb|lbs|ct|pk|g|kg|ml|l)\b/g, '');
    s = s.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Take first 2 words max
    return s.split(' ').slice(0, 2).join(' ');
}

async function onReceiptImportNewCatalogItem(rowIndex, selectEl) {
    const row = _activeReceiptImport.rows[rowIndex];
    const guess = _suggestCatalogName(row.name);
    const name = (prompt('New catalog item name (lowercase, canonical — e.g. "broccoli" not "HEB ORG BROCCOLI"):', guess) || '').trim().toLowerCase();
    if (!name) {
        selectEl.value = row.catalog_name || '';
        return;
    }
    const known = D.kitchen_known_items || (D.kitchen_known_items = {});
    // If category not yet set on this row, default to "other"
    const category = (row.category || 'other').toLowerCase();
    known[name] = category;
    row.catalog_name = name;
    row.category = category;
    renderReceiptImportModal();  // re-render so the new item shows in every row's dropdown
}

async function onReceiptImportNewCategory(rowIndex, selectEl) {
    const name = (prompt('New section name? (e.g. "frozen", "bulk", "bakery")') || '').trim().toLowerCase();
    const r = _activeReceiptImport.rows[rowIndex];
    if (!name) {
        // Revert the dropdown
        selectEl.innerHTML = _locationOptionsHtml(r.category, r.aisle);
        return;
    }
    const order = (D.kitchen_category_order || []).slice();
    if (!order.includes(name)) {
        // Insert just before @aisles if present, otherwise at end
        const aislesAt = order.indexOf('@aisles');
        if (aislesAt >= 0) order.splice(aislesAt, 0, name);
        else order.push(name);
        try {
            await fetch('/api/kitchen/category-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order })
            });
            D.kitchen_category_order = order;
        } catch (e) {
            alert('Failed to save new section: ' + e.message);
            selectEl.innerHTML = _locationOptionsHtml(r.category, r.aisle);
            return;
        }
    }
    r.category = name;
    r.aisle = null;
    r.user_touched = true;
    renderReceiptImportModal();  // re-render so new option appears in all rows
}

async function submitReceiptImport() {
    if (!_activeReceiptImport) return;
    const { filename, rows } = _activeReceiptImport;
    const update_pantry = document.getElementById('receipt-import-pantry').checked;
    // Learn rules for any row that has both a catalog_name and a unique-ish match key (first word of name)
    const learn_rules = [];
    rows.forEach(r => {
        if (!r.include || !r.catalog_name) return;
        const firstWord = (r.name || '').toLowerCase().split(/\s+/).filter(Boolean)[0];
        if (firstWord && firstWord.length >= 3) {
            learn_rules.push({ match: firstWord, category: r.category, catalog_name: r.catalog_name });
        }
    });
    try {
        const res = await fetch('/api/kitchen/parsed-receipts/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, selections: rows, learn_rules, update_pantry })
        });
        const data = await res.json();
        if (data.error) { alert(data.error); return; }
        closeReceiptImportModal();
        _parsedReceiptsFetched = false;
        loadDashboard();  // pulls fresh kitchen_trips + counts
    } catch (e) {
        alert('Import failed: ' + e.message);
    }
}

// --- Spend trend card ---

function renderSpendTrendCard() {
    const trips = (D.kitchen_trips || []).filter(t => typeof t.total === 'number' && t.total > 0);
    if (!trips.length) return '';
    const sorted = trips.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const totals = sorted.map(t => t.total);
    const avg = totals.reduce((s, x) => s + x, 0) / totals.length;
    const last = sorted[sorted.length - 1];
    const last5 = totals.slice(-5);
    const last5Avg = last5.reduce((s, x) => s + x, 0) / last5.length;

    // 30-day total
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const last30Total = sorted.filter(t => (t.date || '') >= cutoffStr).reduce((s, t) => s + t.total, 0);

    // Mini sparkline (last 8 trips)
    const sparkData = totals.slice(-8);
    const max = Math.max(...sparkData, 1);
    const bars = sparkData.map(v => {
        const h = Math.max(3, Math.round((v / max) * 28));
        return `<span title="$${v.toFixed(2)}" style="display:inline-block;width:6px;height:${h}px;background:var(--green);border-radius:1px;margin-right:2px;vertical-align:bottom"></span>`;
    }).join('');

    const dateLabel = last.date ? new Date(last.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

    return `<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="display:flex;align-items:flex-end;gap:2px;height:30px">${bars}</div>
        <div style="font-size:12px;color:var(--text-muted);display:flex;gap:14px;flex-wrap:wrap">
            <span><b style="color:var(--text);font-size:13px">$${last.total.toFixed(2)}</b> last (${esc(dateLabel)})</span>
            <span><b style="color:var(--text);font-size:13px">$${last5Avg.toFixed(2)}</b> avg/trip</span>
            <span><b style="color:var(--text);font-size:13px">$${last30Total.toFixed(2)}</b> last 30d</span>
            <span style="opacity:0.7">${trips.length} trip${trips.length === 1 ? '' : 's'} logged</span>
        </div>
    </div>`;
}

// --- This Week's Meal cluster picker -----------------------------------------
let _mealGenResult = null;  // last generate-list result, shown until next render

function renderThisWeekMealHTML(D) {
    const md = D.meal_defaults || {};
    const mp = md.meal_prep || {};
    if (!mp.protein_rotation || !mp.vegetable_pool) return '';  // not configured

    const tw = mp.this_week || {};
    const protein = tw.protein || '';
    const pickedVeg = tw.vegetables || [];
    const always = mp.always_vegetables || [];
    const grain = mp.grain || '';
    const lastBought = D.kitchen_pantry ? {} : {};  // pantry doesn't have last_bought
    // last_bought is on kitchen.json but not exposed via kitchen_pantry. Read from D.kitchen_last_bought if present.
    const lb = D.kitchen_last_bought || {};
    let rotationHint = '';
    if (mp.protein_rotation.length >= 2) {
        const dated = mp.protein_rotation.map(p => ({ p, d: lb[p] || '' }))
            .sort((a, b) => (b.d > a.d ? 1 : b.d < a.d ? -1 : 0));
        if (dated[0].d) rotationHint = `(last: ${esc(dated[0].p)} ${esc(dated[0].d)})`;
    }

    const saladOn = !!(md.side_salad && md.side_salad.enabled_this_week);

    const proteinChips = mp.protein_rotation.map(p => {
        const sel = p === protein;
        return `<button onclick="setMealProtein('${escJs(p)}')"
            style="padding:6px 12px;border-radius:8px;border:1px solid ${sel ? 'var(--green)' : 'var(--border)'};background:${sel ? 'rgba(58,158,140,0.15)' : 'none'};color:var(--text);font-size:13px;cursor:pointer;font-weight:${sel ? '600' : '400'}">
            ${esc(p)}
        </button>`;
    }).join('');

    const baseChips = [grain, ...always].filter(Boolean).map(b =>
        `<span style="padding:4px 10px;border-radius:8px;background:rgba(255,255,255,0.04);font-size:12px;color:var(--text-muted)">${esc(b)}</span>`
    ).join('');

    const vegChips = mp.vegetable_pool.map(v => {
        const sel = pickedVeg.includes(v);
        return `<button onclick="toggleMealVeg('${escJs(v)}')"
            style="padding:6px 12px;border-radius:14px;border:1px solid ${sel ? 'var(--green)' : 'var(--border)'};background:${sel ? 'rgba(58,158,140,0.15)' : 'none'};color:var(--text);font-size:12px;cursor:pointer">
            ${sel ? '✓ ' : ''}${esc(v)}
        </button>`;
    }).join('');

    let resultMsg = '';
    if (_mealGenResult) {
        const r = _mealGenResult;
        const parts = [];
        if (r.added && r.added.length) parts.push(`Added: ${r.added.join(', ')}`);
        if (r.skipped_in_pantry && r.skipped_in_pantry.length) parts.push(`In pantry: ${r.skipped_in_pantry.join(', ')}`);
        if (r.skipped_already_on_list && r.skipped_already_on_list.length) parts.push(`Already on list: ${r.skipped_already_on_list.join(', ')}`);
        const txt = parts.length ? parts.join(' · ') : 'Nothing to add — list already covers this week.';
        resultMsg = `<div style="margin-top:10px;padding:8px 12px;background:rgba(58,158,140,0.08);border:1px solid rgba(58,158,140,0.3);border-radius:6px;font-size:12px;color:var(--text)">${esc(txt)}</div>`;
    }

    const saladIngs = (md.side_salad && md.side_salad.ingredients) || [];

    return `<div class="kitchen-section" style="margin-bottom:20px;background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:12px 16px">
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0 10px">
            <span style="font-size:16px;font-weight:700">This Week's Meal</span>
            ${tw.week_of ? `<span style="font-size:11px;color:var(--text-muted)">week of ${esc(tw.week_of)}</span>` : ''}
        </div>

        <div style="display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap">
            <span style="font-size:12px;color:var(--text-muted);min-width:54px">Protein</span>
            ${proteinChips}
            ${rotationHint ? `<span style="font-size:11px;color:var(--text-muted)">${rotationHint}</span>` : ''}
        </div>

        <div style="display:flex;align-items:center;gap:6px;margin:6px 0;flex-wrap:wrap">
            <span style="font-size:12px;color:var(--text-muted);min-width:54px">Base</span>
            ${baseChips}
        </div>

        <div style="margin:10px 0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <span style="font-size:12px;color:var(--text-muted);min-width:54px">Pick 2</span>
                <span style="font-size:11px;color:var(--text-muted)">(${pickedVeg.length}/2)</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${vegChips}</div>
        </div>

        <div style="margin:10px 0">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
                <input type="checkbox" ${saladOn ? 'checked' : ''} onchange="toggleMealSalad(this.checked)" style="cursor:pointer">
                <span>Side salad this week</span>
                ${saladIngs.length ? `<span style="font-size:11px;color:var(--text-muted)">(${saladIngs.map(esc).join(', ')})</span>` : ''}
            </label>
        </div>

        <div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <button onclick="generateWeeklyList()"
                style="padding:9px 16px;border-radius:8px;border:none;background:var(--green);color:#fff;font-size:13px;font-weight:600;cursor:pointer">
                Update grocery list →
            </button>
            <span style="font-size:11px;color:var(--text-muted)">Adds missing items, checks pantry for staples</span>
        </div>

        ${resultMsg}
    </div>`;
}

async function setMealProtein(protein) {
    _mealGenResult = null;
    await fetch('/api/meal-defaults/this-week/protein', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protein })
    });
    await loadDashboard();
}

async function toggleMealVeg(name) {
    const mp = (D.meal_defaults && D.meal_defaults.meal_prep) || {};
    const tw = mp.this_week || {};
    let veg = (tw.vegetables || []).slice();
    const idx = veg.indexOf(name);
    if (idx >= 0) {
        veg.splice(idx, 1);
    } else {
        veg.push(name);
        if (veg.length > 2) veg = veg.slice(-2);  // keep most recent 2
    }
    _mealGenResult = null;
    await fetch('/api/meal-defaults/this-week/vegetables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vegetables: veg })
    });
    await loadDashboard();
}

async function toggleMealSalad(enabled) {
    _mealGenResult = null;
    await fetch('/api/meal-defaults/side-salad/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
    });
    await loadDashboard();
}

async function generateWeeklyList() {
    try {
        const res = await fetch('/api/meal-defaults/generate-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await res.json();
        if (data.error) {
            alert('Failed: ' + data.error);
            return;
        }
        _mealGenResult = data;
    } catch (e) {
        alert('Failed: ' + e.message);
        return;
    }
    await loadDashboard();
}

// =====================================================
// Recipes pipeline (URL/image → Claude tmux session → approval → save)
// =====================================================

const RECIPE_CATEGORIES = ['produce', 'vegetables', 'fruit', 'protein', 'dairy', 'grains', 'drinks', 'snacks', 'dessert', 'pharmacy', 'supplements', 'household', 'other'];
const RECIPE_CATEGORY_LABELS = {
    produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
    protein: 'Protein', dairy: 'Dairy', grains: 'Grains',
    drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert',
    pharmacy: 'Pharmacy', supplements: 'Supplements', household: 'Household', other: 'Other'
};
// Stocking status is independent of store category. Drives send behavior, not where it lands.
const STOCKING_STATUSES = [
    { value: '', label: 'Always send' },
    { value: 'usually_have', label: 'Usually have' },
    { value: 'n_a', label: 'Never (N/A)' },
];

// Schema-tolerant readers: legacy data put status in the category field.
function _ingStockingStatus(ing) {
    const st = (ing.stocking_status || '').trim();
    if (st === 'n_a' || st === 'usually_have') return st;
    const cat = (ing.category || '').trim();
    if (cat === 'n_a' || cat === 'usually_have') return cat;
    return '';
}
function _ingStoreCategory(ing) {
    const cat = (ing.category || '').trim();
    if (cat === 'n_a' || cat === 'usually_have') return 'other';
    return cat || 'other';
}

async function fetchParsedRecipes() {
    try {
        const res = await fetch('/api/kitchen/parsed-recipes/list');
        const data = await res.json();
        _parsedRecipes = data.recipes || [];
        renderGroceryList();
    } catch (e) {
        _parsedRecipes = [];
    }
}

function renderParsedRecipesBanner() {
    if (!_parsedRecipes || !_parsedRecipes.length) return '';
    const items = _parsedRecipes.map(r => {
        const summary = r.parse_error
            ? `<span style="color:var(--red)">Parse error: ${esc(r.parse_error)}</span>`
            : `<b>${esc(r.name || '(untitled)')}</b> · ${esc(String(r.ingredients_count || 0))} ingredients`;
        const action = r.parse_error
            ? `<button onclick="discardRecipeImport('${esc(r.filename)}')" style="padding:5px 12px;border-radius:6px;background:none;border:1px solid var(--border);color:var(--text-muted);font-size:12px;cursor:pointer">Dismiss</button>`
            : `<button onclick="openRecipeImport('${esc(r.filename)}')" style="padding:5px 12px;border-radius:6px;background:var(--green);color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer">Review</button>`;
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px dashed var(--border)">
            <span style="font-size:13px;flex:1">${summary}</span>
            ${action}
        </div>`;
    }).join('');
    return `<div style="background:rgba(124,92,191,0.08);border:1px solid rgba(124,92,191,0.3);border-radius:8px;padding:10px 14px;margin-bottom:10px">
        <div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:4px">${_parsedRecipes.length} parsed recipe${_parsedRecipes.length === 1 ? '' : 's'} ready</div>
        ${items}
    </div>`;
}

async function submitRecipeUrl() {
    const input = document.getElementById('recipe-url-input');
    const status = document.getElementById('recipe-parse-status');
    if (!input) return;
    const url = (input.value || '').trim();
    if (!url) { if (status) status.textContent = 'Paste a URL first.'; return; }
    if (status) status.textContent = 'Sending to Claude…';
    const res = await fetch('/api/kitchen/parse-recipe-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.error) { if (status) status.textContent = 'Failed: ' + data.error; return; }
    input.value = '';
    if (status) status.textContent = `Parsing in the recipes tmux session… check the left pane. A "Review" banner will appear here when done.`;
    setTimeout(fetchParsedRecipes, 8000);
    setTimeout(fetchParsedRecipes, 20000);
    setTimeout(fetchParsedRecipes, 45000);
}

async function uploadRecipeImage(file) {
    if (!file) return;
    const status = document.getElementById('recipe-parse-status');
    if (status) status.textContent = 'Uploading…';
    const fd = new FormData();
    fd.append('photo', file);
    const res = await fetch('/api/kitchen/scan-recipe', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { if (status) status.textContent = 'Failed: ' + data.error; return; }
    if (status) status.textContent = 'Parsing in the recipes tmux session… check the left pane.';
    setTimeout(fetchParsedRecipes, 8000);
    setTimeout(fetchParsedRecipes, 20000);
    setTimeout(fetchParsedRecipes, 45000);
}

function renderRecipeCards(recipes) {
    // Only show un-archived recipes in the main list. Archived ones live
    // under the "Past versions" section on each current recipe's detail page.
    const visible = recipes.filter(r => !r.is_archived);
    if (!visible.length) {
        return '<div style="color:var(--text-muted);font-size:13px;font-style:italic;padding:8px 0">No saved recipes yet. Paste a URL above to get started.</div>';
    }
    return visible.map(r => {
        const tags = (r.tags || []).map(t => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:rgba(124,92,191,0.15);color:var(--accent);font-size:11px;font-weight:600;margin-right:4px">${esc(t)}</span>`).join('');
        const timeBits = [];
        if (r.prep_min) timeBits.push(`${r.prep_min} min prep`);
        if (r.cook_min) timeBits.push(`${r.cook_min} min cook`);
        if (r.servings) timeBits.push(`${r.servings} servings`);
        const meta = timeBits.length ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(timeBits.join(' · '))}</div>` : '';
        const sourceLink = r.source_url
            ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener" style="color:var(--ongoing);font-size:12px;text-decoration:none">source ↗</a>`
            : '';
        return `<div class="recipe-card" onclick="viewRecipe('${esc(r.id)}')" style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;background:var(--card-bg);cursor:pointer;transition:border-color 0.15s,background 0.15s">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <div style="flex:1;min-width:0">
                    <div style="font-weight:700;font-size:15px;color:var(--text)">${esc(r.name || '(untitled)')}</div>
                    ${meta}
                    <div style="margin-top:6px">${tags}${sourceLink}</div>
                </div>
                <div style="display:flex;gap:4px;flex-wrap:wrap" onclick="event.stopPropagation()">
                    <button onclick="event.stopPropagation();pushAllRecipeToGrocery('${esc(r.id)}')" style="padding:5px 10px;background:var(--green);border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer" title="Push everything (skips N/A and items already on your list)">Push all</button>
                    <button onclick="event.stopPropagation();sendRecipeToGroceryList('${esc(r.id)}')" style="padding:5px 10px;background:none;border:1px solid var(--green);border-radius:6px;color:var(--green);font-size:12px;font-weight:600;cursor:pointer" title="Pick which ingredients to push">Pick & send</button>
                    <button onclick="event.stopPropagation();removeRecipe('${esc(r.id)}','${esc(r.name || 'recipe')}')" style="background:none;border:none;color:var(--text-muted);font-size:16px;cursor:pointer" title="Delete">&times;</button>
                </div>
                <span class="recipe-card-chev" aria-hidden="true" style="color:var(--text-muted);font-size:20px;line-height:1;margin-left:2px;transition:transform 0.15s,color 0.15s">&rsaquo;</span>
            </div>
        </div>`;
    }).join('');
}

// --- Approval modal (review parsed recipe before save) ---

async function openRecipeImport(filename) {
    try {
        const res = await fetch('/api/kitchen/parsed-recipes/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        const recipe = await res.json();
        if (recipe.error) { alert(recipe.error); return; }
        _activeRecipeImport = { filename, recipe };
        _renderRecipeImportModal();
    } catch (e) {
        alert('Failed to load recipe: ' + e.message);
    }
}

function _renderRecipeImportModal() {
    let overlay = document.getElementById('recipe-import-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'recipe-import-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) closeRecipeImport(); };

    const r = _activeRecipeImport.recipe;
    const catOpts = RECIPE_CATEGORIES.map(c => `<option value="${c}">${RECIPE_CATEGORY_LABELS[c]}</option>`).join('');
    const ingredients = (r.ingredients || []).map((ing, i) => {
        const storeCat = _ingStoreCategory(ing);
        const stocking = _ingStockingStatus(ing);
        return `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap" data-ing-row="${i}">
            <input type="text" data-field="item" value="${esc(ing.item || '')}" placeholder="ingredient" style="flex:2;min-width:120px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            <input type="text" data-field="qty" value="${esc(ing.qty || '')}" placeholder="qty" style="flex:1;min-width:80px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            <select data-field="category" title="Store section" style="padding:5px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px">
                ${RECIPE_CATEGORIES.map(c => `<option value="${c}" ${c === storeCat ? 'selected' : ''}>${RECIPE_CATEGORY_LABELS[c]}</option>`).join('')}
            </select>
            <select data-field="stocking_status" title="Send behavior" style="padding:5px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px">
                ${STOCKING_STATUSES.map(s => `<option value="${s.value}" ${s.value === stocking ? 'selected' : ''}>${s.label}</option>`).join('')}
            </select>
            <input type="text" data-field="note" value="${esc(ing.note || '')}" placeholder="note" style="flex:1;min-width:80px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px">
            <button onclick="_removeRecipeIngredient(${i})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:2px 6px">&times;</button>
        </div>
    `;
    }).join('');
    const instructions = (r.instructions || []).map((step, i) => `
        <div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:6px" data-step-row="${i}">
            <span style="padding-top:6px;font-size:13px;color:var(--text-muted);width:24px;text-align:right">${i + 1}.</span>
            <textarea data-step-idx="${i}" rows="2" style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;resize:vertical;font-family:inherit">${esc(step)}</textarea>
            <button onclick="_removeRecipeStep(${i})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:2px 6px;align-self:flex-start;margin-top:6px">&times;</button>
        </div>
    `).join('');

    overlay.innerHTML = `
    <div style="background:var(--card-bg);border-radius:12px;padding:20px;max-width:640px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div style="font-size:16px;font-weight:700">Review parsed recipe</div>
            <button onclick="closeRecipeImport()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div style="flex:1;overflow-y:auto;min-height:0;padding-right:6px">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
                Name
                <input id="recipe-edit-name" type="text" value="${esc(r.name || '')}" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px">
            </label>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
                <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">Servings
                    <input id="recipe-edit-servings" type="number" min="1" value="${esc(r.servings == null ? '' : r.servings)}" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
                </label>
                <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">Prep (min)
                    <input id="recipe-edit-prep" type="number" min="0" value="${esc(r.prep_min == null ? '' : r.prep_min)}" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
                </label>
                <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">Cook (min)
                    <input id="recipe-edit-cook" type="number" min="0" value="${esc(r.cook_min == null ? '' : r.cook_min)}" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
                </label>
            </div>
            <div style="font-weight:600;margin-bottom:6px">Ingredients</div>
            <div id="recipe-ingredients-list">${ingredients}</div>
            <button onclick="_addRecipeIngredient()" style="font-size:12px;color:var(--text-muted);background:none;border:1px dashed var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;margin-bottom:14px">+ Add ingredient</button>
            <div style="font-weight:600;margin-bottom:6px">Instructions</div>
            <div id="recipe-instructions-list">${instructions}</div>
            <button onclick="_addRecipeStep()" style="font-size:12px;color:var(--text-muted);background:none;border:1px dashed var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;margin-bottom:14px">+ Add step</button>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
                Tags (comma-separated)
                <input id="recipe-edit-tags" type="text" value="${esc((r.tags || []).join(', '))}" placeholder="breakfast, vegetarian" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
                Notes
                <textarea id="recipe-edit-notes" rows="2" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;resize:vertical;font-family:inherit">${esc(r.notes || '')}</textarea>
            </label>
            <div style="font-size:11px;color:var(--text-muted)">Source: ${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" style="color:var(--ongoing);text-decoration:none">${esc(r.source_url)}</a>` : r.source_image ? esc(r.source_image) : '—'}</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
            <button onclick="saveRecipeFromImport()" style="padding:8px 18px;background:var(--ongoing);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Save recipe</button>
            <button onclick="discardRecipeImport()" style="padding:8px 14px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:13px;cursor:pointer">Discard</button>
        </div>
    </div>`;
}

function closeRecipeImport() {
    const overlay = document.getElementById('recipe-import-overlay');
    if (overlay) overlay.style.display = 'none';
    _activeRecipeImport = null;
}

function _readRecipeFromModal() {
    const r = _activeRecipeImport?.recipe || {};
    const name = document.getElementById('recipe-edit-name').value.trim();
    const servings = document.getElementById('recipe-edit-servings').value;
    const prep = document.getElementById('recipe-edit-prep').value;
    const cook = document.getElementById('recipe-edit-cook').value;
    const tagsRaw = document.getElementById('recipe-edit-tags').value;
    const notes = document.getElementById('recipe-edit-notes').value.trim();
    const ingRows = document.querySelectorAll('#recipe-ingredients-list > div[data-ing-row]');
    const ingredients = Array.from(ingRows).map(row => ({
        item: row.querySelector('[data-field="item"]').value.trim(),
        qty: row.querySelector('[data-field="qty"]').value.trim(),
        category: row.querySelector('[data-field="category"]').value,
        stocking_status: row.querySelector('[data-field="stocking_status"]')?.value || '',
        note: row.querySelector('[data-field="note"]').value.trim(),
    })).filter(i => i.item);
    const stepEls = document.querySelectorAll('#recipe-instructions-list textarea[data-step-idx]');
    const instructions = Array.from(stepEls).map(t => t.value.trim()).filter(Boolean);
    const tags = tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    return {
        id: r.id,
        name,
        source_url: r.source_url || null,
        source_image: r.source_image || null,
        servings: servings ? Number(servings) : null,
        prep_min: prep ? Number(prep) : null,
        cook_min: cook ? Number(cook) : null,
        ingredients,
        instructions,
        tags,
        notes,
    };
}

async function saveRecipeFromImport() {
    if (!_activeRecipeImport) return;
    const recipe = _readRecipeFromModal();
    if (!recipe.name) { alert('Recipe needs a name.'); return; }
    const res = await fetch('/api/kitchen/recipes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parsed_filename: _activeRecipeImport.filename, recipe })
    });
    if (res.ok) {
        closeRecipeImport();
        await fetchParsedRecipes();
        loadDashboard();
    } else {
        const err = await res.json().catch(() => ({}));
        alert('Save failed: ' + (err.error || res.status));
    }
}

async function discardRecipeImport(filename) {
    const f = filename || _activeRecipeImport?.filename;
    if (!f) return;
    if (!confirm('Discard this parsed recipe? The original URL/image file is kept.')) return;
    await fetch('/api/kitchen/parsed-recipes/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: f })
    });
    closeRecipeImport();
    await fetchParsedRecipes();
}

function _addRecipeIngredient() {
    if (!_activeRecipeImport) return;
    _activeRecipeImport.recipe.ingredients = _readRecipeFromModal().ingredients;
    _activeRecipeImport.recipe.ingredients.push({ item: '', qty: '', category: 'other', note: '' });
    _renderRecipeImportModal();
}

function _removeRecipeIngredient(idx) {
    if (!_activeRecipeImport) return;
    const cur = _readRecipeFromModal();
    cur.ingredients.splice(idx, 1);
    _activeRecipeImport.recipe.ingredients = cur.ingredients;
    _activeRecipeImport.recipe.instructions = cur.instructions;
    _renderRecipeImportModal();
}

function _addRecipeStep() {
    if (!_activeRecipeImport) return;
    const cur = _readRecipeFromModal();
    cur.instructions.push('');
    _activeRecipeImport.recipe.ingredients = cur.ingredients;
    _activeRecipeImport.recipe.instructions = cur.instructions;
    _renderRecipeImportModal();
}

function _removeRecipeStep(idx) {
    if (!_activeRecipeImport) return;
    const cur = _readRecipeFromModal();
    cur.instructions.splice(idx, 1);
    _activeRecipeImport.recipe.ingredients = cur.ingredients;
    _activeRecipeImport.recipe.instructions = cur.instructions;
    _renderRecipeImportModal();
}

// --- View modal (read-only) ---

function viewRecipe(id) {
    window._kitchenRecipeView = id;
    renderGroceryList();
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function closeRecipeDetail() {
    window._kitchenRecipeView = null;
    renderGroceryList();
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderRecipeDetailInto(el, id) {
    // Edit mode takes priority when active for this recipe
    if (window._kitchenRecipeEdit && window._kitchenRecipeEdit.recipe && window._kitchenRecipeEdit.recipe.id === id) {
        _renderRecipeEditInto(el, window._kitchenRecipeEdit.recipe);
        return;
    }

    const recipe = (D.recipes || []).find(r => r.id === id);
    if (!recipe) {
        window._kitchenRecipeView = null;
        renderGroceryInto(el);
        return;
    }

    const ingredients = (recipe.ingredients || []).map(i => {
        const qty = (i.qty || '').trim();
        const item = (i.item || '').trim();
        const note = i.note ? ` <span style="color:var(--text-muted);font-size:12px">(${esc(i.note)})</span>` : '';
        const main = qty ? `${esc(item)} — <span style="color:var(--text-muted)">${esc(qty)}</span>` : esc(item);
        return `<li style="margin-bottom:4px">${main}${note}</li>`;
    }).join('');
    const steps = (recipe.instructions || []).map(s =>
        `<li style="margin-bottom:8px;padding-left:6px;line-height:1.55">${esc(s)}</li>`
    ).join('');
    // Sectioned recipes render grouped sub-step lists; flat recipes use `steps` as before.
    const hasSections = Array.isArray(recipe.sections) && recipe.sections.length > 0;
    const instructionsHtml = hasSections
        ? recipe.sections.map(sec => {
            const secSteps = (sec.steps || []).map(s =>
                `<li style="margin-bottom:8px;padding-left:6px;line-height:1.55">${esc(s)}</li>`
            ).join('');
            return `<div style="font-weight:700;font-size:14px;margin:14px 0 6px;color:var(--accent)">${esc(sec.title || '')}</div>
                <ol style="margin:0 0 6px 18px;padding:0">${secSteps}</ol>`;
        }).join('')
        : `<ol style="margin:0 0 18px 18px;padding:0">${steps}</ol>`;
    const tags = (recipe.tags || []).map(t =>
        `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:rgba(124,92,191,0.15);color:var(--accent);font-size:11px;font-weight:600;margin-right:4px">${esc(t)}</span>`
    ).join('');
    const metaBits = [];
    if (recipe.servings) metaBits.push(`${recipe.servings} servings`);
    if (recipe.prep_min) metaBits.push(`${recipe.prep_min} min prep`);
    if (recipe.cook_min) metaBits.push(`${recipe.cook_min} min cook`);

    el.innerHTML = `
    <div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            <button onclick="closeRecipeDetail()" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:6px;padding:6px 12px;cursor:pointer">← Back</button>
            <div style="margin-left:auto;display:flex;gap:8px">
                <button onclick="removeRecipe('${esc(recipe.id)}','${esc(recipe.name || 'recipe')}')" style="background:none;border:1px solid var(--border);color:var(--text-muted);font-size:12px;border-radius:6px;padding:6px 12px;cursor:pointer">Delete</button>
                <button onclick="editRecipe('${esc(recipe.id)}')" style="padding:6px 14px;background:none;color:var(--text);border:1px solid var(--accent);border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Edit</button>
            </div>
        </div>
        <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">
            <button onclick="pushAllRecipeToGrocery('${esc(recipe.id)}')" style="padding:6px 14px;background:var(--green);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Push everything (skips N/A and items already on your list)">Push all → grocery</button>
            <button onclick="sendRecipeToGroceryList('${esc(recipe.id)}')" style="padding:6px 14px;background:none;color:var(--green);border:1px solid var(--green);border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Pick & send</button>
        </div>
        <div style="font-size:22px;font-weight:700;margin-bottom:4px">${esc(recipe.name)}</div>
        ${metaBits.length ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${esc(metaBits.join(' · '))}</div>` : ''}
        <div style="margin-bottom:18px">${tags}${recipe.source_url ? `<a href="${esc(recipe.source_url)}" target="_blank" rel="noopener" style="color:var(--ongoing);font-size:12px;text-decoration:none">source ↗</a>` : ''}</div>
        <div style="font-weight:700;margin-bottom:6px;font-size:16px">Ingredients</div>
        <ul style="margin:0 0 18px 18px;padding:0">${ingredients}</ul>
        <div style="font-weight:700;margin-bottom:6px;font-size:16px">Instructions</div>
        ${instructionsHtml}
        ${recipe.notes ? `<div style="font-style:italic;color:var(--text-muted);font-size:13px;padding:10px 0;border-top:1px solid var(--border)">${esc(recipe.notes)}</div>` : ''}
        <div style="padding-top:14px;border-top:1px solid var(--border);margin-top:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <div style="font-weight:700;font-size:15px">My notes</div>
                <div id="recipe-my-notes-status" style="font-size:11px;color:var(--text-muted)"></div>
            </div>
            <textarea id="recipe-my-notes-text" data-id="${esc(recipe.id)}" rows="4" placeholder="What you tweaked, how it turned out, who liked it…" oninput="_recipeMyNotesDirty()" onblur="_recipeMyNotesSave()" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box">${esc(recipe.my_notes || '')}</textarea>
        </div>
        ${_renderRecipePastVersions(recipe)}
    </div>`;
}

function _walkRecipeChain(recipe) {
    const all = D.recipes || [];
    const chain = [];
    let cur = recipe;
    const seen = new Set([recipe.id]);
    while (cur && cur.parent_id) {
        const parent = all.find(r => r.id === cur.parent_id);
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        chain.push(parent);
        cur = parent;
    }
    return chain;
}

function _renderRecipePastVersions(recipe) {
    const chain = _walkRecipeChain(recipe);
    if (!chain.length) return '';
    const rows = chain.map(r => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--border)">
            <span style="font-size:12px;color:var(--text-muted);min-width:90px">${esc(r.created || '—')}</span>
            <span style="flex:1;font-size:13px;color:var(--text)">${esc(r.name || '(untitled)')}</span>
            <button onclick="viewRecipe('${esc(r.id)}')" style="padding:3px 10px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:11px;cursor:pointer">View</button>
        </div>
    `).join('');
    return `<details class="kitchen-section" style="margin-top:18px">
        <summary style="font-size:14px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;transition:transform 0.15s;display:inline-block" class="kitchen-arrow">&#9654;</span>
            Past versions <span style="font-size:12px;font-weight:400;color:var(--text-muted)">(${chain.length})</span>
        </summary>
        <div style="padding-top:8px">${rows}</div>
    </details>`;
}

function _recipeMyNotesDirty() {
    const s = document.getElementById('recipe-my-notes-status');
    if (s) s.textContent = 'unsaved…';
}

async function _recipeMyNotesSave() {
    const ta = document.getElementById('recipe-my-notes-text');
    const s = document.getElementById('recipe-my-notes-status');
    if (!ta) return;
    const id = ta.dataset.id;
    if (s) s.textContent = 'saving…';
    const res = await fetch('/api/kitchen/recipes/my-notes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, my_notes: ta.value }),
    });
    if (s) s.textContent = res.ok ? 'saved' : 'save failed';
    // Reflect saved value back into the in-memory D so navigating away + back keeps it
    if (res.ok && D.recipes) {
        const r = D.recipes.find(r => r.id === id);
        if (r) r.my_notes = ta.value;
    }
}

// --- Edit mode (in-page, mirrors the parsed-recipe review form but reads from D.recipes) ---

function editRecipe(id) {
    const recipe = (D.recipes || []).find(r => r.id === id);
    if (!recipe) return;
    window._kitchenRecipeView = id;
    window._kitchenRecipeEdit = { recipe: JSON.parse(JSON.stringify(recipe)) };
    renderGroceryList();
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function cancelRecipeEdit() {
    window._kitchenRecipeEdit = null;
    renderGroceryList();
}

async function saveRecipeEdit() {
    if (!window._kitchenRecipeEdit) return;
    const updated = _readRecipeFromEditForm();
    if (!updated.name) { alert('Recipe needs a name.'); return; }
    const res = await fetch('/api/kitchen/recipes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe: updated })
    });
    if (res.ok) {
        window._kitchenRecipeEdit = null;
        loadDashboard();
    } else {
        const err = await res.json().catch(() => ({}));
        alert('Save failed: ' + (err.error || res.status));
    }
}

async function saveRecipeAsVariant() {
    if (!window._kitchenRecipeEdit) return;
    const updated = _readRecipeFromEditForm();
    if (!updated.name) { alert('Recipe needs a name.'); return; }
    // Auto-append a date suffix to the name if it doesn't already differ from the original.
    const original = (D.recipes || []).find(r => r.id === updated.id);
    if (original && updated.name.trim() === (original.name || '').trim()) {
        const today = (typeof _serverDate !== 'undefined' && _serverDate) || new Date().toISOString().slice(0, 10);
        updated.name = `${updated.name} (modified ${today})`;
    }
    const res = await fetch('/api/kitchen/recipes/save-as-variant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe: updated })
    });
    if (res.ok) {
        const data = await res.json();
        window._kitchenRecipeEdit = null;
        window._kitchenRecipeView = data.id;  // jump to the new variant's detail page
        loadDashboard();
    } else {
        const err = await res.json().catch(() => ({}));
        alert('Save failed: ' + (err.error || res.status));
    }
}

function _renderRecipeEditInto(el, r) {
    const ingredients = (r.ingredients || []).map((ing, i) => {
        const storeCat = _ingStoreCategory(ing);
        const stocking = _ingStockingStatus(ing);
        return `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap" data-ing-row="${i}">
            <input type="text" data-field="item" value="${esc(ing.item || '')}" placeholder="ingredient" style="flex:2;min-width:120px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            <input type="text" data-field="qty" value="${esc(ing.qty || '')}" placeholder="qty" style="flex:1;min-width:80px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            <select data-field="category" title="Store section" style="padding:5px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px">
                ${RECIPE_CATEGORIES.map(c => `<option value="${c}" ${c === storeCat ? 'selected' : ''}>${RECIPE_CATEGORY_LABELS[c]}</option>`).join('')}
            </select>
            <select data-field="stocking_status" title="Send behavior" style="padding:5px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px">
                ${STOCKING_STATUSES.map(s => `<option value="${s.value}" ${s.value === stocking ? 'selected' : ''}>${s.label}</option>`).join('')}
            </select>
            <input type="text" data-field="note" value="${esc(ing.note || '')}" placeholder="note" style="flex:1;min-width:80px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px">
            <button onclick="_removeEditIngredient(${i})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:2px 6px">&times;</button>
        </div>
    `;
    }).join('');
    const stepCount = (r.instructions || []).length;
    const steps = (r.instructions || []).map((step, i) => `
        <div class="recipe-step-row" draggable="true"
             ondragstart="_recipeStepDragStart(event)"
             ondragover="_recipeStepDragOver(event)"
             ondragleave="_recipeStepDragLeave(event)"
             ondrop="_recipeStepDrop(event)"
             ondragend="_recipeStepDragEnd(event)"
             data-step-row="${i}"
             style="display:flex;gap:6px;align-items:flex-start;margin-bottom:6px;padding:2px">
            <span title="Drag to reorder" style="padding-top:8px;color:var(--text-muted);cursor:grab;font-size:14px;user-select:none;letter-spacing:-2px">&#8942;&#8942;</span>
            <span style="padding-top:6px;font-size:13px;color:var(--text-muted);width:24px;text-align:right">${i + 1}.</span>
            <textarea data-step-idx="${i}" rows="2" style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;resize:vertical;font-family:inherit">${esc(step)}</textarea>
            <div style="display:flex;flex-direction:column;gap:1px;padding-top:4px">
                <button onclick="_moveEditStep(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Move up" style="background:none;border:none;color:var(--text-muted);font-size:11px;cursor:${i === 0 ? 'not-allowed' : 'pointer'};padding:1px 5px;line-height:1;opacity:${i === 0 ? '0.3' : '1'}">&#9650;</button>
                <button onclick="_moveEditStep(${i}, 1)" ${i === stepCount - 1 ? 'disabled' : ''} title="Move down" style="background:none;border:none;color:var(--text-muted);font-size:11px;cursor:${i === stepCount - 1 ? 'not-allowed' : 'pointer'};padding:1px 5px;line-height:1;opacity:${i === stepCount - 1 ? '0.3' : '1'}">&#9660;</button>
            </div>
            <button onclick="_removeEditStep(${i})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:2px 6px;align-self:flex-start;margin-top:6px">&times;</button>
        </div>
    `).join('');

    el.innerHTML = `
    <div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
            <span style="font-size:12px;color:var(--text-muted)">Editing</span>
            <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
                <button onclick="cancelRecipeEdit()" style="padding:6px 14px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;font-size:13px;cursor:pointer">Cancel</button>
                <button onclick="saveRecipeEdit()" style="padding:6px 14px;background:var(--ongoing);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Overwrite this recipe in place">Save</button>
                <button onclick="saveRecipeAsVariant()" style="padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Archive current and create a new version">Save new version</button>
            </div>
        </div>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
            Name
            <input id="recipe-edit-name" type="text" value="${esc(r.name || '')}" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:15px;font-weight:600">
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">Servings
                <input id="recipe-edit-servings" type="number" min="1" value="${esc(r.servings == null ? '' : r.servings)}" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">Prep (min)
                <input id="recipe-edit-prep" type="number" min="0" value="${esc(r.prep_min == null ? '' : r.prep_min)}" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">Cook (min)
                <input id="recipe-edit-cook" type="number" min="0" value="${esc(r.cook_min == null ? '' : r.cook_min)}" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            </label>
        </div>
        <div style="font-weight:700;margin-bottom:6px;font-size:15px">Ingredients</div>
        <div id="recipe-ingredients-list">${ingredients}</div>
        <button onclick="_addEditIngredient()" style="font-size:12px;color:var(--text-muted);background:none;border:1px dashed var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;margin-bottom:14px">+ Add ingredient</button>
        <div style="font-weight:700;margin-bottom:6px;font-size:15px">Instructions</div>
        ${(Array.isArray(r.sections) && r.sections.length) ? `<div style="font-size:12px;color:var(--text-muted);background:rgba(124,92,191,0.08);border:1px dashed var(--accent);border-radius:6px;padding:8px 10px;margin-bottom:8px">This recipe has step <b>sections</b> (shown grouped on the detail page). The flat list below is the raw steps — editing it won't restructure the sections, and the grouped view keeps its own copy. In-form section editing is coming soon.</div>` : ''}
        <div id="recipe-instructions-list">${steps}</div>
        <button onclick="_addEditStep()" style="font-size:12px;color:var(--text-muted);background:none;border:1px dashed var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;margin-bottom:14px">+ Add step</button>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
            Tags (comma-separated)
            <input id="recipe-edit-tags" type="text" value="${esc((r.tags || []).join(', '))}" placeholder="breakfast, vegetarian" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
            Notes (from source)
            <textarea id="recipe-edit-notes" rows="2" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;resize:vertical;font-family:inherit">${esc(r.notes || '')}</textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
            My notes
            <textarea id="recipe-edit-my-notes" rows="3" placeholder="What you tweaked, how it turned out…" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;resize:vertical;font-family:inherit">${esc(r.my_notes || '')}</textarea>
        </label>
        <div style="font-size:11px;color:var(--text-muted)">Source: ${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" style="color:var(--ongoing);text-decoration:none">${esc(r.source_url)}</a>` : r.source_image ? esc(r.source_image) : '—'}</div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border);flex-wrap:wrap">
            <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
                <button onclick="cancelRecipeEdit()" style="padding:6px 14px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;font-size:13px;cursor:pointer">Cancel</button>
                <button onclick="saveRecipeEdit()" style="padding:6px 14px;background:var(--ongoing);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Overwrite this recipe in place">Save</button>
                <button onclick="saveRecipeAsVariant()" style="padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Archive current and create a new version">Save new version</button>
            </div>
        </div>
    </div>`;
}

function _readRecipeFromEditForm() {
    const base = window._kitchenRecipeEdit?.recipe || {};
    const ingRows = document.querySelectorAll('#recipe-ingredients-list > div[data-ing-row]');
    const ingredients = Array.from(ingRows).map(row => ({
        item: row.querySelector('[data-field="item"]').value.trim(),
        qty: row.querySelector('[data-field="qty"]').value.trim(),
        category: row.querySelector('[data-field="category"]').value,
        stocking_status: row.querySelector('[data-field="stocking_status"]')?.value || '',
        note: row.querySelector('[data-field="note"]').value.trim(),
    })).filter(i => i.item);
    const stepEls = document.querySelectorAll('#recipe-instructions-list textarea[data-step-idx]');
    const instructions = Array.from(stepEls).map(t => t.value.trim()).filter(Boolean);
    const tagsRaw = document.getElementById('recipe-edit-tags').value;
    const tags = tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    const servings = document.getElementById('recipe-edit-servings').value;
    const prep = document.getElementById('recipe-edit-prep').value;
    const cook = document.getElementById('recipe-edit-cook').value;
    return {
        id: base.id,
        name: document.getElementById('recipe-edit-name').value.trim(),
        source_url: base.source_url || null,
        source_image: base.source_image || null,
        servings: servings ? Number(servings) : null,
        prep_min: prep ? Number(prep) : null,
        cook_min: cook ? Number(cook) : null,
        ingredients,
        instructions,
        tags,
        notes: document.getElementById('recipe-edit-notes').value.trim(),
        my_notes: document.getElementById('recipe-edit-my-notes').value.trim(),
        created: base.created,
        // Carry the variant-chain fields so an in-place Save doesn't clobber them.
        parent_id: base.parent_id == null ? null : base.parent_id,
        is_archived: base.is_archived === true,
        // Carry choice groups + last picks (not editable from the form yet — coming next).
        choice_groups: base.choice_groups || [],
        last_picks: base.last_picks || {},
        // Carry step sections forward verbatim — the flat editor below doesn't restructure them yet.
        ...(Array.isArray(base.sections) && base.sections.length ? { sections: base.sections } : {}),
    };
}

function _addEditIngredient() {
    if (!window._kitchenRecipeEdit) return;
    const cur = _readRecipeFromEditForm();
    cur.ingredients.push({ item: '', qty: '', category: 'other', note: '' });
    window._kitchenRecipeEdit.recipe = cur;
    renderGroceryList();
}

function _removeEditIngredient(idx) {
    if (!window._kitchenRecipeEdit) return;
    const cur = _readRecipeFromEditForm();
    cur.ingredients.splice(idx, 1);
    window._kitchenRecipeEdit.recipe = cur;
    renderGroceryList();
}

function _addEditStep() {
    if (!window._kitchenRecipeEdit) return;
    const cur = _readRecipeFromEditForm();
    cur.instructions.push('');
    window._kitchenRecipeEdit.recipe = cur;
    renderGroceryList();
}

function _removeEditStep(idx) {
    if (!window._kitchenRecipeEdit) return;
    const cur = _readRecipeFromEditForm();
    cur.instructions.splice(idx, 1);
    window._kitchenRecipeEdit.recipe = cur;
    renderGroceryList();
}

function _moveEditStep(idx, delta) {
    if (!window._kitchenRecipeEdit) return;
    const cur = _readRecipeFromEditForm();
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= cur.instructions.length) return;
    const moved = cur.instructions.splice(idx, 1)[0];
    cur.instructions.splice(newIdx, 0, moved);
    window._kitchenRecipeEdit.recipe = cur;
    renderGroceryList();
}

// --- Drag-and-drop reorder for step rows ---
let _recipeStepDragItem = null;

function _recipeStepDragStart(e) {
    _recipeStepDragItem = e.currentTarget;
    _recipeStepDragItem.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Commit pending textarea values before the drag so we don't lose them on re-render
    if (window._kitchenRecipeEdit) {
        window._kitchenRecipeEdit.recipe = _readRecipeFromEditForm();
    }
}
function _recipeStepDragOver(e) {
    e.preventDefault();
    if (e.currentTarget !== _recipeStepDragItem) {
        e.currentTarget.classList.add('drag-over');
    }
}
function _recipeStepDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}
function _recipeStepDragEnd(e) {
    if (_recipeStepDragItem) _recipeStepDragItem.classList.remove('dragging');
    document.querySelectorAll('.recipe-step-row.drag-over').forEach(el => el.classList.remove('drag-over'));
    _recipeStepDragItem = null;
}
function _recipeStepDrop(e) {
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('drag-over');
    if (!_recipeStepDragItem || target === _recipeStepDragItem) return;
    const fromIdx = Number(_recipeStepDragItem.dataset.stepRow);
    const toIdx = Number(target.dataset.stepRow);
    if (!window._kitchenRecipeEdit) return;
    // Use the already-committed state from dragstart
    const cur = window._kitchenRecipeEdit.recipe;
    const moved = cur.instructions.splice(fromIdx, 1)[0];
    cur.instructions.splice(toIdx, 0, moved);
    renderGroceryList();
}

function sendRecipeToGroceryList(id) {
    const recipe = (D.recipes || []).find(r => r.id === id);
    if (!recipe) return;
    // Initialize the per-modal picks state from recipe.last_picks (if any)
    window._recipeSendId = id;
    window._recipeSendPicks = {};
    (recipe.choice_groups || []).forEach(g => {
        const gid = String(g.id || '');
        const prev = (recipe.last_picks && recipe.last_picks[gid]) || [];
        window._recipeSendPicks[gid] = new Set(prev);
    });
    _renderRecipeSendModal();
}

function _renderRecipeSendModal() {
    const id = window._recipeSendId;
    const recipe = (D.recipes || []).find(r => r.id === id);
    if (!recipe) return;
    let overlay = document.getElementById('recipe-send-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'recipe-send-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:70;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) closeRecipeSend(); };

    const groups = recipe.choice_groups || [];
    const memberSet = new Set();
    groups.forEach(g => (g.members || []).forEach(m => memberSet.add((m || '').toLowerCase().trim())));

    const groupBlocks = groups.map(g => {
        const gid = String(g.id || '');
        const selected = window._recipeSendPicks[gid] || new Set();
        const pickN = Number(g.pick_n) || 1;
        const isValid = selected.size === pickN;
        const counter = pickN === 1
            ? (selected.size ? '1 selected' : 'pick 1')
            : `${selected.size} of ${pickN} selected`;
        const chips = (g.members || []).map(m => {
            const isSel = selected.has(m);
            const label = _recipeMemberLabel(recipe, m);
            return `<button onclick="_recipeSendToggleMember('${esc(gid)}','${esc(m).replace(/'/g, "\\'")}',${pickN})" style="padding:5px 12px;border-radius:14px;font-size:13px;cursor:pointer;border:1px solid ${isSel ? 'var(--accent)' : 'var(--border)'};background:${isSel ? 'rgba(124,92,191,0.18)' : 'none'};color:${isSel ? 'var(--accent)' : 'var(--text)'};font-weight:${isSel ? '700' : '500'}">${esc(label)}</button>`;
        }).join('');
        return `<div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                <div style="font-weight:600;font-size:13px">${esc(g.name || 'Pick')}</div>
                <div style="font-size:11px;color:${isValid ? 'var(--green)' : 'var(--text-muted)'};font-weight:600">${esc(counter)}</div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
        </div>`;
    }).join('');

    const existing = new Set((D.kitchen_list || []).map(i => i.name.toLowerCase()));
    const otherRows = (recipe.ingredients || []).map(ing => {
        const name = (ing.item || '').trim();
        const nameLower = name.toLowerCase();
        if (!name) return '';
        // Skip group members entirely — they're handled by the group chips above
        if (memberSet.has(nameLower)) return '';
        const qty = (ing.qty || '').trim();
        const status = _ingStockingStatus(ing);
        const isNa = status === 'n_a';
        if (isNa) return '';  // hide N/A items from the modal
        const isStocked = status === 'usually_have';
        const onList = existing.has(nameLower);
        const note = ing.note ? ` <span style="color:var(--text-muted);font-size:11px">(${esc(ing.note)})</span>` : '';
        const reasonLabel = onList
            ? ' <span style="color:var(--text-muted);font-size:11px">— already on list</span>'
            : isStocked
                ? ' <span style="color:var(--text-muted);font-size:11px">— usually have</span>'
                : '';
        const main = qty ? `${esc(name)} — <span style="color:var(--text-muted)">${esc(qty)}</span>` : esc(name);
        const checked = (!onList && !isStocked) ? 'checked' : '';
        const opacity = (onList || isStocked) ? 'opacity:0.6' : '';
        return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer;${opacity}">
            <input type="checkbox" data-name="${esc(name)}" ${checked} style="margin:0;cursor:pointer">
            <span style="flex:1;font-size:13px">${main}${note}${reasonLabel}</span>
        </label>`;
    }).filter(Boolean).join('');

    const otherSection = otherRows
        ? `<div ${groups.length ? `style="border-top:1px dashed var(--border);padding-top:10px;margin-top:6px"` : ''}>
            ${groups.length ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Other ingredients</div>' : ''}
            <div id="recipe-send-rows">${otherRows}</div>
        </div>`
        : '<div id="recipe-send-rows"></div>';

    const allGroupsValid = groups.every(g => {
        const selected = window._recipeSendPicks[String(g.id)] || new Set();
        return selected.size === (Number(g.pick_n) || 1);
    });
    const sendDisabled = groups.length > 0 && !allGroupsValid;

    const introText = groups.length
        ? 'Pick from each group below. Other ingredients are toggleable.'
        : "Uncheck anything you don't need to buy.";

    overlay.innerHTML = `
    <div style="background:var(--card-bg);border-radius:12px;padding:20px;max-width:560px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:16px;font-weight:700">Send to grocery list</div>
            <button onclick="closeRecipeSend()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${introText}</div>
        <div style="flex:1;overflow-y:auto;min-height:0;padding-right:6px">
            ${groupBlocks}
            ${otherSection}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
            <button onclick="closeRecipeSend()" style="padding:8px 14px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:13px;cursor:pointer">Cancel</button>
            <button id="recipe-send-confirm-btn" onclick="_doSendRecipeToGrocery('${esc(recipe.id)}')" ${sendDisabled ? 'disabled' : ''} style="padding:8px 16px;background:var(--green);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:${sendDisabled ? 'not-allowed' : 'pointer'};${sendDisabled ? 'opacity:0.5' : ''};margin-left:auto">Add to list</button>
        </div>
    </div>`;
}

function _recipeMemberLabel(recipe, memberName) {
    const ing = (recipe.ingredients || []).find(i => (i.item || '').toLowerCase() === (memberName || '').toLowerCase());
    if (!ing) return memberName;
    const qty = (ing.qty || '').trim();
    return qty ? `${ing.item} · ${qty}` : ing.item;
}

function _recipeSendToggleMember(gid, memberName, pickN) {
    if (!window._recipeSendPicks) window._recipeSendPicks = {};
    const set = window._recipeSendPicks[gid] || new Set();
    if (set.has(memberName)) {
        set.delete(memberName);
    } else {
        if (pickN === 1) set.clear();
        set.add(memberName);
    }
    window._recipeSendPicks[gid] = set;
    _renderRecipeSendModal();
}

function closeRecipeSend() {
    const overlay = document.getElementById('recipe-send-overlay');
    if (overlay) overlay.style.display = 'none';
}

function _recipeSendAllToggle(state) {
    // Skip disabled (N/A) checkboxes — they can never be sent
    document.querySelectorAll('#recipe-send-rows input[type="checkbox"]:not([disabled])').forEach(cb => { cb.checked = state; });
}

async function _doSendRecipeToGrocery(id) {
    const skip = [];
    document.querySelectorAll('#recipe-send-rows input[type="checkbox"]').forEach(cb => {
        if (!cb.checked) skip.push(cb.dataset.name);
    });
    // Serialize group picks
    const picks = {};
    Object.entries(window._recipeSendPicks || {}).forEach(([gid, set]) => {
        picks[gid] = Array.from(set);
    });
    const res = await fetch('/api/kitchen/recipes/to-grocery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, skip, picks })
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    closeRecipeSend();
    const parts = [`Added ${data.added} item${data.added === 1 ? '' : 's'}`];
    if (data.skipped_already_on_list) parts.push(`${data.skipped_already_on_list} already on list`);
    if (data.skipped_unchecked) parts.push(`${data.skipped_unchecked} unchecked`);
    if (data.skipped_na) parts.push(`${data.skipped_na} N/A`);
    if (data.skipped_unpicked) parts.push(`${data.skipped_unpicked} not picked`);
    alert(parts.join(' · '));
    loadDashboard();
}

function pushAllRecipeToGrocery(id) {
    const recipe = (D.recipes || []).find(r => r.id === id);
    if (!recipe) return;
    // If this recipe has choice groups, Push-all only makes sense if we have
    // a last-picks memory. Without one, the user has to make choices → redirect
    // to Pick & send (the picker modal).
    const groups = recipe.choice_groups || [];
    if (groups.length) {
        const hasAllLastPicks = groups.every(g => {
            const gid = String(g.id || '');
            const prev = (recipe.last_picks && recipe.last_picks[gid]) || [];
            return prev.length === (Number(g.pick_n) || 1);
        });
        if (!hasAllLastPicks) {
            // No complete previous selection — go straight to Pick & send
            sendRecipeToGroceryList(id);
            return;
        }
        // Else fall through — the modal preview will reflect the last picks
    }
    const existing = new Set((D.kitchen_list || []).map(i => i.name.toLowerCase()));

    // Bucket every ingredient by what would happen on push.
    // For grouped recipes: only group members in last_picks are "willAdd"; the
    // rest of the group is skippedUnpicked.
    const memberSet = new Set();
    const lastPickSet = new Set();
    groups.forEach(g => {
        const gid = String(g.id || '');
        (g.members || []).forEach(m => memberSet.add((m || '').toLowerCase().trim()));
        ((recipe.last_picks && recipe.last_picks[gid]) || []).forEach(m => lastPickSet.add((m || '').toLowerCase().trim()));
    });

    const willAdd = [];
    const skippedNa = [];
    const skippedStocked = [];
    const skippedOnList = [];
    const skippedUnpicked = [];
    (recipe.ingredients || []).forEach(ing => {
        const name = (ing.item || '').trim();
        if (!name) return;
        const nameLower = name.toLowerCase();
        const status = _ingStockingStatus(ing);
        if (status === 'n_a') { skippedNa.push(ing); return; }
        // Group member: must be in last_picks to be added
        if (memberSet.has(nameLower)) {
            if (lastPickSet.has(nameLower)) {
                if (existing.has(nameLower)) { skippedOnList.push(ing); return; }
                willAdd.push(ing);
            } else {
                skippedUnpicked.push(ing);
            }
            return;
        }
        if (status === 'usually_have') { skippedStocked.push(ing); return; }
        if (existing.has(nameLower)) { skippedOnList.push(ing); return; }
        willAdd.push(ing);
    });

    const fmtRow = (ing, reason) => {
        const qty = (ing.qty || '').trim();
        const tag = reason ? ` <span style="color:var(--text-muted);font-size:11px">— ${esc(reason)}</span>` : '';
        return `<div style="display:flex;gap:12px;padding:4px 0;font-size:13px;align-items:baseline">
            <span style="color:var(--text-muted);min-width:140px;flex-shrink:0;text-align:left">${esc(qty)}</span>
            <span style="flex:1;text-align:left">${esc(ing.item)}${tag}</span>
        </div>`;
    };
    const fmtCheckableRow = (ing, reason) => {
        const qty = (ing.qty || '').trim();
        const tag = reason ? ` <span style="color:var(--text-muted);font-size:11px">— ${esc(reason)}</span>` : '';
        return `<label style="display:flex;gap:10px;padding:4px 0;font-size:13px;align-items:baseline;cursor:pointer">
            <input type="checkbox" data-pushall-include="${esc(ing.item)}" onchange="_pushAllUpdateCount(${willAdd.length})" style="margin:0;cursor:pointer;flex-shrink:0">
            <span style="color:var(--text-muted);min-width:130px;flex-shrink:0;text-align:left">${esc(qty)}</span>
            <span style="flex:1;text-align:left">${esc(ing.item)}${tag}</span>
        </label>`;
    };

    const addList = willAdd.length
        ? willAdd.map(i => fmtRow(i)).join('')
        : '<div style="color:var(--text-muted);font-size:13px;font-style:italic">Nothing new to add by default — but you can opt in usually-have items below.</div>';

    const stockedBlock = skippedStocked.length
        ? `<div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--border)">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Usually have — tap to also send:</div>
            ${skippedStocked.map(i => fmtCheckableRow(i)).join('')}
        </div>`
        : '';

    const skipBits = [
        ...skippedOnList.map(i => fmtRow(i, 'already on list')),
        ...skippedNa.map(i => fmtRow(i, 'N/A')),
    ];
    const skipBlock = skipBits.length
        ? `<details style="margin-top:14px"><summary style="cursor:pointer;font-size:12px;color:var(--text-muted)">Skipping ${skipBits.length} item${skipBits.length === 1 ? '' : 's'} — show details</summary><div style="padding-top:6px;opacity:0.7">${skipBits.join('')}</div></details>`
        : '';

    let overlay = document.getElementById('recipe-pushall-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'recipe-pushall-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:70;display:flex;align-items:center;justify-content:center;padding:16px;';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.onclick = (e) => { if (e.target === overlay) closeRecipePushAll(); };

    const confirmDisabled = willAdd.length === 0;
    overlay.innerHTML = `
    <div style="background:var(--card-bg);border-radius:12px;padding:20px;max-width:520px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,0.4)">
        <div id="recipe-pushall-body" style="flex:1;min-height:0;overflow-y:auto">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                <div style="font-size:16px;font-weight:700">Push to grocery list</div>
                <button onclick="closeRecipePushAll()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer">&times;</button>
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Adding <span id="pushall-count">${willAdd.length}</span> item${willAdd.length === 1 ? '' : 's'} from <b>${esc(recipe.name)}</b></div>
            <div style="border-top:1px solid var(--border);padding-top:10px">${addList}</div>
            ${stockedBlock}
            ${skipBlock}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
            <button onclick="closeRecipePushAll()" style="padding:8px 14px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:13px;cursor:pointer">Cancel</button>
            <button id="pushall-confirm-btn" onclick="_doPushAllConfirm('${esc(id)}')" ${confirmDisabled ? 'disabled' : ''} style="padding:8px 16px;background:var(--green);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:${confirmDisabled ? 'not-allowed' : 'pointer'};${confirmDisabled ? 'opacity:0.5' : ''};margin-left:auto">Add to list</button>
        </div>
    </div>`;
}

function closeRecipePushAll() {
    const overlay = document.getElementById('recipe-pushall-overlay');
    if (overlay) overlay.style.display = 'none';
}

function _pushAllUpdateCount(baseCount) {
    const optIns = document.querySelectorAll('#recipe-pushall-body input[data-pushall-include]:checked').length;
    const total = baseCount + optIns;
    const span = document.getElementById('pushall-count');
    if (span) span.textContent = total;
    const btn = document.getElementById('pushall-confirm-btn');
    if (btn) {
        if (total > 0) {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor = 'pointer';
        } else {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
        }
    }
}

async function _doPushAllConfirm(id) {
    const recipe = (D.recipes || []).find(r => r.id === id);
    if (!recipe) return;
    // Read which usually-have items the user opted into via checkbox.
    const optedIn = new Set();
    document.querySelectorAll('#recipe-pushall-body input[data-pushall-include]:checked').forEach(cb => {
        optedIn.add(cb.dataset.pushallInclude);
    });
    // For grouped recipes, pass last_picks as the picks (backend uses these to
    // know which group members to send).
    const picks = recipe.last_picks || {};
    const skip = (recipe.ingredients || [])
        .filter(ing => {
            const status = _ingStockingStatus(ing);
            const name = (ing.item || '').trim();
            if (!name) return false;
            if (status === 'n_a') return true;
            if (status === 'usually_have' && !optedIn.has(name)) return true;
            return false;
        })
        .map(ing => ing.item.trim());
    const res = await fetch('/api/kitchen/recipes/to-grocery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, skip, picks })
    });
    const data = await res.json();
    const body = document.getElementById('recipe-pushall-body');
    if (data.error) {
        if (body) body.innerHTML = `<div style="color:var(--red);padding:10px 0">Error: ${esc(data.error)}</div>`;
        return;
    }
    const skipParts = [];
    if (data.skipped_already_on_list) skipParts.push(`${data.skipped_already_on_list} already on list`);
    if (data.skipped_na) skipParts.push(`${data.skipped_na} N/A`);
    if (data.skipped_unchecked) skipParts.push(`${data.skipped_unchecked} usually-on-hand`);
    if (body) {
        body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:16px;font-weight:700;color:var(--green)">✓ Added to grocery list</div>
            <button onclick="closeRecipePushAll()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer">&times;</button>
        </div>
        <div style="padding:14px 0;font-size:14px">Added <b>${data.added}</b> item${data.added === 1 ? '' : 's'}.</div>
        ${skipParts.length ? `<div style="font-size:12px;color:var(--text-muted)">Skipped: ${skipParts.join(' · ')}</div>` : ''}`;
    }
    // Auto-close after a short beat, but the user can also click ×/Close.
    setTimeout(closeRecipePushAll, 1800);
    loadDashboard();
}

function removeRecipe(id, name) {
    pendingDelete = { item: id, type: 'recipe-item', label: name };
    document.getElementById('modal-text').innerHTML = `Remove the recipe <b>${esc(name)}</b>?`;
    document.getElementById('modal').classList.add('open');
}

// =====================================================
// Purchase History (sortable spreadsheet — replaces Pantry)
// =====================================================

function _purchaseHistorySort() {
    return localStorage.getItem('purchase_history_sort') || 'last_bought_desc';
}
function setPurchaseHistorySort(mode) {
    localStorage.setItem('purchase_history_sort', mode);
    renderGroceryList();
}

function _renderPurchaseHistorySection(known, counts) {
    const lastBought = D.kitchen_last_bought || {};
    const tags = D.kitchen_safety_tags || {};
    const items = Object.entries(known).map(([name, cat]) => {
        const lb = lastBought[name];
        const lbDate = lb ? new Date(lb + 'T12:00:00') : null;
        const daysSince = lbDate ? Math.round((Date.now() - lbDate.getTime()) / 86400000) : null;
        return {
            name,
            category: cat || 'other',
            count: counts[name] || 0,
            lastBought: lb || null,
            daysSince,
            safety: tags[name] || '',
        };
    });

    const sortMode = _purchaseHistorySort();
    const sorters = {
        name_asc: (a, b) => a.name.localeCompare(b.name),
        name_desc: (a, b) => b.name.localeCompare(a.name),
        category_asc: (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
        count_desc: (a, b) => (b.count - a.count) || a.name.localeCompare(b.name),
        count_asc: (a, b) => (a.count - b.count) || a.name.localeCompare(b.name),
        last_bought_desc: (a, b) => {
            if (a.lastBought && !b.lastBought) return -1;
            if (!a.lastBought && b.lastBought) return 1;
            if (a.lastBought && b.lastBought) return b.lastBought.localeCompare(a.lastBought);
            return a.name.localeCompare(b.name);
        },
        last_bought_asc: (a, b) => {
            if (a.lastBought && !b.lastBought) return 1;
            if (!a.lastBought && b.lastBought) return -1;
            if (a.lastBought && b.lastBought) return a.lastBought.localeCompare(b.lastBought);
            return a.name.localeCompare(b.name);
        },
    };
    items.sort(sorters[sortMode] || sorters.last_bought_desc);

    const flipped = sortMode.endsWith('_desc')
        ? { name: 'name_asc', category: 'category_asc', count: 'count_asc', last_bought: 'last_bought_asc' }
        : { name: 'name_desc', category: 'category_desc', count: 'count_desc', last_bought: 'last_bought_desc' };
    const curCol = sortMode.replace(/_(asc|desc)$/, '');
    const curDir = sortMode.endsWith('_desc') ? '↓' : '↑';
    const headerCell = (col, label) => {
        const next = sortMode.startsWith(col + '_') ? flipped[col] : (col + '_desc');
        const indicator = sortMode.startsWith(col + '_') ? ` ${curDir}` : '';
        return `<th onclick="setPurchaseHistorySort('${next}')" style="padding:8px;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;cursor:pointer;user-select:none;text-align:left;background:var(--bg-card);position:sticky;top:0">${esc(label)}${indicator}</th>`;
    };

    const rows = items.map(it => {
        const label = it.name.charAt(0).toUpperCase() + it.name.slice(1);
        let dateLabel = '—';
        if (it.lastBought) {
            const days = it.daysSince;
            if (days === 0) dateLabel = 'today';
            else if (days === 1) dateLabel = 'yesterday';
            else if (days < 30) dateLabel = `${days}d ago`;
            else if (days < 365) dateLabel = `${Math.round(days / 7)}w ago`;
            else dateLabel = `${Math.round(days / 365 * 10) / 10}y ago`;
        }
        const safetyIcon = it.safety === 'safe' ? '<span style="color:var(--green);font-weight:700" title="Safe">✓</span>'
            : it.safety === 'suspect' ? '<span style="color:var(--orange);font-weight:700" title="Suspect">⚠</span>'
            : '';
        return `<tr>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:13px">${esc(label)} ${safetyIcon}</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-muted)">${esc(it.category)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-muted);text-align:right">${it.count}</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px;color:${it.lastBought ? 'var(--text)' : 'var(--text-muted)'}">${esc(dateLabel)}</td>
        </tr>`;
    }).join('');

    return `<details class="kitchen-section">
        <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;transition:transform 0.15s;display:inline-block" class="kitchen-arrow">&#9654;</span>
            Purchase history <span style="font-size:13px;font-weight:400;color:var(--text-muted)">(${items.length} items)</span>
        </summary>
        <div style="font-size:11px;color:var(--text-muted);margin:6px 0 8px">Tap column headers to sort.</div>
        <div style="max-height:50vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
            <table style="width:100%;border-collapse:collapse">
                <thead><tr>
                    ${headerCell('name', 'Item')}
                    ${headerCell('category', 'Category')}
                    ${headerCell('count', '#')}
                    ${headerCell('last_bought', 'Last bought')}
                </tr></thead>
                <tbody>${rows || `<tr><td colspan="4" style="padding:14px;font-size:13px;color:var(--text-muted);font-style:italic;text-align:center">No catalog items yet.</td></tr>`}</tbody>
            </table>
        </div>
    </details>`;
}

// =====================================================
// Body tab: safe foods + suspect foods chip clouds
// =====================================================

function _renderSafetyChip(name, tag) {
    const label = (name || '').charAt(0).toUpperCase() + (name || '').slice(1);
    const color = tag === 'safe' ? 'var(--green)' : tag === 'inflammatory' ? '#c2185b' : 'var(--orange)';
    const bg = tag === 'safe' ? 'rgba(58,158,140,0.10)' : tag === 'inflammatory' ? 'rgba(194,24,91,0.10)' : 'rgba(212,140,68,0.10)';
    const border = tag === 'safe' ? 'rgba(58,158,140,0.35)' : tag === 'inflammatory' ? 'rgba(194,24,91,0.35)' : 'rgba(212,140,68,0.35)';
    return `<span style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid ${border};border-radius:14px;background:${bg};color:${color};font-size:13px;margin:3px">
        ${esc(label)}
        <button onclick="setSafetyTag('${esc(name)}','')" title="Clear tag" style="background:none;border:none;color:${color};opacity:0.65;font-size:14px;cursor:pointer;line-height:1;padding:0 2px">&times;</button>
    </span>`;
}

// =====================================================
// Food experiments — elimination diet pacing (Body tab)
// =====================================================

function renderFoodExperiments() {
    const el = document.getElementById('food-experiments-area');
    if (!el) return;
    const tests = D.food_tests || [];
    const queue = D.food_test_queue || [];

    const active = tests.find(t => !t.outcome);
    const recovering = active ? null : [...tests].reverse().find(t => t.outcome === 'flared' && !t.cleared_baseline_on);
    const state = active ? 'testing' : recovering ? 'recovering' : 'clear';

    const past = tests.filter(t => t.outcome).slice().reverse();

    let html = '';

    // Intro
    html += `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
        Controlled reintroduction. One test at a time, 3-day rest window between.
        Auto-tags <b style="color:var(--green)">safe</b> when cleared,
        <b style="color:var(--orange)">suspect</b> when flared.
    </div>`;

    // Active test block
    if (active) {
        const todayD = new Date(); todayD.setHours(0,0,0,0);
        const startD = new Date(active.started_on + 'T00:00:00');
        const dayN = Math.max(1, Math.floor((todayD - startD) / 86400000) + 1);
        const canResolveClear = dayN >= active.watch_window_days;
        html += `<div style="border:1px solid var(--accent);border-left:3px solid var(--accent);background:rgba(124,92,191,0.06);border-radius:8px;padding:14px;margin-bottom:14px">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Testing</div>
            <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px">${esc(active.food)}</div>
            <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px">
                Day ${dayN} of ${active.watch_window_days} · started ${esc(active.started_on)} · clears ${esc(active.results_due_on)}
            </div>
            ${active.notes ? `<div style="font-size:13px;color:var(--text);font-style:italic;margin-bottom:10px">${esc(active.notes)}</div>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button onclick="_foodTestResolve('${esc(active.id)}','cleared')" ${canResolveClear ? '' : 'disabled'} title="${canResolveClear ? 'Mark this food cleared (auto-tags it safe)' : 'Available on day ' + active.watch_window_days}" style="padding:6px 14px;background:${canResolveClear ? 'var(--green)' : 'none'};color:${canResolveClear ? '#fff' : 'var(--text-muted)'};border:1px solid var(--green);border-radius:6px;font-size:13px;font-weight:600;cursor:${canResolveClear ? 'pointer' : 'not-allowed'};opacity:${canResolveClear ? '1' : '0.5'}">&#10003; Mark cleared</button>
                <button onclick="_foodTestResolve('${esc(active.id)}','flared')" style="padding:6px 14px;background:var(--orange);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">&#9888; Mark flared</button>
                <button onclick="_foodTestExtend('${esc(active.id)}',2)" style="padding:6px 12px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer">+2 days</button>
                <button onclick="_foodTestCancel('${esc(active.id)}')" style="padding:6px 12px;background:none;color:var(--red);border:1px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer;margin-left:auto">Cancel test</button>
            </div>
        </div>`;
    }

    // Recovering block
    if (recovering) {
        html += `<div style="border:1px solid var(--orange);border-left:3px solid var(--orange);background:rgba(212,140,68,0.06);border-radius:8px;padding:14px;margin-bottom:14px">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Recovering</div>
            <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px">Last flare: ${esc(recovering.food)}</div>
            <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Flared on ${esc(recovering.outcome_at || recovering.started_on)}.</div>
            ${recovering.flare_notes ? `<div style="font-size:13px;color:var(--text);font-style:italic;margin-bottom:10px">"${esc(recovering.flare_notes)}"</div>` : ''}
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">No new tests until you're back to baseline. Watch your symptoms; mark below when nose / brain / gut feel back to normal.</div>
            <button onclick="_foodTestClearBaseline()" style="padding:7px 14px;background:var(--green);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">I'm back to baseline — ready for next experiment</button>
        </div>`;
    }

    // Clear / queue block
    if (state === 'clear') {
        const nextUp = queue[0];
        html += `<div style="border:1px solid var(--green);border-left:3px solid var(--green);background:rgba(58,158,140,0.06);border-radius:8px;padding:14px;margin-bottom:14px">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Ready</div>
            <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px">Baseline clear — ready for next experiment.</div>
            ${nextUp
                ? `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="font-size:13px">Next up: <b>${esc(nextUp)}</b></span><button onclick="_foodTestStart('${esc(nextUp).replace(/'/g, "\\'")}')" style="padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Start test</button></div>`
                : `<div style="font-size:13px;color:var(--text-muted)">No foods queued yet. Add some below.</div>`}
        </div>`;
    }

    // Queue management
    html += `<details ${state === 'clear' ? '' : 'open'} style="margin-bottom:14px">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;padding:6px 0;color:var(--text-muted)">Queue (${queue.length})</summary>
        <div style="padding-top:8px">`;
    if (queue.length) {
        html += queue.map((f, i) => `<div style="display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid var(--border)">
            <span style="font-size:11px;color:var(--text-muted);width:24px;text-align:right">${i + 1}.</span>
            <span style="flex:1;font-size:13px">${esc(f)}</span>
            <button onclick="_foodTestQueueMove('${esc(f).replace(/'/g, "\\'")}',-1)" ${i === 0 ? 'disabled' : ''} style="background:none;border:none;color:var(--text-muted);font-size:11px;cursor:${i === 0 ? 'not-allowed' : 'pointer'};padding:2px 6px;opacity:${i === 0 ? '0.3' : '1'}">&#9650;</button>
            <button onclick="_foodTestQueueMove('${esc(f).replace(/'/g, "\\'")}',1)" ${i === queue.length - 1 ? 'disabled' : ''} style="background:none;border:none;color:var(--text-muted);font-size:11px;cursor:${i === queue.length - 1 ? 'not-allowed' : 'pointer'};padding:2px 6px;opacity:${i === queue.length - 1 ? '0.3' : '1'}">&#9660;</button>
            <button onclick="_foodTestQueueRemove('${esc(f).replace(/'/g, "\\'")}')" style="background:none;border:none;color:var(--red);font-size:14px;cursor:pointer;padding:2px 6px">&times;</button>
        </div>`).join('');
    } else {
        html += `<div style="color:var(--text-muted);font-size:13px;padding:6px 0;font-style:italic">Queue is empty. Add foods you want to test next.</div>`;
    }
    html += `<div style="display:flex;gap:6px;margin-top:10px">
        <input type="text" id="food-test-queue-input" placeholder="Food to add to queue…" onkeydown="if(event.key==='Enter')_foodTestQueueAdd()" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
        <button onclick="_foodTestQueueAdd()" style="padding:6px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">+ Add</button>
    </div>`;
    html += `</div></details>`;

    // Past tests
    if (past.length) {
        html += `<details style="margin-bottom:14px">
            <summary style="cursor:pointer;font-size:13px;font-weight:600;padding:6px 0;color:var(--text-muted)">Past experiments (${past.length})</summary>
            <div style="padding-top:8px">${past.map(t => {
                const icon = t.outcome === 'cleared' ? '<span style="color:var(--green);font-weight:700">&#10003;</span>' : '<span style="color:var(--orange);font-weight:700">&#9888;</span>';
                const note = t.flare_notes ? ` — <span style="font-style:italic;color:var(--text-muted)">"${esc(t.flare_notes)}"</span>` : '';
                return `<div style="padding:6px 4px;border-bottom:1px solid var(--border);font-size:13px;display:flex;gap:8px;align-items:center">
                    ${icon}
                    <span style="color:var(--text-muted);font-size:11px;min-width:90px">${esc(t.started_on)} → ${esc(t.outcome_at || '—')}</span>
                    <span style="flex:1"><b>${esc(t.food)}</b> — ${esc(t.outcome)}${note}</span>
                </div>`;
            }).join('')}</div>
        </details>`;
    }

    // Retroactive flare log
    html += `<details style="margin-bottom:6px">
        <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);padding:6px 0">Log a flare that happened from regular eating (not a test) ▾</summary>
        <div style="padding-top:8px;border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--card-bg)">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Records a retroactive flared event. Puts you in recovering state until you mark baseline clear. Use this for tonight's beans+ACV case.</div>
            <input type="text" id="food-test-retro-food" placeholder="What did you eat? (e.g. 'beans + ACV')" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;margin-bottom:6px;box-sizing:border-box">
            <input type="text" id="food-test-retro-notes" placeholder="Symptoms? (e.g. 'nose congestion, noticeable')" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;margin-bottom:8px;box-sizing:border-box">
            <button onclick="_foodTestLogRetro()" ${active ? 'disabled' : ''} style="padding:7px 14px;background:${active ? 'none' : 'var(--orange)'};color:${active ? 'var(--text-muted)' : '#fff'};border:1px solid var(--orange);border-radius:6px;font-size:13px;font-weight:600;cursor:${active ? 'not-allowed' : 'pointer'}">Log retroactive flare</button>
        </div>
    </details>`;

    el.innerHTML = html;
}

async function _foodTestStart(food) {
    const res = await fetch('/api/body/test/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ food })
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    loadDashboard();
}

async function _foodTestResolve(id, outcome) {
    let flare_notes = '';
    if (outcome === 'flared') {
        flare_notes = prompt('What symptoms / how bad? (optional)') || '';
    } else {
        if (!confirm('Mark this test cleared? The food will be tagged safe in your catalog.')) return;
    }
    const res = await fetch('/api/body/test/outcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, outcome, flare_notes })
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    loadDashboard();
}

async function _foodTestExtend(id, days) {
    await fetch('/api/body/test/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, days })
    });
    loadDashboard();
}

async function _foodTestCancel(id) {
    if (!confirm('Cancel this test entirely? No outcome will be recorded.')) return;
    await fetch('/api/body/test/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    loadDashboard();
}

async function _foodTestClearBaseline() {
    await fetch('/api/body/test/clear-baseline', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    loadDashboard();
}

async function _foodTestQueueAdd() {
    const inp = document.getElementById('food-test-queue-input');
    if (!inp) return;
    const food = inp.value.trim();
    if (!food) return;
    const res = await fetch('/api/body/test/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ food })
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    inp.value = '';
    loadDashboard();
}

async function _foodTestQueueRemove(food) {
    await fetch('/api/body/test/queue/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ food })
    });
    loadDashboard();
}

async function _foodTestQueueMove(food, delta) {
    const queue = (D.food_test_queue || []).slice();
    const idx = queue.findIndex(f => f.toLowerCase() === food.toLowerCase());
    if (idx === -1) return;
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= queue.length) return;
    const moved = queue.splice(idx, 1)[0];
    queue.splice(newIdx, 0, moved);
    await fetch('/api/body/test/queue/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: queue })
    });
    loadDashboard();
}

async function _foodTestLogRetro() {
    const food = document.getElementById('food-test-retro-food').value.trim();
    const flare_notes = document.getElementById('food-test-retro-notes').value.trim();
    if (!food) { alert('What did you eat?'); return; }
    const res = await fetch('/api/body/test/log-retro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ food, flare_notes })
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    loadDashboard();
}

function renderFoodTriage() {
    const el = document.getElementById('triage-foods-area');
    if (!el) return;
    const known = D.kitchen_known_items || {};
    const tags = D.kitchen_safety_tags || {};
    const lastBought = D.kitchen_last_bought || {};
    const counts = D.kitchen_purchase_counts || {};
    // Untagged catalog items, sorted by purchase count (most-bought first — those
    // matter most to triage), then alphabetically
    const items = Object.keys(known)
        .filter(name => !tags[name])
        .map(name => ({
            name,
            count: counts[name] || 0,
            lastBought: lastBought[name] || null,
        }))
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

    if (!items.length) {
        el.innerHTML = `<div style="color:var(--green);font-size:13px;padding:8px 0;font-style:italic">🎉 Every food in your catalog is tagged. Nice triage work.</div>`;
        return;
    }

    const intro = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
        ${items.length} food${items.length === 1 ? '' : 's'} waiting to be triaged. Tap <b style="color:var(--green)">✓ Safe</b> when you've confirmed it doesn't bother you, <b style="color:var(--orange)">⚠ Suspect</b> when you think it might, <b style="color:#c2185b">🔥 Inflammatory</b> for known inflammatory triggers. Most-bought items first.
    </div>`;

    const rows = items.map(it => {
        const label = it.name.charAt(0).toUpperCase() + it.name.slice(1);
        const meta = [];
        if (it.count) meta.push(`bought ${it.count}×`);
        if (it.lastBought) {
            const lb = new Date(it.lastBought + 'T12:00:00');
            const days = Math.round((Date.now() - lb.getTime()) / 86400000);
            meta.push(days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days}d ago` : `${Math.round(days/7)}w ago`);
        }
        const metaText = meta.length ? `<span style="font-size:11px;color:var(--text-muted);margin-left:8px">${esc(meta.join(' · '))}</span>` : '';
        return `<div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid var(--border)">
            <span style="flex:1;font-size:14px">${esc(label)}${metaText}</span>
            <button onclick="triageMark('${esc(it.name)}','safe')" title="Mark confirmed safe" style="padding:5px 12px;border:1px solid var(--green);background:none;color:var(--green);border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">&#10003; Safe</button>
            <button onclick="triageMark('${esc(it.name)}','suspect')" title="Mark suspect" style="padding:5px 12px;border:1px solid var(--orange);background:none;color:var(--orange);border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">&#9888; Suspect</button>
            <button onclick="triageMark('${esc(it.name)}','inflammatory')" title="Mark known inflammatory" style="padding:5px 12px;border:1px solid #c2185b;background:none;color:#c2185b;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">&#128293; Inflammatory</button>
        </div>`;
    }).join('');

    el.innerHTML = intro + `<div style="max-height:60vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:4px 12px">${rows}</div>`;
}

async function triageMark(name, tag) {
    await fetch('/api/kitchen/safety-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tag })
    });
    D.kitchen_safety_tags = D.kitchen_safety_tags || {};
    D.kitchen_safety_tags[name.toLowerCase()] = tag;
    // Local re-render of just the body-tab sections — no full page reload, less jarring
    renderFoodTriage();
    renderSafeFoods();
    renderSuspectFoods();
    renderInflammatoryFoods();
}

function renderSafeFoods() {
    const el = document.getElementById('safe-foods-area');
    if (!el) return;
    const tags = D.kitchen_safety_tags || {};
    const items = Object.entries(tags).filter(([_, t]) => t === 'safe').map(([n, _]) => n).sort();
    if (!items.length) {
        el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:8px 0;font-style:italic">No foods marked safe yet. In <b>Edit Catalog</b>, tap the ✓ on a row to mark a food confirmed-safe.</div>`;
        return;
    }
    el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:2px;padding:6px 0">${items.map(n => _renderSafetyChip(n, 'safe')).join('')}</div>`;
}

function renderSuspectFoods() {
    const el = document.getElementById('suspect-foods-area');
    if (!el) return;
    const tags = D.kitchen_safety_tags || {};
    const items = Object.entries(tags).filter(([_, t]) => t === 'suspect').map(([n, _]) => n).sort();
    if (!items.length) {
        el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:8px 0;font-style:italic">No suspect foods flagged. In <b>Edit Catalog</b>, tap the ⚠ on a row when you spot a possible trigger.</div>`;
        return;
    }
    el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:2px;padding:6px 0">${items.map(n => _renderSafetyChip(n, 'suspect')).join('')}</div>`;
}

function renderInflammatoryFoods() {
    const el = document.getElementById('inflammatory-foods-area');
    if (!el) return;
    const tags = D.kitchen_safety_tags || {};
    const items = Object.entries(tags).filter(([_, t]) => t === 'inflammatory').map(([n, _]) => n).sort();
    if (!items.length) {
        el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:8px 0;font-style:italic">No inflammatory foods flagged. Tap <b style="color:#c2185b">🔥 Inflammatory</b> in Triage foods to flag a known trigger.</div>`;
        return;
    }
    el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:2px;padding:6px 0">${items.map(n => _renderSafetyChip(n, 'inflammatory')).join('')}</div>`;
}

async function setSafetyTag(name, tag) {
    await fetch('/api/kitchen/safety-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tag })
    });
    loadDashboard();
}
