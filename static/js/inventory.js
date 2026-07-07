// inventory.js — buy list and (eventually) stock, goods/services tracking

function renderPriorityNotes() {
    const el = document.getElementById('priority-notes-area');
    if (!el) return;
    const text = (D.priority_notes || '');
    // Don't re-render if the user is currently typing in the textarea
    const existing = el.querySelector('textarea');
    if (existing && document.activeElement === existing) return;

    el.innerHTML = `
        <div class="card" style="border-left-color:#d4880a;background:linear-gradient(rgba(212,136,10,0.07),rgba(212,136,10,0.07)),var(--card-bg,#fffaf0);margin-bottom:16px;padding:14px 16px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <div style="font-size:12px;font-weight:700;color:#d4880a;text-transform:uppercase;letter-spacing:1.2px">Priority notes</div>
                <span id="priority-notes-status" style="font-size:12px;color:var(--text-muted);font-style:italic"></span>
            </div>
            <textarea id="priority-notes-input" placeholder="What you want to buy over other things — running thoughts, savings goals, what to skip..."
                style="width:100%;min-height:60px;border:none;background:transparent;font:inherit;font-size:14px;color:var(--text);resize:vertical;outline:none;line-height:1.55"
                onblur="savePriorityNotes(this)"
                oninput="markPriorityNotesDirty()">${esc(text)}</textarea>
        </div>`;
}

let _pnDirty = false;
function markPriorityNotesDirty() {
    _pnDirty = true;
    const status = document.getElementById('priority-notes-status');
    if (status) status.textContent = 'unsaved';
}

async function savePriorityNotes(textarea) {
    if (!_pnDirty) return;
    _pnDirty = false;
    const status = document.getElementById('priority-notes-status');
    if (status) status.textContent = 'saving…';
    try {
        await fetch('/api/priority-notes/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textarea.value })
        });
        if (status) {
            status.textContent = 'saved';
            setTimeout(() => { if (status.textContent === 'saved') status.textContent = ''; }, 1500);
        }
        // Update local state so a subsequent re-render doesn't blow away the new text
        D.priority_notes = textarea.value;
    } catch (e) {
        if (status) status.textContent = 'save failed';
    }
}

const BUY_KINDS = [
    { key: 'consumable', label: 'Consumables', color: 'var(--green)' },
    { key: 'durable', label: 'Durables', color: 'var(--purple,#8e6bbf)' },
    { key: 'service', label: 'Services', color: 'var(--ongoing)' },
];

async function setBuyKind(name, kind) {
    const res = await fetch('/api/buy/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, kind })
    });
    if (res.ok) loadDashboard();
    else alert('Save failed');
}

function renderBuyList() {
    const el = document.getElementById('buy-list-area');
    const items = D.buy_list || [];

    const priorityColors = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--text-muted)' };
    const priorityOrder = { high: 0, medium: 1, low: 2 };

    const knownCategories = [...new Set(items.map(i => (i.category || '').trim()).filter(Boolean))].sort();
    const datalistOptions = knownCategories.map(c => `<option value="${esc(c)}">`).join('');

    const renderItem = (item) => {
        const color = priorityColors[item.priority] || 'var(--text-muted)';
        const url = `/item/buy/${encodeURIComponent(item.name)}`;
        const costBadge = item.cost
            ? `<span style="font-size:13px;font-weight:600;color:var(--text);background:rgba(26,188,156,0.10);border:1px solid rgba(26,188,156,0.25);border-radius:16px;padding:4px 12px;margin-left:auto;margin-right:6px;white-space:nowrap">${esc(item.cost)}</span>`
            : `<span style="margin-left:auto"></span>`;
        const meta = [];
        if (item.why) meta.push(`<em>${esc(item.why)}</em>`);
        if (item.by) meta.push(`<span style="color:var(--red)">by ${esc(item.by)}</span>`);
        const metaLine = meta.length ? `<div style="width:100%;font-size:12px;color:var(--text-muted);padding-left:16px;margin-top:2px">${meta.join(' · ')}</div>` : '';
        // unsorted items get one-tap filing chips into a kind
        const kindChips = !BUY_KINDS.some(k => k.key === item.kind)
            ? `<span style="display:inline-flex;gap:4px;margin-right:4px">${BUY_KINDS.map(k =>
                `<button onclick="setBuyKind('${escJs(item.name)}','${k.key}')" title="File under ${k.label}" style="min-height:32px;background:none;border:1px solid ${k.color};color:${k.color};border-radius:8px;padding:4px 8px;font-size:12px;font-weight:600;cursor:pointer">${k.label.slice(0, 1)}</button>`).join('')}</span>`
            : '';
        return `<div class="card-item" style="flex-wrap:wrap;align-items:center;min-height:40px;padding:6px 0">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:8px;flex-shrink:0"></span>
            <a href="${url}" class="item-text" style="text-decoration:none;color:inherit;cursor:pointer"><b>${esc(item.name)}</b></a>
            ${costBadge}
            ${kindChips}
            <button onclick="markBuyAsBought('${escJs(item.name)}')" title="Mark as bought — moves to Active" style="min-height:32px;background:none;border:1px solid var(--ongoing);color:var(--ongoing);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;margin-right:4px">✓ Bought</button>
            <button class="delete-btn" onclick="confirmDelete('${escJs(item.name)}','buy')" title="Remove">&times;</button>
            ${metaLine}
        </div>`;
    };

    // group: kind → category → items
    const renderCategoryGroups = (kindItems) => {
        const groups = {};
        kindItems.forEach(item => {
            const cat = (item.category || '').trim() || 'uncategorized';
            (groups[cat] = groups[cat] || []).push(item);
        });
        const categoryNames = Object.keys(groups).sort((a, b) => {
            if (a === 'uncategorized') return 1;
            if (b === 'uncategorized') return -1;
            return a.localeCompare(b);
        });
        return categoryNames.map(cat => {
            const sorted = [...groups[cat]].sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));
            const label = cat === 'uncategorized' ? 'Uncategorized' : cat.charAt(0).toUpperCase() + cat.slice(1);
            return `<div style="margin-bottom:10px">
                <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">${esc(label)} <span style="opacity:0.6;font-weight:400">(${sorted.length})</span></div>
                ${sorted.map(renderItem).join('')}
            </div>`;
        }).join('');
    };

    let listHTML = '';
    const unsorted = items.filter(i => !BUY_KINDS.some(k => k.key === i.kind));
    BUY_KINDS.forEach(k => {
        const kindItems = items.filter(i => i.kind === k.key);
        if (!kindItems.length) return;
        listHTML += `<div style="margin-bottom:14px">
            <div style="font-size:14px;font-weight:700;color:${k.color};margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)">${k.label} <span style="opacity:0.6;font-weight:400;font-size:12px">(${kindItems.length})</span></div>
            ${renderCategoryGroups(kindItems)}
        </div>`;
    });
    if (unsorted.length) {
        listHTML += `<div style="margin-bottom:14px">
            <div style="font-size:14px;font-weight:700;color:var(--text-muted);margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid var(--border)">Unsorted <span style="opacity:0.6;font-weight:400;font-size:12px">(${unsorted.length})</span></div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Tap C / D / S to file as Consumable, Durable or Service</div>
            ${renderCategoryGroups(unsorted)}
        </div>`;
    }

    let html = `<details open class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Buy List${items.length ? ` (${items.length})` : ''}</summary>
        <div class="card" style="border-left-color:var(--ongoing);margin-top:8px;padding:12px">
            ${listHTML || '<div style="font-size:14px;color:var(--text-muted);padding:4px 0">Nothing on the list</div>'}
            <datalist id="buy-categories">${datalistOptions}</datalist>
            <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
                <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">
                    <input type="text" id="buy-name" placeholder="Item name..." style="flex:2;min-width:160px;min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)" onkeydown="if(event.key==='Enter')addBuyItem()">
                    <select id="buy-kind" style="min-height:40px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg)">
                        <option value="consumable" selected>Consumable</option>
                        <option value="durable">Durable</option>
                        <option value="service">Service</option>
                    </select>
                    <select id="buy-priority" style="min-height:40px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg)">
                        <option value="high">High</option>
                        <option value="medium" selected>Medium</option>
                        <option value="low">Low</option>
                    </select>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">
                    <input type="text" id="buy-category" list="buy-categories" placeholder="Category (e.g. supplements)" style="flex:1;min-width:160px;min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
                    <input type="text" id="buy-where" placeholder="Where (optional)" style="flex:1;min-width:160px;min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:8px">
                    <input type="text" id="buy-notes" placeholder="Notes (optional)" style="flex:1;min-width:160px;min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)" onkeydown="if(event.key==='Enter')addBuyItem()">
                    <button onclick="addBuyItem()" style="min-height:40px;padding:7px 16px;border:none;border-radius:8px;background:var(--text);color:#fff;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap">Add</button>
                </div>
            </div>
        </div>
    </details>`;

    el.innerHTML = html;
}

// --- Active Inventory ---

const STATUS_META = {
    in_use:      { label: 'In use',      color: 'var(--green)' },
    running_low: { label: 'Running low', color: 'var(--red)' },
    finished:    { label: 'Finished',    color: 'var(--text-muted)' },
    paused:      { label: 'Paused',      color: 'var(--yellow)' },
};

function renderRestockBanner() {
    const el = document.getElementById('restock-banner-area');
    if (!el) return;
    const items = D.active_inventory || [];
    const lows = items.filter(i => i.status === 'running_low');
    if (!lows.length) { el.innerHTML = ''; return; }

    const chips = lows.map(item => {
        const order = item.order_url
            ? `<a href="${esc(item.order_url)}" target="_blank" rel="noopener" title="Order page" style="color:var(--red);text-decoration:none;margin-left:6px">↗</a>`
            : '';
        return `<span style="display:inline-flex;align-items:center;gap:2px;padding:4px 12px;background:rgba(231,76,60,0.10);color:var(--red);border:1px solid rgba(231,76,60,0.3);border-radius:16px;font-size:12px;font-weight:600">
            ${esc(item.name)}${order}
        </span>`;
    }).join(' ');

    el.innerHTML = `<div style="background:rgba(231,76,60,0.06);border:1px solid rgba(231,76,60,0.25);border-radius:10px;padding:10px 14px;margin-bottom:14px">
        <div style="font-size:12px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Needs Restock (${lows.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
    </div>`;
}

function renderActiveInventory() {
    const el = document.getElementById('active-inventory-area');
    if (!el) return;
    const items = (D.active_inventory || []).filter(i => i.status !== 'finished');

    if (!items.length) {
        el.innerHTML = '';
        return;
    }

    const groups = {};
    items.forEach(item => {
        const cat = (item.category || '').trim() || 'uncategorized';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(item);
    });
    const categoryNames = Object.keys(groups).sort((a, b) => {
        if (a === 'uncategorized') return 1;
        if (b === 'uncategorized') return -1;
        return a.localeCompare(b);
    });

    const renderRow = (item) => {
        const status = item.status || 'in_use';
        const meta = STATUS_META[status] || STATUS_META.in_use;
        const statusBadge = `<span style="font-size:12px;font-weight:600;color:#fff;background:${meta.color};border-radius:16px;padding:3px 10px;white-space:nowrap;display:inline-block">${meta.label}</span>`;
        const costCell = item.last_cost ? esc(item.last_cost) : '<span style="color:var(--text-muted)">—</span>';
        const notesOneLine = item.notes ? item.notes.replace(/\n/g, ' · ') : '';
        const notesCell = notesOneLine
            ? `<span title="${esc(item.notes)}" style="color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;max-width:280px;vertical-align:bottom">${esc(notesOneLine)}</span>`
            : '<span style="color:var(--text-muted)">—</span>';
        const restockBtn = status !== 'running_low'
            ? `<button onclick="restockActive('${escJs(item.name)}')" title="Mark running low — auto-adds to buy list" style="min-height:32px;background:none;border:1px solid var(--red);color:var(--red);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer">Restock</button>`
            : `<span style="font-size:12px;color:var(--red);font-style:italic">on buy list</span>`;
        const retireBtn = `<button onclick="retireActive('${escJs(item.name)}')" title="Move to Past — log when you stopped + your thoughts" style="min-height:32px;background:none;border:1px solid var(--text-muted);color:var(--text-muted);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;margin-left:4px">Retire</button>`;

        const orderLink = item.order_url
            ? `<a href="${esc(item.order_url)}" target="_blank" rel="noopener" title="Order page" style="color:var(--ongoing);text-decoration:none;margin-left:6px;font-size:13px">↗</a>`
            : '';

        const orders = item.ordered_at || [];
        const historyText = orders.length > 0
            ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">Last ordered ${esc(orders[orders.length - 1])}${orders.length > 1 ? ` · ${orders.length} times total` : ''}</div>`
            : '';

        return `<tr style="border-top:1px solid var(--border)">
            <td style="padding:8px 10px">
                <b>${esc(item.name)}</b>${orderLink}
                ${historyText}
            </td>
            <td style="padding:8px 10px;white-space:nowrap;font-size:13px">${costCell}</td>
            <td style="padding:8px 10px;white-space:nowrap">${statusBadge}</td>
            <td style="padding:8px 10px;font-size:13px">${notesCell}</td>
            <td style="padding:8px 10px;text-align:right;white-space:nowrap">
                ${restockBtn}
                ${retireBtn}
                <button onclick="confirmDelete('${escJs(item.name)}','active')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;padding:6px 8px;margin-left:4px">&times;</button>
            </td>
        </tr>`;
    };

    let tablesHTML = '';
    categoryNames.forEach(cat => {
        const sorted = [...groups[cat]].sort((a, b) => {
            const sa = a.status === 'running_low' ? 0 : (a.status === 'in_use' ? 1 : 2);
            const sb = b.status === 'running_low' ? 0 : (b.status === 'in_use' ? 1 : 2);
            return sa - sb;
        });
        const label = cat === 'uncategorized' ? 'Uncategorized' : cat.charAt(0).toUpperCase() + cat.slice(1);
        tablesHTML += `<div style="margin-bottom:14px">
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${esc(label)} <span style="opacity:0.6;font-weight:400">(${sorted.length})</span></div>
            <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:14px">
                    <thead>
                        <tr style="text-align:left;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:0.5px">
                            <th style="padding:6px 10px;font-weight:600">Name</th>
                            <th style="padding:6px 10px;font-weight:600">Last cost</th>
                            <th style="padding:6px 10px;font-weight:600">Status</th>
                            <th style="padding:6px 10px;font-weight:600">Notes</th>
                            <th style="padding:6px 10px;font-weight:600;text-align:right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>${sorted.map(renderRow).join('')}</tbody>
                </table>
            </div>
        </div>`;
    });

    el.innerHTML = `<details open class="card-section" style="margin-bottom:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Consumables${items.length ? ` (${items.length})` : ''}</summary>
        <div class="card" style="border-left-color:var(--green);margin-top:8px;padding:12px">
            ${tablesHTML}
        </div>
    </details>`;
}

async function markBuyAsBought(name) {
    const res = await fetch('/api/buy/move-to-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (res.ok) loadDashboard();
    else alert('Move failed');
}

async function restockActive(name) {
    const res = await fetch('/api/active/restock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (res.ok) loadDashboard();
    else alert('Restock failed');
}

async function retireActive(name) {
    const review = prompt(`Retire "${name}" — your thoughts on it (didn't work, side effects, finished, etc):`, '');
    if (review === null) return;
    const res = await fetch('/api/active/retire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, review: review.trim() })
    });
    if (res.ok) loadDashboard();
    else alert('Retire failed');
}

async function unretireActive(name) {
    const res = await fetch('/api/active/unretire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (res.ok) loadDashboard();
    else alert('Unretire failed');
}

async function editReview(name) {
    const item = (D.active_inventory || []).find(i => i.name === name);
    const current = item ? (item.review || '') : '';
    const updated = prompt(`Review for "${name}":`, current);
    if (updated === null) return;
    const res = await fetch('/api/active/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, review: updated.trim() })
    });
    if (res.ok) loadDashboard();
    else alert('Save failed');
}

function renderPastInventory() {
    const el = document.getElementById('past-inventory-area');
    if (!el) return;
    const items = (D.active_inventory || []).filter(i => i.status === 'finished');

    if (!items.length) {
        el.innerHTML = '';
        return;
    }

    const groups = {};
    items.forEach(item => {
        const cat = (item.category || '').trim() || 'uncategorized';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(item);
    });
    const categoryNames = Object.keys(groups).sort();

    const renderRow = (item) => {
        const orders = item.ordered_at || [];
        const firstOrder = orders.length ? orders[0] : '';
        const retiredOn = item.retired_on || '';
        const usedRange = (firstOrder && retiredOn)
            ? `${esc(firstOrder)} → ${esc(retiredOn)}`
            : (retiredOn ? `retired ${esc(retiredOn)}` : '<span style="color:var(--text-muted)">—</span>');
        const reviewText = item.review
            ? `<span title="${esc(item.review)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;max-width:340px;vertical-align:bottom">${esc(item.review)}</span>`
            : `<span style="color:var(--text-muted);font-style:italic">no thoughts logged</span>`;
        return `<tr style="border-top:1px solid var(--border)">
            <td style="padding:8px 10px"><b>${esc(item.name)}</b></td>
            <td style="padding:8px 10px;white-space:nowrap;font-size:13px;color:var(--text-muted)">${usedRange}</td>
            <td style="padding:8px 10px;font-size:13px;cursor:pointer" onclick="editReview('${escJs(item.name)}')" title="Click to edit">${reviewText}</td>
            <td style="padding:8px 10px;text-align:right;white-space:nowrap">
                <button onclick="unretireActive('${escJs(item.name)}')" title="Bring back to active" style="min-height:32px;background:none;border:1px solid var(--green);color:var(--green);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer">Bring back</button>
                <button onclick="confirmDelete('${escJs(item.name)}','active')" title="Delete forever" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;padding:6px 8px;margin-left:4px">&times;</button>
            </td>
        </tr>`;
    };

    let tablesHTML = '';
    categoryNames.forEach(cat => {
        const sorted = [...groups[cat]].sort((a, b) => (b.retired_on || '').localeCompare(a.retired_on || ''));
        const label = cat === 'uncategorized' ? 'Uncategorized' : cat.charAt(0).toUpperCase() + cat.slice(1);
        tablesHTML += `<div style="margin-bottom:14px">
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${esc(label)} <span style="opacity:0.6;font-weight:400">(${sorted.length})</span></div>
            <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:14px">
                    <thead>
                        <tr style="text-align:left;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:0.5px">
                            <th style="padding:6px 10px;font-weight:600">Name</th>
                            <th style="padding:6px 10px;font-weight:600">Used</th>
                            <th style="padding:6px 10px;font-weight:600">Thoughts</th>
                            <th style="padding:6px 10px;font-weight:600;text-align:right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>${sorted.map(renderRow).join('')}</tbody>
                </table>
            </div>
        </div>`;
    });

    el.innerHTML = `<details class="card-section" style="margin-top:16px">
        <summary style="font-size:16px;font-weight:600;cursor:pointer;color:var(--text-secondary)">Past Consumables${items.length ? ` (${items.length})` : ''}</summary>
        <div class="card" style="border-left-color:var(--text-muted);margin-top:8px;padding:12px">
            ${tablesHTML}
        </div>
    </details>`;
}

// --- Buy Item Detail Page ---
function renderBuyItemDetail() {
    const el = document.getElementById('item-buy-area');
    if (!el) return;

    const item = D.buy_item;
    if (!item) {
        el.innerHTML = `<div style="padding:20px">
            <button onclick="history.back()" style="min-height:40px;font-size:13px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:8px;padding:8px 16px;cursor:pointer;margin-bottom:16px">← Back</button>
            <div style="color:var(--red)">Item not found.</div>
        </div>`;
        return;
    }

    const known = D.known_categories || [];
    const datalistOpts = known.map(c => `<option value="${esc(c)}">`).join('');

    el.innerHTML = `
        <div style="max-width:680px;margin:0 auto">
            <button onclick="history.back()" style="min-height:40px;font-size:13px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:8px;padding:8px 16px;cursor:pointer;margin-bottom:16px">← Back</button>

            <div class="card" style="border-left-color:var(--ongoing);padding:20px">
                <input type="text" id="detail-name" value="${esc(item.name)}" style="width:100%;font-size:22px;font-weight:700;border:none;outline:none;background:transparent;color:var(--text);margin-bottom:16px;padding:4px 0;border-bottom:1px solid transparent" onfocus="this.style.borderBottomColor='var(--border)'" onblur="this.style.borderBottomColor='transparent'">

                <div style="display:grid;grid-template-columns:80px 1fr;gap:10px 12px;margin-bottom:16px;align-items:center">
                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Cost</label>
                    <input type="text" id="detail-cost" value="${esc(item.cost || '')}" placeholder="$40-80, 30 min, or free" style="min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">

                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Why</label>
                    <input type="text" id="detail-why" value="${esc(item.why || '')}" placeholder="what it solves / unlocks" style="min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">

                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">By</label>
                    <input type="text" id="detail-by" value="${esc(item.by || '')}" placeholder="deadline (YYYY-MM-DD) or open" style="min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">

                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Category</label>
                    <input type="text" id="detail-category" list="detail-categories" value="${esc(item.category || '')}" placeholder="services, supplements, household..." style="min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">
                    <datalist id="detail-categories">${datalistOpts}</datalist>

                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Where</label>
                    <input type="text" id="detail-where" value="${esc(item.where || '')}" placeholder="store/site (optional)" style="min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">

                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Order URL</label>
                    <input type="url" id="detail-order-url" value="${esc(item.order_url || '')}" placeholder="https://... (one-tap reorder link)" style="min-height:40px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg)">

                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Priority</label>
                    <select id="detail-priority" style="min-height:40px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg)">
                        <option value="high" ${item.priority === 'high' ? 'selected' : ''}>High</option>
                        <option value="medium" ${item.priority === 'medium' ? 'selected' : ''}>Medium</option>
                        <option value="low" ${item.priority === 'low' ? 'selected' : ''}>Low</option>
                    </select>

                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Kind</label>
                    <select id="detail-kind" style="min-height:40px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--bg)">
                        <option value="" ${!item.kind ? 'selected' : ''}>Unsorted</option>
                        <option value="consumable" ${item.kind === 'consumable' ? 'selected' : ''}>Consumable</option>
                        <option value="durable" ${item.kind === 'durable' ? 'selected' : ''}>Durable</option>
                        <option value="service" ${item.kind === 'service' ? 'selected' : ''}>Service</option>
                    </select>
                </div>

                <div style="margin-top:8px">
                    <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:6px">Notes</label>
                    <textarea id="detail-notes" rows="10" placeholder="research, alternatives, places to try, who recommended what, prices you've seen..." style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--bg);font-family:inherit;line-height:1.5;resize:vertical">${esc(item.notes || '')}</textarea>
                </div>

                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
                    <button onclick="history.back()" style="min-height:40px;padding:8px 16px;border:1px solid var(--border);border-radius:8px;background:none;font-size:13px;cursor:pointer;color:var(--text-muted)">Cancel</button>
                    <button onclick="saveBuyItemDetail('${escJs(item.name)}')" style="min-height:40px;padding:8px 20px;border:none;border-radius:8px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Save</button>
                </div>
            </div>
        </div>
    `;
}

async function saveBuyItemDetail(originalName) {
    const newName = document.getElementById('detail-name').value.trim();
    if (!newName) { alert('Name is required'); return; }
    const payload = {
        name: originalName,
        new_name: newName,
        cost: document.getElementById('detail-cost').value.trim(),
        why: document.getElementById('detail-why').value.trim(),
        by: document.getElementById('detail-by').value.trim(),
        category: document.getElementById('detail-category').value.trim(),
        where: document.getElementById('detail-where').value.trim(),
        order_url: document.getElementById('detail-order-url').value.trim(),
        priority: document.getElementById('detail-priority').value,
        kind: document.getElementById('detail-kind').value,
        notes: document.getElementById('detail-notes').value.trim(),
    };
    const res = await fetch('/api/buy/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (res.ok) {
        if (newName !== originalName) {
            window.location.href = `/item/buy/${encodeURIComponent(newName)}`;
        } else {
            history.back();
        }
    } else {
        alert('Save failed');
    }
}

async function addBuyItem() {
    const name = document.getElementById('buy-name').value.trim();
    if (!name) return;
    const priority = document.getElementById('buy-priority').value;
    const kind = document.getElementById('buy-kind').value;
    const where = document.getElementById('buy-where').value.trim();
    const category = document.getElementById('buy-category').value.trim();
    const notes = document.getElementById('buy-notes').value.trim();
    const res = await fetch('/api/buy/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, priority, kind, where, category, notes })
    });
    if (res.ok) {
        document.getElementById('buy-name').value = '';
        document.getElementById('buy-where').value = '';
        document.getElementById('buy-category').value = '';
        document.getElementById('buy-notes').value = '';
        loadDashboard();
    } else {
        const data = await res.json();
        alert(data.error || 'Failed to add');
    }
}
