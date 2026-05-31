// health.js — HRT, linen reminders, symptom form

function renderHRT() {
    const el = document.getElementById('hrt');
    const h = D.hrt;
    if (isFrosted(h)) {
        el.innerHTML = frostedCard('Estradiol', 2);
        return;
    }
    if (!h || h.days_until === undefined || h.days_until === null || h.days_until > 0) {
        if (expandedAll && h.last_formatted) {
            el.innerHTML = `<div style="font-size:14px;color:var(--text-secondary);margin-bottom:12px;padding:10px 16px;background:var(--card-bg);border-radius:8px;border-left:4px solid var(--green);box-shadow:0 1px 3px rgba(0,0,0,0.06)">
                <b>Estradiol</b> &mdash; last: ${h.last_formatted} &middot; next: ${h.next_formatted}
                ${h.prev_last_dose ? `&nbsp;<a href="#" style="color:var(--red);font-size:12px" onclick="event.preventDefault();undoHRT()">undo last</a>` : ''}
            </div>`;
        } else {
            el.innerHTML = '';
        }
        return;
    }

    let status;
    if (h.days_until < 0) {
        status = `OVERDUE by ${Math.abs(h.days_until)} day${Math.abs(h.days_until)!==1?'s':''}`;
    } else {
        status = 'Due today';
    }

    el.innerHTML = `<div class="hrt-bar" style="border-left-color:var(--red);background:var(--red)">
        <div>
            <div style="font-size:18px">Estradiol Shot — ${status}</div>
            <div style="font-size:13px;opacity:0.8;font-weight:400;margin-top:2px">Last: ${h.last_formatted}</div>
        </div>
        <button class="hrt-done-btn" onclick="logHRT()">&#10003; Done</button>
    </div>`;
}

function logHRT() {
    pendingDelete = { type: 'hrt-confirm' };
    document.getElementById('modal-text').innerHTML = `Did you do your estradiol shot?<br>
        <label style="font-size:13px;color:var(--text-secondary);margin-top:8px;display:block">
            Date: <input type="date" id="hrt-date" value="${todayStr()}" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;margin-left:4px">
        </label>`;
    document.getElementById('modal').querySelector('.confirm').textContent = 'Yes, done';
    document.getElementById('modal').classList.add('open');
}

async function undoHRT() {
    await fetch('/api/hrt/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    loadDashboard();
}

// --- Linen / recurring reminders ---
// The reminder pops + manage modal now live in reminders.js (driven by the
// editable data/reminders.json). These thin aliases keep older callers working.
function renderLinenReminders() { renderReminders(); }
function logLinenDone(type) { return logReminderDone(type); }

function todaySymptomsDone() {
    const today = todayStr();
    const todayData = D.health_data.find(d => d.date === today);
    return todayData && todayData.energy !== null;
}

function renderSymptomForm() {
    const el = document.getElementById('symptom-form-area');
    if (todaySymptomsDone() && !expandedAll) { el.innerHTML = ''; return; }

    const done = todaySymptomsDone();
    const symptoms = [
        ['nose_congestion', 'Nose Congestion'], ['brain_fog', 'Brain Fog'],
        ['abdominal_pain', 'Abdominal Pain'], ['hand_pain', 'Hand Pain'],
        ['headache', 'Headache'], ['energy', 'Energy']
    ];
    function btnGroup(col) {
        const extra = col === 'energy' ? ' energy' : '';
        return [0,1,2,3].map(v =>
            `<button type="button" class="sym-btn${extra}" data-col="${col}" data-val="${v}" onclick="pickSymptom('${col}',${v},this)">${v}</button>`
        ).join('');
    }

    const symKey = `<div class="sym-key">
        <span><span class="sk" style="background:var(--green)"></span> 0 None</span>
        <span><span class="sk" style="background:var(--yellow)"></span> 1 Mild</span>
        <span><span class="sk" style="background:var(--orange)"></span> 2 Moderate</span>
        <span><span class="sk" style="background:var(--red)"></span> 3 Bad</span>
    </div>
    <div class="sym-key" style="margin-bottom:16px">
        <span style="font-style:italic;color:var(--text-muted)">Energy: 0 Crashed &middot; 1 Low &middot; 2 Okay &middot; 3 Great</span>
    </div>`;

    function formInner(btnLabel) {
        return `<div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:600;color:var(--text-secondary)">Date</label>
                <input type="date" id="sym-date" class="date-picker" value="${todayStr()}">
            </div>
            ${symKey}
            <div class="symptom-grid">
                ${symptoms.map(([col, label]) =>
                    `<div class="symptom-field"><label>${label}</label>
                    <div class="sym-btn-group" id="sym-${col}">${btnGroup(col)}</div></div>`
                ).join('')}
            </div>
            <div style="margin:12px 0;display:flex;align-items:center;gap:8px">
                <label style="font-size:14px;font-weight:600;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;gap:8px">
                    <input type="checkbox" id="sym-nose-spray" style="width:18px;height:18px;cursor:pointer"> Nose spray used?
                </label>
            </div>
            <button class="submit-btn" onclick="logSymptoms()">${btnLabel}</button>`;
    }

    if (done && !expandedAll) {
        el.innerHTML = '';
    } else if (done) {
        el.innerHTML = `<details open class="card-section" style="margin-bottom:20px">
            <summary style="font-size:14px;font-weight:600;cursor:pointer;color:var(--text-muted)">Symptoms logged &#10003; (edit)</summary>
            <div class="symptom-form" style="margin-top:8px">${formInner('Update')}</div></details>`;
    } else {
        el.innerHTML = `<div class="symptom-form" style="margin-bottom:20px;border-left:4px solid var(--orange)">
            <h3 style="color:var(--orange)">Log today's symptoms</h3>
            ${formInner('Log')}
        </div>`;
    }
}

const _symSelections = {};

function pickSymptom(col, val, btn) {
    _symSelections[col] = val;
    const group = btn.parentElement;
    group.querySelectorAll('.sym-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

async function logSymptoms() {
    const symptoms = {};
    ['nose_congestion','brain_fog','abdominal_pain','hand_pain','headache','energy'].forEach(col => {
        symptoms[col] = _symSelections[col] !== undefined ? _symSelections[col] : 0;
    });
    const noseSpray = document.getElementById('sym-nose-spray')?.checked ? 1 : 0;
    symptoms['nose_spray'] = noseSpray;
    await fetch('/api/symptoms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: document.getElementById('sym-date').value, symptoms })
    });
    loadDashboard();
}
