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
.mn-text { flex:1; white-space:pre-wrap; word-break:break-word; padding-top:5px; }
.mn-date { font-size:12px; color:var(--text-muted,rgba(180,160,220,0.6)); white-space:nowrap; padding-top:6px; }
.mn-act { background:none; border:none; cursor:pointer; color:var(--text-muted,rgba(180,160,220,0.7)); padding:4px 6px; min-width:30px; min-height:30px; border-radius:6px; font-size:14px; font-family:inherit; }
.mn-act:hover { background:var(--accent-light,rgba(124,92,191,0.15)); color:var(--accent,#7c5cbf); }
.mn-x { font-size:17px; line-height:1; }
.mn-sure { background:#c0392b !important; color:#fff !important; font-size:12px !important; font-weight:600; }
.mn-item.mn-editing { flex-direction:column; align-items:stretch; }
.mn-edit { width:100%; box-sizing:border-box; min-height:60px; padding:8px 10px; border:1px solid var(--border,#2a2a4a); border-radius:8px; font-size:13px; line-height:1.4; font-family:inherit; background:var(--bg,#0d0d1a); color:var(--text,#e8dcc8); resize:none; overflow:hidden; outline:none; }
.mn-btns { display:flex; gap:6px; justify-content:flex-end; margin-top:6px; }
.mn-btns button { min-height:34px; padding:0 14px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; font-family:inherit; }
.mn-save { border:none; background:var(--accent,#7c5cbf); color:#fff; }
.mn-cancel { border:1px solid var(--border,#2a2a4a); background:none; color:var(--text-muted,rgba(180,160,220,0.7)); }
.mn-empty { color:var(--text-muted,rgba(180,160,220,0.6)); font-style:italic; padding:4px 0; }
`;
    document.head.appendChild(st);
})();

function createMiniNotes(listEl, tab) {
    let notes = [];
    let editingId = null;
    let confirmId = null;
    let confirmTimer = null;

    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const post = (url, body) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    async function load() {
        try {
            const r = await fetch(`/api/devnotes/${tab}`);
            notes = (await r.json()).notes || [];
        } catch (e) { listEl.textContent = 'Could not load notes'; return; }
        render();
    }

    function render() {
        if (!notes.length) {
            listEl.innerHTML = `<div class="mn-empty">No ${esc(tab)} notes yet</div>`;
            return;
        }
        listEl.innerHTML = notes.map(n => {
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
                <div class="mn-text">${esc(n.text)}</div>
                <div class="mn-date">${esc(n.created || '')}</div>
                <button class="mn-act" data-action="edit" title="Edit">&#9998;</button>
                <button class="${delCls}" data-action="del" title="Delete">${delLabel}</button>
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
            await post('/api/devnote/edit', { tab, id, text });
            editingId = null;
            load();
        } else if (action === 'del') {
            if (confirmId !== id) {
                confirmId = id;
                render();
                confirmTimer = setTimeout(() => { confirmId = null; render(); }, 3000);
                return;
            }
            await post('/api/devnote/remove', { tab, id });
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

    return { load };
}
