// todos.js — todo cards, applications

function renderTodos() {
    const el = document.getElementById('todo-cards');
    if (isFrosted(D.todos)) {
        el.innerHTML = frostedCard('To Do', 5);
        return;
    }
    const colors = ['var(--todo-1)', 'var(--todo-2)', 'var(--todo-3)'];
    const showNow = ['today', 'tomorrow', 'this week'];
    const hide = ['done'];
    let html = '';
    let collapsedHTML = '';

    D.todos.forEach((section, i) => {
        const name = section.name.toLowerCase().replace(/\s*—.*/, '').trim();
        if (hide.some(h => name.startsWith(h))) return;
        if (showNow.some(s => name.startsWith(s))) {
            html += cardHTML(section.name, section.items, colors[Math.min(i, 2)], 'todo', section.name);
        } else {
            collapsedHTML += cardHTML(section.name, section.items, colors[Math.min(i, 2)], 'todo', section.name);
        }
    });

    if (collapsedHTML) {
        const wasOpen = el.querySelector('details#todo-later')?.open;
        html += `<details id="todo-later" ${wasOpen ? 'open' : ''} style="margin-top:8px"><summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Later</summary>
            <div style="margin-top:8px">${collapsedHTML}</div></details>`;
    }

    el.innerHTML = html;
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
