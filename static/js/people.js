// people.js — the /people roster page: a browsable, filterable, sortable list
// over the same Person dicts the deep /person/<slug> page uses, fed by the
// lightweight /api/people/roster endpoint (no vault-wide mention scan — see
// routes/entities.py's people_roster()). All binning/sorting/filtering here is
// client-side; the server just hands over each person's entry dates + latest note.

let PEOPLE = [];
let ALL_TAGS = [];

const STATE = {
    sort: 'recent',       // 'recent' | 'most' | 'alpha'
    tags: new Set(),      // lowercased tag names, plus '__untagged__'
    expanded: null,       // id of the one expanded row, or null
    now: new Date(),      // computed once at load ("now" is a client concept here)
};

const SORT_CYCLE = ['recent', 'most', 'alpha'];
const SORT_LABELS = { recent: 'Recent', most: 'Most mentioned', alpha: 'A–Z' };

const TIER_ORDER = ['week', 'month', 'earlier', 'quiet', 'none'];
const TIER_LABEL = {
    week: 'This week', month: 'This month', earlier: 'Earlier',
    quiet: 'Quiet', none: 'No mentions yet',
};

function pEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "Mon YYYY" — e.g. "Feb 2026".
function monthYear(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// "Mon D" — e.g. "Jun 2".
function monthDay(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function daysSince(dateStr, now) {
    const d = new Date(dateStr + 'T12:00:00');
    return Math.floor((now - d) / 86400000);
}

// "3d", "2w", "4mo", "1y" — coarser as the gap grows, same spirit as GitHub's
// relative timestamps.
function relLabel(days) {
    if (days <= 0) return 'today';
    if (days < 7) return days + 'd';
    if (days < 31) return Math.max(1, Math.round(days / 7)) + 'w';
    if (days < 365) return Math.max(1, Math.round(days / 30)) + 'mo';
    return Math.max(1, Math.round(days / 365)) + 'y';
}

function lastDateOf(p) {
    return p.dates.length ? p.dates[p.dates.length - 1] : null;
}

function loadState() {
    try {
        const s = localStorage.getItem('peopleRosterSort');
        if (s && SORT_CYCLE.includes(s)) STATE.sort = s;
    } catch (e) {}
    try {
        const t = JSON.parse(localStorage.getItem('peopleRosterTags') || '[]');
        if (Array.isArray(t)) STATE.tags = new Set(t);
    } catch (e) {}
}
function saveSort() { try { localStorage.setItem('peopleRosterSort', STATE.sort); } catch (e) {} }
function saveTags() { try { localStorage.setItem('peopleRosterTags', JSON.stringify([...STATE.tags])); } catch (e) {} }

function computeAllTags() {
    const set = new Set();
    PEOPLE.forEach(p => (p.tags || []).forEach(t => set.add(t.toLowerCase())));
    return [...set].sort();
}

function matchesTags(p, selected) {
    if (!selected.size) return true;
    const tags = (p.tags || []).map(t => t.toLowerCase());
    if (!tags.length) return selected.has('__untagged__');
    return tags.some(t => selected.has(t));
}

async function loadPeopleRoster() {
    loadState();
    try {
        const resp = await fetch('/api/people/roster');
        const data = await resp.json();
        PEOPLE = data.people || [];
    } catch (e) {
        PEOPLE = [];
    }
    ALL_TAGS = computeAllTags();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('list').style.display = '';
    renderControls();
    renderList();
}

function cycleSort() {
    const idx = SORT_CYCLE.indexOf(STATE.sort);
    STATE.sort = SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
    saveSort();
    renderControls();
    renderList();
}

function toggleTag(tag) {
    if (STATE.tags.has(tag)) STATE.tags.delete(tag);
    else STATE.tags.add(tag);
    saveTags();
    renderControls();
    renderList();
}

function renderControls() {
    const el = document.getElementById('controlsRow');
    let html = `<button class="chip sort-chip" id="sortChip">${pEsc(SORT_LABELS[STATE.sort])}</button>`;
    html += `<div class="chip-sep"></div>`;
    ALL_TAGS.forEach(t => {
        const active = STATE.tags.has(t) ? ' active' : '';
        html += `<button class="chip tag-chip${active}" data-tag="${pEsc(t)}">#${pEsc(t)}</button>`;
    });
    const untaggedActive = STATE.tags.has('__untagged__') ? ' active' : '';
    html += `<button class="chip tag-chip${untaggedActive}" data-tag="__untagged__">Untagged</button>`;
    el.innerHTML = html;

    document.getElementById('sortChip').addEventListener('click', cycleSort);
    el.querySelectorAll('.tag-chip').forEach(btn => {
        btn.addEventListener('click', () => toggleTag(btn.dataset.tag));
    });
}

function filteredSorted() {
    let list = PEOPLE.filter(p => matchesTags(p, STATE.tags));
    if (STATE.sort === 'alpha') {
        list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    } else if (STATE.sort === 'most') {
        list = list.slice().sort((a, b) => b.dates.length - a.dates.length || a.name.localeCompare(b.name));
    } else {
        list = list.slice().sort((a, b) => {
            const ad = lastDateOf(a), bd = lastDateOf(b);
            if (!ad && !bd) return a.name.localeCompare(b.name);
            if (!ad) return 1;
            if (!bd) return -1;
            if (ad === bd) return a.name.localeCompare(b.name);
            return bd.localeCompare(ad); // newest first
        });
    }
    return list;
}

function renderList() {
    const el = document.getElementById('list');
    const list = filteredSorted();
    if (!list.length) {
        el.innerHTML = '<div class="pr-empty">No one matches these filters.</div>';
        return;
    }

    if (STATE.sort === 'recent') {
        const groups = { week: [], month: [], earlier: [], quiet: [], none: [] };
        list.forEach(p => {
            const last = lastDateOf(p);
            if (!last) { groups.none.push(p); return; }
            const days = daysSince(last, STATE.now);
            if (days <= 7) groups.week.push(p);
            else if (days <= 31) groups.month.push(p);
            else if (days <= 90) groups.earlier.push(p);
            else groups.quiet.push(p);
        });
        let html = '';
        TIER_ORDER.forEach(key => {
            if (!groups[key].length) return;
            html += `<div class="tier-title">${TIER_LABEL[key]}</div>`;
            html += groups[key].map(renderRow).join('');
        });
        el.innerHTML = html;
    } else {
        el.innerHTML = list.map(renderRow).join('');
    }

    wireRows();
}

function renderRow(p) {
    const last = lastDateOf(p);
    const lastLabel = last ? relLabel(daysSince(last, STATE.now)) : '';
    const expanded = STATE.expanded === p.id;
    let html = `<div class="p-row-item" data-id="${pEsc(p.id)}" role="button" tabindex="0">`;
    html += `<div class="pr-line1"><span class="pr-name">${pEsc(p.name)}</span><span class="pr-lastseen">${pEsc(lastLabel)}</span></div>`;
    html += `<div class="pr-blurb">${pEsc(p.blurb || '')}</div>`;
    if (expanded) html += renderExpanded(p);
    html += `</div>`;
    return html;
}

function statsLine(p) {
    if (!p.dates.length) return '';
    const n = p.dates.length;
    return `${n} day${n === 1 ? '' : 's'} · since ${monthYear(p.dates[0])}`;
}

function renderExpanded(p) {
    let html = `<div class="pr-expanded">`;
    const stats = statsLine(p);
    if (stats) html += `<div class="pr-stats">${pEsc(stats)}</div>`;
    if (p.dates.length) html += sparklineSVG(p.dates, STATE.now);
    if (p.tags && p.tags.length) {
        html += `<div>` + p.tags.map(t => `<span class="p-tag">#${pEsc(t)}</span>`).join('') + `</div>`;
    }
    if (p.last_note) {
        html += `<div class="pr-note">${pEsc(monthDay(p.last_note.date))} &mdash; ${pEsc(p.last_note.note)}</div>`;
    }
    html += `<a class="p-btn pr-open-link" href="/person/${encodeURIComponent(p.id)}">Open person page &rarr;</a>`;
    html += `</div>`;
    return html;
}

function wireRows() {
    document.querySelectorAll('.p-row-item').forEach(row => {
        row.addEventListener('click', () => {
            const id = row.dataset.id;
            STATE.expanded = (STATE.expanded === id) ? null : id;
            renderList();
        });
        row.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
        });
    });
    document.querySelectorAll('.pr-open-link').forEach(a => {
        a.addEventListener('click', e => e.stopPropagation());
    });
}

// --- Monthly-bin sparkline: single series, baseline-anchored bars with
// rounded tops, a continuous stub for zero-mention months. ---
function monthKey(dateStr) { return dateStr.slice(0, 7); }

function monthKeyLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function buildMonthRange(dates, now) {
    if (!dates.length) return [];
    let [y, m] = monthKey(dates[0]).split('-').map(Number);
    const ny = now.getFullYear(), nm = now.getMonth() + 1;
    const months = [];
    while (y < ny || (y === ny && m <= nm)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        m += 1;
        if (m > 12) { m = 1; y += 1; }
    }
    return months;
}

// A bar with only the top corners rounded (a plain rect's radius would also
// round the bottom, which reads oddly sitting flush on the baseline).
function roundedTopBarPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    const bottom = y + h;
    return `M${x},${bottom} L${x},${y + r} Q${x},${y} ${x + r},${y} ` +
        `L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${bottom} Z`;
}

function sparklineSVG(dates, now) {
    const months = buildMonthRange(dates, now);
    if (!months.length) return '';
    const counts = new Map();
    dates.forEach(d => { const k = monthKey(d); counts.set(k, (counts.get(k) || 0) + 1); });
    const maxCount = Math.max(1, ...months.map(k => counts.get(k) || 0));

    const bw = 8, gap = 2, H = 36, maxBarH = 30, stub = 3;
    const totalW = months.length * bw + (months.length - 1) * gap;

    let bars = '';
    months.forEach((k, i) => {
        const c = counts.get(k) || 0;
        const h = c ? Math.max(4, Math.round(maxBarH * (c / maxCount))) : stub;
        const x = i * (bw + gap);
        const y = H - h;
        const fill = c ? 'var(--accent)' : 'var(--hm-empty)';
        const title = `${pEsc(monthKeyLabel(k))} — ${c} day${c === 1 ? '' : 's'}`;
        bars += `<path d="${roundedTopBarPath(x, y, bw, h, 2)}" fill="${fill}"><title>${title}</title></path>`;
    });

    return `<svg class="pr-spark" viewBox="0 0 ${totalW} ${H}" preserveAspectRatio="none">${bars}</svg>`;
}
