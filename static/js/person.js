// person.js — the person page (/person/<slug>): impression, heat map, story,
// receipts. Loaded inside the journal iframe. Depends on md.js (mdToHtml,
// entityHue) being loaded first.

const JOURNAL_PATH = '/journal-view';
let SLUG = null;

function personSlug() {
    const parts = location.pathname.split('/').filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || '');
}

function pEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "Mon YYYY" — e.g. "Feb 2026".
function monthYear(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Ask the app shell to open the Files tab (keeper memory) on this file.
// Fall back to a direct nav if we're ever loaded outside the shell.
function openKeeperFile(path) {
    if (!path) return;
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'open-keeper', path }, location.origin);
    } else {
        location.href = '/keeper#' + encodeURIComponent(path);
    }
}

function goToJournalDate(date) {
    location.href = JOURNAL_PATH + '?date=' + encodeURIComponent(date);
}

// Route [data-nav] taps the same way journal.html's popover does.
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-nav]');
    if (!el) return;
    const nav = el.dataset.nav;
    const idx = nav.indexOf(':');
    const kind = nav.slice(0, idx), val = nav.slice(idx + 1);
    if (kind === 'journal') goToJournalDate(val);
    else if (kind === 'keeper') openKeeperFile(val);
});

async function loadPerson() {
    SLUG = personSlug();
    try {
        const resp = await fetch('/api/person/' + encodeURIComponent(SLUG));
        const data = await resp.json();
        if (data.error) {
            document.getElementById('loading').textContent = "Couldn't load this person.";
            return;
        }
        renderPerson(data);
    } catch (e) {
        document.getElementById('loading').textContent = "Couldn't load this person.";
    }
}

function renderPerson(data) {
    const p = data.person || {};
    const stats = data.stats || {};
    const hue = entityHue(SLUG);
    const color = `hsl(${hue} 70% 66%)`;

    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = '';

    const nameEl = document.getElementById('pName');
    nameEl.textContent = p.name || SLUG;
    nameEl.style.color = color;
    if (p.name) document.title = p.name;

    let meta = '';
    if (p.tags && p.tags.length) {
        meta += p.tags.map(t => `<span class="p-tag">#${pEsc(t)}</span>`).join('');
    }
    if (stats.first_date && stats.last_date) {
        meta += (meta ? ' &middot; ' : '') +
            `<span class="phdr-dates">${monthYear(stats.first_date)} &ndash; ${monthYear(stats.last_date)}</span>`;
    }
    document.getElementById('pMeta').innerHTML = meta;

    const openFileBtn = document.getElementById('openFileBtn');
    if (p.file) {
        openFileBtn.style.display = '';
        openFileBtn.onclick = () => openKeeperFile(p.file);
    } else {
        openFileBtn.style.display = 'none';
    }

    renderFacts(p);
    renderImpression(p);
    renderHeatmap(data.days || [], hue);
    renderStory(p);
    renderReceipts(p, data.mentions || [], data.card_view);
}

const SEED_FACTS = ['relationship', 'age', 'lives', 'work'];
const RESERVED_KEYS = new Set(['tags', 'aliases']);

function renderFacts(p) {
    const el = document.getElementById('factsBody');
    if (!el) return;
    const facts = p.facts || {};

    function saveFacts(updatedFacts) {
        return fetch(`/api/person/${encodeURIComponent(SLUG)}/facts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ facts: updatedFacts }),
        })
        .then(r => r.json())
        .then(data => {
            if (data.error) { alert(data.error); return null; }
            return data.facts;
        });
    }

    function buildCurrentFacts() {
        const rows = el.querySelectorAll('[data-fact-key]');
        const result = {};
        rows.forEach(row => {
            const key = row.dataset.factKey;
            const valEl = row.querySelector('.pf-value');
            if (valEl) result[key] = valEl.textContent;
        });
        // Also include seed facts not yet shown (will be empty strings)
        for (const k of SEED_FACTS) {
            if (!(k in result)) result[k] = '';
        }
        return result;
    }

    function startEdit(rowEl, key, currentVal) {
        rowEl.classList.add('pf-row-editing');
        rowEl.classList.remove('pf-row');
        rowEl.innerHTML = `
            <span class="pf-label">${pEsc(key.charAt(0).toUpperCase() + key.slice(1))}</span>
            <input class="pf-input" value="${pEsc(currentVal)}" placeholder="add…" />
            <button class="pf-btn" title="Save">✓</button>
            <button class="pf-btn pf-cancel" title="Cancel">×</button>
        `;
        const input = rowEl.querySelector('input');
        const saveBtn = rowEl.querySelector('.pf-btn:not(.pf-cancel)');
        const cancelBtn = rowEl.querySelector('.pf-cancel');
        input.focus();
        input.select();

        function doSave() {
            const allFacts = buildCurrentFacts();
            allFacts[key] = input.value;
            saveFacts(allFacts).then(newFacts => {
                if (newFacts !== null) {
                    p.facts = newFacts;
                    renderFacts(p);
                }
            });
        }
        saveBtn.addEventListener('click', doSave);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') doSave();
            if (e.key === 'Escape') renderFacts(p);
        });
        cancelBtn.addEventListener('click', () => renderFacts(p));
    }

    let html = '';

    // Seed fields always appear
    const shownKeys = new Set();
    const allKeys = [...SEED_FACTS];
    for (const k of Object.keys(facts)) {
        if (!allKeys.includes(k)) allKeys.push(k);
    }

    const rows = allKeys.map(key => {
        const val = facts[key] || '';
        shownKeys.add(key);
        if (val) {
            return `<div class="pf-row" data-fact-key="${pEsc(key)}">
                <span class="pf-label">${pEsc(key.charAt(0).toUpperCase() + key.slice(1))}</span>
                <span class="pf-value">${pEsc(val)}</span>
            </div>`;
        } else {
            return `<div class="pf-row" data-fact-key="${pEsc(key)}">
                <span class="pf-label">${pEsc(key.charAt(0).toUpperCase() + key.slice(1))}</span>
                <span class="pf-placeholder">add…</span>
            </div>`;
        }
    });

    html = rows.join('');
    html += `<div class="pf-add-row" id="pfAddRow">
        <button class="pf-add-btn" id="pfAddBtn">+ add fact</button>
    </div>`;

    el.innerHTML = html;

    // Wire up row taps for editing
    el.querySelectorAll('.pf-row[data-fact-key]').forEach(row => {
        row.addEventListener('click', () => {
            const key = row.dataset.factKey;
            const valEl = row.querySelector('.pf-value');
            const currentVal = valEl ? valEl.textContent : '';
            startEdit(row, key, currentVal);
        });
    });

    // Wire up "add fact" button
    const addBtn = document.getElementById('pfAddBtn');
    const addRow = document.getElementById('pfAddRow');
    if (addBtn && addRow) {
        addBtn.addEventListener('click', () => {
            addRow.innerHTML = `
                <input class="pf-key-input" placeholder="field name" />
                <input class="pf-input" placeholder="value" style="flex:1" />
                <button class="pf-btn" title="Save">✓</button>
                <button class="pf-btn pf-cancel" title="Cancel">×</button>
            `;
            const keyInput = addRow.querySelector('.pf-key-input');
            const valInput = addRow.querySelector('.pf-input');
            const saveBtn = addRow.querySelector('.pf-btn:not(.pf-cancel)');
            const cancelBtn = addRow.querySelector('.pf-cancel');
            keyInput.focus();

            function doAddSave() {
                const newKey = keyInput.value.trim().toLowerCase();
                const newVal = valInput.value.trim();
                if (!newKey) { keyInput.focus(); return; }
                if (RESERVED_KEYS.has(newKey)) {
                    alert(`"${newKey}" is a reserved key`);
                    return;
                }
                const allFacts = buildCurrentFacts();
                allFacts[newKey] = newVal;
                saveFacts(allFacts).then(newFacts => {
                    if (newFacts !== null) {
                        p.facts = newFacts;
                        renderFacts(p);
                    }
                });
            }
            saveBtn.addEventListener('click', doAddSave);
            valInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') doAddSave();
                if (e.key === 'Escape') renderFacts(p);
            });
            keyInput.addEventListener('keydown', e => {
                if (e.key === 'Escape') renderFacts(p);
            });
            cancelBtn.addEventListener('click', () => renderFacts(p));
        });
    }
}

function renderImpression(p) {
    const body = document.getElementById('impressionBody');
    const text = (p.impression || '').trim();
    body.innerHTML = text ? mdToHtml(text) : '<p class="p-empty">No impression written yet.</p>';
}

// Story is the file's narrative body, minus the "Referenced In" tail (that's
// the same data the Receipts section below renders, structured).
function renderStory(p) {
    const body = document.getElementById('storyBody');
    let text = p.body || '';
    const idx = text.search(/^##\s+Referenced In/im);
    if (idx !== -1) text = text.slice(0, idx);
    text = text.trim();
    body.innerHTML = text ? mdToHtml(text) : '<p class="p-empty">Nothing written yet.</p>';
}

function renderReceipts(p, mentions, cardView) {
    const el = document.getElementById('receiptsList');
    let html = '';

    const entries = (p.entries || []).slice().reverse();
    if (entries.length) {
        html += `<div class="p-subhead">In their file &middot; ${entries.length}</div>`;
        for (const en of entries) {
            html += `<button class="p-row" data-nav="journal:${pEsc(en.date)}">
                <span class="p-row-date">${pEsc(en.date)}</span>${en.note ? ` <span class="p-row-note">${pEsc(en.note)}</span>` : ''}
            </button>`;
        }
    }

    if (mentions.length) {
        html += `<div class="p-subhead">Mentioned elsewhere &middot; ${mentions.length}</div>`;
        for (const m of mentions) {
            const nav = (m.file.startsWith('Journal/Daily/') && m.date) ? `journal:${m.date}` : `keeper:${m.file}`;
            const badge = m.count ? `<span class="p-badge">&times;${m.count}</span>` : '';
            html += `<button class="p-row" data-nav="${pEsc(nav)}">
                ${badge}
                <span class="p-row-date">${pEsc(m.label)}</span>
                <span class="p-row-snip">${pEsc(m.snippet)}</span>
            </button>`;
        }
    }

    if (cardView) {
        html += `<button class="p-row p-row-cardview" data-nav="keeper:${pEsc(cardView)}">Card view (verbatim receipts) &rarr;</button>`;
    }

    if (!entries.length && !mentions.length) {
        html += `<div class="p-empty">No references recorded yet.</div>`;
    }

    el.innerHTML = html;
}

// --- Heat map: GitHub-contributions style, weeks as columns, Mon-Sun rows ---
function renderHeatmap(days, hue) {
    const wrap = document.getElementById('heatmapWrap');
    if (!days.length) { wrap.innerHTML = '<p class="p-empty">No activity yet.</p>'; return; }

    const counts = new Map(days.map(d => [d.date, d.count]));
    const sortedDates = days.map(d => d.date).slice().sort();
    const first = new Date(sortedDates[0] + 'T12:00:00');
    const last = new Date(sortedDates[sortedDates.length - 1] + 'T12:00:00');

    const dow = (d) => (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
    const start = new Date(first); start.setDate(start.getDate() - dow(first));
    const end = new Date(last); end.setDate(end.getDate() + (6 - dow(last)));

    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const maxCount = Math.max(0, ...days.map(d => d.count || 0));
    const bucket = (c) => {
        if (!c) return 0;
        if (maxCount <= 1) return 4;
        const r = c / maxCount;
        return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
    };
    const LEVEL_L = { 1: 60, 2: 48, 3: 38, 4: 26 };

    const weeks = [];
    const monthLabels = [];
    let week = [];
    let prevMonth = null;
    const cur = new Date(start);
    while (cur <= end) {
        if (week.length === 0) {
            const m = cur.getMonth();
            if (m !== prevMonth) {
                monthLabels.push({ week: weeks.length, label: cur.toLocaleDateString('en-US', { month: 'short' }) });
                prevMonth = m;
            }
        }
        const dateStr = fmt(cur);
        week.push({ date: dateStr, count: counts.get(dateStr) || 0 });
        if (week.length === 7) { weeks.push(week); week = []; }
        cur.setDate(cur.getDate() + 1);
    }
    if (week.length) weeks.push(week);

    let html = '<div class="heatmap-scroll" id="heatmapScroll"><div class="heatmap-inner">';
    html += '<div class="hm-months">';
    weeks.forEach((w, i) => {
        const lbl = monthLabels.find(m => m.week === i);
        html += `<div class="hm-month-col">${lbl ? pEsc(lbl.label) : ''}</div>`;
    });
    html += '</div><div class="heatmap-grid">';
    weeks.forEach(w => {
        html += '<div class="hm-week">';
        w.forEach(cell => {
            const lvl = bucket(cell.count);
            const bg = lvl === 0 ? 'var(--hm-empty)' : `hsl(${hue} 70% ${LEVEL_L[lvl]}%)`;
            html += `<div class="hm-cell" style="background:${bg}" title="${cell.date} &middot; ${cell.count} mentions" data-date="${cell.date}"></div>`;
        });
        html += '</div>';
    });
    html += '</div></div></div>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('.hm-cell').forEach(el => {
        el.addEventListener('click', () => goToJournalDate(el.dataset.date));
    });

    // Pin the scroll to the newest (right) side on load, same as overview.js's
    // dot grid — do it now and again next frame since scrollWidth isn't final
    // until layout settles.
    const scrollEl = document.getElementById('heatmapScroll');
    scrollEl.scrollLeft = scrollEl.scrollWidth;
    requestAnimationFrame(() => { scrollEl.scrollLeft = scrollEl.scrollWidth; });
}

// --- Regenerate impression: spawn (or reuse) the "person" tmux session server-side,
// then deep-link the same way the todo-triage button does. ---
async function regenerateImpression() {
    const btn = document.getElementById('regenBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Regenerating…'; }
    let sessionName = 'person';
    try {
        const resp = await fetch(`/api/person/${encodeURIComponent(SLUG)}/summarize`, { method: 'POST' });
        const data = await resp.json();
        if (data && data.session) sessionName = data.session;
    } catch (e) { /* still try to open — the session tab is there either way */ }
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'openTerminalSession', name: sessionName }, location.origin);
    } else {
        window.location.href = '/phone?session=' + encodeURIComponent(sessionName);
    }
    if (btn) setTimeout(() => { btn.disabled = false; btn.textContent = 'Regenerate impression'; }, 1500);
}
