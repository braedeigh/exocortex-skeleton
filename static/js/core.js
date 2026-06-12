// core.js — shared globals, utilities, render loop, modal, drag-drop, card system

// --- Global variables ---
let D = null; // dashboard data
let _serverDate = null;
let selectedTime = null;
let pendingDelete = null;
let expandedAll = false;
let currentTab = document.body.dataset.activeTab || 'today';

const TAB_ENDPOINTS = {
    today: '/api/data/today',
    map: '/api/data/map',
    kitchen: '/api/data/kitchen',
    inventory: () => {
        const name = document.body.dataset.itemName || '';
        return name ? `/api/data/item-buy?name=${encodeURIComponent(name)}` : '/api/data/inventory';
    },
    money: '/api/data/money',
    car: '/api/data/car',
    meditation: '/api/data/meditation',
    media: '/api/data/media',
    movement: '/api/data/movement',
    body: '/api/data/body',
};

// TAB_RENDERERS is built lazily in render() because the functions
// are defined in other JS files that load after core.js
let TAB_RENDERERS = null;

// --- initTab ---
function initTab() {
    document.getElementById('tab-today').style.display = currentTab === 'today' ? '' : 'none';
    document.getElementById('tab-map').style.display = currentTab === 'map' ? '' : 'none';
    document.getElementById('tab-kitchen').style.display = currentTab === 'kitchen' ? '' : 'none';
    document.getElementById('tab-inventory').style.display = currentTab === 'inventory' ? '' : 'none';
    document.getElementById('tab-money').style.display = currentTab === 'money' ? '' : 'none';
    const carEl = document.getElementById('tab-car');
    if (carEl) carEl.style.display = currentTab === 'car' ? '' : 'none';
    const medEl = document.getElementById('tab-meditation');
    if (medEl) medEl.style.display = currentTab === 'meditation' ? '' : 'none';
    const mediaEl = document.getElementById('tab-media');
    if (mediaEl) mediaEl.style.display = currentTab === 'media' ? '' : 'none';
    const movementEl = document.getElementById('tab-movement');
    if (movementEl) movementEl.style.display = currentTab === 'movement' ? '' : 'none';
    const bodyEl = document.getElementById('tab-body');
    if (bodyEl) bodyEl.style.display = currentTab === 'body' ? '' : 'none';

    // Inside inventory: show list OR item detail based on data-item-name
    const itemName = document.body.dataset.itemName || '';
    const listSection = document.getElementById('buy-list-section');
    const detailSection = document.getElementById('item-buy-area');
    if (listSection && detailSection) {
        if (itemName) {
            listSection.style.display = 'none';
            detailSection.style.display = '';
        } else {
            listSection.style.display = '';
            detailSection.style.display = 'none';
        }
    }
    document.querySelectorAll('#tab-selector .time-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === currentTab);
    });
}

// --- toggleExpandAll ---
function toggleExpandAll() {
    expandedAll = !expandedAll;
    document.getElementById('expand-btn').textContent = expandedAll ? 'Show less' : 'Show hidden';
    render();
    if (expandedAll) {
        document.querySelectorAll('details').forEach(d => { d.open = true; });
    }
}

// --- toggleMapCollapse ---
function toggleMapCollapse() {
    const sections = document.querySelectorAll('#tab-map details.map-section');
    const anyOpen = Array.from(sections).some(d => d.open);
    sections.forEach(d => { d.open = !anyOpen; if (d.open) mapCardToggled(d); });
    const btn = document.getElementById('map-collapse-btn');
    if (btn) btn.textContent = anyOpen ? 'Expand all' : 'Collapse all';
}

// When a Map card opens/closes: remember the state (so cards stay how you leave
// them), and snap any horizontal trackers to the right edge on open.
function mapCardToggled(d) {
    if (!d) return;
    if (d.dataset.card) {
        try { localStorage.setItem('mapCardOpen:' + d.dataset.card, d.open ? '1' : '0'); } catch (e) {}
    }
    if (!d.open) return;
    requestAnimationFrame(() => {
        d.querySelectorAll('.dot-grid, .contact-calendar').forEach(g => { g.scrollLeft = g.scrollWidth; });
    });
}

// --- Generic editor modal (habit edit / manage reminders / manage contacts) ---
function showEditorModal(title, html) {
    const m = document.getElementById('panel-modal');
    if (!m) return;
    document.getElementById('panel-modal-title').textContent = title;
    document.getElementById('panel-modal-body').innerHTML = html;
    m.classList.add('open');
}
function hideEditorModal() {
    const m = document.getElementById('panel-modal');
    if (m) m.classList.remove('open');
}
// Close whichever editor is open (the modal's × button).
function closeActiveEditor() {
    hideEditorModal();
    if (window._editBucket) {
        window._editBucket = null;
        const m = document.getElementById('panel-modal');
        if (m) m.classList.remove('todo-bucket-modal');
    }
    if (typeof _habitTrackerEditing !== 'undefined' && _habitTrackerEditing) {
        _habitTrackerEditing = false;
        document.querySelectorAll('.habit-edit-btn').forEach(b => { b.textContent = 'Edit'; });
        renderHabitTracker();
    }
    if (window._remMgrOpen) {
        window._remMgrOpen = false; window._remindersDraft = null;
        if (typeof renderReminderManager === 'function') renderReminderManager();
    }
    if (window._contactsManageOpen) {
        window._contactsManageOpen = false;
        if (typeof renderContacts === 'function') renderContacts();
    }
}

// Restore each collapsible card's saved open/closed state on load (Map + Body).
// No saved value → default to whether it has the data-default-open attribute.
function restoreMapCards() {
    document.querySelectorAll('details.map-section[data-card]').forEach(d => {
        let v = null;
        try { v = localStorage.getItem('mapCardOpen:' + d.dataset.card); } catch (e) {}
        if (v === '1') d.open = true;
        else if (v === '0') d.open = false;
        else d.open = d.hasAttribute('data-default-open');
    });
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreMapCards);
} else {
    restoreMapCards();
}

// --- App banner (loading / error states) ---
let _bannerTimer = null;

function setBanner(state, message) {
    if (_bannerTimer) { clearTimeout(_bannerTimer); _bannerTimer = null; }
    const el = document.getElementById('app-banner');
    if (!el) return;
    if (state === 'clear') {
        el.className = '';
        el.innerHTML = '';
        return;
    }
    if (state === 'loading') {
        // Debounce: only show after 300ms so a fast fetch doesn't flash a banner.
        _bannerTimer = setTimeout(() => {
            el.className = 'app-banner loading';
            el.innerHTML = '<span>Loading…</span>';
        }, 300);
        return;
    }
    if (state === 'error') {
        el.className = 'app-banner error';
        el.innerHTML = `<span>${esc(message || "Couldn't load data.")}</span><button onclick="loadDashboard()">Retry</button>`;
        return;
    }
}

// --- loadDashboard ---
async function loadDashboard() {
    setBanner('loading');
    try {
        let endpoint = TAB_ENDPOINTS[currentTab] || '/api/data';
        if (typeof endpoint === 'function') endpoint = endpoint();
        const res = await fetch(endpoint);
        const data = await res.json();
        if (data.error) {
            console.error('Server error:', data.error);
            setBanner('error', data.error);
            return;
        }
        setBanner('clear');
        D = data;
        // Public mode: frosted streams arrive as {_frosted:true,...}. Replace them with
        // safe empty values so every consumer (e.g. habit tracker reads health_data) keeps
        // rendering, and record which were frosted so primary cards can show a frosted
        // placeholder instead of looking falsely empty. No-op when authed (nothing is frosted).
        D._frost = {};
        const _frostDefaults = {
            health_data: [],
            tax_setaside: [],
        };
        for (const k in _frostDefaults) {
            if (isFrosted(D[k])) { D._frost[k] = true; D[k] = _frostDefaults[k]; }
        }
        if (isFrosted(D.streaks)) D._frost.streaks = true;
        // Normalize: habits items → strings (they use habits_log for done state)
        if (D.habits) D.habits.forEach(s => { s.items = s.items.map(i => typeof i === 'string' ? i : i.text); });
        if (!selectedTime) selectedTime = D.time_of_day;
        // Use server time for all time-dependent displays
        if (D.server_date) _serverDate = D.server_date;
        if (typeof _serverHour !== 'undefined' && D.server_hour !== undefined) {
            _serverHour = D.server_hour;
            _serverDayOfYear = D.server_day_of_year;
            updateSkyTheme();
        }
        render();
    } catch(e) {
        console.error('Failed to load dashboard:', e);
        setBanner('error', e.message || 'Could not load data — check server.log');
    }
}

// --- render ---
function render() {
    if (!TAB_RENDERERS) {
        TAB_RENDERERS = {
            today: [
                renderHeader, renderFoodBanner, renderGroceryQuick,
                renderReminders, renderContactReminders, renderContacts,
                renderContactCalendar, renderHabits, renderTodos, renderSymptomForm,
                renderDevNotes, restoreEditModes
            ],
            map: [
                renderHeader, renderContacts, renderContactCalendar,
                renderHabitTracker, renderActivityCalendar, renderReminderManager,
                renderDevNotes, restoreEditModes
            ],
            body: [
                renderHeader, renderFoodExperiments, renderFoodTriage, renderSafeFoods, renderSuspectFoods,
                renderInflammatoryFoods, renderDotGrid, renderSymptomDefinitions, renderFoodLog,
                renderDevNotes, restoreEditModes
            ],
            kitchen: [
                renderHeader, renderGroceryList, renderDevNotes, restoreEditModes
            ],
            inventory: [
                renderHeader,
                () => {
                    const name = document.body.dataset.itemName || '';
                    if (name) {
                        renderBuyItemDetail();
                    } else {
                        renderPriorityNotes();
                        renderRestockBanner();
                        renderActiveInventory();
                        renderBuyList();
                        renderPastInventory();
                    }
                },
                renderDevNotes, restoreEditModes
            ],
            money: [
                renderHeader, renderQuickExpense, renderCsvImport, renderSetAside,
                renderSpendingBreakdown, renderThisMonth, renderRecentExpenses,
                renderSubscriptions, renderBudgetConfig, renderDevNotes, restoreEditModes
            ],
            car: [
                renderHeader, renderCarNotes, renderCarAddForm, renderCarLog,
                renderDevNotes, restoreEditModes
            ],
            meditation: [
                renderHeader, renderMeditationTimer, renderMeditationStream,
                renderDeities, _applyMedView, renderDevNotes, restoreEditModes
            ],
            media: [
                renderHeader, renderMedia, renderDevNotes, restoreEditModes
            ],
            movement: [
                renderHeader, renderMovement, renderDevNotes, restoreEditModes
            ],
        };
    }
    const fns = TAB_RENDERERS[currentTab] || Object.values(TAB_RENDERERS).flat();
    for (const fn of fns) {
        try { fn(); } catch(e) { console.error(fn.name + ' failed:', e); }
    }
}

// --- Time selector ---
function setTime(t) {
    selectedTime = t;
    render();
}

function getTime() { return selectedTime || D.time_of_day; }

// --- Header ---
// User-defined "Day N <label>" counters in the header (add-only; delete to redo).
function renderStreaks() {
    const el = document.getElementById('streaks-area');
    if (!el) return;
    if (D._frost && D._frost.streaks) { el.innerHTML = ''; return; }
    const inp = 'padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px';
    const chips = (D.streaks || []).map(s => `<span class="streak-chip">
        <span><span class="num">Day ${s.days}</span> ${esc(s.label)}</span>
        <button class="x" onclick="removeStreak('${escJs(s.label)}','${esc(s.since)}')" title="Remove (re-add to fix a date)">&times;</button>
    </span>`).join('');
    el.innerHTML = `<div class="streak-row">
            ${chips}
            <button class="streak-add" onclick="toggleAdd('add-streak-form')">+ day count</button>
        </div>
        <div class="add-form" id="add-streak-form" style="margin-top:8px;align-items:center;flex-wrap:wrap;gap:6px">
            <input type="text" id="streak-label" placeholder="e.g. nicotine patches" style="${inp};flex:1;min-width:140px" onkeydown="if(event.key==='Enter')addStreak()">
            <span style="font-size:12px;color:var(--text-muted)">since</span>
            <input type="date" id="streak-since" value="${todayStr()}" style="${inp}">
            <button onclick="addStreak()">Add</button>
        </div>`;
}

async function addStreak() {
    const label = (document.getElementById('streak-label')?.value || '').trim();
    const since = document.getElementById('streak-since')?.value || '';
    if (!label || !since) return;
    const res = await fetch('/api/streaks/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, since })
    });
    if (res.ok) loadDashboard();
    else { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to add'); }
}

function removeStreak(label, since) {
    confirmDelete(label, 'streak');
    pendingDelete = { type: 'streak', label, since, item: label };
}

function renderHeader() {
    const greetingEl = document.getElementById('greeting');
    const dateEl = document.getElementById('date-info');
    if (currentTab === 'today') {
        const greetings = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' };
        greetingEl.textContent = greetings[getTime()];
        dateEl.textContent = D.date;
        greetingEl.style.display = '';
        dateEl.style.display = '';
        renderStreaks();
    } else {
        greetingEl.style.display = 'none';
        dateEl.style.display = 'none';
        const sa = document.getElementById('streaks-area');
        if (sa) sa.innerHTML = '';
    }

    document.querySelectorAll('#time-selector .time-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.time === getTime());
    });
    // Lay out the tab bar (fit-as-many + overflow into More) and set active states.
    layoutTabs();
}

// --- Utility functions ---
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// Escape for a JS single-quoted string sitting inside a double-quoted HTML
// attribute (e.g. onclick="fn('...')"). Note: " must become &quot; — \" does
// NOT stop the browser from ending the attribute, which silently breaks the
// handler for any item containing a double-quote.
function escJs(s) {
    return String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/\r?\n/g, '\\n');
}

// --- Tab navigation: post to parent (split.html) so URL updates without reloading the shell ---
function switchTab(event, name, extra) {
    if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0)) return;  // let browser open in new tab
    closeMore();
    if (window.parent && window.parent !== window) {
        if (event) event.preventDefault();
        // `extra` is an optional deep-link payload (e.g. {routine:'evening-neck'}).
        window.parent.postMessage({ type: 'tab', name: name, extra: extra || null }, location.origin);
    }
    // standalone (no parent shell): let the <a> href navigate normally
}

window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (e.source !== window.parent) return;
    if (!e.data || e.data.type !== 'switchTo') return;
    const name = e.data.name;
    const extra = e.data.extra || null;
    // Deep-link target for Movement: open straight into a routine (or clear it on
    // a plain tab switch so normal nav shows the routine list).
    if (name === 'movement') window._movementRoutineView = (extra && extra.routine) ? extra.routine : null;
    if (name === currentTab) {
        // Already on this tab — just apply the deep-link by re-rendering.
        if (name === 'movement' && typeof renderMovement === 'function') renderMovement();
        return;
    }
    currentTab = name;
    document.body.dataset.activeTab = name;
    if (name === 'today') resetTodoCollapseMemory();  // start the To-Do page fresh
    initTab();
    loadDashboard();
});

// --- Frosted-placeholder helpers (public mode) ---
function isFrosted(v) { return v && typeof v === 'object' && v._frosted === true; }
function frostedCard(title, fauxCount) {
    if (fauxCount == null) fauxCount = 3;
    const widths = ['', ' medium', ' short'];
    let rows = '';
    for (let i = 0; i < fauxCount; i++) rows += `<div class="frosted-faux-row${widths[i % widths.length]}"></div>`;
    return `<div class="frosted-card">
        <div class="frosted-blur">
            ${title ? `<div class="frosted-title">${esc(title)}</div>` : ''}
            ${rows}
        </div>
        <div class="frosted-overlay"><a href="/login" target="_top">Sign in to view</a></div>
    </div>`;
}

// moved to top — needs to be declared before loadDashboard runs

function todayStr() {
    if (_serverDate) return _serverDate;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Tomorrow as YYYY-MM-DD, derived from todayStr so it respects the server date.
function tomorrowStr() {
    const d = new Date(todayStr() + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// --- Edit mode ---
const editingCards = new Set();

function toggleEditMode(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    if (editingCards.has(cardId)) {
        editingCards.delete(cardId);
    } else {
        editingCards.add(cardId);
    }
    applyEditMode(card, editingCards.has(cardId));
}

function applyEditMode(card, editing) {
    card.classList.toggle('editing', editing);
    const toggle = card.querySelector('.edit-toggle');
    if (toggle) toggle.textContent = editing ? 'done' : 'edit';
    card.querySelectorAll('.habit-view, .todo-view').forEach(el => el.style.display = editing ? 'none' : '');
    card.querySelectorAll('.habit-edit, .todo-edit').forEach(el => {
        el.style.display = editing ? '' : 'none';
        // Size the edit box to its content now that it's visible (scrollHeight
        // is 0 while hidden), so long items wrap and grow instead of scrolling.
        if (editing && el.tagName === 'TEXTAREA') autoGrow(el);
    });
    // The description editor reveals in edit mode (CSS); size it once visible.
    if (editing) card.querySelectorAll('.todo-notes-input').forEach(autoGrow);
}

// Grow a textarea to fit its content (no inner scrollbar).
function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function restoreEditModes() {
    editingCards.forEach(cardId => {
        const card = document.getElementById(cardId);
        if (card) applyEditMode(card, true);
    });
}

async function commitRename(input) {
    const oldName = input.dataset.original;
    const newName = input.value.trim();
    const section = input.dataset.section;
    const type = input.dataset.type || 'habit';
    if (!newName || newName === oldName) return;
    let endpoint, body;
    if (type === 'growth') {
        endpoint = '/api/growth/rename';
        body = { old: oldName, new: newName };
    } else {
        endpoint = type === 'todo' ? '/api/todos/rename' : type === 'edge' ? '/api/edges/rename' : '/api/habits/rename';
        body = type === 'todo'
            ? { id: input.dataset.id, old: oldName, new: newName }
            : { old: oldName, new: newName, section };
    }
    await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    loadDashboard();
}

// --- Drag and drop for habits ---
let dragItem = null;
// Only start a drag when it began from the dots handle (set on mousedown),
// so selecting/highlighting text in an item doesn't trigger a reorder.
let dragFromHandle = false;
document.addEventListener('mouseup', () => { dragFromHandle = false; });
function habitDragStart(e) {
    if (!dragFromHandle) { e.preventDefault(); return; }
    dragItem = e.currentTarget;
    dragItem.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}
function habitDragOver(e) {
    e.preventDefault();
    const target = e.currentTarget;
    if (target !== dragItem) {
        target.classList.add('drag-over');
    }
}
function habitDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}
function habitDragEnd(e) {
    dragFromHandle = false;
    if (dragItem) dragItem.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    dragItem = null;
}
async function habitDrop(e, type) {
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('drag-over');
    if (!dragItem || target === dragItem) return;
    const fromSection = dragItem.dataset.section;
    const toSection = target.dataset.section;

    // Cross-card move (todo only)
    if (fromSection !== toSection && type === 'todo') {
        const item = dragItem.dataset.id || dragItem.dataset.habit;
        await fetch('/api/todos/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item, to_section: toSection })
        });
        loadDashboard();
        return;
    }

    if (fromSection !== toSection) return;

    // Same-card reorder
    const card = target.closest('.card');
    const allItems = [...card.querySelectorAll('.card-item[draggable]')];
    const fromIdx = allItems.indexOf(dragItem);
    const toIdx = allItems.indexOf(target);

    const items = allItems.map(el => (type === 'todo') ? (el.dataset.id || el.dataset.habit) : el.dataset.habit);
    const moved = items.splice(fromIdx, 1)[0];
    items.splice(toIdx, 0, moved);

    if (type === 'growth') {
        await fetch('/api/growth/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: items })
        });
    } else {
        const endpoint = (type === 'todo') ? '/api/todos/reorder' : '/api/habits/reorder';
        await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section: fromSection, items })
        });
    }
    loadDashboard();
}

// Card-level drop zone for dragging items into empty areas of a card
function cardDragOver(e) {
    e.preventDefault();
    e.currentTarget.style.outline = '2px dashed var(--ongoing)';
    e.currentTarget.style.outlineOffset = '-2px';
}
function cardDragLeave(e) {
    e.currentTarget.style.outline = '';
    e.currentTarget.style.outlineOffset = '';
}
async function cardDrop(e, sectionName) {
    e.preventDefault();
    e.currentTarget.style.outline = '';
    e.currentTarget.style.outlineOffset = '';
    if (!dragItem) return;
    const fromSection = dragItem.dataset.section;
    if (fromSection === sectionName) return;
    const item = dragItem.dataset.id || dragItem.dataset.habit;
    await fetch('/api/todos/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item, to_section: sectionName })
    });
    loadDashboard();
}

// --- cardHTML (shared between habits and todos) ---
function cardHTML(title, items, color, type, sectionName, dim, manualOrder) {
    const cardId = `card-${type}-${sectionName.replace(/\s+/g,'-')}`;
    const itemsHTML = items.map((rawItem, idx) => {
        const item = typeof rawItem === 'string' ? { text: rawItem, done: false } : rawItem;
        const text = item.text;
        const done = item.done;
        const id = item.id || text;  // todos are identified by stable id (text is the fallback)
        return `<div class="card-item" draggable="true" data-section="${esc(sectionName)}" data-idx="${idx}" data-habit="${esc(text)}" data-id="${type === 'todo' ? esc(id) : ''}" data-due="${type === 'todo' && item.due_by ? esc(item.due_by) : ''}"
              ondragstart="habitDragStart(event)" ondragover="habitDragOver(event)" ondrop="habitDrop(event,'${type}')" ondragend="habitDragEnd(event)" ondragleave="habitDragLeave(event)">
            <span class="drag-handle" onmousedown="dragFromHandle=true">&#8942;&#8942;</span>
            <span class="habit-check ${done?'done':''}" onclick="toggleTodo('${escJs(id)}')" style="cursor:pointer" title="Check off">
                ${done ? '&#10003;' : '&#9675;'}
            </span>
            <span class="item-text todo-view"${type === 'todo' ? ' onclick="openTodoDetail(this, event)"' : ''} style="${type === 'todo' ? 'cursor:pointer;' : ''}${done?'text-decoration:line-through;opacity:0.5':''}">${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(text)}</a>` : esc(text)}${item.due_by ? `<span class="todo-due${_isOverdue(item.due_by) && !done ? ' overdue' : ''}" title="Due ${esc(item.due_by)}">${_isOverdue(item.due_by) && !done ? 'overdue · ' : 'due '}${esc(_fmtAddedDate(item.due_by))}</span>` : ''}${type === 'todo' && item.status && !done ? `<span class="todo-chip chip-status status-${esc(item.status)}">${esc(_statusLabel(item.status))}</span>` : ''}${type === 'todo' ? `<span class="todo-expand" aria-hidden="true">&#8250;</span>` : ''}</span>
            <textarea class="habit-rename todo-edit" rows="1" style="display:none" data-original="${esc(text)}" data-id="${esc(id)}" data-section="${esc(sectionName)}" data-type="${type}"
                oninput="autoGrow(this)" onblur="commitRename(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}else if(event.key==='Escape'){this.value=this.dataset.original;this.blur()}">${esc(text)}</textarea>
            ${type === 'todo' ? `<button class="delete-btn todo-action" onclick="showMoveMenu(this,'${escJs(id)}')" title="Move / snooze" style="font-size:14px">&#8595;</button>` : ''}
            <button class="delete-btn${type === 'todo' ? ' todo-action' : ''}" onclick="confirmDelete('${escJs(type === 'todo' ? id : text)}','${type}'${type === 'todo' ? `,'${escJs(text)}'` : ''})" title="Remove">&times;</button>
        </div>
        ${type === 'todo' ? `<div class="todo-detail">
            <div class="todo-detail-read">
                ${item.created ? `<span class="todo-detail-added">Added ${esc(_fmtAddedDate(item.created))}</span>` : ''}
                ${item.notes ? `<div class="todo-detail-desc">${esc(item.notes)}</div>` : `<div class="todo-detail-desc empty">No description</div>`}
            </div>
            <textarea class="todo-notes-input" placeholder="Add a description…" data-item="${esc(id)}" oninput="autoGrow(this)" onblur="saveTodoNotes(this)" rows="1">${esc(item.notes || '')}</textarea>
        </div>` : ''}`;
    }).join('');

    const emptyHTML = items.length === 0
        ? '<div class="empty-state">Nothing here — add one below</div>'
        : '';

    const addId = `add-${type}-${sectionName.replace(/\s+/g,'-')}`;
    const addForm = type === 'todo'
        ? `<div class="add-trigger" onclick="openAddTodoModal('${escJs(sectionName)}')">+ Add</div>`
        : `
        <div class="add-trigger" onclick="toggleAdd('${addId}')">+ Add</div>
        <div class="add-form" id="${addId}">
            <input type="text" placeholder="New item..." onkeydown="if(event.key==='Enter')addItem('${type}','${escJs(sectionName)}',this)">
            <button onclick="addItem('${type}','${escJs(sectionName)}',this.previousElementSibling)">Add</button>
        </div>`;

    const dropAttrs = type === 'todo' ? `ondragover="cardDragOver(event)" ondragleave="cardDragLeave(event)" ondrop="cardDrop(event,'${escJs(sectionName)}')"` : '';
    const open = todoCardOpen(sectionName);
    const remaining = items.filter(it => !(typeof it === 'object' && it.done)).length;
    const countBadge = `<span style="font-size:12px;font-weight:600;color:var(--text-muted);background:var(--bg);border-radius:10px;padding:1px 8px;margin-left:8px">${remaining}</span>`;
    return `<details class="card todo-card${dim?' dimmed':''}" style="border-left-color:${color}" id="${cardId}" ${open ? 'open' : ''} ontoggle="todoCardToggled(this,'${escJs(sectionName)}')" ${dropAttrs}>
        <summary class="card-title" style="color:${color};cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">
            <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
            <span style="flex:1">${title}${countBadge}</span>
            ${type === 'todo' && manualOrder ? `<span class="autosort-toggle" onclick="event.preventDefault();event.stopPropagation();autosortTodos('${escJs(sectionName)}')" title="Sort by due date again">&#8597; Auto-sort</span>` : ''}
            <span class="edit-toggle" onclick="event.preventDefault();event.stopPropagation();${type === 'todo' ? `openBucketEdit('${escJs(sectionName)}')` : `toggleEditMode('${cardId}')`}">edit</span>
        </summary>
        ${itemsHTML}${emptyHTML}${addForm}</details>`;
}

// Per-bucket collapse memory for the To-Do ladder. Default: only "Now" opens;
// the rest start collapsed. The memory is wiped on each visit to the To-Do page
// (see resetTodoCollapseMemory), so the page always *starts* clean — only "Now"
// (and the active habit section) open — while expands you make stick for the rest
// of that visit.
function todoCardOpen(sectionName) {
    try { const v = localStorage.getItem('todoOpenV2:' + sectionName); if (v !== null) return v === '1'; } catch (e) {}
    return (sectionName || '').toLowerCase() === 'now';
}
function todoCardToggled(d, sectionName) {
    try { localStorage.setItem('todoOpenV2:' + sectionName, d.open ? '1' : '0'); } catch (e) {}
}

// Clear the saved open/closed state of every To-Do bucket so the page reopens in
// its default layout (only "Now" expanded). Call this when entering the To-Do
// page — NOT on data re-renders — so logging an item doesn't snap your work shut.
function resetTodoCollapseMemory() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf('todoOpenV2:') === 0) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* no-op */ }
}

// --- habitCount, habitStartLabel, habitCardHTML ---
function habitCount(habit) {
    let count = 0;
    for (const date in D.habits_log) {
        if (D.habits_log[date][habit]) count++;
    }
    return count;
}

function habitStartLabel(item) {
    const starts = D.habit_starts || {};
    const d = starts[item];
    if (!d) return '';
    const days = Math.floor((new Date() - new Date(d + 'T00:00:00')) / 86400000);
    if (days === 0) return 'today · ';
    if (days === 1) return '1d · ';
    return `${days}d · `;
}

// Habits with a companion page — a ↗ icon next to them jumps there. Keys are the
// habit text lowercased; value is { tab, routine? } where routine deep-links into
// a specific Movement routine. Extend as more habits get pages.
const HABIT_LINKS = { 'stretch routine': { tab: 'movement', routine: 'evening-neck' } };

function habitCardHTML(title, items, color, sectionName) {
    const today = todayStr();
    const todayLog = (D.habits_log || {})[today] || {};

    const listId = `habit-list-${sectionName.replace(/\s+/g,'-')}`;
    const itemsHTML = items.map((item, idx) => {
        const done = !!todayLog[item];
        const total = habitCount(item);
        const target = 60;
        const lnk = HABIT_LINKS[item.toLowerCase()];
        const linkBtn = lnk
            ? `<button class="habit-link-btn" onclick="switchTab(event,'${esc(lnk.tab)}'${lnk.routine ? `,{routine:'${escJs(lnk.routine)}'}` : ''})" title="Open routine" aria-label="Open linked page">&#8599;</button>`
            : '';

        return `<div class="card-item" draggable="true" data-section="${esc(sectionName)}" data-idx="${idx}" data-habit="${esc(item)}"
                ondragstart="habitDragStart(event)" ondragover="habitDragOver(event)" ondrop="habitDrop(event,'habit')" ondragend="habitDragEnd(event)" ondragleave="habitDragLeave(event)">
            <span class="drag-handle" onmousedown="dragFromHandle=true">&#8942;&#8942;</span>
            <span class="habit-check ${done?'done':''}" onclick="toggleHabit('${esc(item)}')" title="Toggle today">
                ${done ? '&#10003;' : '&#9675;'}
            </span>
            <span class="item-text habit-view" style="${done?'text-decoration:line-through;opacity:0.5':''}">${esc(item)}${linkBtn}</span>
            <textarea class="habit-rename habit-edit" rows="1" style="display:none" data-original="${esc(item)}" data-section="${esc(sectionName)}"
                oninput="autoGrow(this)" onblur="commitRename(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}else if(event.key==='Escape'){this.value=this.dataset.original;this.blur()}">${esc(item)}</textarea>
            <span style="font-size:12px;color:var(--text-muted);margin-left:auto">${habitStartLabel(item)}${total}/${target}</span>
            <button class="delete-btn" onclick="confirmDelete('${esc(item)}','habit')" title="Remove">&times;</button>
        </div>`;
    }).join('');

    const emptyHTML = items.length === 0
        ? '<div class="empty-state">No habits yet — add one below</div>'
        : '';

    const addId = `add-habit-${sectionName.replace(/\s+/g,'-')}`;
    const addForm = `
        <div class="add-trigger" onclick="toggleAdd('${addId}')">+ Add</div>
        <div class="add-form" id="${addId}">
            <input type="text" placeholder="New habit..." onkeydown="if(event.key==='Enter')addItem('habit','${esc(sectionName)}',this)">
            <button onclick="addItem('habit','${esc(sectionName)}',this.previousElementSibling)">Add</button>
        </div>`;

    return `<div class="card habit-card" style="border-left-color:${color}" id="${listId}">
        <div class="card-title" style="color:${color}">${title}<span class="edit-toggle" onclick="toggleEditMode('${listId}')">edit</span></div>
        ${itemsHTML}${emptyHTML}${addForm}</div>`;
}

// --- Modal system ---
function confirmDelete(item, type, label) {
    pendingDelete = { item, type };
    document.getElementById('modal-text').innerHTML = `Remove <b>${esc(label || item)}</b>?`;
    document.getElementById('modal').classList.add('open');
}

async function executeDelete() {
    if (!pendingDelete) return;
    if (pendingDelete.type === 'kitchen-done') {
        await fetch('/api/kitchen/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        // Check off any kitchen-related todo item
        const kitchenTodo = D.todos.flatMap(s => s.items)
            .find(i => {
                const text = typeof i === 'string' ? i : i.text;
                const done = typeof i === 'string' ? false : i.done;
                return text.toLowerCase().includes('grocer') && !done;
            });
        if (kitchenTodo) {
            const text = typeof kitchenTodo === 'string' ? kitchenTodo : kitchenTodo.text;
            await fetch('/api/todos/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item: text })
            });
        }
    } else if (pendingDelete.type === 'habit') {
        await fetch('/api/habits/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'habit-dot') {
        await fetch('/api/habits/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ habit: pendingDelete.habit, date: pendingDelete.date })
        });
    } else if (pendingDelete.type === 'streak') {
        await fetch('/api/streaks/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: pendingDelete.label, since: pendingDelete.since })
        });
    } else if (pendingDelete.type === 'devnote') {
        const tab = pendingDelete.tab;
        await fetch('/api/devnote/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tab, id: pendingDelete.id })
        });
        closeModal();
        await refreshDevNotes(tab);
        return;
    } else if (pendingDelete.type === 'buy') {
        await fetch('/api/buy/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'edge') {
        await fetch('/api/edges/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'growth') {
        await fetch('/api/growth/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'active') {
        await fetch('/api/active/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'run') {
        await fetch('/api/runs/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: pendingDelete.date })
        });
    } else if (pendingDelete.type === 'kitchen-trip') {
        await fetch('/api/kitchen/trips/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: pendingDelete.date })
        });
    } else if (pendingDelete.type === 'activity') {
        await fetch('/api/activity/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: pendingDelete.date, type: pendingDelete.actType })
        });
    } else if (pendingDelete.type === 'contact-history') {
        await fetch('/api/contacts/history/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: pendingDelete.name, date: pendingDelete.date, method: pendingDelete.method })
        });
    } else if (pendingDelete.type === 'catalog-item') {
        await fetch('/api/kitchen/catalog/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: pendingDelete.item })
        });
        closeModal();
        await loadDashboard();
        openCatalogEditor();  // keep the catalog editor open after delete
        return;
    } else if (pendingDelete.type === 'grocery-item') {
        await fetch('/api/kitchen/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'kitchen-clear-all') {
        await fetch('/api/kitchen/clear-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
    } else if (pendingDelete.type === 'meditation-entry') {
        await fetch('/api/meditation/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'media-item') {
        await fetch('/api/media/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'movement-routine') {
        await fetch('/api/movement/routine/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'movement-move') {
        await fetch('/api/movement/move/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ routine_id: pendingDelete.routineId, id: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'recipe-item') {
        await fetch('/api/kitchen/recipes/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: pendingDelete.item })
        });
    } else if (pendingDelete.type === 'meal-note') {
        await fetch('/api/kitchen/meal-notes/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: pendingDelete.item })
        });
    } else {
        await fetch(`/api/${pendingDelete.type}s/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: pendingDelete.item })
        });
    }
    closeModal();
    loadDashboard();
}

function closeModal() {
    pendingDelete = null;
    document.getElementById('modal').classList.remove('open');
    document.getElementById('modal').querySelector('.confirm').textContent = 'Yes, remove';
}

// --- toggleAdd, addItem, showMoveMenu, moveTodo ---
function toggleAdd(id) {
    const el = document.getElementById(id);
    el.classList.toggle('open');
    if (el.classList.contains('open')) el.querySelector('input').focus();
}

async function addItem(type, section, inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;
    const res = await fetch(`/api/${type}s/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: text, section: section })
    });
    if (res.ok) {
        inputEl.value = '';
        loadDashboard();
    } else {
        const data = await res.json();
        alert(data.error || 'Failed to add');
    }
}

// --- Add-to-do modal (text + due-by + description) ---
// opts.due prefills the due date (used by the Today/Tomorrow day-view "+ Add",
// which drops the item into Now dated for that day so it lands in the day view).
// opts.dayLabel retitles the modal ("Add to Today" instead of "Add to Now").
function openAddTodoModal(section, opts) {
    opts = opts || {};
    const presetDue = opts.due || '';
    const html = `
        <form class="todo-add-form" onsubmit="event.preventDefault();submitAddTodoModal('${escJs(section)}')">
            <label class="todo-add-label">
                <span class="todo-add-labeltext">To-do</span>
                <textarea id="add-todo-text" class="todo-add-input" rows="1" placeholder="What needs doing?" autocomplete="off"
                    oninput="autoGrow(this)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitAddTodoModal('${escJs(section)}')}"></textarea>
            </label>
            <label class="todo-add-label">
                <span class="todo-add-labeltext">Due by <span class="todo-add-opt">(optional)</span></span>
                <input type="date" id="add-todo-due" class="todo-add-input" value="${esc(presetDue)}">
            </label>
            <label class="todo-add-label">
                <span class="todo-add-labeltext">Description <span class="todo-add-opt">(optional)</span></span>
                <textarea id="add-todo-desc" class="todo-add-input" rows="2" placeholder="Any details…" oninput="autoGrow(this)"></textarea>
            </label>
            <div class="todo-add-actions">
                <button type="button" class="modal-btn cancel" onclick="closeActiveEditor()">Cancel</button>
                <button type="submit" class="modal-btn confirm" style="background:var(--accent)">Add</button>
            </div>
        </form>`;
    showEditorModal('Add to ' + (opts.dayLabel || section), html);
    setTimeout(() => { const el = document.getElementById('add-todo-text'); if (el) el.focus(); }, 50);
}

// The Today/Tomorrow day views are computed from due dates, so "add here" means
// "add a to-do in Now dated for that day" — then it surfaces in the day view.
function addToDay(label) {
    const due = label === 'Tomorrow' ? tomorrowStr() : todayStr();
    openAddTodoModal('Now', { due, dayLabel: label });
}

async function submitAddTodoModal(section) {
    const textEl = document.getElementById('add-todo-text');
    const text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    const due_by = document.getElementById('add-todo-due').value;
    const notes = document.getElementById('add-todo-desc').value.trim();
    const res = await fetch('/api/todos/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: text, section, due_by, notes })
    });
    if (res.ok) {
        hideEditorModal();
        loadDashboard();
    } else {
        const data = await res.json();
        alert(data.error || 'Failed to add');
    }
}

function showMoveMenu(btn, item) {
    // Remove any existing move menu
    document.querySelectorAll('.move-menu').forEach(m => m.remove());
    const sections = D.todos.filter(s => !s.name.toLowerCase().startsWith('done')).map(s => s.name);
    const menu = document.createElement('div');
    menu.className = 'move-menu';
    menu.style.cssText = 'position:absolute;right:0;top:100%;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.12);z-index:100;min-width:160px;padding:4px 0;font-size:13px';
    const moveLbl = document.createElement('div');
    moveLbl.textContent = 'Move to';
    moveLbl.style.cssText = 'padding:4px 14px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted)';
    menu.appendChild(moveLbl);
    sections.forEach(s => {
        const opt = document.createElement('div');
        opt.textContent = s;
        opt.style.cssText = 'padding:6px 14px;cursor:pointer;color:var(--text)';
        opt.onmouseenter = () => opt.style.background = 'var(--bg)';
        opt.onmouseleave = () => opt.style.background = 'none';
        opt.onclick = () => { menu.remove(); moveTodo(item, s); };
        menu.appendChild(opt);
    });
    // Snooze ("kick the can down the road")
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--border);margin:4px 0';
    menu.appendChild(sep);
    const snoozeLbl = document.createElement('div');
    snoozeLbl.textContent = 'Snooze';
    snoozeLbl.style.cssText = 'padding:4px 14px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted)';
    menu.appendChild(snoozeLbl);
    [['3 days', 3], ['1 week', 7], ['2 weeks', 14], ['1 month', 30]].forEach(([label, days]) => {
        const opt = document.createElement('div');
        opt.textContent = `💤 ${label}`;
        opt.style.cssText = 'padding:6px 14px;cursor:pointer;color:var(--text)';
        opt.onmouseenter = () => opt.style.background = 'var(--bg)';
        opt.onmouseleave = () => opt.style.background = 'none';
        opt.onclick = () => { menu.remove(); snoozeTodo(item, days); };
        menu.appendChild(opt);
    });
    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(menu);
    // Close on outside click
    setTimeout(() => document.addEventListener('click', function close(e) {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
    }), 0);
}

async function moveTodo(item, toSection) {
    await fetch('/api/todos/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item, to_section: toSection })
    });
    loadDashboard();
}

async function snoozeTodo(item, days) {
    await fetch('/api/todos/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item, days })
    });
    loadDashboard();
}

// --- Per-bucket edit modal -------------------------------------------------
// Tapping a bucket's "edit" opens that whole bucket (Now / Up Next / …) in a
// large modal, in edit mode, reusing the normal card so all the existing
// reorder / rename / move / delete / description handlers work. It re-renders
// from data after every dashboard reload so it never goes stale.
function openBucketEdit(sectionName) {
    window._editBucket = sectionName;
    renderBucketEditModal();
}

function renderBucketEditModal() {
    const sectionName = window._editBucket;
    if (!sectionName) return;
    const m = document.getElementById('panel-modal');
    const bodyEl = document.getElementById('panel-modal-body');
    if (!m || !bodyEl) return;
    const section = (D.todos || []).find(s => s.name === sectionName);
    if (!section) { window._editBucket = null; return; }
    const today = (typeof todayStr === 'function') ? todayStr() : '';
    const visible = (section.items || []).filter(it => {
        const su = (it && typeof it === 'object') ? it.snoozed_until : null;
        return !(su && su > today && !it.done);
    });
    const slug = sectionName.replace(/\s+/g, '-');
    let html = cardHTML(sectionName, visible, 'var(--accent)', 'todo', sectionName, false, section.manual_order);
    // Unique id so it never collides with the same bucket's card on the page.
    html = html.replace(`id="card-todo-${slug}"`, `id="modal-card-todo-${slug}"`);
    document.getElementById('panel-modal-title').innerHTML =
        `<span class="todo-modal-kicker">Edit:</span> <span class="todo-modal-htitle">${esc(sectionName)}</span>`;
    bodyEl.innerHTML = `<div class="bucket-edit-wrap">${html}</div>`;
    m.classList.add('open', 'todo-bucket-modal');
    const card = bodyEl.querySelector('.card');
    if (card) { card.setAttribute('open', ''); applyEditMode(card, true); }
}

// Tap a to-do to pop up its details: due (left) / added (right), title, and
// description — all read-only until the Edit button (which becomes Save) is
// tapped. Ignores clicks on an inner link so URL to-dos still navigate.
// --- To-do attribute vocabulary + helpers (Phase 1) --------------------------
// Category mirrors the app's tab taxonomy ("tag a to-do by the tab it belongs
// to"); status captures the "will it be ready?" question.
const TODO_CATEGORIES = [
    { key: 'body', label: 'Body' },
    { key: 'kitchen', label: 'Kitchen' },
    { key: 'money', label: 'Money' },
    { key: 'car', label: 'Car' },
    { key: 'inventory', label: 'Inventory' },
    { key: 'meditation', label: 'Meditation' },
    { key: 'media', label: 'Media' },
    { key: 'movement', label: 'Movement' },
    { key: 'map', label: 'Life Map' },
];
const TODO_STATUSES = [
    { key: 'ready', label: 'Ready' },
    { key: 'check_first', label: 'Check first' },
    { key: 'waiting', label: 'Waiting' },
];

function findTodoById(id) {
    for (const sec of (D.todos || [])) {
        for (const it of (sec.items || [])) {
            if (it && typeof it === 'object' && (it.id === id || it.text === id)) return it;
        }
    }
    return null;
}
function placeById(pid) { return (D.places || []).find(p => p.id === pid) || null; }
function _catLabel(key) { const c = TODO_CATEGORIES.find(c => c.key === key); return c ? c.label : (key || ''); }
function _statusLabel(key) { const s = TODO_STATUSES.find(s => s.key === key); return s ? s.label : (key || ''); }
function _fmtTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = String(hhmm).split(':').map(Number);
    if (isNaN(h)) return hhmm;
    const ap = h < 12 ? 'am' : 'pm';
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m || 0).padStart(2, '0')}${ap}`;
}
function _fmtDuration(min) {
    min = parseInt(min, 10);
    if (!min) return '';
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h${m}` : `${h}h`;
}
// Read-only chip row summarizing a to-do's attributes (used in the detail modal;
// reused by the day/itinerary views in Phase 2).
function todoChipsHTML(item) {
    const chips = [];
    const pl = item.place_id && placeById(item.place_id);
    if (pl) chips.push(`<span class="todo-chip chip-place">📍 ${esc(pl.name)}</span>`);
    if (item.due_time) chips.push(`<span class="todo-chip chip-time">🕑 ${esc(_fmtTime(item.due_time))}</span>`);
    if (item.duration_min) chips.push(`<span class="todo-chip chip-dur">⏱ ${esc(_fmtDuration(item.duration_min))}</span>`);
    if (item.category) chips.push(`<span class="todo-chip chip-cat">${esc(_catLabel(item.category))}</span>`);
    if (item.status) chips.push(`<span class="todo-chip chip-status status-${esc(item.status)}">${esc(_statusLabel(item.status))}</span>`);
    return chips.join('');
}

// Edit-mode chip handlers (duration quick-picks + single-select status).
function tmDurationChip(btn, mins) {
    const wrap = btn.closest('.tm-chips');
    wrap.querySelectorAll('.tm-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const inp = wrap.querySelector('.todo-modal-duration');
    if (inp) inp.value = mins;
}
function tmStatusChip(btn) {
    const wrap = btn.closest('.tm-chips');
    const wasActive = btn.classList.contains('active');
    wrap.querySelectorAll('.tm-chip').forEach(c => c.classList.remove('active'));
    if (!wasActive) btn.classList.add('active');   // tap an active chip again to clear
}
function tmPlaceChanged(sel) {
    const np = sel.closest('.tm-field').querySelector('.tm-newplace');
    if (np) np.style.display = sel.value === '__new__' ? 'flex' : 'none';
}
async function tmSaveNewPlace(btn) {
    const wrap = btn.closest('.tm-newplace');
    const nameEl = wrap.querySelector('.tm-newplace-name');
    const name = nameEl.value.trim();
    const addr = wrap.querySelector('.tm-newplace-addr').value.trim();
    if (!name) { nameEl.focus(); return; }
    const res = await fetch('/api/places/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, address: addr })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Could not add place'); return; }
    D.places = D.places || [];
    D.places.push({ id: data.id, name, address: addr, category: '', notes: '' });
    const sel = btn.closest('.tm-field').querySelector('.todo-modal-place');
    const opt = document.createElement('option');
    opt.value = data.id; opt.textContent = name; opt.selected = true;
    sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
    sel.value = data.id;
    wrap.style.display = 'none';
    nameEl.value = ''; wrap.querySelector('.tm-newplace-addr').value = '';
}

// Tap a to-do → its detail modal. Read mode shows attribute chips; Edit reveals
// the date+time, place, category, duration and status controls.
function openTodoDetail(el, ev) {
    if (ev && ev.target && ev.target.closest('a')) return;
    const row = el.closest('.card-item');
    if (!row) return;
    const text = row.dataset.habit || '';
    const id = row.dataset.id || text;
    const item = findTodoById(id) || { text };
    const dueIso = item.due_by || row.dataset.due || '';
    const dueTime = item.due_time || '';
    const notes = item.notes || '';
    const added = item.created ? `Added ${_fmtAddedDate(item.created)}` : '';
    const overdue = dueIso && _isOverdue(dueIso);
    const dueText = dueIso
        ? `${overdue ? 'overdue · ' : 'due '}${_fmtAddedDate(dueIso)}${dueTime ? ' · ' + _fmtTime(dueTime) : ''}`
        : (dueTime ? _fmtTime(dueTime) : '');
    const chips = todoChipsHTML(item);
    const metaBits = [];
    if (dueText) metaBits.push(`<span class="todo-modal-due${overdue ? ' overdue' : ''}">${esc(dueText)}</span>`);
    if (chips) metaBits.push(`<span class="todo-modal-chips">${chips}</span>`);
    // `added` now lives in the footer between Delete and Edit (not the meta row).

    const placeOpts = ['<option value="">No place</option>']
        .concat((D.places || []).map(p => `<option value="${esc(p.id)}"${p.id === item.place_id ? ' selected' : ''}>${esc(p.name)}</option>`))
        .concat(['<option value="__new__">➕ Add a place…</option>']).join('');
    const catOpts = ['<option value="">— none —</option>']
        .concat(TODO_CATEGORIES.map(c => `<option value="${esc(c.key)}"${c.key === item.category ? ' selected' : ''}>${esc(c.label)}</option>`)).join('');
    const durChips = [15, 30, 60].map(m => `<button type="button" class="tm-chip${item.duration_min === m ? ' active' : ''}" onclick="tmDurationChip(this, ${m})">${m}m</button>`).join('');
    const statusChips = TODO_STATUSES.map(s => `<button type="button" class="tm-chip${item.status === s.key ? ' active' : ''}" data-val="${esc(s.key)}" onclick="tmStatusChip(this)">${esc(s.label)}</button>`).join('');

    const body = `<div class="todo-modal-body" data-item="${esc(text)}" data-id="${esc(id)}" data-due="${esc(dueIso)}">
        <div class="todo-modal-meta"${metaBits.length ? '' : ' style="display:none"'}>${metaBits.join('')}</div>
        <div class="todo-modal-desc-read${notes ? '' : ' empty'}">${notes ? esc(notes) : 'No description'}</div>
        <div class="todo-modal-edit" style="display:none">
            <div class="tm-field">
                <label class="todo-modal-label">Description</label>
                <textarea class="todo-modal-desc-edit" placeholder="Add a description…" oninput="autoGrow(this)">${esc(notes)}</textarea>
            </div>
            <div class="tm-field">
                <label class="todo-modal-label">Do on <span class="todo-add-opt">(date + time, optional)</span></label>
                <div class="tm-row">
                    <input type="date" class="todo-modal-due-input" value="${esc(dueIso)}">
                    <input type="time" class="todo-modal-time-input" value="${esc(dueTime)}">
                </div>
            </div>
            <div class="tm-field">
                <label class="todo-modal-label">Place</label>
                <select class="todo-modal-place" onchange="tmPlaceChanged(this)">${placeOpts}</select>
                <div class="tm-newplace" style="display:none">
                    <input type="text" class="tm-newplace-name" placeholder="Place name">
                    <input type="text" class="tm-newplace-addr" placeholder="Address (optional)">
                    <button type="button" class="modal-btn confirm" style="background:var(--accent)" onclick="tmSaveNewPlace(this)">Save place</button>
                </div>
            </div>
            <div class="tm-field">
                <label class="todo-modal-label">Category</label>
                <select class="todo-modal-category">${catOpts}</select>
            </div>
            <div class="tm-field">
                <label class="todo-modal-label">Duration <span class="todo-add-opt">(rough estimate)</span></label>
                <div class="tm-chips">${durChips}<input type="number" min="0" step="5" class="todo-modal-duration" placeholder="min" value="${item.duration_min ? esc(item.duration_min) : ''}"></div>
            </div>
            <div class="tm-field">
                <label class="todo-modal-label">Status</label>
                <div class="tm-chips todo-modal-status">${statusChips}</div>
            </div>
        </div>
        <div class="todo-modal-foot">
            <button type="button" class="todo-modal-delete" onclick="confirmDeleteTodoItem(this.closest('.todo-modal-body').dataset.id, this.closest('.todo-modal-body').dataset.item)">Delete</button>
            ${added ? `<span class="todo-modal-foot-added">${esc(added)}</span>` : ''}
            <button type="button" class="todo-desc-editbtn" onclick="toggleTodoModalEdit(this)">Edit</button>
        </div>
    </div>`;
    showEditorModal('To-do', body);
    const h3 = document.getElementById('panel-modal-title');
    if (h3) h3.innerHTML = `<span class="todo-modal-kicker">To-do:</span> <span class="todo-modal-htitle">${esc(text)}</span><textarea class="todo-modal-htitle-edit" rows="1" placeholder="To-do" oninput="autoGrow(this)" style="display:none">${esc(text)}</textarea>`;
}

// Edit/Save toggle inside the item detail modal — flips title, due date and
// description between read and edit, and persists all three on Save.
async function toggleTodoModalEdit(btn) {
    const body = btn.closest('.todo-modal-body');
    if (!body) return;
    const headerTitle = document.querySelector('#panel-modal-title .todo-modal-htitle');
    const titleEdit = document.querySelector('#panel-modal-title .todo-modal-htitle-edit');
    const metaRow = body.querySelector('.todo-modal-meta');
    const editPanel = body.querySelector('.todo-modal-edit');
    const descRead = body.querySelector('.todo-modal-desc-read');
    const descEdit = body.querySelector('.todo-modal-desc-edit');

    if (btn.textContent.trim() === 'Edit') {
        headerTitle.style.display = 'none';
        titleEdit.style.display = '';
        autoGrow(titleEdit);
        if (editPanel) editPanel.style.display = '';
        if (metaRow) metaRow.style.display = 'none';
        descRead.style.display = 'none';
        descEdit.style.display = 'block';
        autoGrow(descEdit);
        titleEdit.focus();
        titleEdit.setSelectionRange(titleEdit.value.length, titleEdit.value.length);
        btn.textContent = 'Save';
        return;
    }

    // Save — title via rename, everything else via the generic details updater.
    const id = body.dataset.id || body.dataset.item;
    const oldText = body.dataset.item;
    const newText = titleEdit.value.trim() || oldText;
    const notes = descEdit.value.trim();
    const due = body.querySelector('.todo-modal-due-input').value;
    const dueTime = body.querySelector('.todo-modal-time-input').value;
    let placeSel = body.querySelector('.todo-modal-place').value;
    if (placeSel === '__new__') placeSel = '';   // an unsaved "add place" choice → none
    const category = body.querySelector('.todo-modal-category').value;
    const duration = body.querySelector('.todo-modal-duration').value;
    const statusBtn = body.querySelector('.todo-modal-status .tm-chip.active');
    const status = statusBtn ? statusBtn.dataset.val : '';

    if (newText !== oldText) {
        await fetch('/api/todos/rename', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, old: oldText, new: newText })
        });
    }
    await fetch('/api/todos/details', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, notes, due_by: due, due_time: dueTime, place_id: placeSel, category, duration_min: duration, status })
    });
    hideEditorModal();
    loadDashboard();
}

// Shared "are you sure" delete confirm — sits above the detail modal. Pass the
// label to show and a callback to run when the user confirms.
function _showDeleteConfirm(label, onYes) {
    let ov = document.getElementById('todo-confirm-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'todo-confirm-overlay';
        ov.className = 'modal-overlay';
        ov.style.zIndex = '200';   // above the detail modal (z-index 100)
        ov.innerHTML = `<div class="modal" style="max-width:380px">
            <p id="todo-confirm-text"></p>
            <div class="modal-buttons">
                <button class="modal-btn confirm" id="todo-confirm-yes">Delete</button>
                <button class="modal-btn cancel" onclick="closeTodoConfirm()">Cancel</button>
            </div>
        </div>`;
        document.body.appendChild(ov);
        ov.addEventListener('click', e => { if (e.target === ov) closeTodoConfirm(); });
    }
    ov.querySelector('#todo-confirm-text').textContent = `Delete “${label}”? This can’t be undone.`;
    ov.querySelector('#todo-confirm-yes').onclick = onYes;
    ov.classList.add('open');
}
function closeTodoConfirm() {
    const ov = document.getElementById('todo-confirm-overlay');
    if (ov) ov.classList.remove('open');
}

// To-do item delete (from the detail modal)
function confirmDeleteTodoItem(id, label) {
    _showDeleteConfirm(label || id, () => deleteTodoItemConfirmed(id));
}
async function deleteTodoItemConfirmed(id) {
    await fetch('/api/todos/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    closeTodoConfirm();
    hideEditorModal();
    loadDashboard();
}

// Working On (growth) delete — same are-you-sure confirm
function confirmDeleteGrowth(text) {
    _showDeleteConfirm(text, () => deleteGrowthConfirmed(text));
}
async function deleteGrowthConfirmed(text) {
    await fetch('/api/growth/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });
    closeTodoConfirm();
    hideEditorModal();
    loadDashboard();
}

// Tap a Working On item → a simple detail modal: title + description (no due /
// no to-do fields), with an Edit/Save toggle and an are-you-sure Delete.
function openGrowthDetail(el, ev) {
    if (ev && ev.target && ev.target.closest('a')) return;
    const row = el.closest('.card-item');
    if (!row) return;
    const text = row.dataset.habit || '';
    const notes = row.dataset.notes || '';
    const body = `<div class="todo-modal-body growth-modal-body" data-item="${esc(text)}">
        <div class="todo-modal-desc-read${notes ? '' : ' empty'}">${notes ? esc(notes) : 'No description'}</div>
        <textarea class="todo-modal-desc-edit" placeholder="Add a description…" oninput="autoGrow(this)" style="display:none">${esc(notes)}</textarea>
        <div class="todo-modal-foot">
            <button type="button" class="todo-modal-delete" onclick="confirmDeleteGrowth(this.closest('.todo-modal-body').dataset.item)">Delete</button>
            <button type="button" class="todo-desc-editbtn" onclick="toggleGrowthModalEdit(this)">Edit</button>
        </div>
    </div>`;
    showEditorModal('Working on', body);
    const h3 = document.getElementById('panel-modal-title');
    if (h3) h3.innerHTML = `<span class="todo-modal-kicker">Working on:</span> <span class="todo-modal-htitle">${esc(text)}</span><textarea class="todo-modal-htitle-edit" rows="1" placeholder="Working on…" oninput="autoGrow(this)" style="display:none">${esc(text)}</textarea>`;
}

async function toggleGrowthModalEdit(btn) {
    const body = btn.closest('.todo-modal-body');
    if (!body) return;
    const headerTitle = document.querySelector('#panel-modal-title .todo-modal-htitle');
    const titleEdit = document.querySelector('#panel-modal-title .todo-modal-htitle-edit');
    const descRead = body.querySelector('.todo-modal-desc-read');
    const descEdit = body.querySelector('.todo-modal-desc-edit');

    if (btn.textContent.trim() === 'Edit') {
        headerTitle.style.display = 'none';
        titleEdit.style.display = '';
        autoGrow(titleEdit);
        descRead.style.display = 'none';
        descEdit.style.display = 'block';
        autoGrow(descEdit);
        titleEdit.focus();
        titleEdit.setSelectionRange(titleEdit.value.length, titleEdit.value.length);
        btn.textContent = 'Save';
        return;
    }

    const oldText = body.dataset.item;
    const newText = titleEdit.value.trim() || oldText;
    const notes = descEdit.value.trim();
    if (newText !== oldText) {
        await fetch('/api/growth/rename', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old: oldText, new: newText })
        });
        body.dataset.item = newText;
    }
    await fetch('/api/growth/details', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newText, notes })
    });
    if (headerTitle) headerTitle.textContent = newText;
    descRead.textContent = notes || 'No description';
    descRead.classList.toggle('empty', !notes);
    headerTitle.style.display = '';
    titleEdit.style.display = 'none';
    descRead.style.display = '';
    descEdit.style.display = 'none';
    btn.textContent = 'Edit';
    loadDashboard();
}

async function saveTodoNotes(ta) {
    const notes = ta.value.trim();
    const id = ta.dataset.item;  // the inline notes editor carries the stable id
    await fetch('/api/todos/details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, notes })
    });
    // Keep every view of this item's description in sync (modal ↔ inline editor
    // ↔ read display) so reopening or entering edit mode shows the latest.
    document.querySelectorAll('.todo-notes-input, .todo-modal-desc').forEach(el => {
        if (el !== ta && el.dataset.item === id) el.value = ta.value;
    });
    document.querySelectorAll('#tab-today .card-item').forEach(row => {
        if (row.dataset.id !== id) return;
        const detail = row.nextElementSibling;
        const desc = detail && detail.querySelector('.todo-detail-desc');
        if (!desc) return;
        desc.textContent = notes || 'No description';
        desc.classList.toggle('empty', !notes);
    });
}

// Drop a bucket's manual order so it auto-sorts (due date, then age) again.
async function autosortTodos(section) {
    await fetch('/api/todos/autosort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section })
    });
    loadDashboard();
}

// Short, friendly "added" date label (e.g. "Jun 6"). Hides the current year.
function _fmtAddedDate(iso) {
    try {
        const d = new Date(iso + 'T12:00:00');
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) { return iso; }
}

function _isOverdue(iso) {
    try {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        return new Date(iso + 'T12:00:00') < today;
    } catch (e) { return false; }
}

// --- Toggle functions ---
async function toggleTodo(item) {
    await fetch('/api/todos/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item })
    });
    loadDashboard();
}

async function toggleHabit(habit) {
    await fetch('/api/habits/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit })
    });
    loadDashboard();
}

async function toggleHabitDate(habit, date) {
    await fetch('/api/habits/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit, date })
    });
    loadDashboard();
}

function confirmHabitDot(habit, date) {
    pendingDelete = { type: 'habit-dot', habit, date };
    document.getElementById('modal-text').innerHTML = `Remove <b>${esc(habit)}</b> on ${date}?`;
    document.getElementById('modal').classList.add('open');
}

function toggleChore(chore) {
    const today = todayStr();
    const choreLog = JSON.parse(localStorage.getItem('choreLog') || '{}');
    if (!choreLog[today]) choreLog[today] = {};
    if (choreLog[today][chore]) {
        delete choreLog[today][chore];
    } else {
        choreLog[today][chore] = true;
    }
    // Clean up old days (keep last 3)
    const dates = Object.keys(choreLog).sort();
    while (dates.length > 3) { delete choreLog[dates.shift()]; }
    localStorage.setItem('choreLog', JSON.stringify(choreLog));
    render();
}

// --- addEdge ---
async function addEdge(inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;
    const res = await fetch('/api/edges/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: text })
    });
    if (res.ok) {
        inputEl.value = '';
        loadDashboard();
    } else {
        const data = await res.json();
        alert(data.error || 'Failed to add');
    }
}

// --- Constants ---
// Shape = family (movement circle, errands square, linens diamond, meds
// triangle, body ring); color = the individual ritual within it.
const ACT_TYPES = {
    run:              { label: 'Run',     color: 'var(--green)', shape: 'circle' },
    kitchen:          { label: 'Grocery', color: '#4A90D9', shape: 'square' },
    'laundry-sheets': { label: 'Sheets',  color: '#E06060', shape: 'diamond' },
    'wash-eyemasks':  { label: 'Eye masks', color: '#5BB8C9', shape: 'diamond' },
    'change-pillowcase': { label: 'Pillowcase', color: '#D4A0A0', shape: 'diamond' },
    'wash-hair':      { label: 'Hair wash', color: '#8B7EC8', shape: 'ring' },
    estradiol:        { label: 'Estradiol', color: '#E091C7', shape: 'triangle' },
    peptides:         { label: 'Peptides', color: '#6FBF8B', shape: 'triangle' },
};

// Activity types hidden from the public legend (their entries are also stripped
// server-side, so logged-out visitors see no trace). The live set is driven by
// each reminder's `private` flag, exposed publicly as D.private_act_types; this
// constant is the fallback when that field is absent.
const PRIVATE_ACT_TYPES = ['estradiol', 'peptides'];

function privateActTypes() {
    const d = (typeof D !== 'undefined' && D && D.private_act_types) || null;
    return Array.isArray(d) && d.length ? d : PRIVATE_ACT_TYPES;
}

// The calendar's type map is derived: the hardcoded ACT_TYPES above are the
// base (run/grocery/estradiol are "system" types with their own subsystems),
// and the user-managed reminder registry (data/reminders.json → D.reminders)
// overrides/extends it so colors + labels stay in sync everywhere.
function activityTypeMap() {
    const map = Object.assign({}, ACT_TYPES);
    ((typeof D !== 'undefined' && D && D.reminders) || []).forEach(r => {
        if (!r || !r.type) return;
        map[r.type] = {
            label: r.label || r.type, color: r.color || '#9AA0B5', emoji: r.emoji || '',
            shape: r.shape || (map[r.type] && map[r.type].shape) || 'circle',
        };
    });
    return map;
}

const APP_STATUSES = ['applied', '1st round interview', '2nd round interview', 'offer', 'rejected', 'withdrawn'];
const APP_STATUS_CLASS = (s) => {
    s = s.toLowerCase();
    if (s.includes('interview')) return 'interviewing';
    if (s.includes('offer')) return 'offer';
    if (s.includes('reject')) return 'rejected';
    if (s.includes('withdrawn')) return 'withdrawn';
    return 'applied';
};

// --- Dev Notes (per-tab friction log) ---
// Lives at the bottom of any page that has a div with class "dev-notes-area"
// or a div whose id starts with "dev-notes-". The div needs `data-tab="<key>"`.
// Notes are loaded from D.dev_notes (the page's data endpoint must populate it).

// Which note (if any) is currently being inline-edited: { tab, id } or null.
let _devNoteEditing = null;

function renderDevNotes() {
    const els = document.querySelectorAll('[id^="dev-notes-"]');
    els.forEach(el => {
        const tab = el.dataset.tab || el.id.replace('dev-notes-', '');
        // Preserve open/closed state across re-renders so adding/deleting a
        // note doesn't collapse the panel.
        const wasOpen = el.querySelector('details')?.open;
        const notes = D.dev_notes || [];
        const rows = notes.map(n => {
            const editing = _devNoteEditing && _devNoteEditing.tab === tab && _devNoteEditing.id === n.id;
            if (editing) {
                return `<div style="padding:8px 0;border-top:1px solid var(--border)">
                    <textarea id="devnote-edit-${esc(tab)}-${esc(n.id)}" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'" style="width:100%;box-sizing:border-box;min-height:72px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.4;font-family:inherit;background:var(--bg);color:var(--text);resize:none;overflow:hidden">${esc(n.text)}</textarea>
                    <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end">
                        <button onclick="saveDevNote('${escJs(tab)}','${escJs(n.id)}')" style="padding:5px 12px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Save</button>
                        <button onclick="cancelDevNoteEdit()" style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text-muted);font-size:12px;cursor:pointer">Cancel</button>
                    </div>
                </div>`;
            }
            return `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--border);font-size:13px">
                <div style="flex:1">${esc(n.text)}</div>
                <div style="font-size:12px;color:var(--text-muted);white-space:nowrap">${esc(n.created || '')}</div>
                <button onclick="editDevNote('${escJs(tab)}','${escJs(n.id)}')" title="Edit" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;padding:0 4px">&#9998;</button>
                <button onclick="removeDevNote('${escJs(tab)}','${escJs(n.id)}')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0 4px">&times;</button>
            </div>`;
        }).join('');
        const addBox = (which) => `<div style="display:flex;gap:6px;align-items:flex-end;margin-${which === 'top' ? 'bottom' : 'top'}:10px">
                    <textarea rows="1" id="devnote-input-${esc(tab)}-${which}" placeholder="What's bugging you about this page?" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.4;font-family:inherit;outline:none;background:var(--bg);color:var(--text);resize:none;overflow:hidden" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addDevNote('${escJs(tab)}','${which}')}"></textarea>
                    <button onclick="addDevNote('${escJs(tab)}','${which}')" style="padding:6px 14px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Add</button>
                </div>`;
        el.innerHTML = `<details style="margin-top:24px"${wasOpen ? ' open' : ''}>
            <summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Dev notes${notes.length ? ` (${notes.length})` : ''}</summary>
            <div class="card" style="border-left-color:var(--text-muted);margin-top:8px;padding:10px">
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Friction, change ideas, things to fix on this page.</div>
                ${addBox('top')}
                ${rows}
                ${notes.length ? addBox('bottom') : ''}
            </div>
        </details>`;
    });
}

async function addDevNote(tab, which) {
    const input = document.getElementById(`devnote-input-${tab}-${which || 'top'}`)
        || document.getElementById(`devnote-input-${tab}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const res = await fetch('/api/devnote/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, text })
    });
    if (res.ok) {
        input.value = '';
        input.style.height = '';
        await refreshDevNotes(tab);
    }
}

function editDevNote(tab, id) {
    _devNoteEditing = { tab, id };
    renderDevNotes();
    const ta = document.getElementById(`devnote-edit-${tab}-${id}`);
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function cancelDevNoteEdit() {
    _devNoteEditing = null;
    renderDevNotes();
}

async function saveDevNote(tab, id) {
    const ta = document.getElementById(`devnote-edit-${tab}-${id}`);
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;
    const res = await fetch('/api/devnote/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, id, text })
    });
    if (res.ok) {
        _devNoteEditing = null;
        await refreshDevNotes(tab);
    }
}

function removeDevNote(tab, id) {
    const note = (D.dev_notes || []).find(n => n.id === id);
    confirmDelete(note ? note.text : 'this note', 'devnote');
    pendingDelete = { type: 'devnote', tab, id, item: note ? note.text : 'this note' };
}

// Refresh just the dev-notes panel from the server without a full dashboard
// reload, so the open panel and scroll position are preserved.
async function refreshDevNotes(tab) {
    try {
        const r = await fetch(`/api/devnotes/${tab}`);
        if (r.ok) {
            const data = await r.json();
            D.dev_notes = data.notes || [];
            renderDevNotes();
            return;
        }
    } catch (e) { /* fall through to full reload */ }
    loadDashboard();
}

// --- Settings (opens as a tab in the parent split-screen's right pane) ---

function openSettings() {
    // We're inside the dashboard iframe; ask the parent (split.html) to switch the
    // right-pane view to Settings. Falls back to direct navigation if there's no parent.
    try {
        if (window.parent && window.parent !== window && typeof window.parent.openSettingsTab === 'function') {
            window.parent.openSettingsTab();
            return;
        }
    } catch (e) { /* cross-origin or no parent — fall through */ }
    (window.top || window).location.href = '/settings';
}

function closeSettings() {
    // Legacy stub; the panel concept is gone. Settings is now a tab in the parent shell.
    try {
        if (window.parent && window.parent !== window && typeof window.parent.openDashboardTab === 'function') {
            window.parent.openDashboardTab();
        }
    } catch (e) { /* no-op */ }
}

// --- Tab bar auto-fit + overflow into More ------------------------------------
// The bar shows the 3 core tabs plus as many optional tabs (.tab-opt) as fit the
// pane; the rest are moved into the More menu. Because each optional tab lives in
// exactly one place at a time, the active highlight can never land on both a bar
// tab and the More button (the old CSS-media-query approach kept duplicates,
// which is what caused the double-highlight). Re-runs on every render and resize.
function setTabActive() {
    document.querySelectorAll('#tab-selector .time-btn').forEach(btn => {
        if (btn.id === 'more-btn') return;
        btn.classList.toggle('active', btn.dataset.tab === currentTab);
    });
    let activeMenuLabel = null;
    document.querySelectorAll('#more-menu a[data-tab]').forEach(a => {
        const on = a.dataset.tab === currentTab;
        a.classList.toggle('active', on);
        if (on) activeMenuLabel = a.textContent.trim();
    });
    const moreBtn = document.getElementById('more-btn');
    if (moreBtn) {
        // More reflects the current tab ONLY when that tab actually lives in the
        // menu; a tab visible in the bar never also lights up More.
        moreBtn.textContent = `${activeMenuLabel || 'More'} ▾`;
        moreBtn.classList.toggle('active', !!activeMenuLabel);
    }
}

function layoutTabs() {
    const sel = document.getElementById('tab-selector');
    const menu = document.getElementById('more-menu');
    if (!sel || !menu) { return; }
    const row = sel.parentElement;  // flex row: selector pill + settings gear
    // 1. Reset — every optional tab back in the bar, clear previously injected items.
    const opt = [...sel.querySelectorAll('.time-btn.tab-opt')];
    opt.forEach(b => { b.style.display = ''; });
    menu.querySelectorAll('.tab-injected').forEach(n => n.remove());
    // 2. Space available to the selector pill = the row minus the (optional) gear.
    const gear = document.getElementById('settings-gear');
    const gearW = (gear && gear.offsetParent !== null) ? gear.offsetWidth + 12 : 0;
    const avail = (row ? row.clientWidth : 0) - gearW;
    // 3. Hide optional tabs from the end until the pill fits (keep core 3 + More).
    const overflowed = [];
    if (avail > 0) {
        for (let i = opt.length - 1; i >= 0; i--) {
            if (sel.offsetWidth <= avail) break;
            opt[i].style.display = 'none';
            overflowed.unshift(opt[i]);
        }
    }
    // 4. Inject the overflowed tabs above the always-in-More items, in bar order.
    const anchor = menu.firstChild;
    overflowed.forEach(b => {
        const a = document.createElement('a');
        a.className = 'tab-injected';
        a.href = b.getAttribute('href');
        a.dataset.tab = b.dataset.tab;
        a.textContent = b.textContent.trim();
        a.addEventListener('click', (e) => switchTab(e, b.dataset.tab));
        menu.insertBefore(a, anchor);
    });
    setTabActive();
}

// Re-fit on viewport changes (debounced to one run per animation frame).
let _tabLayoutPending = false;
window.addEventListener('resize', () => {
    if (_tabLayoutPending) return;
    _tabLayoutPending = true;
    requestAnimationFrame(() => { _tabLayoutPending = false; layoutTabs(); });
});

// --- More dropdown (Priority+ nav overflow) ---

function toggleMore(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('more-menu');
    if (menu) menu.classList.toggle('open');
}

function closeMore() {
    const menu = document.getElementById('more-menu');
    if (menu) menu.classList.remove('open');
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('more-menu');
    const btn = document.getElementById('more-btn');
    if (!menu || !btn) return;
    if (menu.classList.contains('open') && !menu.contains(e.target) && e.target !== btn) {
        closeMore();
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMore();
});
