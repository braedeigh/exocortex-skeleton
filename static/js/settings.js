// settings.js — drives the right-side Settings panel inside index.html.
// Lazy-initialized: nothing runs until openSettings() calls initSettingsPanel().

(function () {
    let initialized = false;
    let state = null;
    let dirty = false;

    const PHASE_LABELS = {
        night: 'Night', dawn: 'Dawn', postDawn: 'Post-dawn', morning: 'Morning',
        day: 'Day', golden: 'Golden hour', twilight: 'Twilight',
    };
    const PHASE_ORDER = ['night','dawn','postDawn','morning','day','golden','twilight'];
    const COLOR_KEYS = [
        ['bg', 'Background'],
        ['cardBg', 'Card bg'],
        ['text', 'Text'],
        ['textSecondary', 'Text 2°'],
        ['textMuted', 'Text muted'],
        ['border', 'Border'],
    ];
    const OFFSET_KEYS = [
        ['dawnStart', 'Dawn start', 'sunrise'],
        ['dawnEnd', 'Dawn end', 'sunrise'],
        ['postDawnEnd', 'Post-dawn end', 'sunrise'],
        ['morningEnd', 'Morning end', 'sunrise'],
        ['goldenStart', 'Golden start', 'sunset'],
        ['twilightStart', 'Twilight start', 'sunset'],
        ['twilightEnd', 'Twilight end', 'sunset'],
    ];
    const ACCENT_LABELS = {
        morning: 'Morning section', evening: 'Evening section', ongoing: 'Midday / accent', accent: 'Primary accent',
    };

    window.initSettingsPanel = function () {
        if (initialized) return;
        initialized = true;

        state = JSON.parse(JSON.stringify(window.THEME_OVERRIDES || {}));
        state.themes ??= {};
        state.offsets ??= {};
        state.phasesEnabled ??= {};
        state.accents ??= {};
        if (state.enabled === undefined) state.enabled = true;

        document.getElementById('enableToggle').checked = state.enabled !== false;
        document.getElementById('enableToggle').addEventListener('change', (e) => {
            state.enabled = e.target.checked;
            markDirty();
        });
        document.getElementById('saveBtn').addEventListener('click', save);
        document.getElementById('devNoteAdd').addEventListener('click', () => addDevNote('devNoteInput'));
        document.getElementById('devNoteInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addDevNote('devNoteInput');
        });
        document.getElementById('devNoteAddBottom').addEventListener('click', () => addDevNote('devNoteInputBottom'));
        document.getElementById('devNoteInputBottom').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addDevNote('devNoteInputBottom');
        });
        const pwBtn = document.getElementById('pwChangeBtn');
        if (pwBtn) pwBtn.addEventListener('click', changePassword);

        renderPhases();
        renderRules();
        renderAccents();
        renderDevNotes();
    };

    function markDirty() {
        dirty = true;
        window.__settingsDirty = true;
        const btn = document.getElementById('saveBtn');
        btn.disabled = false;
        btn.classList.add('dirty');
        document.getElementById('saveStatus').textContent = 'unsaved';
    }

    async function save() {
        if (!dirty) return;
        const btn = document.getElementById('saveBtn');
        btn.disabled = true;
        document.getElementById('saveStatus').textContent = 'saving…';
        try {
            const payload = {
                enabled: state.enabled,
                themes: trimEmpty(state.themes),
                offsets: trimEmpty(state.offsets),
                phasesEnabled: trimEmpty(state.phasesEnabled),
                accents: trimEmpty(state.accents),
            };
            const r = await fetch('/api/theme/save', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload),
            });
            if (!r.ok) throw new Error(r.status);
            dirty = false;
            window.__settingsDirty = false;
            btn.classList.remove('dirty');
            document.getElementById('saveStatus').textContent = 'saved';
            setTimeout(() => {
                if (!dirty) document.getElementById('saveStatus').textContent = '';
            }, 1200);
            window.THEME_OVERRIDES = payload;
            if (typeof updateSkyTheme === 'function') updateSkyTheme();
            // Tell the parent shell so it can broadcast to sibling iframes
            try {
                if (window.parent && window.parent !== window) {
                    window.parent.postMessage({ type: 'theme-changed', overrides: payload }, '*');
                }
            } catch (err) { /* cross-origin or no parent */ }
        } catch (e) {
            document.getElementById('saveStatus').textContent = 'save failed';
            btn.disabled = false;
        }
    }

    function trimEmpty(o) {
        const out = {};
        for (const k of Object.keys(o)) {
            const v = o[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                const inner = {};
                for (const kk of Object.keys(v)) {
                    if (v[kk] !== undefined && v[kk] !== null && v[kk] !== '') inner[kk] = v[kk];
                }
                if (Object.keys(inner).length) out[k] = inner;
            } else if (v !== undefined && v !== null && v !== '') {
                out[k] = v;
            }
        }
        return out;
    }

    function effectiveColor(phase, key) {
        return (state.themes[phase] && state.themes[phase][key]) ?? SKY_DEFAULT_THEMES[phase][key];
    }
    function effectiveOffset(key) {
        return state.offsets[key] ?? SKY_DEFAULT_OFFSETS[key];
    }
    function effectiveAccent(key) {
        return state.accents[key] ?? SKY_DEFAULT_ACCENTS[key];
    }

    function renderPhases() {
        const list = document.getElementById('phaseList');
        list.innerHTML = '';
        for (const phase of PHASE_ORDER) {
            const card = document.createElement('div');
            card.className = 'phase-card';
            const disabled = state.phasesEnabled[phase] === false;
            if (disabled) card.classList.add('disabled');
            const swatchColor = effectiveColor(phase, 'bg');
            card.innerHTML = `
                <div class="phase-head">
                    <div class="phase-swatch" style="background:${swatchColor}"></div>
                    <div class="name">${PHASE_LABELS[phase]}</div>
                    <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted)" onclick="event.stopPropagation()">
                        <input type="checkbox" ${disabled ? '' : 'checked'} data-phase-enable="${phase}">
                        on
                    </label>
                    <span class="chev">▶</span>
                </div>
                <div class="phase-body">
                    <div class="phase-preview" data-preview="${phase}" style="background:${effectiveColor(phase, 'bg')}">
                        <div class="phase-preview-inner"
                             style="background:${effectiveColor(phase, 'cardBg')};border-color:${effectiveColor(phase, 'border')}">
                            <div class="pp-title" style="color:${effectiveColor(phase, 'text')}">Sample card title</div>
                            <div class="pp-secondary" style="color:${effectiveColor(phase, 'textSecondary')}">Body text reads in text-secondary — a paragraph might look like this.</div>
                            <div class="pp-muted" style="color:${effectiveColor(phase, 'textMuted')}">Muted metadata · timestamp · hint text</div>
                        </div>
                    </div>
                    ${COLOR_KEYS.map(([key, label]) => {
                        const val = effectiveColor(phase, key);
                        const isRgba = val.startsWith('rgba');
                        const hex = isRgba ? rgbaToHex(val) : val;
                        return `<div class="color-row">
                            <label>${label}</label>
                            <input type="color" value="${hex}" data-phase="${phase}" data-key="${key}" data-rgba="${isRgba}">
                            <input type="text" value="${val}" data-phase="${phase}" data-key="${key}" data-rgba="${isRgba}">
                        </div>`;
                    }).join('')}
                    <div class="phase-actions">
                        <button class="btn-mini" data-reset-phase="${phase}">Reset to default</button>
                    </div>
                </div>`;
            list.appendChild(card);
            card.querySelector('.phase-head').addEventListener('click', () => card.classList.toggle('open'));
            card.querySelector('[data-reset-phase]').addEventListener('click', () => resetPhase(phase));
        }
        list.querySelectorAll('input[type="color"], input[type="text"][data-phase]').forEach(inp => {
            inp.addEventListener('input', onPhaseColorChange);
        });
        list.querySelectorAll('input[data-phase-enable]').forEach(inp => {
            inp.addEventListener('change', (e) => {
                const phase = e.target.dataset.phaseEnable;
                if (e.target.checked) delete state.phasesEnabled[phase];
                else state.phasesEnabled[phase] = false;
                e.target.closest('.phase-card').classList.toggle('disabled', !e.target.checked);
                markDirty();
            });
        });
    }

    function rgbaToHex(rgba) {
        const m = rgba.match(/[\d.]+/g);
        if (!m) return '#000000';
        return '#' + m.slice(0, 3).map(n => Math.round(parseFloat(n)).toString(16).padStart(2, '0')).join('');
    }

    function onPhaseColorChange(e) {
        const phase = e.target.dataset.phase;
        const key = e.target.dataset.key;
        const isRgba = e.target.dataset.rgba === 'true';
        let val = e.target.value;
        if (isRgba && e.target.type === 'color') {
            const cur = effectiveColor(phase, key);
            const alpha = (cur.match(/[\d.]+/g) || ['0','0','0','1'])[3] || '1';
            const m = val.match(/[0-9a-f]{2}/gi);
            if (m) val = `rgba(${parseInt(m[0],16)},${parseInt(m[1],16)},${parseInt(m[2],16)},${alpha})`;
        }
        state.themes[phase] ??= {};
        state.themes[phase][key] = val;
        const siblings = e.target.parentElement.querySelectorAll('input');
        siblings.forEach(s => {
            if (s === e.target) return;
            if (s.type === 'color') s.value = isRgba ? rgbaToHex(val) : val;
            else s.value = val;
        });
        const card = e.target.closest('.phase-card');
        if (key === 'bg') {
            card.querySelector('.phase-swatch').style.background = val;
            card.querySelector('.phase-preview').style.background = val;
        } else if (key === 'cardBg') {
            card.querySelector('.phase-preview-inner').style.background = val;
        } else if (key === 'border') {
            card.querySelector('.phase-preview-inner').style.borderColor = val;
        } else if (key === 'text') {
            card.querySelector('.phase-preview-inner .pp-title').style.color = val;
        } else if (key === 'textSecondary') {
            card.querySelector('.phase-preview-inner .pp-secondary').style.color = val;
        } else if (key === 'textMuted') {
            card.querySelector('.phase-preview-inner .pp-muted').style.color = val;
        }
        markDirty();
    }

    function resetPhase(phase) {
        delete state.themes[phase];
        renderPhases();
        markDirty();
    }

    function renderRules() {
        const list = document.getElementById('rulesList');
        list.innerHTML = '';
        for (const [key, label, anchor] of OFFSET_KEYS) {
            const val = effectiveOffset(key);
            const row = document.createElement('div');
            row.className = 'rule-row';
            row.innerHTML = `
                <label style="font-size:13px;color:var(--text)">${label}</label>
                <span class="anchor">${anchor}</span>
                <span style="font-size:12px;color:var(--text-muted)">${anchor} + <span class="cur-val">${val}</span> hr</span>
                <input type="number" step="0.25" value="${val}" data-offset-key="${key}">`;
            list.appendChild(row);
        }
        list.querySelectorAll('input[data-offset-key]').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const key = e.target.dataset.offsetKey;
                const v = parseFloat(e.target.value);
                if (isNaN(v)) return;
                state.offsets[key] = v;
                e.target.closest('.rule-row').querySelector('.cur-val').textContent = v;
                markDirty();
            });
        });
    }

    function renderAccents() {
        const list = document.getElementById('accentList');
        list.innerHTML = '';

        const preview = document.createElement('div');
        preview.className = 'accent-preview';
        preview.innerHTML = Object.keys(ACCENT_LABELS).map(key => {
            return `<span class="swatch-pill" data-accent-pill="${key}" style="background:${effectiveAccent(key)}">
                <span class="dot"></span>${ACCENT_LABELS[key]}
            </span>`;
        }).join('');
        list.appendChild(preview);

        for (const key of Object.keys(ACCENT_LABELS)) {
            const val = effectiveAccent(key);
            const row = document.createElement('div');
            row.className = 'color-row';
            row.innerHTML = `
                <label>${ACCENT_LABELS[key]}</label>
                <input type="color" value="${val}" data-accent-key="${key}">
                <input type="text" value="${val}" data-accent-key="${key}">`;
            list.appendChild(row);
        }
        list.querySelectorAll('input[data-accent-key]').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const key = e.target.dataset.accentKey;
                state.accents[key] = e.target.value;
                const siblings = e.target.parentElement.querySelectorAll('input[data-accent-key]');
                siblings.forEach(s => { if (s !== e.target) s.value = e.target.value; });
                const pill = list.querySelector(`[data-accent-pill="${key}"]`);
                if (pill) pill.style.background = e.target.value;
                markDirty();
            });
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    let _globalEditId = null;

    async function renderDevNotes() {
        const list = document.getElementById('devNotesList');
        let notes = [];
        try {
            const r = await fetch('/api/devnotes/global');
            if (r.ok) notes = (await r.json()).notes || [];
        } catch (e) { /* empty */ }
        if (!notes.length) {
            list.innerHTML = `<div style="font-size:13px;color:var(--text-muted);padding:8px 0">No notes yet.</div>`;
            return;
        }
        list.innerHTML = notes.map(n => {
            if (_globalEditId === n.id) {
                return `<div style="padding:8px 0;border-top:1px solid var(--border)">
                    <textarea data-edit-id="${escapeHtml(n.id)}" style="width:100%;box-sizing:border-box;min-height:72px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit;background:var(--bg);color:var(--text);resize:vertical">${escapeHtml(n.text)}</textarea>
                    <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end">
                        <button data-save-id="${escapeHtml(n.id)}" style="padding:5px 12px;border:none;border-radius:6px;background:var(--text);color:var(--bg);font-size:12px;font-weight:600;cursor:pointer">Save</button>
                        <button data-cancel-edit="1" style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--text-muted);font-size:12px;cursor:pointer">Cancel</button>
                    </div>
                </div>`;
            }
            return `<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--border);font-size:13px">
                <div style="flex:1">${escapeHtml(n.text)}</div>
                <div style="font-size:11px;color:var(--text-muted);white-space:nowrap">${escapeHtml(n.created || '')}</div>
                <button data-edit-trigger="${escapeHtml(n.id)}" title="Edit" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;padding:0 4px">&#9998;</button>
                <button data-remove-id="${escapeHtml(n.id)}" title="Remove" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0 4px">&times;</button>
            </div>`;
        }).join('');
        list.querySelectorAll('[data-remove-id]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Remove this note?')) return;
                await fetch('/api/devnote/remove', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ tab: 'global', id: btn.dataset.removeId }),
                });
                renderDevNotes();
            });
        });
        list.querySelectorAll('[data-edit-trigger]').forEach(btn => {
            btn.addEventListener('click', () => {
                _globalEditId = btn.dataset.editTrigger;
                renderDevNotes().then(() => {
                    const ta = list.querySelector(`[data-edit-id="${_globalEditId}"]`);
                    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
                });
            });
        });
        list.querySelectorAll('[data-cancel-edit]').forEach(btn => {
            btn.addEventListener('click', () => { _globalEditId = null; renderDevNotes(); });
        });
        list.querySelectorAll('[data-save-id]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const ta = list.querySelector(`[data-edit-id="${btn.dataset.saveId}"]`);
                const text = ta ? ta.value.trim() : '';
                if (!text) return;
                await fetch('/api/devnote/edit', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ tab: 'global', id: btn.dataset.saveId, text }),
                });
                _globalEditId = null;
                renderDevNotes();
            });
        });
    }

    async function addDevNote(inputId) {
        const inp = document.getElementById(inputId || 'devNoteInput');
        if (!inp) return;
        const text = inp.value.trim();
        if (!text) return;
        const r = await fetch('/api/devnote/add', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ tab: 'global', text }),
        });
        if (r.ok) {
            inp.value = '';
            const other = document.getElementById(inputId === 'devNoteInputBottom' ? 'devNoteInput' : 'devNoteInputBottom');
            if (other) other.value = '';
            renderDevNotes();
        }
    }

    async function changePassword() {
        const cur = document.getElementById('pwCurrent').value;
        const nw = document.getElementById('pwNew').value;
        const cn = document.getElementById('pwConfirm').value;
        const msg = document.getElementById('pwMsg');
        msg.className = '';
        if (!cur || !nw) { msg.textContent = 'Fill in current and new password.'; msg.className = 'error'; return; }
        if (nw.length < 6) { msg.textContent = 'New password must be 6+ characters.'; msg.className = 'error'; return; }
        if (nw !== cn) { msg.textContent = "New and confirm don't match."; msg.className = 'error'; return; }
        msg.textContent = 'changing…';
        try {
            const r = await fetch('/api/auth/change-password', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ current: cur, new: nw }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                msg.textContent = data.error || 'Change failed';
                msg.className = 'error';
                return;
            }
            msg.textContent = 'Password updated.';
            msg.className = 'success';
            document.getElementById('pwCurrent').value = '';
            document.getElementById('pwNew').value = '';
            document.getElementById('pwConfirm').value = '';
        } catch (e) {
            msg.textContent = 'Network error.';
            msg.className = 'error';
        }
    }

    window.addEventListener('beforeunload', (e) => {
        if (window.__settingsDirty) { e.preventDefault(); e.returnValue = ''; }
    });
})();
