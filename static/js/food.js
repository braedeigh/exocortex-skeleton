// food.js — food banner, food log, meal defaults

function renderFoodBanner() {
    const el = document.getElementById('food-log-banner');
    // Only surface during the evening view — that's when the day's eating is done.
    if (getTime() !== 'evening' && !expandedAll) { el.innerHTML = ''; return; }
    const today = todayStr();
    const todayLog = (D.habits_log || {})[today] || {};
    if (todayLog[habitKey(habitSectionOf('Log new or flagged foods'), 'Log new or flagged foods')] && !expandedAll) { el.innerHTML = ''; return; }

    el.innerHTML = `<div class="hrt-bar" style="border-left-color:var(--ongoing);background:var(--ongoing);margin-bottom:8px;padding:10px 16px;">
        <div>
            <div style="font-size:15px">Eat anything new or flagged?</div>
            <div style="font-size:12px;opacity:0.8;font-weight:400;margin-top:1px">Log it or dismiss</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
            <button class="hrt-done-btn" onclick="promptFoodBanner()" style="font-size:12px">+ Log</button>
            <button class="hrt-done-btn" onclick="dismissFoodBanner()" style="font-size:12px;opacity:0.7">Nah</button>
        </div>
    </div>
    <div id="food-banner-form" style="display:none;margin-bottom:12px;display:flex;gap:8px">
        <input type="text" id="food-banner-input" placeholder="What did you eat..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;background:var(--card-bg)" onkeydown="if(event.key==='Enter')submitFoodBanner()">
        <button onclick="submitFoodBanner()" style="padding:8px 16px;border:none;border-radius:8px;background:var(--ongoing);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Add</button>
    </div>`;
    document.getElementById('food-banner-form').style.display = 'none';
}

function promptFoodBanner() {
    const form = document.getElementById('food-banner-form');
    form.style.display = 'flex';
    document.getElementById('food-banner-input').focus();
}

async function submitFoodBanner() {
    const input = document.getElementById('food-banner-input');
    const food = input.value.trim();
    if (!food) return;
    await addFoodItem(food);
    input.value = '';
    document.getElementById('food-log-banner').innerHTML = '';
}

async function dismissFoodBanner() {
    await markFoodLogDone();
    document.getElementById('food-log-banner').innerHTML = '';
    loadDashboard();
}

// --- Food Log (today + past days, expandable further back) ---

let foodLogDaysBack = 3;

// Which single date (if any) currently has its item list expanded into the
// editable view — either 'today' or a past day, toggled via the per-day Edit
// affordance. Only one day is editable at a time to keep the list simple.
let _foodEditingDate = null;
// Which item index within _foodEditingDate is mid inline-edit (text field open).
let _foodEditingItemIdx = null;

function foodItemsForDate(date) {
    const dayData = D.health_data.find(d => d.date === date);
    return dayData && dayData.food_notes ? dayData.food_notes.split(';').map(f => f.trim()).filter(Boolean) : [];
}

function toggleFoodDayEdit(date) {
    _foodEditingDate = (_foodEditingDate === date) ? null : date;
    _foodEditingItemIdx = null;
    renderFoodLog();
}

async function saveFoodItemsForDate(date, foods) {
    await fetch('/api/food/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, food_notes: foods.join('; ') })
    });
    loadDashboard();
}

function editFoodItemInline(idx) {
    _foodEditingItemIdx = idx;
    renderFoodLog();
    document.getElementById('food-item-edit-input')?.focus();
}

function cancelFoodItemInline() {
    _foodEditingItemIdx = null;
    renderFoodLog();
}

async function saveFoodItemInline(date, idx) {
    const input = document.getElementById('food-item-edit-input');
    const val = input ? input.value.trim() : '';
    const foods = foodItemsForDate(date);
    if (val) foods[idx] = val; else foods.splice(idx, 1);   // saving blank = delete
    _foodEditingItemIdx = null;
    await saveFoodItemsForDate(date, foods);
}

async function deleteFoodItem(date, idx) {
    const foods = foodItemsForDate(date);
    foods.splice(idx, 1);
    await saveFoodItemsForDate(date, foods);
}

function renderFoodLog() {
    const el = document.getElementById('food-log-area');
    const today = todayStr();
    const earliest = (D.health_data && D.health_data.length) ? D.health_data[0].date : today;

    const dates = [];
    for (let i = foodLogDaysBack; i >= 0; i--) {
        const d = new Date(today + 'T12:00:00');
        d.setDate(d.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        if (ds < earliest) continue;   // don't show days before any data exists
        dates.push(ds);
    }

    const safetyTags = D.kitchen_safety_tags || {};
    const foodBadge = (item) => {
        const lower = item.toLowerCase();
        let c = '';
        // User-set safety tags take priority over the hardcoded guide.
        const tag = safetyTags[lower];
        if (tag === 'inflammatory') c = '#c2185b';
        else if (tag === 'suspect') c = 'var(--orange)';
        else if (tag === 'safe') c = 'var(--green)';
        else if (D.food_guide.hurts.some(h => lower.includes(h) || h.includes(lower))) c = 'var(--red)';
        else if (D.food_guide.unsure.some(u => lower.includes(u) || u.includes(lower))) c = 'var(--yellow)';
        else if (D.food_guide.safe.some(s => lower.includes(s) || s.includes(lower))) c = 'var(--green)';
        return c ? `<span class="food-badge" style="background:${c}"></span>` : '';
    };

    // Renders a date's items as an editable list: tap text to fix a typo,
    // tap × to delete. Used for whichever single day is currently expanded
    // (today by default has its own "Edit" toggle same as any past day).
    const renderEditableItems = (date, foods) => {
        if (!foods.length) return '<div style="font-size:13px;color:var(--text-muted);font-style:italic;padding:4px 0">No food logged</div>';
        return foods.map((item, idx) => {
            if (_foodEditingItemIdx === idx) {
                return `<div class="card-item food-item-editing">
                    <input type="text" id="food-item-edit-input" class="food-item-input" value="${esc(item)}" onkeydown="if(event.key==='Enter')saveFoodItemInline('${date}',${idx});if(event.key==='Escape')cancelFoodItemInline()">
                    <button class="food-item-save" onclick="saveFoodItemInline('${date}',${idx})" title="Save">&#10003;</button>
                    <button class="delete-btn food-item-del" onclick="cancelFoodItemInline()" title="Cancel">&times;</button>
                </div>`;
            }
            return `<div class="card-item">
                <span class="item-text" onclick="editFoodItemInline(${idx})" style="cursor:pointer">${foodBadge(item)}${esc(item)}</span>
                <button class="delete-btn food-item-del" onclick="deleteFoodItem('${date}',${idx})" title="Delete">&times;</button>
            </div>`;
        }).join('');
    };

    let html = '';

    // Earlier-days controls
    const canExpand = dates.length && dates[0] > earliest;
    const canCollapse = foodLogDaysBack > 3;
    if (canExpand || canCollapse) {
        html += '<div style="display:flex;justify-content:center;gap:8px;margin-bottom:8px">';
        if (canExpand) html += `<button onclick="showEarlierFood()" class="food-log-more-btn">&#8593; Show earlier days</button>`;
        if (canCollapse) html += `<button onclick="hideEarlierFood()" class="food-log-more-btn">&#8595; Hide earlier days</button>`;
        html += '</div>';
    }

    // Past days: compact one-liners (oldest first, today rendered separately below);
    // tapping "Edit" expands a day into the same editable list Today uses.
    const pastDates = dates.filter(d => d !== today);
    if (pastDates.length) {
        html += '<div class="card" style="border-left-color:var(--ongoing);margin-bottom:8px;padding:6px 12px">';
        pastDates.forEach(date => {
            const foods = foodItemsForDate(date);
            const label = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            if (_foodEditingDate === date) {
                html += `<div style="padding:6px 0;border-top:1px solid var(--border)">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                        <span style="color:var(--text-secondary);font-weight:600;font-size:13px">${label}</span>
                        <button class="food-day-edit-btn" onclick="toggleFoodDayEdit('${date}')">Done</button>
                    </div>
                    ${renderEditableItems(date, foods)}
                </div>`;
            } else {
                const foodsHtml = foods.length
                    ? foods.map(item => `${foodBadge(item)}${esc(item)}`).join('<span style="color:var(--text-muted)">, </span>')
                    : '<span style="color:var(--text-muted);font-style:italic">—</span>';
                html += `<div style="display:flex;gap:10px;padding:4px 0;border-top:1px solid var(--border);font-size:13px;line-height:1.4;align-items:center">
                    <span style="color:var(--text-secondary);font-weight:600;white-space:nowrap;min-width:70px">${label}</span>
                    <span style="flex:1">${foodsHtml}</span>
                    <button class="food-day-edit-btn" onclick="toggleFoodDayEdit('${date}')" title="Edit this day's food log">Edit</button>
                </div>`;
            }
        });
        html += '</div>';
    }

    // Today: full card with add box; items are editable via the same Edit toggle.
    const todayFoods = foodItemsForDate(today);
    const todayEditing = _foodEditingDate === today;
    html += `<div class="card" style="border-left-color:var(--ongoing);margin-bottom:8px">`;
    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:12px;font-weight:600;color:var(--green)">Today</span>
        ${todayFoods.length ? `<button class="food-day-edit-btn" onclick="toggleFoodDayEdit('${today}')">${todayEditing ? 'Done' : 'Edit'}</button>` : ''}
    </div>`;
    if (todayEditing) {
        html += renderEditableItems(today, todayFoods);
    } else {
        todayFoods.forEach(item => {
            html += `<div class="card-item"><span class="item-text">${foodBadge(item)}${esc(item)}</span></div>`;
        });
    }
    html += `<div style="margin-top:8px;display:flex;gap:8px">
        <input type="text" id="food-input" placeholder="What did you eat..." style="flex:1;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)" onkeydown="if(event.key==='Enter')addFood()">
        <button onclick="addFood()" style="padding:7px 16px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Add</button>
    </div>`;
    html += '</div>';

    el.innerHTML = html;
}

function showEarlierFood() {
    foodLogDaysBack += 7;
    renderFoodLog();
}

function hideEarlierFood() {
    foodLogDaysBack = 3;
    renderFoodLog();
}

async function addFood() {
    const input = document.getElementById('food-input');
    const food = input.value.trim();
    if (!food) return;
    await addFoodItem(food);
    input.value = '';
}

async function markFoodLogDone() {
    const today = todayStr();
    const todayLog = (D.habits_log || {})[today] || {};
    const section = habitSectionOf('Log new or flagged foods');
    if (!todayLog[habitKey(section, 'Log new or flagged foods')]) {
        await fetch('/api/habits/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ habit: 'Log new or flagged foods', section })
        });
    }
}

async function addFoodItem(food) {
    await fetch('/api/food/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ food })
    });
    await markFoodLogDone();
    loadDashboard();
}

