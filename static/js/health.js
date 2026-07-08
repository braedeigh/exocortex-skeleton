// health.js — linen/recurring reminder aliases, symptom form
//
// Estradiol used to live here as a bespoke "HRT" engine. It's now a normal
// reminder (data/reminders.json, type "estradiol") rendered by reminders.js —
// no special bar, log, or undo code is needed anymore.

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

// Whether the "Symptoms logged ✓ (edit)" card renders expanded. Starts open
// (so it's discoverable the first time it appears) but is force-collapsed
// after a successful save — the save action should close the card it's in,
// not leave it hanging open. Also kept in sync if the user manually
// re-toggles it via the <details> summary.
let _symptomDetailsOpen = true;

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
            `<button type="button" class="sym-btn${extra}" data-col="${col}" data-val="${v}" title="${esc(symptomTip(col, v))}" onclick="pickSymptom('${col}',${v},this)">${v}</button>`
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
            <button class="submit-btn" onclick="logSymptoms()">${btnLabel}</button>
            <div style="margin-top:10px">
                <a href="/body" onclick="switchTab(event,'body')" style="font-size:12px;color:var(--accent);text-decoration:none">View full symptom tracker ↗</a>
            </div>`;
    }

    if (done && !expandedAll) {
        el.innerHTML = '';
    } else if (done) {
        el.innerHTML = `<details ${_symptomDetailsOpen ? 'open' : ''} class="card-section" style="margin-bottom:20px" ontoggle="_symptomDetailsOpen = this.open">
            <summary style="font-size:14px;font-weight:600;cursor:pointer;color:var(--text-muted)">Symptoms logged &#10003; (edit)</summary>
            <div class="symptom-form" style="margin-top:8px">${formInner('Update')}</div></details>`;
    } else {
        el.innerHTML = `<div class="symptom-form" style="margin-bottom:20px;border-left:4px solid var(--orange)">
            <h3 style="color:var(--orange)">Log today's symptoms</h3>
            ${formInner('Log')}
        </div>`;
    }
}

// --- Symptom tier definitions (shared) ---
const SYMPTOM_DEF_FIELDS = [
    ['energy', 'Energy', ['Crashed', 'Low', 'Okay', 'Great']],
    ['nose_congestion', 'Nose Congestion', ['None', 'Mild', 'Moderate', 'Bad']],
    ['brain_fog', 'Brain Fog', ['None', 'Mild', 'Moderate', 'Bad']],
    ['abdominal_pain', 'Abdominal Pain', ['None', 'Mild', 'Moderate', 'Bad']],
    ['hand_pain', 'Hand Pain', ['None', 'Mild', 'Moderate', 'Bad']],
    ['headache', 'Headache', ['None', 'Mild', 'Moderate', 'Bad']],
];

// The user's custom definition for a symptom level, or the generic fallback.
function symptomTip(col, v) {
    const d = (D.symptom_definitions || {})[col];
    if (d && d[String(v)]) return d[String(v)];
    const generic = col === 'energy' ? ['Crashed', 'Low', 'Okay', 'Great'] : ['None', 'Mild', 'Moderate', 'Bad'];
    return generic[v] || '';
}

function renderSymptomDefinitions() {
    const el = document.getElementById('symptom-definitions-area');
    if (!el) return;
    const defs = D.symptom_definitions || {};
    let html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">What each 0–3 means for you. Saved and shown as tooltips on the symptom buttons.</div>';
    html += '<div style="display:flex;flex-direction:column;gap:12px">';
    SYMPTOM_DEF_FIELDS.forEach(([col, label, hints]) => {
        html += `<div><div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:4px">${label}</div>
            <div style="display:flex;flex-direction:column;gap:4px">`;
        [0, 1, 2, 3].forEach(v => {
            const cur = (defs[col] || {})[String(v)] || '';
            html += `<div style="display:flex;align-items:center;gap:8px">
                <span style="width:18px;text-align:center;font-weight:600;color:var(--text-muted);font-size:12px">${v}</span>
                <input type="text" data-symdef="${col}" data-level="${v}" value="${esc(cur)}" placeholder="${esc(hints[v])}" style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);outline:none">
            </div>`;
        });
        html += '</div></div>';
    });
    html += '</div>';
    html += `<button onclick="saveSymptomDefinitions()" style="margin-top:12px;padding:6px 14px;border:none;border-radius:6px;background:var(--text);color:var(--bg);font-size:12px;font-weight:600;cursor:pointer">Save definitions</button>`;
    el.innerHTML = html;
}

async function saveSymptomDefinitions() {
    const el = document.getElementById('symptom-definitions-area');
    if (!el) return;
    const definitions = {};
    el.querySelectorAll('input[data-symdef]').forEach(inp => {
        const val = inp.value.trim();
        if (!val) return;
        const col = inp.dataset.symdef;
        (definitions[col] = definitions[col] || {})[inp.dataset.level] = val;
    });
    const res = await fetch('/api/symptom-definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitions })
    });
    if (res.ok) {
        D.symptom_definitions = definitions;
        renderSymptomDefinitions();
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
    const res = await fetch('/api/symptoms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: document.getElementById('sym-date').value, symptoms })
    });
    // Auto-close the "Symptoms logged (edit)" card on a successful save so it
    // doesn't sit open after you've just saved it.
    if (res.ok) _symptomDetailsOpen = false;
    loadDashboard();
}
