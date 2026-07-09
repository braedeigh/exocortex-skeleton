// mini-notes.js — the compact dev-notes list used by the floating panels
// (journal 📝 modal, desktop + PWA terminal notes). One row per note with
// edit (✎) and delete (×) like the dashboard panels, sized for a small
// overlay. Delete is two-tap: × turns into "Sure?" and resets after 3s.
//
// Usage: const notes = createMiniNotes(listEl, 'journal'); notes.load();
// CSS uses the page's theme vars when present, with dark fallbacks for the
// terminal pages that don't define them.

(function () {
    if (document.getElementById('mini-notes-css')) return;
    const st = document.createElement('style');
    st.id = 'mini-notes-css';
    st.textContent = `
.mn-item { display:flex; gap:6px; align-items:flex-start; padding:6px 0; border-top:1px solid var(--border,#2a2a4a); font-size:13px; }
.mn-body { flex:1; padding-top:5px; min-width:0; }
.mn-text { white-space:pre-wrap; word-break:break-word; }
.mn-date { font-size:12px; color:var(--text-muted,rgba(180,160,220,0.6)); margin-top:2px; }
.mn-acts { display:flex; flex-direction:column; gap:2px; align-items:center; }
.mn-act { background:none; border:none; cursor:pointer; color:var(--text-muted,rgba(180,160,220,0.7)); padding:4px 6px; min-width:30px; min-height:30px; border-radius:6px; font-size:14px; font-family:inherit; }
.mn-act:hover { background:var(--accent-light,rgba(124,92,191,0.15)); color:var(--accent,#7c5cbf); }
.mn-x { font-size:17px; line-height:1; }
.mn-sure { background:#c0392b !important; color:#fff !important; font-size:12px !important; font-weight:600; }
.mn-item.mn-editing { flex-direction:column; align-items:stretch; }
/* 16px, not 13px — iOS Safari auto-zooms a focused input/textarea under 16px. */
.mn-edit { width:100%; box-sizing:border-box; min-height:60px; padding:8px 10px; border:1px solid var(--border,#2a2a4a); border-radius:8px; font-size:16px; line-height:1.4; font-family:inherit; background:var(--bg,#0d0d1a); color:var(--text,#e8dcc8); resize:none; overflow:hidden; outline:none; }
.mn-btns { display:flex; gap:6px; justify-content:flex-end; margin-top:6px; }
.mn-btns button { min-height:34px; padding:0 14px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit; }
.mn-save { border:none; background:var(--accent,#7c5cbf); color:#fff; }
.mn-cancel { border:1px solid var(--border,#2a2a4a); background:none; color:var(--text-muted,rgba(180,160,220,0.7)); }
.mn-empty { color:var(--text-muted,rgba(180,160,220,0.6)); font-style:italic; padding:4px 0; }
@media (display-mode: standalone) { .mn-date { display:none; } }
`;
    document.head.appendChild(st);
})();

// opts: { kind: 'dev' | 'idea', sort: null | 'newest' | 'oldest' }
//   kind picks the endpoint pair (dev → /api/devnote*, idea → /api/ideanote*).
//   sort=null keeps stored order (journal/research rely on this); 'newest'/'oldest'
//   sort by the note's `created` (YYYY-MM-DD HH:MM, so string compare is chronological).
function createMiniNotes(listEl, tab, opts) {
    opts = opts || {};
    const kind = opts.kind === 'idea' ? 'idea' : 'dev';
    const listUrl = kind === 'idea' ? `/api/ideanotes/${tab}` : `/api/devnotes/${tab}`;
    const apiBase = kind === 'idea' ? '/api/ideanote' : '/api/devnote';
    let sort = opts.sort || null;
    let notes = [];
    let editingId = null;
    let confirmId = null;
    let confirmTimer = null;

    function sorted() {
        if (!sort) return notes;
        const arr = notes.slice();
        arr.sort((a, b) => {
            const ca = String(a.created || ''), cb = String(b.created || '');
            if (ca === cb) return 0;
            return sort === 'newest' ? (ca < cb ? 1 : -1) : (ca < cb ? -1 : 1);
        });
        return arr;
    }

    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const post = (url, body) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    async function load() {
        try {
            const r = await fetch(listUrl);
            notes = (await r.json()).notes || [];
        } catch (e) { listEl.textContent = 'Could not load notes'; return; }
        render();
    }

    function render() {
        const rows = sorted();
        if (!rows.length) {
            listEl.innerHTML = `<div class="mn-empty">No ${esc(tab)} notes yet</div>`;
            return;
        }
        listEl.innerHTML = rows.map(n => {
            if (n.id === editingId) {
                return `<div class="mn-item mn-editing" data-id="${esc(n.id)}">
                    <textarea class="mn-edit">${esc(n.text)}</textarea>
                    <div class="mn-btns">
                        <button class="mn-cancel" data-action="cancel">Cancel</button>
                        <button class="mn-save" data-action="save">Save</button>
                    </div>
                </div>`;
            }
            const delCls = n.id === confirmId ? 'mn-act mn-x mn-sure' : 'mn-act mn-x';
            const delLabel = n.id === confirmId ? 'Sure?' : '&times;';
            return `<div class="mn-item" data-id="${esc(n.id)}">
                <div class="mn-body">
                    <div class="mn-text">${esc(n.text)}</div>
                    <div class="mn-date">${esc(n.created || '')}</div>
                </div>
                <div class="mn-acts">
                    <button class="${delCls}" data-action="del" title="Delete">${delLabel}</button>
                    <button class="mn-act" data-action="edit" title="Edit">&#9998;</button>
                </div>
            </div>`;
        }).join('');
        const ta = listEl.querySelector('.mn-edit');
        if (ta) {
            ta.style.height = 'auto';
            ta.style.height = ta.scrollHeight + 'px';
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
    }

    listEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn || !listEl.contains(btn)) return;
        const id = btn.closest('.mn-item').dataset.id;
        const action = btn.dataset.action;
        clearTimeout(confirmTimer);
        if (action === 'edit') {
            editingId = id;
            confirmId = null;
            render();
        } else if (action === 'cancel') {
            editingId = null;
            render();
        } else if (action === 'save') {
            const text = listEl.querySelector('.mn-edit').value.trim();
            if (!text) return;
            await post(`${apiBase}/edit`, { tab, id, text });
            editingId = null;
            load();
        } else if (action === 'del') {
            if (confirmId !== id) {
                confirmId = id;
                render();
                confirmTimer = setTimeout(() => { confirmId = null; render(); }, 3000);
                return;
            }
            await post(`${apiBase}/remove`, { tab, id });
            confirmId = null;
            load();
        }
    });

    // Auto-expand the edit textarea while typing
    listEl.addEventListener('input', (e) => {
        if (e.target.classList.contains('mn-edit')) {
            e.target.style.height = 'auto';
            e.target.style.height = e.target.scrollHeight + 'px';
        }
    });

    return {
        load,
        setSort(dir) { sort = dir; render(); },
        getSort() { return sort; },
    };
}
