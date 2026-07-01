// todos.js — todo cards, applications

// All not-done (or done-today) unsnoozed items that belong to a day view.
// 'Today' = due today or overdue; 'Tomorrow' = due tomorrow. Shared by the
// page render and the day-card edit modal.
function dayViewItems(label) {
    const today = todayStr();
    const isSnoozed = it => it && typeof it === 'object' && it.snoozed_until && it.snoozed_until > today && !it.done;
    // Keep items checked off *today* visible (struck through) so completing
    // one in a day view persists instead of vanishing; the overnight sweep
    // clears them. Items done on an earlier day stay out.
    const doneToday = it => it.done && it.done_at === today;
    const all = [];
    (D.todos || []).forEach(section => {
        const name = section.name.toLowerCase().replace(/\s*—.*/, '').trim();
        if (name.startsWith('done')) return;
        (section.items || []).forEach(it => { if (it && typeof it === 'object') all.push(it); });
    });
    const live = all.filter(it => (!it.done || doneToday(it)) && !isSnoozed(it));
    if (label === 'Tomorrow') return live.filter(it => it.due_by === tomorrowStr());
    return live.filter(it => it.due_by && it.due_by <= today);
}

// --- Focus themes: filter the To Do page to one project area at a time. The
// selection lives in localStorage so the page reopens already focused.
function getFocusTheme() { try { return localStorage.getItem('todoFocusTheme') || ''; } catch (e) { return ''; } }
function setFocusTheme(t) { try { localStorage.setItem('todoFocusTheme', t || ''); } catch (e) {} renderTodos(); }
// '' = All; '__none__' = untagged only; else exact theme match.
function _focusMatch(it, theme) {
    if (!theme) return true;
    if (!it || typeof it !== 'object') return false;
    if (theme === '__none__') return !it.theme;
    return it.theme === theme;
}

// The chip strip: "All" + one chip per theme that has live items (plus the
// active one even if it just emptied). Count = not-done, not-snoozed items.
function focusBarHTML(activeTheme) {
    const today = todayStr();
    const counts = {}; let total = 0, none = 0;
    (D.todos || []).forEach(section => {
        const name = section.name.toLowerCase().replace(/\s*—.*/, '').trim();
        if (name.startsWith('done')) return;
        (section.items || []).forEach(it => {
            if (!it || typeof it !== 'object' || it.done) return;
            if (it.snoozed_until && it.snoozed_until > today) return;
            total++;
            if (it.theme) counts[it.theme] = (counts[it.theme] || 0) + 1;
            else none++;
        });
    });
    let chips = `<button type="button" class="focus-chip${!activeTheme ? ' active' : ''}" onclick="setFocusTheme('')">All<span class="focus-count">${total}</span></button>`;
    TODO_THEMES.forEach(t => {
        const c = counts[t.key] || 0;
        if (!c && t.key !== activeTheme) return;
        chips += `<button type="button" class="focus-chip${t.key === activeTheme ? ' active' : ''}" onclick="setFocusTheme('${escJs(t.key)}')">${t.emoji} ${esc(t.label)}<span class="focus-count">${c}</span></button>`;
    });
    // "Other" = untagged items. Only shown when there's something untagged (or
    // you're currently in it) — no empty chip cluttering the bar.
    if (none || activeTheme === '__none__') {
        chips += `<button type="button" class="focus-chip${activeTheme === '__none__' ? ' active' : ''}" onclick="setFocusTheme('__none__')">🏷️ Other<span class="focus-count">${none}</span></button>`;
    }
    return `<div class="focus-bar">${chips}</div>`;
}

function renderTodos() {
    const el = document.getElementById('todo-cards');
    if (isFrosted(D.todos)) {
        el.innerHTML = frostedCard('To Do', 5);
        return;
    }
    const colors = ['var(--todo-1)', 'var(--todo-2)', 'var(--todo-3)'];
    const hide = ['done'];
    const today = todayStr();
    const isSnoozed = it => it && typeof it === 'object' && it.snoozed_until && it.snoozed_until > today && !it.done;
    const theme = getFocusTheme();   // '' = All; otherwise show only this focus

    // --- Computed day views (Today / Tomorrow) over due_by, across all buckets.
    // Scheduled items that land in a day view are pulled out of the ladder below
    // (so they aren't shown twice). Guarded so any glitch degrades to the ladder.
    let dayHTML = '';
    let pulledIds = new Set();
    try {
        const todayItems = dayViewItems('Today').filter(it => _focusMatch(it, theme));
        const tomorrowItems = dayViewItems('Tomorrow').filter(it => _focusMatch(it, theme));
        pulledIds = new Set([...todayItems, ...tomorrowItems].map(it => it.id).filter(Boolean));
        // Today wears the current part of day (same palette as the habit cards).
        const todColor = { morning: 'var(--morning)', afternoon: 'var(--ongoing)', evening: 'var(--evening)' }[getTime()] || 'var(--accent)';
        dayHTML += dayViewHTML('Today', todayItems, todColor, false);
        dayHTML += dayViewHTML('Tomorrow', tomorrowItems, 'var(--ongoing)');
    } catch (e) {
        console.error('day view render failed, falling back to ladder', e);
        dayHTML = '';
        pulledIds = new Set();
    }

    // Focus chip strip sits above everything; tapping a chip re-renders in place.
    let html = focusBarHTML(theme) + dayHTML;
    const snoozed = [];
    let shownCount = pulledIds.size;   // day-view items already count as shown
    // The priority ladder below now holds floating + far-dated items; near-term
    // scheduled items live in the day views above.
    D.todos.forEach((section, i) => {
        const name = section.name.toLowerCase().replace(/\s*—.*/, '').trim();
        if (hide.some(h => name.startsWith(h))) return;
        const visible = [];
        (section.items || []).forEach(it => {
            if (!_focusMatch(it, theme)) return;
            if (isSnoozed(it)) { snoozed.push(it); return; }
            if (it && typeof it === 'object' && it.id && pulledIds.has(it.id)) return;
            visible.push(it);
        });
        shownCount += visible.length;
        // When focused, hide buckets empty in this theme (no empty cards). With
        // no focus, keep the full ladder visible as before.
        if (theme && !visible.length) return;
        html += cardHTML(section.name, visible, colors[Math.min(i, 2)], 'todo', section.name, false, section.manual_order);
    });

    if (theme && shownCount === 0) {
        html += `<div class="empty-state" style="padding:24px 12px">Nothing in ${esc(_themeLabel(theme))} right now. 🎉</div>`;
    }

    if (snoozed.length) html += snoozedCardHTML(snoozed);

    el.innerHTML = html;

    // Keep the per-bucket edit modal in sync if it's open.
    const pm = document.getElementById('panel-modal');
    if (window._editBucket && pm && pm.classList.contains('open')) renderBucketEditModal();
}

// One day's plan: items sorted time-first, then grouped by place into "stops"
// (errands at the same place batched), with rough duration totals. Returns ''
// when the day is empty so the card only appears when there's something in it.
function dayViewHTML(label, items, color, alwaysShow) {
    // Tomorrow only appears once it has something; Today always shows so its
    // "+ Add" is reachable even on an empty day (otherwise: nothing to add into).
    if (!items.length && !alwaysShow) return '';
    const sorted = items.slice().sort((a, b) => {
        // Checked-off items sink to the bottom; the rest sort by time.
        if (!!a.done !== !!b.done) return a.done ? 1 : -1;
        const at = a.due_time || '99:99', bt = b.due_time || '99:99';
        return at < bt ? -1 : (at > bt ? 1 : 0);
    });
    const groups = [];
    const byPlace = {};
    sorted.forEach(it => {
        const key = it.place_id || '__none__';
        if (!byPlace[key]) { byPlace[key] = { key, items: [] }; groups.push(byPlace[key]); }
        byPlace[key].items.push(it);
    });
    // Stops with a known place float above the "No location" group.
    groups.sort((a, b) => (a.key === '__none__' ? 1 : 0) - (b.key === '__none__' ? 1 : 0));
    const totalMin = items.reduce((s, it) => s + (parseInt(it.duration_min, 10) || 0), 0);
    const totalBadge = totalMin ? `<span class="todo-day-total">~${esc(_fmtDuration(totalMin))}</span>` : '';
    let open = true;  // day views default open
    try { const v = localStorage.getItem('todoOpenV2:' + label); if (v !== null) open = v === '1'; } catch (e) {}
    const stopsHTML = items.length
        ? groups.map(g => stopHTML(g)).join('')
        : '<div class="empty-state">Nothing scheduled yet</div>';
    return `<details class="card todo-card todo-day" style="border-left-color:${color}" id="card-todo-${esc(label)}" ${open ? 'open' : ''} ontoggle="todoCardToggled(this,'${escJs(label)}')">
        <summary class="card-title" style="color:${color};cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">
            <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
            <span style="flex:1">${esc(label)}<span class="todo-day-count">${items.filter(it => !it.done).length}</span></span>
            ${totalBadge}
            <span class="edit-toggle" onclick="event.preventDefault();event.stopPropagation();openBucketEdit('${escJs(label)}')">edit</span>
        </summary>
        ${stopsHTML}
        <div class="add-trigger" onclick="addToDay('${escJs(label)}')">+ Add</div>
    </details>`;
}

function stopHTML(group) {
    const pl = group.key === '__none__' ? null : placeById(group.key);
    const stopMin = group.items.reduce((s, it) => s + (parseInt(it.duration_min, 10) || 0), 0);
    const stopTotal = stopMin ? `<span class="todo-stop-total">~${esc(_fmtDuration(stopMin))}</span>` : '';
    const head = pl
        ? `<div class="todo-stop-head"><span class="todo-stop-name">📍 ${esc(pl.name)}</span>${pl.address ? `<span class="todo-stop-addr">${esc(pl.address)}</span>` : ''}${stopTotal}</div>`
        : `<div class="todo-stop-head todo-stop-none"><span class="todo-stop-name">No location</span>${stopTotal}</div>`;
    return `<div class="todo-stop">${head}${group.items.map(dayItemHTML).join('')}</div>`;
}

function dayItemHTML(it) {
    const id = it.id || it.text;
    const done = it.done;
    const overdue = it.due_by && _isOverdue(it.due_by) && !done;
    const chips = [];
    if (it.due_time) chips.push(`<span class="todo-chip chip-time${overdue ? ' overdue' : ''}">🕑 ${esc(_fmtTime(it.due_time))}</span>`);
    if (it.duration_min) chips.push(`<span class="todo-chip chip-dur">⏱ ${esc(_fmtDuration(it.duration_min))}</span>`);
    if (it.status) chips.push(`<span class="todo-chip chip-status status-${esc(it.status)}">${esc(_statusLabel(it.status))}</span>`);
    if (it.category) chips.push(`<span class="todo-chip chip-cat">${esc(_catLabel(it.category))}</span>`);
    return `<div class="card-item todo-day-item" data-id="${esc(id)}" data-habit="${esc(it.text)}" data-due="${esc(it.due_by || '')}">
        <span class="habit-check ${done ? 'done' : ''}" onclick="toggleTodo('${escJs(id)}')" style="cursor:pointer" title="Check off">${done ? '&#10003;' : '&#9675;'}</span>
        <span class="item-text" onclick="openTodoDetail(this, event)" style="cursor:pointer;${done ? 'text-decoration:line-through;opacity:0.5' : ''}">${esc(it.text)}${chips.length ? `<span class="todo-chips-inline">${chips.join('')}</span>` : ''}</span>
    </div>`;
}

function snoozedCardHTML(items) {
    const wasOpen = document.querySelector('details#todo-snoozed')?.open;
    const rows = items
        .sort((a, b) => (a.snoozed_until || '').localeCompare(b.snoozed_until || ''))
        .map(it => {
            const back = _fmtAddedDate(it.snoozed_until);
            return `<div class="card-item">
                <span class="item-text" style="flex:1">${esc(it.text)}<span style="font-size:12px;color:var(--text-muted);margin-left:8px">💤 back ${esc(back)}</span></span>
                <button class="delete-btn" onclick="snoozeTodo('${escJs(it.id || it.text)}',0)" title="Un-snooze now" style="font-size:12px">↩</button>
            </div>`;
        }).join('');
    return `<details id="todo-snoozed" class="card todo-card" ${wasOpen ? 'open' : ''} style="border-left-color:var(--text-muted)" ontoggle="todoCardToggled(this,'__snoozed__')">
        <summary class="card-title" style="color:var(--text-muted);cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">
            <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
            <span style="flex:1">Snoozed<span style="font-size:12px;font-weight:600;color:var(--text-muted);background:var(--bg);border-radius:10px;padding:1px 8px;margin-left:8px">${items.length}</span></span>
        </summary>
        ${rows}
    </details>`;
}

// --- Tab to-dos strip ---
// To-dos category-tagged for a page (the detail modal's Category field) show
// in a strip at the top of that page. Data: D.tab_todos, served per-tab.
function renderTabTodos() {
    const el = document.getElementById(`tab-todos-${currentTab}`);
    if (!el) return;
    const items = D.tab_todos || [];
    if (!items.length) { el.innerHTML = ''; return; }
    const rows = items.map(it => `<div class="card-item">
        <span class="habit-check" onclick="toggleTabTodo('${escJs(it.id || it.text)}')" style="cursor:pointer" title="Check off">&#9675;</span>
        <span class="item-text">${esc(it.text)}${it.due_by ? `<span class="todo-due${_isOverdue(it.due_by) ? ' overdue' : ''}" title="Due ${esc(it.due_by)}">${_isOverdue(it.due_by) ? 'overdue · ' : 'due '}${esc(_fmtAddedDate(it.due_by))}</span>` : ''}</span>
    </div>`).join('');
    el.innerHTML = `<div class="card" style="border-left-color:var(--accent);margin-bottom:14px">
        <div class="card-title" style="color:var(--accent)">To-dos for this page</div>
        ${rows}
    </div>`;
}

async function toggleTabTodo(id) {
    await fetch('/api/todos/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    loadDashboard();
}

// --- Applications ---
// APP_STATUSES and APP_STATUS_CLASS are in core.js

function renderApplications() {
    const el = document.getElementById('applications-area');
    const apps = D.applications || [];
    if (!apps.length && !expandedAll) { el.innerHTML = ''; return; }

    // Sort: active first (applied/interviewing), then rejected/withdrawn
    const active = apps.filter(a => !a.status.match(/reject|withdrawn/i));
    const inactive = apps.filter(a => a.status.match(/reject|withdrawn/i));

    let rows = active.map(a => `
        <div class="app-row">
            <div class="app-company">${esc(a.company)}<small>${esc(a.title || '')}${a.location ? ' · ' + esc(a.location) : ''}</small></div>
            <button class="app-status ${APP_STATUS_CLASS(a.status)}" onclick="cycleAppStatus('${esc(a.company)}')">${esc(a.status)}</button>
            <div class="app-actions"><button onclick="removeApp('${esc(a.company)}')" title="Remove">&times;</button></div>
        </div>`).join('');

    let inactiveHTML = '';
    if (inactive.length) {
        inactiveHTML = `<details style="margin-top:8px"><summary style="font-size:12px;color:var(--text-muted);cursor:pointer">${inactive.length} closed</summary>` +
            inactive.map(a => `
                <div class="app-row" style="opacity:0.5">
                    <div class="app-company">${esc(a.company)}<small>${esc(a.title || '')}</small></div>
                    <span class="app-status ${APP_STATUS_CLASS(a.status)}">${esc(a.status)}</span>
                    <div class="app-actions"><button onclick="removeApp('${esc(a.company)}')">&times;</button></div>
                </div>`).join('') + '</details>';
    }

    el.innerHTML = `
        <div class="section-title" style="margin-top:24px">Applications</div>
        <div class="card" style="border-left-color: var(--accent, #7c5cbf)">
            ${rows || '<div style="color:var(--text-muted);font-size:14px">No applications yet</div>'}
            ${inactiveHTML}
            <details id="app-add-form" style="margin-top:12px">
                <summary style="font-size:12px;color:var(--text-muted);cursor:pointer">+ Add application</summary>
                <div class="app-add-form" style="margin-top:8px">
                    <input id="app-company" placeholder="Company">
                    <input id="app-title" placeholder="Job title">
                    <input id="app-location" placeholder="Location">
                    <button onclick="addApp()">Add</button>
                </div>
            </details>
        </div>`;
}

async function cycleAppStatus(company) {
    const apps = D.applications || [];
    const app = apps.find(a => a.company === company);
    if (!app) return;
    const idx = APP_STATUSES.indexOf(app.status);
    const next = APP_STATUSES[(idx + 1) % APP_STATUSES.length];
    await fetch('/api/applications/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company, status: next })
    });
    loadDashboard();
}

async function addApp() {
    const company = document.getElementById('app-company').value.trim();
    if (!company) return;
    await fetch('/api/applications/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            company,
            title: document.getElementById('app-title').value.trim(),
            location: document.getElementById('app-location').value.trim(),
        })
    });
    loadDashboard();
}

async function removeApp(company) {
    if (!confirm('Remove ' + company + '?')) return;
    await fetch('/api/applications/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company })
    });
    loadDashboard();
}

// --- Triage ---
// Spawn (or reuse) the `todo` Claude session, then ask the split shell to open
// the terminal pane on it (a "Todo" session tab). You just talk; it reorders
// todos.json live. Falls back to /phone if we're not inside the split shell.
async function openTriage(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '🧭 Opening…'; }
    try {
        await fetch('/api/triage/open', { method: 'POST' });
    } catch (e) { /* still try to open — the session tab is there either way */ }
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'openTerminalSession', name: 'todo' }, location.origin);
    } else {
        window.location.href = '/phone?session=todo';
    }
    if (btn) setTimeout(() => { btn.disabled = false; btn.textContent = '🧭 Triage'; }, 1500);
}
