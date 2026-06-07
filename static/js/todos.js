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
    let html = '';
    const snoozed = [];

    // Each bucket (Now / Up Next / Later / Someday) is its own collapsible card.
    // Snoozed (not-yet-due) items are pulled out into their own section below.
    D.todos.forEach((section, i) => {
        const name = section.name.toLowerCase().replace(/\s*—.*/, '').trim();
        if (hide.some(h => name.startsWith(h))) return;
        const visible = [];
        (section.items || []).forEach(it => {
            const su = (it && typeof it === 'object') ? it.snoozed_until : null;
            if (su && su > today && !it.done) snoozed.push(it);
            else visible.push(it);
        });
        html += cardHTML(section.name, visible, colors[Math.min(i, 2)], 'todo', section.name);
    });

    if (snoozed.length) html += snoozedCardHTML(snoozed);

    el.innerHTML = html;
}

function snoozedCardHTML(items) {
    const wasOpen = document.querySelector('details#todo-snoozed')?.open;
    const rows = items
        .sort((a, b) => (a.snoozed_until || '').localeCompare(b.snoozed_until || ''))
        .map(it => {
            const back = _fmtAddedDate(it.snoozed_until);
            return `<div class="card-item">
                <span class="item-text" style="flex:1">${esc(it.text)}<span style="font-size:12px;color:var(--text-muted);margin-left:8px">💤 back ${esc(back)}</span></span>
                <button class="delete-btn" onclick="snoozeTodo('${escJs(it.text)}',0)" title="Un-snooze now" style="font-size:12px">↩</button>
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
