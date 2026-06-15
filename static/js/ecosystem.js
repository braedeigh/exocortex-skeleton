// ecosystem.js — a map of where her food comes from. First layer of the
// "Ecosystem" tab: each source is a grocery/meal-prep item placed on a real
// Leaflet map. A crisp dot = an exact spot; a dot inside a soft dashed circle =
// a rough region (radius = how fuzzy), because most retail sourcing is opaque.
//
// Survives the 5s polling re-render: the Leaflet map lives in the persistent
// #ecomap div, which this file NEVER rebuilds — the map object is created once
// (window._ecomap) and each render only syncs Leaflet layers + the surrounding
// HTML panels (#ecosystem-controls / -legend / -panel / -area).

const ECO_AUSTIN = [30.2672, -97.7431];   // "My region" home view (Austin / TX)
const ECO_REGION_ZOOM = 5;                 // frames Texas + neighbors
const ECO_COLOR = '#2f9e7f';               // one calm green for every source dot

function _ecoSources() {
    return (D && D.ecosystem && D.ecosystem.sources) || [];
}

// --- Map lifecycle (created once, then reused) -------------------------------
function _ecoEnsureMap() {
    if (window._ecomap) return window._ecomap;
    const el = document.getElementById('ecomap');
    if (!el) return null;
    const map = L.map(el, { zoomControl: true }).setView(ECO_AUSTIN, ECO_REGION_ZOOM);
    window._ecomap = map;
    window._ecoLayer = L.layerGroup().addTo(map);   // holds all source dots/circles
    window._ecoMarkers = {};
    map.on('click', _ecoMapClick);                  // tap-to-place while adding/editing
    return map;
}

// Pick the CARTO basemap that matches the current theme by reading --bg's
// luminance — works for auto/sky/light/dark without a body class to watch.
function _ecoIsDark() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const rgb = _ecoParseColor(bg);
    if (!rgb) return false;
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return lum < 0.5;
}
function _ecoParseColor(s) {
    if (!s) return null;
    if (s[0] === '#') {
        let h = s.slice(1);
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (h.length < 6) return null;
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(',').map(x => parseFloat(x)); return [p[0], p[1], p[2]]; }
    return null;
}
function _ecoSyncTiles() {
    const map = window._ecomap; if (!map) return;
    const key = _ecoIsDark() ? 'dark' : 'light';
    if (window._ecoTilesKey === key) return;
    if (window._ecoTiles) map.removeLayer(window._ecoTiles);
    const url = key === 'dark'
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    window._ecoTiles = L.tileLayer(url, {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd', maxZoom: 19,
    }).addTo(map);
    window._ecoTiles.bringToBack();
    window._ecoTilesKey = key;
}

// --- Source dots + circles (synced only when the data actually changes, so an
//     open popup isn't yanked shut on every 5s poll) ---------------------------
function _ecoSyncMarkers() {
    const map = window._ecomap; if (!map || !window._ecoLayer) return;
    const src = _ecoSources();
    const key = JSON.stringify(src);
    if (window._ecoLastSources === key) return;
    window._ecoLastSources = key;
    window._ecoLayer.clearLayers();
    window._ecoMarkers = {};
    src.forEach(s => {
        if (typeof s.lat !== 'number' || typeof s.lng !== 'number') return;
        if (s.precision === 'area' && s.radius_km > 0) {
            L.circle([s.lat, s.lng], {
                radius: s.radius_km * 1000, color: ECO_COLOR, weight: 1,
                fillColor: ECO_COLOR, fillOpacity: 0.12, opacity: 0.45, dashArray: '4 4',
            }).addTo(window._ecoLayer);
        }
        const cm = L.circleMarker([s.lat, s.lng], {
            radius: 7, color: '#fff', weight: 2, fillColor: ECO_COLOR, fillOpacity: 0.95,
        }).addTo(window._ecoLayer);
        cm.bindPopup(_ecoPopupHtml(s));
        window._ecoMarkers[s.id] = cm;
    });
}
function _ecoPopupHtml(s) {
    const area = s.precision === 'area' && s.radius_km > 0;
    const meta = area ? ('~' + Math.round(s.radius_km) + ' km region') : 'exact spot';
    return `<div style="min-width:170px">
        <div style="font-size:14px;font-weight:700;margin-bottom:2px">${esc(s.name)}</div>
        ${s.note ? `<div style="font-size:12px;color:#555;margin-bottom:4px">${esc(s.note)}</div>` : ''}
        <div style="font-size:11px;color:#888;margin-bottom:8px">${meta}</div>
        <div style="display:flex;gap:6px">
            <button onclick="_ecoEditOpen('${esc(s.id)}')" style="flex:1;height:30px;border-radius:6px;border:1px solid #ccc;background:#fff;font-size:12px;font-weight:600;cursor:pointer">Edit</button>
            <button onclick="_ecoDelete('${esc(s.id)}','${escJs(s.name)}')" style="flex:1;height:30px;border-radius:6px;border:1px solid #e0b4b4;background:#fff;color:#c0392b;font-size:12px;font-weight:600;cursor:pointer">Delete</button>
        </div>
    </div>`;
}

// --- Draft pin (the one being added/edited): a draggable divIcon marker, so we
//     need no marker-image assets, plus a live preview circle for area mode -----
function _ecoSyncDraftMarker() {
    const map = window._ecomap; if (!map) return;
    if (window._ecoTemp) { map.removeLayer(window._ecoTemp); window._ecoTemp = null; }
    if (window._ecoTempCircle) { map.removeLayer(window._ecoTempCircle); window._ecoTempCircle = null; }
    const d = window._ecoDraft;
    if (!d || typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
    if (d.precision === 'area' && d.radius_km > 0) {
        window._ecoTempCircle = L.circle([d.lat, d.lng], {
            radius: d.radius_km * 1000, color: '#7c5cbf', weight: 1,
            fillColor: '#7c5cbf', fillOpacity: 0.12, opacity: 0.55, dashArray: '4 4',
        }).addTo(map);
    }
    const icon = L.divIcon({
        className: 'eco-draft-pin',
        html: '<div style="width:18px;height:18px;border-radius:50%;background:#7c5cbf;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></div>',
        iconSize: [18, 18], iconAnchor: [9, 9],
    });
    const m = L.marker([d.lat, d.lng], { draggable: true, icon }).addTo(map);
    m.on('drag', e => {
        const p = e.target.getLatLng();
        window._ecoDraft.lat = p.lat; window._ecoDraft.lng = p.lng;
        if (window._ecoTempCircle) window._ecoTempCircle.setLatLng(p);
    });
    m.on('dragend', _ecoUpdateLocReadout);
    window._ecoTemp = m;
}
function _ecoMapClick(e) {
    if (!window._ecoDraft) return;            // only places a pin while adding/editing
    window._ecoDraft.lat = e.latlng.lat;
    window._ecoDraft.lng = e.latlng.lng;
    _ecoSyncDraftMarker();
    _ecoUpdateLocReadout();
}
function _ecoUpdateLocReadout() {
    const d = window._ecoDraft;
    const el = document.getElementById('eco-loc-readout');
    if (el && d && typeof d.lat === 'number') {
        el.style.color = 'var(--green)';
        el.textContent = '📍 ' + d.lat.toFixed(3) + ', ' + d.lng.toFixed(3);
    }
}

// --- Toolbar: Add button + region/world toggle -------------------------------
function _ecoControls() {
    const el = document.getElementById('ecosystem-controls'); if (!el) return;
    const view = window._ecoView || 'region';
    const adding = !!window._ecoDraft;
    const btn = 'height:38px;padding:0 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer';
    const seg = (v, label) => `<button onclick="_ecoSetView('${v}')" style="${btn};border:1px solid ${view === v ? 'var(--accent)' : 'var(--border)'};background:${view === v ? 'rgba(124,92,191,0.12)' : 'none'};color:var(--text)">${label}</button>`;
    el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        ${adding ? '' : `<button onclick="_ecoAddNew()" style="${btn};border:none;background:var(--green);color:#fff">&#65291; Add food</button>`}
        <div style="display:flex;gap:6px;margin-left:auto">${seg('region', 'My region')}${seg('world', 'Whole world')}</div>
    </div>`;
}
function _ecoSetView(v) {
    window._ecoView = v;
    const map = window._ecomap;
    if (map) {
        if (v === 'world') {
            const src = _ecoSources().filter(s => typeof s.lat === 'number' && typeof s.lng === 'number');
            if (src.length) map.fitBounds(L.latLngBounds(src.map(s => [s.lat, s.lng])).pad(0.3), { maxZoom: 6 });
            else map.setView([20, 0], 2);
        } else {
            map.setView(ECO_AUSTIN, ECO_REGION_ZOOM);
        }
    }
    _ecoControls();
}

// --- Legend ------------------------------------------------------------------
function _ecoLegend() {
    const el = document.getElementById('ecosystem-legend'); if (!el) return;
    el.innerHTML = `<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--text-muted);margin-bottom:12px">
        <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:12px;height:12px;border-radius:50%;background:${ECO_COLOR};border:2px solid #fff;box-shadow:0 0 0 1px var(--border)"></span> exact spot</span>
        <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:15px;height:15px;border-radius:50%;background:${ECO_COLOR}22;border:1px dashed ${ECO_COLOR}"></span> rough region &mdash; circle size = how fuzzy</span>
    </div>`;
}

// --- Add / edit panel (form) -------------------------------------------------
function _ecoAddNew() {
    window._ecoDraft = { name: '', note: '', precision: 'point', radius_km: 0, lat: null, lng: null };
    _ecoSyncDraftMarker(); _ecoControls(); _ecoPanel();
}
function _ecoEditOpen(id) {
    const s = _ecoSources().find(x => x.id === id); if (!s) return;
    if (window._ecomap) window._ecomap.closePopup();
    window._ecoDraft = {
        id: s.id, name: s.name, note: s.note || '',
        precision: s.precision || 'point', radius_km: s.radius_km || 0,
        lat: s.lat, lng: s.lng,
    };
    _ecoSyncDraftMarker();
    if (window._ecomap && typeof s.lat === 'number') window._ecomap.panTo([s.lat, s.lng]);
    _ecoControls(); _ecoPanel();
    const p = document.getElementById('ecosystem-panel');
    if (p) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function _ecoCancel() {
    window._ecoDraft = null;
    _ecoSyncDraftMarker(); _ecoControls(); _ecoPanel();
}
function _ecoDraftSet(field, val) {
    const d = window._ecoDraft; if (!d) return;
    if (field === 'radius_km') {
        d.radius_km = parseFloat(val) || 0;
        if (window._ecoTempCircle) window._ecoTempCircle.setRadius(d.radius_km * 1000);
        return;
    }
    if (field === 'precision') {
        d.precision = val === 'area' ? 'area' : 'point';
        if (d.precision === 'area' && !(d.radius_km > 0)) d.radius_km = 100;
        _ecoPanel(); _ecoSyncDraftMarker();
        return;
    }
    d[field] = val;
}
function _ecoPanel() {
    const el = document.getElementById('ecosystem-panel'); if (!el) return;
    const d = window._ecoDraft;
    if (!d) { el.innerHTML = ''; return; }
    const editing = !!d.id;
    const area = d.precision === 'area';
    const inp = 'padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box;width:100%';
    const segBtn = (on) => `height:38px;border-radius:8px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};background:${on ? 'rgba(124,92,191,0.12)' : 'none'};color:var(--text);font-size:13px;font-weight:600;cursor:pointer;flex:1`;
    const hasLoc = typeof d.lat === 'number' && typeof d.lng === 'number';
    const loc = hasLoc
        ? `<span id="eco-loc-readout" style="color:var(--green)">📍 ${d.lat.toFixed(3)}, ${d.lng.toFixed(3)}</span>`
        : `<span id="eco-loc-readout" style="color:var(--text-muted)">Tap the map to set the location</span>`;
    el.innerHTML = `<div style="border:1px solid var(--accent);border-radius:12px;padding:16px;margin-bottom:14px;background:var(--card-bg)">
        <div style="font-size:16px;font-weight:700;margin-bottom:10px">${editing ? 'Edit source' : 'New food source'}</div>
        <input id="eco-f-name" type="text" value="${esc(d.name || '')}" oninput="_ecoDraftSet('name',this.value)" placeholder="What food? (e.g. HEB chuck roast)" style="${inp};margin-bottom:8px">
        <input id="eco-f-note" type="text" value="${esc(d.note || '')}" oninput="_ecoDraftSet('note',this.value)" placeholder="Sourcing note (vendor, what's known…)" style="${inp};margin-bottom:10px">
        <div style="display:flex;gap:8px;margin-bottom:10px">
            <button onclick="_ecoDraftSet('precision','point')" style="${segBtn(!area)}">&#9679; Exact spot</button>
            <button onclick="_ecoDraftSet('precision','area')" style="${segBtn(area)}">&#9711; Rough region</button>
        </div>
        ${area ? `<div style="margin-bottom:10px">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Region radius: <b id="eco-r-label">${Math.round(d.radius_km || 0)}</b> km</label>
            <input type="range" min="5" max="2000" step="5" value="${d.radius_km || 100}" oninput="_ecoDraftSet('radius_km',this.value);document.getElementById('eco-r-label').textContent=Math.round(this.value)" style="width:100%">
        </div>` : ''}
        <div style="font-size:12px;margin-bottom:12px">${loc}</div>
        <div style="display:flex;gap:8px">
            <button onclick="_ecoSave()" style="height:40px;padding:0 20px;border-radius:8px;border:none;background:var(--green);color:#fff;font-size:14px;font-weight:700;cursor:pointer">${editing ? 'Save' : 'Add to map'}</button>
            <button onclick="_ecoCancel()" style="height:40px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;font-weight:600;cursor:pointer">Cancel</button>
        </div>
    </div>`;
}

async function _ecoPost(url, payload) {
    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Save failed.');
        return false;
    }
    return true;
}
async function _ecoSave() {
    const d = window._ecoDraft; if (!d) return;
    if (!d.name || !d.name.trim()) { alert('Name the food first.'); return; }
    if (typeof d.lat !== 'number' || typeof d.lng !== 'number') { alert('Tap the map to set a location first.'); return; }
    const payload = {
        name: d.name.trim(), note: (d.note || '').trim(),
        lat: d.lat, lng: d.lng, precision: d.precision,
        radius_km: d.precision === 'area' ? (d.radius_km || 0) : 0,
    };
    const url = d.id ? '/api/ecosystem/source/update' : '/api/ecosystem/source/add';
    if (d.id) payload.id = d.id;
    if (await _ecoPost(url, payload)) {
        window._ecoDraft = null;
        _ecoSyncDraftMarker();
        window._ecoLastSources = null;     // force a marker re-sync after the change
        await loadDashboard();
    }
}
function _ecoDelete(id, name) {
    if (window._ecomap) window._ecomap.closePopup();
    pendingDelete = { item: id, type: 'ecosystem-source', label: name };
    document.getElementById('modal-text').innerHTML = `Remove <b>${esc(name)}</b> from the map?`;
    document.getElementById('modal').classList.add('open');
}

// --- List under the map ------------------------------------------------------
function _ecoList() {
    const el = document.getElementById('ecosystem-area'); if (!el) return;
    const src = _ecoSources();
    if (!src.length) {
        el.innerHTML = `<div style="color:var(--text-muted);font-style:italic;padding:16px;border:1px dashed var(--border);border-radius:8px;text-align:center;font-size:14px">No food sources yet. Tap &#65291; Add food, then tap the map to place it.</div>`;
        return;
    }
    el.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin:4px 0 10px">${src.length} source${src.length === 1 ? '' : 's'}</div>`
        + src.map(_ecoListRow).join('');
}
function _ecoListRow(s) {
    const area = s.precision === 'area' && s.radius_km > 0;
    const tag = `<span style="flex:none;font-size:11px;color:var(--text-muted);white-space:nowrap">${area ? '~' + Math.round(s.radius_km) + ' km' : 'exact'}</span>`;
    const note = s.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(s.note)}</div>` : '';
    return `<div onclick="_ecoFocus('${esc(s.id)}')" style="display:flex;align-items:center;gap:12px;border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer;min-height:44px;background:var(--card-bg)">
        <span style="flex:none;width:12px;height:12px;border-radius:50%;background:${ECO_COLOR};border:2px solid #fff;box-shadow:0 0 0 1px var(--border)"></span>
        <div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:600;color:var(--text)">${esc(s.name)}</div>
            ${note}
        </div>
        ${tag}
        <button onclick="event.stopPropagation();_ecoEditOpen('${esc(s.id)}')" style="flex:none;height:34px;padding:0 12px;border-radius:7px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:13px;font-weight:600;cursor:pointer">Edit</button>
    </div>`;
}
function _ecoFocus(id) {
    const s = _ecoSources().find(x => x.id === id);
    if (!s || typeof s.lat !== 'number') return;
    const map = window._ecomap;
    if (map) {
        map.setView([s.lat, s.lng], s.precision === 'area' ? 6 : 9);
        const m = window._ecoMarkers && window._ecoMarkers[s.id];
        if (m) m.openPopup();
    }
    const top = document.getElementById('ecomap');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- Entry point (called by the render loop, incl. the 5s poll) --------------
function renderEcosystem() {
    if (typeof L === 'undefined') return;     // Leaflet not loaded
    const map = _ecoEnsureMap(); if (!map) return;
    _ecoSyncTiles();
    _ecoSyncMarkers();
    _ecoControls();
    _ecoLegend();
    _ecoPanel();
    _ecoList();
    // The host div was display:none until the tab opened — let Leaflet recompute
    // its size now that it's visible (otherwise tiles render into a 0×0 box).
    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 0);
}
