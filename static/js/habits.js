// habits.js — habit cards, habit tracker grid

// --- Cadence ladder (daily → weekly → monthly → retired) ---
// A proven daily habit graduates to occasional spot-checks. Promotion is
// suggested (badge → tap); demotion is automatic server-side. State lives in
// D.habit_cadence keyed by 'section|text'; a plain daily habit has NO entry.

function habitCadence(section, item) {
    return (D.habit_cadence || {})[habitKey(section, item)] || null;
}
function isGraduated(c) { return !!c && (c.stage === 'weekly' || c.stage === 'monthly'); }

// Completions in the last `days` days — the "still consistent NOW" graduation gate,
// so a long-dormant habit's stale lifetime count can't keep re-suggesting itself.
function recentHabitDone(section, item, days) {
    const key = habitKey(section, item);
    const log = D.habits_log || {};
    const now = new Date();
    let n = 0;
    for (let i = 0; i < days; i++) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        if ((log[ds] || {})[key]) n++;
    }
    return n;
}

// A plain daily habit that's proven AND still consistent → offer graduation.
function readyToGraduate(section, item) {
    if (habitCadence(section, item)) return false;          // already on the ladder
    if (habitMeta(section, item)) return false;             // temporary/course habits don't graduate
    const cfg = D.cadence_config || {};
    const need = cfg.graduate_count || 60;
    const [rn, rd] = cfg.graduate_recent || [24, 30];
    return habitCount(item, section) >= need && recentHabitDone(section, item, rd) >= rn;
}

// A graduated habit that's passed enough spot-checks → offer the next rung.
function readyToPromote(c) {
    const cfg = D.cadence_config || {};
    if (c.stage === 'weekly')  return (c.passes || 0) >= (cfg.weekly_to_monthly || 4);
    if (c.stage === 'monthly') return (c.passes || 0) >= (cfg.monthly_to_retire || 3);
    return false;
}

// Passes needed at the current stage (for the "2/4 → monthly" progress label).
function promoteTarget(c) {
    const cfg = D.cadence_config || {};
    if (c.stage === 'weekly')  return cfg.weekly_to_monthly || 4;
    if (c.stage === 'monthly') return cfg.monthly_to_retire || 3;
    return 0;
}

// Is a graduated habit's spot-check open today? (check day + grace window).
function spotCheckDue(section, item) {
    const c = habitCadence(section, item);
    if (!isGraduated(c) || !c.next_check) return false;
    const t = todayStr();
    if (t < c.next_check) return false;
    const grace = (D.cadence_config || {}).grace_days ?? 1;
    const gap = Math.round((new Date(t + 'T12:00:00') - new Date(c.next_check + 'T12:00:00')) / 86400000);
    return gap <= grace;
}

// Should this habit appear in today's daily card? Plain daily → always;
// graduated → only on its open spot-check day; retired → never.
function showsInDaily(section, item) {
    const ci = courseInfo(section, item);
    if (ci && ci.expired) return false;                     // finished course → off the daily list
    const c = habitCadence(section, item);
    if (!c) return true;
    if (c.stage === 'retired') return false;
    return spotCheckDue(section, item);
}

// --- Course habits (time-limited, e.g. a 10-day antibiotic) ---
function habitMeta(section, item) {
    return (D.habit_meta || {})[habitKey(section, item)] || null;
}
function courseInfo(section, item) {
    const m = habitMeta(section, item);
    if (!m || !m.course_days) return null;
    const start = new Date(m.course_start + 'T12:00:00');
    const dayNum = Math.floor((new Date(todayStr() + 'T12:00:00') - start) / 86400000) + 1;
    return { start: m.course_start, days: m.course_days, dayNum, expired: dayNum > m.course_days };
}

// Actual HABITS.md section names for the Morning/Midday/Evening slots.
function habitSectionDefs() {
    let m = 'Morning', mid = 'Midday', n = 'Evening / Night';
    for (const s of (D.habits || [])) {
        const x = s.name.toLowerCase();
        if (x === 'morning') m = s.name;
        else if (x === 'midday') mid = s.name;
        else if (x === 'night' || x === 'evening / night') n = s.name;
    }
    return [{ label: 'Morning', name: m }, { label: 'Midday', name: mid }, { label: 'Evening', name: n }];
}
function _habitSectionsOf(item) {
    return (D.habits || []).filter(s => (s.items || []).includes(item)).map(s => s.name);
}

function openHabitConfigNew() { _openHabitConfig({ name: '', sections: [], courseDays: 0, isEdit: false }); }
function openHabitConfig(section, item) {
    const m = habitMeta(section, item);
    _openHabitConfig({ name: item, sections: _habitSectionsOf(item), courseDays: (m && m.course_days) || 0, isEdit: true });
}
function _openHabitConfig(o) {
    const inp = 'padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:15px';
    const checks = habitSectionDefs().map(s => `<label style="display:inline-flex;align-items:center;gap:7px;min-height:40px;margin-right:16px;font-size:15px;cursor:pointer">
        <input type="checkbox" class="hc-section" value="${esc(s.name)}" ${o.sections.includes(s.name) ? 'checked' : ''} style="width:20px;height:20px;cursor:pointer"> ${s.label}
    </label>`).join('');
    const on = o.courseDays > 0;
    const body = `<div class="habit-config" data-original="${esc(o.name)}">
        <div class="tm-field">
            <label class="todo-modal-label">Name</label>
            <input id="hc-name" type="text" value="${esc(o.name)}" placeholder="e.g. Doxycycline" ${o.isEdit ? 'readonly' : ''} style="${inp};width:100%${o.isEdit ? ';opacity:0.7' : ''}">
        </div>
        <div class="tm-field">
            <label class="todo-modal-label">Time of day</label>
            <div style="margin-top:4px">${checks}</div>
        </div>
        <div class="tm-field">
            <label style="display:flex;align-items:center;gap:8px;min-height:40px;cursor:pointer">
                <input id="hc-course-on" type="checkbox" ${on ? 'checked' : ''} onchange="hcToggleCourse()" style="width:20px;height:20px;cursor:pointer">
                <span class="todo-modal-label" style="margin:0">Temporary course — auto-archives when it ends</span>
            </label>
            <div id="hc-course-fields" style="display:${on ? 'flex' : 'none'};align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
                <span style="font-size:15px">Length</span>
                <input id="hc-course-days" type="number" min="1" value="${o.courseDays || 10}" oninput="hcUpdateEnd()" style="${inp};width:72px">
                <span style="font-size:15px">days</span>
                <span id="hc-course-end" style="color:var(--text-muted);font-size:13px"></span>
            </div>
        </div>
        <div class="todo-modal-foot">
            ${o.isEdit ? `<button type="button" class="todo-modal-delete" onclick="hcDelete()">Delete</button>` : '<span></span>'}
            <button type="button" class="todo-desc-editbtn" onclick="saveHabitConfig()">Save</button>
        </div>
    </div>`;
    showEditorModal(o.isEdit ? 'Edit habit' : 'New habit', body);
    hcUpdateEnd();
}
function hcToggleCourse() {
    const on = document.getElementById('hc-course-on').checked;
    document.getElementById('hc-course-fields').style.display = on ? 'flex' : 'none';
    hcUpdateEnd();
}
function hcUpdateEnd() {
    const el = document.getElementById('hc-course-end');
    if (!el) return;
    const on = document.getElementById('hc-course-on') && document.getElementById('hc-course-on').checked;
    const days = parseInt(document.getElementById('hc-course-days') && document.getElementById('hc-course-days').value, 10);
    if (!on || !days || days < 1) { el.textContent = ''; return; }
    const end = new Date(todayStr() + 'T12:00:00'); end.setDate(end.getDate() + days - 1);
    el.textContent = '→ ends ' + end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
async function saveHabitConfig() {
    const root = document.querySelector('.habit-config');
    if (!root) return;
    const name = document.getElementById('hc-name').value.trim();
    if (!name) { alert('Give it a name'); return; }
    const sections = [...root.querySelectorAll('.hc-section:checked')].map(c => c.value);
    if (!sections.length) { alert('Pick at least one time of day'); return; }
    const courseOn = document.getElementById('hc-course-on').checked;
    const courseDays = courseOn ? (parseInt(document.getElementById('hc-course-days').value, 10) || 0) : 0;
    const res = await fetch('/api/habits/configure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sections, course_days: courseDays })
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Failed to save'); return; }
    hideEditorModal();
    loadDashboard();
}
async function hcDelete() {
    const root = document.querySelector('.habit-config');
    const name = root && root.dataset.original;
    if (!name) return;
    if (!confirm(`Remove "${name}" from all habit sections? Its history stays.`)) return;
    await fetch('/api/habits/configure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, remove: true })
    });
    hideEditorModal();
    loadDashboard();
}

const STAGE_NEXT_LABEL = { weekly: 'monthly', monthly: 'retire' };

async function graduateHabit(section, item) {
    await fetch('/api/habits/cadence/promote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit: item, section })
    });
    loadDashboard();
}
async function restoreHabitCadence(section, item) {
    await fetch('/api/habits/cadence/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit: item, section })
    });
    loadDashboard();
}

// Graduating from the To-Do nudge keeps a transient "graduated · Undo" bar visible
// for ~6s (mirrors the reminders' logReminderDone pattern), then clears it.
window._gradRecent = window._gradRecent || {};

async function graduateFromPrompt(section, item) {
    await fetch('/api/habits/cadence/promote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit: item, section })
    });
    const key = habitKey(section, item);
    window._gradRecent[key] = { section, item };
    setTimeout(() => { delete window._gradRecent[key]; renderGraduationPrompts(); }, 6000);
    loadDashboard();
}

async function undoGraduate(section, item) {
    delete window._gradRecent[habitKey(section, item)];
    await fetch('/api/habits/cadence/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit: item, section })
    });
    loadDashboard();
}

// "Not now" on a graduate nudge — hide it for a week (client-side, like a snooze)
// so the To-Do page doesn't nag daily. Falls away once she taps Graduate.
function _gradSnoozeMap() {
    try { return JSON.parse(localStorage.getItem('gradSnooze') || '{}'); } catch (e) { return {}; }
}
function gradSnoozed(section, item) {
    const until = _gradSnoozeMap()[habitKey(section, item)];
    return !!until && until > todayStr();
}
function snoozeGraduate(section, item) {
    const m = _gradSnoozeMap();
    const d = new Date(); d.setDate(d.getDate() + 7);
    m[habitKey(section, item)] = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    localStorage.setItem('gradSnooze', JSON.stringify(m));
    renderGraduationPrompts();
}

// To-Do page nudge: proven daily habits ready to graduate, shown as reminder-style
// bars next to the linen/peptide reminders. (The Map keeps the management list.)
function renderGraduationPrompts() {
    const el = document.getElementById('habit-graduation-prompts');
    if (!el) return;
    const hidden = (D.habit_settings && D.habit_settings.hidden) || [];
    let html = '';
    // Just-graduated → brief green "graduated · Undo" confirmation (held ~6s).
    const recent = window._gradRecent || {};
    for (const key in recent) {
        const { section, item } = recent[key];
        html += `<div class="hrt-bar" style="border-left-color:var(--green);background:var(--green);margin-bottom:12px">
            <div><div style="font-size:18px">&#10003; &#127891; ${esc(item)} graduated &rarr; weekly</div></div>
            <button class="hrt-done-btn" onclick="undoGraduate('${escJs(section)}','${escJs(item)}')">Undo</button>
        </div>`;
    }
    for (const section of (D.habits || [])) {
        const n = section.name.toLowerCase();
        if (!['morning', 'midday', 'night', 'evening / night'].includes(n)) continue;
        for (const item of section.items) {
            if (hidden.includes(item)) continue;
            if (recent[habitKey(section.name, item)]) continue;   // showing its confirmation bar
            if (!readyToGraduate(section.name, item)) continue;
            if (gradSnoozed(section.name, item)) continue;
            const color = '#9b86c9';
            html += `<div class="hrt-bar" style="border-left-color:${color};background:${color};margin-bottom:12px">
                <div>
                    <div style="font-size:18px">&#127891; Graduate: ${esc(item)}</div>
                    <div style="font-size:13px;opacity:0.8;font-weight:400;margin-top:2px">Automatic now — move it to a weekly spot-check</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex:none">
                    <button class="hrt-done-btn" onclick="snoozeGraduate('${escJs(section.name)}','${escJs(item)}')" title="Not yet" style="opacity:0.85">Not now</button>
                    <button class="hrt-done-btn" onclick="graduateFromPrompt('${escJs(section.name)}','${escJs(item)}')">&#127891; Graduate</button>
                </div>
            </div>`;
        }
    }
    el.innerHTML = html;
}

function renderHabits() {
    const tod = getTime();
    const el = document.getElementById('habits-cards');
    let html = '';

    // Map section names to time-of-day display
    const sectionConfig = {
        'morning':         { time: 'morning',   label: 'This morning', color: 'var(--morning)' },
        'midday':          { time: 'afternoon', label: 'Midday',       color: 'var(--ongoing)' },
        'night':           { time: 'evening',   label: 'Tonight',      color: 'var(--evening)' },
        'evening / night': { time: 'evening',   label: 'Tonight',      color: 'var(--evening)' },
    };

    const today = todayStr();
    const todayLog = (D.habits_log || {})[today] || {};
    const hidden = (D.habit_settings && D.habit_settings.hidden) || [];

    for (const section of D.habits) {
        const cfg = sectionConfig[section.name.toLowerCase()];
        if (!cfg || cfg.time !== tod) continue;

        const visibleItems = section.items.filter(item =>
            !hidden.includes(item) && showsInDaily(section.name, item));
        if (!visibleItems.length) continue;

        const allDone = visibleItems.every(item => !!todayLog[habitKey(section.name, item)]);
        if (allDone && !expandedAll) {
            html += `<div style="font-size:14px;color:var(--text-muted);padding:8px 0;margin-bottom:8px">
                <span style="color:${cfg.color}">&#10003;</span> ${cfg.label} — all done
            </div>`;
        } else {
            html += habitCardHTML(cfg.label, visibleItems, cfg.color, section.name);
        }
    }

    // Evening — kitchen close-out: a quiet reference list of things to do if
    // needed (no checkboxes / tracking — these are do-when-relevant, not habits).
    if (tod === 'evening') {
        const chores = ['Clean kitchen countertops', 'Clear dishwasher', 'Put away drying rack', 'Take out trash if full'];
        if (new Date().getDay() === 2) chores.push('Take trash to curb (for Sally)');
        const choreItems = chores.map(c =>
            `<div class="card-item" style="padding:4px 0">
                <span class="item-text" style="color:var(--text-secondary)">${esc(c)}</span>
            </div>`).join('');

        html += `<div class="card" style="border-left-color:var(--evening)">
            <div class="card-title" style="color:var(--evening)">Kitchen close-out <span style="font-size:12px;font-weight:400;color:var(--text-muted)">— if needed</span></div>
            ${choreItems}
        </div>`;
    }

    // Growth Notes — collapsible aspirations tracker
    if (isFrosted(D.growth_notes)) {
        html += `<details style="margin-top:8px"><summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Growth Notes</summary>${frostedCard('Working On', 3)}</details>`;
    } else if (D.growth_notes && D.growth_notes.length) {
        const active = D.growth_notes.filter(g => g.status === 'active');
        const incorporated = D.growth_notes.filter(g => g.status === 'incorporated');
        const incWasOpen = el.querySelector('details#growth-incorporated')?.open;

        const growthOpen = todoCardOpen('Working On');
        const growthCount = `<span style="font-size:12px;font-weight:600;color:var(--text-muted);background:var(--bg);border-radius:10px;padding:1px 8px;margin-left:8px">${active.length}</span>`;
        let growthHTML = `<details class="card todo-card" id="card-growth" style="border-left-color:var(--text-muted);margin-top:8px" ${growthOpen ? 'open' : ''} ontoggle="todoCardToggled(this,'Working On')">
                <summary class="card-title" style="color:var(--text-muted);cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">
                    <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
                    <span style="flex:1">Working On${growthCount}</span>
                    <span class="edit-toggle" onclick="event.preventDefault();event.stopPropagation();toggleEditMode('card-growth')">edit</span>
                </summary>`;

        active.forEach((g, idx) => {
            const daysAgo = Math.floor((new Date() - new Date(g.added + 'T12:00:00')) / 86400000);
            const daysLabel = daysAgo === 0 ? 'today' : `${daysAgo}d`;
            growthHTML += `<div class="card-item" draggable="true" data-section="growth" data-idx="${idx}" data-habit="${esc(g.text)}" data-notes="${esc(g.notes || '')}"
                  ondragstart="habitDragStart(event)" ondragover="habitDragOver(event)" ondrop="habitDrop(event,'growth')" ondragend="habitDragEnd(event)" ondragleave="habitDragLeave(event)">
                <span class="drag-handle" onmousedown="dragFromHandle=true">&#8942;&#8942;</span>
                <span class="reorder-arrows">
                    <button onclick="moveCardItem(this,'growth',-1)" title="Move up">&#9650;</button>
                    <button onclick="moveCardItem(this,'growth',1)" title="Move down">&#9660;</button>
                </span>
                <span class="item-text todo-view" onclick="openGrowthDetail(this, event)" style="color:var(--text-secondary);cursor:pointer">${esc(g.text)}</span>
                <span style="font-size:12px;color:var(--text-muted);margin-left:auto;margin-right:6px;white-space:nowrap">${daysLabel}</span>
                <input class="habit-rename todo-edit" style="display:none" value="${esc(g.text)}" data-original="${esc(g.text)}" data-type="growth"
                    onblur="commitRename(this)" onkeydown="if(event.key==='Enter'){this.blur()}else if(event.key==='Escape'){this.value=this.dataset.original;this.blur()}">
                <button class="delete-btn" onclick="confirmDeleteGrowth('${escJs(g.text)}')" title="Remove">&times;</button>
            </div>`;
        });

        growthHTML += `<div class="add-trigger" onclick="toggleAdd('add-growth')">+ Add</div>
                <div class="add-form" id="add-growth">
                    <input type="text" placeholder="New aspiration..." onkeydown="if(event.key==='Enter')addGrowthNote(this)">
                    <button onclick="addGrowthNote(this.previousElementSibling)">Add</button>
                </div>`;

        // Incorporated section
        if (incorporated.length) {
            growthHTML += `<details id="growth-incorporated" ${incWasOpen ? 'open' : ''} style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px">
                <summary style="font-size:12px;font-weight:600;cursor:pointer;color:var(--green)">Incorporated (${incorporated.length})</summary>`;
            incorporated.forEach(g => {
                const addedDate = new Date(g.added + 'T12:00:00');
                const incDate = new Date(g.incorporated + 'T12:00:00');
                const daysTook = Math.floor((incDate - addedDate) / 86400000);
                const journey = daysTook === 0 ? 'same day' : `${daysTook} day${daysTook !== 1 ? 's' : ''}`;
                growthHTML += `<div style="padding:4px 0;font-size:13px;color:var(--text-muted);display:flex;align-items:center;gap:8px">
                    <span style="text-decoration:line-through;opacity:0.6;flex:1">${esc(g.text)}</span>
                    <span style="font-size:12px;white-space:nowrap;color:var(--green)">${journey}</span>
                    <button style="font-size:12px;background:none;border:1px solid var(--border);border-radius:4px;padding:2px 6px;cursor:pointer;color:var(--text-muted)" onclick="reactivateGrowth('${escJs(g.text)}')" title="Move back to active">&#8634;</button>
                </div>`;
            });
            growthHTML += '</details>';
        }

        growthHTML += '</details>';
        html += growthHTML;
    }

    html += `<button onclick="openHabitConfigNew()" title="Add a habit with time-of-day and an optional course length"
        style="margin-top:10px;min-height:40px;width:100%;font-size:13px;background:none;border:1px dashed var(--border);border-radius:8px;color:var(--text-muted);cursor:pointer">&#43; Tracked habit</button>`;

    el.innerHTML = html;
}

// --- Habit Tracker ---
let _habitTrackerEditing = false;
let _buildingNextEditing = false;

function renderHabitTracker() {
    const el = document.getElementById('habit-tracker');
    const log = D.habits_log || {};
    const hidden = (D.habit_settings && D.habit_settings.hidden) || [];

    // Separate habits by section
    const allMorning = [];
    const allMidday = [];
    const allNight = [];
    const weeklyGoals = [];
    let mSec = 'Morning', midSec = 'Midday', nSec = 'Evening / Night';
    for (const section of D.habits) {
        const n = section.name.toLowerCase();
        if (n === 'morning') { allMorning.push(...section.items); mSec = section.name; }
        else if (n === 'midday') { allMidday.push(...section.items); midSec = section.name; }
        else if (n === 'night' || n === 'evening / night') { allNight.push(...section.items); nSec = section.name; }
        else if (n === 'weekly' || n === 'recurring' || n === 'trying to add') weeklyGoals.push(...section.items);
    }

    // Filter hidden + graduated habits from the daily grid. A graduated habit
    // (any cadence entry) lives in the "Graduated" block below, not the dot grid.
    const notExpired = (sec, h) => { const ci = courseInfo(sec, h); return !(ci && ci.expired); };
    const morningHabits = allMorning.filter(h => !hidden.includes(h) && !habitCadence(mSec, h) && notExpired(mSec, h));
    const middayHabits = allMidday.filter(h => !hidden.includes(h) && !habitCadence(midSec, h) && notExpired(midSec, h));
    const nightHabits = allNight.filter(h => !hidden.includes(h) && !habitCadence(nSec, h) && notExpired(nSec, h));

    if (!allMorning.length && !allMidday.length && !allNight.length) { el.innerHTML = ''; return; }

    // Last 30 days (local time)
    const days = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        days.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }

    function dateHeaderRow() {
        let row = '<tr><td style="min-width:90px"></td>';
        days.forEach((d, i) => {
            const dt = new Date(d + 'T12:00:00');
            const label = (i % 5 === 0 || i === days.length - 1)
                ? `<span class="date-label">${dt.toLocaleDateString('en-US',{month:'short'})}<br>${dt.getDate()}</span>`
                : '';
            row += `<td class="date-label">${label}</td>`;
        });
        return row + '</tr>';
    }

    function habitRow(habit, accentColor, sectionName) {
        const total = habitCount(habit, sectionName);
        const key = habitKey(sectionName, habit);
        const maxLen = 30;
        const shortName = habit.length > maxLen ? habit.slice(0, maxLen) + '...' : habit;
        let row = `<tr><td class="metric-label">${esc(shortName)}<span style="font-size:12px;color:var(--text-muted);margin-left:6px">${habitStartLabel(habit)}${total}/60</span></td>`;
        days.forEach(d => {
            const hit = log[d] && log[d][key];
            const color = hit ? accentColor : '#2a2a4a';
            if (hit) {
                row += `<td><div class="dot" style="background:${color};cursor:pointer" title="Click to remove" onclick="confirmHabitDot('${escJs(habit)}','${d}','${escJs(sectionName)}')"></div></td>`;
            } else {
                row += `<td><div class="dot" style="background:${color};cursor:pointer" title="Click to log" onclick="toggleHabitDate('${escJs(habit)}','${d}','${escJs(sectionName)}')"></div></td>`;
            }
        });
        row += '</tr>';
        return row;
    }

    // Top Edit button now lives on the card's title line (see index.html);
    // a second one is rendered below the habits.
    let html = '';

    // --- Shared inline editor (used by the daily-habits panel AND Building next) ---
    // Find actual section names from D.habits
    const sectionNames = {};
    for (const section of D.habits) {
        const n = section.name.toLowerCase();
        if (n === 'morning') sectionNames.morning = section.name;
        else if (n === 'midday') sectionNames.midday = section.name;
        else if (n === 'night' || n === 'evening / night') sectionNames.night = section.name;
    }
    const weeklySections = D.habits.filter(s => ['weekly', 'recurring', 'trying to add'].includes(s.name.toLowerCase()));
    // Every section a habit can be moved into (drives the move-to-section menu).
    const moveTargets = [sectionNames.morning || 'Morning', sectionNames.midday || 'Midday',
        sectionNames.night || 'Evening / Night', ...weeklySections.map(s => s.name)];
    const moveTargetsJs = '[' + moveTargets.map(s => `'${escJs(s)}'`).join(',') + ']';
    function editSection(title, color, habits, sectionName) {
        let s = title ? `<div style="font-size:12px;font-weight:600;color:${color};margin-top:8px;margin-bottom:4px">${title}</div>` : '';
        s += `<div class="tracker-edit-list" data-section="${esc(sectionName)}">`;
        habits.forEach((h, idx) => {
            const isHidden = hidden.includes(h);
            const btn = 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:12px;padding:2px 6px;flex-shrink:0';
            s += `<div class="tracker-edit-item" draggable="true" data-section="${esc(sectionName)}" data-idx="${idx}" data-habit="${esc(h)}"
                  ondragstart="trackerDragStart(event)" ondragover="trackerDragOver(event)" ondrop="trackerDrop(event)" ondragend="trackerDragEnd(event)" ondragleave="trackerDragLeave(event)"
                  style="display:flex;align-items:center;gap:6px;padding:5px 0;font-size:13px;color:${isHidden ? 'var(--text-muted)' : 'var(--text)'}">
                <span class="drag-handle" style="cursor:grab;color:var(--text-muted);font-size:14px;user-select:none">&#8942;&#8942;</span>
                <input type="checkbox" ${isHidden ? '' : 'checked'} onchange="toggleHabitVisibility('${escJs(h)}', this.checked)" style="width:16px;height:16px;cursor:pointer;flex-shrink:0">
                <span class="tracker-edit-name" onclick="startTrackerRename(this, '${escJs(h)}', '${escJs(sectionName)}')" style="cursor:text;flex:1;min-width:0;${isHidden ? 'text-decoration:line-through;opacity:0.5' : ''}" title="Click to rename">${esc(h)}</span>
                <button onclick="moveHabitInSection('${escJs(sectionName)}','${escJs(h)}',-1)" style="${btn}" title="Move up">&#9650;</button>
                <button onclick="moveHabitInSection('${escJs(sectionName)}','${escJs(h)}',1)" style="${btn}" title="Move down">&#9660;</button>
                <button onclick="showTrackerMoveMenu(this, '${escJs(h)}', '${escJs(sectionName)}', ${moveTargetsJs})" style="${btn}" title="Move to section">&#8596;</button>
                <button onclick="openHabitConfig('${escJs(sectionName)}','${escJs(h)}')" style="${btn}" title="Options — time of day, course">&#9881;</button>
                <button onclick="confirmDelete('${escJs(h)}','habit')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0 4px;flex-shrink:0" title="Remove">&times;</button>
            </div>`;
        });
        s += '</div>';
        const addId = `add-tracker-habit-${sectionName.replace(/\s+/g,'-').replace(/[^a-zA-Z0-9_-]/g,'')}`;
        s += `<div class="add-trigger" style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:4px 0 6px;margin-left:24px" onclick="toggleAdd('${addId}')">+ Add habit</div>
            <div class="add-form" id="${addId}" style="margin-left:24px">
                <input type="text" placeholder="New habit..." onkeydown="if(event.key==='Enter')addItem('habit','${escJs(sectionName)}',this)">
                <button onclick="addItem('habit','${escJs(sectionName)}',this.previousElementSibling)">Add</button>
            </div>`;
        return s;
    }

    // Daily-habits edit panel — rendered into the editor modal (see end of fn).
    let editPanelHtml = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Drag to reorder, click a name to rename.</div>';
    editPanelHtml += editSection('Morning', 'var(--morning)', allMorning, sectionNames.morning || 'Morning');
    editPanelHtml += editSection('Midday', 'var(--ongoing)', allMidday, sectionNames.midday || 'Midday');
    editPanelHtml += editSection('Evening', 'var(--evening)', allNight, sectionNames.night || 'Evening / Night');

    const symCount = D.health_data.filter(d => d.energy !== null).length;

    function sectionBlock(title, color, habits, accentColor, extra, sectionName) {
        if (!habits.length && !extra) return '';
        let s = `<div class="habit-section-header" style="color:${color}">${title}</div>`;
        s += '<div class="dot-grid"><table>' + dateHeaderRow();
        habits.forEach(h => { s += habitRow(h, accentColor, sectionName); });
        if (extra) s += extra;
        s += '</table></div>';
        return s;
    }

    let symRow = `<tr><td class="metric-label">Log symptoms<span style="font-size:12px;color:var(--text-muted);margin-left:6px">${symCount}/60</span></td>`;
    days.forEach(d => {
        const dayData = D.health_data.find(h => h.date === d);
        const hit = dayData && dayData.energy !== null;
        const color = hit ? 'var(--morning)' : '#2a2a4a';
        symRow += `<td><div class="dot" style="background:${color}" title="Symptoms: ${hit ? 'Logged' : 'Not logged'} on ${d}"></div></td>`;
    });
    symRow += '</tr>';

    // (The "ready to graduate" nudge lives on the To-Do page next to the reminders —
    // see renderGraduationPrompts. The Map keeps only the Graduated management list below.)
    html += sectionBlock('Morning', 'var(--morning)', morningHabits, 'var(--morning)', symRow, sectionNames.morning || 'Morning');
    if (middayHabits.length) {
        html += sectionBlock('Midday', 'var(--ongoing)', middayHabits, 'var(--ongoing)', '', sectionNames.midday || 'Midday');
    }
    html += sectionBlock('Evening', 'var(--evening)', nightHabits, 'var(--evening)', '', sectionNames.night || 'Evening / Night');

    // Hidden count
    const hiddenCount = hidden.length;
    if (hiddenCount && !_habitTrackerEditing) {
        html += `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${hiddenCount} habit${hiddenCount !== 1 ? 's' : ''} hidden</div>`;
    }

    // (Edit lives on the card's title line — see index.html.)

    // Building next — collapsible, with its own Edit toggle
    if (weeklySections.length || weeklyGoals.length) {
        const editBtn = `<button onclick="event.preventDefault();event.stopPropagation();toggleBuildingNextEdit()" style="float:right;font-size:12px;background:none;border:1px solid var(--border);border-radius:6px;padding:2px 10px;cursor:pointer;color:var(--text-muted)">${_buildingNextEditing ? 'Done' : 'Edit'}</button>`;
        html += `<details style="margin-top:12px" ${_buildingNextEditing ? 'open' : ''}>
            <summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Building next (${weeklyGoals.length})${editBtn}</summary>
            <div style="margin-top:8px">`;
        if (_buildingNextEditing) {
            const routineTargetsJs = '[' + [sectionNames.morning || 'Morning', sectionNames.midday || 'Midday', sectionNames.night || 'Evening / Night'].map(s => `'${escJs(s)}'`).join(',') + ']';
            html += '<div style="background:var(--card-bg);border-radius:8px;padding:10px 14px;border:1px solid var(--border)">';
            html += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Habits you want to build. Add them here, then “Add to routine” when you’re ready to start.</div>';
            weeklySections.forEach(sec => {
                const btn = 'background:none;border:1px solid var(--border);border-radius:5px;color:var(--text-muted);cursor:pointer;font-size:12px;padding:3px 8px;flex-shrink:0';
                sec.items.forEach(h => {
                    html += `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px">
                        <span class="tracker-edit-name" onclick="startTrackerRename(this, '${escJs(h)}', '${escJs(sec.name)}')" style="cursor:text;flex:1;min-width:0" title="Click to edit wording">${esc(h)}</span>
                        <button onclick="showTrackerMoveMenu(this,'${escJs(h)}','${escJs(sec.name)}',${routineTargetsJs})" style="${btn}" title="Move into a daily routine">Add to routine &#9662;</button>
                        <button onclick="confirmDelete('${escJs(h)}','habit')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0 4px;flex-shrink:0" title="Remove">&times;</button>
                    </div>`;
                });
                const addId = `add-bn-${sec.name.replace(/\s+/g,'-').replace(/[^a-zA-Z0-9_-]/g,'')}`;
                html += `<div class="add-trigger" style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:6px 0 2px" onclick="toggleAdd('${addId}')">+ Add a habit to build</div>
                    <div class="add-form" id="${addId}">
                        <input type="text" placeholder="New habit to build toward..." onkeydown="if(event.key==='Enter')addItem('habit','${escJs(sec.name)}',this)">
                        <button onclick="addItem('habit','${escJs(sec.name)}',this.previousElementSibling)">Add</button>
                    </div>`;
            });
            html += '</div>';
        } else {
            html += `<div style="display:flex;flex-wrap:wrap;gap:8px">
                ${weeklyGoals.map(g => `<span style="padding:5px 12px;background:var(--card-bg);border-left:3px solid var(--todo-1);border-radius:6px;font-size:13px;color:var(--text-secondary)">${esc(g)}</span>`).join('')}
            </div>`;
        }
        html += `</div></details>`;
    }

    // --- Graduated: habits on a lighter cadence, plus retired ones (collapsible) ---
    const graduatedList = [];
    const retiredList = [];
    for (const section of D.habits) {
        for (const item of section.items) {
            const c = habitCadence(section.name, item);
            if (!c) continue;
            if (c.stage === 'retired') retiredList.push({ section: section.name, item, c });
            else if (c.stage === 'weekly' || c.stage === 'monthly') graduatedList.push({ section: section.name, item, c });
        }
    }
    if (graduatedList.length || retiredList.length) {
        const fmt = ds => { if (!ds) return ''; const d = new Date(ds + 'T12:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
        const chip = (label, color) => `<span style="font-size:12px;color:${color};background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:1px 8px;white-space:nowrap">${esc(label)}</span>`;
        const btn = 'min-height:34px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);cursor:pointer;font-size:12px;padding:4px 10px;flex-shrink:0';
        const row = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--border)';
        let g = `<details style="margin-top:12px">
            <summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Graduated (${graduatedList.length + retiredList.length})</summary>
            <div style="margin-top:8px">`;
        graduatedList.forEach(({ section, item, c }) => {
            const stageColor = c.stage === 'monthly' ? 'var(--evening)' : 'var(--ongoing)';
            const nextLabel = STAGE_NEXT_LABEL[c.stage] || '';
            const ready = readyToPromote(c);
            const progress = ready
                ? `<span style="font-size:12px;color:${stageColor}">ready for ${nextLabel}</span>`
                : `<span style="font-size:12px;color:var(--text-muted)">${c.passes || 0}/${promoteTarget(c)} &#8594; ${nextLabel}</span>`;
            const when = spotCheckDue(section, item)
                ? `<span style="font-size:12px;color:var(--ongoing)">due today</span>`
                : `<span style="font-size:12px;color:var(--text-muted)">next ${fmt(c.next_check)}</span>`;
            const promoteBtn = ready
                ? `<button onclick="graduateHabit('${escJs(section)}','${escJs(item)}')" style="${btn};border-color:${stageColor};color:${stageColor}">&#127891; ${nextLabel === 'retire' ? 'Retire' : 'To ' + nextLabel}</button>`
                : '';
            g += `<div style="${row}">
                <span style="flex:1;min-width:120px;font-size:13px;color:var(--text)">${esc(item)}</span>
                ${chip(c.stage, stageColor)}${progress}${when}${promoteBtn}
                <button onclick="restoreHabitCadence('${escJs(section)}','${escJs(item)}')" style="${btn}" title="Bring back to daily">&#8634; daily</button>
            </div>`;
        });
        retiredList.forEach(({ section, item }) => {
            g += `<div style="${row}">
                <span style="flex:1;min-width:120px;font-size:13px;color:var(--text-muted);text-decoration:line-through">${esc(item)}</span>
                ${chip('retired', 'var(--green)')}
                <button onclick="restoreHabitCadence('${escJs(section)}','${escJs(item)}')" style="${btn}" title="Bring back to daily">&#8634; daily</button>
            </div>`;
        });
        g += `</div></details>`;
        html += g;
    }

    // --- Finished courses: expired time-limited habits, archived but kept ---
    const finishedCourses = [];
    for (const section of D.habits) {
        for (const item of section.items) {
            const ci = courseInfo(section.name, item);
            if (ci && ci.expired) finishedCourses.push({ section: section.name, item, ci });
        }
    }
    if (finishedCourses.length) {
        const fmt = ds => { const d = new Date(ds + 'T12:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
        const btn = 'min-height:34px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);cursor:pointer;font-size:12px;padding:4px 10px;flex-shrink:0';
        const row = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--border)';
        // dedupe by item (a course in AM+PM is one finished course)
        const uniqueCount = new Set(finishedCourses.map(c => c.item)).size;
        let f = `<details style="margin-top:12px">
            <summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Finished courses (${uniqueCount})</summary>
            <div style="margin-top:8px">`;
        const shown = new Set();
        finishedCourses.forEach(({ section, item, ci }) => {
            if (shown.has(item)) return;
            shown.add(item);
            const endD = new Date(ci.start + 'T12:00:00'); endD.setDate(endD.getDate() + ci.days - 1);
            f += `<div style="${row}">
                <span style="flex:1;min-width:120px;font-size:13px;color:var(--text-muted);text-decoration:line-through">${esc(item)}</span>
                <span style="font-size:12px;color:var(--green)">finished ${fmt(endD.toISOString().slice(0,10))}</span>
                <button onclick="openHabitConfig('${escJs(section)}','${escJs(item)}')" style="${btn}" title="Edit / extend">&#9881; edit</button>
            </div>`;
        });
        f += `</div></details>`;
        html += f;
    }

    el.innerHTML = html;

    // Auto-scroll to most recent days
    el.querySelectorAll('.dot-grid').forEach(g => {
        g.scrollLeft = g.scrollWidth;
    });

    // The edit panel lives in the shared editor modal.
    if (_habitTrackerEditing) showEditorModal('Edit habits', editPanelHtml);
    document.querySelectorAll('.habit-edit-btn').forEach(b => { b.textContent = _habitTrackerEditing ? 'Done' : 'Edit'; });
}

function toggleHabitTrackerEdit() {
    _habitTrackerEditing = !_habitTrackerEditing;
    if (_habitTrackerEditing) { window._remMgrOpen = false; window._contactsManageOpen = false; }
    else hideEditorModal();
    renderHabitTracker();
}

function toggleBuildingNextEdit() {
    _buildingNextEditing = !_buildingNextEditing;
    renderHabitTracker();
}

// Move a habit up/down within its section (dir = -1 up, +1 down). Button-based
// reorder for touch/PWA where drag is awkward.
async function moveHabitInSection(section, habit, dir) {
    const sec = (D.habits || []).find(s => s.name === section);
    if (!sec) return;
    const items = [...sec.items];
    const i = items.indexOf(habit);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    sec.items = items;            // optimistic local update
    renderHabitTracker();
    await fetch('/api/habits/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, items })
    });
}

async function toggleHabitVisibility(habit, visible) {
    const hidden = (D.habit_settings && D.habit_settings.hidden) || [];
    let newHidden;
    if (visible) {
        newHidden = hidden.filter(h => h !== habit);
    } else {
        newHidden = [...hidden, habit];
    }
    // Update local state immediately for responsiveness
    if (!D.habit_settings) D.habit_settings = {};
    D.habit_settings.hidden = newHidden;
    renderHabitTracker();
    // Persist to server
    await fetch('/api/habits/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: newHidden })
    });
}

// --- Tracker edit: drag reorder ---
let _trackerDragItem = null;

function trackerDragStart(e) {
    _trackerDragItem = e.currentTarget;
    _trackerDragItem.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
}

function trackerDragOver(e) {
    e.preventDefault();
    const target = e.currentTarget;
    if (target === _trackerDragItem) return;
    target.style.borderTop = '2px solid var(--ongoing)';
}

function trackerDragLeave(e) {
    e.currentTarget.style.borderTop = '';
}

function trackerDragEnd(e) {
    e.currentTarget.style.opacity = '';
    document.querySelectorAll('.tracker-edit-item').forEach(el => el.style.borderTop = '');
    _trackerDragItem = null;
}

async function trackerDrop(e) {
    e.preventDefault();
    const target = e.currentTarget;
    target.style.borderTop = '';
    if (!_trackerDragItem || target === _trackerDragItem) return;

    const fromSection = _trackerDragItem.dataset.section;
    const toSection = target.dataset.section;
    const habit = _trackerDragItem.dataset.habit;

    if (fromSection !== toSection) {
        // Cross-section move
        await fetch('/api/habits/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: habit, to_section: toSection })
        });
    } else {
        // Same-section reorder
        const list = target.closest('.tracker-edit-list');
        const allItems = [...list.querySelectorAll('.tracker-edit-item')];
        const items = allItems.map(el => el.dataset.habit);
        const fromIdx = items.indexOf(habit);
        const toIdx = items.indexOf(target.dataset.habit);
        const moved = items.splice(fromIdx, 1)[0];
        items.splice(toIdx, 0, moved);

        await fetch('/api/habits/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section: fromSection, items })
        });
    }
    loadDashboard();
}

// --- Tracker edit: move to section (for mobile / easier use) ---
function showTrackerMoveMenu(btn, habit, currentSection, allSections) {
    document.querySelectorAll('.tracker-move-menu').forEach(p => p.remove());
    const menu = document.createElement('div');
    menu.className = 'tracker-move-menu';
    menu.style.cssText = 'position:absolute;right:0;top:100%;background:var(--card-bg);border:1px solid var(--border);border-radius:6px;padding:4px;z-index:10;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
    allSections.forEach(s => {
        if (s === currentSection) return;
        const b = document.createElement('button');
        b.textContent = s;
        b.style.cssText = 'display:block;width:100%;text-align:left;padding:6px 12px;font-size:12px;border:none;background:none;color:var(--text);cursor:pointer;border-radius:4px;white-space:nowrap';
        b.onmouseover = () => b.style.background = 'var(--border)';
        b.onmouseout = () => b.style.background = 'none';
        b.onclick = async (e) => {
            e.stopPropagation();
            menu.remove();
            await fetch('/api/habits/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item: habit, to_section: s })
            });
            loadDashboard();
        };
        menu.appendChild(b);
    });
    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(menu);
    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
        });
    }, 0);
}

// --- Tracker edit: inline rename ---
function startTrackerRename(span, habit, section) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = habit;
    input.style.cssText = 'flex:1;font-size:13px;padding:2px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);outline:none';
    input.dataset.original = habit;
    input.dataset.section = section;

    const commit = async () => {
        const newName = input.value.trim();
        if (!newName || newName === habit) {
            renderHabitTracker();
            return;
        }
        await fetch('/api/habits/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old: habit, new: newName, section })
        });
        // Also update hidden list if this habit was hidden
        const hidden = (D.habit_settings && D.habit_settings.hidden) || [];
        if (hidden.includes(habit)) {
            const newHidden = hidden.map(h => h === habit ? newName : h);
            D.habit_settings.hidden = newHidden;
            await fetch('/api/habits/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hidden: newHidden })
            });
        }
        loadDashboard();
    };

    input.onblur = commit;
    input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = habit; input.blur(); }
    };

    span.replaceWith(input);
    input.focus();
    input.select();
}

// --- Growth Notes ---
async function addGrowthNote(inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;
    const res = await fetch('/api/growth/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });
    if (res.ok) {
        inputEl.value = '';
        loadDashboard();
    } else {
        const data = await res.json();
        alert(data.error || 'Failed to add');
    }
}

async function incorporateGrowth(text) {
    await fetch('/api/growth/incorporate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });
    loadDashboard();
}

async function reactivateGrowth(text) {
    await fetch('/api/growth/reactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });
    loadDashboard();
}
