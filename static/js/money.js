// money.js — budget, expense log, subscriptions, CSV import

// CSV import state lives at module scope so user edits persist across renders
let _csvFiles = null;
let _csvSelected = null;
let _csvRows = null;
let _csvKnownCategories = [];

function _budget() { return D.budget || { income_monthly: 0, categories: [] }; }
function _expenses() { return D.expenses || []; }
function _subs() { return D.subscriptions || []; }

// Money figure for display. Public visitors see a masked placeholder ($•••) in place
// of every dollar amount; the underlying values still power the bars/percentages.
// Works in both HTML body and title="" tooltips (plain text, no markup).
function _m(n) {
    if (window.VIEW_MODE && window.VIEW_MODE !== 'authed') return '$•••';
    return '$' + (Number(n) || 0).toFixed(2);
}

function _categoryOptions(selected = '') {
    const cats = _budget().categories || [];
    const opts = ['<option value="">— pick category —</option>'];
    cats.forEach(c => {
        const sel = c.name === selected ? ' selected' : '';
        opts.push(`<option value="${esc(c.name)}"${sel}>${esc(c.name)}</option>`);
    });
    return opts.join('');
}

function _thisMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function _expensesThisMonth() {
    const key = _thisMonthKey();
    return _expenses().filter(e => (e.date || '').startsWith(key));
}

function _spentByCategory() {
    const tally = {};
    _expensesThisMonth().forEach(e => {
        const c = e.category || 'Uncategorized';
        tally[c] = (tally[c] || 0) + (e.amount || 0);
    });
    return tally;
}

// --- Quick Expense ---

function renderQuickExpense() {
    const el = document.getElementById('quick-expense-area');
    if (!el) return;
    const bankUrl = (_budget().bank_csv_url || '').trim();
    const bankChip = bankUrl
        ? `<a href="${esc(bankUrl)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:4px 12px;background:rgba(26,188,156,0.10);border:1px solid rgba(26,188,156,0.25);border-radius:14px;font-size:12px;font-weight:600;color:var(--ongoing);text-decoration:none">↗ Download CSV from bank</a>`
        : '';
    el.innerHTML = `<div class="card" style="border-left-color:var(--ongoing);margin-bottom:16px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Log expense</div>
            ${bankChip}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <input type="number" step="0.01" id="exp-amount" placeholder="$" style="width:100px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)" onkeydown="if(event.key==='Enter')addExpense()">
            <select id="exp-category" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--bg);min-width:140px">${_categoryOptions()}</select>
            <input type="text" id="exp-comments" placeholder="comment (optional)" style="flex:1;min-width:160px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)" onkeydown="if(event.key==='Enter')addExpense()">
            <input type="date" id="exp-date" value="${todayStr()}" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg)">
            <button onclick="addExpense()" style="padding:7px 18px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Log</button>
        </div>
    </div>`;
}

async function addExpense() {
    const amount = document.getElementById('exp-amount').value;
    if (!amount) { document.getElementById('exp-amount').focus(); return; }
    const category = document.getElementById('exp-category').value;
    const comments = document.getElementById('exp-comments').value.trim();
    const date = document.getElementById('exp-date').value || todayStr();
    const res = await fetch('/api/expense/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, category, comments, date })
    });
    if (res.ok) {
        document.getElementById('exp-amount').value = '';
        document.getElementById('exp-comments').value = '';
        loadDashboard();
    } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to log');
    }
}

// --- This Month summary ---

function renderThisMonth() {
    const el = document.getElementById('this-month-area');
    if (!el) return;
    const cats = (_budget().categories || []).filter(c => c.type !== 'savings');
    if (!cats.length) { el.innerHTML = ''; return; }

    const spent = _spentByCategory();
    const monthName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    let totalSpent = 0, totalPlanned = 0;
    const rows = cats.map(c => {
        const s = spent[c.name] || 0;
        const p = c.planned || 0;
        totalSpent += s;
        totalPlanned += p;
        const pct = p > 0 ? Math.min(100, (s / p) * 100) : 0;
        const over = p > 0 && s > p;
        const barColor = over ? 'var(--red)' : (pct > 80 ? 'var(--yellow)' : 'var(--green)');
        return `<div style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
                <span><b>${esc(c.name)}</b></span>
                <span style="color:${over ? 'var(--red)' : 'var(--text-muted)'}">${_m(s)}${p > 0 ? ` / ${_m(p)}` : ''}</span>
            </div>
            <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
                <div style="height:100%;background:${barColor};width:${pct}%"></div>
            </div>
        </div>`;
    }).join('');

    el.innerHTML = `<details open class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">${esc(monthName)} &mdash; ${_m(totalSpent)} of ${_m(totalPlanned)}</summary>
        <div class="card" style="border-left-color:var(--ongoing);margin-top:8px;padding:14px">
            ${rows}
        </div>
    </details>`;
}

// --- Recent expenses ---

function renderRecentExpenses() {
    const el = document.getElementById('recent-expenses-area');
    if (!el) return;
    const items = [..._expenses()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!items.length) { el.innerHTML = ''; return; }
    const recent = items.slice(0, 30);

    const rows = recent.map(e => `<tr style="border-top:1px solid var(--border)">
        <td style="padding:6px 10px;white-space:nowrap;font-size:13px;color:var(--text-muted)">${esc(e.date || '')}</td>
        <td style="padding:6px 10px;white-space:nowrap"><b>${_m(e.amount)}</b></td>
        <td style="padding:6px 10px;font-size:13px">${esc(e.category || '')}</td>
        <td style="padding:6px 10px;font-size:13px;color:var(--text-muted)">${esc(e.comments || '')}</td>
        <td style="padding:6px 10px;text-align:right">
            <button onclick="removeExpense('${esc(e.id)}')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;padding:0 4px">&times;</button>
        </td>
    </tr>`).join('');

    el.innerHTML = `<details class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Recent expenses (${items.length} total)</summary>
        <div class="card" style="border-left-color:var(--text-muted);margin-top:8px;padding:8px">
            <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${rows}</tbody></table></div>
        </div>
    </details>`;
}

async function removeExpense(id) {
    if (!confirm('Remove this expense?')) return;
    await fetch('/api/expense/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    loadDashboard();
}

// --- Subscriptions ---

function _daysUntil(dateStr) {
    if (!dateStr) return null;
    const target = new Date(dateStr + 'T12:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function renderSubscriptions() {
    const el = document.getElementById('subscriptions-area');
    if (!el) return;
    const items = [..._subs()].sort((a, b) => {
        const da = _daysUntil(a.next_renewal);
        const db = _daysUntil(b.next_renewal);
        if (da === null && db === null) return 0;
        if (da === null) return 1;
        if (db === null) return -1;
        return da - db;
    });

    let monthlyTotal = 0;
    items.forEach(s => {
        const amt = s.amount || 0;
        monthlyTotal += s.frequency === 'yearly' ? amt / 12 : amt;
    });

    const rows = items.map(s => {
        const days = _daysUntil(s.next_renewal);
        let renewCell;
        if (days === null) {
            renewCell = '<span style="color:var(--text-muted)">—</span>';
        } else if (days <= 7) {
            renewCell = `<span style="color:var(--red);font-weight:600">${esc(s.next_renewal)} (${days}d)</span>`;
        } else if (days <= 30) {
            renewCell = `<span style="color:var(--yellow)">${esc(s.next_renewal)} (${days}d)</span>`;
        } else {
            renewCell = `<span style="color:var(--text-muted)">${esc(s.next_renewal)}</span>`;
        }
        const cancelLink = s.cancel_url
            ? `<a href="${esc(s.cancel_url)}" target="_blank" rel="noopener" title="Cancel page" style="color:var(--ongoing);text-decoration:none;margin-right:6px;font-size:13px">↗</a>`
            : '';
        const freq = s.frequency === 'yearly' ? '/yr' : '/mo';
        return `<tr style="border-top:1px solid var(--border)">
            <td style="padding:8px 10px"><b>${esc(s.name)}</b>${cancelLink ? ' ' + cancelLink : ''}</td>
            <td style="padding:8px 10px;white-space:nowrap;font-size:13px">${_m(s.amount)}${freq}</td>
            <td style="padding:8px 10px;white-space:nowrap;font-size:13px">${renewCell}</td>
            <td style="padding:8px 10px;font-size:13px;color:var(--text-muted)">${esc(s.notes || '')}</td>
            <td style="padding:8px 10px;text-align:right">
                <button onclick="removeSubscription('${escJs(s.name)}')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;padding:0 4px">&times;</button>
            </td>
        </tr>`;
    }).join('');

    el.innerHTML = `<details open class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Subscriptions (${items.length}) &mdash; ${_m(monthlyTotal)}/mo equiv</summary>
        <div class="card" style="border-left-color:var(--red);margin-top:8px;padding:10px">
            ${items.length ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px">
                <thead><tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px">
                    <th style="padding:6px 10px;font-weight:600">Name</th>
                    <th style="padding:6px 10px;font-weight:600">Cost</th>
                    <th style="padding:6px 10px;font-weight:600">Next renewal</th>
                    <th style="padding:6px 10px;font-weight:600">Notes</th>
                    <th></th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table></div>` : '<div style="font-size:14px;color:var(--text-muted);padding:6px 0">No subscriptions tracked yet.</div>'}
            <div style="margin-top:10px">
                <button onclick="autoDetectSubscriptions()" style="padding:6px 14px;border:1px solid var(--ongoing);background:none;color:var(--ongoing);border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">Auto-detect from expenses</button>
                <span style="font-size:11px;color:var(--text-muted);margin-left:6px">Scans expenses categorized as "Subscriptions" — recurring charges (2+ months) get added.</span>
            </div>
            <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
                <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
                    <input type="text" id="sub-name" placeholder="Subscription name" style="flex:1;min-width:140px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)">
                    <input type="number" step="0.01" id="sub-amount" placeholder="$ amount" style="width:110px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)">
                    <select id="sub-frequency" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg)">
                        <option value="monthly">monthly</option>
                        <option value="yearly">yearly</option>
                    </select>
                    <input type="date" id="sub-next" placeholder="Next renewal" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg)">
                    <input type="url" id="sub-cancel-url" placeholder="cancel URL (optional)" style="flex:1;min-width:160px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none;background:var(--bg)">
                    <button onclick="addSubscription()" style="padding:7px 18px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Add</button>
                </div>
            </div>
        </div>
    </details>`;
}

async function addSubscription() {
    const name = document.getElementById('sub-name').value.trim();
    if (!name) { document.getElementById('sub-name').focus(); return; }
    const amount = document.getElementById('sub-amount').value || 0;
    const frequency = document.getElementById('sub-frequency').value;
    const next_renewal = document.getElementById('sub-next').value;
    const cancel_url = document.getElementById('sub-cancel-url').value.trim();
    const res = await fetch('/api/subscription/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, amount, frequency, next_renewal, cancel_url })
    });
    if (res.ok) {
        ['sub-name','sub-amount','sub-next','sub-cancel-url'].forEach(id => document.getElementById(id).value = '');
        loadDashboard();
    } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to add');
    }
}

async function removeSubscription(name) {
    if (!confirm(`Remove subscription "${name}"?`)) return;
    await fetch('/api/subscription/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    loadDashboard();
}

async function autoDetectSubscriptions() {
    const res = await fetch('/api/subscription/auto-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    if (!res.ok) { alert('Detection failed'); return; }
    const data = await res.json();
    alert(`Added ${data.added} subscription(s). Skipped ${data.skipped} (not recurring across months, or already tracked).`);
    loadDashboard();
}

// --- Budget config (income + categories) ---

function renderBudgetConfig() {
    const el = document.getElementById('budget-config-area');
    if (!el) return;
    const b = _budget();
    const cats = b.categories || [];

    const catRows = cats.map(c => `<tr style="border-top:1px solid var(--border)">
        <td style="padding:6px 10px"><b>${esc(c.name)}</b></td>
        <td style="padding:6px 10px;font-size:13px;color:var(--text-muted)">${esc(c.type || 'variable')}</td>
        <td style="padding:6px 10px;white-space:nowrap">$${(c.planned || 0).toFixed(2)}</td>
        <td style="padding:6px 10px;text-align:right">
            <button onclick="removeCategory('${escJs(c.name)}')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;padding:0 4px">&times;</button>
        </td>
    </tr>`).join('');

    const totalPlanned = cats.reduce((s, c) => s + (c.planned || 0), 0);

    el.innerHTML = `<details class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Budget setup &mdash; income $${(b.income_monthly || 0).toFixed(2)}/mo, allocated $${totalPlanned.toFixed(2)}</summary>
        <div class="card" style="border-left-color:var(--text-muted);margin-top:8px;padding:12px">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
                <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Income/mo</label>
                <input type="number" step="0.01" id="bud-income" value="${b.income_monthly || 0}" style="width:140px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)">
                <button onclick="saveIncome()" style="padding:6px 14px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Save</button>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
                <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">Bank CSV URL</label>
                <input type="url" id="bud-bank-url" value="${esc(b.bank_csv_url || '')}" placeholder="paste your BoA download deep-link" style="flex:1;min-width:240px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none;background:var(--bg)">
                <button onclick="saveBankUrl()" style="padding:6px 14px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Save</button>
            </div>
            ${cats.length ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px">
                <thead><tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px">
                    <th style="padding:6px 10px;font-weight:600">Category</th>
                    <th style="padding:6px 10px;font-weight:600">Type</th>
                    <th style="padding:6px 10px;font-weight:600">Planned/mo</th>
                    <th></th>
                </tr></thead>
                <tbody>${catRows}</tbody>
            </table></div>` : '<div style="font-size:13px;color:var(--text-muted);padding:6px 0">No categories yet — add some below.</div>'}
            <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
                <input type="text" id="cat-name" placeholder="Category name (e.g. Groceries)" style="flex:1;min-width:140px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)">
                <input type="number" step="0.01" id="cat-planned" placeholder="Planned/mo" style="width:120px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)">
                <select id="cat-type" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg)">
                    <option value="variable">variable</option>
                    <option value="fixed">fixed</option>
                    <option value="savings">savings</option>
                </select>
                <button onclick="addCategory()" style="padding:7px 18px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Add</button>
            </div>
        </div>
    </details>`;
}

async function saveIncome() {
    const income = document.getElementById('bud-income').value;
    await fetch('/api/budget/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ income_monthly: income })
    });
    loadDashboard();
}

async function saveBankUrl() {
    const bank_csv_url = document.getElementById('bud-bank-url').value.trim();
    await fetch('/api/budget/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_csv_url })
    });
    loadDashboard();
}

async function addCategory() {
    const name = document.getElementById('cat-name').value.trim();
    if (!name) { document.getElementById('cat-name').focus(); return; }
    const planned = document.getElementById('cat-planned').value || 0;
    const type = document.getElementById('cat-type').value;
    const res = await fetch('/api/budget/category/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, planned, type })
    });
    if (res.ok) {
        ['cat-name','cat-planned'].forEach(id => document.getElementById(id).value = '');
        loadDashboard();
    } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to add');
    }
}

async function removeCategory(name) {
    if (!confirm(`Remove category "${name}"?`)) return;
    await fetch('/api/budget/category/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    loadDashboard();
}

// --- CSV Import ---

async function renderCsvImport() {
    const el = document.getElementById('csv-import-area');
    if (!el) return;

    // Lazy-load file list once per session
    if (_csvFiles === null) {
        try {
            const res = await fetch('/api/csv/list');
            const data = await res.json();
            _csvFiles = data.files || [];
        } catch (e) {
            _csvFiles = [];
        }
    }

    let body;
    if (_csvRows) {
        body = _renderCsvPreview();
    } else if (_csvFiles.length === 0) {
        body = `<div style="font-size:13px;color:var(--text-muted);padding:6px 0">
            No CSVs in <code>data/bank_csvs/</code>. Drop a Bank of America CSV export there to import.
        </div>`;
    } else {
        const fileButtons = _csvFiles.map(f =>
            `<button onclick="loadCsvForImport('${escJs(f)}')" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer;margin-right:6px;margin-bottom:4px">${esc(f)}</button>`
        ).join('');
        body = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Pick a CSV to parse:</div>${fileButtons}`;
    }

    el.innerHTML = `<details ${_csvRows ? 'open' : ''} class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Import from CSV</summary>
        <div class="card" style="border-left-color:var(--ongoing);margin-top:8px;padding:12px">
            ${body}
        </div>
    </details>`;
}

async function loadCsvForImport(filename) {
    _csvSelected = filename;
    const res = await fetch('/api/csv/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
    });
    if (!res.ok) {
        alert('Parse failed');
        return;
    }
    const data = await res.json();
    _csvRows = data.rows || [];
    _csvKnownCategories = data.categories || [];
    renderCsvImport();
}

function _csvCategoryDropdown(rowIdx, currentCategory) {
    const cats = _csvKnownCategories;
    const opts = ['<option value="">— Uncategorized —</option>'];
    cats.forEach(c => {
        const sel = c === currentCategory ? ' selected' : '';
        opts.push(`<option value="${esc(c)}"${sel}>${esc(c)}</option>`);
    });
    // Allow free-text new category via prompt button
    return `<select onchange="updateCsvCategory(${rowIdx}, this.value)" style="padding:3px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--bg);max-width:160px">${opts.join('')}</select>
        <button onclick="newCsvCategory(${rowIdx})" title="New category" style="background:none;border:none;color:var(--ongoing);cursor:pointer;font-size:14px;padding:0 4px">+</button>`;
}

function updateCsvCategory(rowIdx, value) {
    if (_csvRows && _csvRows[rowIdx]) {
        _csvRows[rowIdx].category = value;
    }
}

function newCsvCategory(rowIdx) {
    const name = prompt('New category name:', '');
    if (!name) return;
    const trimmed = name.trim();
    if (!_csvKnownCategories.includes(trimmed)) {
        _csvKnownCategories.push(trimmed);
        _csvKnownCategories.sort();
    }
    if (_csvRows && _csvRows[rowIdx]) {
        _csvRows[rowIdx].category = trimmed;
    }
    renderCsvImport();
}

function toggleCsvInclude(rowIdx, checked) {
    if (_csvRows && _csvRows[rowIdx]) {
        _csvRows[rowIdx].include = checked;
    }
}

function _renderCsvPreview() {
    const rows = _csvRows;
    const includedCount = rows.filter(r => r.include).length;
    const includedTotal = rows.filter(r => r.include).reduce((sum, r) => sum + Math.abs(r.amount), 0);
    const uncategorizedIncluded = rows.filter(r => r.include && (!r.category || r.category === 'Uncategorized')).length;

    const tableRows = rows.map((r, idx) => {
        const isExpense = r.amount < 0;
        const isUncategorized = !r.category || r.category === 'Uncategorized';
        const highlightBg = (r.include && isUncategorized) ? 'background:rgba(231,76,60,0.10);' : '';
        const dimmed = !r.include ? 'opacity:0.4;' : '';
        const dupTag = r.already_imported ? '<span style="font-size:10px;color:var(--text-muted);background:var(--border);padding:1px 6px;border-radius:4px;margin-left:4px">already imported</span>' : '';
        const amtColor = isExpense ? 'var(--text)' : 'var(--green)';
        return `<tr style="border-top:1px solid var(--border);${highlightBg}${dimmed}">
            <td style="padding:5px 8px"><input type="checkbox" ${r.include ? 'checked' : ''} onchange="toggleCsvInclude(${idx}, this.checked)"></td>
            <td style="padding:5px 8px;font-size:12px;color:var(--text-muted);white-space:nowrap">${esc(r.date)}</td>
            <td style="padding:5px 8px;font-size:12px">${esc(r.desc.length > 60 ? r.desc.substring(0, 60) + '…' : r.desc)}${dupTag}</td>
            <td style="padding:5px 8px;font-size:13px;white-space:nowrap;color:${amtColor}">${isExpense ? '' : '+'}$${Math.abs(r.amount).toFixed(2)}</td>
            <td style="padding:5px 8px">${_csvCategoryDropdown(idx, r.category)}</td>
        </tr>`;
    }).join('');

    return `
        <div style="margin-bottom:10px;font-size:13px;color:var(--text-muted)">
            <b style="color:var(--text)">${esc(_csvSelected)}</b> &mdash; ${rows.length} rows, ${includedCount} selected ($${includedTotal.toFixed(2)})
            ${uncategorizedIncluded > 0 ? `<span style="color:var(--red);margin-left:8px">⚠ ${uncategorizedIncluded} uncategorized in selection</span>` : ''}
        </div>
        <div style="overflow-x:auto;max-height:600px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
            <table style="width:100%;border-collapse:collapse;font-size:14px">
                <thead style="position:sticky;top:0;background:var(--card-bg);z-index:1">
                    <tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px">
                        <th style="padding:6px 8px;font-weight:600">Inc.</th>
                        <th style="padding:6px 8px;font-weight:600">Date</th>
                        <th style="padding:6px 8px;font-weight:600">Description</th>
                        <th style="padding:6px 8px;font-weight:600">Amount</th>
                        <th style="padding:6px 8px;font-weight:600">Category</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap">
            <label style="font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:4px">
                <input type="checkbox" id="csv-learn-rules" checked> Save category assignments as new rules (so future imports auto-categorize)
            </label>
            <button onclick="cancelCsvImport()" style="padding:8px 16px;border:1px solid var(--border);border-radius:6px;background:none;font-size:13px;cursor:pointer;color:var(--text-muted)">Cancel</button>
            <button onclick="confirmCsvImport()" style="padding:8px 18px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Import ${includedCount} expenses</button>
        </div>
    `;
}

function cancelCsvImport() {
    _csvRows = null;
    _csvSelected = null;
    renderCsvImport();
}

async function confirmCsvImport() {
    const learnRulesChecked = document.getElementById('csv-learn-rules')?.checked;
    const selections = _csvRows.filter(r => r.include).map(r => ({
        date: r.date,
        desc: r.desc,
        amount: r.amount,
        category: r.category || 'Uncategorized',
    }));
    // Determine new rules to learn: each unique merchant key => category
    let learn_rules = [];
    if (learnRulesChecked) {
        // For each included row, derive a stable "merchant key" from the description
        // Simple heuristic: take the first ~3 words, lowercased, alphanumeric only
        const seen = new Set();
        for (const r of _csvRows) {
            if (!r.include || !r.category || r.category === 'Uncategorized') continue;
            const key = _merchantKey(r.desc);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            learn_rules.push({ match: key, category: r.category });
        }
    }
    const res = await fetch('/api/csv/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections, learn_rules })
    });
    if (!res.ok) {
        alert('Import failed');
        return;
    }
    const data = await res.json();
    alert(`Imported ${data.added} expenses. Learned ${data.rules_learned} new merchant rules. Added ${data.categories_added} new budget categories.`);
    _csvRows = null;
    _csvSelected = null;
    _csvFiles = null;  // Force reload of file list
    loadDashboard();
}

function _merchantKey(desc) {
    // Take first 1-3 words, lowercased, strip punctuation
    if (!desc) return '';
    const words = desc.toLowerCase().replace(/[^a-z0-9 *-]/g, ' ').split(/\s+/).filter(Boolean);
    // Use first 2 words as the key (e.g. "h-e-b #476" -> "h-e-b" or "shell service" -> "shell service")
    return words.slice(0, 2).join(' ');
}

// --- Spending Breakdown (bar chart, per-month) ---

const _BREAKDOWN_PALETTE = [
    '#1abc9c', '#3498db', '#9b59b6', '#e67e22', '#e74c3c',
    '#f1c40f', '#2ecc71', '#34495e', '#16a085', '#d35400',
    '#8e44ad', '#27ae60', '#c0392b', '#7f8c8d',
];

function _breakdownColorFor(cat) {
    let h = 0;
    for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
    return _BREAKDOWN_PALETTE[h % _BREAKDOWN_PALETTE.length];
}

let _breakdownDrill = null; // {monthKey, category} or null

function toggleBreakdownDrill(monthKey, category) {
    if (_breakdownDrill && _breakdownDrill.monthKey === monthKey && _breakdownDrill.category === category) {
        _breakdownDrill = null;
    } else {
        _breakdownDrill = { monthKey, category };
    }
    renderSpendingBreakdown();
}

function _allKnownCategories() {
    const fromBudget = (_budget().categories || []).map(c => c.name);
    const fromExpenses = (_expenses() || []).map(e => e.category).filter(Boolean);
    return [...new Set([...fromBudget, ...fromExpenses])].sort();
}

function _renderCategoryDropdown(expenseId, currentCat) {
    const cats = _allKnownCategories();
    const opts = ['<option value="Uncategorized">— Uncategorized —</option>'];
    cats.forEach(c => {
        if (c === 'Uncategorized') return;
        const sel = c === currentCat ? ' selected' : '';
        opts.push(`<option value="${esc(c)}"${sel}>${esc(c)}</option>`);
    });
    return `<select onchange="updateExpenseCategory('${escJs(expenseId)}', this.value)" style="padding:2px 4px;border:1px solid var(--border);border-radius:4px;font-size:11px;background:var(--bg);max-width:140px">${opts.join('')}</select>`;
}

function _renderDrillTransactions(items, category) {
    const matching = items
        .filter(e => (e.category || 'Uncategorized') === category)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!matching.length) {
        return `<div style="padding:8px;font-size:12px;color:var(--text-muted)">No transactions.</div>`;
    }
    const receiptsMap = D.receipts_map || {};
    const rows = matching.map(e => {
        const titleVal = e.title || '';
        const titleDisplay = titleVal
            ? `<input type="text" value="${esc(titleVal)}" data-orig="${esc(titleVal)}" onfocus="this.style.borderBottomColor='var(--border)'" onblur="this.style.borderBottomColor='transparent'; if(this.value !== this.dataset.orig) updateExpenseTitle('${escJs(e.id)}', this.value, true)" style="background:transparent;border:none;border-bottom:1px solid transparent;font-size:12px;font-weight:600;color:var(--text);width:160px;padding:1px 2px">`
            : `<input type="text" value="" placeholder="+ title" onfocus="this.style.borderBottomColor='var(--border)';this.style.fontStyle='normal'" onblur="this.style.borderBottomColor='transparent'; if(this.value) updateExpenseTitle('${escJs(e.id)}', this.value, true)" style="background:transparent;border:none;border-bottom:1px solid transparent;font-size:12px;color:var(--text-muted);font-style:italic;width:120px;padding:1px 2px">`;
        const hasReceipt = receiptsMap[e.id];
        const receiptBtn = hasReceipt
            ? `<a href="/receipts/${esc(hasReceipt.filename)}" target="_blank" title="View receipt (${esc(hasReceipt.filename)})" style="color:var(--ongoing);text-decoration:none;cursor:pointer">📷</a>`
            : `<label title="Attach receipt" style="cursor:pointer;color:var(--text-muted);opacity:0.5">📷
                 <input type="file" accept="image/*,.pdf,.heic" style="display:none" onchange="uploadReceipt('${escJs(e.id)}', this.files[0])">
               </label>`;
        return `<tr style="border-top:1px solid var(--border)">
            <td style="padding:4px 8px;font-size:11px;color:var(--text-muted);white-space:nowrap">${esc(e.date || '')}</td>
            <td style="padding:4px 8px;font-size:12px;white-space:nowrap"><b>${_m(e.amount)}</b></td>
            <td style="padding:4px 8px;white-space:nowrap">${titleDisplay}</td>
            <td style="padding:4px 8px;font-size:11px;color:var(--text-muted)">${esc(e.comments || '')}</td>
            <td style="padding:4px 8px;text-align:center">${receiptBtn}</td>
            <td style="padding:4px 8px;text-align:right">${_renderCategoryDropdown(e.id, e.category || 'Uncategorized')}</td>
        </tr>`;
    }).join('');
    return `<div style="margin:4px 0 10px 0;background:rgba(0,0,0,0.03);border-radius:6px;padding:6px">
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>
    </div>`;
}

async function updateExpenseTitle(id, title, learnRule) {
    const res = await fetch('/api/expense/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title, learn_label_rule: !!learnRule })
    });
    if (res.ok) loadDashboard();
}

async function uploadReceipt(eid, file) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/expense/${encodeURIComponent(eid)}/receipt`, {
        method: 'POST',
        body: fd,
    });
    if (res.ok) loadDashboard();
    else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Upload failed');
    }
}

async function updateExpenseCategory(id, category) {
    const res = await fetch('/api/expense/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, category })
    });
    if (res.ok) loadDashboard();
    else alert('Update failed');
}

function _renderMonthBars(items, monthKey) {
    const tally = {};
    items.forEach(e => {
        const c = e.category || 'Uncategorized';
        tally[c] = (tally[c] || 0) + (e.amount || 0);
    });
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, v]) => s + v, 0);
    const max = sorted[0]?.[1] || 1;
    return sorted.map(([cat, amt]) => {
        const pct = (amt / max) * 100;
        const sharePct = total > 0 ? (amt / total) * 100 : 0;
        const color = _breakdownColorFor(cat);
        const isActive = _breakdownDrill && _breakdownDrill.monthKey === monthKey && _breakdownDrill.category === cat;
        const drillBlock = isActive ? _renderDrillTransactions(items, cat) : '';
        const arrow = isActive ? '▾' : '▸';
        return `<div style="margin-bottom:6px">
            <div onclick="toggleBreakdownDrill('${escJs(monthKey)}','${escJs(cat)}')" style="cursor:pointer;padding:2px 0">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">
                    <span><span style="color:var(--text-muted);margin-right:4px">${arrow}</span><b>${esc(cat)}</b> <span style="color:var(--text-muted);font-weight:400">· ${sharePct.toFixed(1)}%</span></span>
                    <span>${_m(amt)}</span>
                </div>
                <div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden">
                    <div style="height:100%;background:${color};width:${pct}%;border-radius:4px"></div>
                </div>
            </div>
            ${drillBlock}
        </div>`;
    }).join('');
}

function _renderIncomeGauge(spendingItems, incomeItems) {
    // Spending categorized excluded from "spent" view: Income, Savings/Transfer, Transfer (in)
    const SKIP = new Set(['income', 'savings/transfer', 'transfer (in)']);
    const spent = spendingItems
        .filter(e => !SKIP.has((e.category || '').toLowerCase()))
        .reduce((s, e) => s + (e.amount || 0), 0);
    const income = incomeItems.reduce((s, e) => s + (e.amount || 0), 0);

    if (income === 0 && spent === 0) return '';

    // Tally spending by category for stacked-bar segments
    const tally = {};
    spendingItems
        .filter(e => !SKIP.has((e.category || '').toLowerCase()))
        .forEach(e => {
            const c = e.category || 'Uncategorized';
            tally[c] = (tally[c] || 0) + (e.amount || 0);
        });
    const sortedCats = Object.entries(tally).sort((a, b) => b[1] - a[1]);

    // Bar denominator = max(income, spent) so overspending shows visually
    const denom = Math.max(income, spent, 1);
    const segments = sortedCats.map(([cat, amt]) => {
        const pct = (amt / denom) * 100;
        const color = _breakdownColorFor(cat);
        return `<div title="${esc(cat)} — ${_m(amt)}" style="height:100%;width:${pct}%;background:${color};display:inline-block"></div>`;
    }).join('');

    const leftover = income - spent;
    const unspentPct = leftover > 0 ? (leftover / denom) * 100 : 0;
    const unspentSeg = unspentPct > 0
        ? `<div title="Unspent — ${_m(leftover)}" style="height:100%;width:${unspentPct}%;background:rgba(127,127,127,0.18);display:inline-block"></div>`
        : '';

    // Income marker line (only if spent > income, to show overflow)
    const incomeMarkerPct = spent > income && income > 0 ? (income / denom) * 100 : null;
    const marker = incomeMarkerPct !== null
        ? `<div title="Income ${_m(income)}" style="position:absolute;top:-2px;bottom:-2px;left:${incomeMarkerPct}%;width:2px;background:var(--text)"></div>`
        : '';

    let leftoverLabel;
    if (income === 0) {
        leftoverLabel = `<span style="color:var(--text-muted)">no income logged this month</span>`;
    } else if (leftover >= 0) {
        leftoverLabel = `<span style="color:var(--green)">${_m(leftover)} unspent</span>`;
    } else {
        leftoverLabel = `<span style="color:var(--red)">OVER by ${_m(Math.abs(leftover))}</span>`;
    }

    return `<div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
            <span style="color:var(--text-muted)">Earned ${_m(income)} &middot; Spent ${_m(spent)}</span>
            <span><b>${leftoverLabel}</b></span>
        </div>
        <div style="position:relative;height:14px;background:rgba(127,127,127,0.10);border-radius:7px;overflow:hidden;font-size:0">
            ${segments}${unspentSeg}${marker}
        </div>
    </div>`;
}

function renderSpendingBreakdown() {
    const el = document.getElementById('spending-breakdown-area');
    if (!el) return;
    const allItems = _expenses();
    if (!allItems.length) { el.innerHTML = ''; return; }

    // Group by month (YYYY-MM)
    const byMonth = {};
    allItems.forEach(e => {
        const key = (e.date || '').substring(0, 7);
        if (!key) return;
        if (!byMonth[key]) byMonth[key] = [];
        byMonth[key].push(e);
    });
    const months = Object.keys(byMonth).sort().reverse(); // newest first

    const SKIP = new Set(['income', 'savings/transfer', 'transfer (in)']);

    const sections = months.map((monthKey, idx) => {
        const items = byMonth[monthKey];
        const incomeItems = items.filter(e => (e.category || '').toLowerCase() === 'income');
        const spendingOnly = items.filter(e => !SKIP.has((e.category || '').toLowerCase()));
        const totalSpent = spendingOnly.reduce((s, e) => s + (e.amount || 0), 0);
        const totalIncome = incomeItems.reduce((s, e) => s + (e.amount || 0), 0);
        const monthName = new Date(monthKey + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const isOpen = idx === 0;
        const summaryParts = [];
        if (totalIncome > 0) summaryParts.push(`<span style="color:var(--green)">+${_m(totalIncome)} in</span>`);
        summaryParts.push(`<span style="color:var(--text-muted)">−${_m(totalSpent)} out</span>`);
        return `<details ${isOpen ? 'open' : ''} style="margin-bottom:10px;border-bottom:1px solid var(--border);padding-bottom:8px">
            <summary style="font-size:14px;font-weight:600;cursor:pointer;color:var(--text);padding:4px 0">${esc(monthName)} <span style="font-weight:400">&mdash; ${summaryParts.join(' &middot; ')}</span></summary>
            <div style="padding:10px 0 4px 0">
                ${_renderIncomeGauge(items, incomeItems)}
                ${_renderMonthBars(spendingOnly, monthKey)}
            </div>
        </details>`;
    }).join('');

    const grandSpent = allItems
        .filter(e => !SKIP.has((e.category || '').toLowerCase()))
        .reduce((s, e) => s + (e.amount || 0), 0);
    const grandIncome = allItems
        .filter(e => (e.category || '').toLowerCase() === 'income')
        .reduce((s, e) => s + (e.amount || 0), 0);
    const headerParts = [];
    if (grandIncome > 0) headerParts.push(`<span style="color:var(--green)">+${_m(grandIncome)} in</span>`);
    headerParts.push(`<span>−${_m(grandSpent)} out</span>`);

    el.innerHTML = `<details open class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Spending by month &mdash; ${headerParts.join(' &middot; ')} across ${months.length} month${months.length === 1 ? '' : 's'}</summary>
        <div class="card" style="border-left-color:var(--ongoing);margin-top:8px;padding:14px">
            ${sections}
        </div>
    </details>`;
}

// --- Set Aside (savings + tax obligation) ---

const TAX_RATE = 0.25;

function _vidalaIncome() {
    return _expenses().filter(e => {
        const c = (e.comments || '').toLowerCase();
        const cat = (e.category || '').toLowerCase();
        return cat === 'income' && c.includes('vidala');
    });
}

function _allIncome() {
    return _expenses().filter(e => (e.category || '').toLowerCase() === 'income');
}

function _savingsTransfers() {
    // Items categorized as Savings/Transfer (created during CSV import for "transfer to savings")
    return _expenses().filter(e => (e.category || '').toLowerCase() === 'savings/transfer');
}

function _taxSetaside() { return D.tax_setaside || []; }

function renderSetAside() {
    const el = document.getElementById('set-aside-area');
    if (!el) return;

    // Tax math
    const vidalaPaychecks = _vidalaIncome();
    const vidalaTotal = vidalaPaychecks.reduce((s, e) => s + (e.amount || 0), 0);
    const taxOwed = vidalaTotal * TAX_RATE;
    const taxAside = _taxSetaside().reduce((s, t) => s + (t.amount || 0), 0);
    const taxBalance = taxOwed - taxAside;

    // Savings math (just transfers to savings for now)
    const savings = _savingsTransfers();
    const savingsTotal = savings.reduce((s, e) => s + (e.amount || 0), 0);

    const taxBalanceColor = taxBalance > 0 ? 'var(--red)' : 'var(--green)';
    const taxBalanceLabel = taxBalance > 0 ? `OWE $${taxBalance.toFixed(2)}` : `AHEAD $${Math.abs(taxBalance).toFixed(2)}`;

    // Tax setaside log
    const recentTaxLog = [..._taxSetaside()]
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .slice(0, 8)
        .map(t => `<tr style="border-top:1px solid var(--border)">
            <td style="padding:4px 8px;font-size:11px;color:var(--text-muted);white-space:nowrap">${esc(t.date || '')}</td>
            <td style="padding:4px 8px;font-size:12px;white-space:nowrap"><b>$${(t.amount || 0).toFixed(2)}</b></td>
            <td style="padding:4px 8px;font-size:11px;color:var(--text-muted)">${esc(t.notes || '')}</td>
            <td style="padding:4px 8px;text-align:right">
                <button onclick="removeTaxSetaside('${esc(t.id)}')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0 4px">&times;</button>
            </td>
        </tr>`).join('');

    el.innerHTML = `<details open class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Set Aside &mdash; Saved + Tax</summary>
        <div class="card" style="border-left-color:var(--ongoing);margin-top:8px;padding:14px">

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:14px">
                <div style="background:rgba(46,204,113,0.06);border:1px solid rgba(46,204,113,0.25);border-radius:8px;padding:10px 14px">
                    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Saved (transfers)</div>
                    <div style="font-size:22px;font-weight:700;color:var(--green);margin-top:4px">$${savingsTotal.toFixed(2)}</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${savings.length} transfer${savings.length === 1 ? '' : 's'} logged</div>
                </div>

                <div style="background:rgba(231,76,60,0.06);border:1px solid rgba(231,76,60,0.25);border-radius:8px;padding:10px 14px">
                    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Tax obligation (25%)</div>
                    <div style="font-size:22px;font-weight:700;color:${taxBalanceColor};margin-top:4px">${taxBalanceLabel}</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px">$${taxOwed.toFixed(2)} owed &middot; $${taxAside.toFixed(2)} set aside</div>
                </div>
            </div>

            <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">
                Vidala paychecks detected: <b>${vidalaPaychecks.length}</b> totaling <b>$${vidalaTotal.toFixed(2)}</b>
                ${vidalaPaychecks.length === 0 ? '<span style="color:var(--yellow)"> &mdash; none yet (CSV import income marked Vidala will appear here)</span>' : ''}
            </div>

            <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
                <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Log tax setaside</div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
                    <input type="number" step="0.01" id="tax-amount" placeholder="$ moved to tax savings" style="width:180px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)" onkeydown="if(event.key==='Enter')addTaxSetaside()">
                    <input type="date" id="tax-date" value="${todayStr()}" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg)">
                    <input type="text" id="tax-notes" placeholder="notes (optional)" style="flex:1;min-width:160px;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)" onkeydown="if(event.key==='Enter')addTaxSetaside()">
                    <button onclick="addTaxSetaside()" style="padding:7px 18px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Log</button>
                </div>
                ${recentTaxLog ? `<table style="width:100%;border-collapse:collapse;margin-top:10px"><tbody>${recentTaxLog}</tbody></table>` : ''}
            </div>
        </div>
    </details>`;
}

async function addTaxSetaside() {
    const amount = document.getElementById('tax-amount').value;
    if (!amount) { document.getElementById('tax-amount').focus(); return; }
    const date = document.getElementById('tax-date').value || todayStr();
    const notes = document.getElementById('tax-notes').value.trim();
    const res = await fetch('/api/tax/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, date, notes })
    });
    if (res.ok) {
        document.getElementById('tax-amount').value = '';
        document.getElementById('tax-notes').value = '';
        loadDashboard();
    }
}

async function removeTaxSetaside(id) {
    if (!confirm('Remove this setaside entry?')) return;
    await fetch('/api/tax/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    loadDashboard();
}
