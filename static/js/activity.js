// activity.js — activity calendar, run tracker

let _selectedActivityDate = null;
let _activityMonthOffset = 0;   // 0 = current month, -1 = last month, etc.

function activityMonthNav(delta) {
    const next = _activityMonthOffset + delta;
    if (next > 0) return;       // don't navigate into future months
    _activityMonthOffset = next;
    renderActivityCalendar();
}

function selectActivityDate(dateStr) {
    _selectedActivityDate = (dateStr === _selectedActivityDate || dateStr === todayStr()) ? null : dateStr;
    render();
}

function getActivityDate() {
    return _selectedActivityDate || todayStr();
}

function renderActivityCalendar() {
    const el = document.getElementById('activity-calendar');
    if (!el) return;
    try {

    // Merge all activity data into a date map: { "2026-03-24": ["run", "kitchen"] }
    const dateMap = {};
    function addEntry(date, type) {
        if (!dateMap[date]) dateMap[date] = [];
        if (!dateMap[date].includes(type)) dateMap[date].push(type);
    }
    (D.runs?.runs || []).forEach(r => addEntry(r.date, 'run'));
    (D.kitchen_trips || []).forEach(t => addEntry(t.date, 'kitchen'));
    (D.activity_log || []).forEach(e => addEntry(e.date, e.type));

    // Build month grid (offset lets you page back through months)
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth() + _activityMonthOffset, 1);
    const year = base.getFullYear();
    const month = base.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDow = (firstDay.getDay() + 6) % 7; // Mon=0
    const daysInMonth = lastDay.getDate();
    const today = todayStr();
    const monthLabel = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const navBtn = 'background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);cursor:pointer;font-size:14px;line-height:1;padding:2px 9px';
    let html = `<div class="section-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <button onclick="activityMonthNav(-1)" title="Previous month" style="${navBtn}">&#8249;</button>
        <span>${monthLabel}</span>
        <button onclick="activityMonthNav(1)" title="Next month" style="${navBtn}${_activityMonthOffset >= 0 ? 'visibility:hidden' : ''}">&#8250;</button>
    </div>`;
    html += '<div class="activity-cal"><table><thead><tr>';
    ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(d => { html += `<th>${d}</th>`; });
    html += '</tr></thead><tbody><tr>';

    // Leading empty cells
    for (let i = 0; i < startDow; i++) html += '<td class="empty-cell"></td>';

    let col = startDow;
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const isToday = dateStr === today;
        const isFuture = dateStr > today;
        const isPast = dateStr < today;
        const entries = dateMap[dateStr] || [];
        const isSelected = _selectedActivityDate ? dateStr === _selectedActivityDate : isToday;
        const selStyle = isSelected ? 'outline:2px solid var(--orange);outline-offset:-2px;border-radius:4px;' : '';
        const clickable = !isFuture ? `onclick="selectActivityDate('${dateStr}')" style="cursor:pointer;${selStyle}${isPast ? 'opacity:0.78;' : ''}"` : `style="opacity:0.4;${selStyle}"`;
        html += `<td class="${isToday ? 'today' : ''}" ${clickable}>`;
        html += `<div class="cal-day">${day}</div>`;
        if (entries.length) {
            const _typeMap = activityTypeMap();
            html += '<div class="cal-dots">';
            entries.forEach(type => {
                const info = _typeMap[type] || { label: type, color: '#999' };
                html += `<span class="cal-dot" style="background:${info.color}" title="${info.label} — ${dateStr}" onclick="confirmRemoveActivity('${dateStr}','${type}')"></span>`;
            });
            html += '</div>';
        }
        html += '</td>';
        col++;
        if (col === 7 && day < daysInMonth) { html += '</tr><tr>'; col = 0; }
    }
    // Trailing empty cells
    if (col > 0) { for (let i = col; i < 7; i++) html += '<td class="empty-cell"></td>'; }
    html += '</tr></tbody></table></div>';

    // Legend
    const _publicView = window.VIEW_MODE && window.VIEW_MODE !== 'authed';
    html += '<div class="activity-legend">';
    for (const [key, info] of Object.entries(activityTypeMap())) {
        if (_publicView && PRIVATE_ACT_TYPES.includes(key)) continue;
        html += `<span><span class="ldot" style="background:${info.color}"></span>${esc(info.label)}</span>`;
    }
    html += '</div>';

    // Stats row
    const runs = D.runs?.runs || [];
    const runTarget = D.runs?.target_per_week || 3;
    // This week's runs (Mon-Sun)
    const nowD = new Date();
    const dow = (nowD.getDay() + 6) % 7;
    const monDate = new Date(nowD); monDate.setDate(monDate.getDate() - dow);
    const monStr = `${monDate.getFullYear()}-${String(monDate.getMonth()+1).padStart(2,'0')}-${String(monDate.getDate()).padStart(2,'0')}`;
    const thisWeekRuns = runs.filter(r => r.date >= monStr && r.date <= today).length;

    html += '<div class="activity-stats">';
    html += `<div><span class="stat-val" style="color:var(--green)">${thisWeekRuns}</span><span style="color:var(--text-muted)">/${runTarget} runs this week</span></div>`;

    const trips = D.kitchen_trips || [];
    if (trips.length) {
        const lastTrip = new Date(trips[trips.length-1].date + 'T12:00:00');
        const daysAgo = Math.round((new Date().setHours(12,0,0,0) - lastTrip) / 86400000);
        html += `<div><span class="stat-val" style="color:#4A90D9">${daysAgo === 0 ? 'today' : daysAgo + 'd'}</span> <span style="color:var(--text-muted)">since groceries</span></div>`;
    }

    // Last sheets wash
    const allEntries = D.activity_log || [];
    const lastSheets = [...allEntries].reverse().find(e => e.type === 'laundry-sheets');
    if (lastSheets) {
        const dAgo = Math.round((new Date().setHours(12,0,0,0) - new Date(lastSheets.date + 'T12:00:00')) / 86400000);
        html += `<div><span class="stat-val" style="color:#E06060">${dAgo === 0 ? 'today' : dAgo + 'd'}</span> <span style="color:var(--text-muted)">since sheets</span></div>`;
    }
    html += '</div>';

    // Quick-log buttons
    const selDate = getActivityDate();
    const selLabel = selDate === today ? 'Today' : new Date(selDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:600;color:${selDate === today ? 'var(--text-secondary)' : 'var(--orange)'}">Log for: ${selLabel}</span>
        ${selDate !== today ? `<button onclick="_selectedActivityDate=null;render()" style="font-size:11px;background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;cursor:pointer;color:var(--text-muted)">Back to today</button>` : ''}
    </div>`;
    // Quick-log buttons. Run + Grocery keep their special subsystems (a form /
    // trip log); the rest are generated from the reminder registry + estradiol so
    // adding a reminder automatically gives it a log button here.
    html += '<div class="activity-btns">';
    html += `<button onclick="showRunForm()" style="border-color:var(--green);color:var(--green)">+ Run</button>`;
    html += `<button onclick="quickLogActivity('kitchen')" style="border-color:#4A90D9;color:#4A90D9">+ Grocery</button>`;
    for (const r of (D.reminders || [])) {
        const label = `${r.emoji ? r.emoji + ' ' : ''}${esc(r.label)}`;
        html += `<button onclick="quickLogActivity('${escJs(r.type)}')" style="border-color:${r.color || '#9AA0B5'};color:${r.color || '#9AA0B5'}">+ ${label}</button>`;
    }
    if (D.hrt && !isFrosted(D.hrt)) {
        html += `<button onclick="logHRT()" style="border-color:#E091C7;color:#E091C7">+ 💉 Estradiol</button>`;
    }
    html += '</div>';

    // Run form (hidden)
    html += `<div id="run-form" style="display:none;background:var(--card-bg);padding:16px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06);margin-bottom:16px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
            <div><label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Date</label>
                <input type="date" id="run-date" value="${todayStr()}" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px"></div>
            <div><label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Minutes</label>
                <input type="number" id="run-minutes" placeholder="30" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;width:80px"></div>
            <div><label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Notes</label>
                <input type="text" id="run-notes" placeholder="Easy pace, felt good..." style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:14px;width:200px"></div>
            <button class="submit-btn" onclick="logRun()" style="padding:7px 16px;font-size:13px;background:var(--green)">Save</button>
        </div>
    </div>`;

    // Recent runs (collapsible)
    const recent = [...runs].reverse().slice(0, 10);
    if (recent.length) {
        html += '<details class="card-section"><summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Recent runs</summary><div style="margin-top:8px">';
        recent.forEach(r => {
            const d = new Date(r.date + 'T12:00:00');
            const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            html += `<div class="run-log-item">
                <span style="min-width:100px;font-weight:600">${label}</span>
                ${r.minutes ? `<span>${r.minutes} min</span>` : ''}
                ${r.notes ? `<span style="color:var(--text-muted);flex:1">${esc(r.notes)}</span>` : ''}
                <button class="delete-btn" style="opacity:0.5" onclick="removeRun('${r.date}')" title="Remove">&times;</button>
            </div>`;
        });
        html += '</div></details>';
    }

    el.innerHTML = html;
    } catch(e) {
        el.innerHTML = `<div style="color:red;padding:12px;background:#fff0f0;border-radius:8px;margin:12px 0;font-size:13px"><b>Activity calendar error:</b> ${e.message}</div>`;
    }
}

function showRunForm() {
    const form = document.getElementById('run-form');
    if (form) form.style.display = form.style.display === 'none' ? '' : 'none';
}

async function logRun() {
    const date = document.getElementById('run-date').value;
    const minutes = parseInt(document.getElementById('run-minutes').value) || null;
    const notes = document.getElementById('run-notes').value.trim();
    await fetch('/api/runs/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, minutes, notes })
    });
    loadDashboard();
}

async function removeRun(date) {
    pendingDelete = { type: 'run', date };
    document.getElementById('modal-text').innerHTML = `Remove this run?`;
    document.getElementById('modal').querySelector('.confirm').textContent = 'Yes, remove';
    document.getElementById('modal').classList.add('open');
}

async function quickLogActivity(type) {
    const date = getActivityDate();
    if (type === 'kitchen') {
        await fetch('/api/kitchen/trips/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date })
        });
    } else {
        await fetch('/api/activity/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, type })
        });
        // A reminder may have a companion ("did you also …?"). If so it handles reload.
        if (typeof maybeCompanionPrompt === 'function' && maybeCompanionPrompt(type, date)) return;
    }
    loadDashboard();
}

function confirmRemoveActivity(date, type) {
    if (type === 'run') { removeRun(date); return; }
    if (type === 'kitchen') {
        pendingDelete = { type: 'kitchen-trip', date };
        document.getElementById('modal-text').innerHTML = `Remove kitchen trip on ${date}?`;
        document.getElementById('modal').querySelector('.confirm').textContent = 'Yes, remove';
        document.getElementById('modal').classList.add('open');
        return;
    }
    const info = activityTypeMap()[type] || { label: type };
    pendingDelete = { type: 'activity', date, actType: type };
    document.getElementById('modal-text').innerHTML = `Remove <b>${info.label}</b> on ${date}?`;
    document.getElementById('modal').querySelector('.confirm').textContent = 'Yes, remove';
    document.getElementById('modal').classList.add('open');
}
