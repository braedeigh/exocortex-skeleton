// todos.js — todo cards, applications

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

    // --- Computed day views (Today / Tomorrow) over due_by, across all buckets.
    // Scheduled items that land in a day view are pulled out of the ladder below
    // (so they aren't shown twice). Guarded so any glitch degrades to the ladder.
    let dayHTML = '';
    let pulledIds = new Set();
    try {
        const tomorrow = tomorrowStr();
        const all = [];
        D.todos.forEach(section => {
            const name = section.name.toLowerCase().replace(/\s*—.*/, '').trim();
            if (hide.some(h => name.startsWith(h))) return;
            (section.items || []).forEach(it => { if (it && typeof it === 'object') all.push(it); });
        });
        const todayItems = all.filter(it => !it.done && !isSnoozed(it) && it.due_by && it.due_by <= today);
        const tomorrowItems = all.filter(it => !it.done && !isSnoozed(it) && it.due_by === tomorrow);
        pulledIds = new Set([...todayItems, ...tomorrowItems].map(it => it.id).filter(Boolean));
        dayHTML += dayViewHTML('Today', todayItems, 'var(--accent)');
        dayHTML += dayViewHTML('Tomorrow', tomorrowItems, 'var(--ongoing)');
    } catch (e) {
        console.error('day view render failed, falling back to ladder', e);
        dayHTML = '';
        pulledIds = new Set();
    }

    let html = dayHTML;
    const snoozed = [];
    // The priority ladder below now holds floating + far-dated items; near-term
    // scheduled items live in the day views above.
    D.todos.forEach((section, i) => {
        const name = section.name.toLowerCase().replace(/\s*—.*/, '').trim();
        if (hide.some(h => name.startsWith(h))) return;
        const visible = [];
        (section.items || []).forEach(it => {
            if (isSnoozed(it)) { snoozed.push(it); return; }
            if (it && typeof it === 'object' && it.id && pulledIds.has(it.id)) return;
            visible.push(it);
        });
        html += cardHTML(section.name, visible, colors[Math.min(i, 2)], 'todo', section.name, false, section.manual_order);
    });

    if (snoozed.length) html += snoozedCardHTML(snoozed);

    el.innerHTML = html;

    // Keep the per-bucket edit modal in sync if it's open.
    const pm = document.getElementById('panel-modal');
    if (window._editBucket && pm && pm.classList.contains('open')) renderBucketEditModal();
}

// One day's plan: items sorted time-first, then grouped by place into "stops"
// (errands at the same place batched), with rough duration totals. Returns ''
// when the day is empty so the card only appears when there's something in it.
function dayViewHTML(label, items, color) {
    if (!items.length) return '';
    const sorted = items.slice().sort((a, b) => {
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
    const stopsHTML = groups.map(g => stopHTML(g)).join('');
    return `<details class="card todo-card todo-day" style="border-left-color:${color}" id="card-todo-${esc(label)}" ${open ? 'open' : ''} ontoggle="todoCardToggled(this,'${escJs(label)}')">
        <summary class="card-title" style="color:${color};cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">
            <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
            <span style="flex:1">${esc(label)}<span class="todo-day-count">${items.length}</span></span>
            ${totalBadge}
        </summary>
        ${stopsHTML}
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
