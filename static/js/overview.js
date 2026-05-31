// overview.js — dot grid, daily overview, meetings

let gridSelectedCol = null;
let gridSelectedRow = null;

function renderDotGrid() {
    const el = document.getElementById('dot-grid');
    if (D._frost && D._frost.health_data) { el.innerHTML = frostedCard('Symptoms & Energy', 5); return; }
    const data = D.health_data;
    if (!data.length) { el.innerHTML = '<p style="color:var(--text-muted)">No health data yet.</p>'; return; }

    const gray = '#ddd';

    // Pre-compute nose_spray streaks so we can flag 3+ consecutive days
    const noseSprayStreak = data.map(() => false);
    let _run = 0;
    data.forEach((d, i) => {
        if (d.nose_spray === true) _run++; else _run = 0;
        if (_run >= 3) {
            for (let j = i - _run + 1; j <= i; j++) noseSprayStreak[j] = true;
        }
    });

    const metrics = [
        { name: 'Energy', fn: (d, i) => {
            if (d.energy == null) return [gray, 'No data'];
            return [{0:'var(--red)',1:'var(--orange)',2:'var(--yellow)',3:'var(--green)'}[d.energy]||gray,
                    {0:'Crashed',1:'Low',2:'Okay',3:'Great'}[d.energy]||''];
        }},
        ...['Nose','Brain Fog','Abdomen','Hands','Headache'].map(name => {
            const col = {Nose:'nose_congestion','Brain Fog':'brain_fog',Abdomen:'abdominal_pain',Hands:'hand_pain',Headache:'headache'}[name];
            return { name, fn: (d, i) => {
                const v = d[col];
                if (v == null) return [gray, 'No data'];
                return [{0:'var(--green)',1:'var(--yellow)',2:'var(--orange)',3:'var(--red)'}[v]||gray,
                        {0:'None',1:'Mild',2:'Moderate',3:'Bad'}[v]||''];
            }};
        }),
        { name: 'Nasal spray', toggle: true, fn: (d, i) => {
            if (d.nose_spray == null) return [gray, 'Not used'];
            if (d.nose_spray !== true) return [gray, 'Not used'];
            if (noseSprayStreak[i]) return ['var(--orange)', 'Used — 3+ day streak (breathing flag)'];
            return ['var(--accent)', 'Used'];
        }},
    ];

    let html = '<table id="symptom-table">';
    // Date row
    html += '<tr><td class="metric-label" style="background:var(--bg)"></td>';
    data.forEach((d, ci) => { html += `<td class="date-label" data-col="${ci}">${d.date_short.split(' ')[0]}<br>${d.date_short.split(' ')[1]}</td>`; });
    html += '</tr>';

    metrics.forEach((m, ri) => {
        html += `<tr data-row="${ri}"><td class="metric-label">${m.name}</td>`;
        data.forEach((d, ci) => {
            const [color, tip] = m.fn(d, ci);
            const click = m.toggle
                ? `toggleNoseSpray('${d.date}', ${d.nose_spray === true})`
                : `selectGridCell(${ci},'${d.date}',${ri})`;
            const tipText = m.toggle ? `${tip} — click to toggle` : tip;
            html += `<td data-col="${ci}" data-row="${ri}"><div class="dot" style="background:${color}" title="${d.date_short}: ${tipText}" onclick="${click}"></div></td>`;
        });
        html += '</tr>';
    });

    html += '</table>';

    el.innerHTML = html;

    // Auto-scroll to most recent
    el.scrollLeft = el.scrollWidth;

    // Render key to the right
    const keyEl = document.getElementById('dot-grid-key');
    const keys = [
        ['var(--green)', 'None / Good'],
        ['var(--yellow)', 'Mild / Low'],
        ['var(--orange)', 'Moderate'],
        ['var(--red)', 'Bad / Severe'],
        [gray, 'No data'],
    ];
    let khtml = '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap">';
    keys.forEach(([c, label]) => {
        khtml += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><div class="dot" style="width:10px;height:10px;background:${c};cursor:default"></div>${label}</div>`;
    });
    // Nasal spray sub-key
    khtml += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)"><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Nasal spray</div>';
    [['var(--accent)', 'Used'], ['var(--orange)', '3+ day streak']].forEach(([c, label]) => {
        khtml += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><div class="dot" style="width:10px;height:10px;background:${c};cursor:default"></div>${label}</div>`;
    });
    khtml += '</div></div>';
    keyEl.innerHTML = khtml;

    // Auto-select last day
    const lastCol = data.length - 1;
    if (lastCol >= 0) {
        gridSelectedCol = lastCol;
        const tbl = document.getElementById('symptom-table');
        tbl.querySelectorAll(`td[data-col="${lastCol}"]`).forEach(td => td.classList.add('col-highlight'));
    }

    // Column hover highlighting
    const hoverTbl = document.getElementById('symptom-table');
    if (hoverTbl) {
        hoverTbl.querySelectorAll('td[data-col]').forEach(td => {
            td.addEventListener('mouseenter', () => {
                const col = td.dataset.col;
                hoverTbl.querySelectorAll(`td[data-col="${col}"]`).forEach(c => c.classList.add('col-hover'));
            });
            td.addEventListener('mouseleave', () => {
                const col = td.dataset.col;
                hoverTbl.querySelectorAll(`td[data-col="${col}"]`).forEach(c => c.classList.remove('col-hover'));
            });
        });
    }
}

async function toggleNoseSpray(dateStr, currentlyUsed) {
    await fetch('/api/symptoms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr, symptoms: { nose_spray: currentlyUsed ? 0 : 1 } })
    });
    loadDashboard();
}

function selectGridCell(col, dateStr, row) {
    // Toggle off if same column
    if (gridSelectedCol === col) {
        gridSelectedCol = null;
    } else {
        gridSelectedCol = col;
    }

    // Highlight column
    const table = document.getElementById('symptom-table');
    table.querySelectorAll('td').forEach(td => td.classList.remove('col-highlight'));
    if (gridSelectedCol !== null) {
        table.querySelectorAll(`td[data-col="${gridSelectedCol}"]`).forEach(td => td.classList.add('col-highlight'));
    }

    // Show diet detail
    const el = document.getElementById('diet-detail');
    if (gridSelectedCol === null) { el.innerHTML = ''; return; }

    const data = D.health_data;
    const idx = data.findIndex(d => d.date === dateStr);
    if (idx === -1) { el.innerHTML = ''; return; }

    const start = Math.max(0, idx - 3);
    const slice = data.slice(start, idx + 1).reverse();

    let html = '<div style="margin-top:12px;padding:12px 16px;background:var(--card-bg);border-radius:8px;border-left:4px solid var(--ongoing);box-shadow:0 1px 3px rgba(0,0,0,0.06)">';
    slice.forEach(d => {
        const foods = d.food_notes ? d.food_notes.split(';').map(f => f.trim()).filter(Boolean) : [];
        const label = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const isSel = d.date === dateStr;
        html += `<div style="margin-bottom:8px;${isSel ? 'font-weight:600' : 'opacity:0.7'}">`;
        html += `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:2px">${label}</div>`;
        if (foods.length) {
            html += `<div style="font-size:14px;color:var(--text)">${foods.join('; ')}</div>`;
        } else {
            html += `<div style="font-size:14px;color:var(--text-muted);font-style:italic">No food logged</div>`;
        }
        html += '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
}

function renderDayPicker() {
    const sel = document.getElementById('day-picker');
    sel.innerHTML = D.health_data.map((d, i) =>
        `<option value="${i}" ${i === D.health_data.length-1 ? 'selected' : ''}>${d.date_short} (${d.day_name})</option>`
    ).join('');
}

function renderDailyOverview() {
    const el = document.getElementById('daily-overview');
    const idx = parseInt(document.getElementById('day-picker').value);
    const day = D.health_data[idx];
    if (!day) { el.innerHTML = ''; return; }

    // Symptoms
    let sympHTML = '';
    const sleepColors = {1:'var(--red)',2:'var(--orange)',3:'var(--green)',4:'#27ae60'};
    if (day.sleep_quality) {
        const sc = sleepColors[day.sleep_score] || 'var(--text-muted)';
        sympHTML += `<div class="symptom-bar" style="border-left-color:${sc};background:${sc}15"><b>Sleep:</b> ${esc(day.sleep_quality)}</div>`;
    }
    const symptomCols = [
        ['energy','Energy',{0:'Crashed',1:'Low',2:'Okay',3:'Great'},{0:'var(--red)',1:'var(--orange)',2:'var(--yellow)',3:'var(--green)'}],
        ['nose_congestion','Nose',{0:'None',1:'Mild',2:'Moderate',3:'Bad'},{0:'#888',1:'var(--yellow)',2:'var(--orange)',3:'var(--red)'}],
        ['brain_fog','Brain Fog',{0:'None',1:'Mild',2:'Moderate',3:'Bad'},{0:'#888',1:'var(--yellow)',2:'var(--orange)',3:'var(--red)'}],
        ['abdominal_pain','Abdomen',{0:'None',1:'Mild',2:'Moderate',3:'Bad'},{0:'#888',1:'var(--yellow)',2:'var(--orange)',3:'var(--red)'}],
        ['hand_pain','Hands',{0:'None',1:'Mild',2:'Moderate',3:'Bad'},{0:'#888',1:'var(--yellow)',2:'var(--orange)',3:'var(--red)'}],
        ['headache','Headache',{0:'None',1:'Mild',2:'Moderate',3:'Bad'},{0:'#888',1:'var(--yellow)',2:'var(--orange)',3:'var(--red)'}],
    ];
    let hasSymptom = false;
    symptomCols.forEach(([col, name, labels, colors]) => {
        const v = day[col];
        if (v == null) return;
        if (col !== 'energy' && v === 0) return;
        hasSymptom = true;
        const c = colors[v] || '#888';
        sympHTML += `<div class="symptom-bar" style="border-left-color:${c};background:${c}15"><b>${name}:</b> ${labels[v]}</div>`;
    });
    if (day.nose_spray) {
        hasSymptom = true;
        sympHTML += `<div class="symptom-bar" style="border-left-color:var(--ongoing);background:var(--ongoing)15"><b>Nose spray:</b> Used</div>`;
    }
    if (!sympHTML) sympHTML = '<div style="color:var(--text-muted);font-size:14px">No symptom data</div>';

    // Context
    let ctxHTML = '';
    if (day.exercised) {
        const t = day.exercise_type || 'yes';
        const m = day.exercise_minutes ? ` (${day.exercise_minutes} min)` : '';
        ctxHTML += `<div style="font-size:14px;margin-bottom:4px"><b>Exercise:</b> ${esc(t)}${m}</div>`;
    } else {
        ctxHTML += '<div style="font-size:14px;color:var(--text-muted);margin-bottom:4px">No exercise</div>';
    }
    if (day.wakeups) {
        ctxHTML += `<div style="font-size:14px;margin-bottom:4px"><b>Wakeups:</b> ${esc(String(day.wakeups))}</div>`;
        if (day.wakeup_notes) ctxHTML += `<div style="font-size:13px;color:var(--text-muted)">${esc(day.wakeup_notes)}</div>`;
    }
    if (day.food_spend) ctxHTML += `<div style="font-size:14px"><b>Food spend:</b> ${esc(String(day.food_spend))}</div>`;

    el.innerHTML = `
        <div class="overview-card"><h3>How You Felt</h3>${sympHTML}</div>
        <div class="overview-card"><h3>Day Context</h3>${ctxHTML || '<div style="color:var(--text-muted);font-size:14px">No context data</div>'}</div>`;
}

