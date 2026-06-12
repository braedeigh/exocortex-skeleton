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
// A reminder may set `times` (subset of morning/afternoon/evening): it then only
// pops on the To-Do page during those windows (empty = all day). `private` hides
// its activity type from the public/shared calendar.
//
// Day-counts come from activity_log (logged via /api/activity/log). Estradiol is
// now a normal reminder (type "estradiol") just like the rest — no special engine.

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
    // Per-reminder copy for the "it's due" line (overdue/future states keep their
    // own status wording). Empty → the generic default for the mode.
    const dueText = (r.due_text || '').trim();

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
            sub = overdue ? `Overdue since ${WEEKDAY_SHORT[last.getDay()]}` : (dueText || 'Due today');
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
        else if (due) { color = 'var(--orange)'; sub = dueText || 'Due now'; }
        else { const left = r.every_days - days; color = 'var(--ongoing)'; sub = `Due in ${left} day${left !== 1 ? 's' : ''}`; }
    } else {
        color = overdue ? 'var(--red)' : 'var(--orange)';
        sub = days === null ? 'Start tracking!' : overdue ? 'Overdue!' : (dueText || 'Time to change');
    }
    const pulse = overdue && r.mode === 'log' ? _REM_PULSE : '';
    return { show: true, color, sub, daysText, pulse };
}

// --- To-Do pops -----------------------------------------------------------
// Transient "just logged" state: after ✓ Done the bar becomes "logged · Undo"
// for a few seconds so a misclick can be caught, then quietly disappears.
// { [type]: { date } }
window._remRecent = window._remRecent || {};

function renderReminders() {
    const el = document.getElementById('linen-reminders');
    if (!el) return;

    const now = getTime();
    let html = '';
    for (const r of _reminderList()) {
        // Just logged → brief green "logged · Undo" confirmation (see logReminderDone).
        if (window._remRecent[r.type]) {
            const emoji = r.emoji ? `${r.emoji} ` : '';
            html += `<div class="hrt-bar" style="border-left-color:var(--green);background:var(--green);margin-bottom:12px">
                <div><div style="font-size:18px">&#10003; ${emoji}${esc(r.label)} logged</div></div>
                <button class="hrt-done-btn" onclick="undoReminderLog('${escJs(r.type)}')">Undo</button>
            </div>`;
            continue;
        }
        const s = _remCompute(r);
        if (!s.show) continue;
        // Time-of-day filter: a reminder with `times` only pops in those windows.
        // Skipped when "show hidden" is on so nothing is ever truly lost.
        if (!expandedAll && Array.isArray(r.times) && r.times.length && !r.times.includes(now)) continue;
        // Snoozed ("kick the can"): hidden until the date passes — but still
        // reachable under "Show hidden prompts", marked as snoozed.
        const snoozed = r.snoozed_until && r.snoozed_until > todayStr();
        if (snoozed && !expandedAll) continue;
        const emoji = r.emoji ? `${r.emoji} ` : '';
        const sub = snoozed ? `💤 snoozed — back ${_fmtAddedDate(r.snoozed_until)}` : s.sub;
        html += `<div class="hrt-bar" style="border-left-color:${s.color};background:${s.color};${s.pulse}margin-bottom:12px${snoozed ? ';opacity:0.6' : ''}">
            <div>
                <div style="font-size:18px">${emoji}${esc(r.label)} — ${s.daysText}</div>
                <div style="font-size:13px;opacity:0.8;font-weight:400;margin-top:2px">${sub}</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex:none">
                <button class="hrt-done-btn" onclick="showReminderSnoozeMenu(this,'${escJs(r.id || r.type)}',${snoozed ? 'true' : 'false'})" title="Remind me later" style="opacity:0.85;min-width:40px">&#128164;</button>
                <button class="hrt-done-btn" onclick="logReminderDone('${escJs(r.type)}',{daysAgo:1})" title="Log it for yesterday" style="opacity:0.85">Yesterday</button>
                <button class="hrt-done-btn" onclick="logReminderDone('${escJs(r.type)}')">&#10003; Done</button>
            </div>
        </div>`;
    }
    el.innerHTML = html;
}

// "Kick the can down the road" — small menu of snooze lengths on a pop bar.
function showReminderSnoozeMenu(btn, ident, isSnoozed) {
    document.querySelectorAll('.move-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'move-menu';
    menu.style.cssText = 'position:absolute;right:0;top:100%;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.12);z-index:100;min-width:170px;padding:4px 0;font-size:13px;color:var(--text)';
    const lbl = document.createElement('div');
    lbl.textContent = 'Remind me again in';
    lbl.style.cssText = 'padding:4px 14px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted)';
    menu.appendChild(lbl);
    const opts = [['3 days', 3], ['1 week', 7], ['2 weeks', 14]];
    if (isSnoozed) opts.push(['Un-snooze now', 0]);
    opts.forEach(([label, days]) => {
        const opt = document.createElement('div');
        opt.textContent = days ? `💤 ${label}` : `↩ ${label}`;
        opt.style.cssText = 'padding:9px 14px;cursor:pointer;color:var(--text)';
        opt.onmouseenter = () => opt.style.background = 'var(--bg)';
        opt.onmouseleave = () => opt.style.background = 'none';
        opt.onclick = () => { menu.remove(); snoozeReminder(ident, days); };
        menu.appendChild(opt);
    });
    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(menu);
    setTimeout(() => document.addEventListener('click', function close(e) {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
    }), 0);
}

async function snoozeReminder(ident, days) {
    await fetch('/api/reminders/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ident, days })
    });
    loadDashboard();
}

// Log a reminder. opts.daysAgo backdates (e.g. {daysAgo:1} = yesterday, for a
// shot done/logged past midnight). Leaves a brief undo affordance.
async function logReminderDone(type, opts) {
    opts = opts || {};
    let date = todayStr();
    if (opts.daysAgo) {
        const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - opts.daysAgo);
        date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    await fetch('/api/activity/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, type })
    });
    // Keep the bar visible as "logged · Undo" for ~6s, then clear it.
    window._remRecent[type] = { date };
    setTimeout(() => { delete window._remRecent[type]; renderReminders(); }, 6000);
    // Prompt for a companion before reloading, if any (and not already done today).
    if (!maybeCompanionPrompt(type, date)) loadDashboard();
}

// Undo the most recent log for a reminder (removes the activity_log entry).
async function undoReminderLog(type) {
    const rec = window._remRecent[type];
    delete window._remRecent[type];
    if (rec) {
        await fetch('/api/activity/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: rec.date, type })
        });
    }
    loadDashboard();
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
    // The trigger now lives on the Activity card title line; the panel opens in
    // the shared editor modal.
    const el = document.getElementById('reminder-manager');
    if (el) el.innerHTML = '';
    if (window._remMgrOpen) showEditorModal('Manage reminders', reminderManagerPanelHtml());
}

function reminderManagerPanelHtml() {
    // Seed the draft from live data the first time the panel opens (or after a save).
    if (!window._remindersDraft) {
        window._remindersDraft = _reminderList().map(r => ({
            id: r.id, emoji: r.emoji || '', label: r.label || '', type: r.type || '',
            color: r.color || '#9AA0B5', shape: r.shape || 'circle', schedule: r.schedule || 'interval',
            every_days: r.every_days, overdue_days: r.overdue_days,
            weekdays: Array.isArray(r.weekdays) ? r.weekdays.slice() : [],
            mode: r.mode || 'log', companion: r.companion || '',
            times: Array.isArray(r.times) ? r.times.slice() : [],
            private: !!r.private, due_text: r.due_text || '',
        }));
    }

    const numInp = 'padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box;width:52px;text-align:center';

    let html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
            These drive the calendar dots, the quick-log buttons above, and the pops on your To-Do page.
            <b>tap-to-log</b> pops when due · <b>countdown</b> always shows time left · <b>track</b> just logs (no pop).
        </div>`;

    // Save/Cancel mirrored top + bottom so she can click whichever's closer.
    const actions = `<div style="display:flex;gap:8px;justify-content:flex-end">
            <button onclick="_remCancel()" style="padding:8px 16px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;cursor:pointer">Cancel</button>
            <button onclick="saveReminders()" style="padding:8px 16px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600">Save changes</button>
        </div>`;
    html += `<div style="margin-bottom:14px">${actions}</div>`;

    html += `<div id="reminder-manager-rows">${_remDraftRowsHtml(numInp)}</div>`;
    html += `<button onclick="_remAdd()" style="padding:7px 14px;border-radius:6px;border:1px dashed var(--border);background:none;color:var(--text-muted);cursor:pointer;font-size:13px;margin-top:4px">+ Add reminder</button>`;
    html += `<div style="margin-top:14px">${actions}</div>`;
    return html;
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
                    [0, 1, 2, 3, 4, 5, 6].map(d => `<button onclick="_remToggleWeekday(${i},${d})" title="${WEEKDAY_FULL[d]}" style="width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:12px;${wd.includes(d)
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

        // Per-reminder wording for the "it's due" line (track never pops → hidden).
        const dueWording = isTrack ? '' : `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--text-muted);margin-top:8px">
            <span>when due, say</span>
            <input value="${esc(r.due_text || '')}" oninput="_remField(${i},'due_text',this.value)" placeholder="Due today" maxlength="60" style="${inp};flex:1;min-width:140px">
        </div>`;

        // Time-of-day: which windows it pops on the To-Do page (none = all day).
        // Irrelevant for track-only (never pops), so hidden there.
        const tlist = Array.isArray(r.times) ? r.times : [];
        const timeOpts = [['morning', 'Morning'], ['afternoon', 'Midday'], ['evening', 'Evening']];
        const timeRow = isTrack ? '' : `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--text-muted);margin-top:8px">
            <span>show on To-Do</span>
            <span style="display:flex;gap:4px">${timeOpts.map(([v, lbl]) => chip(`_remToggleTime(${i},'${v}')`, lbl, tlist.includes(v))).join('')}</span>
            <span style="font-size:12px;opacity:0.7">${tlist.length ? '' : '(all day)'}</span>
        </div>`;

        // Privacy: hide this activity type from the public/shared calendar.
        const privacy = `<label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--text-muted);margin-top:8px;cursor:pointer">
            <input type="checkbox" ${r.private ? 'checked' : ''} onchange="_remField(${i},'private',this.checked)" style="width:16px;height:16px;flex:none">
            private — hidden on the public calendar
        </label>`;

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
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--text-muted);margin-top:8px">
                <span title="Shape groups a family of rituals (meds, linens, body…); color names the individual">calendar shape</span>
                <span style="display:flex;gap:4px">
                    ${chip(`_remSetShape(${i},'circle')`, '●', (r.shape || 'circle') === 'circle')}
                    ${chip(`_remSetShape(${i},'square')`, '■', r.shape === 'square')}
                    ${chip(`_remSetShape(${i},'diamond')`, '◆', r.shape === 'diamond')}
                    ${chip(`_remSetShape(${i},'triangle')`, '▲', r.shape === 'triangle')}
                    ${chip(`_remSetShape(${i},'ring')`, '○', r.shape === 'ring')}
                </span>
            </div>
            ${cadence}
            ${dueWording}
            ${timeRow}
            ${companion}
            ${privacy}
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
    if (window._remMgrOpen) {
        // Only one editor modal at a time.
        if (typeof _habitTrackerEditing !== 'undefined') _habitTrackerEditing = false;
        window._contactsManageOpen = false;
        if (typeof renderHabitTracker === 'function') renderHabitTracker();
        if (typeof renderContacts === 'function') renderContacts();
    } else {
        hideEditorModal();
    }
    renderReminderManager();
}

function _remCancel() {
    window._remMgrOpen = false;
    window._remindersDraft = null;
    hideEditorModal();
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

function _remSetShape(i, shape) {
    const a = window._remindersDraft;
    if (!a || !a[i]) return;
    a[i].shape = shape;
    _remRerenderRows();
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

function _remToggleTime(i, t) {
    const a = window._remindersDraft;
    if (!a || !a[i]) return;
    const ts = a[i].times = a[i].times || [];
    const idx = ts.indexOf(t);
    if (idx === -1) ts.push(t); else ts.splice(idx, 1);
    const order = ['morning', 'afternoon', 'evening'];
    a[i].times = order.filter(x => ts.includes(x));
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
        id: '', emoji: '', label: '', type: '', color: '#9AA0B5', shape: 'circle', schedule: 'interval',
        every_days: 3, overdue_days: 7, weekdays: [], mode: 'log', companion: '',
        times: [], private: false, due_text: '',
    });
    _remRerenderRows();
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
            shape: r.shape || 'circle',
            schedule: r.schedule === 'weekly' ? 'weekly' : 'interval',
            every_days: Number(r.every_days) || 1,
            overdue_days: Number(r.overdue_days) || 1,
            weekdays: Array.isArray(r.weekdays) ? r.weekdays : [],
            mode: ['log', 'countdown', 'track'].includes(r.mode) ? r.mode : 'log',
            companion: (r.companion || '').trim(),
            times: Array.isArray(r.times) ? r.times : [],
            private: !!r.private,
            due_text: (r.due_text || '').trim(),
        }));
    const res = await fetch('/api/reminders/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminders: rows }),
    });
    if (res.ok) {
        window._remMgrOpen = false;     // leave edit mode
        window._remindersDraft = null;  // re-seed from fresh data on next open
        hideEditorModal();
        await loadDashboard();
    } else {
        alert('Save failed.');
    }
}
