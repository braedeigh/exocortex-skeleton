// contacts.js — contact reminders, keep in touch, contact calendar

function getContactSnoozes() {
    try {
        const raw = localStorage.getItem('exo-contact-snooze');
        if (!raw) return {};
        const data = JSON.parse(raw);
        // Clean out old snoozes (not today)
        const today = todayStr();
        const cleaned = {};
        Object.keys(data).forEach(k => { if (data[k] === today) cleaned[k] = today; });
        return cleaned;
    } catch(e) { return {}; }
}

function snoozeContact(name) {
    const snoozes = getContactSnoozes();
    snoozes[name] = todayStr();
    localStorage.setItem('exo-contact-snooze', JSON.stringify(snoozes));
    renderContactReminders();
}

function renderContactReminders() {
    const el = document.getElementById('contact-reminders');
    if (!D.contacts || !D.contacts.length) { el.innerHTML = ''; return; }

    const snoozes = getContactSnoozes();
    const today = todayStr();
    let cards = '';
    let count = 0;
    let hasRed = false;
    D.contacts.forEach(c => {
        const days = c.days_since;
        const warn = Math.floor(c.threshold_days / 2); // warn at half threshold
        const red = c.threshold_days;

        if (days === null || days >= warn) {
            const isRed = days === null || days >= red;
            // Skip snoozed orange contacts
            if (!isRed && snoozes[c.name] === today) return;
            if (isRed) hasRed = true;
            count++;
            const color = isRed ? 'var(--red)' : 'var(--orange)';
            const daysText = days === null ? 'never' : `${days} day${days !== 1 ? 's' : ''} ago`;
            const subtitle = isRed ? 'Overdue — reach out!' : 'Been a while';
            const pulse = isRed ? 'animation: hrt-pulse 2s ease-in-out infinite;' : '';
            const fontSize = isRed ? '18px' : '15px';
            const snoozeBtn = !isRed ? `<button onclick="snoozeContact('${esc(c.name)}')" style="font-size:11px;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);border-radius:6px;padding:4px 10px;cursor:pointer;color:inherit;margin-right:6px">Tomorrow</button>` : '';

            cards += `<div class="hrt-bar" style="border-left-color:${color};background:${color};${pulse}margin-bottom:8px;${isRed ? '' : 'padding:10px 16px;'}">
                <div>
                    <div style="font-size:${fontSize}">${esc(c.name)} — ${daysText}</div>
                    <div style="font-size:12px;opacity:0.8;font-weight:400;margin-top:1px">${subtitle}</div>
                </div>
                <div style="display:flex;align-items:center">
                    ${snoozeBtn}
                    <button class="hrt-done-btn" onclick="showContactMethodPicker(this, '${esc(c.name)}')" style="font-size:12px">&#10003; Talked</button>
                </div>
            </div>`;
        }
    });
    if (!count) { el.innerHTML = ''; return; }
    const summaryColor = hasRed ? 'var(--red)' : 'var(--orange)';
    const summaryLabel = `Calls & Contacts (${count})`;
    el.innerHTML = `<details class="contact-reminder-group">
        <summary style="cursor:pointer;font-size:15px;font-weight:600;color:${summaryColor};margin-bottom:8px;list-style:none;display:flex;align-items:center;gap:8px">
            <span class="contact-chevron" style="display:inline-block;transition:transform 0.2s;font-size:12px">&#9660;</span>
            ${summaryLabel}
        </summary>
        ${cards}
    </details>`;
}

function showContactMethodPicker(btn, name) {
    // Remove any existing picker
    document.querySelectorAll('.contact-method-picker').forEach(p => p.remove());
    const picker = document.createElement('div');
    picker.className = 'contact-method-picker';
    ['Call', 'Text', 'FaceTime', 'Visit'].forEach(m => {
        const b = document.createElement('button');
        b.textContent = m;
        b.onclick = (e) => { e.stopPropagation(); picker.remove(); quickLogContact(name, m.toLowerCase()); };
        picker.appendChild(b);
    });
    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(picker);
    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); }
        });
    }, 0);
}

async function quickLogContact(name, method) {
    await fetch('/api/contacts/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, method })
    });
    loadDashboard();
}

// --- Contacts ---
function renderContacts() {
    // The card shows just the calendar; "Manage contacts" opens in the editor modal.
    const el = document.getElementById('contacts-area');
    if (el) el.innerHTML = (D.contacts && D.contacts.length) ? '<div id="contact-calendar-slot"></div>' : '';
    if (window._contactsManageOpen) showEditorModal('Manage contacts', manageContactsPanelHtml());
}

function openContactsManage() {
    window._contactsManageOpen = true;
    if (typeof _habitTrackerEditing !== 'undefined') _habitTrackerEditing = false;
    window._remMgrOpen = false;
    if (typeof renderHabitTracker === 'function') renderHabitTracker();
    if (typeof renderReminderManager === 'function') renderReminderManager();
    renderContacts();
}

function manageContactsPanelHtml() {
    let html = '<div class="contacts-grid">';
    (D.contacts || []).forEach(c => {
        const days = c.days_since;
        let color, statusText;
        if (days === null || days === undefined) {
            color = 'var(--red)';
            statusText = 'Never contacted';
        } else if (days === 0) {
            color = 'var(--green)';
            statusText = 'Today';
        } else if (days < 7) {
            color = 'var(--green)';
            statusText = `${days} day${days !== 1 ? 's' : ''} ago`;
        } else if (days < c.threshold_days) {
            color = 'var(--yellow)';
            statusText = `${days} days ago`;
        } else {
            color = 'var(--red)';
            statusText = `${days} days ago`;
        }

        const methodText = c.method ? `Last: ${esc(c.method)}` : '';
        const methods = ['Call', 'Text', 'FaceTime', 'Visit'];
        const buttons = methods.map(m =>
            `<button onclick="event.stopPropagation();logContact('${esc(c.name)}','${m.toLowerCase()}')">${m}</button>`
        ).join('');
        const cardId = `contact-actions-${c.name.replace(/\s+/g,'-')}`;

        const rbtn = 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:10px;line-height:1;padding:2px 5px';
        html += `<div class="contact-card" style="border-left-color:${color}">
            <button class="contact-remove" onclick="removeContact('${esc(c.name)}')" title="Remove">&times;</button>
            <div style="position:absolute;top:8px;left:10px;display:flex;gap:3px">
                <button onclick="moveContact('${escJs(c.name)}',-1)" title="Move up" style="${rbtn}">&#9650;</button>
                <button onclick="moveContact('${escJs(c.name)}',1)" title="Move down" style="${rbtn}">&#9660;</button>
            </div>
            <div class="contact-name" style="margin-top:14px">${esc(c.name)}</div>
            <div class="contact-status" style="color:${color};font-weight:600">${statusText}</div>
            ${methodText ? `<div class="contact-method">${methodText}</div>` : ''}
            <div class="contact-cadence" style="font-size:12px;color:var(--text-muted);margin:4px 0">
                remind every
                <input type="number" min="1" value="${esc(c.threshold_days)}" onchange="updateContactThreshold('${escJs(c.name)}', this.value)" style="width:46px;padding:3px 5px;border:1px solid var(--border);border-radius:5px;background:var(--bg);color:var(--text);font-size:12px;text-align:center;margin:0 2px"> days
            </div>
            <div class="contact-actions">${buttons}</div>
        </div>`;
    });
    html += '</div>';

    // Add contact form inside the details
    html += `<div class="add-trigger" onclick="toggleAdd('add-contact-form')">+ Add person</div>
        <div class="add-form" id="add-contact-form" style="margin-bottom:12px;align-items:center;flex-wrap:wrap">
            <input type="text" id="add-contact-name" placeholder="Name..." onkeydown="if(event.key==='Enter')addContact()">
            <span style="font-size:12px;color:var(--text-muted)">remind every</span>
            <input type="number" id="add-contact-threshold" min="1" value="14" style="width:52px;text-align:center" onkeydown="if(event.key==='Enter')addContact()">
            <span style="font-size:12px;color:var(--text-muted)">days</span>
            <button onclick="addContact()">Add</button>
        </div>`;
    return html;
}

async function logContact(name, method) {
    await fetch('/api/contacts/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, method })
    });
    loadDashboard();
}

async function addContact() {
    const nameEl = document.getElementById('add-contact-name');
    const threshEl = document.getElementById('add-contact-threshold');
    const name = (nameEl?.value || '').trim();
    if (!name) return;
    const threshold_days = Math.max(1, Number(threshEl?.value) || 14);
    const res = await fetch('/api/contacts/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, threshold_days })
    });
    if (res.ok) {
        if (nameEl) nameEl.value = '';
        if (threshEl) threshEl.value = 14;
        loadDashboard();
    } else {
        const data = await res.json();
        alert(data.error || 'Failed to add');
    }
}

async function moveContact(name, dir) {
    const arr = D.contacts || [];
    const i = arr.findIndex(c => c.name === name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    renderContacts();
    renderContactCalendar();
    await fetch('/api/contacts/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: arr.map(c => c.name) })
    });
}

async function updateContactThreshold(name, value) {
    const threshold_days = Number(value);
    const contact = (D.contacts || []).find(c => c.name === name);
    if (!threshold_days || threshold_days < 1) {
        // Restore the displayed value without collapsing the panel
        renderContacts();
        renderContactCalendar();
        return;
    }
    // Update locally + re-render in place (preserves open panels), then persist.
    if (contact) contact.threshold_days = threshold_days;
    renderContacts();
    renderContactCalendar();
    const res = await fetch('/api/contacts/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, threshold_days })
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to update');
    }
}

function renderContactCalendar() {
    const el = document.getElementById('contact-calendar-slot');
    if (!el || !D.contacts || !D.contacts.length) return;

    const methodColors = {
        call: '#3498db',
        text: '#2ecc71',
        facetime: '#9b59b6',
        visit: '#e67e22'
    };

    // Build last 30 days
    const days = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().split('T')[0]);
    }

    let html = '<div class="contact-calendar"><table>';

    // Date header row — show every 5th day
    html += '<tr><td style="min-width:100px;position:sticky;left:0;background:var(--bg);z-index:2"></td>';
    days.forEach((d, i) => {
        const dt = new Date(d + 'T12:00:00');
        const label = (i % 5 === 0 || i === days.length - 1)
            ? `<span class="cal-date">${dt.toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>`
            : '';
        html += `<td>${label}</td>`;
    });
    html += '</tr>';

    // Row per contact
    D.contacts.forEach(c => {
        const history = c.history || [];
        // Group by date — keep last method for color, count for tooltip
        const historyByDate = {};
        history.forEach(h => {
            if (!historyByDate[h.date]) historyByDate[h.date] = [];
            historyByDate[h.date].push(h.method);
        });

        html += `<tr><td class="cal-name">${esc(c.name)}</td>`;
        days.forEach(d => {
            const methods = historyByDate[d];
            if (methods && methods.length) {
                const lastMethod = methods[methods.length - 1];
                const color = methodColors[lastMethod] || '#888';
                const label = lastMethod.charAt(0).toUpperCase() + lastMethod.slice(1);
                html += `<td><div class="cal-dot-wrap" onclick="confirmRemoveHistory('${esc(c.name)}','${d}','${lastMethod}')">
                    <div class="cal-dot filled" style="background:${color}"></div>
                    <div class="cal-x">&times;</div>
                    <div class="cal-tooltip">Click to remove</div>
                </div></td>`;
            } else {
                html += `<td><div class="cal-dot-wrap">
                    <div class="cal-dot empty" style="cursor:pointer" onclick="showLogPicker('${esc(c.name)}','${d}',this)"></div>
                    <div class="cal-tooltip">Click to log</div>
                </div></td>`;
            }
        });
        html += '</tr>';
    });

    html += '</table></div>';

    // Legend — outside the scrollable area
    html += '<div style="margin-top:8px;display:flex;gap:14px;font-size:12px;color:var(--text-secondary)">';
    for (const [method, color] of Object.entries(methodColors)) {
        html += `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:4px;vertical-align:middle"></span>${method.charAt(0).toUpperCase() + method.slice(1)}</span>`;
    }
    html += '</div>';

    el.innerHTML = html;

    // Auto-scroll to show most recent days
    const cal = el.querySelector('.contact-calendar');
    if (cal) cal.scrollLeft = cal.scrollWidth;
}

function showLogPicker(name, date, dotEl) {
    // Remove any existing picker
    document.querySelectorAll('.log-picker').forEach(p => p.remove());
    const wrap = dotEl.closest('.cal-dot-wrap');
    const picker = document.createElement('div');
    picker.className = 'log-picker';
    ['Call','Text','FaceTime','Visit'].forEach(m => {
        const btn = document.createElement('button');
        btn.textContent = m;
        btn.onclick = (e) => { e.stopPropagation(); logContactOnDate(name, date, m.toLowerCase()); };
        picker.appendChild(btn);
    });
    wrap.appendChild(picker);
    // Keep the picker on-screen — nudge horizontally if it's clipped at an edge
    // (fixes the far-right column popup getting cut off).
    requestAnimationFrame(() => {
        const r = picker.getBoundingClientRect();
        const pad = 8;
        let shift = 0;
        if (r.right > window.innerWidth - pad) shift = (window.innerWidth - pad) - r.right;
        else if (r.left < pad) shift = pad - r.left;
        if (shift) picker.style.transform = `translateX(calc(-50% + ${Math.round(shift)}px))`;
    });
    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); }
        });
    }, 0);
}

async function logContactOnDate(name, date, method) {
    await fetch('/api/contacts/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, method, date })
    });
    loadDashboard();
}

function confirmRemoveHistory(name, date, method) {
    const label = method.charAt(0).toUpperCase() + method.slice(1);
    pendingDelete = { type: 'contact-history', name, date, method };
    document.getElementById('modal-text').innerHTML = `Remove <b>${label}</b> with <b>${esc(name)}</b> on ${date}?`;
    document.getElementById('modal').classList.add('open');
}

async function removeContact(name) {
    if (!confirm(`Remove ${name}?`)) return;
    await fetch('/api/contacts/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    loadDashboard();
}
