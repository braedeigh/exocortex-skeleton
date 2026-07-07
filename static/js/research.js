// research.js — the standalone /research place (templates/research.html).
// A flat pool of learning notes; topics are threads over the pool, not boxes.
// Hash-routed: '' is the main directory (composer, send-all, search, open
// questions, the thread directory, Unfiled backstop, Library, new-thread
// row); '#thread/<id>' is a single thread's chat-like view (her entries +
// nested llm replies, oldest first, with its own composer at the bottom).
// She flags entries to queue them for Claude; a send fires a research-runner
// session that writes reply entries back into the thread.
//
// Self-contained: talks straight to /api/data/research + /api/research/*,
// no dashboard globals (D, loadDashboard, core.js helpers).

const _rsrchInputStyle = 'padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box';

// --- State ---
let R = { topics: [], entries: [], sessions: [] };
let _library = [];
const editingCards = new Set();
let _rsrchComposer = { text: '', kind: 'note', url: '', topics: new Set(), replyTo: null };
let _rsrchSearch = { q: '', mode: 'keyword', hits: null, msg: '' };
const _rsrchAnnotating = new Set();
const _rsrchFetchingText = new Set();
let _docTexts = new Set();   // doc ids (entry:<id>) with extracted text on disk
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
function _researchSessions() { return R.sessions || []; }
function _rsrchTopicsById() { return Object.fromEntries(_researchTopics().map(t => [t.id, t])); }

// --- Hash routing: '' = main directory, '#thread/<id>' = one thread ---
function _rsrchCurrentThreadId() {
    const m = (location.hash || '').match(/^#thread\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
}

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
    R = body.research || { topics: [], entries: [], sessions: [] };
}

function renderResearch() {
    const el = document.getElementById('research-area');
    if (!el) return;
    const tid = _rsrchCurrentThreadId();
    if (tid && _rsrchTopicsById()[tid]) {
        el.innerHTML = _rsrchThreadView(_rsrchTopicsById()[tid]);
        return;
    }
    if (tid) { location.hash = ''; return; }   // unknown thread id — bounce home
    el.innerHTML = _rsrchMainView();
}

function _rsrchMainView() {
    return _rsrchComposerHtml() + _rsrchSendAllStrip() + _rsrchSearchCard() + _rsrchQuestionsCard()
        + _rsrchThreadDirectoryCard() + _rsrchUnfiledCard() + _rsrchArticlesCard()
        + _rsrchLibraryCard() + _rsrchNewTopicRow();
}

window.addEventListener('hashchange', renderResearch);

// --- Quick capture composer ---
const RSRCH_KINDS = [
    ['note', 'Note'], ['source', 'Source'], ['claim', 'Claim'], ['question', 'Question'],
];

function _rsrchComposerHtml(opts) {
    opts = opts || {};
    const st = _rsrchComposer;
    const topics = _researchTopics();
    const kindChips = RSRCH_KINDS.map(([k, label]) =>
        `<button type="button" class="rsrch-chip${st.kind === k ? ' active' : ''}" onclick="_rsrchSetKind('${k}')">${label}</button>`
    ).join('');
    const topicChips = opts.hideTopics ? '' : (topics.length
        ? topics.map(t => `<button type="button" class="rsrch-chip${st.topics.has(t.id) ? ' active' : ''}" onclick="_rsrchToggleComposerTopic('${esc(t.id)}')">${esc(t.name)}</button>`).join('')
        : `<span style="font-size:12px;color:var(--text-muted);font-style:italic">No topics yet &mdash; add one at the bottom of the page.</span>`);
    const urlRow = st.kind === 'source'
        ? `<input type="text" id="rsrch-add-url" value="${esc(st.url)}" oninput="_rsrchComposer.url=this.value" placeholder="URL" style="${_rsrchInputStyle};width:100%;margin-top:8px">`
        : '';
    const replyPill = st.replyTo
        ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 10px;border-radius:8px;background:rgba(124,92,191,0.10);font-size:13px;color:var(--text)">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">&#8618; answering: <i>${esc(st.replyTo.text)}</i></span>
            <button type="button" onclick="_rsrchCancelAnswer()" title="Cancel answering" style="flex:none;min-width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;cursor:pointer">&times;</button>
        </div>`
        : '';
    const addArg = opts.presetTopic ? `'${escJs(opts.presetTopic)}'` : '';
    const addLabel = opts.addLabel || 'Add';
    const placeholder = opts.placeholder || 'Capture a note, source, claim, or question&hellip;';
    return `<div style="border:1px solid var(--border);border-radius:12px;padding:14px;${opts.presetTopic ? 'margin-top:12px' : 'margin-bottom:16px'};background:var(--card-bg)">
        ${replyPill}
        <textarea id="rsrch-add-text" oninput="_rsrchComposer.text=this.value" placeholder="${placeholder}" rows="2" style="${_rsrchInputStyle};width:100%;min-height:40px;resize:vertical;font-family:inherit">${esc(st.text)}</textarea>
        ${urlRow}
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${kindChips}</div>
        ${topicChips ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${topicChips}</div>` : ''}
        <button type="button" onclick="_rsrchAddEntry(${addArg})" style="margin-top:12px;height:40px;padding:0 20px;border-radius:8px;border:none;background:var(--ongoing);color:#fff;font-size:14px;font-weight:700;cursor:pointer">${addLabel}</button>
    </div>`;
}

function _rsrchSetKind(k) { _rsrchComposer.kind = k; renderResearch(); }
function _rsrchToggleComposerTopic(id) {
    const s = _rsrchComposer.topics;
    if (s.has(id)) s.delete(id); else s.add(id);
    renderResearch();
}

async function _rsrchAddEntry(extraTopicId) {
    const st = _rsrchComposer;
    const text = (st.text || '').trim();
    if (!text) { alert('Write something first.'); return; }
    const topics = new Set(st.topics);
    if (extraTopicId) topics.add(extraTopicId);
    const payload = { text, kind: st.kind, topics: Array.from(topics) };
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

// --- Send-all strip: only when something's queued. The count pill next to
// it surfaces unreviewed llm output so the orange never hides silently.
function _rsrchSendAllStrip() {
    const entries = _researchEntries();
    const flagged = entries.filter(e => e.flagged && e.author !== 'llm');
    if (!flagged.length) return '';
    const unreviewed = entries.filter(e => e.author === 'llm' && !e.reviewed).length;
    const pill = unreviewed
        ? `<span style="flex:none;display:inline-flex;align-items:center;height:44px;padding:0 14px;border-radius:10px;background:rgba(212,112,10,0.16);color:var(--orange);font-size:13px;font-weight:700;white-space:nowrap">${unreviewed} unreviewed</span>`
        : '';
    return `<div style="display:flex;align-items:stretch;gap:10px;margin-bottom:16px">
        <button type="button" onclick="_rsrchSend(null)" style="flex:1;min-height:44px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-size:15px;font-weight:700;cursor:pointer">&#10148; Send ${flagged.length} queued to Claude</button>
        ${pill}
    </div>`;
}

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

// --- Thread directory (main view): one row per thread, tap to enter ---
function _rsrchThreadDirectoryCard() {
    const topics = _rsrchOrderedTopics();
    const entries = _researchEntries();
    const rows = topics.length
        ? topics.map(t => _rsrchThreadDirRow(t, entries)).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:10px 2px;font-size:14px">No threads yet &mdash; add one below.</div>`;
    return `<details class="rsrch-card" data-card="research-threads"${_openAttr('research-threads', true)} ontoggle="rsrchCardToggled(this)">
        <summary><span class="kitchen-arrow">&#9654;</span>Threads<span class="card-count">${topics.length}</span></summary>
        ${rows}
    </details>`;
}

function _rsrchThreadDirRow(t, entries) {
    const own = entries.filter(e => (e.topics || []).includes(t.id));
    const flaggedN = own.filter(e => e.flagged && e.author !== 'llm').length;
    const unreviewedN = own.filter(e => e.author === 'llm' && !e.reviewed).length;
    const openN = own.filter(e => e.kind === 'question' && e.status === 'open').length;
    const statusNote = t.status !== 'active'
        ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">&middot; ${esc(t.status)}</div>` : '';
    const flagBadge = flaggedN ? `<span style="flex:none;font-size:12px;font-weight:700;color:var(--accent)">&#9873; ${flaggedN}</span>` : '';
    const unreviewedBadge = unreviewedN
        ? `<span style="flex:none;font-size:12px;font-weight:700;color:var(--orange);background:rgba(212,112,10,0.16);padding:3px 10px;border-radius:999px">${unreviewedN} new</span>` : '';
    const openBadge = openN ? `<span style="flex:none;font-size:12px;font-weight:700;color:var(--accent)">${openN} open</span>` : '';
    return `<div class="rsrch-entry" style="display:flex;align-items:center;gap:10px;padding:12px 0;border-top:1px solid var(--border);min-height:44px;cursor:pointer" onclick="location.hash='thread/${escJs(t.id)}'">
        <div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:700;color:var(--text)">${esc(t.name)}<span class="card-count">${own.length} entr${own.length === 1 ? 'y' : 'ies'}</span></div>
            ${statusNote}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex:none">${flagBadge}${unreviewedBadge}${openBadge}</div>
        <span style="flex:none;color:var(--text-muted);font-size:20px;line-height:1">&#8250;</span>
    </div>`;
}

// --- Thread view: the thread as a chat — her entries + nested llm replies,
// oldest first, with a bottom composer preset to this thread's id.
function _rsrchThreadView(t) {
    const cardId = `research-topic-${t.id}`;
    const isEditing = editingCards.has(cardId);
    const entries = _researchEntries()
        .filter(e => (e.topics || []).includes(t.id))
        .slice().sort((a, b) => (a.created || '').localeCompare(b.created || ''));
    const idsInThread = new Set(entries.map(e => e.id));
    const flagged = entries.filter(e => e.flagged && e.author !== 'llm');
    const sessions = _researchSessions()
        .filter(s => (s.topics || []).includes(t.id))
        .slice().sort((a, b) => (b.created || '').localeCompare(a.created || ''));

    const repliesOf = {};
    for (const e of entries) {
        if (e.reply_to && idsInThread.has(e.reply_to)) {
            (repliesOf[e.reply_to] = repliesOf[e.reply_to] || []).push(e);
        }
    }
    const topLevel = entries.filter(e => !e.reply_to || !idsInThread.has(e.reply_to));
    const threadRows = topLevel.length
        ? topLevel.map(e => _rsrchThreadBlock(e, repliesOf, isEditing)).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:10px 2px;font-size:14px">No entries yet &mdash; start below.</div>`;

    // Build the array literal with escJs'd single-quoted strings (not
    // JSON.stringify) since this lands inside a double-quoted onclick attr.
    const flaggedIdsJs = flagged.map(e => `'${escJs(e.id)}'`).join(',');
    const sendStrip = flagged.length
        ? `<div style="margin-bottom:16px">
            <button type="button" onclick="_rsrchSend([${flaggedIdsJs}])" style="width:100%;min-height:44px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-size:15px;font-weight:700;cursor:pointer">&#10148; Send ${flagged.length} queued in this thread</button>
        </div>` : '';

    return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <button type="button" onclick="location.hash=''" title="Back to threads" aria-label="Back to threads" style="flex:none;width:40px;height:40px;border-radius:10px;border:1px solid var(--border);background:var(--card-bg);color:var(--text);font-size:19px;cursor:pointer">&#8592;</button>
        <div style="flex:1;min-width:0">
            <div style="font-size:18px;font-weight:800;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</div>
        </div>
        <button type="button" class="card-edit-btn" onclick="toggleEditMode('${cardId}')">${isEditing ? 'Done' : 'Edit'}</button>
    </div>
    ${isEditing ? `<div style="border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin-bottom:16px;background:var(--card-bg)">${_rsrchTopicEditor(t)}</div>` : ''}
    ${sendStrip}
    ${_rsrchSessionsCard(sessions)}
    <div style="border:1px solid var(--border);border-radius:12px;padding:4px 14px;margin-bottom:16px;background:var(--card-bg)">
        ${threadRows}
    </div>
    ${_rsrchComposerHtml({ hideTopics: true, presetTopic: t.id, addLabel: 'Add to thread', placeholder: 'Add to this thread&hellip;' })}`;
}

// LLM replies nest under the entry they answer, indented — the output lands
// "in that spot" instead of just appending at the end of the thread.
function _rsrchThreadBlock(e, repliesOf, isEditing) {
    const kids = (repliesOf[e.id] || []).slice().sort((a, b) => (a.created || '').localeCompare(b.created || ''));
    const kidsHtml = kids.length
        ? `<div style="margin-left:16px;border-left:2px solid var(--border);padding-left:12px;margin-top:2px">${kids.map(k => _rsrchThreadBlock(k, repliesOf, isEditing)).join('')}</div>`
        : '';
    return `${_rsrchEntryRow(e, isEditing)}${kidsHtml}`;
}

// --- Sessions record: the saved history of research-runner runs for a
// thread, newest first, collapsed by default so it doesn't crowd the chat.
function _rsrchSessionsCard(sessions) {
    if (!sessions.length) return '';
    const rows = sessions.map(s => {
        const running = s.status === 'running';
        const dot = running
            ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--orange);animation:rsrchPulse 1.2s ease-in-out infinite"></span>`
            : '';
        return `<div class="rsrch-entry" style="padding:10px 0;border-top:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:13px;color:var(--text-muted)">${esc(s.created || '')}</span>
                <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:${running ? 'var(--orange)' : 'var(--green)'}">${dot}${running ? 'running&hellip;' : 'done'}</span>
                <span style="font-size:12px;color:var(--text-muted)">${(s.entry_ids || []).length} entries sent</span>
            </div>
            ${s.report ? `<div style="font-size:14px;color:var(--text);margin-top:6px">${esc(s.report)}</div>` : ''}
        </div>`;
    }).join('');
    return `<details class="rsrch-card" data-card="research-sessions"${_openAttr('research-sessions', false)} ontoggle="rsrchCardToggled(this)">
        <summary><span class="kitchen-arrow">&#9654;</span>Sessions<span class="card-count">${sessions.length} &mdash; the saved record of each run</span></summary>
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
    const isLlm = e.author === 'llm';
    const badge = isLlm
        ? `<span class="rsrch-kind kind-llm">&#10024; claude</span>`
        : `<span class="rsrch-kind kind-${e.kind}">${RSRCH_KIND_LABEL[e.kind] || e.kind}</span>`;
    let extra = '';
    if (e.kind === 'source') {
        const link = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent);word-break:break-all">${esc(e.url)} &#8599;</a>` : '';
        const verified = e.verdict === 'verified';
        const busy = _rsrchAnnotating.has(e.id);
        const annBtn = (!e.meta || editing)
            ? `<button type="button" class="rsrch-chip" ${busy ? 'disabled' : ''} onclick="_rsrchAnnotate('${esc(e.id)}')">${busy ? '&#10024; fetching&hellip;' : (e.meta ? '&#8635; re-annotate' : '&#10024; annotate')}</button>`
            : '';
        const doc = 'entry:' + e.id;
        const fetching = _rsrchFetchingText.has(e.id);
        const readBtn = _docTexts.has(doc)
            ? `<button type="button" class="rsrch-chip" onclick="openAnnotator('${escJs(doc)}','${escJs(e.text.slice(0, 60))}')">&#128214; read</button>`
            : (e.url ? `<button type="button" class="rsrch-chip" ${fetching ? 'disabled' : ''} onclick="_rsrchFetchText('${escJs(e.id)}')">${fetching ? '&#8987; fetching&hellip;' : '&#8681; get text'}</button>` : '');
        extra = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px">
            ${link}
            <button type="button" class="rsrch-chip${verified ? ' verdict-verified' : ''}" onclick="_rsrchSetVerdict('${esc(e.id)}','${verified ? '' : 'verified'}')">${verified ? '&#10003; verified' : '&#9675; unverified'}</button>
            ${annBtn}
            ${readBtn}
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
    // Claude's replies may use markdown (bullets etc); her own text stays
    // escaped plain text, and only hers is inline-editable.
    const textHtml = isLlm
        ? `<span style="font-size:14px;color:var(--text)">${mdToHtml(e.text)}</span>`
        : (editing
            ? `<span onclick="_rsrchEditText('${esc(e.id)}','${escJs(e.text)}')" style="font-size:14px;color:var(--text);cursor:text" title="Tap to edit">${esc(e.text)}</span>`
            : `<span style="font-size:14px;color:var(--text)">${esc(e.text)}</span>`);
    const del = editing
        ? `<button type="button" class="rsrch-del-btn" onclick="_rsrchConfirmRemoveEntry('${esc(e.id)}','${escJs(e.text.slice(0, 60))}')" title="Delete">&times;</button>`
        : '';
    // Flag/send for her entries; mark-reviewed for llm outputs. Never both.
    let controlChips = '';
    if (isLlm) {
        const reviewed = !!e.reviewed;
        controlChips = `<button type="button" class="rsrch-chip ${reviewed ? 'verdict-verified' : 'verdict-interesting'}" onclick="_rsrchToggleReviewed('${esc(e.id)}', ${reviewed ? 'false' : 'true'})">${reviewed ? '&#10003; reviewed' : '&#9675; mark reviewed'}</button>`;
    } else {
        const flagged = !!e.flagged;
        controlChips = `<button type="button" class="rsrch-chip${flagged ? ' active' : ''}" onclick="_rsrchToggleFlag('${esc(e.id)}', ${flagged ? 'false' : 'true'})">${flagged ? '&#9873; queued' : '&#9873; queue for Claude'}</button>
            <button type="button" class="rsrch-chip" onclick="_rsrchSend(['${esc(e.id)}'])">&#10148; send now</button>`;
    }
    // Row tint: unreviewed llm output (orange) > processed by the runner
    // (pink) > flagged and queued (accent edge). At most one applies.
    let rowStyle = 'display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid var(--border)';
    if (isLlm && !e.reviewed) {
        rowStyle += ';background:rgba(212,112,10,0.12);border-left:3px solid var(--orange);padding-left:10px;border-radius:6px';
    } else if (e.processed) {
        rowStyle += ';background:rgba(214,107,160,0.10);border-left:3px solid var(--pink);padding-left:10px;border-radius:6px';
    } else if (!isLlm && e.flagged) {
        rowStyle += ';border-left:3px solid var(--accent);padding-left:10px';
    }
    return `<div class="rsrch-entry" style="${rowStyle}">
        <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${badge}${textHtml}</div>
            ${extra}
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center">${controlChips}</div>
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
        if (await _rsrchPost('/api/research/topic/remove', { id: pd.item })) {
            // Deleting the thread we're currently viewing bounces to the
            // directory; the hashchange handler re-renders from there.
            if (location.hash === '#thread/' + pd.item) location.hash = '';
            else renderResearch();
        }
    } else if (pd.type === 'research-entry') {
        if (await _rsrchPost('/api/research/entry/remove', { id: pd.item })) renderResearch();
    } else if (pd.type === 'annotation') {
        await _annPost('/api/annotations/remove', { id: pd.item });
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

// --- Articles: every source with fetched full text, ready to annotate.
// The "article picker" half of the labrador tool — pick a doc, land in the
// highlighter. A source's own row also has read/get-text, but this gathers
// them in one Labrador-sidebar-style list.
function _rsrchArticlesCard() {
    const byDoc = {};
    for (const e of _researchEntries()) {
        if (e.kind === 'source') byDoc['entry:' + e.id] = e;
    }
    const docs = Array.from(_docTexts).filter(d => byDoc[d]);
    if (!docs.length) return '';   // nothing fetched yet — hide the card entirely
    const rows = docs.map(doc => {
        const e = byDoc[doc];
        const m = e.meta || {};
        const title = m.title || e.text;
        const sub = [_rsrchAuthorsShort(m.authors), m.journal, m.published].filter(Boolean).map(esc).join(' &middot; ');
        return `<div style="display:flex;align-items:center;gap:10px;padding:0;border-top:1px solid var(--border)">
            <button type="button" onclick="openAnnotator('${escJs(doc)}','${escJs((title || '').slice(0, 60))}')" style="flex:1;min-width:0;min-height:44px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;background:none;border:none;cursor:pointer;text-align:left;padding:6px 2px;font-family:inherit">
                <span style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%">${esc(title)}</span>
                ${sub ? `<span style="font-size:12px;color:var(--text-muted)">${sub}</span>` : ''}
            </button>
            <span class="rsrch-kind kind-source" style="flex:none">&#128214; annotate</span>
        </div>`;
    }).join('');
    return `<details class="rsrch-card" data-card="research-articles"${_openAttr('research-articles', true)} ontoggle="rsrchCardToggled(this)">
        <summary><span class="kitchen-arrow">&#9654;</span>Articles<span class="card-count">${docs.length} with full text &mdash; pick one to highlight &amp; annotate</span></summary>
        ${rows}
    </details>`;
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

// --- New thread row ---
function _rsrchNewTopicRow() {
    return `<div style="display:flex;gap:8px;margin-top:4px">
        <input type="text" id="rsrch-new-topic-name" placeholder="New thread name" style="${_rsrchInputStyle};flex:1" onkeydown="if(event.key==='Enter')_rsrchCreateTopic()">
        <button type="button" onclick="_rsrchCreateTopic()" style="flex:none;height:40px;padding:0 18px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer">New thread</button>
    </div>`;
}

async function _rsrchCreateTopic() {
    const input = document.getElementById('rsrch-new-topic-name');
    const name = (input?.value || '').trim();
    if (!name) { alert('Name the thread first.'); return; }
    if (await _rsrchPost('/api/research/topic/add', { name })) renderResearch();
}

// --- API helper ---
// Every CRUD endpoint returns the full {topics, entries, sessions} state, so
// a successful post refreshes R directly — no refetch needed.
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
    if (body && body.topics) R = { topics: body.topics, entries: body.entries || [], sessions: body.sessions || [] };
    return true;
}

// --- Flag / review / send: the newest endpoints, not live until the app is
// restarted — a 404 here means "the code's in, the process isn't" and gets
// the same friendly alert as the other not-yet-restarted endpoints.
async function _rsrchToggleFlag(id, flagged) {
    let res;
    try {
        res = await fetch('/api/research/entry/flag', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, flagged }),
        });
    } catch (err) { alert('Network error — try again.'); return; }
    if (res.status === 404) { alert('Flag API not loaded yet — needs an app restart.'); return; }
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Could not flag.'); return; }
    const d = await res.json().catch(() => ({}));
    if (d.topics) R = { topics: d.topics, entries: d.entries || [], sessions: d.sessions || [] };
    renderResearch();
}

async function _rsrchToggleReviewed(id, reviewed) {
    let res;
    try {
        res = await fetch('/api/research/entry/review', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, reviewed }),
        });
    } catch (err) { alert('Network error — try again.'); return; }
    if (res.status === 404) { alert('Review API not loaded yet — needs an app restart.'); return; }
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Could not mark reviewed.'); return; }
    const d = await res.json().catch(() => ({}));
    if (d.topics) R = { topics: d.topics, entries: d.entries || [], sessions: d.sessions || [] };
    renderResearch();
}

// ids === null means "send everything already flagged" ({} body).
async function _rsrchSend(ids) {
    let res;
    try {
        res = await fetch('/api/research/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ids ? { ids } : {}),
        });
    } catch (err) { alert('Network error — try again.'); return; }
    if (res.status === 404) { alert('Send API not loaded yet — needs an app restart.'); return; }
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Could not send.'); return; }
    const d = await res.json().catch(() => ({}));
    await loadResearch();
    renderResearch();
    if (d.sent > 0) {
        window.parent.postMessage({ type: 'openTerminalSession', name: 'research-runner' }, location.origin);
        _rsrchStartPolling();
    }
}

// --- Poll while a research-runner session is running: refresh every 5s so
// her replies land without a manual refresh, capped at ~10 minutes.
let _rsrchPollTimer = null;
let _rsrchPollTicks = 0;
const RSRCH_POLL_MAX_TICKS = 120;   // 120 * 5s = 10 minutes

function _rsrchAnySessionRunning() {
    return _researchSessions().some(s => s.status === 'running');
}

function _rsrchStartPolling() {
    if (_rsrchPollTimer) return;
    _rsrchPollTicks = 0;
    _rsrchPollTimer = setInterval(async () => {
        _rsrchPollTicks++;
        await loadResearch();
        renderResearch();
        if (!_rsrchAnySessionRunning() || _rsrchPollTicks >= RSRCH_POLL_MAX_TICKS) {
            clearInterval(_rsrchPollTimer);
            _rsrchPollTimer = null;
        }
    }, 5000);
}

// === Annotator — labrador's char-anchored highlights, generic over docs ===
// An annotation = {selector: {exact, char_start, char_end}, content: {kind,
// note, source: llm|human}, needs_review}. Highlights render amber until
// reviewed (green). Docs are namespaced ids (entry:<id>, note:<file>; the
// journal: namespace for Cricket sessions is one docstore branch away).

let _ann = { doc: null, title: '', text: '', items: [], selStart: null, selEnd: null, activeId: null };

async function loadDocTexts() {
    try {
        const res = await fetch('/api/research/texts');
        if (res.ok) _docTexts = new Set((await res.json()).docs || []);
    } catch (e) { /* offline — keep whatever we had */ }
}

async function _rsrchFetchText(id) {
    if (_rsrchFetchingText.has(id)) return;
    _rsrchFetchingText.add(id);
    renderResearch();
    let res;
    try {
        res = await fetch('/api/research/entry/fetch-text', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
    } catch (err) {
        _rsrchFetchingText.delete(id); renderResearch(); alert('Network error — try again.'); return;
    }
    _rsrchFetchingText.delete(id);
    if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        renderResearch();
        alert(d.error === 'pdf_extraction_unavailable'
            ? "That source is a PDF — PDF text extraction isn't wired up yet."
            : (d.error || 'Could not fetch text.'));
        return;
    }
    const d = await res.json().catch(() => ({}));
    if (d.doc) _docTexts.add(d.doc);
    renderResearch();
    const entry = _researchEntries().find(x => x.id === id);
    openAnnotator(d.doc, entry ? entry.text.slice(0, 60) : '');
}

async function openAnnotator(doc, fallbackTitle) {
    let dt, ann;
    try {
        [dt, ann] = await Promise.all([
            fetch('/api/annotations/doc-text?doc=' + encodeURIComponent(doc)),
            fetch('/api/annotations?doc=' + encodeURIComponent(doc)),
        ]);
    } catch (err) { alert('Network error — try again.'); return; }
    if (dt.status === 404) { alert('No text fetched for this document yet.'); return; }
    if (!dt.ok) { alert('Could not load the document text.'); return; }
    const dbody = await dt.json().catch(() => ({}));
    const abody = ann.ok ? await ann.json().catch(() => ({})) : {};
    _ann = { doc, title: dbody.title || fallbackTitle || doc, text: dbody.text || '',
             items: abody.annotations || [], selStart: null, selEnd: null, activeId: null };
    _annRender();
    document.getElementById('annOverlay').classList.add('open');
}

function closeAnnotator() {
    document.getElementById('annOverlay').classList.remove('open');
    _annHidePop();
    _ann.doc = null;
}

function annotateReaderFile() {
    const path = document.getElementById('readerFile').textContent;
    if (!path) return;
    const title = document.getElementById('readerTitle').textContent;
    closeReader();
    openAnnotator('note:' + path, title);
}

function _annRender() {
    document.getElementById('annTitle').textContent = _ann.title;
    document.getElementById('annDoc').textContent = _ann.doc || '';
    document.getElementById('annText').innerHTML = _annMarksHtml();
    document.getElementById('annList').innerHTML = _annListHtml();
}

// Highlighted text: greedy non-overlapping pass over resolved selectors.
// An overlapped annotation loses its mark but stays in the list.
function _annMarksHtml() {
    const text = _ann.text;
    const spans = _ann.items
        .filter(a => a.state !== 'lost' && a.state !== 'unresolved' && a.selector)
        .map(a => ({ id: a.id, s: a.selector.char_start, e: a.selector.char_end, review: a.needs_review }))
        .filter(x => Number.isInteger(x.s) && Number.isInteger(x.e) && x.s >= 0 && x.e <= text.length && x.s < x.e)
        .sort((a, b) => a.s - b.s || a.e - b.e);
    let html = '', pos = 0;
    for (const sp of spans) {
        if (sp.s < pos) continue;
        html += esc(text.slice(pos, sp.s));
        const cls = 'ann-mark' + (sp.review ? '' : ' reviewed') + (sp.id === _ann.activeId ? ' active' : '');
        html += `<mark class="${cls}" data-ann="${esc(sp.id)}" onclick="_annFocus('${escJs(sp.id)}')">${esc(text.slice(sp.s, sp.e))}</mark>`;
        pos = sp.e;
    }
    html += esc(text.slice(pos));
    return html || '<span class="ann-empty">Empty document.</span>';
}

function _annListHtml() {
    if (!_ann.items.length) {
        return '<div class="ann-empty">No annotations yet &mdash; select some text in the document to make the first one.</div>';
    }
    return _ann.items.slice().sort((a, b) => {
        const sa = a.selector ? a.selector.char_start : Number.MAX_SAFE_INTEGER;
        const sb = b.selector ? b.selector.char_start : Number.MAX_SAFE_INTEGER;
        return sa - sb;
    }).map(a => {
        const q = (a.selector && a.selector.exact) || '';
        const note = (a.content && a.content.note) || '';
        const state = a.state === 'relocated'
            ? '<span class="rsrch-chip" style="cursor:default" title="The text shifted; re-anchored by its exact quote">&#8635; relocated</span>'
            : a.state === 'lost'
                ? '<span class="rsrch-chip verdict-shaky" style="cursor:default" title="The quoted text no longer appears in this document">&#9888; lost</span>' : '';
        const src = (a.content && a.content.source) === 'llm'
            ? '<span class="rsrch-chip" style="cursor:default">llm</span>' : '';
        const review = `<button type="button" class="rsrch-chip ${a.needs_review ? 'verdict-interesting' : 'verdict-verified'}" onclick="_annToggleReview('${escJs(a.id)}', ${a.needs_review ? 'true' : 'false'})">${a.needs_review ? '&#9675; review' : '&#10003; reviewed'}</button>`;
        return `<div class="ann-row">
            <div class="ann-quote" onclick="_annFocus('${escJs(a.id)}')">&ldquo;${esc(q.slice(0, 120))}${q.length > 120 ? '&hellip;' : ''}&rdquo;</div>
            ${note ? `<div class="ann-note">${esc(note)}</div>` : ''}
            <div class="ann-chips">${review}${src}${state}
                <button type="button" class="rsrch-chip" onclick="_annEditNote('${escJs(a.id)}')">edit</button>
                <button type="button" class="rsrch-chip" style="color:var(--red)" onclick="_annConfirmDelete('${escJs(a.id)}')">&times; delete</button>
            </div>
        </div>`;
    }).join('');
}

function _annFocus(id) {
    _ann.activeId = id;
    _annRender();
    const m = document.querySelector(`#annText mark[data-ann="${CSS.escape(id)}"]`);
    if (m) m.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// --- Selection → offsets. Marks contribute their inner text only, so the
// rendered textContent maps 1:1 onto the raw document string.
function _annSelectionOffsets() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const container = document.getElementById('annText');
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const len = range.toString().length;
    if (!len) return null;
    return { start, end: start + len, rect: range.getBoundingClientRect() };
}

function _annOnSelectionEnd() {
    if (!_ann.doc) return;
    setTimeout(() => {
        const off = _annSelectionOffsets();
        if (!off) { _annHidePop(); return; }
        _ann.selStart = off.start;
        _ann.selEnd = off.end;
        const pop = document.getElementById('annPop');
        pop.style.left = Math.max(8, Math.min(window.innerWidth - 150, off.rect.left + off.rect.width / 2 - 65)) + 'px';
        pop.style.top = Math.max(8, off.rect.top - 48) + 'px';
        pop.classList.add('show');
    }, 10);
}

function _annHidePop() {
    document.getElementById('annPop').classList.remove('show');
}

async function _annCreate() {
    _annHidePop();
    if (_ann.selStart == null || _ann.selEnd == null || !_ann.doc) return;
    const note = prompt('Annotation note (optional):', '');
    if (note === null) return;
    const ok = await _annPost('/api/annotations/add', {
        doc: _ann.doc, char_start: _ann.selStart, char_end: _ann.selEnd,
        content: { kind: 'highlight', note: note.trim(), source: 'human' },
    });
    if (ok) {
        _ann.selStart = _ann.selEnd = null;
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
    }
}

async function _annToggleReview(id, cur) {
    await _annPost('/api/annotations/edit', { id, needs_review: !cur });
}

async function _annEditNote(id) {
    const a = _ann.items.find(x => x.id === id);
    if (!a) return;
    const note = prompt('Annotation note:', (a.content && a.content.note) || '');
    if (note === null) return;
    const content = Object.assign({}, a.content || {}, { note: note.trim() });
    await _annPost('/api/annotations/edit', { id, content });
}

function _annConfirmDelete(id) {
    const a = _ann.items.find(x => x.id === id);
    pendingDelete = { item: id, type: 'annotation' };
    document.getElementById('rsrchModalText').innerHTML =
        `Delete this annotation?<br><i>&ldquo;${esc(((a && a.selector && a.selector.exact) || '').slice(0, 80))}&rdquo;</i>`;
    document.getElementById('rsrchModal').classList.add('open');
}

// Annotation endpoints return the doc-scoped list; refresh _ann from it.
async function _annPost(url, payload) {
    let res;
    try {
        res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (err) { alert('Network error — try again.'); return false; }
    if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Save failed.');
        return false;
    }
    const d = await res.json().catch(() => ({}));
    if (d.annotations && (!d.doc || d.doc === _ann.doc)) {
        _ann.items = d.annotations;
        _annRender();
    }
    return true;
}

document.addEventListener('mouseup', _annOnSelectionEnd);
document.addEventListener('touchend', _annOnSelectionEnd);

// --- Boot + refresh-on-return. Also resumes polling on load if a session
// was left running (e.g. she closed the tab mid-run).
async function _rsrchInit() {
    await Promise.all([loadResearch(), loadLibrary(), loadDocTexts()]);
    renderResearch();
    if (_rsrchAnySessionRunning()) _rsrchStartPolling();
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
