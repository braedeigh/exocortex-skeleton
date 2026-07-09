// notes-pill.js — the floating corner pill for per-page dev notes + ideas.
//
// Closed: a rounded rectangle of two squares in the bottom-right corner —
//   📝 (left) = dev notes, 💡 (right) = ideas.
// Click a square: the pill is REPLACED in place by a little editor — a floating
//   list (newest→oldest, with a sort toggle) with an add-input pinned at the
//   bottom. On desktop the panel is drag-resizable from its top-left corner.
//
// One component covers every dashboard tab: it always acts on the *current*
// tab's notes (core.js's `currentTab`). Reuses createMiniNotes (mini-notes.js)
// for the list + edit/delete, and the same /api/devnote* & /api/ideanote*
// endpoints the dashboard panels use. Journal + Research keep their own corner
// dropdowns — this only lives in the dashboard shell (index.html).

(function () {
    if (window.__notesPillMounted) return;
    window.__notesPillMounted = true;

    // --- config per kind ---------------------------------------------------
    const KINDS = {
        dev:  { label: 'Dev notes', api: '/api/devnote',  ph: "What's bugging you about this page?" },
        idea: { label: 'Ideas',     api: '/api/ideanote', ph: 'What could this page become?' },
    };

    // Which tab the pill acts on — follows the dashboard's active tab.
    function activeTab() {
        try {
            if (typeof currentTab !== 'undefined' && currentTab) return currentTab;
        } catch (e) { /* currentTab not defined (core.js absent) */ }
        return document.body.dataset.activeTab || 'today';
    }

    // --- styles ------------------------------------------------------------
    const css = document.createElement('style');
    css.id = 'notes-pill-css';
    css.textContent = `
.np-root { position: fixed; right: 16px; bottom: 16px; z-index: 45; font-family: inherit; }

.np-pill { display: flex; border-radius: 14px; overflow: hidden;
    box-shadow: 0 6px 22px rgba(0,0,0,0.28); border: 1px solid var(--border, rgba(124,92,191,0.4)); }
.np-sq { width: 46px; height: 46px; border: none; cursor: pointer; font-size: 22px; line-height: 1;
    background: var(--card-bg, #16162a); display: flex; align-items: center; justify-content: center;
    padding: 0; transition: background 0.12s; }
.np-sq:hover { background: var(--accent-light, rgba(124,92,191,0.22)); }
.np-sq.np-dev { border-right: 1px solid var(--border, rgba(124,92,191,0.4)); }

.np-panel { display: none; flex-direction: column; position: fixed; right: 16px; bottom: 16px;
    width: min(340px, calc(100vw - 24px)); height: min(62vh, 470px);
    background: var(--card-bg, #16162a); border: 1px solid rgba(124,92,191,0.5); border-radius: 14px;
    box-shadow: 0 10px 34px rgba(0,0,0,0.4); overflow: hidden; }
.np-panel.open { display: flex; }
@media (min-width: 700px) {
    .np-panel { resize: both; min-width: 260px; min-height: 220px;
        max-width: calc(100vw - 24px); max-height: 82vh; }
}

.np-head { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 12px;
    border-bottom: 1px solid var(--border, rgba(124,92,191,0.25)); flex-shrink: 0; }
.np-title { flex: 1; font-size: 14px; font-weight: 700; color: var(--text, #e8dcc8); }
.np-title.idea { color: var(--green, #6bbf7c); }
.np-sort { background: none; border: 1px solid var(--border, rgba(124,92,191,0.35)); border-radius: 8px;
    color: var(--text-muted, rgba(180,160,220,0.8)); font-family: inherit; font-size: 12px;
    padding: 0 10px; height: 30px; cursor: pointer; white-space: nowrap;
    min-width: 92px; text-align: center; }
.np-sort:hover { color: var(--text, #e8dcc8); border-color: var(--accent, #7c5cbf); }
.np-close { background: none; border: none; color: var(--text-muted, rgba(180,160,220,0.85));
    font-size: 24px; line-height: 1; width: 34px; height: 34px; cursor: pointer; border-radius: 8px; }
.np-close:hover { background: var(--accent-light, rgba(124,92,191,0.18)); color: var(--text, #e8dcc8); }
.np-maxbtn { background: none; border: none; color: var(--text-muted, rgba(180,160,220,0.85));
    font-size: 17px; line-height: 1; width: 34px; height: 34px; cursor: pointer; border-radius: 8px; }
.np-maxbtn:hover { background: var(--accent-light, rgba(124,92,191,0.18)); color: var(--text, #e8dcc8); }

/* Expanded: grows up from the corner into a near-fullscreen sheet. */
.np-panel.np-max { top: 12px; left: 12px; width: auto; height: auto;
    max-width: none; max-height: none; resize: none; }

.np-list { flex: 1; overflow-y: auto; padding: 4px 12px; min-height: 0; }

.np-add { display: flex; gap: 6px; align-items: flex-start; padding: 8px 10px; flex-shrink: 0;
    border-top: 1px solid var(--border, rgba(124,92,191,0.25)); }
.np-add textarea { flex: 1; padding: 8px 10px; border: 1px solid var(--border, #2a2a4a); border-radius: 8px;
    background: var(--bg, #0d0d1a); color: var(--text, #e8dcc8); font-size: 13px; font-family: inherit;
    resize: none; outline: none; }
.np-add button { min-height: 40px; padding: 0 16px; border: none; border-radius: 8px;
    background: var(--accent, #7c5cbf); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
`;
    document.head.appendChild(css);

    // --- DOM ---------------------------------------------------------------
    const root = document.createElement('div');
    root.className = 'np-root';
    root.innerHTML = `
<div class="np-pill" id="npPill">
    <button class="np-sq np-dev" data-kind="dev" title="Dev notes" aria-label="Dev notes">&#128221;</button>
    <button class="np-sq np-idea" data-kind="idea" title="Ideas" aria-label="Ideas">&#128161;</button>
</div>
<div class="np-panel" id="npPanel">
    <div class="np-head">
        <span class="np-title" id="npTitle">Dev notes</span>
        <button class="np-sort" id="npSort" type="button">&#8595;&#xFE0E; Newest</button>
        <button class="np-maxbtn" id="npMax" type="button" title="Expand" aria-label="Expand">&#9974;</button>
        <button class="np-close" id="npClose" type="button" title="Close" aria-label="Close">&times;</button>
    </div>
    <div class="np-list" id="npList"></div>
    <div class="np-add">
        <textarea id="npInput" rows="2"></textarea>
        <button id="npAdd" type="button">Add</button>
    </div>
</div>`;

    function mount() {
        document.body.appendChild(root);
        wire();
    }

    // --- behaviour ---------------------------------------------------------
    function wire() {
        const pill   = root.querySelector('#npPill');
        const panel  = root.querySelector('#npPanel');
        const titleE = root.querySelector('#npTitle');
        const sortE  = root.querySelector('#npSort');
        const listE  = root.querySelector('#npList');
        const input  = root.querySelector('#npInput');
        const addBtn = root.querySelector('#npAdd');

        let openKind = null;
        let sort = localStorage.getItem('np-sort') || 'newest';
        let mini = null;

        // ︎ = text variation selector — stops iOS rendering the arrow as emoji.
        function paintSort() {
            sortE.innerHTML = (sort === 'newest' ? '&#8595;&#xFE0E; Newest' : '&#8593;&#xFE0E; Oldest');
        }

        function open(kind) {
            openKind = kind;
            const cfg = KINDS[kind];
            titleE.textContent = cfg.label;
            titleE.classList.toggle('idea', kind === 'idea');
            input.placeholder = cfg.ph;
            paintSort();

            // Fresh list node each open so createMiniNotes' listeners don't stack,
            // and so it re-reads the (possibly changed) current tab.
            listE.innerHTML = '';
            const inner = document.createElement('div');
            listE.appendChild(inner);
            mini = createMiniNotes(inner, activeTab(), { kind, sort });
            mini.load();

            pill.style.display = 'none';
            panel.classList.add('open');
            input.value = '';
            setTimeout(() => input.focus(), 0);
        }

        function close() {
            openKind = null;
            mini = null;
            panel.classList.remove('open');
            panel.classList.remove('np-max');
            pill.style.display = '';
        }

        async function add() {
            const text = input.value.trim();
            if (!text || !openKind) return;
            await fetch(`${KINDS[openKind].api}/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tab: activeTab(), text }),
            });
            input.value = '';
            input.style.height = '';
            if (mini) mini.load();
            input.focus();
        }

        pill.addEventListener('click', (e) => {
            const sq = e.target.closest('.np-sq');
            if (sq) open(sq.dataset.kind);
        });
        root.querySelector('#npClose').addEventListener('click', close);
        sortE.addEventListener('click', () => {
            sort = sort === 'newest' ? 'oldest' : 'newest';
            localStorage.setItem('np-sort', sort);
            paintSort();
            if (mini) mini.setSort(sort);
        });
        const maxE = root.querySelector('#npMax');
        maxE.addEventListener('click', () => {
            const on = panel.classList.toggle('np-max');
            maxE.title = on ? 'Shrink' : 'Expand';
            maxE.setAttribute('aria-label', maxE.title);
        });
        addBtn.addEventListener('click', add);
        // Enter sends, Shift+Enter makes a newline (same as the dashboard panels).
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
        });

        // Outside-click closes. composedPath captured synchronously so a list
        // re-render (which detaches the clicked node) doesn't falsely fire.
        document.addEventListener('click', (e) => {
            if (!openKind) return;
            if (e.composedPath().includes(root)) return;
            close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && openKind) close();
        });

        paintSort();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
