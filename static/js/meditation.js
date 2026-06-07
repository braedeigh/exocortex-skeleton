// meditation.js — dated cells, multi-tag, optional timer

const MED_TYPE_LABELS = {
    sitting: 'Sitting',
    walking: 'Walking',
    deity_yoga: 'Deity yoga',
    metta: 'Metta',
    vipassana: 'Vipassana',
};
const MED_TYPE_ORDER = ['sitting', 'walking', 'deity_yoga', 'metta', 'vipassana'];

function medTypeLabel(t) {
    if (MED_TYPE_LABELS[t]) return MED_TYPE_LABELS[t];
    if (!t) return '—';
    return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function medSlug(s) {
    return (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function medEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function medFormatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function medFormatDate(iso) {
    if (!iso) return 'undated';
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function medTodayStr() {
    return (typeof _serverDate !== 'undefined' && _serverDate) || new Date().toISOString().slice(0, 10);
}

// --- Compose state (multi-tag selection persists across re-renders of the form) ---
if (!window._medCompose) window._medCompose = { types: new Set(), customTypes: [] };

// --- Timer ---
function _medTimerState() {
    try {
        const raw = localStorage.getItem('med_timer_state');
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj.type || !obj.started_at) return null;
        return obj;
    } catch (e) {
        return null;
    }
}

function renderMeditationTimer() {
    const el = document.getElementById('meditation-timer-area');
    if (!el) return;
    if (window._medTimerInterval) {
        clearInterval(window._medTimerInterval);
        window._medTimerInterval = null;
    }
    const state = _medTimerState();
    if (state) {
        const elapsedMs = Date.now() - state.started_at;
        el.innerHTML = `
        <div style="border:1px solid var(--accent);border-radius:8px;padding:16px;margin-bottom:18px;background:rgba(124,92,191,0.10);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:12px">
                <div style="font-size:22px">\u{1F9D8}</div>
                <div>
                    <div style="font-weight:600;font-size:16px">${medEscape(medTypeLabel(state.type))}</div>
                    <div id="med-timer-elapsed" style="font-size:24px;font-variant-numeric:tabular-nums;color:var(--accent);font-weight:700">${medFormatElapsed(elapsedMs)}</div>
                </div>
            </div>
            <button onclick="_stopMedTimer()" style="padding:10px 20px;background:var(--accent);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600">Stop</button>
        </div>`;
        window._medTimerInterval = setInterval(_medTimerTick, 1000);
    } else {
        let chips = MED_TYPE_ORDER.map(t => `
            <button onclick="_startMedTimer('${t}')" style="padding:10px 16px;border-radius:24px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);cursor:pointer;font-size:14px;font-weight:600">${medEscape(MED_TYPE_LABELS[t])}</button>
        `).join('');
        chips += `<button onclick="_startMedTimerCustom()" style="padding:10px 16px;border-radius:24px;border:1px dashed var(--border);background:none;color:var(--text-muted);cursor:pointer;font-size:14px">Other…</button>`;
        el.innerHTML = `
        <div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:18px;background:var(--bg-card)">
            <div style="font-weight:600;margin-bottom:10px">Start a timed session</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px">${chips}</div>
        </div>`;
    }
}

function _medTimerTick() {
    const state = _medTimerState();
    if (!state) {
        if (window._medTimerInterval) { clearInterval(window._medTimerInterval); window._medTimerInterval = null; }
        return;
    }
    const span = document.getElementById('med-timer-elapsed');
    if (span) span.textContent = medFormatElapsed(Date.now() - state.started_at);
}

function _startMedTimer(type) {
    localStorage.setItem('med_timer_state', JSON.stringify({ type, started_at: Date.now() }));
    renderMeditationTimer();
}

function _startMedTimerCustom() {
    const t = prompt('Custom practice name (e.g. tonglen):');
    if (!t || !t.trim()) return;
    const key = medSlug(t);
    if (!key) return;
    _startMedTimer(key);
}

function _stopMedTimer() {
    const state = _medTimerState();
    if (!state) { renderMeditationTimer(); return; }
    const elapsedMs = Date.now() - state.started_at;
    const duration_min = Math.max(1, Math.round(elapsedMs / 60000));
    localStorage.removeItem('med_timer_state');
    if (window._medTimerInterval) { clearInterval(window._medTimerInterval); window._medTimerInterval = null; }

    // Prefill the compose cell with this session's type and duration
    window._medCompose.types = new Set([state.type]);
    if (state.type && !MED_TYPE_LABELS[state.type] && !window._medCompose.customTypes.includes(state.type)) {
        window._medCompose.customTypes.push(state.type);
    }
    renderMeditationTimer();
    renderMeditationStream();
    const durInput = document.getElementById('med-compose-duration');
    if (durInput) durInput.value = duration_min;
    const notesEl = document.getElementById('med-compose-notes');
    if (notesEl) notesEl.focus();
}

// --- Stream (compose cell + dated cells) ---
function renderMeditationStream() {
    const el = document.getElementById('meditation-stream-area');
    if (!el) return;

    const entries = (D.meditation_log && D.meditation_log.entries) || [];
    // Collect any custom types from existing entries so they show up as chips
    const customFromEntries = new Set();
    entries.forEach(e => (e.types || []).forEach(t => {
        if (!MED_TYPE_LABELS[t]) customFromEntries.add(t);
    }));
    window._medCompose.customTypes.forEach(t => customFromEntries.add(t));
    const customTypes = Array.from(customFromEntries).sort();

    const selected = window._medCompose.types;
    const isSelected = t => selected.has(t);
    const chipStyle = (active) => active
        ? 'background:rgba(124,92,191,0.18);border:1px solid var(--accent);color:var(--accent);font-weight:700'
        : 'background:none;border:1px solid var(--border);color:var(--text-muted);font-weight:500';
    const typeChip = (t, label) => `<button onclick="_medToggleType('${medEscape(t)}')" data-type="${medEscape(t)}" style="padding:5px 12px;border-radius:14px;cursor:pointer;font-size:13px;${chipStyle(isSelected(t))}">${medEscape(label)}</button>`;

    const builtinChips = MED_TYPE_ORDER.map(t => typeChip(t, MED_TYPE_LABELS[t])).join('');
    const customChips = customTypes.map(t => typeChip(t, medTypeLabel(t))).join('');
    const addCustomBtn = `<button onclick="_medAddCustomType()" style="padding:5px 12px;border-radius:14px;cursor:pointer;font-size:13px;background:none;border:1px dashed var(--border);color:var(--text-muted)">+ tag</button>`;

    const compose = `
    <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:18px;background:var(--bg-card)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <input type="date" id="med-compose-date" value="${medTodayStr()}" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            <input type="number" id="med-compose-duration" min="1" placeholder="min" style="width:80px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px">
            <span style="font-size:12px;color:var(--text-muted)">duration (optional)</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
            ${builtinChips}${customChips}${addCustomBtn}
        </div>
        <textarea id="med-compose-notes" rows="4" placeholder="What arose? What's loosening? Or just a dharma note." style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);resize:vertical;font-family:inherit;font-size:14px;box-sizing:border-box;margin-bottom:10px"></textarea>
        <div style="display:flex;gap:8px">
            <button onclick="_medSaveCompose()" style="padding:8px 16px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600">Add cell</button>
            <button onclick="_medClearCompose()" style="padding:8px 16px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;cursor:pointer">Clear</button>
        </div>
    </div>`;

    // Sort cells: by date desc, then by id (stable tiebreaker)
    const sorted = entries.slice().sort((a, b) => {
        const av = a.date || '0000-00-00';
        const bv = b.date || '0000-00-00';
        if (av !== bv) return bv.localeCompare(av);
        return (b.id || '').localeCompare(a.id || '');
    });

    let cellsHtml = '';
    if (!sorted.length) {
        cellsHtml = `<div style="color:var(--text-muted);font-style:italic;padding:18px;border:1px dashed var(--border);border-radius:8px;text-align:center">No cells yet. Write one above, or start a timer.</div>`;
    } else {
        cellsHtml = sorted.map(e => {
            const tagPills = (e.types || []).map(t => `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:rgba(124,92,191,0.15);color:var(--accent);font-size:12px;font-weight:600">${medEscape(medTypeLabel(t))}</span>`).join('');
            const dur = (e.duration_min != null && e.duration_min !== '')
                ? `<span style="font-size:12px;color:var(--text-muted)">· ${medEscape(e.duration_min)} min</span>`
                : '';
            const notesHtml = e.notes
                ? `<div style="margin-top:8px;white-space:pre-wrap;line-height:1.55;font-size:14px;color:var(--text)">${medEscape(e.notes)}</div>`
                : '<div style="margin-top:6px;color:var(--text-muted);font-style:italic;font-size:13px">(no notes)</div>';
            return `<div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px;background:var(--bg-card)">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                        <span style="font-weight:700;font-size:14px;color:var(--text)">${medEscape(medFormatDate(e.date))}</span>
                        ${tagPills}
                        ${dur}
                    </div>
                    <button onclick="medRemoveEntry('${medEscape(e.id)}','${medEscape((e.types||[]).map(medTypeLabel).join(' + ') || 'cell')}')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px" title="Remove">&times;</button>
                </div>
                ${notesHtml}
            </div>`;
        }).join('');
    }

    el.innerHTML = compose + cellsHtml;
}

function _medToggleType(t) {
    const s = window._medCompose.types;
    if (s.has(t)) s.delete(t); else s.add(t);
    renderMeditationStream();
}

function _medAddCustomType() {
    const raw = prompt('Custom tag name (e.g. tonglen):');
    if (!raw) return;
    const slug = medSlug(raw);
    if (!slug) return;
    if (!window._medCompose.customTypes.includes(slug)) window._medCompose.customTypes.push(slug);
    window._medCompose.types.add(slug);
    renderMeditationStream();
}

async function _medSaveCompose() {
    const dateEl = document.getElementById('med-compose-date');
    const durEl = document.getElementById('med-compose-duration');
    const notesEl = document.getElementById('med-compose-notes');
    const types = Array.from(window._medCompose.types);
    const notes = (notesEl?.value || '').trim();
    if (!types.length && !notes) return;  // need at least one tag or some text
    const payload = {
        types,
        date: dateEl?.value || medTodayStr(),
        duration_min: durEl?.value ? Number(durEl.value) : null,
        notes,
    };
    const res = await fetch('/api/meditation/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) {
        window._medCompose.types = new Set();
        loadDashboard();
    }
}

function _medClearCompose() {
    window._medCompose.types = new Set();
    const notesEl = document.getElementById('med-compose-notes');
    const durEl = document.getElementById('med-compose-duration');
    if (notesEl) notesEl.value = '';
    if (durEl) durEl.value = '';
    renderMeditationStream();
}

function medRemoveEntry(id, label) {
    pendingDelete = { item: id, type: 'meditation-entry', label };
    document.getElementById('modal-text').innerHTML = `Remove the <b>${medEscape(label)}</b> cell?`;
    document.getElementById('modal').classList.add('open');
}

// =====================================================================
// Deity yoga profiles
// =====================================================================

// --- View state ---
function _applyMedView() {
    const view = window._medView || (window._medView = (localStorage.getItem('med_view') || 'practice'));
    const pv = document.getElementById('meditation-practice-view');
    const dv = document.getElementById('meditation-deities-view');
    const pb = document.getElementById('med-subtab-practice');
    const db = document.getElementById('med-subtab-deities');
    if (!pv || !dv) return;
    const base = 'padding:7px 16px;border-radius:20px;cursor:pointer;font-size:14px;';
    const on = 'background:rgba(124,92,191,0.18);border:1px solid var(--accent);color:var(--accent);font-weight:700';
    const off = 'background:var(--bg-card);border:1px solid var(--border);color:var(--text);font-weight:600';
    const deities = view === 'deities';
    pv.style.display = deities ? 'none' : '';
    dv.style.display = deities ? '' : 'none';
    if (pb) pb.style.cssText = base + (deities ? off : on);
    if (db) db.style.cssText = base + (deities ? on : off);
}

function setMedView(view) {
    window._medView = view;
    try { localStorage.setItem('med_view', view); } catch (e) {}
    _applyMedView();
    if (view === 'deities') renderDeities();
}

// --- Minimal markdown renderer (headings, bold/italic/code, links,
//     blockquotes, hr, lists, GFM tables). Input is escaped first. ---
function _mdEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _mdInline(s) {
    // s is already HTML-escaped
    s = s.replace(/`([^`]+)`/g, (m, c) => `<code style="background:rgba(124,92,191,0.12);padding:1px 5px;border-radius:4px;font-size:0.92em">${c}</code>`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent)">$1</a>');
    // Auto-link bare URLs (not the ones already inside a markdown link's href/text)
    s = s.replace(/(^|[^"(>\]])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all">$2</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    return s;
}

function _mdIsHr(l) { return /^\s*([-=*_])\1{2,}\s*$/.test(l); }
function _mdIsTableSep(l) { return l.includes('|') && /-/.test(l) && /^\s*\|?[\s|:\-]+$/.test(l); }
function _mdCells(l) {
    return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
}

function mdToHtml(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    let i = 0;
    while (i < lines.length) {
        let line = lines[i];
        if (!line.trim()) { i++; continue; }

        // Horizontal rule
        if (_mdIsHr(line)) {
            html += '<hr style="border:none;border-top:1px solid var(--border);margin:16px 0">';
            i++;
            continue;
        }

        // Heading
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            const lvl = h[1].length;
            const sizes = { 1: '20px', 2: '17px', 3: '15px', 4: '14px', 5: '13px', 6: '13px' };
            html += `<div style="font-weight:700;font-size:${sizes[lvl]};margin:14px 0 6px 0;color:var(--text)">${_mdInline(_mdEsc(h[2]))}</div>`;
            i++;
            continue;
        }

        // Table: current row + separator on next line
        if (line.includes('|') && i + 1 < lines.length && _mdIsTableSep(lines[i + 1])) {
            const header = _mdCells(line);
            i += 2; // skip header + separator
            const rows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
                const cells = _mdCells(lines[i]);
                i++;
                if (cells.every(c => !c)) continue;  // skip blank padding rows
                rows.push(cells);
            }
            let t = '<div style="overflow-x:auto;margin:8px 0"><table style="border-collapse:collapse;width:100%;font-size:13px">';
            t += '<thead><tr>' + header.map(c => `<th style="text-align:left;padding:6px 10px;border:1px solid var(--border);background:rgba(124,92,191,0.10);font-weight:700">${_mdInline(_mdEsc(c))}</th>`).join('') + '</tr></thead>';
            t += '<tbody>' + rows.map(r => '<tr>' + header.map((_, ci) => `<td style="padding:6px 10px;border:1px solid var(--border);vertical-align:top">${_mdInline(_mdEsc(r[ci] || ''))}</td>`).join('') + '</tr>').join('') + '</tbody>';
            t += '</table></div>';
            html += t;
            continue;
        }

        // Blockquote
        if (/^\s*>/.test(line)) {
            const buf = [];
            while (i < lines.length && /^\s*>/.test(lines[i])) {
                buf.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            html += `<blockquote style="margin:10px 0;padding:8px 14px;border-left:3px solid var(--accent);background:rgba(124,92,191,0.07);color:var(--text);line-height:1.55">${_mdInline(_mdEsc(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`;
            continue;
        }

        // List (unordered or ordered)
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
            const ordered = /^\s*\d+\.\s+/.test(line);
            const items = [];
            while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            html += `<${tag} style="margin:8px 0;padding-left:22px;line-height:1.6">` +
                items.map(it => `<li style="margin:3px 0">${_mdInline(_mdEsc(it))}</li>`).join('') +
                `</${tag}>`;
            continue;
        }

        // Paragraph
        const para = [];
        while (i < lines.length && lines[i].trim() && !_mdIsHr(lines[i]) &&
               !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) &&
               !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
               !(lines[i].includes('|') && i + 1 < lines.length && _mdIsTableSep(lines[i + 1]))) {
            para.push(lines[i]);
            i++;
        }
        html += `<p style="margin:8px 0;line-height:1.6">${_mdInline(_mdEsc(para.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    }
    return html;
}

// --- Deity data + render dispatch ---
function _deityProfiles() {
    return (D.deity_profiles && D.deity_profiles.profiles) || [];
}

// Derive a display name from the first `# H1` of the pasted markdown.
function _deityParseName(body) {
    const lines = String(body || '').split('\n');
    for (const l of lines) {
        const m = l.match(/^#\s+(.*\S)\s*$/);
        if (m) return m[1].trim();
    }
    return '';
}

// Pull a short mantra preview for the list: the line after **Romanized text:**,
// else the first non-heading, non-empty line.
function _deityParseMantra(body) {
    const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (/romanized\s*text/i.test(lines[i].replace(/\*/g, ''))) {
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim()) return lines[j].trim();
            }
        }
    }
    return '';
}

function renderDeities() {
    const el = document.getElementById('meditation-deities-area');
    if (!el) return;
    const v = window._deityView || (window._deityView = { mode: 'list', id: null });
    if (v.mode === 'new') return _deityRenderEditor(el, null);
    if (v.mode === 'edit') return _deityRenderEditor(el, v.id);
    if (v.mode === 'detail') return _deityRenderDetail(el, v.id);
    return _deityRenderList(el);
}

function _deityName(p) { return p.name || _deityParseName(p.body) || 'Untitled'; }

function _deityRenderList(el) {
    const profiles = _deityProfiles().slice().sort((a, b) => _deityName(a).localeCompare(_deityName(b)));
    const addBtn = `<button onclick="_deityNew()" style="padding:8px 16px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;margin-bottom:14px">+ New deity</button>`;
    let cards;
    if (!profiles.length) {
        cards = `<div style="color:var(--text-muted);font-style:italic;padding:18px;border:1px dashed var(--border);border-radius:8px;text-align:center">No deity profiles yet. Add one above.</div>`;
    } else {
        cards = profiles.map(p => {
            const mantraText = p.mantra || _deityParseMantra(p.body);
            const mantra = mantraText ? `<div style="font-size:12px;color:var(--accent);margin-top:6px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${medEscape(mantraText)}</div>` : '';
            return `<div onclick="_deityOpen('${medEscape(p.id)}')" style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;background:var(--bg-card);cursor:pointer">
                <div style="font-weight:700;font-size:16px;color:var(--text)">${medEscape(_deityName(p))}</div>
                ${mantra}
            </div>`;
        }).join('');
    }
    el.innerHTML = addBtn + cards;
}

function _deityRenderDetail(el, id) {
    const p = _deityProfiles().find(x => x.id === id);
    if (!p) { window._deityView = { mode: 'list', id: null }; return _deityRenderList(el); }
    const body = p.body
        ? `<div style="margin-top:8px;color:var(--text)">${mdToHtml(p.body)}</div>`
        : `<div style="margin-top:8px;color:var(--text-muted);font-style:italic">(empty)</div>`;
    el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <button onclick="_deityBackToList()" style="background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:6px;padding:6px 12px;cursor:pointer">&larr; All deities</button>
        <div style="display:flex;gap:8px">
            <button onclick="_deityEdit('${medEscape(p.id)}')" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 12px;cursor:pointer">Edit</button>
            <button onclick="deityRemove('${medEscape(p.id)}','${medEscape(_deityName(p))}')" style="background:none;border:1px solid var(--border);color:var(--negative,#c0506a);border-radius:6px;padding:6px 12px;cursor:pointer">Delete</button>
        </div>
    </div>
    ${body}
    ${_deityRenderLinks(p.links)}`;
}

function _deityRenderLinks(links) {
    if (!Array.isArray(links) || !links.length) return '';
    const items = links.map(l => {
        const title = medEscape(l.title || l.url || 'Link');
        const url = medEscape(l.url || '#');
        const desc = l.description
            ? `<div style="font-size:13px;color:var(--text-muted);margin-top:2px;line-height:1.5">${medEscape(l.description)}</div>`
            : '';
        return `<div style="margin-bottom:12px">
            <a href="${url}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600;font-size:15px;word-break:break-word">${title}</a>
            ${desc}
        </div>`;
    }).join('');
    return `<div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border)">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:12px">Links</div>
        ${items}
    </div>`;
}

function _deityRenderEditor(el, id) {
    const p = id ? _deityProfiles().find(x => x.id === id) : null;
    const val = (s) => medEscape(s || '');
    const ph = '# Medicine Buddha Mantra (Bhaiṣajyaguru)&#10;&#10;**Romanized text:**&#10;Tadyathā: oṃ bhaiṣajye ... svāhā&#10;&#10;-----&#10;&#10;## Translation&#10;...&#10;&#10;| Word | Meaning |&#10;|------|---------|&#10;| oṃ | sacred syllable |';
    el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-weight:700;font-size:18px">${p ? 'Edit deity' : 'New deity'}</div>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
        Paste the full markdown. The first <code>#&nbsp;Heading</code> becomes the deity's name in the list. Tables, &gt; quotes, ----- rules, lists and **bold** all render.
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">
        <textarea id="deity-body" rows="22" placeholder="${ph}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;line-height:1.5;box-sizing:border-box">${val(p && p.body)}</textarea>
        <div style="margin-top:6px">
            <div style="font-weight:700;font-size:15px;margin-bottom:4px">Links</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Title shows as the clickable link, with an optional description below it. Drag order with the arrows.</div>
            <div id="deity-links-editor"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:6px">
            <button onclick="_deitySave(${p ? `'${medEscape(p.id)}'` : 'null'})" style="padding:9px 18px;background:var(--ongoing);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600">Save</button>
            <button onclick="_deityCancelEdit(${p ? `'${medEscape(p.id)}'` : 'null'})" style="padding:9px 18px;background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;cursor:pointer">Cancel</button>
        </div>
    </div>`;
    _deityLinksInit(p);
    _deityRenderLinksEditor();
    const bodyEl = document.getElementById('deity-body');
    if (bodyEl && !p) bodyEl.focus();
}

// --- Link editor state (lives only while editing) ---
function _deityLinksInit(p) {
    const src = (p && Array.isArray(p.links)) ? p.links : [];
    window._deityEditLinks = src.map(l => ({
        title: l.title || '', url: l.url || '', description: l.description || '',
    }));
}

function _deityRenderLinksEditor() {
    const c = document.getElementById('deity-links-editor');
    if (!c) return;
    const links = window._deityEditLinks || [];
    const inp = 'width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box';
    const iconBtn = 'background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:14px;flex:none';
    let rows = links.map((l, i) => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--bg-card)">
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
                <input value="${medEscape(l.title)}" oninput="_deityLinkField(${i},'title',this.value)" placeholder="Link title" style="${inp};flex:1">
                <button onclick="_deityLinkMove(${i},-1)" ${i === 0 ? 'disabled style="opacity:0.35;' + iconBtn + '"' : 'style="' + iconBtn + '"'} title="Move up">&uarr;</button>
                <button onclick="_deityLinkMove(${i},1)" ${i === links.length - 1 ? 'disabled style="opacity:0.35;' + iconBtn + '"' : 'style="' + iconBtn + '"'} title="Move down">&darr;</button>
                <button onclick="_deityLinkDel(${i})" style="${iconBtn};color:var(--negative,#c0506a)" title="Remove link">&times;</button>
            </div>
            <input value="${medEscape(l.url)}" oninput="_deityLinkField(${i},'url',this.value)" placeholder="https://…" style="${inp};margin-bottom:6px">
            <input value="${medEscape(l.description)}" oninput="_deityLinkField(${i},'description',this.value)" placeholder="Description (optional)" style="${inp}">
        </div>
    `).join('');
    if (!links.length) {
        rows = `<div style="color:var(--text-muted);font-style:italic;font-size:13px;margin-bottom:8px">No links yet.</div>`;
    }
    c.innerHTML = rows + `<button onclick="_deityLinkAdd()" style="padding:6px 14px;border-radius:6px;border:1px dashed var(--border);background:none;color:var(--text-muted);cursor:pointer;font-size:13px">+ Add link</button>`;
}

function _deityLinkField(i, field, value) {
    const a = window._deityEditLinks;
    if (a && a[i]) a[i][field] = value;  // no re-render → preserves typing focus
}
function _deityLinkAdd() {
    (window._deityEditLinks = window._deityEditLinks || []).push({ title: '', url: '', description: '' });
    _deityRenderLinksEditor();
}
function _deityLinkDel(i) {
    if (!window._deityEditLinks) return;
    window._deityEditLinks.splice(i, 1);
    _deityRenderLinksEditor();
}
function _deityLinkMove(i, dir) {
    const a = window._deityEditLinks, j = i + dir;
    if (!a || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    _deityRenderLinksEditor();
}

// --- Navigation ---
function _deityOpen(id) { window._deityView = { mode: 'detail', id }; renderDeities(); }
function _deityBackToList() { window._deityView = { mode: 'list', id: null }; renderDeities(); }
function _deityNew() { window._deityView = { mode: 'new', id: null }; renderDeities(); }
function _deityEdit(id) { window._deityView = { mode: 'edit', id }; renderDeities(); }
function _deityCancelEdit(id) {
    window._deityView = id ? { mode: 'detail', id } : { mode: 'list', id: null };
    renderDeities();
}

async function _deitySave(id) {
    const body = document.getElementById('deity-body')?.value || '';
    const name = _deityParseName(body);
    if (!body.trim()) { alert('Paste some markdown first.'); return; }
    if (!name) { alert('Add a "# Title" heading line so the deity has a name.'); return; }
    const links = (window._deityEditLinks || [])
        .map(l => ({ title: (l.title || '').trim(), url: (l.url || '').trim(), description: (l.description || '').trim() }))
        .filter(l => l.title || l.url);
    const payload = {
        name,
        mantra: _deityParseMantra(body),
        body,
        links,
    };
    let url = '/api/deity/add';
    if (id) { url = '/api/deity/update'; payload.id = id; }
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const newId = id || data.id;
        window._deityView = { mode: 'detail', id: newId };
        await loadDashboard();
    } else {
        alert('Save failed.');
    }
}

async function deityRemove(id, name) {
    if (!confirm(`Delete the "${name}" deity profile? This can't be undone.`)) return;
    const res = await fetch('/api/deity/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });
    if (res.ok) {
        window._deityView = { mode: 'list', id: null };
        await loadDashboard();
    } else {
        alert('Delete failed.');
    }
}
