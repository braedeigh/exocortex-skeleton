// reminders.js — the single registry (data/reminders.json → D.reminders) that
// drives: the To-Do "pops", the Life Map calendar legend/dots/quick-log buttons
// (see activityTypeMap() in core.js + activity.js), and the manager panel under
// the calendar.
//
// Modes:
//   "log"       — pops on To-Do when due; ✓ Done logs + resets (chore/dose)
//   "countdown" — always pops on To-Do showing time until due; ✓ Done resets
//   "track"     — never pops; just lives on the calendar (dot + quick-log button)
//
// Schedule (for log/countdown):
//   "interval" — due every N days since last logged (overdue after M days)
//   "weekly"   — due on specific weekdays; overdue if a scheduled day passed unlogged
//
// A reminder may also have a `companion` (another reminder's type): logging it
// pops a "did you also …?" prompt for the companion (e.g. sheets → eye masks).
//
// Day-counts come from activity_log (logged via /api/activity/log). Estradiol
// keeps its own richer HRT engine (exact dates + undo) while still appearing here.

const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const _REM_PULSE = 'animation: hrt-pulse 2s ease-in-out infinite;';

function _reminderList() {
    return (D && D.reminders) || [];
}

function _remActivityEntries() {
    return (D && D.activity_log) || [];
}

function _remDaysSince(type) {
    const last = _remActivityEntries().filter(e => e.type === type).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!last) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(last.date + 'T00:00:00'); d.setHours(0, 0, 0, 0);
    return Math.floor((today - d) / 86400000);
}

function _remMidnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function _remFmt(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function _remShift(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function _remLastScheduled(weekdays, ref) {
    for (let i = 0; i < 7; i++) { const d = _remShift(ref, -i); if (weekdays.includes(d.getDay())) return d; }
    return null;
}
function _remNextScheduled(weekdays, ref) {
    for (let i = 0; i < 7; i++) { const d = _remShift(ref, i); if (weekdays.includes(d.getDay())) return d; }
    return null;
}

// Compute display state for a reminder's To-Do pop. Returns {show:false} to hide.
function _remCompute(r) {
    if (r.mode === 'track') return { show: false };

    const days = _remDaysSince(r.type);
    const daysText = days === null ? 'never logged' : days === 0 ? 'today' : `${days} day${days !== 1 ? 's' : ''} ago`;
    const schedule = r.schedule || 'interval';

    if (schedule === 'weekly') {
        const weekdays = r.weekdays || [];
        if (!weekdays.length) return { show: false };
        const today = _remMidnight();
        const last = _remLastScheduled(weekdays, today);
        const lastStr = _remFmt(last);
        const loggedSince = _remActivityEntries().some(e => e.type === r.type && e.date >= lastStr);
        const due = !loggedSince;
        const isToday = lastStr === _remFmt(today);
        const overdue = due && !isToday;

        if (r.mode === 'log' && !due) return { show: false };

        let color, sub;
        if (r.mode === 'countdown' && !due) {
            const next = _remNextScheduled(weekdays, _remShift(today, 1));
            color = 'var(--ongoing)';
            sub = next ? `Next ${WEEKDAY_SHORT[next.getDay()]}` : 'Scheduled';
        } else {
            color = overdue ? 'var(--red)' : 'var(--orange)';
            sub = overdue ? `Overdue since ${WEEKDAY_SHORT[last.getDay()]}` : 'Due today';
        }
        const pulse = overdue && r.mode === 'log' ? _REM_PULSE : '';
        return { show: true, color, sub, daysText, pulse };
    }

    // interval
    const due = days === null || days >= r.every_days;
    const overdue = days === null || days >= r.overdue_days;
    if (r.mode === 'log' && !due) return { show: false };

    let color, sub;
    if (r.mode === 'countdown') {
        if (overdue) { color = 'var(--red)'; sub = 'Overdue'; }
        else if (due) { color = 'var(--orange)'; sub = 'Due now'; }
        else { const left = r.every_days - days; color = 'var(--ongoing)'; sub = `Due in ${left} day${left !== 1 ? 's' : ''}`; }
    } else {
        color = overdue ? 'var(--red)' : 'var(--orange)';
        sub = days === null ? 'Start tracking!' : overdue ? 'Overdue!' : 'Time to change';
    }
    const pulse = overdue && r.mode === 'log' ? _REM_PULSE : '';
    return { show: true, color, sub, daysText, pulse };
}

// --- To-Do pops -----------------------------------------------------------
function renderReminders() {
    const el = document.getElementById('linen-reminders');
    if (!el) return;

    let html = '';
    for (const r of _reminderList()) {
        const s = _remCompute(r);
        if (!s.show) continue;
        const emoji = r.emoji ? `${r.emoji} ` : '';
        html += `<div class="hrt-bar" style="border-left-color:${s.color};background:${s.color};${s.pulse}margin-bottom:12px">
            <div>
                <div style="font-size:18px">${emoji}${esc(r.label)} — ${s.daysText}</div>
                <div style="font-size:13px;opacity:0.8;font-weight:400;margin-top:2px">${s.sub}</div>
            </div>
            <button class="hrt-done-btn" onclick="logReminderDone('${escJs(r.type)}')">&#10003; Done</button>
        </div>`;
    }
    el.innerHTML = html;
}

async function logReminderDone(type) {
    const date = todayStr();
    await fetch('/api/activity/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, type })
    });
    // Prompt for a companion before reloading, if any (and not already done today).
    if (!maybeCompanionPrompt(type, date)) loadDashboard();
}

// =========================================================================
// Companion prompt — logging reminder A asks "did you also …?" for its pair.
// Returns true if a prompt was shown (caller then skips its own reload).
// =========================================================================
function maybeCompanionPrompt(loggedType, date) {
    const src = _reminderList().find(r => r.type === loggedType);
    if (!src || !src.companion) return false;
    const comp = _reminderList().find(r => r.type === src.companion);
    if (!comp) return false;
    // Skip if the companion is already logged on this date.
    if (_remActivityEntries().some(e => e.type === comp.type && e.date === date)) return false;

    window._companionPending = { type: comp.type, date };
    const txt = document.getElementById('companion-modal-text');
    if (txt) {
        const srcLabel = `${src.emoji ? src.emoji + ' ' : ''}${esc(src.label)}`;
        const compLabel = `${comp.emoji ? comp.emoji + ' ' : ''}${esc(comp.label)}`;
        txt.innerHTML = `Logged <b>${srcLabel}</b>. Did you also do <b>${compLabel}</b>?`;
    }
    document.getElementById('companion-modal').classList.add('open');
    return true;
}

async function companionYes() {
    const p = window._companionPending;
    document.getElementById('companion-modal').classList.remove('open');
    window._companionPending = null;
    if (p) {
        await fetch('/api/activity/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: p.date, type: p.type })
        });
    }
    loadDashboard();
}

function companionNo() {
    document.getElementById('companion-modal').classList.remove('open');
    window._companionPending = null;
    loadDashboard();
}

// =========================================================================
// Manager — inline collapsible panel under the calendar on Life Map.
// Edits a working draft; "Save" commits the whole registry at once.
// =========================================================================
function renderReminderManager() {
    const el = document.getElementById('reminder-manager');
    if (!el) return;

    if (!window._remMgrOpen) {
        el.innerHTML = `<button onclick="toggleReminderManager()" style="background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px">&#9881; Manage reminders</button>`;
        return;
    }

    // Seed the draft from live data the first time the panel opens (or after a save).
    if (!window._remindersDraft) {
        window._remindersDraft = _reminderList().map(r => ({
            id: r.id, emoji: r.emoji || '', label: r.label || '', type: r.type || '',
            color: r.color || '#9AA0B5', schedule: r.schedule || 'interval',
            every_days: r.every_days, overdue_days: r.overdue_days,
            weekdays: Array.isArray(r.weekdays) ? r.weekdays.slice() : [],
            mode: r.mode || 'log', companion: r.companion || '',
        }));
    }

    const numInp = 'padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box;width:52px;text-align:center';

    let html = `<div style="border:1px solid var(--border);border-radius:10px;padding:14px;background:var(--bg-card)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <b style="font-size:15px;color:var(--text)">Recurring reminders</b>
            <button onclick="toggleReminderManager()" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;line-height:1">&times;</button>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
            These drive the calendar dots, the quick-log buttons above, and the pops on your To-Do page.
            <b>tap-to-log</b> pops when due · <b>countdown</b> always shows time left · <b>track</b> just logs (no pop).
        </div>`;

    // Save/Cancel mirrored top + bottom so she can click whichever's closer.
    const actions = `<div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="_remCancel()" style="padding:8px 16px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;cursor:pointer">Cancel</button>
            <button onclick="saveReminders()" style="padding:8px 16px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600">Save changes</button>
        </div>`;
    html += `<div style="margin-bottom:14px">${actions}</div>`;

    // Estradiol: special row backed by the HRT engine (exact dates + undo kept).
    html += _remEstradiolRow(numInp);

    html += `<div id="reminder-manager-rows">${_remDraftRowsHtml(numInp)}</div>`;
    html += `<button onclick="_remAdd()" style="padding:7px 14px;border-radius:6px;border:1px dashed var(--border);background:none;color:var(--text-muted);cursor:pointer;font-size:13px;margin-top:4px">+ Add reminder</button>`;
    html += `<div style="margin-top:14px">${actions}</div>`;
    html += `</div>`;
    el.innerHTML = html;
}

function _remEstradiolRow(numInp) {
    const h = (D && D.hrt) || null;
    if (!h || isFrosted(h) || h.cycle_days === undefined) return '';
    const next = h.next_formatted ? ` · next: ${esc(h.next_formatted)}` : '';
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:rgba(224,145,199,0.08)">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span style="font-size:16px">💉</span>
            <b style="color:var(--text)">Estradiol</b>
            <span style="font-size:12px;color:var(--text-muted)">injection · every</span>
            <input type="number" min="1" value="${esc(h.cycle_days)}" onchange="_remSaveEstradiolCycle(this.value)" style="${numInp}">
            <span style="font-size:12px;color:var(--text-muted)">days${next}</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Exact next-dose date + undo are kept — log it from the To-Do shot bar or the + Estradiol button.</div>
    </div>`;
}

function _remDraftRowsHtml(numInp) {
    const rows = window._remindersDraft || [];
    if (!rows.length) {
        return `<div style="color:var(--text-muted);font-style:italic;padding:10px 0">No reminders yet. Add one below.</div>`;
    }
    const inp = 'padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box';
    const chip = (onclick, label, active) =>
        `<button onclick="${onclick}" style="padding:4px 9px;border-radius:12px;cursor:pointer;font-size:12px;${active
            ? 'background:rgba(124,92,191,0.18);border:1px solid var(--accent);color:var(--accent);font-weight:700'
            : 'background:none;border:1px solid var(--border);color:var(--text-muted)'}">${label}</button>`;

    return rows.map((r, i) => {
        const isTrack = r.mode === 'track';
        const schedule = r.schedule || 'interval';

        // Cadence controls (hidden for track-only)
        let cadence = '';
        if (!isTrack) {
            const schedChips = `<span style="display:flex;gap:4px;margin-left:auto">
                ${chip(`_remSetSchedule(${i},'interval')`, 'every N days', schedule !== 'weekly')}
                ${chip(`_remSetSchedule(${i},'weekly')`, 'days of week', schedule === 'weekly')}
            </span>`;
            let detail;
            if (schedule === 'weekly') {
                const wd = r.weekdays || [];
                detail = `<span style="display:flex;gap:3px;flex-wrap:wrap;align-items:center">` +
                    [0, 1, 2, 3, 4, 5, 6].map(d => `<button onclick="_remToggleWeekday(${i},${d})" title="${WEEKDAY_FULL[d]}" style="width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:11px;${wd.includes(d)
                        ? 'background:rgba(124,92,191,0.18);border:1px solid var(--accent);color:var(--accent);font-weight:700'
                        : 'background:none;border:1px solid var(--border);color:var(--text-muted)'}">${WEEKDAY_LETTER[d]}</button>`).join('') +
                    `</span>`;
            } else {
                detail = `<span>every</span>
                    <input type="number" min="1" value="${esc(r.every_days)}" oninput="_remField(${i},'every_days',this.value)" style="${numInp}">
                    <span>d · overdue after</span>
                    <input type="number" min="1" value="${esc(r.overdue_days)}" oninput="_remField(${i},'overdue_days',this.value)" style="${numInp}">
                    <span>d</span>`;
            }
            cadence = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--text-muted);margin-top:8px">${detail}${schedChips}</div>`;
        }

        // Companion selector — any OTHER reminder
        const others = rows.filter((_, j) => j !== i);
        const compOpts = `<option value=""${!r.companion ? ' selected' : ''}>— none —</option>` +
            others.map(o => `<option value="${esc(o.type || '')}"${r.companion && r.companion === o.type ? ' selected' : ''}>${esc((o.emoji ? o.emoji + ' ' : '') + (o.label || o.type || ''))}</option>`).join('');
        const companion = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--text-muted);margin-top:8px">
            <span>after logging, also ask about</span>
            <select onchange="_remField(${i},'companion',this.value)" style="${inp};max-width:200px">${compOpts}</select>
        </div>`;

        return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--bg)">
            <div style="display:flex;gap:6px;align-items:center">
                <input value="${esc(r.emoji)}" oninput="_remField(${i},'emoji',this.value)" placeholder="🛏" maxlength="4" style="${inp};width:46px;text-align:center;font-size:16px">
                <input value="${esc(r.label)}" oninput="_remField(${i},'label',this.value)" placeholder="What to track" style="${inp};flex:1">
                <input type="color" value="${esc(r.color || '#9AA0B5')}" oninput="_remField(${i},'color',this.value)" title="Calendar color" style="width:34px;height:32px;padding:0;border:1px solid var(--border);border-radius:6px;background:none;cursor:pointer;flex:none">
                <button onclick="_remDel(${i})" title="Remove" style="background:none;border:1px solid var(--border);color:var(--negative,#c0506a);border-radius:6px;width:30px;height:30px;cursor:pointer;flex:none;font-size:15px">&times;</button>
            </div>
            <div style="display:flex;gap:4px;margin-top:8px">
                ${chip(`_remSetMode(${i},'log')`, '✓ tap-to-log', r.mode === 'log')}
                ${chip(`_remSetMode(${i},'countdown')`, 'countdown', r.mode === 'countdown')}
                ${chip(`_remSetMode(${i},'track')`, 'track', r.mode === 'track')}
            </div>
            ${cadence}
            ${companion}
        </div>`;
    }).join('');
}

// Re-render only the rows container (keeps the rest of the panel stable).
function _remRerenderRows() {
    const c = document.getElementById('reminder-manager-rows');
    const numInp = 'padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box;width:52px;text-align:center';
    if (c) c.innerHTML = _remDraftRowsHtml(numInp);
}

function toggleReminderManager() {
    window._remMgrOpen = !window._remMgrOpen;
    window._remindersDraft = null;  // re-seed from live data on next open
    renderReminderManager();
}

function _remCancel() {
    window._remMgrOpen = false;
    window._remindersDraft = null;
    renderReminderManager();
}

function _remField(i, field, value) {
    const a = window._remindersDraft;
    if (!a || !a[i]) return;
    if (field === 'every_days' || field === 'overdue_days') {
        a[i][field] = value === '' ? '' : Number(value);  // no re-render → keep focus
    } else if (field === 'companion') {
        a[i][field] = value;  // <select> change is fine to not re-render
    } else {
        a[i][field] = value;
    }
}

function _remSetMode(i, mode) {
    const a = window._remindersDraft;
    if (a && a[i]) { a[i].mode = mode; _remRerenderRows(); }
}

function _remSetSchedule(i, schedule) {
    const a = window._remindersDraft;
    if (a && a[i]) { a[i].schedule = schedule; _remRerenderRows(); }
}

function _remToggleWeekday(i, day) {
    const a = window._remindersDraft;
    if (!a || !a[i]) return;
    const wd = a[i].weekdays = a[i].weekdays || [];
    const idx = wd.indexOf(day);
    if (idx === -1) wd.push(day); else wd.splice(idx, 1);
    wd.sort((x, y) => x - y);
    _remRerenderRows();
}

function _remDel(i) {
    const a = window._remindersDraft;
    if (!a) return;
    a.splice(i, 1);
    _remRerenderRows();
}

function _remAdd() {
    (window._remindersDraft = window._remindersDraft || []).push({
        id: '', emoji: '', label: '', type: '', color: '#9AA0B5', schedule: 'interval',
        every_days: 3, overdue_days: 7, weekdays: [], mode: 'log', companion: '',
    });
    _remRerenderRows();
}

async function _remSaveEstradiolCycle(value) {
    const cycle = Number(value);
    if (!cycle || cycle < 1) return;
    await fetch('/api/hrt/cycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cycle_days: cycle }),
    });
    loadDashboard();
}

async function saveReminders() {
    const rows = (window._remindersDraft || [])
        .filter(r => (r.label || '').trim())
        .map(r => ({
            id: r.id || undefined,
            emoji: (r.emoji || '').trim(),
            label: (r.label || '').trim(),
            type: (r.type || '').trim() || undefined,
            color: (r.color || '').trim() || undefined,
            schedule: r.schedule === 'weekly' ? 'weekly' : 'interval',
            every_days: Number(r.every_days) || 1,
            overdue_days: Number(r.overdue_days) || 1,
            weekdays: Array.isArray(r.weekdays) ? r.weekdays : [],
            mode: ['log', 'countdown', 'track'].includes(r.mode) ? r.mode : 'log',
            companion: (r.companion || '').trim(),
        }));
    const res = await fetch('/api/reminders/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminders: rows }),
    });
    if (res.ok) {
        window._remMgrOpen = false;     // leave edit mode, collapse back to the button
        window._remindersDraft = null;  // re-seed from fresh data on next open
        await loadDashboard();
    } else {
        alert('Save failed.');
    }
}
