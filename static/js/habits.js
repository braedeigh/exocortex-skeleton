// habits.js — habit cards, habit tracker grid

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

        const visibleItems = section.items.filter(item => !hidden.includes(item));
        if (!visibleItems.length) continue;

        const allDone = visibleItems.every(item => !!todayLog[item]);
        if (allDone && !expandedAll) {
            html += `<div style="font-size:14px;color:var(--text-muted);padding:8px 0;margin-bottom:8px">
                <span style="color:${cfg.color}">&#10003;</span> ${cfg.label} — all done
            </div>`;
        } else {
            html += habitCardHTML(cfg.label, visibleItems, cfg.color, section.name);
        }
    }

    // Evening — kitchen close-out (resets daily, no tracking)
    if (tod === 'evening') {
        const chores = ['Clean kitchen countertops', 'Clear dishwasher', 'Put away drying rack', 'Take out trash if full'];
        const dayOfWeek = new Date().getDay();
        if (dayOfWeek === 2) chores.push('Take trash to curb (for Sally)');
        const choreLog = JSON.parse(localStorage.getItem('choreLog') || '{}');
        const todayChores = choreLog[today] || {};

        const allChoresDone = chores.every(c => !!todayChores[c]);
        if (allChoresDone && !expandedAll) {
            html += `<div style="font-size:14px;color:var(--text-muted);padding:8px 0;margin-bottom:8px">
                <span style="color:var(--ongoing)">&#10003;</span> Kitchen — all done
            </div>`;
        } else {
            const choreItems = chores.map(c => {
                const done = !!todayChores[c];
                return `<div class="card-item">
                    <span class="habit-check ${done?'done':''}" onclick="toggleChore('${esc(c)}')" title="Toggle">
                        ${done ? '&#10003;' : '&#9675;'}
                    </span>
                    <span class="item-text" style="${done?'text-decoration:line-through;opacity:0.5':''}">${esc(c)}</span>
                </div>`;
            }).join('');

            html += `<div class="card" style="border-left-color:var(--ongoing)">
                <div class="card-title" style="color:var(--ongoing)">Kitchen close-out</div>
                ${choreItems}
            </div>`;
        }
    }

    // Growth Notes — collapsible aspirations tracker
    if (isFrosted(D.growth_notes)) {
        html += `<details style="margin-top:8px"><summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Growth Notes</summary>${frostedCard('Working On', 3)}</details>`;
    } else if (D.growth_notes && D.growth_notes.length) {
        const growthWasOpen = el.querySelector('details#growth-detail')?.open;
        const active = D.growth_notes.filter(g => g.status === 'active');
        const incorporated = D.growth_notes.filter(g => g.status === 'incorporated');
        const incWasOpen = el.querySelector('details#growth-incorporated')?.open;

        let growthHTML = `<details id="growth-detail" ${growthWasOpen ? 'open' : ''} style="margin-top:8px">
            <summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Growth Notes (${active.length} active)</summary>
            <div class="card" style="border-left-color:#9b59b6;margin-top:8px" id="card-growth">
                <div class="card-title" style="color:#9b59b6">Working On<span class="edit-toggle" onclick="toggleEditMode('card-growth')">edit</span></div>`;

        active.forEach((g, idx) => {
            const daysAgo = Math.floor((new Date() - new Date(g.added + 'T12:00:00')) / 86400000);
            const daysLabel = daysAgo === 0 ? 'today' : `${daysAgo}d`;
            growthHTML += `<div class="card-item" draggable="true" data-section="growth" data-idx="${idx}" data-habit="${esc(g.text)}"
                  ondragstart="habitDragStart(event)" ondragover="habitDragOver(event)" ondrop="habitDrop(event,'growth')" ondragend="habitDragEnd(event)" ondragleave="habitDragLeave(event)">
                <span class="drag-handle" onmousedown="dragFromHandle=true">&#8942;&#8942;</span>
                <span class="item-text todo-view" style="color:var(--text-secondary)">${esc(g.text)}</span>
                <span style="font-size:10px;color:var(--text-muted);margin-left:auto;margin-right:6px;white-space:nowrap">${daysLabel}</span>
                <input class="habit-rename todo-edit" style="display:none" value="${esc(g.text)}" data-original="${esc(g.text)}" data-type="growth"
                    onblur="commitRename(this)" onkeydown="if(event.key==='Enter'){this.blur()}else if(event.key==='Escape'){this.value=this.dataset.original;this.blur()}">
                <button class="delete-btn todo-edit" style="display:none;font-size:11px;color:var(--green);border:1px solid var(--green);border-radius:4px;padding:2px 6px;background:none;cursor:pointer;margin-right:4px" onclick="incorporateGrowth('${escJs(g.text)}')" title="Mark incorporated">&#10003;</button>
                <button class="delete-btn" onclick="confirmDelete('${escJs(g.text)}','growth')" title="Remove">&times;</button>
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
                    <span style="font-size:10px;white-space:nowrap;color:var(--green)">${journey}</span>
                    <button style="font-size:10px;background:none;border:1px solid var(--border);border-radius:4px;padding:2px 6px;cursor:pointer;color:var(--text-muted)" onclick="reactivateGrowth('${escJs(g.text)}')" title="Move back to active">&#8634;</button>
                </div>`;
            });
            growthHTML += '</details>';
        }

        growthHTML += '</div></details>';
        html += growthHTML;
    }

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
    for (const section of D.habits) {
        const n = section.name.toLowerCase();
        if (n === 'morning') allMorning.push(...section.items);
        else if (n === 'midday') allMidday.push(...section.items);
        else if (n === 'night' || n === 'evening / night') allNight.push(...section.items);
        else if (n === 'weekly' || n === 'recurring' || n === 'trying to add') weeklyGoals.push(...section.items);
    }

    // Filter hidden habits for display
    const morningHabits = allMorning.filter(h => !hidden.includes(h));
    const middayHabits = allMidday.filter(h => !hidden.includes(h));
    const nightHabits = allNight.filter(h => !hidden.includes(h));

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

    function habitRow(habit, accentColor) {
        const total = habitCount(habit);
        const maxLen = 30;
        const shortName = habit.length > maxLen ? habit.slice(0, maxLen) + '...' : habit;
        let row = `<tr><td class="metric-label">${esc(shortName)}<span style="font-size:10px;color:var(--text-muted);margin-left:6px">${habitStartLabel(habit)}${total}/60</span></td>`;
        days.forEach(d => {
            const hit = log[d] && log[d][habit];
            const color = hit ? accentColor : '#2a2a4a';
            if (hit) {
                row += `<td><div class="dot" style="background:${color};cursor:pointer" title="Click to remove" onclick="confirmHabitDot('${esc(habit)}','${d}')"></div></td>`;
            } else {
                row += `<td><div class="dot" style="background:${color};cursor:pointer" title="Click to log" onclick="toggleHabitDate('${esc(habit)}','${d}')"></div></td>`;
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
            const btn = 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:11px;padding:2px 6px;flex-shrink:0';
            s += `<div class="tracker-edit-item" draggable="true" data-section="${esc(sectionName)}" data-idx="${idx}" data-habit="${esc(h)}"
                  ondragstart="trackerDragStart(event)" ondragover="trackerDragOver(event)" ondrop="trackerDrop(event)" ondragend="trackerDragEnd(event)" ondragleave="trackerDragLeave(event)"
                  style="display:flex;align-items:center;gap:6px;padding:5px 0;font-size:13px;color:${isHidden ? 'var(--text-muted)' : 'var(--text)'}">
                <span class="drag-handle" style="cursor:grab;color:var(--text-muted);font-size:14px;user-select:none">&#8942;&#8942;</span>
                <input type="checkbox" ${isHidden ? '' : 'checked'} onchange="toggleHabitVisibility('${escJs(h)}', this.checked)" style="width:16px;height:16px;cursor:pointer;flex-shrink:0">
                <span class="tracker-edit-name" onclick="startTrackerRename(this, '${escJs(h)}', '${escJs(sectionName)}')" style="cursor:text;flex:1;min-width:0;${isHidden ? 'text-decoration:line-through;opacity:0.5' : ''}" title="Click to rename">${esc(h)}</span>
                <button onclick="moveHabitInSection('${escJs(sectionName)}','${escJs(h)}',-1)" style="${btn}" title="Move up">&#9650;</button>
                <button onclick="moveHabitInSection('${escJs(sectionName)}','${escJs(h)}',1)" style="${btn}" title="Move down">&#9660;</button>
                <button onclick="showTrackerMoveMenu(this, '${escJs(h)}', '${escJs(sectionName)}', ${moveTargetsJs})" style="${btn}" title="Move to section">&#8596;</button>
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

    function sectionBlock(title, color, habits, accentColor, extra) {
        if (!habits.length && !extra) return '';
        let s = `<div class="habit-section-header" style="color:${color}">${title}</div>`;
        s += '<div class="dot-grid"><table>' + dateHeaderRow();
        habits.forEach(h => { s += habitRow(h, accentColor); });
        if (extra) s += extra;
        s += '</table></div>';
        return s;
    }

    let symRow = `<tr><td class="metric-label">Log symptoms<span style="font-size:10px;color:var(--text-muted);margin-left:6px">${symCount}/60</span></td>`;
    days.forEach(d => {
        const dayData = D.health_data.find(h => h.date === d);
        const hit = dayData && dayData.energy !== null;
        const color = hit ? 'var(--morning)' : '#2a2a4a';
        symRow += `<td><div class="dot" style="background:${color}" title="Symptoms: ${hit ? 'Logged' : 'Not logged'} on ${d}"></div></td>`;
    });
    symRow += '</tr>';

    html += sectionBlock('Morning', 'var(--morning)', morningHabits, 'var(--morning)', symRow);
    if (middayHabits.length) {
        html += sectionBlock('Midday', 'var(--ongoing)', middayHabits, 'var(--ongoing)');
    }
    html += sectionBlock('Evening', 'var(--evening)', nightHabits, 'var(--evening)');

    // Hidden count
    const hiddenCount = hidden.length;
    if (hiddenCount && !_habitTrackerEditing) {
        html += `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${hiddenCount} habit${hiddenCount !== 1 ? 's' : ''} hidden</div>`;
    }

    // (Edit lives on the card's title line — see index.html.)

    // Building next — collapsible, with its own Edit toggle
    if (weeklySections.length || weeklyGoals.length) {
        const editBtn = `<button onclick="event.preventDefault();event.stopPropagation();toggleBuildingNextEdit()" style="float:right;font-size:11px;background:none;border:1px solid var(--border);border-radius:6px;padding:2px 10px;cursor:pointer;color:var(--text-muted)">${_buildingNextEditing ? 'Done' : 'Edit'}</button>`;
        html += `<details style="margin-top:12px" ${_buildingNextEditing ? 'open' : ''}>
            <summary style="font-size:13px;font-weight:600;cursor:pointer;color:var(--text-muted)">Building next (${weeklyGoals.length})${editBtn}</summary>
            <div style="margin-top:8px">`;
        if (_buildingNextEditing) {
            const routineTargetsJs = '[' + [sectionNames.morning || 'Morning', sectionNames.midday || 'Midday', sectionNames.night || 'Evening / Night'].map(s => `'${escJs(s)}'`).join(',') + ']';
            html += '<div style="background:var(--card-bg);border-radius:8px;padding:10px 14px;border:1px solid var(--border)">';
            html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Habits you want to build. Add them here, then “Add to routine” when you’re ready to start.</div>';
            weeklySections.forEach(sec => {
                const btn = 'background:none;border:1px solid var(--border);border-radius:5px;color:var(--text-muted);cursor:pointer;font-size:11px;padding:3px 8px;flex-shrink:0';
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
