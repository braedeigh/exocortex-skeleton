// research.js — a flat pool of learning notes; topics are lenses over the
// pool, not boxes. Quick capture at the top, an "Open questions" roll-up,
// one card per topic (active, then dormant, then settled), then the Unfiled
// backstop and a "new topic" row. Everything here is editable in the UI.

const _rsrchInputStyle = 'padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box';

// Quick-capture composer state — window-scoped so it survives the 5s polling
// re-render (same idea as movement's _movementRoutineView).
if (!window._rsrchComposer) window._rsrchComposer = { text: '', kind: 'note', url: '', topics: new Set() };

function _researchTopics() { return (D.research && D.research.topics) || []; }
function _researchEntries() { return (D.research && D.research.entries) || []; }
function _rsrchTopicsById() { return Object.fromEntries(_researchTopics().map(t => [t.id, t])); }

function renderResearch() {
    const el = document.getElementById('research-area');
    if (!el) return;
    el.innerHTML = _rsrchComposerHtml() + _rsrchQuestionsCard() + _rsrchTopicCards() + _rsrchUnfiledCard() + _rsrchNewTopicRow();
}

// --- Quick capture composer ---
const RSRCH_KINDS = [
    ['note', 'Note'], ['source', 'Source'], ['claim', 'Claim'], ['question', 'Question'],
];

function _rsrchComposerHtml() {
    const st = window._rsrchComposer;
    const topics = _researchTopics();
    const kindChips = RSRCH_KINDS.map(([k, label]) =>
        `<button type="button" class="rsrch-chip${st.kind === k ? ' active' : ''}" onclick="_rsrchSetKind('${k}')">${label}</button>`
    ).join('');
    const topicChips = topics.length
        ? topics.map(t => `<button type="button" class="rsrch-chip${st.topics.has(t.id) ? ' active' : ''}" onclick="_rsrchToggleComposerTopic('${esc(t.id)}')">${esc(t.name)}</button>`).join('')
        : `<span style="font-size:12px;color:var(--text-muted);font-style:italic">No topics yet &mdash; add one at the bottom of the page.</span>`;
    const urlRow = st.kind === 'source'
        ? `<input type="text" id="rsrch-add-url" value="${esc(st.url)}" oninput="window._rsrchComposer.url=this.value" placeholder="URL" style="${_rsrchInputStyle};width:100%;margin-top:8px">`
        : '';
    return `<div style="border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;background:var(--bg-card)">
        <textarea id="rsrch-add-text" oninput="window._rsrchComposer.text=this.value" placeholder="Capture a note, source, claim, or question&hellip;" rows="2" style="${_rsrchInputStyle};width:100%;min-height:40px;resize:vertical">${esc(st.text)}</textarea>
        ${urlRow}
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${kindChips}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${topicChips}</div>
        <button type="button" onclick="_rsrchAddEntry()" style="margin-top:12px;height:40px;padding:0 20px;border-radius:8px;border:none;background:var(--ongoing);color:#fff;font-size:14px;font-weight:700;cursor:pointer">Add</button>
    </div>`;
}

function _rsrchSetKind(k) { window._rsrchComposer.kind = k; renderResearch(); }
function _rsrchToggleComposerTopic(id) {
    const s = window._rsrchComposer.topics;
    if (s.has(id)) s.delete(id); else s.add(id);
    renderResearch();
}

async function _rsrchAddEntry() {
    const st = window._rsrchComposer;
    const text = (st.text || '').trim();
    if (!text) { alert('Write something first.'); return; }
    const payload = { text, kind: st.kind, topics: Array.from(st.topics) };
    if (st.kind === 'source') payload.url = st.url || '';
    if (await _rsrchPost('/api/research/entry/add', payload)) {
        window._rsrchComposer = { text: '', kind: 'note', url: '', topics: new Set() };
        await loadDashboard();
    }
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
    return `<details class="map-section kitchen-section" data-card="research-questions" ontoggle="mapCardToggled(this)">
        <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
            <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>Open questions (${qs.length})
        </summary>
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
        <button type="button" onclick="_rsrchAnswer('${esc(e.id)}')" style="flex:none;height:40px;padding:0 14px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:13px;font-weight:600;cursor:pointer">Answered</button>
    </div>`;
}

async function _rsrchAnswer(id) {
    if (await _rsrchPost('/api/research/entry/edit', { id, status: 'answered' })) await loadDashboard();
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
    return `<details class="map-section kitchen-section${isEditing ? ' editing' : ''}" id="${cardId}" data-card="${cardId}" ontoggle="mapCardToggled(this)">
        <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
            <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
            <span style="flex:1">${esc(t.name)}<span style="font-size:12px;font-weight:400;color:var(--text-muted);margin-left:8px">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>${statusBadge}${openBadge}</span>
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
        <button type="button" onclick="_rsrchConfirmRemoveTopic('${esc(t.id)}','${escJs(t.name)}')" style="height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--border);background:none;color:#e07a7a;font-size:13px;font-weight:600;cursor:pointer">Delete topic</button>
    </div>`;
}

async function _rsrchRenameTopic(id, name) {
    if (!name.trim()) return;
    if (await _rsrchPost('/api/research/topic/edit', { id, name })) await loadDashboard();
}

async function _rsrchCycleTopicStatus(id, status) {
    if (await _rsrchPost('/api/research/topic/edit', { id, status })) await loadDashboard();
}

function _rsrchConfirmRemoveTopic(id, name) {
    pendingDelete = { item: id, type: 'research-topic', label: name };
    document.getElementById('modal-text').innerHTML = `Delete topic <b>${esc(name)}</b>? Its entries are kept &mdash; they just lose this tag.`;
    document.getElementById('modal').classList.add('open');
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
        extra = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px">
            ${link}
            <button type="button" class="rsrch-chip${verified ? ' verdict-verified' : ''}" onclick="_rsrchSetVerdict('${esc(e.id)}','${verified ? '' : 'verified'}')">${verified ? '&#10003; verified' : '&#9675; unverified'}</button>
        </div>`;
    } else if (e.kind === 'claim') {
        const label = e.verdict || '&mdash;';
        extra = `<div style="margin-top:6px">
            <button type="button" class="rsrch-chip${e.verdict ? ' verdict-' + e.verdict : ''}" onclick="_rsrchSetVerdict('${esc(e.id)}','${RSRCH_CLAIM_CYCLE[e.verdict] ?? 'real'}')">${label}</button>
        </div>`;
    } else if (e.kind === 'question') {
        const answered = e.status === 'answered';
        extra = `<div style="margin-top:6px">
            <button type="button" class="rsrch-chip${answered ? ' status-answered' : ''}" onclick="_rsrchSetQuestionStatus('${esc(e.id)}','${answered ? 'open' : 'answered'}')">${answered ? 'answered' : 'open'}</button>
        </div>`;
    }
    const byId = _rsrchTopicsById();
    const topicChips = (e.topics || []).map(tid => byId[tid]
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
            ${topicChips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${topicChips}</div>` : ''}
        </div>
        ${del}
    </div>`;
}

async function _rsrchSetVerdict(id, verdict) {
    if (await _rsrchPost('/api/research/entry/edit', { id, verdict })) await loadDashboard();
}

async function _rsrchSetQuestionStatus(id, status) {
    if (await _rsrchPost('/api/research/entry/edit', { id, status })) await loadDashboard();
}

async function _rsrchEditText(id, current) {
    const next = prompt('Edit entry text', current);
    if (next === null) return;
    const text = next.trim();
    if (!text) return;
    if (await _rsrchPost('/api/research/entry/edit', { id, text })) await loadDashboard();
}

function _rsrchConfirmRemoveEntry(id, preview) {
    pendingDelete = { item: id, type: 'research-entry', label: preview };
    document.getElementById('modal-text').innerHTML = `Delete this entry?<br><i>${esc(preview)}</i>`;
    document.getElementById('modal').classList.add('open');
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
    return `<details class="map-section kitchen-section${isEditing ? ' editing' : ''}" id="${cardId}" data-card="${cardId}" ontoggle="mapCardToggled(this)">
        <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
            <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
            <span style="flex:1">Unfiled<span style="font-size:12px;font-weight:400;color:var(--text-muted);margin-left:8px">${entries.length}</span></span>
            <button class="card-edit-btn" onclick="event.preventDefault();event.stopPropagation();toggleEditMode('${cardId}')">${isEditing ? 'Done' : 'Edit'}</button>
        </summary>
        ${rows}
    </details>`;
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
    if (await _rsrchPost('/api/research/topic/add', { name })) await loadDashboard();
}

// --- API helper ---
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
    return true;
}
