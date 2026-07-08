// kitchen-recipes.js — recipe pipeline: URL/image parse → approval → save,
// view/edit, send-to-grocery, push-all. Split out of kitchen.js.
// Plain (non-module) script: every function here is a global, called from
// inline on* handlers and from kitchen.js's list render at click/render time.
// Load order is not load-bearing (globals resolve at call-time); loaded right
// after kitchen.js for tidiness. Shared list state lives in kitchen.js.

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

let _recipeSearch = '';  // live filter, typed in the recipe list search bar

function recipeSearchInput(val) {
    _recipeSearch = val;
    renderGroceryList();
    const el = document.getElementById('recipe-search-input');
    if (el) {
        el.focus();
        el.setSelectionRange(val.length, val.length);
    }
}

function setRecipeSort(mode) {
    localStorage.setItem('kitchen_recipe_sort', mode);
    renderGroceryList();
}

function renderRecipeCards(recipes) {
    // Only show un-archived recipes in the main list. Archived ones live
    // under the "Past versions" section on each current recipe's detail page.
    const visible = recipes.filter(r => !r.is_archived);
    if (!visible.length) {
        return '<div style="color:var(--text-muted);font-size:13px;font-style:italic;padding:8px 0">No saved recipes yet. Paste a URL above to get started.</div>';
    }

    const sortMode = localStorage.getItem('kitchen_recipe_sort') || 'name';
    const search = (_recipeSearch || '').trim().toLowerCase();
    const filtered = search
        ? visible.filter(r => {
            if ((r.name || '').toLowerCase().includes(search)) return true;
            return (r.ingredients || []).some(i => (i.item || '').toLowerCase().includes(search));
        })
        : visible;
    const sorted = filtered.slice().sort((a, b) => {
        if (sortMode === 'added') return (b.created || '').localeCompare(a.created || '');
        if (sortMode === 'time') {
            const ta = (Number(a.prep_min) || 0) + (Number(a.cook_min) || 0);
            const tb = (Number(b.prep_min) || 0) + (Number(b.cook_min) || 0);
            return ta - tb;
        }
        return (a.name || '').localeCompare(b.name || '');
    });

    const sortBtn = (mode, label) => {
        const active = mode === sortMode;
        return `<button onclick="setRecipeSort('${mode}')" style="min-height:28px;padding:3px 9px;border-radius:6px;border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};background:${active ? 'rgba(124,92,191,0.12)' : 'none'};color:${active ? 'var(--accent)' : 'var(--text-muted)'};font-size:12px;font-weight:${active ? '700' : '500'};cursor:pointer">${esc(label)}</button>`;
    };
    const bar = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <input type="text" id="recipe-search-input" value="${esc(_recipeSearch)}" placeholder="Search recipes or ingredients…" oninput="recipeSearchInput(this.value)" style="flex:1;min-width:160px;min-height:40px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box">
        <span style="display:inline-flex;gap:4px" title="Sort by">
            ${sortBtn('name', 'Name')}
            ${sortBtn('added', 'Added')}
            ${sortBtn('time', 'Time')}
        </span>
    </div>`;

    if (!sorted.length) {
        return bar + '<div style="color:var(--text-muted);font-size:13px;font-style:italic;padding:8px 0">No recipes match your search.</div>';
    }

    return bar + sorted.map(r => {
        const tags = (r.tags || []).map(t => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:rgba(124,92,191,0.15);color:var(--accent);font-size:12px;font-weight:600;margin-right:4px">${esc(t)}</span>`).join('');
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
                    <button onclick="event.stopPropagation();sendRecipeToGroceryList('${esc(r.id)}')" style="padding:5px 10px;background:var(--green);border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer" title="Pick ingredients (the ones you need are pre-checked) and add to your grocery list">Send to list</button>
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
            <div style="font-size:12px;color:var(--text-muted)">Source: ${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" style="color:var(--ongoing);text-decoration:none">${esc(r.source_url)}</a>` : r.source_image ? esc(r.source_image) : '—'}</div>
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
        `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:rgba(124,92,191,0.15);color:var(--accent);font-size:12px;font-weight:600;margin-right:4px">${esc(t)}</span>`
    ).join('');
    const metaBits = [];
    if (recipe.servings) metaBits.push(`${recipe.servings} servings`);
    if (recipe.prep_min) metaBits.push(`${recipe.prep_min} min prep`);
    if (recipe.cook_min) metaBits.push(`${recipe.cook_min} min cook`);

    el.innerHTML = `
    <div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
            <button onclick="closeRecipeDetail()" style="display:inline-flex;align-items:center;gap:6px;min-height:40px;font-size:13px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:6px;padding:6px 12px;cursor:pointer">← Back</button>
            <div style="flex:1 1 auto;display:flex;justify-content:center;min-width:120px">
                <button onclick="sendRecipeToGroceryList('${esc(recipe.id)}')" style="min-height:40px;padding:6px 18px;background:var(--green);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Pick ingredients (the ones you need are pre-checked) and add to your grocery list">Send to list</button>
            </div>
            <button onclick="editRecipe('${esc(recipe.id)}')" style="min-height:40px;padding:6px 14px;background:none;color:var(--text);border:1px solid var(--accent);border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Edit</button>
        </div>
        <div style="font-size:22px;font-weight:700;margin-bottom:4px">${esc(recipe.name)}</div>
        ${metaBits.length ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${esc(metaBits.join(' · '))}</div>` : ''}
        <div style="margin-bottom:18px">${tags}${recipe.source_url ? `<a href="${esc(recipe.source_url)}" target="_blank" rel="noopener" style="color:var(--ongoing);font-size:12px;text-decoration:none">source ↗</a>` : ''}</div>
        <div style="font-weight:700;margin-bottom:6px;font-size:16px">Ingredients</div>
        <ul style="margin:0 0 18px 18px;padding:0">${ingredients}</ul>
        ${_renderRecipeSourcing(recipe)}
        <div style="font-weight:700;margin-bottom:6px;font-size:16px">Instructions</div>
        ${instructionsHtml}
        ${recipe.notes ? `<div style="font-style:italic;color:var(--text-muted);font-size:13px;padding:10px 0;border-top:1px solid var(--border)">${esc(recipe.notes)}</div>` : ''}
        <div style="padding-top:14px;border-top:1px solid var(--border);margin-top:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <div style="font-weight:700;font-size:15px">My notes</div>
                <div id="recipe-my-notes-status" style="font-size:12px;color:var(--text-muted)"></div>
            </div>
            <textarea id="recipe-my-notes-text" data-id="${esc(recipe.id)}" rows="4" placeholder="What you tweaked, how it turned out, who liked it…" oninput="_recipeMyNotesDirty();autoGrow(this)" onblur="_recipeMyNotesSave()" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;font-family:inherit;resize:vertical;box-sizing:border-box;max-height:300px;overflow-y:auto">${esc(recipe.my_notes || '')}</textarea>
        </div>
        ${_renderRecipePastVersions(recipe)}
    </div>`;
    // Open "My notes" at the height of what's already written (it also grows as
    // she types — a drag-resize handle doesn't exist on touch).
    const mn = document.getElementById('recipe-my-notes-text');
    if (mn && mn.value) autoGrow(mn);
}

// "Where it comes from" — a sourcing summary for the recipe, matching each
// ingredient to a placed ecosystem source (or marking it untraced / pantry). The
// "View on map" button deep-links to the Ecosystem tab with this recipe selected.
function _renderRecipeSourcing(recipe) {
    if (typeof ecoRecipeSourcing !== 'function') return '';
    const sources = (D.ecosystem && D.ecosystem.sources) || [];
    const s = ecoRecipeSourcing(recipe, sources);
    if (!s.total) return '';
    const txOf = (src) => (typeof ECO_TX !== 'undefined' && ECO_TX[src.transparency]) || { color: '#9aa0a6', label: 'unrated' };
    const dot = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};flex:none"></span>`;
    const tracedRows = s.traced.map(t => {
        const tx = txOf(t.source);
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px">
            ${dot(tx.color)}
            <span style="flex:1;color:var(--text)">${esc(t.ing.item)}</span>
            <span style="color:var(--text-muted);font-size:12px">${esc(t.source.name)}</span>
        </div>`;
    }).join('');
    const body = tracedRows || `<div style="font-size:13px;color:var(--text-muted)">Nothing traced yet — place these foods on the map.</div>`;
    const placeRow = s.place.length
        ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Not yet traced: ${s.place.map(p => esc(p.ing.item)).join(', ')}</div>`
        : '';
    const pantryRow = s.pantry.length
        ? `<div style="margin-top:4px;font-size:12px;color:var(--text-muted);opacity:.7">+ ${s.pantry.length} pantry staple${s.pantry.length === 1 ? '' : 's'} (not traced)</div>`
        : '';
    const jump = `<button onclick="switchTab(event,'ecosystem',{recipe:'${esc(recipe.id)}'})" style="min-height:40px;padding:6px 14px;margin-top:12px;background:none;color:var(--accent);border:1px solid var(--accent);border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">View on map &rarr;</button>`;
    return `<details class="kitchen-section" data-card="recipe-sourcing" open style="margin:0 0 18px;border:1px solid var(--border);border-radius:10px;padding:0 12px">
        <summary style="font-size:15px;font-weight:700;cursor:pointer;padding:12px 0;list-style:none;display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;transition:transform .15s;display:inline-block" class="kitchen-arrow">&#9654;</span>
            Where it comes from
            <span style="font-size:12px;font-weight:400;color:var(--text-muted)">traced ${s.traced.length}/${s.total}</span>
        </summary>
        <div style="padding:0 0 12px">
            ${body}
            ${placeRow}
            ${pantryRow}
            ${jump}
        </div>
    </details>`;
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
            <button onclick="viewRecipe('${esc(r.id)}')" style="padding:3px 10px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:12px;cursor:pointer">View</button>
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
                <button onclick="_moveEditStep(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Move up" style="background:none;border:none;color:var(--text-muted);font-size:12px;cursor:${i === 0 ? 'not-allowed' : 'pointer'};padding:1px 5px;line-height:1;opacity:${i === 0 ? '0.3' : '1'}">&#9650;</button>
                <button onclick="_moveEditStep(${i}, 1)" ${i === stepCount - 1 ? 'disabled' : ''} title="Move down" style="background:none;border:none;color:var(--text-muted);font-size:12px;cursor:${i === stepCount - 1 ? 'not-allowed' : 'pointer'};padding:1px 5px;line-height:1;opacity:${i === stepCount - 1 ? '0.3' : '1'}">&#9660;</button>
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
            <textarea id="recipe-edit-my-notes" rows="3" placeholder="What you tweaked, how it turned out…" oninput="autoGrow(this)" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;resize:vertical;font-family:inherit;max-height:300px;overflow-y:auto">${esc(r.my_notes || '')}</textarea>
        </label>
        <div style="font-size:12px;color:var(--text-muted)">Source: ${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" style="color:var(--ongoing);text-decoration:none">${esc(r.source_url)}</a>` : r.source_image ? esc(r.source_image) : '—'}</div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border);flex-wrap:wrap">
            <button onclick="removeRecipe('${esc(r.id)}','${esc(r.name || 'recipe')}')" style="min-height:40px;background:none;border:1px solid var(--red);color:var(--red);font-size:13px;font-weight:600;border-radius:6px;padding:6px 14px;cursor:pointer">Delete</button>
            <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
                <button onclick="cancelRecipeEdit()" style="padding:6px 14px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;font-size:13px;cursor:pointer">Cancel</button>
                <button onclick="saveRecipeEdit()" style="padding:6px 14px;background:var(--ongoing);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Overwrite this recipe in place">Save</button>
                <button onclick="saveRecipeAsVariant()" style="padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer" title="Archive current and create a new version">Save new version</button>
            </div>
        </div>
    </div>`;
    const emn = document.getElementById('recipe-edit-my-notes');
    if (emn && emn.value) autoGrow(emn);
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
                <div style="font-size:12px;color:${isValid ? 'var(--green)' : 'var(--text-muted)'};font-weight:600">${esc(counter)}</div>
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
        const note = ing.note ? ` <span style="color:var(--text-muted);font-size:12px">(${esc(ing.note)})</span>` : '';
        const reasonLabel = onList
            ? ' <span style="color:var(--text-muted);font-size:12px">— already on list</span>'
            : isStocked
                ? ' <span style="color:var(--text-muted);font-size:12px">— usually have</span>'
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
        const tag = reason ? ` <span style="color:var(--text-muted);font-size:12px">— ${esc(reason)}</span>` : '';
        return `<div style="display:flex;gap:12px;padding:4px 0;font-size:13px;align-items:baseline">
            <span style="color:var(--text-muted);min-width:140px;flex-shrink:0;text-align:left">${esc(qty)}</span>
            <span style="flex:1;text-align:left">${esc(ing.item)}${tag}</span>
        </div>`;
    };
    const fmtCheckableRow = (ing, reason) => {
        const qty = (ing.qty || '').trim();
        const tag = reason ? ` <span style="color:var(--text-muted);font-size:12px">— ${esc(reason)}</span>` : '';
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

