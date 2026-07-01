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
const ECO_COLOR = '#2f9e7f';               // fallback / draft-pin green

// Dot color = how disclosed the origin is (the Proper axis). Dot shape (crisp vs
// soft circle) still carries precision. Two honest axes: how visible × how exact.
const ECO_TX = {
    disclosed: { color: '#2f9e7f', label: 'disclosed', blurb: 'named / certified / confirmed' },
    partial:   { color: '#e0a82e', label: 'partial',   blurb: 'country known, not the farm' },
    opaque:    { color: '#d4554a', label: 'opaque',    blurb: 'nothing disclosed' },
    unrated:   { color: '#9aa0a6', label: 'unrated',   blurb: 'not researched yet' },
};
const ECO_TX_ORDER = ['disclosed', 'partial', 'opaque', 'unrated'];   // most → least Proper
function _ecoTx(s) { return ECO_TX[s && s.transparency] || ECO_TX.unrated; }

// A third honest axis: how the DOT itself got placed (vs. transparency = how
// disclosed the chain is, precision = how exact the area is). Keeps a proxy dot
// from masquerading as a factual placement of THIS item.
const ECO_GEO = {
    placed:  { icon: '📍', label: 'placed',     blurb: 'exact spot I chose — a claim about this item' },
    proxy:   { icon: '≈',  label: 'USDA proxy', blurb: 'where this is generally grown — not necessarily this item' },
    guess:   { icon: '~',  label: 'rough guess', blurb: 'eyeballed a rough region' },
    unrated: { icon: '·',  label: 'unset',      blurb: "how the dot was placed isn't marked" },
};
const ECO_GEO_ORDER = ['placed', 'proxy', 'guess'];   // the three settable choices
function _ecoGeo(s) { return ECO_GEO[s && s.geo_source] || ECO_GEO.unrated; }

// Editing is owner-only. On the public standalone map (/food-map) VIEW_MODE is
// "public", so the Add button and per-source Edit/Delete are withheld — viewers
// still get the map, legend, transparency filters and recipe tracing, read-only.
function _ecoCanEdit() { return !window.VIEW_MODE || window.VIEW_MODE === 'authed'; }

function _ecoSources() {
    return (D && D.ecosystem && D.ecosystem.sources) || [];
}

// --- Recipe tracing (the kitchen ↔ map bridge) -------------------------------
// When a recipe is "traced", its matched sources are emphasized on the map and
// the rest dim. Matching lives in eco-match.js (shared with the kitchen tab).
function _ecoRecipes() { return (D && (D.eco_recipes || D.recipes)) || []; }
function _ecoActiveRecipe() {
    if (!window._ecoRecipeView) return null;
    return _ecoRecipes().find(r => r.id === window._ecoRecipeView) || null;
}

// --- Boundary GeoJSON (lazy: the counties file is ~3MB, so only fetch it once,
//     and only when a real region actually needs drawing) ----------------------
function _ecoLoadGeo() {
    if (window._ecoGeo) return Promise.resolve(window._ecoGeo);
    if (window._ecoGeoPromise) return window._ecoGeoPromise;
    window._ecoGeoPromise = Promise.all([
        fetch('/static/vendor/geo/us-counties.geojson').then(r => r.json()),
        fetch('/static/vendor/geo/us-states.geojson').then(r => r.json()),
    ]).then(([counties, states]) => {
        const byFips = {};
        counties.features.forEach(f => { byFips[f.id] = f; });
        const byState = {};
        states.features.forEach(f => { byState[(f.properties.name || '').toLowerCase()] = f; });
        window._ecoGeo = { byFips, byState };
        return window._ecoGeo;
    }).catch(e => { window._ecoGeoPromise = null; throw e; });
    return window._ecoGeoPromise;
}
// GeoJSON features for a shape-region source/draft (or [] if geo isn't loaded
// yet / nothing matched). `s` only needs {area_kind, counties, region_name}.
function _ecoFeatures(s) {
    const geo = window._ecoGeo; if (!geo) return [];
    if (s.area_kind === 'counties') return [...new Set(s.counties || [])].map(f => geo.byFips[f]).filter(Boolean);
    if (s.area_kind === 'state' && s.region_name) {
        const f = geo.byState[s.region_name.toLowerCase()];
        return f ? [f] : [];
    }
    return [];
}
function _ecoIsShape(s) {
    return s && s.precision === 'area' && (s.area_kind === 'counties' || s.area_kind === 'state');
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

// Convert a GeoJSON Polygon/MultiPolygon into Leaflet [lat,lng] ring arrays for
// L.polygon. We draw regions with L.polygon directly instead of L.geoJSON — the
// GeoJSON layer was throwing in-browser and taking the whole map down with it.
// Returns null for anything unexpected (caller falls back to a dot).
function _ecoLatLngs(geom) {
    if (!geom) return null;
    const ring = r => r.map(p => [p[1], p[0]]);   // GeoJSON [lng,lat] -> Leaflet [lat,lng]
    if (geom.type === 'Polygon') return geom.coordinates.map(ring);               // [outer, hole, …]
    if (geom.type === 'MultiPolygon') return geom.coordinates.map(poly => poly.map(ring));
    return null;
}

// --- Source dots + circles + region shapes (synced only when the data actually
//     changes, so an open popup isn't yanked shut on every 5s poll) ------------
function _ecoSyncMarkers() {
    const map = window._ecomap; if (!map || !window._ecoLayer) return;
    const src = _ecoSources();
    // A filter (a traced recipe, or a single item picked from the list) hides
    // every source outside it — only what's in `visible` is drawn at all.
    const visible = _ecoVisibleIds();
    const key = JSON.stringify(src) + '|' + (visible ? [...visible].sort().join(',') : '');
    if (window._ecoLastSources === key) return;
    window._ecoLastSources = key;
    window._ecoLayer.clearLayers();
    window._ecoMarkers = {};
    // County/state regions need the boundary GeoJSON. Load it once, then re-sync
    // (until it's here those sources stand in as dots).
    if (!window._ecoGeo && !window._ecoGeoPromise && src.some(_ecoIsShape)) {
        _ecoLoadGeo().then(() => { window._ecoLastSources = null; _ecoSyncMarkers(); }).catch(() => {});
    }
    src.forEach(s => {
        if (typeof s.lat !== 'number' || typeof s.lng !== 'number') return;
        if (visible && !visible.has(s.id)) return;          // filtered out — don't draw it
        const col = _ecoTx(s).color;
        const dot = () => {
            const d = L.circleMarker([s.lat, s.lng], {
                radius: 7, color: '#fff', weight: 2, fillColor: col, fillOpacity: 0.95,
            }).addTo(window._ecoLayer);
            d.bindPopup(_ecoPopupHtml(s));
            return d;
        };
        // Each source draws in isolation: a single bad shape must NOT abort the
        // loop and hide every other source. On any failure we log the offender
        // and fall back to a plain dot, so the source still lands on the map.
        let host = null;
        try {
            if (s.precision === 'area' && _ecoIsShape(s)) {
                // Real county/state outlines, drawn as raw polygons (not L.geoJSON),
                // colored by transparency. Falls through to a dot if geo isn't loaded.
                const feats = _ecoFeatures(s);
                if (feats.length) {
                    const style = { color: col, weight: 1, fillColor: col, fillOpacity: 0.2, opacity: 0.6 };
                    const grp = L.featureGroup();
                    feats.forEach(f => {
                        const ll = _ecoLatLngs(f.geometry);
                        if (ll) L.polygon(ll, style).addTo(grp);
                    });
                    if (grp.getLayers().length) {
                        grp.addTo(window._ecoLayer);
                        grp.bindPopup(_ecoPopupHtml(s));   // click anywhere in the region
                        host = grp;
                    }
                }
            } else if (s.precision === 'area' && s.radius_km > 0) {
                // A rough circle region — a soft hunch, not an exact spot.
                host = L.circle([s.lat, s.lng], {
                    radius: s.radius_km * 1000, color: col, weight: 1,
                    fillColor: col, fillOpacity: 0.12, opacity: 0.45, dashArray: '4 4',
                }).addTo(window._ecoLayer);
                host.bindPopup(_ecoPopupHtml(s));
            }
            if (!host) host = dot();   // exact point, or shapes not loaded yet
        } catch (e) {
            console.error('ecosystem: failed to draw "' + (s.name || s.id) + '" (' + s.area_kind + '/' + s.precision + '):', e);
            try { host = dot(); } catch (e2) { host = null; }
        }
        if (host) window._ecoMarkers[s.id] = host;
    });
}

// The set of source ids allowed on the map, or null for "show all". Active
// filters STACK (intersect): transparency chip ∩ traced recipe ∩ single-item
// pick. So "partial" narrows the map to partial sources, and then clicking a row
// drills into that one within the chip's filter.
function _ecoVisibleIds() {
    const all = _ecoSources();
    let ids = null;   // null = unconstrained
    const intersect = (set) => { ids = ids ? new Set([...ids].filter(x => set.has(x))) : set; };
    if (window._ecoTxFilter) {
        const txOf = s => (s.transparency in ECO_TX) ? s.transparency : 'unrated';
        intersect(new Set(all.filter(s => txOf(s) === window._ecoTxFilter).map(s => s.id)));
    }
    const recipe = _ecoActiveRecipe();
    if (recipe) intersect(ecoRecipeSourceIds(recipe, all));
    if (window._ecoSoloSource) intersect(new Set([window._ecoSoloSource]));
    return ids;
}
// A short human label for what a source's footprint is.
function _ecoMetaLabel(s) {
    if (s.precision === 'area' && s.area_kind === 'counties') {
        const n = new Set(s.counties || []).size;
        return n + (n === 1 ? ' county' : ' counties') + ' (USDA)';
    }
    if (s.precision === 'area' && s.area_kind === 'state') return (s.region_name || 'state') + ' (state)';
    if (s.precision === 'area' && s.radius_km > 0) return '~' + Math.round(s.radius_km) + ' km region';
    return 'exact spot';
}
function _ecoPopupHtml(s) {
    const meta = _ecoMetaLabel(s);
    const tx = _ecoTx(s);
    const chip = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${tx.color};margin-right:5px;vertical-align:middle"></span>${tx.label}`;
    const g = _ecoGeo(s);
    const geoLine = (s.geo_source && s.geo_source !== 'unrated')
        ? `<div style="font-size:11px;color:#999;margin-bottom:8px">${g.icon} ${g.label}${s.geo_source === 'proxy' ? ' — generally grown here, not necessarily this item&rsquo;s source' : ''}</div>`
        : '';
    return `<div style="min-width:170px">
        <div style="font-size:14px;font-weight:700;margin-bottom:2px">${esc(s.name)}</div>
        ${s.note ? `<div style="font-size:12px;color:#555;margin-bottom:4px">${esc(s.note)}</div>` : ''}
        <div style="font-size:11px;color:#888;margin-bottom:${geoLine ? '4px' : '8px'}">${chip} &middot; ${meta}</div>
        ${geoLine}
        ${_ecoCanEdit() ? `<div style="display:flex;gap:6px">
            <button onclick="_ecoEditOpen('${esc(s.id)}')" style="flex:1;height:30px;border-radius:6px;border:1px solid #ccc;background:#fff;font-size:12px;font-weight:600;cursor:pointer">Edit</button>
            <button onclick="_ecoDelete('${esc(s.id)}','${escJs(s.name)}')" style="flex:1;height:30px;border-radius:6px;border:1px solid #e0b4b4;background:#fff;color:#c0392b;font-size:12px;font-weight:600;cursor:pointer">Delete</button>
        </div>` : ''}
    </div>`;
}

// --- Draft pin (the one being added/edited): a draggable divIcon marker, so we
//     need no marker-image assets, plus a live preview circle for area mode -----
function _ecoSyncDraftMarker() {
    const map = window._ecomap; if (!map) return;
    if (window._ecoTemp) { map.removeLayer(window._ecoTemp); window._ecoTemp = null; }
    if (window._ecoTempCircle) { map.removeLayer(window._ecoTempCircle); window._ecoTempCircle = null; }
    if (window._ecoTempShapes) { map.removeLayer(window._ecoTempShapes); window._ecoTempShapes = null; }
    const d = window._ecoDraft;
    if (!d || typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
    if (_ecoIsShape(d)) {
        const feats = _ecoFeatures(d);
        if (feats.length) {
            window._ecoTempShapes = L.geoJSON(feats, { style: { color: '#7c5cbf', weight: 1, fillColor: '#7c5cbf', fillOpacity: 0.15, opacity: 0.6 } }).addTo(map);
            return;   // outlines shown — skip the draggable anchor pin
        }
    } else if (d.precision === 'area' && d.radius_km > 0) {
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
    if (el && d && typeof d.lat === 'number' && typeof d.lng === 'number') {
        el.style.color = 'var(--green)';
        el.textContent = '📍 ' + d.lat.toFixed(3) + ', ' + d.lng.toFixed(3);
    }
}
// Typed-in coordinates (one field at a time). Syncs the pin/readout once both are
// valid numbers, leaving the map alone while only one is filled in.
function _ecoSetCoord(field, val) {
    const d = window._ecoDraft; if (!d) return;
    const n = parseFloat(val);
    d[field] = isNaN(n) ? null : n;
    _ecoSyncDraftMarker();
    if (typeof d.lat === 'number' && typeof d.lng === 'number') {
        _ecoUpdateLocReadout();
        if (window._ecomap) window._ecomap.panTo([d.lat, d.lng]);
    }
}
// Geocode a typed address → pin (server-side, via the /geocode endpoint), then
// drop the spot there and reflect it into the coord fields + readout.
async function _ecoGeocode() {
    const d = window._ecoDraft; if (!d) return;
    const inp = document.getElementById('eco-addr');
    const msg = document.getElementById('eco-addr-msg');
    const q = (inp && inp.value || '').trim();
    if (!q) { if (msg) msg.textContent = 'Type an address or place first.'; return; }
    if (msg) msg.textContent = 'Searching…';
    let j = {};
    try {
        const res = await fetch('/api/ecosystem/geocode', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: q }),
        });
        j = await res.json();
    } catch (e) { if (msg) msg.textContent = 'Network error reaching the geocoder.'; return; }
    if (!j || !j.ok) { if (msg) msg.textContent = (j && j.reason) || 'No match found.'; return; }
    d.precision = 'point'; d.lat = j.lat; d.lng = j.lng;
    d.geo_source = 'placed';   // a geocoded address is a deliberate, exact placement
    _ecoSyncDraftMarker();
    if (window._ecomap) window._ecomap.setView([d.lat, d.lng], 13);
    _ecoUpdateLocReadout();
    const la = document.getElementById('eco-lat'), lo = document.getElementById('eco-lng');
    if (la) la.value = d.lat;
    if (lo) lo.value = d.lng;
    if (msg) msg.textContent = j.label ? ('Found: ' + j.label) : 'Found it — adjust or save.';
}

// --- Toolbar: Add button + region/world toggle -------------------------------
function _ecoControls() {
    const el = document.getElementById('ecosystem-controls'); if (!el) return;
    const view = window._ecoView || 'region';
    const adding = !!window._ecoDraft;
    const btn = 'height:38px;padding:0 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer';
    const seg = (v, label) => `<button onclick="_ecoSetView('${v}')" style="${btn};border:1px solid ${view === v ? 'var(--accent)' : 'var(--border)'};background:${view === v ? 'rgba(124,92,191,0.12)' : 'none'};color:var(--text)">${label}</button>`;
    const recipes = _ecoRecipes();
    const rv = window._ecoRecipeView || '';
    const recipePicker = recipes.length ? `<select onchange="_ecoSetRecipe(this.value)" title="Trace where a recipe's ingredients come from" style="height:38px;border-radius:8px;border:1px solid ${rv ? 'var(--accent)' : 'var(--border)'};background:var(--bg);color:var(--text);font-size:13px;padding:0 10px;max-width:220px;cursor:pointer">
        <option value="">&#127858; Trace a recipe&hellip;</option>
        ${recipes.map(r => `<option value="${esc(r.id)}"${r.id === rv ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
    </select>` : '';
    el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        ${(adding || !_ecoCanEdit()) ? '' : `<button onclick="_ecoAddNew()" style="${btn};border:none;background:var(--green);color:#fff">&#65291; Add food</button>`}
        ${recipePicker}
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

// --- Recipe sourcing panel (shown when a recipe is being traced) -------------
function _ecoSetRecipe(id) {
    window._ecoRecipeView = id || null;
    window._ecoSoloSource = null;       // a recipe pick clears any single-item filter
    window._ecoFittedRecipe = null;     // re-frame the map on the next render
    window._ecoLastSources = null;      // re-filter markers
    renderEcosystem();
}
// Single-item filter: clicking a source in the list below shows only that one on
// the map (click it again, or "Show all", to clear). Independent of recipe tracing.
function _ecoSetSolo(id) {
    window._ecoSoloSource = (window._ecoSoloSource === id) ? null : (id || null);
    window._ecoLastSources = null;      // re-filter markers
    if (!window._ecoSoloSource) window._ecoFittedRecipe = null;     // re-frame recipe/all on clear
    renderEcosystem();
    if (window._ecoSoloSource) _ecoFocus(window._ecoSoloSource);   // zoom + open its popup
}
// Frame the map on a traced recipe's matched sources (once per selection).
function _ecoFitRecipe(recipe) {
    const map = window._ecomap; if (!map || !recipe) return;
    map.invalidateSize(false);   // tab may have been hidden — refresh cached size so the fit centers right
    const ids = ecoRecipeSourceIds(recipe, _ecoSources());
    const pts = _ecoSources().filter(s => ids.has(s.id) && typeof s.lat === 'number').map(s => [s.lat, s.lng]);
    if (pts.length === 1) map.setView(pts[0], 7);
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 7 });
}
// Open the add-source form pre-filled with an untraced ingredient's name, so
// placing it is one tap → name already typed → "Suggest region" or tap the map.
function _ecoPlaceIngredient(name) {
    _ecoAddNew();
    if (window._ecoDraft) window._ecoDraft.name = name || '';
    _ecoControls(); _ecoRecipePanel(); _ecoPanel(true);
    const p = document.getElementById('ecosystem-panel');
    if (p) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function _ecoRecipePanel() {
    const el = document.getElementById('ecosystem-recipe'); if (!el) return;
    const recipe = _ecoActiveRecipe();
    // Hidden while adding/editing a source, or while a single item is isolated
    // from the list below — reappears when that single-item filter is cleared.
    if (!recipe || window._ecoDraft || window._ecoSoloSource) { el.innerHTML = ''; return; }
    const s = ecoRecipeSourcing(recipe, _ecoSources());
    const dot = (c) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 0 0 1px var(--border);flex:none"></span>`;
    const tracedRows = s.traced.map(t => {
        const tx = _ecoTx(t.source);
        return `<button onclick="_ecoFocus('${esc(t.source.id)}')" style="display:flex;width:100%;align-items:center;gap:10px;border:1px solid var(--border);border-radius:9px;padding:9px 11px;margin-bottom:6px;background:var(--bg);cursor:pointer;text-align:left;min-height:40px">
            ${dot(tx.color)}
            <span style="flex:1;font-size:14px;color:var(--text)">${esc(t.ing.item)}</span>
            <span style="font-size:12px;color:var(--text-muted)">${esc(t.source.name)} &rsaquo;</span>
        </button>`;
    }).join('');
    const placeRows = s.place.map(p => `<div style="display:flex;align-items:center;gap:10px;border:1px dashed var(--border);border-radius:9px;padding:9px 11px;margin-bottom:6px;min-height:40px">
        <span style="flex:1;font-size:14px;color:var(--text-muted)">${esc(p.ing.item)}</span>
        <button onclick="_ecoPlaceIngredient('${escJs(p.ing.item)}')" style="height:34px;padding:0 13px;border-radius:7px;border:1px solid var(--green);background:none;color:var(--green);font-size:12px;font-weight:700;cursor:pointer">&#65291; Place</button>
    </div>`).join('');
    const pantry = s.pantry.length
        ? `<div style="font-size:12px;color:var(--text-muted);opacity:.75;margin-top:8px">+ ${s.pantry.length} pantry staple${s.pantry.length === 1 ? '' : 's'} (salt, water, spices &mdash; not traced)</div>`
        : '';
    el.innerHTML = `<div style="border:1px solid var(--accent);border-radius:12px;padding:14px 16px;margin-bottom:14px;background:var(--card-bg)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:120px;font-size:16px;font-weight:700">${esc(recipe.name)}</div>
            <span style="font-size:12px;color:var(--text-muted)">traced ${s.traced.length}/${s.total}</span>
            <button onclick="_ecoSetRecipe('')" style="height:34px;padding:0 12px;border-radius:7px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer">Show all</button>
        </div>
        ${tracedRows || '<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">Nothing traced yet &mdash; place these foods below.</div>'}
        ${s.place.length ? `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px">Not yet on the map</div>${placeRows}` : ''}
        ${pantry}
    </div>`;
}

// --- Legend ------------------------------------------------------------------
function _ecoLegend() {
    const el = document.getElementById('ecosystem-legend'); if (!el) return;
    const dots = ECO_TX_ORDER.map(k => {
        const t = ECO_TX[k];
        return `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:12px;height:12px;border-radius:50%;background:${t.color};border:2px solid #fff;box-shadow:0 0 0 1px var(--border)"></span> ${t.label}</span>`;
    }).join('');
    el.innerHTML = `<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--text-muted);margin-bottom:6px">
        <span style="font-weight:700;color:var(--text)">Transparency:</span> ${dots}
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
        Crisp dot = exact spot &middot; shaded shape = a region (real county/state outlines from USDA where known; a soft circle when only roughly known).
    </div>`;
}

// --- Add / edit panel (form) -------------------------------------------------
function _ecoAddNew() {
    window._ecoDraft = { name: '', note: '', precision: 'point', radius_km: 0, lat: null, lng: null, transparency: 'unrated', area_kind: 'circle', counties: [], region_name: '', geo_source: 'unrated' };
    window._ecoKeyPrompt = false;
    _ecoSyncDraftMarker(); _ecoControls(); _ecoPanel(true);
}
function _ecoEditOpen(id) {
    const s = _ecoSources().find(x => x.id === id); if (!s) return;
    if (window._ecomap) window._ecomap.closePopup();
    window._ecoKeyPrompt = false;
    window._ecoDraft = {
        id: s.id, name: s.name, note: s.note || '',
        precision: s.precision || 'point', radius_km: s.radius_km || 0,
        lat: s.lat, lng: s.lng, transparency: s.transparency || 'unrated',
        area_kind: s.area_kind || 'circle', counties: (s.counties || []).slice(),
        region_name: s.region_name || '', geo_source: s.geo_source || 'unrated',
    };
    _ecoSyncDraftMarker();
    if (window._ecomap && typeof s.lat === 'number') window._ecomap.panTo([s.lat, s.lng]);
    _ecoControls(); _ecoRecipePanel(); _ecoPanel(true);
}
function _ecoCancel() {
    window._ecoDraft = null;
    _ecoSyncDraftMarker(); _ecoControls(); _ecoRecipePanel(); _ecoPanel(true);
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
        if (d.precision === 'area') {
            if (['circle', 'counties', 'state'].indexOf(d.area_kind) < 0) d.area_kind = 'circle';
            if (d.area_kind === 'circle' && !(d.radius_km > 0)) d.radius_km = 100;
        }
        _ecoPanel(true); _ecoSyncDraftMarker();
        return;
    }
    if (field === 'transparency') {
        d.transparency = ECO_TX[val] ? val : 'unrated';
        _ecoPanel(true);        // re-render to move the selected highlight
        return;
    }
    if (field === 'geo_source') {
        d.geo_source = ECO_GEO[val] ? val : 'unrated';
        _ecoPanel(true);
        return;
    }
    d[field] = val;
}

// --- USDA "suggest region" assist (asks where USDA says this is grown) --------
function _ecoUsdaMsg(t) { const el = document.getElementById('eco-usda-msg'); if (el) el.textContent = t || ''; }
async function _ecoSuggestUSDA() {
    const d = window._ecoDraft; if (!d) return;
    if (!d.name || !d.name.trim()) { _ecoUsdaMsg('Type the food name first.'); return; }
    _ecoUsdaMsg('Asking USDA…');
    let j = {};
    try {
        const res = await fetch('/api/ecosystem/usda/suggest', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: d.name.trim() }),
        });
        j = await res.json();
    } catch (e) { _ecoUsdaMsg('Network error reaching USDA.'); return; }
    if (j && j.ok && j.mode === 'counties') {
        await _ecoLoadGeo().catch(() => {});
        d.precision = 'area'; d.area_kind = 'counties';
        d.counties = j.counties || []; d.region_name = ''; d.radius_km = 0;
        d.geo_source = 'proxy';   // USDA = where it's generally grown, not this item
        if (!d.note) d.note = j.note || '';
        if ((d.transparency || 'unrated') === 'unrated') d.transparency = 'partial';
        window._ecoKeyPrompt = false;
        _ecoFitDraftShapes(d);
        _ecoSyncDraftMarker(); _ecoPanel(true);
        _ecoUsdaMsg('Placed ' + (j.label || 'counties') + '. Adjust or save.');
        return;
    }
    if (j && j.ok && j.mode === 'state') {
        await _ecoLoadGeo().catch(() => {});
        d.precision = 'area'; d.area_kind = 'state';
        d.region_name = j.region_name || ''; d.counties = []; d.radius_km = 0;
        d.lat = j.lat; d.lng = j.lng;
        d.geo_source = 'proxy';   // USDA = where it's generally grown, not this item
        if (!d.note) d.note = j.note || '';
        if ((d.transparency || 'unrated') === 'unrated') d.transparency = 'partial';
        window._ecoKeyPrompt = false;
        if (!_ecoFitDraftShapes(d) && window._ecomap) window._ecomap.setView([d.lat, d.lng], 6);
        _ecoSyncDraftMarker(); _ecoPanel(true);
        _ecoUsdaMsg('Placed ' + (j.label || 'state') + '. Adjust or save.');
        return;
    }
    if (j && j.need_key) { window._ecoKeyPrompt = true; _ecoPanel(true); _ecoUsdaMsg(j.reason || 'Add a free USDA key.'); return; }
    _ecoUsdaMsg((j && j.reason) || 'No suggestion available.');
}
// Set the draft anchor to the center of its shapes and frame them. Returns true
// if shapes were found (geo loaded + matched).
function _ecoFitDraftShapes(d) {
    const feats = _ecoFeatures(d);
    if (!feats.length || !window._ecomap) return false;
    const b = L.geoJSON(feats).getBounds();
    const c = b.getCenter();
    d.lat = c.lat; d.lng = c.lng;
    window._ecomap.fitBounds(b.pad(0.2));
    return true;
}
// Switch a shape region back to a plain circle.
function _ecoUseCircle() {
    const d = window._ecoDraft; if (!d) return;
    d.area_kind = 'circle'; d.counties = []; d.region_name = '';
    if (!(d.radius_km > 0)) d.radius_km = 100;
    if (d.geo_source === 'proxy') d.geo_source = 'guess';   // a hand circle is a hunch, not USDA
    _ecoSyncDraftMarker(); _ecoPanel(true);
}
async function _ecoSaveKey() {
    const inp = document.getElementById('eco-usda-key-input');
    const v = (inp && inp.value || '').trim();
    if (!v) { _ecoUsdaMsg('Paste a key first.'); return; }
    try {
        const res = await fetch('/api/ecosystem/usda/key', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: v }),
        });
        if (!res.ok) throw new Error();
        if (D) D.usda_key_set = true;
        window._ecoKeyPrompt = false;
        _ecoPanel(true);
        _ecoUsdaMsg('Key saved — tap “Suggest region” again.');
    } catch (e) { _ecoUsdaMsg('Could not save the key.'); }
}
// Adding renders inline (below the map, so you can tap to place a pin); editing
// opens the shared focused-editor modal (panel-modal), like other pages. `force`
// re-renders even when the open state is unchanged — the 5s poll passes nothing,
// so it skips and an in-progress edit keeps its focus.
function _ecoPanel(force) {
    const d = window._ecoDraft;
    const editing = !!(d && d.id);
    const desired = !d ? null : (editing ? ('edit:' + d.id) : 'add');
    if (!force && window._ecoPanelState === desired) return;
    window._ecoPanelState = desired;
    const inlineEl = document.getElementById('ecosystem-panel');
    if (!d) {
        if (inlineEl) inlineEl.innerHTML = '';
        if (window._ecoModalOpen) { window._ecoModalOpen = false; hideEditorModal(); }
        return;
    }
    const area = d.precision === 'area';
    const inp = 'padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box;width:100%';
    const segBtn = (on) => `height:38px;border-radius:8px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};background:${on ? 'rgba(124,92,191,0.12)' : 'none'};color:var(--text);font-size:13px;font-weight:600;cursor:pointer;flex:1`;
    const hasLoc = typeof d.lat === 'number' && typeof d.lng === 'number';
    const loc = hasLoc
        ? `<span id="eco-loc-readout" style="color:var(--green)">📍 ${d.lat.toFixed(3)}, ${d.lng.toFixed(3)}</span>`
        : `<span id="eco-loc-readout" style="color:var(--text-muted)">No location set yet</span>`;
    const txCur = d.transparency || 'unrated';
    const txButtons = ECO_TX_ORDER.map(k => {
        const t = ECO_TX[k]; const on = txCur === k;
        return `<button onclick="_ecoDraftSet('transparency','${k}')" title="${t.blurb}" style="flex:1;height:36px;border-radius:8px;border:1px solid ${on ? t.color : 'var(--border)'};background:${on ? t.color + '22' : 'none'};color:var(--text);font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px"><span style="width:9px;height:9px;border-radius:50%;background:${t.color};flex:none"></span>${t.label}</button>`;
    }).join('');
    const geoCur = d.geo_source || 'unrated';
    const geoButtons = ECO_GEO_ORDER.map(k => {
        const t = ECO_GEO[k]; const on = geoCur === k;
        return `<button onclick="_ecoDraftSet('geo_source','${k}')" title="${t.blurb}" style="flex:1;height:36px;border-radius:8px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};background:${on ? 'rgba(124,92,191,0.12)' : 'none'};color:var(--text);font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px">${t.icon} ${t.label}</button>`;
    }).join('');
    const keyOpen = !!window._ecoKeyPrompt;
    const useCircleBtn = `<button onclick="_ecoUseCircle()" style="height:30px;padding:0 10px;border-radius:7px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer">use a circle</button>`;
    let regionUi = '';
    if (area && d.area_kind === 'counties') {
        const n = new Set(d.counties || []).size;
        regionUi = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:13px;color:var(--text)">&#128506; ${n} county outline${n === 1 ? '' : 's'} from USDA ${useCircleBtn}</div>`;
    } else if (area && d.area_kind === 'state') {
        regionUi = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:13px;color:var(--text)">&#128506; ${esc(d.region_name || 'state')} outline ${useCircleBtn}</div>`;
    } else if (area) {
        regionUi = `<div style="margin-bottom:10px">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Region radius: <b id="eco-r-label">${Math.round(d.radius_km || 0)}</b> km</label>
            <input type="range" min="5" max="2000" step="5" value="${d.radius_km || 100}" oninput="_ecoDraftSet('radius_km',this.value);document.getElementById('eco-r-label').textContent=Math.round(this.value)" style="width:100%">
        </div>`;
    }
    // Exact-spot mode: type an address (geocoded to a pin) or raw coordinates, in
    // addition to tapping the map.
    let pointUi = '';
    if (!area) {
        pointUi = `<div style="margin-bottom:10px">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Set the spot — tap the map, search an address, or type coordinates:</div>
            <div style="display:flex;gap:6px;margin-bottom:8px">
                <input id="eco-addr" type="text" placeholder="Address or place (e.g. 1100 Congress Ave, Austin TX)" onkeydown="if(event.key==='Enter'){event.preventDefault();_ecoGeocode()}" style="${inp};flex:1">
                <button onclick="_ecoGeocode()" style="height:38px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--accent);font-size:13px;font-weight:600;cursor:pointer;flex:none">Find</button>
            </div>
            <div id="eco-addr-msg" style="font-size:12px;color:var(--text-muted);margin-bottom:8px"></div>
            <div style="display:flex;gap:6px">
                <input id="eco-lat" type="number" step="any" value="${typeof d.lat === 'number' ? d.lat : ''}" placeholder="latitude" oninput="_ecoSetCoord('lat',this.value)" style="${inp};flex:1">
                <input id="eco-lng" type="number" step="any" value="${typeof d.lng === 'number' ? d.lng : ''}" placeholder="longitude" oninput="_ecoSetCoord('lng',this.value)" style="${inp};flex:1">
            </div>
        </div>`;
    }
    const deleteBtn = editing
        ? `<button onclick="_ecoDeleteFromEdit('${esc(d.id)}','${escJs(d.name || '')}')" style="height:40px;padding:0 16px;border-radius:8px;border:1px solid #e0b4b4;background:none;color:#c0392b;font-size:14px;font-weight:700;cursor:pointer;margin-left:auto">Delete</button>`
        : '';
    const inner = `
        <input id="eco-f-name" type="text" value="${esc(d.name || '')}" oninput="_ecoDraftSet('name',this.value)" placeholder="What food? (e.g. HEB chuck roast)" style="${inp};margin-bottom:8px">
        <input id="eco-f-note" type="text" value="${esc(d.note || '')}" oninput="_ecoDraftSet('note',this.value)" placeholder="Sourcing note (vendor, what's known…)" style="${inp};margin-bottom:12px">

        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">How disclosed is the origin?</div>
        <div style="display:flex;gap:6px;margin-bottom:12px">${txButtons}</div>

        <div style="display:flex;gap:8px;margin-bottom:10px">
            <button onclick="_ecoDraftSet('precision','point')" style="${segBtn(!area)}">&#9679; Exact spot</button>
            <button onclick="_ecoDraftSet('precision','area')" style="${segBtn(area)}">&#9711; Rough region</button>
        </div>
        ${regionUi}${pointUi}

        <div style="margin-bottom:10px">
            <button onclick="_ecoSuggestUSDA()" style="height:36px;padding:0 12px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--accent);font-size:13px;font-weight:600;cursor:pointer">📍 Suggest region from USDA</button>
            <div id="eco-usda-msg" style="font-size:12px;color:var(--text-muted);margin-top:6px"></div>
            <div id="eco-usda-key" style="display:${keyOpen ? '' : 'none'};margin-top:8px">
                <input id="eco-usda-key-input" type="text" placeholder="Paste your free USDA QuickStats key" style="${inp};margin-bottom:6px">
                <div style="display:flex;gap:10px;align-items:center">
                    <button onclick="_ecoSaveKey()" style="height:34px;padding:0 14px;border-radius:7px;border:none;background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Save key</button>
                    <a href="https://quickstats.nass.usda.gov/api" target="_blank" rel="noopener" style="font-size:12px;color:var(--text-muted)">Get a free key &#8599;</a>
                </div>
            </div>
        </div>

        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">How was this dot placed?</div>
        <div style="display:flex;gap:6px;margin-bottom:12px">${geoButtons}</div>

        <div style="font-size:12px;margin-bottom:12px">${loc}</div>
        <div style="display:flex;gap:8px;align-items:center">
            <button onclick="_ecoSave()" style="height:40px;padding:0 20px;border-radius:8px;border:none;background:var(--green);color:#fff;font-size:14px;font-weight:700;cursor:pointer">${editing ? 'Save' : 'Add to map'}</button>
            <button onclick="_ecoCancel()" style="height:40px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:14px;font-weight:600;cursor:pointer">Cancel</button>
            ${deleteBtn}
        </div>`;
    if (editing) {
        // Focused editing in the shared modal; the inline slot stays empty.
        if (inlineEl) inlineEl.innerHTML = '';
        window._ecoModalOpen = true;
        showEditorModal('Edit source', inner);
    } else {
        if (window._ecoModalOpen) { window._ecoModalOpen = false; hideEditorModal(); }
        if (inlineEl) inlineEl.innerHTML = `<div style="border:1px solid var(--accent);border-radius:12px;padding:16px;margin-bottom:14px;background:var(--card-bg)">
            <div style="font-size:16px;font-weight:700;margin-bottom:10px">New food source</div>
            ${inner}
        </div>`;
    }
}
// Delete from inside the edit modal: close it first, then run the shared confirm
// flow (the two modals would otherwise stack).
function _ecoDeleteFromEdit(id, name) {
    window._ecoDraft = null;
    _ecoPanel(true);
    _ecoControls(); _ecoRecipePanel();
    _ecoDelete(id, name);
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
    const kind = d.precision === 'area' ? (d.area_kind || 'circle') : 'circle';
    const payload = {
        name: d.name.trim(), note: (d.note || '').trim(),
        lat: d.lat, lng: d.lng, precision: d.precision,
        radius_km: (d.precision === 'area' && kind === 'circle') ? (d.radius_km || 0) : 0,
        transparency: d.transparency || 'unrated',
        area_kind: kind,
        counties: kind === 'counties' ? (d.counties || []) : [],
        region_name: kind === 'state' ? (d.region_name || '') : '',
        geo_source: d.geo_source || 'unrated',
    };
    const url = d.id ? '/api/ecosystem/source/update' : '/api/ecosystem/source/add';
    if (d.id) payload.id = d.id;
    if (await _ecoPost(url, payload)) {
        window._ecoDraft = null;
        _ecoPanel(true);                   // close the editor (modal or inline) immediately
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

// --- List under the map (a card with search + transparency filter) -----------
// The card shell is built ONCE (so the search box keeps focus across the 5s
// poll); only the chips + rows + count are refreshed on each render.
function _ecoList() {
    const el = document.getElementById('ecosystem-area'); if (!el) return;
    const src = _ecoSources();
    if (!src.length) {
        el.innerHTML = `<div style="color:var(--text-muted);font-style:italic;padding:16px;border:1px dashed var(--border);border-radius:8px;text-align:center;font-size:14px">No food sources yet. Tap &#65291; Add food, then tap the map to place it.</div>`;
        el._ecoScaffolded = false;
        return;
    }
    if (!el._ecoScaffolded) {
        el.innerHTML = `<div style="border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:var(--card-bg)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                <span style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;flex:1">Sources</span>
                <span id="eco-list-count" style="font-size:12px;color:var(--text-muted)"></span>
            </div>
            <input id="eco-search" type="text" value="${esc(window._ecoSearch || '')}" oninput="_ecoSearchInput(this.value)" placeholder="Search by name or note…" style="width:100%;box-sizing:border-box;height:40px;padding:0 12px;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text);font-size:14px;margin-bottom:10px">
            <div id="eco-tx-filter" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div>
            <div id="eco-list-banner"></div>
            <div id="eco-list-rows"></div>
        </div>`;
        el._ecoScaffolded = true;
    }
    _ecoRenderFilterChips();
    _ecoRenderRows();
}
// Filter chips along the transparency axis (All + each level).
function _ecoRenderFilterChips() {
    const el = document.getElementById('eco-tx-filter'); if (!el) return;
    const cur = window._ecoTxFilter || '';
    const chip = (key, label, color) => {
        const on = cur === key;
        const dot = color ? `<span style="width:9px;height:9px;border-radius:50%;background:${color};flex:none"></span>` : '';
        return `<button onclick="_ecoSetTxFilter('${key}')" style="display:inline-flex;align-items:center;gap:5px;height:32px;padding:0 12px;border-radius:16px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};background:${on ? 'rgba(124,92,191,0.12)' : 'none'};color:var(--text);font-size:12px;font-weight:600;cursor:pointer">${dot}${label}</button>`;
    };
    el.innerHTML = chip('', 'All', null) + ECO_TX_ORDER.map(k => chip(k, ECO_TX[k].label, ECO_TX[k].color)).join('');
}
// Filtered + sorted rows, plus the count and the single-item "Show all" banner.
function _ecoRenderRows() {
    const rowsEl = document.getElementById('eco-list-rows'); if (!rowsEl) return;
    const all = _ecoSources();
    const q = (window._ecoSearch || '').trim().toLowerCase();
    const txf = window._ecoTxFilter || null;
    const txOf = s => (s.transparency in ECO_TX) ? s.transparency : 'unrated';
    let list = all.slice();
    if (txf) list = list.filter(s => txOf(s) === txf);
    if (q) list = list.filter(s => (s.name || '').toLowerCase().includes(q) || (s.note || '').toLowerCase().includes(q));
    const rank = s => ECO_TX_ORDER.indexOf(txOf(s));
    list.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra !== rb ? ra - rb : String(a.name).localeCompare(String(b.name)); });

    const countEl = document.getElementById('eco-list-count');
    if (countEl) countEl.textContent = (q || txf) ? `${list.length} of ${all.length}` : `${all.length} source${all.length === 1 ? '' : 's'}`;

    const bEl = document.getElementById('eco-list-banner');
    if (bEl) {
        const soloSrc = window._ecoSoloSource && all.find(s => s.id === window._ecoSoloSource);
        bEl.innerHTML = soloSrc
            ? `<div style="display:flex;align-items:center;gap:10px;border:1px solid var(--accent);background:rgba(124,92,191,0.08);border-radius:10px;padding:10px 12px;margin-bottom:10px">
                <span style="flex:1;font-size:13px;color:var(--text)">Showing only <b>${esc(soloSrc.name)}</b> on the map</span>
                <button onclick="_ecoSetSolo('')" style="height:34px;padding:0 12px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;font-weight:600;cursor:pointer">Show all</button>
            </div>`
            : '';
    }
    rowsEl.innerHTML = list.length
        ? list.map(_ecoListRow).join('')
        : `<div style="color:var(--text-muted);font-style:italic;padding:14px;text-align:center;font-size:14px">No sources match.</div>`;
}
function _ecoSearchInput(v) { window._ecoSearch = v; _ecoRenderRows(); }
// The transparency chip filters the MAP too (not just the list). Changing it
// resets any single-item pick — you re-stack one by clicking a row afterward.
function _ecoSetTxFilter(key) {
    window._ecoTxFilter = key || null;
    window._ecoSoloSource = null;
    window._ecoLastSources = null;     // map visibility changed → re-sync markers
    window._ecoFittedRecipe = null;
    _ecoRenderFilterChips();
    _ecoRenderRows();
    _ecoRecipePanel();                 // may reappear now that solo is cleared
    _ecoSyncMarkers();
    _ecoFitVisible();                  // zoom + center over the filtered group
}
function _ecoListRow(s) {
    const tx = _ecoTx(s);
    const active = window._ecoSoloSource === s.id;
    const tag = `<span style="flex:none;font-size:11px;color:var(--text-muted);white-space:nowrap;text-align:right">${tx.label}<br>${esc(_ecoMetaLabel(s))}</span>`;
    const note = s.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(s.note)}</div>` : '';
    return `<div onclick="_ecoSetSolo('${esc(s.id)}')" style="display:flex;align-items:center;gap:12px;border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer;min-height:44px;background:${active ? 'rgba(124,92,191,0.08)' : 'var(--card-bg)'}">
        <span style="flex:none;width:12px;height:12px;border-radius:50%;background:${tx.color};border:2px solid #fff;box-shadow:0 0 0 1px var(--border)"></span>
        <div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:600;color:var(--text)">${esc(s.name)}</div>
            ${note}
        </div>
        ${tag}
        <button onclick="event.stopPropagation();_ecoEditOpen('${esc(s.id)}')" style="flex:none;height:34px;padding:0 12px;border-radius:7px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:13px;font-weight:600;cursor:pointer">Edit</button>
    </div>`;
}
// Zoom + center the map tightly on one source: frame its shape/region exactly,
// or zoom in close on an exact spot.
function _ecoFocus(id) {
    const s = _ecoSources().find(x => x.id === id);
    if (!s || typeof s.lat !== 'number' || typeof s.lng !== 'number') return;
    const map = window._ecomap;
    if (map) {
        map.invalidateSize(false);   // refresh cached size first, else the fit lands off-center
        const feats = _ecoIsShape(s) ? _ecoFeatures(s) : [];
        if (feats.length) {
            map.fitBounds(L.geoJSON(feats).getBounds().pad(0.15));        // county/state outline
        } else if (s.precision === 'area' && s.radius_km > 0) {
            map.fitBounds(L.latLng(s.lat, s.lng).toBounds(s.radius_km * 2000).pad(0.15));  // circle region
        } else {
            map.setView([s.lat, s.lng], 13);                              // exact spot — close + centered
        }
        const m = window._ecoMarkers && window._ecoMarkers[s.id];
        if (m) m.openPopup();
    }
    const top = document.getElementById('ecomap');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// Zoom + center the map over the whole currently-visible set (e.g. after a
// transparency chip). One match → the tight single-item framing; several → fit
// them all; none → leave the view be.
function _ecoFitVisible() {
    const map = window._ecomap; if (!map) return;
    map.invalidateSize(false);   // refresh cached size first, else the fit lands off-center
    const visible = _ecoVisibleIds();
    const src = _ecoSources().filter(s => typeof s.lat === 'number' && typeof s.lng === 'number' && (!visible || visible.has(s.id)));
    if (!src.length) return;
    if (src.length === 1) { _ecoFocus(src[0].id); return; }
    // Dots-only: frame the points themselves (no shape/region geometry).
    let bounds = null;
    src.forEach(s => {
        const b = L.latLngBounds([s.lat, s.lng], [s.lat, s.lng]);
        bounds = bounds ? bounds.extend(b) : b;
    });
    if (bounds) map.fitBounds(bounds.pad(0.15));
}

// --- Entry point (called by the render loop, incl. the 5s poll) --------------
function renderEcosystem() {
    if (typeof L === 'undefined') return;     // Leaflet not loaded
    const map = _ecoEnsureMap(); if (!map) return;
    // Each piece renders independently. A throw in one (e.g. a single bad marker
    // tripping real Leaflet) must NOT blank the controls, legend, or item list
    // below it — that's the "map but no UI" failure. Isolate + surface, never swallow.
    const step = (name, fn) => { try { fn(); } catch (e) { console.error('renderEcosystem step "' + name + '" failed:', e); } };
    step('tiles', _ecoSyncTiles);
    step('markers', _ecoSyncMarkers);
    step('controls', _ecoControls);
    step('legend', _ecoLegend);
    step('recipePanel', _ecoRecipePanel);
    step('panel', _ecoPanel);
    step('list', _ecoList);
    // Frame a freshly-selected recipe's sources once (not on every 5s poll).
    step('fitRecipe', () => {
        const rec = _ecoActiveRecipe();
        if (rec) { if (window._ecoFittedRecipe !== rec.id) { window._ecoFittedRecipe = rec.id; _ecoFitRecipe(rec); } }
        else window._ecoFittedRecipe = null;
    });
    // The host div was display:none until the tab opened — let Leaflet recompute
    // its size now that it's visible (otherwise tiles render into a 0×0 box), THEN
    // frame all her sources once. Without this the map opens on the fixed Austin
    // view and far-flung sources (e.g. a California circle) sit off the edge.
    setTimeout(() => {
        try {
            map.invalidateSize();
            if (!window._ecoDidInitialFit) { window._ecoDidInitialFit = true; _ecoFitVisible(); }
        } catch (e) {}
    }, 0);
}
