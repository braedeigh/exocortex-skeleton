// food.js — food banner, food log, meal defaults

function renderFoodBanner() {
    const el = document.getElementById('food-log-banner');
    const today = todayStr();
    const todayLog = (D.habits_log || {})[today] || {};
    if (todayLog['Log new or flagged foods'] && !expandedAll) { el.innerHTML = ''; return; }

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

// --- Food Log (today + past 3 days) ---

function renderFoodLog() {
    const el = document.getElementById('food-log-area');
    const today = todayStr();

    const dates = [];
    for (let i = 3; i >= 0; i--) {
        const d = new Date(today + 'T12:00:00');
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
    }

    let html = '';

    dates.forEach(date => {
        const isToday = date === today;
        const dayData = D.health_data.find(d => d.date === date);
        const foods = dayData && dayData.food_notes ? dayData.food_notes.split(';').map(f => f.trim()).filter(Boolean) : [];
        const label = isToday ? 'Today' : new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

        html += `<div class="card" style="border-left-color:var(--ongoing);margin-bottom:8px">`;
        html += `<div style="font-size:12px;font-weight:600;color:${isToday ? 'var(--green)' : 'var(--text-secondary)'};margin-bottom:4px">${label}</div>`;

        if (foods.length) {
            foods.forEach(item => {
                const lower = item.toLowerCase();
                let badge = '';
                if (D.food_guide.hurts.some(h => lower.includes(h) || h.includes(lower))) badge = `<span class="food-badge" style="background:var(--red)"></span>`;
                else if (D.food_guide.unsure.some(u => lower.includes(u) || u.includes(lower))) badge = `<span class="food-badge" style="background:var(--yellow)"></span>`;
                else if (D.food_guide.safe.some(s => lower.includes(s) || s.includes(lower))) badge = `<span class="food-badge" style="background:var(--green)"></span>`;
                html += `<div class="card-item"><span class="item-text">${badge}${esc(item)}</span></div>`;
            });
        } else if (!isToday) {
            html += `<div style="font-size:13px;color:var(--text-muted);font-style:italic;padding:4px 0">No food logged</div>`;
        }

        if (isToday) {
            html += `<div style="margin-top:8px;display:flex;gap:8px">
                <input type="text" id="food-input" placeholder="What did you eat..." style="flex:1;padding:7px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;outline:none;background:var(--bg)" onkeydown="if(event.key==='Enter')addFood()">
                <button onclick="addFood()" style="padding:7px 16px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Add</button>
            </div>`;
        }

        html += '</div>';
    });

    el.innerHTML = html;
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
    if (!todayLog['Log new or flagged foods']) {
        await fetch('/api/habits/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ habit: 'Log new or flagged foods' })
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

