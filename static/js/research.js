// research.js — the standalone /research place (templates/research.html).
// A flat pool of learning notes; topics are lenses over the pool, not boxes.
// Quick capture at the top, an "Open questions" roll-up, one card per topic
// (active, then dormant, then settled), the Unfiled backstop, the read-only
// Library of research/*.md files, and a "new topic" row.
//
// Self-contained: talks straight to /api/data/research + /api/research/*,
// no dashboard globals (D, loadDashboard, core.js helpers).

const _rsrchInputStyle = 'padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box';

// --- State ---
let R = { topics: [], entries: [] };
let _library = [];
const editingCards = new Set();
let _rsrchComposer = { text: '', kind: 'note', url: '', topics: new Set(), replyTo: null };
let _rsrchSearch = { q: '', mode: 'keyword', hits: null, msg: '' };
const _rsrchAnnotating = new Set();
let pendingDelete = null;

// --- Local helpers (same semantics as core.js's esc/escJs) ---
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function escJs(s) {
    return String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/\r?\n/g, '\\n');
}

function _researchTopics() { return R.topics || []; }
function _researchEntries() { return R.entries || []; }
function _rsrchTopicsById() { return Object.fromEntries(_researchTopics().map(t => [t.id, t])); }

// --- Card open/closed memory (per data-card, localStorage) ---
const RSRCH_OPEN_KEY = 'rsrch-open-cards';
function _openCards() {
    try { return JSON.parse(localStorage.getItem(RSRCH_OPEN_KEY)) || {}; } catch (e) { return {}; }
}
function rsrchCardToggled(d) {
    const map = _openCards();
    map[d.dataset.card] = d.open;
    localStorage.setItem(RSRCH_OPEN_KEY, JSON.stringify(map));
}
function _openAttr(cardId, defaultOpen) {
    const map = _openCards();
    const open = cardId in map ? map[cardId] : defaultOpen;
    return open ? ' open' : '';
}

function toggleEditMode(cardId) {
    if (editingCards.has(cardId)) editingCards.delete(cardId); else editingCards.add(cardId);
    renderResearch();
}

// --- Load + render ---
async function loadResearch() {
    const res = await fetch('/api/data/research');
    if (!res.ok) return;
    const body = await res.json();
    R = body.research || { topics: [], entries: [] };
}

function renderResearch() {
    const el = document.getElementById('research-area');
    if (!el) return;
    el.innerHTML = _rsrchComposerHtml() + _rsrchSearchCard() + _rsrchQuestionsCard() + _rsrchTopicCards()
        + _rsrchUnfiledCard() + _rsrchLibraryCard() + _rsrchNewTopicRow();
}

// --- Quick capture composer ---
const RSRCH_KINDS = [
    ['note', 'Note'], ['source', 'Source'], ['claim', 'Claim'], ['question', 'Question'],
];

function _rsrchComposerHtml() {
    const st = _rsrchComposer;
    const topics = _researchTopics();
    const kindChips = RSRCH_KINDS.map(([k, label]) =>
        `<button type="button" class="rsrch-chip${st.kind === k ? ' active' : ''}" onclick="_rsrchSetKind('${k}')">${label}</button>`
    ).join('');
    const topicChips = topics.length
        ? topics.map(t => `<button type="button" class="rsrch-chip${st.topics.has(t.id) ? ' active' : ''}" onclick="_rsrchToggleComposerTopic('${esc(t.id)}')">${esc(t.name)}</button>`).join('')
        : `<span style="font-size:12px;color:var(--text-muted);font-style:italic">No topics yet &mdash; add one at the bottom of the page.</span>`;
    const urlRow = st.kind === 'source'
        ? `<input type="text" id="rsrch-add-url" value="${esc(st.url)}" oninput="_rsrchComposer.url=this.value" placeholder="URL" style="${_rsrchInputStyle};width:100%;margin-top:8px">`
        : '';
    const replyPill = st.replyTo
        ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 10px;border-radius:8px;background:rgba(124,92,191,0.10);font-size:13px;color:var(--text)">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">&#8618; answering: <i>${esc(st.replyTo.text)}</i></span>
            <button type="button" onclick="_rsrchCancelAnswer()" title="Cancel answering" style="flex:none;min-width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;cursor:pointer">&times;</button>
        </div>`
        : '';
    return `<div style="border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;background:var(--card-bg)">
        ${replyPill}
        <textarea id="rsrch-add-text" oninput="_rsrchComposer.text=this.value" placeholder="Capture a note, source, claim, or question&hellip;" rows="2" style="${_rsrchInputStyle};width:100%;min-height:40px;resize:vertical;font-family:inherit">${esc(st.text)}</textarea>
        ${urlRow}
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${kindChips}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${topicChips}</div>
        <button type="button" onclick="_rsrchAddEntry()" style="margin-top:12px;height:40px;padding:0 20px;border-radius:8px;border:none;background:var(--ongoing);color:#fff;font-size:14px;font-weight:700;cursor:pointer">Add</button>
    </div>`;
}

function _rsrchSetKind(k) { _rsrchComposer.kind = k; renderResearch(); }
function _rsrchToggleComposerTopic(id) {
    const s = _rsrchComposer.topics;
    if (s.has(id)) s.delete(id); else s.add(id);
    renderResearch();
}

async function _rsrchAddEntry() {
    const st = _rsrchComposer;
    const text = (st.text || '').trim();
    if (!text) { alert('Write something first.'); return; }
    const payload = { text, kind: st.kind, topics: Array.from(st.topics) };
    if (st.kind === 'source') payload.url = st.url || '';
    if (st.replyTo) payload.reply_to = st.replyTo.id;
    if (await _rsrchPost('/api/research/entry/add', payload)) {
        // Answering a question auto-closes it — the reply IS the resolution.
        if (st.replyTo) {
            const q = _researchEntries().find(e => e.id === st.replyTo.id);
            if (q && q.kind === 'question' && q.status === 'open') {
                await _rsrchPost('/api/research/entry/edit', { id: q.id, status: 'answered' });
            }
        }
        _rsrchComposer = { text: '', kind: 'note', url: '', topics: new Set(), replyTo: null };
        renderResearch();
    }
}

// --- Answer-a-question flow: reply_to wires answers to questions (the first
// edge of the walkable web). Starting an answer aims the composer at the
// question and inherits its topics, so the answer lands in the same lens.
function _rsrchStartAnswer(id) {
    const q = _researchEntries().find(e => e.id === id);
    if (!q) return;
    _rsrchComposer.replyTo = { id: q.id, text: q.text };
    _rsrchComposer.kind = 'note';
    _rsrchComposer.topics = new Set(q.topics || []);
    renderResearch();
    const ta = document.getElementById('rsrch-add-text');
    if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); ta.focus(); }
}

function _rsrchCancelAnswer() { _rsrchComposer.replyTo = null; renderResearch(); }

// --- Search (labrador port: keyword + semantic as two independent modes) ---
// Keyword always works (pure server-side ranking); Semantic lights up once
// the server has an OPENAI_API_KEY, and degrades to a friendly message
// until then — same graceful fallback labrador uses.

function _rsrchSearchCard() {
    const st = _rsrchSearch;
    const modeChips = [['keyword', 'Keyword'], ['vector', 'Semantic']].map(([m, label]) =>
        `<button type="button" class="rsrch-chip${st.mode === m ? ' active' : ''}" onclick="_rsrchSetSearchMode('${m}')">${label}</button>`
    ).join('');
    let results = '';
    if (st.msg) {
        results = `<div style="color:var(--text-muted);font-style:italic;padding:10px 2px;font-size:13px">${esc(st.msg)}</div>`;
    } else if (st.hits) {
        results = st.hits.length
            ? st.hits.map(h => _rsrchSearchHit(h)).join('')
            : `<div style="color:var(--text-muted);font-style:italic;padding:10px 2px;font-size:14px">No matches.</div>`;
    }
    const clear = (st.hits || st.msg)
        ? `<button type="button" class="rsrch-chip" style="margin-left:auto" onclick="_rsrchSearchClear()">Clear</button>`
        : '';
    return `<div style="border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;background:var(--card-bg)">
        <div style="display:flex;gap:8px">
            <input type="text" id="rsrch-search-q" value="${esc(st.q)}" oninput="_rsrchSearch.q=this.value"
                onkeydown="if(event.key==='Enter')_rsrchSearchRun()"
                placeholder="Search entries + note files&hellip; (&quot;quoted phrase&quot;, -exclude)"
                style="${_rsrchInputStyle};flex:1;min-width:0">
            <button type="button" onclick="_rsrchSearchRun()" style="flex:none;height:40px;padding:0 16px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer">Search</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center">${modeChips}${clear}</div>
        ${results}
    </div>`;
}

function _rsrchSearchHit(h) {
    const head = h.kind === 'note'
        ? `<span class="rsrch-kind kind-note">&#128196; note file</span>
           <button type="button" onclick="openLibraryFile('${escJs(h.id)}')" style="background:none;border:none;padding:0;cursor:pointer;font-size:14px;font-weight:600;color:var(--accent);font-family:inherit">${esc(h.title || h.id)}</button>`
        : `<span class="rsrch-kind kind-${esc(h.entry_kind || 'note')}">${RSRCH_KIND_LABEL[h.entry_kind] || 'Entry'}</span>`;
    const chips = (h.topics || []).map(n => `<span class="rsrch-chip" style="cursor:default">${esc(n)}</span>`).join('');
    return `<div class="rsrch-entry" style="padding:10px 0;border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${head}</div>
        <div style="font-size:14px;color:var(--text);margin-top:4px">${esc(h.snippet || '')}</div>
        ${chips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${chips}</div>` : ''}
    </div>`;
}

function _rsrchSetSearchMode(m) {
    _rsrchSearch.mode = m;
    if ((_rsrchSearch.q || '').trim()) _rsrchSearchRun(); else renderResearch();
}

function _rsrchSearchClear() {
    _rsrchSearch = { q: '', mode: _rsrchSearch.mode, hits: null, msg: '' };
    renderResearch();
}

async function _rsrchSearchRun() {
    const q = (_rsrchSearch.q || '').trim();
    if (!q) { _rsrchSearchClear(); return; }
    _rsrchSearch.hits = null; _rsrchSearch.msg = '';
    let res;
    try {
        res = await fetch(`/api/research/search?q=${encodeURIComponent(q)}&mode=${_rsrchSearch.mode}`);
    } catch (err) {
        _rsrchSearch.msg = 'Network error — try again.'; renderResearch(); return;
    }
    if (res.status === 404) _rsrchSearch.msg = 'Search API not loaded yet — needs an app restart.';
    else if (res.status === 503) _rsrchSearch.msg = 'Semantic search needs an OpenAI key on the server. Keyword mode works now.';
    else if (!res.ok) _rsrchSearch.msg = 'Search failed.';
    else { const d = await res.json().catch(() => ({})); _rsrchSearch.hits = d.hits || []; }
    renderResearch();
}

// --- Open questions roll-up ---
function _rsrchQuestionsCard() {
    const qs = _researchEntries()
        .filter(e => e.kind === 'question' && e.status === 'open')
        .slice().sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    const byId = _rsrchTopicsById();
    const rows = qs.length
        ? qs.map(e => _rsrchQuestionRow(e, byId)).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:10px 2px;font-size:14px">None open &#10003;</div>`;
    return `<details class="rsrch-card" data-card="research-questions"${_openAttr('research-questions', true)} ontoggle="rsrchCardToggled(this)">
        <summary><span class="kitchen-arrow">&#9654;</span>Open questions<span class="card-count">${qs.length} &mdash; the edge of what's known</span></summary>
        ${rows}
    </details>`;
}

function _rsrchQuestionRow(e, byId) {
    const chips = (e.topics || []).map(tid => byId[tid]
        ? `<span class="rsrch-chip" style="cursor:default">${esc(byId[tid].name)}</span>` : '').join('');
    return `<div class="rsrch-entry" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border)">
        <div style="flex:1;min-width:0">
            <div style="font-size:14px;color:var(--text)">${esc(e.text)}</div>
            ${chips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${chips}</div>` : ''}
        </div>
        <button type="button" onclick="_rsrchStartAnswer('${esc(e.id)}')" style="flex:none;height:40px;padding:0 14px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:13px;font-weight:700;cursor:pointer">Answer&hellip;</button>
        <button type="button" onclick="_rsrchAnswer('${esc(e.id)}')" title="Mark answered without writing an answer" style="flex:none;height:40px;padding:0 14px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:13px;font-weight:600;cursor:pointer">&#10003; Done</button>
    </div>`;
}

async function _rsrchAnswer(id) {
    if (await _rsrchPost('/api/research/entry/edit', { id, status: 'answered' })) renderResearch();
}

// --- Topic cards ---
const RSRCH_STATUS_RANK = { active: 0, dormant: 1, settled: 2 };

function _rsrchOrderedTopics() {
    const topics = _researchTopics();
    const entries = _researchEntries();
    const latest = {};
    for (const e of entries) {
        for (const tid of (e.topics || [])) {
            if (!latest[tid] || (e.created || '') > latest[tid]) latest[tid] = e.created || '';
        }
    }
    return topics.slice().sort((a, b) => {
        const ra = RSRCH_STATUS_RANK[a.status] ?? 3;
        const rb = RSRCH_STATUS_RANK[b.status] ?? 3;
        if (ra !== rb) return ra - rb;
        return (latest[b.id] || '').localeCompare(latest[a.id] || '');
    });
}

function _rsrchTopicCards() {
    return _rsrchOrderedTopics().map(t => _rsrchTopicCard(t)).join('');
}

function _rsrchTopicCard(t) {
    const cardId = `research-topic-${t.id}`;
    const isEditing = editingCards.has(cardId);
    const entries = _researchEntries()
        .filter(e => (e.topics || []).includes(t.id))
        .slice().sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    const openQCount = entries.filter(e => e.kind === 'question' && e.status === 'open').length;
    const rows = entries.length
        ? entries.map(e => _rsrchEntryRow(e, isEditing)).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:10px 2px;font-size:14px">No entries yet.</div>`;
    const statusBadge = t.status !== 'active' ? `<span style="font-size:12px;font-weight:400;color:var(--text-muted);margin-left:6px">&middot; ${esc(t.status)}</span>` : '';
    const openBadge = openQCount ? `<span style="font-size:12px;font-weight:700;color:var(--accent);margin-left:8px">${openQCount} open</span>` : '';
    return `<details class="rsrch-card${isEditing ? ' editing' : ''}" id="${cardId}" data-card="${cardId}"${_openAttr(cardId, false)} ontoggle="rsrchCardToggled(this)">
        <summary>
            <span class="kitchen-arrow">&#9654;</span>
            <span style="flex:1">${esc(t.name)}<span class="card-count">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>${statusBadge}${openBadge}</span>
            <button class="card-edit-btn" onclick="event.preventDefault();event.stopPropagation();toggleEditMode('${cardId}')">${isEditing ? 'Done' : 'Edit'}</button>
        </summary>
        ${isEditing ? _rsrchTopicEditor(t) : ''}
        ${rows}
    </details>`;
}

function _rsrchTopicEditor(t) {
    const nextStatus = { active: 'dormant', dormant: 'settled', settled: 'active' };
    return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;border-bottom:1px dashed var(--border);margin-bottom:8px">
        <input type="text" value="${esc(t.name)}" onchange="_rsrchRenameTopic('${esc(t.id)}', this.value)" placeholder="Topic name" style="${_rsrchInputStyle};flex:1;min-width:140px">
        <button type="button" onclick="_rsrchCycleTopicStatus('${esc(t.id)}','${nextStatus[t.status] || 'active'}')" style="height:36px;padding:0 12px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:13px;cursor:pointer">Status: ${esc(t.status)} &#8594;</button>
        <button type="button" onclick="_rsrchConfirmRemoveTopic('${esc(t.id)}','${escJs(t.name)}')" style="height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--red);font-size:13px;font-weight:600;cursor:pointer">Delete topic</button>
    </div>`;
}

async function _rsrchRenameTopic(id, name) {
    if (!name.trim()) return;
    if (await _rsrchPost('/api/research/topic/edit', { id, name })) renderResearch();
}

async function _rsrchCycleTopicStatus(id, status) {
    if (await _rsrchPost('/api/research/topic/edit', { id, status })) renderResearch();
}

function _rsrchConfirmRemoveTopic(id, name) {
    pendingDelete = { item: id, type: 'research-topic' };
    document.getElementById('rsrchModalText').innerHTML = `Delete topic <b>${esc(name)}</b>? Its entries are kept &mdash; they just lose this tag.`;
    document.getElementById('rsrchModal').classList.add('open');
}

// --- Entry row (shared by topic cards, questions, and Unfiled) ---
const RSRCH_KIND_LABEL = { note: 'Note', source: 'Source', claim: 'Claim', question: 'Question' };
const RSRCH_CLAIM_CYCLE = { '': 'real', real: 'shaky', shaky: 'interesting', interesting: '' };

function _rsrchEntryRow(e, editing) {
    const badge = `<span class="rsrch-kind kind-${e.kind}">${RSRCH_KIND_LABEL[e.kind] || e.kind}</span>`;
    let extra = '';
    if (e.kind === 'source') {
        const link = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent);word-break:break-all">${esc(e.url)} &#8599;</a>` : '';
        const verified = e.verdict === 'verified';
        const busy = _rsrchAnnotating.has(e.id);
        const annBtn = (!e.meta || editing)
            ? `<button type="button" class="rsrch-chip" ${busy ? 'disabled' : ''} onclick="_rsrchAnnotate('${esc(e.id)}')">${busy ? '&#10024; fetching&hellip;' : (e.meta ? '&#8635; re-annotate' : '&#10024; annotate')}</button>`
            : '';
        extra = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px">
            ${link}
            <button type="button" class="rsrch-chip${verified ? ' verdict-verified' : ''}" onclick="_rsrchSetVerdict('${esc(e.id)}','${verified ? '' : 'verified'}')">${verified ? '&#10003; verified' : '&#9675; unverified'}</button>
            ${annBtn}
        </div>${e.meta ? _rsrchMetaHtml(e) : ''}`;
    } else if (e.kind === 'claim') {
        const label = e.verdict || '&mdash;';
        extra = `<div style="margin-top:6px">
            <button type="button" class="rsrch-chip${e.verdict ? ' verdict-' + e.verdict : ''}" onclick="_rsrchSetVerdict('${esc(e.id)}','${RSRCH_CLAIM_CYCLE[e.verdict] ?? 'real'}')">${label}</button>
        </div>`;
    } else if (e.kind === 'question') {
        const answered = e.status === 'answered';
        const answers = _researchEntries().filter(x => x.reply_to === e.id);
        const answerChip = answers.length
            ? `<span class="rsrch-chip" style="cursor:default">&#8618; ${answers.length} answer${answers.length === 1 ? '' : 's'}</span>` : '';
        extra = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center">
            <button type="button" class="rsrch-chip${answered ? ' status-answered' : ''}" onclick="_rsrchSetQuestionStatus('${esc(e.id)}','${answered ? 'open' : 'answered'}')">${answered ? 'answered' : 'open'}</button>
            ${answerChip}
        </div>`;
    }
    // An entry that answers a question wears the link — the walkable web.
    const repliedTo = e.reply_to ? _researchEntries().find(x => x.id === e.reply_to) : null;
    const originFile = (e.origin || '').startsWith('note:') ? e.origin.slice(5) : '';
    const replyLine = (repliedTo || originFile)
        ? `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--text-muted);margin-top:6px">
            ${repliedTo ? `<span>&#8618; answers: <i>${esc(repliedTo.text.slice(0, 80))}${repliedTo.text.length > 80 ? '&hellip;' : ''}</i></span>` : ''}
            ${originFile ? `<button type="button" onclick="openLibraryFile('${escJs(originFile)}')" style="background:none;border:none;padding:0;cursor:pointer;font-size:12px;color:var(--accent);font-family:inherit">from ${esc(originFile)} &#8599;</button>` : ''}
        </div>`
        : '';
    const byId = _rsrchTopicsById();
    // Read mode: show the entry's own tags. Edit mode: every topic becomes a
    // toggle chip, so filing (or re-filing) is a tap — this is the manual
    // door for the Unfiled backstop.
    const topicChips = editing
        ? _researchTopics().map(t => {
            const has = (e.topics || []).includes(t.id);
            return `<button type="button" class="rsrch-chip${has ? ' active' : ''}" onclick="_rsrchToggleEntryTopic('${esc(e.id)}','${esc(t.id)}')">${esc(t.name)}</button>`;
        }).join('')
        : (e.topics || []).map(tid => byId[tid]
            ? `<span class="rsrch-chip" style="cursor:default">${esc(byId[tid].name)}</span>` : '').join('');
    const textHtml = editing
        ? `<span onclick="_rsrchEditText('${esc(e.id)}','${escJs(e.text)}')" style="font-size:14px;color:var(--text);cursor:text" title="Tap to edit">${esc(e.text)}</span>`
        : `<span style="font-size:14px;color:var(--text)">${esc(e.text)}</span>`;
    const del = editing
        ? `<button type="button" class="rsrch-del-btn" onclick="_rsrchConfirmRemoveEntry('${esc(e.id)}','${escJs(e.text.slice(0, 60))}')" title="Delete">&times;</button>`
        : '';
    return `<div class="rsrch-entry" style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid var(--border)">
        <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${badge}${textHtml}</div>
            ${extra}
            ${replyLine}
            ${topicChips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${topicChips}</div>` : ''}
        </div>
        ${del}
    </div>`;
}

// --- Primary-source annotator (the "puller" labrador designed but never built).
// Auto-fetched metadata lands reviewed:false — the amber badge — and Bradie's
// tap is the human sign-off, exactly labrador's needs_review convention.

function _rsrchAuthorsShort(authors) {
    if (!authors || !authors.length) return '';
    const name = a => [a.given, a.family].filter(Boolean).join(' ');
    if (authors.length === 1) return name(authors[0]);
    if (authors.length === 2) return `${name(authors[0])} & ${name(authors[1])}`;
    return `${name(authors[0])} et al.`;
}

function _rsrchMetaHtml(e) {
    const m = e.meta || {};
    const title = m.title || m.doi || 'Untitled';
    const head = m.doi
        ? `<a href="https://doi.org/${esc(m.doi)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(title)}</a>`
        : esc(title);
    const line2 = [_rsrchAuthorsShort(m.authors), m.journal, m.published]
        .filter(Boolean).map(esc).join(' &middot; ');
    const reviewed = !!m.reviewed;
    const badge = `<button type="button" class="rsrch-chip ${reviewed ? 'verdict-verified' : 'verdict-interesting'}"
        title="Auto-fetched metadata &mdash; tap to mark ${reviewed ? 'unreviewed' : 'reviewed'}"
        onclick="_rsrchMetaReview('${esc(e.id)}', ${reviewed ? 'false' : 'true'})">auto ${reviewed ? '&#10003; reviewed' : '&#9675; review'}</button>`;
    const cites = (m.cited_by ?? null) !== null
        ? `<span class="rsrch-chip" style="cursor:default">cited by ${Number(m.cited_by) || 0}</span>` : '';
    const pdf = m.pdf_url
        ? `<a class="rsrch-chip" href="${esc(m.pdf_url)}" target="_blank" rel="noopener" style="text-decoration:none">free PDF &#8599;</a>` : '';
    const abstract = m.abstract
        ? `<details style="margin-top:6px"><summary style="font-size:12px;color:var(--text-muted);cursor:pointer;min-height:28px;display:flex;align-items:center">Abstract</summary><div style="font-size:13px;color:var(--text);margin-top:4px;line-height:1.5">${esc(m.abstract)}</div></details>`
        : '';
    return `<div style="margin-top:8px;padding:10px 12px;border:1px dashed var(--border);border-radius:8px">
        <div style="font-size:14px;font-weight:600">${head}</div>
        ${line2 ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${line2}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center">${badge}${cites}${pdf}</div>
        ${abstract}
    </div>`;
}

async function _rsrchAnnotate(id) {
    if (_rsrchAnnotating.has(id)) return;
    _rsrchAnnotating.add(id);
    renderResearch();
    const ok = await _rsrchPost('/api/research/entry/annotate', { id });
    _rsrchAnnotating.delete(id);
    renderResearch();
    if (!ok) return;
}

async function _rsrchMetaReview(id, reviewed) {
    if (await _rsrchPost('/api/research/entry/meta-review', { id, reviewed })) renderResearch();
}

async function _rsrchSetVerdict(id, verdict) {
    if (await _rsrchPost('/api/research/entry/edit', { id, verdict })) renderResearch();
}

async function _rsrchSetQuestionStatus(id, status) {
    if (await _rsrchPost('/api/research/entry/edit', { id, status })) renderResearch();
}

async function _rsrchEditText(id, current) {
    const next = prompt('Edit entry text', current);
    if (next === null) return;
    const text = next.trim();
    if (!text) return;
    if (await _rsrchPost('/api/research/entry/edit', { id, text })) renderResearch();
}

function _rsrchConfirmRemoveEntry(id, preview) {
    pendingDelete = { item: id, type: 'research-entry' };
    document.getElementById('rsrchModalText').innerHTML = `Delete this entry?<br><i>${esc(preview)}</i>`;
    document.getElementById('rsrchModal').classList.add('open');
}

// --- Confirm-delete modal ---
function closeRsrchModal() {
    pendingDelete = null;
    document.getElementById('rsrchModal').classList.remove('open');
}

async function confirmRsrchDelete() {
    const pd = pendingDelete;
    closeRsrchModal();
    if (!pd) return;
    if (pd.type === 'research-topic') {
        if (await _rsrchPost('/api/research/topic/remove', { id: pd.item })) renderResearch();
    } else if (pd.type === 'research-entry') {
        if (await _rsrchPost('/api/research/entry/remove', { id: pd.item })) renderResearch();
    }
}

// --- Unfiled backstop: entries with no topics — nothing captured can hide ---
function _rsrchUnfiledCard() {
    const cardId = 'research-unfiled';
    const isEditing = editingCards.has(cardId);
    const entries = _researchEntries()
        .filter(e => !(e.topics && e.topics.length))
        .slice().sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    const rows = entries.length
        ? entries.map(e => _rsrchEntryRow(e, isEditing)).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:10px 2px;font-size:14px">Nothing unfiled.</div>`;
    const fileBtn = entries.length
        ? `<button class="card-edit-btn" title="A cricket reads these and tags them into topics" onclick="event.preventDefault();event.stopPropagation();_rsrchFileUnfiled()">&#10024; File</button>`
        : '';
    return `<details class="rsrch-card${isEditing ? ' editing' : ''}" id="${cardId}" data-card="${cardId}"${_openAttr(cardId, false)} ontoggle="rsrchCardToggled(this)">
        <summary>
            <span class="kitchen-arrow">&#9654;</span>
            <span style="flex:1">Unfiled<span class="card-count">${entries.length}</span></span>
            ${fileBtn}
            <button class="card-edit-btn" onclick="event.preventDefault();event.stopPropagation();toggleEditMode('${cardId}')">${isEditing ? 'Done' : 'Edit'}</button>
        </summary>
        ${rows}
    </details>`;
}

// Tap a topic chip on an entry (edit mode) — toggle that tag on the entry.
async function _rsrchToggleEntryTopic(id, tid) {
    const e = _researchEntries().find(x => x.id === id);
    if (!e) return;
    const cur = new Set(e.topics || []);
    if (cur.has(tid)) cur.delete(tid); else cur.add(tid);
    if (await _rsrchPost('/api/research/entry/edit', { id, topics: Array.from(cur) })) renderResearch();
}

// Fire the filer cricket: a tmux Claude session (same pattern as the people
// files' "regenerate impression") that tags the unfiled entries, then the
// terminal pane flips to it so she can watch or ignore it.
async function _rsrchFileUnfiled() {
    let res;
    try {
        res = await fetch('/api/research/file-unfiled', { method: 'POST' });
    } catch (err) { alert('Network error — try again.'); return; }
    if (res.status === 404) { alert('Filer API not loaded yet — needs an app restart.'); return; }
    if (!res.ok) { alert('Could not start the filer.'); return; }
    const d = await res.json().catch(() => ({}));
    if (!d.unfiled) { alert('Nothing unfiled.'); return; }
    window.parent.postMessage({ type: 'openTerminalSession', name: d.session || 'research' }, location.origin);
}

// --- Library: read-only listing of the research/*.md corpus ---
async function loadLibrary() {
    try {
        const res = await fetch('/api/research/library');
        if (!res.ok) return;
        _library = (await res.json()).files || [];
    } catch (e) { /* offline — keep whatever we had */ }
}

function _rsrchLibraryCard() {
    const rows = _library.length
        ? _library.map(f => `<div style="display:flex;align-items:center;gap:10px;padding:0;border-top:1px solid var(--border)">
            <button type="button" onclick="openLibraryFile('${escJs(f.path)}')" style="flex:1;min-width:0;min-height:44px;display:flex;align-items:center;gap:10px;background:none;border:none;cursor:pointer;text-align:left;padding:6px 2px;font-family:inherit">
                <span style="flex:1;min-width:0">
                    <span style="display:block;font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.title)}</span>
                    <span style="display:block;font-size:12px;color:var(--text-muted);margin-top:2px">${esc(f.path)}</span>
                </span>
                <span style="flex:none;font-size:12px;color:var(--text-muted)">${esc(f.mtime)}</span>
            </button>
        </div>`).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:10px 2px;font-size:14px">No files in the research folder.</div>`;
    const importRow = _library.length
        ? `<div style="padding-top:10px;margin-top:4px;border-top:1px solid var(--border)">
            <button type="button" onclick="_rsrchImportQuestions()" style="height:40px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:13px;font-weight:600;cursor:pointer">&#8615; Import open questions from these files</button>
        </div>` : '';
    return `<details class="rsrch-card" data-card="research-library"${_openAttr('research-library', true)} ontoggle="rsrchCardToggled(this)">
        <summary><span class="kitchen-arrow">&#9654;</span>Library<span class="card-count">${_library.length} file${_library.length === 1 ? '' : 's'} &mdash; the full write-ups behind the entries</span></summary>
        ${rows}
        ${importRow}
    </details>`;
}

// Mine the note files' open-question sections into question entries.
// Heuristic extraction, so it never runs blind: dry-run first, preview,
// then confirm. Idempotent server-side — safe to run again after new notes.
async function _rsrchImportQuestions() {
    let res;
    try {
        res = await fetch('/api/research/import-questions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dry_run: true }),
        });
    } catch (err) { alert('Network error — try again.'); return; }
    if (res.status === 404) { alert('Import API not loaded yet — needs an app restart.'); return; }
    if (!res.ok) { alert('Import preview failed.'); return; }
    const d = await res.json().catch(() => ({}));
    if (!d.total) { alert('No new open questions found in the note files.'); return; }
    const lines = (d.plan || []).map(p => `• ${p.topic}: ${p.questions.length}`).join('\n');
    if (!confirm(`Found ${d.total} open question${d.total === 1 ? '' : 's'} to import:\n\n${lines}\n\nEach file becomes (or reuses) a topic. Import?`)) return;
    if (await _rsrchPost('/api/research/import-questions', {})) renderResearch();
}

async function openLibraryFile(path) {
    const res = await fetch('/api/research/library/file?path=' + encodeURIComponent(path));
    if (!res.ok) { alert('Could not open file.'); return; }
    const f = await res.json();
    document.getElementById('readerTitle').textContent = f.title || path;
    document.getElementById('readerFile').textContent = path;
    document.getElementById('readerBody').innerHTML = mdToHtml(f.text || '');
    document.getElementById('readerOverlay').classList.add('open');
}

function closeReader() {
    document.getElementById('readerOverlay').classList.remove('open');
}

// --- New topic row ---
function _rsrchNewTopicRow() {
    return `<div style="display:flex;gap:8px;margin-top:4px">
        <input type="text" id="rsrch-new-topic-name" placeholder="New topic name" style="${_rsrchInputStyle};flex:1" onkeydown="if(event.key==='Enter')_rsrchCreateTopic()">
        <button type="button" onclick="_rsrchCreateTopic()" style="flex:none;height:40px;padding:0 18px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer">Add topic</button>
    </div>`;
}

async function _rsrchCreateTopic() {
    const input = document.getElementById('rsrch-new-topic-name');
    const name = (input?.value || '').trim();
    if (!name) { alert('Name the topic first.'); return; }
    if (await _rsrchPost('/api/research/topic/add', { name })) renderResearch();
}

// --- API helper ---
// Every CRUD endpoint returns the full {topics, entries} state, so a
// successful post refreshes R directly — no refetch needed.
async function _rsrchPost(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Save failed.');
        return false;
    }
    const body = await res.json().catch(() => null);
    if (body && body.topics) R = { topics: body.topics, entries: body.entries || [] };
    return true;
}

// --- Boot + refresh-on-return (no polling on this page) ---
async function _rsrchInit() {
    await Promise.all([loadResearch(), loadLibrary()]);
    renderResearch();
}

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await loadResearch();
    renderResearch();
});

// Clicking back into this iframe (e.g. returning from watching the filer
// cricket in the terminal pane) — visibilitychange doesn't fire for pane
// switches inside the shell, but window focus does. Only re-render when the
// data actually changed remotely, so the click that focused the page never
// lands on a rebuilt DOM.
window.addEventListener('focus', async () => {
    const before = JSON.stringify(R);
    await loadResearch();
    if (JSON.stringify(R) !== before) renderResearch();
});

document.addEventListener('DOMContentLoaded', _rsrchInit);
