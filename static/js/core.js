// core.js — shared globals, utilities, render loop, modal, drag-drop, card system

// --- Global variables ---
let D = null; // dashboard data
let _serverDate = null;
let selectedTime = null;
let _serverTodLast = null;   // last server time-of-day, to detect boundary crossings
let pendingDelete = null;
let expandedAll = false;
let currentTab = document.body.dataset.activeTab || 'today';

// Keep the time-of-day display rolling with the actual day. A manual pick on
// the Morning/Midday/Evening selector holds — but only until the server's part
// of day next changes, then the roll resumes. (Before this, selectedTime was
// set once and a PWA left open simply froze on its load-time part of day.)
function syncTimeOfDay(tod) {
    if (!tod) return;
    if (_serverTodLast === null) _serverTodLast = tod;
    if (tod !== _serverTodLast) {
        _serverTodLast = tod;
        selectedTime = tod;
    }
    if (!selectedTime) selectedTime = tod;
}

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
    housing: '/api/data/housing',
    people: '/api/data/people',
    meditation: '/api/data/meditation',
    media: '/api/data/media',
    movement: '/api/data/movement',
    body: '/api/data/body',
    ideas: '/api/data/ideas',
    ecosystem: '/api/data/ecosystem',
};

// TAB_RENDERERS is built lazily in render() because the functions
// are defined in other JS files that load after core.js
let TAB_RENDERERS = null;

// --- Lazy tab assets (kitchen.js/kitchen-recipes.js/leaflet.js/ecosystem.js) ---
// Which tabs need which entry in window.TAB_ASSETS. 'body' needs the kitchen
// group too — its food-safety cards (renderFoodExperiments/renderFoodTriage/
// renderSafeFoods/renderSuspectFoods/renderInflammatoryFoods) live in kitchen.js.
const TAB_ASSET_GROUPS = { kitchen: 'kitchen', body: 'kitchen', ecosystem: 'ecosystem' };
let _tabAssetPromises = {};

function _loadScriptSeq(urls) {
    // Sequential, not parallel: each script must finish (and run) before the
    // next is even appended, so execution order matches document order
    // (leaflet.js before ecosystem.js, kitchen.js before kitchen-recipes.js).
    return urls.reduce((p, url) => p.then(() => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('script load failed: ' + url));
        document.body.appendChild(s);
    })), Promise.resolve());
}

// Ensures the JS group a tab needs is present, fetching it (once) if not.
// Memoized per group so repeated/concurrent calls share the same promise.
function ensureTabAssets(name) {
    const group = TAB_ASSET_GROUPS[name];
    if (!group) return Promise.resolve();
    window.TAB_ASSETS_LOADED = window.TAB_ASSETS_LOADED || {};
    if (window.TAB_ASSETS_LOADED[group]) return Promise.resolve();
    if (_tabAssetPromises[group]) return _tabAssetPromises[group];
    const urls = (window.TAB_ASSETS && window.TAB_ASSETS[group]) || [];
    if (!urls.length) return Promise.resolve();
    const p = _loadScriptSeq(urls).then(() => {
        window.TAB_ASSETS_LOADED[group] = true;
    }).catch(err => {
        console.error('ensureTabAssets: failed to load "' + group + '" assets:', err);
        delete _tabAssetPromises[group];  // let a later retry re-attempt
        throw err;
    });
    _tabAssetPromises[group] = p;
    return p;
}

// --- initTab ---
function initTab() {
    document.getElementById('tab-today').style.display = currentTab === 'today' ? '' : 'none';
    document.getElementById('tab-map').style.display = currentTab === 'map' ? '' : 'none';
    document.getElementById('tab-kitchen').style.display = currentTab === 'kitchen' ? '' : 'none';
    document.getElementById('tab-inventory').style.display = currentTab === 'inventory' ? '' : 'none';
    document.getElementById('tab-money').style.display = currentTab === 'money' ? '' : 'none';
    const carEl = document.getElementById('tab-car');
    if (carEl) carEl.style.display = currentTab === 'car' ? '' : 'none';
    const housingEl = document.getElementById('tab-housing');
    if (housingEl) housingEl.style.display = currentTab === 'housing' ? '' : 'none';
    const medEl = document.getElementById('tab-meditation');
    if (medEl) medEl.style.display = currentTab === 'meditation' ? '' : 'none';
    const mediaEl = document.getElementById('tab-media');
    if (mediaEl) mediaEl.style.display = currentTab === 'media' ? '' : 'none';
    const movementEl = document.getElementById('tab-movement');
    if (movementEl) movementEl.style.display = currentTab === 'movement' ? '' : 'none';
    const bodyEl = document.getElementById('tab-body');
    if (bodyEl) bodyEl.style.display = currentTab === 'body' ? '' : 'none';
    const ideasEl = document.getElementById('tab-ideas');
    if (ideasEl) ideasEl.style.display = currentTab === 'ideas' ? '' : 'none';
    const ecoEl = document.getElementById('tab-ecosystem');
    if (ecoEl) ecoEl.style.display = currentTab === 'ecosystem' ? '' : 'none';
    const peopleEl = document.getElementById('tab-people');
    if (peopleEl) peopleEl.style.display = currentTab === 'people' ? '' : 'none';

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
// While the programmatic open/close sweep runs, card-memory writes are
// suppressed — otherwise "show hidden" stamps open=1 into every card's saved
// state and "hide" has nothing to restore (the bug where collapsing left all
// the to-do and habit cards open).
let _suppressCardMemory = false;

function toggleExpandAll() {
    expandedAll = !expandedAll;
    document.getElementById('expand-btn').textContent = expandedAll ? 'Hide prompts' : 'Show hidden prompts';
    _suppressCardMemory = true;
    if (expandedAll) {
        render();
        document.querySelectorAll('details').forEach(d => { d.open = true; });
    } else {
        // Back to the page's usual layout: wipe the visit's collapse memory and
        // re-render so defaults apply (only "Now", the day views, the active
        // habit card) instead of leaving everything the sweep opened.
        resetTodoCollapseMemory();
        document.querySelectorAll('#tab-today details').forEach(d => { d.open = false; });
        render();
    }
    setTimeout(() => { _suppressCardMemory = false; }, 100);
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
    if (_suppressCardMemory) return;   // programmatic show/hide-all sweeps don't count
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
    if (window._ecoModalOpen) {
        // Editing an ecosystem source in the modal — drop the draft and refresh.
        window._ecoModalOpen = false;
        window._ecoDraft = null;
        window._ecoPanelState = null;
        if (typeof renderEcosystem === 'function') renderEcosystem();
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
        syncTimeOfDay(D.time_of_day);
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
    // Authoritative guard: never rebuild the DOM while she's mid-keystroke.
    // polling.js's _inputFocused flag is event-based (focusin/focusout) and can
    // miss iOS PWA blips — the autocorrect bar etc. fires focusout *between*
    // keystrokes, flipping the flag false while she's still typing. Checking
    // activeElement here, at render time, can't be fooled by a stale flag.
    // Defer instead of skipping: flip the shared _pendingRender flag so
    // polling.js's focusout handler (and its next-poll-tick fallback) replays
    // this render once she's actually done, so no update is lost.
    const _typingEl = document.activeElement;
    if (_typingEl && (_typingEl.tagName === 'INPUT' || _typingEl.tagName === 'TEXTAREA' || _typingEl.isContentEditable)) {
        if (typeof _pendingRender !== 'undefined') _pendingRender = true;
        return;
    }
    if (!TAB_RENDERERS) {
        TAB_RENDERERS = {
            today: [
                renderHeader, renderFoodBanner,
                () => {
                    // renderGroceryQuick lives in kitchen.js, which is lazy.
                    // Don't block Today's paint on it — fetch in the background
                    // and fill the grocery card in when it lands.
                    if (typeof renderGroceryQuick === 'function') { renderGroceryQuick(); return; }
                    ensureTabAssets('kitchen').then(() => {
                        if (currentTab === 'today' && typeof renderGroceryQuick === 'function') renderGroceryQuick();
                    }).catch(() => {});
                },
                renderReminders, renderGraduationPrompts, renderContactReminders, renderContacts,
                renderContactCalendar, renderHabits, renderTodos, renderSymptomForm,
                renderDevNotes, restoreEditModes
            ],
            map: [
                renderHeader, renderContacts, renderContactCalendar,
                renderHabitTracker, renderActivityCalendar, renderReminderManager,
                renderDevNotes, restoreEditModes
            ],
            body: [
                renderHeader,
                () => { if (typeof renderFoodExperiments === 'function') renderFoodExperiments(); },
                () => { if (typeof renderFoodTriage === 'function') renderFoodTriage(); },
                () => { if (typeof renderSafeFoods === 'function') renderSafeFoods(); },
                () => { if (typeof renderSuspectFoods === 'function') renderSuspectFoods(); },
                () => { if (typeof renderInflammatoryFoods === 'function') renderInflammatoryFoods(); },
                renderDotGrid, renderSymptomDefinitions, renderFoodLog,
                renderDevNotes, restoreEditModes
            ],
            kitchen: [
                renderHeader,
                () => { if (typeof renderGroceryList === 'function') renderGroceryList(); },
                renderDevNotes, restoreEditModes
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
                        if (typeof renderArchivals === 'function') renderArchivals();
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
            housing: [
                renderHeader, renderHousingNotes, renderHousingAddForm, renderHousingList,
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
            ideas: [
                renderHeader, renderIdeasByPage, renderIdeasDoc, renderDevNotes, restoreEditModes
            ],
            ecosystem: [
                renderHeader,
                () => { if (typeof renderEcosystem === 'function') renderEcosystem(); },
                renderDevNotes, restoreEditModes
            ],
            people: [
                renderHeader, renderPeopleTab, renderDevNotes, restoreEditModes
            ],
        };
    }
    // Preserve an in-progress input across the DOM rebuild (the PWA
    // "my half-typed note vanished" bug): snapshot the focused field, restore
    // value + focus + caret after re-render. Keyed by the field's id, or by
    // its parent's id for the id-less add-form inputs.
    let snap = null;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        const key = ae.id || (ae.parentElement && ae.parentElement.id ? ae.parentElement.id : '');
        if (key) {
            snap = {
                byParent: !ae.id, key, tag: ae.tagName, value: ae.value,
                start: ae.selectionStart, end: ae.selectionEnd,
            };
        }
    }

    const fns = TAB_RENDERERS[currentTab] || Object.values(TAB_RENDERERS).flat();
    for (const fn of fns) {
        try { fn(); } catch(e) { console.error(fn.name + ' failed:', e); }
    }
    // Category-tagged to-dos strip — no-ops on tabs without a container.
    try { renderTabTodos(); } catch(e) { console.error('renderTabTodos failed:', e); }

    if (snap) {
        const host = document.getElementById(snap.key);
        const el = snap.byParent ? (host && host.querySelector(snap.tag)) : host;
        if (el && el.tagName === snap.tag && snap.value && el.value !== snap.value) {
            el.value = snap.value;
            if (el.tagName === 'TEXTAREA' && typeof autoGrow === 'function') autoGrow(el);
        }
        // Re-focus only when this document actually holds keyboard focus.
        // activeElement stays pointed at the last-focused input even after the
        // user clicks into another pane (in split view the dashboard is an
        // iframe beside the terminal) — focusing it here would steal the
        // keyboard back across panes mid-typing.
        if (el && document.hasFocus()) {
            try {
                el.focus({ preventScroll: true });
                el.setSelectionRange(snap.start, snap.end);
            } catch (e) { /* date/number inputs don't support selection — fine */ }
        }
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
        <span class="streak-chip-body" onclick="openStreakDetail('${escJs(s.label)}','${esc(s.since)}')" title="Notes & details">
            <span class="num">Day ${s.days}</span> ${esc(s.label)}
        </span>
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

// Streak detail modal — mirrors the To-do detail modal: read view + an
// Edit/Save toggle on a freeform notes field (dosage, changes, milestones).
// A streak label ("on doxycycline") → a tidy habit name ("Doxycycline").
function streakHabitName(label) {
    const n = (label || '').replace(/^(on|off|of)\s+/i, '').trim();
    return n ? n[0].toUpperCase() + n.slice(1) : label;
}

function openStreakDetail(label, since) {
    const s = (D.streaks || []).find(x => x.label === label && x.since === since);
    if (!s) return;
    const notes = s.notes || '';
    // Habit linkage: this streak can also be tracked as daily habit checkboxes.
    const habitName = streakHabitName(label);
    const curSections = (typeof _habitSectionsOf === 'function') ? _habitSectionsOf(habitName) : [];
    let courseDays = 0;
    for (const sec of curSections) { const m = habitMeta(sec, habitName); if (m && m.course_days) { courseDays = m.course_days; break; } }
    const defs = (typeof habitSectionDefs === 'function') ? habitSectionDefs() : [];
    const inp = 'padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:15px';
    const secChecks = defs.map(d => `<label style="display:inline-flex;align-items:center;gap:7px;min-height:40px;margin-right:16px;font-size:15px;cursor:pointer">
        <input type="checkbox" class="hc-section" value="${esc(d.name)}" ${curSections.includes(d.name) ? 'checked' : ''} style="width:20px;height:20px;cursor:pointer"> ${d.label}
    </label>`).join('');
    const courseOn = courseDays > 0;
    const body = `<div class="streak-modal-body" data-label="${esc(label)}" data-since="${esc(since)}" data-habit="${esc(habitName)}" data-linked="${curSections.length ? '1' : ''}">
        <div class="todo-modal-desc-read${notes ? '' : ' empty'}">${notes ? esc(notes) : 'No notes yet'}</div>
        <div class="streak-modal-edit" style="display:none">
            <div class="tm-field">
                <label class="todo-modal-label">Notes</label>
                <textarea class="todo-modal-desc-edit" placeholder="Dosage, changes, milestones…" oninput="autoGrow(this)">${esc(notes)}</textarea>
            </div>
            <div class="tm-field" style="border-top:1px solid var(--border);padding-top:12px;margin-top:6px">
                <label class="todo-modal-label">Track as a daily habit</label>
                <div style="font-size:12px;color:var(--text-muted);margin:2px 0 6px">Adds checkboxes named “${esc(habitName)}” to your habit cards. Uncheck all to stop.</div>
                <div>${secChecks}</div>
                <label style="display:flex;align-items:center;gap:8px;min-height:40px;cursor:pointer">
                    <input id="hc-course-on" type="checkbox" ${courseOn ? 'checked' : ''} onchange="hcToggleCourse()" style="width:20px;height:20px;cursor:pointer">
                    <span class="todo-modal-label" style="margin:0">Temporary course — auto-archives when it ends</span>
                </label>
                <div id="hc-course-fields" style="display:${courseOn ? 'flex' : 'none'};align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
                    <span style="font-size:15px">Length</span>
                    <input id="hc-course-days" type="number" min="1" value="${courseDays || 10}" oninput="hcUpdateEnd()" style="${inp};width:72px">
                    <span style="font-size:15px">days</span>
                    <span id="hc-course-end" style="color:var(--text-muted);font-size:13px"></span>
                </div>
            </div>
        </div>
        <div class="todo-modal-foot streak-modal-foot">
            <button type="button" class="todo-modal-delete" onclick="removeStreakFromModal()">Delete</button>
            <span class="streak-modal-meta">Started ${esc(since)}</span>
            <button type="button" class="todo-desc-editbtn" onclick="toggleStreakEdit(this)">Edit</button>
        </div>
    </div>`;
    showEditorModal('Streak', body);
    const h3 = document.getElementById('panel-modal-title');
    if (h3) h3.innerHTML = `<span class="todo-modal-kicker">Day ${s.days}</span> <span class="todo-modal-htitle">${esc(label)}</span>`;
}

async function toggleStreakEdit(btn) {
    const body = btn.closest('.streak-modal-body');
    if (!body) return;
    const editPanel = body.querySelector('.streak-modal-edit');
    const descRead = body.querySelector('.todo-modal-desc-read');
    const descEdit = body.querySelector('.todo-modal-desc-edit');
    if (btn.textContent.trim() === 'Edit') {
        editPanel.style.display = '';
        descRead.style.display = 'none';
        autoGrow(descEdit);
        descEdit.focus();
        descEdit.setSelectionRange(descEdit.value.length, descEdit.value.length);
        btn.textContent = 'Save';
        return;
    }
    const notes = descEdit.value.trim();
    await fetch('/api/streaks/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: body.dataset.label, since: body.dataset.since, notes })
    });
    // Habit linkage: create/update/remove the daily-habit checkboxes for this streak.
    const habitName = body.dataset.habit;
    if (habitName) {
        const sections = [...body.querySelectorAll('.hc-section:checked')].map(c => c.value);
        const courseOn = body.querySelector('#hc-course-on') && body.querySelector('#hc-course-on').checked;
        const courseDays = courseOn ? (parseInt(body.querySelector('#hc-course-days').value, 10) || 0) : 0;
        if (sections.length) {
            await fetch('/api/habits/configure', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: habitName, sections, course_days: courseDays })
            });
        } else if (body.dataset.linked) {        // was linked, now all unchecked → unlink
            await fetch('/api/habits/configure', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: habitName, remove: true })
            });
        }
    }
    hideEditorModal();
    loadDashboard();
}

function removeStreakFromModal() {
    const body = document.querySelector('.streak-modal-body');
    if (!body) return;
    hideEditorModal();
    removeStreak(body.dataset.label, body.dataset.since);
}

function renderHeader() {
    const greetingEl = document.getElementById('greeting');
    const dateEl = document.getElementById('date-info');
    if (currentTab === 'today') {
        const greetings = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' };
        greetingEl.textContent = greetings[getTime()];
        // The date line also carries the "Show hidden prompts" toggle — write the
        // date into its own span so the button (a sibling) survives re-renders.
        const dateText = document.getElementById('date-text');
        if (dateText) dateText.textContent = D.date; else dateEl.textContent = D.date;
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
    // Ecosystem deep-link: open straight into tracing a recipe (from the kitchen
    // tab's "View on map" button), or clear it on a plain tab switch.
    if (name === 'ecosystem') {
        window._ecoRecipeView = (extra && extra.recipe) ? extra.recipe : null;
        window._ecoFittedRecipe = null;
        window._ecoLastSources = null;
    }
    if (name === currentTab) {
        // Already on this tab — just apply the deep-link by re-rendering, once
        // this tab's lazy assets (if any) are in place.
        ensureTabAssets(name).catch(() => {}).then(() => {
            if (name === 'movement' && typeof renderMovement === 'function') renderMovement();
            if (name === 'ecosystem' && typeof renderEcosystem === 'function') renderEcosystem();
        });
        return;
    }
    currentTab = name;
    document.body.dataset.activeTab = name;
    if (name === 'today') resetTodoCollapseMemory();  // start the To-Do page fresh
    // Fetch this tab's fat JS (if it has any and it isn't already loaded) before
    // rendering it — ensures e.g. renderGroceryList/renderEcosystem are real
    // functions (not no-op guards) by the time render() runs for this tab.
    // Swallow load failures so a flaky fetch doesn't leave the tab stuck blank —
    // the guarded renderers just no-op and initTab()/loadDashboard() still run.
    ensureTabAssets(name).catch(() => {}).then(() => {
        initTab();
        loadDashboard();
    });
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

// Edit-mode ▲▼ reorder — the touch-friendly counterpart of drag-and-drop
// (drag doesn't work on the PWA). Same DOM-order → endpoint logic as
// habitDrop's same-card branch.
async function moveCardItem(btn, type, dir) {
    const row = btn.closest('.card-item');
    const card = btn.closest('.card');
    if (!row || !card) return;
    const allItems = [...card.querySelectorAll('.card-item[draggable]')];
    const fromIdx = allItems.indexOf(row);
    const toIdx = fromIdx + dir;
    if (fromIdx === -1 || toIdx < 0 || toIdx >= allItems.length) return;
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
            body: JSON.stringify({ section: row.dataset.section, items })
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
            ${type === 'todo' ? `<button class="delete-btn todo-action" onclick="todoEditDetails('${escJs(id)}')" title="All details (time, place, category…)" style="font-size:15px">&#8943;</button>` : ''}
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
        ? `<div class="empty-state">Nothing here — add one ${type === 'todo' ? 'with + add above' : 'below'}</div>`
        : '';

    // To-do cards add from the title row (+ Add next to edit); other card
    // types keep their inline bottom form.
    const addId = `add-${type}-${sectionName.replace(/\s+/g,'-')}`;
    const addForm = type === 'todo'
        ? ''
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
            ${type === 'todo' ? `<span class="add-toggle" onclick="event.preventDefault();event.stopPropagation();openAddTodoModal('${escJs(sectionName)}')">+ add</span>` : ''}
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
    const name = (sectionName || '').toLowerCase();
    // Default open: always "Now". When ANY Focus filter is active (a theme or
    // Other — i.e. not "All"), also open "Up Next": a filtered view is short, so
    // showing the next tier helps rather than clutters. On "All" it stays shut.
    let theme = '';
    try { theme = (typeof getFocusTheme === 'function') ? getFocusTheme() : ''; } catch (e) {}
    if (theme && name === 'up next') return true;
    return name === 'now';
}
function todoCardToggled(d, sectionName) {
    if (_suppressCardMemory) return;   // programmatic show/hide-all sweeps don't count
    try { localStorage.setItem('todoOpenV2:' + sectionName, d.open ? '1' : '0'); } catch (e) {}
}

// "show all" / "collapse all" button next to the To Do title. Unlike the
// prompts sweep above, this one writes card memory on purpose (via each
// card's ontoggle): a state you asked for by name should survive data
// re-renders for the rest of the visit.
function toggleAllTodoCards(btn) {
    const cards = document.querySelectorAll('#todo-cards details.todo-card');
    if (!cards.length) return;
    const anyClosed = Array.from(cards).some(d => !d.open);
    cards.forEach(d => { d.open = anyClosed; });
    btn.textContent = anyClosed ? 'collapse all' : 'show all';
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
    // Fresh visit, default layout — the show/collapse-all button starts over too.
    const btn = document.getElementById('todo-showall-btn');
    if (btn) btn.textContent = 'show all';
}

// --- habitCount, habitStartLabel, habitCardHTML ---

// Done-state key for a habit: 'section|text' (mirrors data_helpers.habit_log_key)
// so the same text can live in Morning AND Evening with independent checkboxes.
function habitKey(section, text) {
    return (section || '').trim().toLowerCase() + '|' + text;
}

// Which HABITS.md section a habit text currently lives in (first match).
function habitSectionOf(text) {
    for (const s of (D.habits || [])) {
        if ((s.items || []).includes(text)) return s.name;
    }
    return '';
}

function habitCount(habit, section) {
    const key = habitKey(section !== undefined ? section : habitSectionOf(habit), habit);
    let count = 0;
    for (const date in D.habits_log) {
        if (D.habits_log[date][key]) count++;
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
        const done = !!todayLog[habitKey(sectionName, item)];
        const total = habitCount(item, sectionName);
        const target = 60;
        const cad = habitCadence(sectionName, item);
        const spot = isGraduated(cad);
        const ci = courseInfo(sectionName, item);
        const rightLabel = ci
            ? `<span onclick="openHabitConfig('${escJs(sectionName)}','${escJs(item)}')" title="Day ${ci.dayNum} of ${ci.days} — tap to edit the course" style="font-size:12px;margin-left:auto;white-space:nowrap;cursor:pointer;color:var(--evening);background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:1px 8px">day ${ci.dayNum}/${ci.days}</span>`
            : spot
            ? `<span style="font-size:12px;margin-left:auto;white-space:nowrap;color:var(--ongoing);background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:1px 8px" title="A spot-check — keeping this habit honest on a light cadence">${esc(cad.stage)} check</span>`
            : `<span style="font-size:12px;color:var(--text-muted);margin-left:auto">${habitStartLabel(item)}${total}/${target}</span>`;
        const lnk = HABIT_LINKS[item.toLowerCase()];
        const linkBtn = lnk
            ? `<button class="habit-link-btn" onclick="switchTab(event,'${esc(lnk.tab)}'${lnk.routine ? `,{routine:'${escJs(lnk.routine)}'}` : ''})" title="Open routine" aria-label="Open linked page">&#8599;</button>`
            : '';

        return `<div class="card-item" draggable="true" data-section="${esc(sectionName)}" data-idx="${idx}" data-habit="${esc(item)}"
                ondragstart="habitDragStart(event)" ondragover="habitDragOver(event)" ondrop="habitDrop(event,'habit')" ondragend="habitDragEnd(event)" ondragleave="habitDragLeave(event)">
            <span class="drag-handle" onmousedown="dragFromHandle=true">&#8942;&#8942;</span>
            <span class="reorder-arrows">
                <button onclick="moveCardItem(this,'habit',-1)" title="Move up">&#9650;</button>
                <button onclick="moveCardItem(this,'habit',1)" title="Move down">&#9660;</button>
            </span>
            <span class="habit-check ${done?'done':''}" onclick="toggleHabit('${escJs(item)}','${escJs(sectionName)}')" title="Toggle today">
                ${done ? '&#10003;' : '&#9675;'}
            </span>
            <span class="item-text habit-view" style="${done?'text-decoration:line-through;opacity:0.5':''}">${esc(item)}${linkBtn}</span>
            <textarea class="habit-rename habit-edit" rows="1" style="display:none" data-original="${esc(item)}" data-section="${esc(sectionName)}"
                oninput="autoGrow(this)" onblur="commitRename(this)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}else if(event.key==='Escape'){this.value=this.dataset.original;this.blur()}">${esc(item)}</textarea>
            ${rightLabel}
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
            body: JSON.stringify({ habit: pendingDelete.habit, date: pendingDelete.date, section: pendingDelete.section || '' })
        });
    } else if (pendingDelete.type === 'streak') {
        await fetch('/api/streaks/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: pendingDelete.label, since: pendingDelete.since })
        });
    } else if (pendingDelete.type === 'devnote' || pendingDelete.type === 'ideanote') {
        const { kind, tab } = pendingDelete;
        const cfg = NOTE_KINDS[kind];
        const notes = D[cfg.dataKey] || [];
        const index = notes.findIndex(n => n.id === pendingDelete.id);
        const note = notes[index];
        await fetch(`${cfg.api}/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tab, id: pendingDelete.id })
        });
        if (note) _notePush(kind, tab, { kind: 'delete', note, index });
        closeModal();
        await refreshNotes(kind, tab);
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
    } else if (pendingDelete.type === 'ecosystem-source') {
        await fetch('/api/ecosystem/source/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: pendingDelete.item })
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
    } else if (pendingDelete.type === 'housing-place') {
        await fetch('/api/housing/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: pendingDelete.item })
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
    // If a Focus filter is active, pre-tag the new to-do with that theme so it
    // lands inside the view you're looking at. ('Other'/__none__ → stays blank.)
    const ft = getFocusTheme();
    const presetTheme = (ft && ft !== '__none__') ? ft : '';
    // Time lives behind "More options" alongside the rest of todoAttrFieldsHTML
    // — quick-add only surfaces title / due / description / Focus up front.
    const timeFieldHTML = `<div class="tm-field">
                <label class="todo-modal-label">Time <span class="todo-add-opt">(optional)</span></label>
                <input type="time" id="add-todo-time" class="todo-modal-time-input">
            </div>`;
    const html = `
        <form class="todo-add-form" onsubmit="event.preventDefault();submitAddTodoModal('${escJs(section)}')">
            <label class="todo-add-label">
                <span class="todo-add-labeltext">To-do</span>
                <textarea id="add-todo-text" class="todo-add-input" rows="1" placeholder="What needs doing?" autocomplete="off"
                    oninput="autoGrow(this)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitAddTodoModal('${escJs(section)}')}"></textarea>
            </label>
            <label class="todo-add-label">
                <span class="todo-add-labeltext">Due by <span class="todo-add-opt">(optional)</span></span>
                <input type="date" id="add-todo-due" class="todo-add-input" value="${esc(presetDue)}" onchange="addTodoDueChanged(this)">
            </label>
            <label class="todo-add-label">
                <span class="todo-add-labeltext">Description <span class="todo-add-opt">(optional)</span></span>
                <textarea id="add-todo-desc" class="todo-add-input" rows="2" placeholder="Any details…" oninput="autoGrow(this)"></textarea>
            </label>
            <div class="todo-modal-edit">
                ${todoThemeFieldHTML(presetTheme)}
                ${tmMoreHTML(timeFieldHTML + todoAttrFieldsHTML({}), false)}
            </div>
            <div class="todo-add-actions">
                <button type="button" class="modal-btn cancel" onclick="closeActiveEditor()">Cancel</button>
                <button type="submit" class="modal-btn confirm" style="background:var(--accent)">Add</button>
            </div>
        </form>`;
    showEditorModal('Add to ' + (opts.dayLabel || section), html);
    // Header "Now" becomes a picker: the real lists, plus Today/Tomorrow — which
    // are day views (due today/tomorrow), not lists. Picking a day sets the due
    // date; the to-do still files into the underlying list (data-base). The
    // picker and the Due-by input stay in sync both ways (see the two handlers
    // next to submitAddTodoModal).
    const sections = (D.todos || []).filter(s => !s.name.toLowerCase().startsWith('done')).map(s => s.name);
    const h3 = document.getElementById('panel-modal-title');
    if (h3 && sections.length) {
        const selVal = presetDue === todayStr() ? '__today__' : (presetDue === tomorrowStr() ? '__tomorrow__' : section);
        const optHTML = [['__today__', 'Today'], ['__tomorrow__', 'Tomorrow']]
            .map(([v, l]) => `<option value="${v}"${selVal === v ? ' selected' : ''}>${l}</option>`).join('')
            + sections.map(s => `<option value="${esc(s)}"${selVal === s ? ' selected' : ''}>${esc(s)}</option>`).join('');
        h3.innerHTML = `Add to <select id="add-todo-section" class="todo-add-section" data-base="${esc(section)}" onchange="addTodoSectionChanged(this)">${optHTML}</select>`;
    }
    setTimeout(() => { const el = document.getElementById('add-todo-text'); if (el) el.focus(); }, 50);
}

// The Today/Tomorrow day views are computed from due dates, so "add here" means
// "add a to-do in Now dated for that day" — then it surfaces in the day view.
function addToDay(label) {
    const due = label === 'Tomorrow' ? tomorrowStr() : todayStr();
    openAddTodoModal('Now', { due, dayLabel: label });
}

// Two-way sync between the header picker and the Due-by input. Picker → day
// option sets the matching due date; picker → real list clears the date it
// set (only a today/tomorrow date — a hand-picked other date is left alone)
// and becomes the new fallback list. Date → today/tomorrow flips the picker
// to that day; any other date flips it back to the fallback list.
function addTodoSectionChanged(sel) {
    const due = document.getElementById('add-todo-due');
    if (!due) return;
    if (sel.value === '__today__') due.value = todayStr();
    else if (sel.value === '__tomorrow__') due.value = tomorrowStr();
    else {
        sel.dataset.base = sel.value;
        if (due.value === todayStr() || due.value === tomorrowStr()) due.value = '';
    }
}
function addTodoDueChanged(inp) {
    const sel = document.getElementById('add-todo-section');
    if (!sel) return;
    if (inp.value === todayStr()) sel.value = '__today__';
    else if (inp.value === tomorrowStr()) sel.value = '__tomorrow__';
    else if (sel.value === '__today__' || sel.value === '__tomorrow__') sel.value = sel.dataset.base;
}

async function submitAddTodoModal(section) {
    const textEl = document.getElementById('add-todo-text');
    const text = textEl.value.trim();
    if (!text) { textEl.focus(); return; }
    // The header picker wins over the section the modal opened with; a day
    // option means "the underlying list, dated for that day" (the due date is
    // already in #add-todo-due via the sync handlers).
    const sectionSel = document.getElementById('add-todo-section');
    if (sectionSel) {
        section = (sectionSel.value === '__today__' || sectionSel.value === '__tomorrow__')
            ? (sectionSel.dataset.base || section) : sectionSel.value;
    }
    const due_by = document.getElementById('add-todo-due').value;
    const notes = document.getElementById('add-todo-desc').value.trim();
    // Attribute fields (same selectors as the detail modal's edit panel).
    const form = textEl.closest('form');
    const due_time = document.getElementById('add-todo-time')?.value || '';
    let place_id = form.querySelector('.todo-modal-place')?.value || '';
    if (place_id === '__new__') place_id = '';
    const category = form.querySelector('.todo-modal-category .tm-chip.active')?.dataset.val || '';
    // Pre-selected from the active Focus filter (see openAddTodoModal), so a plain
    // read keeps the new to-do inside the view you added it from.
    const theme = form.querySelector('.todo-modal-theme')?.value || '';
    const duration_min = form.querySelector('.todo-modal-duration')?.value || '';
    const statusBtn = form.querySelector('.todo-modal-status .tm-chip.active');
    const status = statusBtn ? statusBtn.dataset.val : '';
    const res = await fetch('/api/todos/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: text, section, due_by, notes, due_time, place_id, category, theme, duration_min, status })
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
    // Day views (Today / Tomorrow) edit in the same big modal as the ladder
    // buckets — their item list is computed over due dates (todos.js).
    const isDay = sectionName === 'Today' || sectionName === 'Tomorrow';
    let visible, manualOrder = false;
    if (isDay) {
        visible = (typeof dayViewItems === 'function') ? dayViewItems(sectionName) : [];
    } else {
        const section = (D.todos || []).find(s => s.name === sectionName);
        if (!section) { window._editBucket = null; return; }
        manualOrder = section.manual_order;
        const today = (typeof todayStr === 'function') ? todayStr() : '';
        visible = (section.items || []).filter(it => {
            const su = (it && typeof it === 'object') ? it.snoozed_until : null;
            return !(su && su > today && !it.done);
        });
    }
    const slug = sectionName.replace(/\s+/g, '-');
    let html = cardHTML(sectionName, visible, 'var(--accent)', 'todo', sectionName, false, manualOrder);
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
// Focus themes — the "what project is this part of" axis (separate from
// `category`, which routes a to-do to a page tab). Drives the Focus chip strip
// at the top of the To Do page: pick one and the ladder collapses to just it.
const TODO_THEMES = [
    { key: 'move', label: 'Move', emoji: '🏠' },
    { key: 'job', label: 'Job', emoji: '💼' },
    { key: 'health', label: 'Health', emoji: '🩺' },
    { key: 'admin', label: 'Admin', emoji: '📋' },
    { key: 'life', label: 'Life', emoji: '🌱' },
    { key: 'exocortex', label: 'Exocortex', emoji: '🧠' },
];
function _themeLabel(key) { if (key === '__none__') return '🏷️ Other'; const t = TODO_THEMES.find(t => t.key === key); return t ? `${t.emoji} ${t.label}` : (key || ''); }

function findTodoById(id) {
    for (const sec of (D.todos || [])) {
        for (const it of (sec.items || [])) {
            if (it && typeof it === 'object' && (it.id === id || it.text === id)) return it;
        }
    }
    return null;
}
// Which bucket (section name) a to-do currently lives in — for the detail
// modal's "List" mover.
function findTodoSectionName(id) {
    for (const sec of (D.todos || [])) {
        for (const it of (sec.items || [])) {
            if (it && typeof it === 'object' && (it.id === id || it.text === id)) return sec.name;
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
// Generic scoped single-select-with-clear chip handler — tap a chip to select
// it (clearing any sibling in the same .tm-chips wrap), tap the active chip
// again to clear it. Reused by status *and* category (todoAttrFieldsHTML),
// not just status despite the name.
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

// Shared attribute-field markup (place / category / duration / status) for the
// to-do editors — used by both the detail modal's edit panel and the add modal.
// Focus lives in its own todoThemeFieldHTML above; the rest are here. Selectors
// (.todo-modal-*) are shared too, so the same readers work in both places.
// The Focus (theme) field, pulled out so it can sit on its own — right below
// Description and above Time — in both the add and detail modals.
function todoThemeFieldHTML(theme) {
    // Blank = "Other": untagged items surface under the Other chip, so leaving a
    // to-do without a theme is a real (named) choice, not a forgotten one.
    const themeOpts = ['<option value="">🏷️ Other</option>']
        .concat(TODO_THEMES.map(t => `<option value="${esc(t.key)}"${t.key === theme ? ' selected' : ''}>${t.emoji} ${esc(t.label)}</option>`)).join('');
    return `<div class="tm-field">
                <label class="todo-modal-label">Focus</label>
                <select class="todo-modal-theme">${themeOpts}</select>
            </div>`;
}

function todoAttrFieldsHTML(item) {
    item = item || {};
    const placeOpts = ['<option value="">No place</option>']
        .concat((D.places || []).map(p => `<option value="${esc(p.id)}"${p.id === item.place_id ? ' selected' : ''}>${esc(p.name)}</option>`))
        .concat(['<option value="__new__">➕ Add a place…</option>']).join('');
    // No "none" chip: clearing the category means tapping the active chip
    // again (tmStatusChip's existing clear-on-reclick behavior).
    const catChips = TODO_CATEGORIES.map(c => `<button type="button" class="tm-chip${item.category === c.key ? ' active' : ''}" data-val="${esc(c.key)}" onclick="tmStatusChip(this)">${esc(c.label)}</button>`).join('');
    const durChips = [15, 30, 60].map(m => `<button type="button" class="tm-chip${item.duration_min === m ? ' active' : ''}" onclick="tmDurationChip(this, ${m})">${m}m</button>`).join('');
    const statusChips = TODO_STATUSES.map(s => `<button type="button" class="tm-chip${item.status === s.key ? ' active' : ''}" data-val="${esc(s.key)}" onclick="tmStatusChip(this)">${esc(s.label)}</button>`).join('');
    return `
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
                <div class="tm-chips todo-modal-category">${catChips}</div>
            </div>
            <div class="tm-field">
                <label class="todo-modal-label">Duration <span class="todo-add-opt">(rough estimate)</span></label>
                <div class="tm-chips">${durChips}<input type="number" min="0" step="5" class="todo-modal-duration" placeholder="min" value="${item.duration_min ? esc(item.duration_min) : ''}"></div>
            </div>
            <div class="tm-field">
                <label class="todo-modal-label">Status</label>
                <div class="tm-chips todo-modal-status">${statusChips}</div>
            </div>`;
}

// Generic collapsible "more options" wrapper — the app's existing kitchen-arrow
// chevron idiom (see cardHTML's todo-card summary), reused here. `inner` stays
// in the DOM whether or not the <details> is open, so every field it wraps
// keeps working with existing scoped readers (form/body .querySelector).
function tmMoreHTML(inner, open) {
    return `<details class="tm-more"${open ? ' open' : ''}>
        <summary class="tm-more-summary">
            <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
            <span>More options</span>
        </summary>
        <div class="tm-more-body">${inner}</div>
    </details>`;
}

// Whether an item carries any of the fields tucked behind "More options", so
// the detail modal's expander can default open instead of hiding data the
// item already has.
function _hasHiddenAttrs(item) {
    return !!(item.place_id || item.category || item.duration_min || item.status);
}

// Tap a to-do → its detail modal. Read mode shows attribute chips; Edit reveals
// the date+time, place, category, duration and status controls.
function openTodoDetail(el, ev) {
    if (ev && ev.target && ev.target.closest('a')) return;
    const row = el.closest('.card-item');
    if (!row) return;
    const rowText = row.dataset.habit || '';
    openTodoDetailById(row.dataset.id || rowText, { fallbackText: rowText, fallbackDue: row.dataset.due || '' });
}

// Same modal, addressed by id — used by edit-mode rows (incl. the big bucket
// modal) where there's no tappable view-mode row. opts.edit opens straight
// into edit mode.
function openTodoDetailById(id, opts) {
    opts = opts || {};
    const item = findTodoById(id) || { text: opts.fallbackText || String(id) };
    const text = item.text || opts.fallbackText || '';
    const dueIso = item.due_by || opts.fallbackDue || '';
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

    // "List" mover: every bucket except Done (checking off handles Done).
    const curSection = findTodoSectionName(id) || '';
    const bucketOpts = (D.todos || [])
        .filter(s => !s.name.toLowerCase().startsWith('done'))
        .map(s => `<option value="${esc(s.name)}"${s.name === curSection ? ' selected' : ''}>${esc(s.name)}</option>`).join('');

    // List/bucket mover markup, folded into the "More options" expander (D) below.
    const bucketFieldHTML = bucketOpts ? `<div class="tm-field">
                <label class="todo-modal-label">List <span class="todo-add-opt">(move to another section)</span></label>
                <select class="todo-modal-bucket" data-original="${esc(curSection)}">${bucketOpts}</select>
            </div>` : '';
    const body = `<div class="todo-modal-body" data-item="${esc(text)}" data-id="${esc(id)}" data-due="${esc(dueIso)}">
        <div class="todo-modal-meta"${metaBits.length ? '' : ' style="display:none"'}>${metaBits.join('')}</div>
        <div class="todo-modal-desc-read${notes ? '' : ' empty'}" onclick="todoQuickEditDesc(this)">${notes ? esc(notes) : 'No description'}</div>
        <div class="todo-modal-edit" style="display:none">
            <div class="tm-field">
                <label class="todo-modal-label">Do on <span class="todo-add-opt">(date + time, optional)</span></label>
                <div class="tm-row">
                    <input type="date" class="todo-modal-due-input" value="${esc(dueIso)}">
                    <input type="time" class="todo-modal-time-input" value="${esc(dueTime)}">
                </div>
            </div>
        </div>
        <div class="todo-modal-edit" style="display:none">
            <div class="tm-field">
                <label class="todo-modal-label">Description</label>
                <textarea class="todo-modal-desc-edit" placeholder="Add a description…" oninput="autoGrow(this)">${esc(notes)}</textarea>
            </div>
        </div>
        <div class="todo-modal-edit" style="display:none">
            ${todoThemeFieldHTML(item.theme)}
        </div>
        <div class="todo-modal-edit" style="display:none">
            ${tmMoreHTML(todoAttrFieldsHTML(item) + bucketFieldHTML, _hasHiddenAttrs(item))}
        </div>
        <div class="todo-modal-foot">
            <button type="button" class="todo-modal-delete" onclick="confirmDeleteTodoItem(this.closest('.todo-modal-body').dataset.id, this.closest('.todo-modal-body').dataset.item)">Delete</button>
            ${added ? `<span class="todo-modal-foot-added">${esc(added)}</span>` : ''}
            <button type="button" class="todo-desc-editbtn" onclick="toggleTodoModalEdit(this)">Edit</button>
        </div>
    </div>`;
    showEditorModal('To-do', body);
    const h3 = document.getElementById('panel-modal-title');
    if (h3) h3.innerHTML = `<span class="todo-modal-kicker">To-do:</span> <span class="todo-modal-htitle" onclick="todoQuickEditTitle()">${esc(text)}</span><textarea class="todo-modal-htitle-edit" rows="1" placeholder="To-do" oninput="autoGrow(this)" style="display:none">${esc(text)}</textarea>`;
    if (opts.edit) {
        const b = document.querySelector('#panel-modal .todo-desc-editbtn');
        if (b) toggleTodoModalEdit(b);
    }
}

// From an edit-mode row (incl. the bucket/day edit modal) into the full
// attribute editor — time, place, category, duration, status, list.
function todoEditDetails(id) {
    closeActiveEditor();
    openTodoDetailById(id, { edit: true });
}

// Edit/Save toggle inside the item detail modal — flips title, due date and
// description between read and edit, and persists all three on Save.
async function toggleTodoModalEdit(btn) {
    const body = btn.closest('.todo-modal-body');
    if (!body) return;
    const headerTitle = document.querySelector('#panel-modal-title .todo-modal-htitle');
    const titleEdit = document.querySelector('#panel-modal-title .todo-modal-htitle-edit');
    const metaRow = body.querySelector('.todo-modal-meta');
    const editPanels = body.querySelectorAll('.todo-modal-edit');   // 4 sibling wrappers (see openTodoDetailById)
    const descRead = body.querySelector('.todo-modal-desc-read');
    const descEdit = body.querySelector('.todo-modal-desc-edit');

    if (btn.textContent.trim() === 'Edit') {
        headerTitle.style.display = 'none';
        titleEdit.style.display = '';
        autoGrow(titleEdit);
        editPanels.forEach(p => p.style.display = '');
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
    const category = body.querySelector('.todo-modal-category .tm-chip.active')?.dataset.val || '';
    const theme = body.querySelector('.todo-modal-theme').value;
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
        body: JSON.stringify({ id, notes, due_by: due, due_time: dueTime, place_id: placeSel, category, theme, duration_min: duration, status })
    });
    // Moved to a different list? Do it last so rename/details found the item
    // in place first.
    const bucketSel = body.querySelector('.todo-modal-bucket');
    if (bucketSel && bucketSel.value && bucketSel.value !== bucketSel.dataset.original) {
        await fetch('/api/todos/move', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, item: oldText, to_section: bucketSel.value })
        });
    }
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

// Tap-to-edit, read mode only, in the to-do detail modal (openTodoDetailById).
// NOT wired on the growth or streak modals — they reuse the same
// .todo-modal-htitle / .todo-modal-desc-read classes but are different modals;
// their onclick hooks are intentionally absent, so this pair never fires there.
function todoQuickEditTitle() {
    const headerTitle = document.querySelector('#panel-modal-title .todo-modal-htitle');
    const titleEdit = document.querySelector('#panel-modal-title .todo-modal-htitle-edit');
    if (!headerTitle || !titleEdit) return;
    headerTitle.style.display = 'none';
    titleEdit.style.display = '';
    autoGrow(titleEdit);
    titleEdit.focus();
    titleEdit.setSelectionRange(titleEdit.value.length, titleEdit.value.length);
    titleEdit.onblur = () => todoQuickSaveTitle(titleEdit);
}

async function todoQuickSaveTitle(el) {
    el.onblur = null;   // clear first — a programmatic blur during the DOM swap below must not re-fire this
    const headerTitle = document.querySelector('#panel-modal-title .todo-modal-htitle');
    const body = document.querySelector('#panel-modal-body .todo-modal-body');
    if (!headerTitle || !body) return;
    const oldText = body.dataset.item;
    const newText = el.value.trim();
    // Swap back to read mode synchronously, before any fetch: browser event
    // order is mousedown -> blur -> click, so if the user blurred by clicking
    // Edit/Delete, that click must land on clean read-mode DOM, not DOM that's
    // still mid-request.
    headerTitle.style.display = '';
    el.style.display = 'none';
    if (!newText || newText === oldText) { el.value = oldText; return; }   // revert silently, no fetch
    headerTitle.textContent = newText;
    body.dataset.item = newText;   // read by the Delete label + move payload elsewhere
    const id = body.dataset.id || oldText;
    await fetch('/api/todos/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, old: oldText, new: newText })
    });
    loadDashboard();
}

// Same pattern for the description — swaps in wrapper (B) from
// openTodoDetailById in place of the read-mode div.
function todoQuickEditDesc(el) {
    const body = el.closest('.todo-modal-body');
    const descEdit = body && body.querySelector('.todo-modal-desc-edit');
    const wrap = descEdit && descEdit.closest('.todo-modal-edit');
    if (!descEdit || !wrap) return;
    el.style.display = 'none';
    wrap.style.display = '';
    autoGrow(descEdit);
    descEdit.focus();
    descEdit.onblur = () => todoQuickSaveDesc(descEdit);
}

async function todoQuickSaveDesc(el) {
    el.onblur = null;
    const wrap = el.closest('.todo-modal-edit');
    const body = el.closest('.todo-modal-body');
    const descRead = body && body.querySelector('.todo-modal-desc-read');
    if (!wrap || !body || !descRead) return;
    const notes = el.value.trim();
    // Swap back to read mode before the fetch, same reasoning as todoQuickSaveTitle.
    wrap.style.display = 'none';
    descRead.style.display = '';
    descRead.textContent = notes || 'No description';
    descRead.classList.toggle('empty', !notes);
    const id = body.dataset.id || body.dataset.item;
    // Same request shape as saveTodoNotes below.
    await fetch('/api/todos/details', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, notes })
    });
    // Refresh client state (D) like the title path does, so reopening the
    // modal before the next poll doesn't show the stale description.
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

async function toggleHabit(habit, section) {
    await fetch('/api/habits/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit, section: section !== undefined ? section : habitSectionOf(habit) })
    });
    loadDashboard();
}

async function toggleHabitDate(habit, date, section) {
    await fetch('/api/habits/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit, date, section: section !== undefined ? section : habitSectionOf(habit) })
    });
    loadDashboard();
}

function confirmHabitDot(habit, date, section) {
    pendingDelete = { type: 'habit-dot', habit, date, section: section !== undefined ? section : habitSectionOf(habit) };
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
    'wash-hair':      { label: 'Hair wash', color: '#8B7EC8', shape: 'circle' },
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

// --- Dev Notes + Idea Notes (the two per-tab capture panels) ---
// Every page bottom hosts two collapsible panels over the same component:
//   Dev notes — friction, fixes ("what's bugging you about this page?")
//   Ideas     — wants, features, what-ifs for this page
// Containers: <div id="dev-notes-<tab>"> / <div id="idea-notes-<tab>"> with
// data-tab. Data arrives as D.dev_notes / D.idea_notes (the page's tab only).
// A dev note that's really an idea moves down a panel via the 💡 button.

const NOTE_KINDS = {
    dev: {
        label: 'Dev notes',
        blurb: 'Friction, change ideas, things to fix on this page.',
        placeholder: "What's bugging you about this page?",
        prefix: 'dev-notes-',
        api: '/api/devnote',
        listUrl: tab => `/api/devnotes/${tab}`,
        dataKey: 'dev_notes',
        deleteType: 'devnote',
        accent: 'var(--text-muted)',
    },
    idea: {
        label: 'Ideas',
        blurb: 'Ideas for this page — features, wants, what-ifs.',
        placeholder: 'What could this page become?',
        prefix: 'idea-notes-',
        api: '/api/ideanote',
        listUrl: tab => `/api/ideanotes/${tab}`,
        dataKey: 'idea_notes',
        deleteType: 'ideanote',
        accent: 'var(--green)',
    },
};

// Which note (if any) is currently being inline-edited: {kind, tab, id} or null.
let _noteEditing = null;

// --- Undo/redo --------------------------------------------------------------
// Per-(kind,tab) history of destructive panel actions, kept in memory for the
// page session. Each action knows how to invert itself: Undo plays the inverse,
// Redo replays the original.
// Action shapes: {kind:'delete'|'ideas', note, index} | {kind:'edit', id, before, after}
window._noteHistory = window._noteHistory || {};

function _noteHist(kind, tab) {
    const key = kind + ':' + tab;
    return window._noteHistory[key] = window._noteHistory[key] || { undo: [], redo: [] };
}

// A fresh user action starts a new timeline: push to undo, clear redo.
function _notePush(kind, tab, action) {
    const h = _noteHist(kind, tab);
    h.undo.push(action);
    if (h.undo.length > 20) h.undo.shift();
    h.redo.length = 0;
}

async function _noteApply(kind, tab, a, dir) {
    const cfg = NOTE_KINDS[kind];
    const post = (url, body) => fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (a.kind === 'delete') {
        if (dir === 'undo') await post(`${cfg.api}/restore`, { tab, note: a.note, index: a.index });
        else await post(`${cfg.api}/remove`, { tab, id: a.note.id });
    } else if (a.kind === 'ideas') {   // dev-only: the 💡 move and its inverse
        if (dir === 'undo') await post('/api/devnote/restore', { tab, note: a.note, index: a.index, remove_from_ideas: true });
        else await post('/api/devnote/to_ideas', { tab, id: a.note.id });
    } else if (a.kind === 'edit') {
        await post(`${cfg.api}/edit`, { tab, id: a.id, text: dir === 'undo' ? a.before : a.after });
    }
}

async function noteHistoryStep(kind, tab, dir) {
    const h = _noteHist(kind, tab);
    const from = dir === 'undo' ? h.undo : h.redo;
    const to = dir === 'undo' ? h.redo : h.undo;
    const a = from.pop();
    if (!a) return;
    await _noteApply(kind, tab, a, dir);
    to.push(a);
    await refreshNotes(kind, tab, a.kind === 'ideas');
}

const _NOTE_ACTION_LABEL = { delete: 'delete', ideas: 'send to ideas', edit: 'edit' };

// --- Rendering ---------------------------------------------------------------

function renderNotePanels(kind) {
    const cfg = NOTE_KINDS[kind];
    document.querySelectorAll(`[id^="${cfg.prefix}"]`).forEach(el => {
        const tab = el.dataset.tab || el.id.replace(cfg.prefix, '');
        // Preserve open/closed state across re-renders so adding/deleting a
        // note doesn't collapse the panel.
        const wasOpen = el.querySelector('details')?.open;
        const notes = D[cfg.dataKey] || [];
        const rows = notes.map(n => {
            const editing = _noteEditing && _noteEditing.kind === kind && _noteEditing.tab === tab && _noteEditing.id === n.id;
            if (editing) {
                return `<div style="display:flex;gap:6px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--border)">
                    <textarea id="${kind}note-edit-${esc(tab)}-${esc(n.id)}" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'" style="flex:1;box-sizing:border-box;min-height:72px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.4;font-family:inherit;background:var(--bg);color:var(--text);resize:none;overflow:hidden">${esc(n.text)}</textarea>
                    <div style="display:flex;flex-direction:column;gap:6px">
                        <button onclick="saveNote('${kind}','${escJs(tab)}','${escJs(n.id)}')" style="padding:8px 12px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Save</button>
                        <button onclick="cancelNoteEdit()" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text-muted);font-size:12px;cursor:pointer">Cancel</button>
                    </div>
                </div>`;
            }
            const ideaBtn = kind === 'dev'
                ? `<button onclick="sendDevNoteToIdeas('${escJs(tab)}','${escJs(n.id)}')" title="Send to Ideas (moves this note into the Ideas panel)" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;padding:0 4px">&#128161;</button>`
                : '';
            return `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--border);font-size:13px">
                <div style="flex:1;min-width:0">
                    <div>${esc(n.text)}</div>
                    <div class="note-created" style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(n.created || '')}</div>
                </div>
                ${ideaBtn}
                <button onclick="editNote('${kind}','${escJs(tab)}','${escJs(n.id)}')" title="Edit" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;padding:0 4px">&#9998;</button>
                <button onclick="removeNote('${kind}','${escJs(tab)}','${escJs(n.id)}')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0 4px">&times;</button>
            </div>`;
        }).join('');
        const addBox = (which) => `<div style="display:flex;gap:6px;align-items:flex-start;margin-${which === 'top' ? 'bottom' : 'top'}:10px">
                    <textarea rows="1" id="${kind}note-input-${esc(tab)}-${which}" placeholder="${esc(cfg.placeholder)}" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.4;font-family:inherit;outline:none;background:var(--bg);color:var(--text);resize:none;overflow:hidden" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addNote('${kind}','${escJs(tab)}','${which}')}"></textarea>
                    <button onclick="addNote('${kind}','${escJs(tab)}','${which}')" style="padding:6px 14px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Add</button>
                </div>`;
        const h = _noteHist(kind, tab);
        const histBtn = (dir, stack, glyph) => {
            const top = stack[stack.length - 1];
            const label = top ? `${dir === 'undo' ? 'Undo' : 'Redo'} ${_NOTE_ACTION_LABEL[top.kind] || ''}` : (dir === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
            return `<button onclick="noteHistoryStep('${kind}','${escJs(tab)}','${dir}')" ${top ? '' : 'disabled'} title="${esc(label)}"
                style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:12px;padding:5px 10px;cursor:${top ? 'pointer' : 'default'};opacity:${top ? 1 : 0.4};white-space:nowrap">${glyph} ${dir === 'undo' ? 'Undo' : 'Redo'}</button>`;
        };
        el.innerHTML = `<details style="margin-top:${kind === 'dev' ? 24 : 10}px"${wasOpen ? ' open' : ''}>
            <summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">${esc(cfg.label)}${notes.length ? ` (${notes.length})` : ''}</summary>
            <div class="card" style="border-left-color:${cfg.accent};margin-top:8px;padding:10px">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
                    <div style="font-size:12px;color:var(--text-muted);flex:1">${esc(cfg.blurb)}</div>
                    ${histBtn('undo', h.undo, '&#8617;')}
                    ${histBtn('redo', h.redo, '&#8618;')}
                </div>
                ${addBox('top')}
                ${rows}
                ${notes.length ? addBox('bottom') : ''}
            </div>
        </details>`;
    });
}

// Kept under the old name — it's wired into every tab's renderer list.
// Renders BOTH panels (dev notes + ideas) for the current page.
function renderDevNotes() {
    renderNotePanels('dev');
    renderNotePanels('idea');
}

// --- Actions -----------------------------------------------------------------

async function addNote(kind, tab, which) {
    const cfg = NOTE_KINDS[kind];
    const input = document.getElementById(`${kind}note-input-${tab}-${which || 'top'}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const res = await fetch(`${cfg.api}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, text })
    });
    if (res.ok) {
        input.value = '';
        input.style.height = '';
        await refreshNotes(kind, tab);
    }
}

// A dev note that's really an idea: move it down into the same page's Ideas
// panel (id + created survive, so Undo is exact).
async function sendDevNoteToIdeas(tab, id) {
    const notes = D.dev_notes || [];
    const index = notes.findIndex(n => n.id === id);
    const note = notes[index];
    const res = await fetch('/api/devnote/to_ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, id })
    });
    if (res.ok) {
        if (note) _notePush('dev', tab, { kind: 'ideas', note, index });
        await refreshNotes('dev', tab, true);
    } else alert('Could not send to ideas');
}

function editNote(kind, tab, id) {
    _noteEditing = { kind, tab, id };
    renderDevNotes();
    const ta = document.getElementById(`${kind}note-edit-${tab}-${id}`);
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function cancelNoteEdit() {
    _noteEditing = null;
    renderDevNotes();
}

async function saveNote(kind, tab, id) {
    const cfg = NOTE_KINDS[kind];
    const ta = document.getElementById(`${kind}note-edit-${tab}-${id}`);
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;
    const before = ((D[cfg.dataKey] || []).find(n => n.id === id) || {}).text;
    const res = await fetch(`${cfg.api}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, id, text })
    });
    if (res.ok) {
        if (before !== undefined && before !== text) _notePush(kind, tab, { kind: 'edit', id, before, after: text });
        _noteEditing = null;
        await refreshNotes(kind, tab);
    }
}

function removeNote(kind, tab, id) {
    const cfg = NOTE_KINDS[kind];
    const note = (D[cfg.dataKey] || []).find(n => n.id === id);
    confirmDelete(note ? note.text : 'this note', cfg.deleteType);
    pendingDelete = { type: cfg.deleteType, kind, tab, id, item: note ? note.text : 'this note' };
}

// Refresh the panels from the server without a full dashboard reload, so the
// open panel and scroll position are preserved. `both` refetches the other
// panel too (a 💡 move touches dev AND idea). On the Ideas tab the by-page
// overview also needs the new state, so fall back to a full reload there.
async function refreshNotes(kind, tab, both) {
    if (currentTab === 'ideas') { loadDashboard(); return; }
    try {
        const kinds = both ? ['dev', 'idea'] : [kind];
        for (const k of kinds) {
            const cfg = NOTE_KINDS[k];
            const r = await fetch(cfg.listUrl(tab));
            if (!r.ok) throw new Error(r.status);
            const data = await r.json();
            D[cfg.dataKey] = data.notes || [];
        }
        renderDevNotes();
        return;
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
    // The ACTIVE tab is hidden last — it stays visible in the bar whenever any
    // arrangement allows it, so the current page never reads as "More ▾"-only.
    const overflowed = [];
    if (avail > 0) {
        for (let i = opt.length - 1; i >= 0; i--) {
            if (sel.offsetWidth <= avail) break;
            if (opt[i].dataset.tab === currentTab) continue;
            opt[i].style.display = 'none';
            overflowed.unshift(opt[i]);
        }
        // Still doesn't fit even with every other optional tab hidden → the
        // active one overflows too (tiny panes), and More correctly shows it.
        if (sel.offsetWidth > avail) {
            const act = opt.find(b => b.dataset.tab === currentTab && b.style.display !== 'none');
            if (act) {
                act.style.display = 'none';
                // Keep bar order in the menu: insert at its original position.
                const idx = opt.indexOf(act);
                let at = overflowed.findIndex(b => opt.indexOf(b) > idx);
                if (at === -1) at = overflowed.length;
                overflowed.splice(at, 0, act);
            }
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
