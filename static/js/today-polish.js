// today-polish.js — friendlier To Do tab.
// Additive + defensive: (1) whole-row tap-to-complete, (2) a gentle completion
// animation, (3) undo-on-delete (replaces the confirm modal for To Do items).
// Scoped to the To Do tab; wrapped so it never throws into the page.
// Remove the <script> tag in index.html (+ the matching CSS block) to revert.
(function () {
    'use strict';

    var REDUCED = false;
    try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    // ---------- (1) + (2) whole-row tap to complete, with animation ----------
    function isControl(t) {
        return t.closest(
            '.delete-btn, .add-trigger, .drag-handle, input, textarea, select,' +
            ' button, a, .habit-rename, summary'
        );
    }

    document.addEventListener('click', function (e) {
        try {
            var item = e.target.closest('.card-item');
            if (!item || !item.closest('#tab-today')) return;
            if (item.closest('.todo-card')) return;      // to-dos: tap opens details, checkbox completes
            if (item.closest('.card.editing')) return;  // edit mode: no tap-to-complete
            var check = item.querySelector('.habit-check');
            if (!check) return;               // rows without a checkbox (e.g. growth notes)
            if (isControl(e.target)) return;  // let real controls act
            if (check === e.target || check.contains(e.target)) return; // checkbox handles itself

            e.preventDefault();
            if (item.dataset.ttBusy) return;
            item.dataset.ttBusy = '1';

            var becomingDone = !check.classList.contains('done');
            if (becomingDone && !REDUCED) {
                item.classList.add('tt-completing');
                setTimeout(function () { check.click(); }, 360);
            } else {
                check.click();
            }
        } catch (err) { /* never break the page */ }
    }, false);

    // ---------- (3) undo-on-delete ----------
    // Replaces the "Remove X?" modal with a 5s "Removed · Undo" toast for the
    // three To Do item types. All other deletes keep the original confirm modal.
    var UNDOABLE = { habit: 1, todo: 1, growth: 1 };
    var _orig = window.confirmDelete;
    var _undo = null; // { item, type, timer, hideTimer }

    function toastEl() {
        var t = document.getElementById('tt-toast');
        if (!t) { t = document.createElement('div'); t.id = 'tt-toast'; t.className = 'tt-toast'; document.body.appendChild(t); }
        return t;
    }
    // Keep the pending row hidden even if a 5s poll re-renders the list.
    function hidePending() {
        if (!_undo) return;
        document.querySelectorAll('#tab-today .card-item').forEach(function (r) {
            if (r.dataset.habit === _undo.item) r.style.display = 'none';
        });
    }
    function clearUndo() {
        if (!_undo) return;
        clearTimeout(_undo.timer); clearInterval(_undo.hideTimer);
        toastEl().classList.remove('show');
    }
    function finalize() {           // commit the real delete via existing machinery
        if (!_undo) return;
        var u = _undo; clearUndo(); _undo = null;
        try { pendingDelete = { item: u.item, type: u.type }; executeDelete(); } catch (e) {}
    }
    function undo() {               // nothing was deleted yet — just restore the view
        if (!_undo) return;
        clearUndo(); _undo = null;
        try { render(); } catch (e) {}
    }

    window.confirmDelete = function (item, type) {
        try {
            if (currentTab === 'today' && UNDOABLE[type]) {
                if (_undo) finalize();              // commit any earlier pending delete first
                _undo = { item: item, type: type, timer: null, hideTimer: null };
                hidePending();
                _undo.hideTimer = setInterval(hidePending, 250);
                var t = toastEl();
                t.innerHTML = '';
                var span = document.createElement('span');
                span.className = 'tt-toast-msg';
                span.textContent = 'Removed';
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = 'Undo';
                btn.addEventListener('click', undo);
                t.appendChild(span); t.appendChild(btn);
                t.classList.add('show');
                _undo.timer = setTimeout(finalize, 5000);
                return;
            }
        } catch (e) { /* fall through to original on any trouble */ }
        return _orig.call(this, item, type);
    };
})();
