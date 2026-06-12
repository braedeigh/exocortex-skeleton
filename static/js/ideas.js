// ideas.js — the Ideas tab: every page's idea entries sorted by page, then the
// vision doc (IDEAS.md) rendered as collapsible section cards.
//
// Two stores, two halves:
//   D.idea_notes_all — {tab: [{id,text,created}]} from idea_notes.json (the
//     little dated blurbs; 💡-sends from dev notes land here)
//   D.ideas_md — the raw IDEAS.md vision doc (kept as-is for now; she'll sort
//     it into entries later)

const IDEAS_TAB_ORDER = ['general', 'today', 'kitchen', 'map', 'body', 'money', 'movement', 'inventory', 'meditation', 'media', 'car', 'ideas'];
const IDEAS_TAB_LABELS = {
    general: 'General', today: 'To Do', kitchen: 'Kitchen', map: 'Life Map',
    body: 'Body', money: 'Money', movement: 'Movement', inventory: 'Inventory',
    meditation: 'Meditation', media: 'Media', car: 'Car', ideas: 'Ideas page', global: 'Global',
};

// {tab, id} while an overview row is being inline-edited; draft survives re-renders.
let _ideasOvEditing = null;
let _ideasOvDraft = '';

function _ideasTabLabel(tab) {
    return IDEAS_TAB_LABELS[tab] || (tab.charAt(0).toUpperCase() + tab.slice(1));
}

function renderIdeasByPage() {
    const el = document.getElementById('ideas-by-page');
    if (!el) return;
    const all = D.idea_notes_all || {};
    const tabs = [...new Set([...IDEAS_TAB_ORDER, ...Object.keys(all)])]
        .filter(t => t === 'general' || (all[t] || []).length);

    const cards = tabs.map(tab => {
        const notes = all[tab] || [];
        const rows = notes.map(n => {
            const editing = _ideasOvEditing && _ideasOvEditing.tab === tab && _ideasOvEditing.id === n.id;
            if (editing) {
                return `<div style="display:flex;gap:6px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--border)">
                    <textarea id="ideas-ov-edit" oninput="_ideasOvDraft=this.value;this.style.height='auto';this.style.height=this.scrollHeight+'px'" style="flex:1;box-sizing:border-box;min-height:72px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.4;font-family:inherit;background:var(--bg);color:var(--text);resize:none;overflow:hidden">${esc(_ideasOvDraft)}</textarea>
                    <div style="display:flex;flex-direction:column;gap:6px">
                        <button onclick="ideasOvSave('${escJs(tab)}','${escJs(n.id)}')" style="padding:8px 12px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Save</button>
                        <button onclick="ideasOvCancel()" style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text-muted);font-size:12px;cursor:pointer">Cancel</button>
                    </div>
                </div>`;
            }
            return `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--border);font-size:13px">
                <div style="flex:1">${esc(n.text)}</div>
                <div style="font-size:12px;color:var(--text-muted);white-space:nowrap">${esc(n.created || '')}</div>
                <button onclick="ideasOvEdit('${escJs(tab)}','${escJs(n.id)}')" title="Edit" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;padding:0 4px">&#9998;</button>
                <button onclick="ideasOvRemove('${escJs(tab)}','${escJs(n.id)}')" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0 4px">&times;</button>
            </div>`;
        }).join('');
        const addBox = tab === 'general'
            ? `<div style="display:flex;gap:6px;align-items:flex-start;margin-top:10px">
                <textarea rows="1" id="ideas-ov-input" placeholder="A new idea…" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.4;font-family:inherit;outline:none;background:var(--bg);color:var(--text);resize:none;overflow:hidden" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();ideasOvAdd()}"></textarea>
                <button onclick="ideasOvAdd()" style="padding:6px 14px;border:none;border-radius:6px;background:var(--text);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Add</button>
            </div>`
            : '';
        return `<details class="map-section kitchen-section" data-card="ideas-${esc(tab)}" ${tab === 'general' ? 'data-default-open open' : ''} ontoggle="mapCardToggled(this)">
            <summary style="font-size:16px;font-weight:700;cursor:pointer;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px">
                <span class="kitchen-arrow" style="font-size:12px;transition:transform 0.15s;display:inline-block">&#9654;</span>
                <span style="flex:1">${esc(_ideasTabLabel(tab))}</span>
                ${notes.length ? `<span style="font-size:12px;font-weight:600;color:var(--text-muted);background:var(--bg-card,var(--card-bg));border-radius:10px;padding:1px 8px">${notes.length}</span>` : ''}
            </summary>
            ${rows || '<div style="color:var(--text-muted);font-size:13px;font-style:italic;padding:4px 0">Nothing here yet</div>'}
            ${addBox}
        </details>`;
    }).join('');

    el.innerHTML = `
        <div class="section-title" style="margin-top:0">Ideas</div>
        <div style="font-size:12px;color:var(--text-muted);margin:-8px 0 12px 0">
            Ideas sorted by page. Send one here from any page's dev notes with &#128161;, or add directly under General.
        </div>
        ${cards}`;
}

async function ideasOvAdd() {
    const input = document.getElementById('ideas-ov-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const res = await fetch('/api/ideanote/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab: 'general', text })
    });
    if (res.ok) { input.value = ''; loadDashboard(); }
}

function ideasOvEdit(tab, id) {
    const n = ((D.idea_notes_all || {})[tab] || []).find(x => x.id === id);
    _ideasOvEditing = { tab, id };
    _ideasOvDraft = n ? n.text : '';
    renderIdeasByPage();
    const ta = document.getElementById('ideas-ov-edit');
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function ideasOvCancel() {
    _ideasOvEditing = null;
    _ideasOvDraft = '';
    renderIdeasByPage();
}

async function ideasOvSave(tab, id) {
    const text = _ideasOvDraft.trim();
    if (!text) return;
    const before = (((D.idea_notes_all || {})[tab] || []).find(x => x.id === id) || {}).text;
    const res = await fetch('/api/ideanote/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, id, text })
    });
    if (res.ok) {
        if (before !== undefined && before !== text) _notePush('idea', tab, { kind: 'edit', id, before, after: text });
        _ideasOvEditing = null;
        _ideasOvDraft = '';
        loadDashboard();
    }
}

function ideasOvRemove(tab, id) {
    const note = ((D.idea_notes_all || {})[tab] || []).find(x => x.id === id);
    confirmDelete(note ? note.text : 'this idea', 'ideanote');
    pendingDelete = { type: 'ideanote', kind: 'idea', tab, id, item: note ? note.text : 'this idea' };
}

// --- Vision doc (IDEAS.md) ---------------------------------------------------
// Rendered read-only as collapsible ## section cards; a small "edit raw" flips
// to a plain-markdown textarea with explicit Save/Cancel (the /api/ideas POST
// refuses empty bodies, so a glitched load can't wipe the doc).

let _ideasDocEditing = false;
let _ideasDocDraft = null;

function _ideasMdInline(s) {
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
}

function _ideasMdBlock(md) {
    const out = [];
    let list = null;
    let quote = null;
    const flushList = () => { if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; } };
    const flushQuote = () => { if (quote) { out.push('<blockquote>' + quote.join('<br>') + '</blockquote>'); quote = null; } };
    for (const raw of md.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        const li = line.match(/^\s*[-*] (.+)$/);
        const oli = line.match(/^\s*\d+\. (.+)$/);
        const q = line.match(/^> ?(.*)$/);
        const h3 = line.match(/^### (.+)$/);
        if (li || oli) {
            flushQuote();
            (list = list || []).push('<li>' + _ideasMdInline(li ? li[1] : oli[1]) + '</li>');
        } else if (q) {
            flushList();
            (quote = quote || []).push(_ideasMdInline(q[1]));
        } else if (h3) {
            flushList(); flushQuote();
            out.push('<h3>' + _ideasMdInline(h3[1]) + '</h3>');
        } else if (/^---+$/.test(line)) {
            flushList(); flushQuote();
            out.push('<hr>');
        } else if (!line.trim()) {
            flushList(); flushQuote();
        } else {
            flushList(); flushQuote();
            out.push('<p>' + _ideasMdInline(line) + '</p>');
        }
    }
    flushList(); flushQuote();
    return out.join('\n');
}

function _ideasParseSections(md) {
    const sections = [];
    let cur = { title: null, lines: [] };
    for (const line of md.split('\n')) {
        const m = line.match(/^## (.+)$/);
        if (m) { sections.push(cur); cur = { title: m[1].trim(), lines: [] }; }
        else cur.lines.push(line);
    }
    sections.push(cur);
    return sections;   // [0] = preamble (title:null), rest titled
}

function renderIdeasDoc() {
    const el = document.getElementById('ideas-doc');
    if (!el) return;
    const md = _ideasDocEditing && _ideasDocDraft !== null ? _ideasDocDraft : (D.ideas_md || '');

    if (_ideasDocEditing) {
        el.innerHTML = `
            <div class="section-title" style="margin-top:24px;display:flex;align-items:center;gap:8px">
                <span style="flex:1">Vision doc <span style="font-weight:400;font-size:12px;color:var(--text-muted)">IDEAS.md — raw</span></span>
                <button class="card-edit-btn" onclick="ideasDocSave()">Save</button>
                <button class="card-edit-btn" onclick="ideasDocCancel()">Cancel</button>
            </div>
            <textarea id="ideas-doc-editor" spellcheck="false" oninput="_ideasDocDraft=this.value"
                style="width:100%;box-sizing:border-box;min-height:60vh;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13px;line-height:1.55;resize:vertical"></textarea>`;
        document.getElementById('ideas-doc-editor').value = md;
        return;
    }

    let html = `
        <div class="section-title" style="margin-top:24px;display:flex;align-items:center;gap:8px">
            <span style="flex:1">Vision doc <span style="font-weight:400;font-size:12px;color:var(--text-muted)">IDEAS.md — the big scratchpad, kept as-is for now</span></span>
            <button class="card-edit-btn" onclick="ideasDocEdit()">Edit raw</button>
        </div>`;
    if (!md.trim()) {
        el.innerHTML = html + '<div style="color:var(--text-muted);font-style:italic;font-size:13px">No vision doc yet.</div>';
        return;
    }
    const secs = _ideasParseSections(md);
    const preLines = secs[0].lines.slice();
    const tIdx = preLines.findIndex(l => /^# (.+)$/.test(l));
    if (tIdx !== -1) preLines.splice(tIdx, 1);   // the tab header already says where we are
    const preBody = preLines.join('\n').replace(/^-{3,}$/gm, '').trim();
    if (preBody) html += `<div style="color:var(--text-muted);font-size:13px;margin:4px 0 10px">${_ideasMdBlock(preBody)}</div>`;
    secs.slice(1).forEach((sec, i) => {
        const bullets = sec.lines.filter(l => /^\s*[-*] /.test(l)).length;
        html += `<details class="ideas-doc-section" data-card="ideas-doc-${i}" ontoggle="mapCardToggled(this)">
            <summary><span class="kitchen-arrow" style="font-size:11px;transition:transform 0.15s;display:inline-block">&#9654;</span><span style="flex:1">${_ideasMdInline(sec.title)}</span>${bullets ? `<span class="ideas-doc-count">${bullets}</span>` : ''}</summary>
            <div class="ideas-doc-body">${_ideasMdBlock(sec.lines.join('\n').trim())}</div>
        </details>`;
    });
    el.innerHTML = html;
    restoreMapCards();
}

function ideasDocEdit() {
    _ideasDocEditing = true;
    _ideasDocDraft = D.ideas_md || '';
    renderIdeasDoc();
}

function ideasDocCancel() {
    _ideasDocEditing = false;
    _ideasDocDraft = null;
    renderIdeasDoc();
}

async function ideasDocSave() {
    const content = _ideasDocDraft === null ? (D.ideas_md || '') : _ideasDocDraft;
    const res = await fetch('/api/ideas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Save failed');
        return;
    }
    D.ideas_md = content;
    _ideasDocEditing = false;
    _ideasDocDraft = null;
    renderIdeasDoc();
}
