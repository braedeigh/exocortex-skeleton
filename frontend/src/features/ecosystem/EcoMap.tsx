/**
 * EcoMap.tsx — the persistent Leaflet map. Port of the map half of
 * static/js/ecosystem.js.
 *
 * CRITICAL parity behavior: the Leaflet map instance is created ONCE (mount
 * effect) and survives every poll-driven re-render — renders only reconcile
 * layers imperatively. Marker sync is keyed on the serialized sources +
 * visible-id set (the old `_ecoLastSources` guard), so an open popup isn't
 * yanked shut by the 5s poll when nothing actually changed.
 *
 * The page drives view changes (focus / fit / world–region) through the
 * imperative handle instead of props, mirroring how the old code called map
 * methods directly from its event handlers.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { geoSourceInfo, isShapeSource, metaLabel, txInfo } from './axes';
import { featuresFor, geometryToLatLngs, getGeo, loadGeo } from './geo';
import type { GeoFeature } from './geo';
import { cartoKey, currentTileKey, tileLayersFor } from './themeColor';
import type { TileKey } from './themeColor';
import type { EcoDraft, EcoSource } from './types';
import { HOME_LAT, HOME_LNG } from '../../ownerHome';
import styles from './EcoMap.module.css';

/** "My region" home view — the owner's coordinates from .env.local (see
 * ownerHome.ts); regional zoom frames their surroundings. Unset, open on a
 * neutral world view instead. */
const ECO_HOME: [number, number] =
  HOME_LAT !== undefined && HOME_LNG !== undefined ? [HOME_LAT, HOME_LNG] : [20, 0];
const ECO_REGION_ZOOM = HOME_LAT !== undefined ? 5 : 2;

const DRAFT_COLOR = '#7c5cbf';

export interface EcoMapHandle {
  /** Zoom + center tightly on one source (frame its shape/region exactly, or
   * zoom in close on an exact spot), open its popup, scroll the map into view. */
  focusSource: (id: string) => void;
  /** Zoom + center over the whole currently-visible set. One match → the tight
   * single-item framing; several → fit them all; none → leave the view be. */
  fitVisible: () => void;
  /** Frame a traced recipe's matched source points (once per selection).
   * `fly` animates there from wherever the map is — the exhibit's opening. */
  fitRecipePoints: (pts: [number, number][], opts?: { fly?: boolean }) => void;
  setRegionView: () => void;
  setWorldView: () => void;
  setView: (lat: number, lng: number, zoom: number) => void;
  panTo: (lat: number, lng: number) => void;
  /** Fit the map to a draft's county/state shapes; returns the shapes' center
   * (for re-anchoring the draft) or null when geo isn't loaded / no match. */
  fitDraftShapes: (d: Pick<EcoDraft, 'area_kind' | 'counties' | 'region_name'>) => { lat: number; lng: number } | null;
  closePopup: () => void;
}

export interface EcoMapProps {
  sources: EcoSource[];
  /** Ids allowed on the map, or null for "show all" (see visibility.ts). */
  visibleIds: Set<string> | null;
  draft: EcoDraft | null;
  canEdit: boolean;
  /** The exhibit: fills its frame, opens on the world, and the first markers
   * rise in one after another. */
  embed?: boolean;
  /** Tap-to-place while adding/editing (only fired while a draft is active). */
  onMapClick: (lat: number, lng: number) => void;
  /** The draggable draft pin was dropped somewhere new. */
  onDraftMove: (lat: number, lng: number) => void;
  onEditSource: (id: string) => void;
  onDeleteSource: (id: string, name: string) => void;
}

/** Mouse/trackpad devices get the popup on hover — no tap required at a desk.
 * Touch devices (no real hover) keep Leaflet's default click/tap-to-open.
 * Cached: whether a device has hover doesn't change mid-session. */
let hoverMQ: boolean | undefined;
function hoverCapable(): boolean {
  if (hoverMQ === undefined) {
    hoverMQ = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
  }
  return hoverMQ;
}

function hasCoords(s: EcoSource): s is EcoSource & { lat: number; lng: number } {
  return typeof s.lat === 'number' && typeof s.lng === 'number';
}

function featureCollection(feats: GeoFeature[]): GeoJSON.GeoJsonObject {
  return { type: 'FeatureCollection', features: feats } as unknown as GeoJSON.GeoJsonObject;
}

/** Popup HTML, built as a real DOM element so Edit/Delete wire straight to
 * React callbacks (the old code used global onclick handlers). Inline styles
 * kept byte-close to the old popup for visual parity. */
function makePopup(
  s: EcoSource,
  canEdit: boolean,
  onEdit: (id: string) => void,
  onDelete: (id: string, name: string) => void,
): HTMLElement {
  const tx = txInfo(s);
  const g = geoSourceInfo(s);
  const root = document.createElement('div');
  root.style.minWidth = '170px';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:2px;color:var(--text)';
  title.textContent = s.name;
  root.appendChild(title);

  if (s.note) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:13px;color:var(--text-secondary);margin-bottom:4px';
    note.textContent = s.note;
    root.appendChild(note);
  }

  const showGeoLine = !!s.geo_source && s.geo_source !== 'unrated';
  const meta = document.createElement('div');
  meta.style.cssText = `font-size:12px;color:var(--text-muted);margin-bottom:${showGeoLine ? '4px' : '8px'}`;
  const chip = document.createElement('span');
  chip.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${tx.color};margin-right:5px;vertical-align:middle`;
  meta.appendChild(chip);
  meta.appendChild(document.createTextNode(`${tx.label} · ${metaLabel(s)}`));
  root.appendChild(meta);

  if (showGeoLine) {
    const geoLine = document.createElement('div');
    geoLine.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:8px';
    geoLine.textContent =
      `${g.icon} ${g.label}` +
      (s.geo_source === 'proxy' ? " — generally grown here, not necessarily this item's source" : '');
    root.appendChild(geoLine);
  }

  if (canEdit) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px';
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.style.cssText =
      'flex:1;height:36px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:13px;font-weight:600;cursor:pointer';
    editBtn.addEventListener('click', () => onEdit(s.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.style.cssText =
      'flex:1;height:36px;border-radius:8px;border:1px solid #e0b4b4;background:transparent;color:#c0392b;font-size:13px;font-weight:600;cursor:pointer';
    delBtn.addEventListener('click', () => onDelete(s.id, s.name));
    row.appendChild(editBtn);
    row.appendChild(delBtn);
    root.appendChild(row);
  }
  return root;
}

/** Bind a source's popup to a layer (dot / circle / region group). Click/tap
 * always opens it. On hover-capable devices it also opens on mouseover;
 * mouseout closes it UNLESS the cursor is heading into the popup itself (e.g.
 * to tap Edit/Delete). */
function bindPopup(layer: L.Layer, content: HTMLElement): void {
  layer.bindPopup(content);
  if (hoverCapable()) {
    layer.on('mouseover', () => layer.openPopup());
    layer.on('mouseout', (e: L.LeafletEvent) => {
      const orig = (e as L.LeafletMouseEvent).originalEvent as MouseEvent | undefined;
      const to = orig?.relatedTarget as Element | null | undefined;
      if (to && to.closest && to.closest('.leaflet-popup')) return; // moving onto the popup — leave it open
      layer.closePopup();
    });
  }
}

export const EcoMap = forwardRef<EcoMapHandle, EcoMapProps>(function EcoMap(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Record<string, L.Layer>>({});
  // The basemap is one or two tile layers (Esri = base + labels), swapped as a
  // unit when the theme flips.
  const tilesRef = useRef<L.TileLayer[]>([]);
  const tilesKeyRef = useRef<TileKey | null>(null);
  const lastSourcesKeyRef = useRef<string | null>(null);
  const tempMarkerRef = useRef<L.Marker | null>(null);
  const tempCircleRef = useRef<L.Circle | null>(null);
  const tempShapesRef = useRef<L.GeoJSON | null>(null);
  // Bumped when the boundary GeoJSON finishes loading, so shape sources that
  // stood in as plain dots get redrawn as real outlines.
  const [geoVersion, setGeoVersion] = useState(0);

  // Latest props, readable from imperative handlers without re-binding.
  const propsRef = useRef(props);
  propsRef.current = props;
  const mountedAt = useRef(Date.now());

  function syncTiles() {
    const map = mapRef.current;
    if (!map) return;
    const key = currentTileKey();
    if (tilesKeyRef.current === key) return;
    tilesRef.current.forEach((t) => map.removeLayer(t));
    // Provider (CARTO with a key, Esri without) is decided in themeColor.ts.
    // Layers go on in order, then the whole stack drops behind the markers.
    tilesRef.current = tileLayersFor(key, cartoKey()).map((spec) =>
      L.tileLayer(spec.url, {
        attribution: spec.attribution,
        maxNativeZoom: spec.maxNativeZoom,
        maxZoom: 19,
      }).addTo(map),
    );
    tilesRef.current.slice().reverse().forEach((t) => t.bringToBack());
    tilesKeyRef.current = key;
  }

  // --- Map lifecycle: created once, destroyed only on unmount ---------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // The exhibit starts pulled all the way out so the recipe flight has
    // somewhere to arrive from; the page starts at home.
    const map = propsRef.current.embed
      ? L.map(el, { zoomControl: false }).setView([20, 0], 2)
      : L.map(el, { zoomControl: true }).setView(ECO_HOME, ECO_REGION_ZOOM);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      // only places a pin while adding/editing
      if (!propsRef.current.draft) return;
      propsRef.current.onMapClick(e.latlng.lat, e.latlng.lng);
    });
    syncTiles();
    // sky-theme.js writes the palette as inline styles on <html> (initial
    // paint, the 2-minute sky tick, and theme-changed postMessages all land
    // there) — watching the style attribute catches every one of them.
    const observer = new MutationObserver(syncTiles);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    // The host div may have just become visible — let Leaflet recompute its
    // size so tiles don't render into a stale box.
    const t = setTimeout(() => map.invalidateSize(), 0);
    return () => {
      clearTimeout(t);
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      markersRef.current = {};
      tilesRef.current = [];
      tilesKeyRef.current = null;
      lastSourcesKeyRef.current = null;
      tempMarkerRef.current = null;
      tempCircleRef.current = null;
      tempShapesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Source dots + circles + region shapes (synced only when the data
  //     actually changes, so an open popup isn't yanked on every 5s poll) ----
  const { sources, visibleIds, canEdit, draft } = props;
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    const key =
      JSON.stringify(sources) +
      '|' +
      (visibleIds ? [...visibleIds].sort().join(',') : '') +
      '|' +
      canEdit +
      '|' +
      geoVersion;
    if (lastSourcesKeyRef.current === key) return;
    lastSourcesKeyRef.current = key;
    layer.clearLayers();
    markersRef.current = {};
    // County/state regions need the boundary GeoJSON. Load it once, then
    // re-sync (until it's here those sources stand in as dots).
    if (!getGeo() && sources.some(isShapeSource)) {
      loadGeo()
        .then(() => setGeoVersion((v) => v + 1))
        .catch(() => {});
    }
    const onEdit = (id: string) => propsRef.current.onEditSource(id);
    const onDelete = (id: string, name: string) => propsRef.current.onDeleteSource(id, name);
    const hosts: L.Layer[] = [];
    sources.forEach((s) => {
      if (!hasCoords(s)) return;
      if (visibleIds && !visibleIds.has(s.id)) return; // filtered out — don't draw it
      const col = txInfo(s).color;
      const dot = () => {
        const d = L.circleMarker([s.lat, s.lng], {
          radius: 7,
          color: '#fff',
          weight: 2,
          fillColor: col,
          fillOpacity: 0.95,
        }).addTo(layer);
        bindPopup(d, makePopup(s, canEdit, onEdit, onDelete));
        return d;
      };
      // Each source draws in isolation: a single bad shape must NOT abort the
      // loop and hide every other source. On any failure we log the offender
      // and fall back to a plain dot, so the source still lands on the map.
      let host: L.Layer | null = null;
      try {
        if (s.precision === 'area' && isShapeSource(s)) {
          // Real county/state outlines, drawn as raw polygons (not L.geoJSON),
          // colored by transparency. Falls through to a dot if geo isn't loaded.
          const feats = featuresFor(s, getGeo());
          if (feats.length) {
            const style = { color: col, weight: 1, fillColor: col, fillOpacity: 0.2, opacity: 0.6 };
            const grp = L.featureGroup();
            feats.forEach((f) => {
              const ll = geometryToLatLngs(f.geometry);
              if (ll) L.polygon(ll as L.LatLngExpression[][], style).addTo(grp);
            });
            if (grp.getLayers().length) {
              grp.addTo(layer);
              bindPopup(grp, makePopup(s, canEdit, onEdit, onDelete)); // anywhere in the region
              host = grp;
            }
          }
        } else if (s.precision === 'area' && (s.radius_km || 0) > 0) {
          // A rough circle region — a soft hunch, not an exact spot.
          const c = L.circle([s.lat, s.lng], {
            radius: (s.radius_km || 0) * 1000,
            color: col,
            weight: 1,
            fillColor: col,
            fillOpacity: 0.12,
            opacity: 0.45,
            dashArray: '4 4',
          }).addTo(layer);
          bindPopup(c, makePopup(s, canEdit, onEdit, onDelete));
          host = c;
        }
        if (!host) host = dot(); // exact point, or shapes not loaded yet
      } catch (e) {
        console.error(
          `ecosystem: failed to draw "${s.name || s.id}" (${s.area_kind}/${s.precision}):`,
          e,
        );
        try {
          host = dot();
        } catch {
          host = null;
        }
      }
      if (host) {
        markersRef.current[s.id] = host;
        hosts.push(host);
      }
    });
    // THE REVEAL, exhibit only: for the first few seconds after mount (the
    // first draw, and the redraw when the outlines land) each shape rises in
    // ~90ms after the last, timed to arrive as the recipe flight settles.
    // After that window a redraw is just a redraw — a poll must not replay it.
    if (propsRef.current.embed && Date.now() - mountedAt.current < 4000) {
      const paths = (l: L.Layer): L.Path[] =>
        l instanceof L.FeatureGroup ? (l.getLayers() as L.Path[]) : [l as L.Path];
      hosts.forEach((h, i) => {
        paths(h).forEach((pth) => {
          const el = pth.getElement() as SVGElement | null;
          if (!el) return;
          el.classList.add(styles.rise);
          el.style.animationDelay = `${1400 + i * 90}ms`;
        });
      });
    }
  }, [sources, visibleIds, canEdit, geoVersion]);

  // --- Draft pin (the one being added/edited): a draggable divIcon marker,
  //     plus a live preview circle/outline for area mode ---------------------
  // Keyed on the geo-relevant fields only, so typing the name/note doesn't
  // rebuild the pin on every keystroke.
  const draftKey = draft
    ? JSON.stringify([
        draft.lat,
        draft.lng,
        draft.precision,
        draft.radius_km,
        draft.area_kind,
        draft.counties,
        draft.region_name,
      ])
    : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tempMarkerRef.current) {
      map.removeLayer(tempMarkerRef.current);
      tempMarkerRef.current = null;
    }
    if (tempCircleRef.current) {
      map.removeLayer(tempCircleRef.current);
      tempCircleRef.current = null;
    }
    if (tempShapesRef.current) {
      map.removeLayer(tempShapesRef.current);
      tempShapesRef.current = null;
    }
    const d = propsRef.current.draft;
    if (!d || typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
    if (isShapeSource(d)) {
      const feats = featuresFor(d, getGeo());
      if (feats.length) {
        tempShapesRef.current = L.geoJSON(featureCollection(feats), {
          style: { color: DRAFT_COLOR, weight: 1, fillColor: DRAFT_COLOR, fillOpacity: 0.15, opacity: 0.6 },
        }).addTo(map);
        return; // outlines shown — skip the draggable anchor pin
      }
    } else if (d.precision === 'area' && d.radius_km > 0) {
      tempCircleRef.current = L.circle([d.lat, d.lng], {
        radius: d.radius_km * 1000,
        color: DRAFT_COLOR,
        weight: 1,
        fillColor: DRAFT_COLOR,
        fillOpacity: 0.12,
        opacity: 0.55,
        dashArray: '4 4',
      }).addTo(map);
    }
    const icon = L.divIcon({
      className: 'eco-draft-pin',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${DRAFT_COLOR};border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    const m = L.marker([d.lat, d.lng], { draggable: true, icon }).addTo(map);
    m.on('drag', (e: L.LeafletEvent) => {
      const p = (e.target as L.Marker).getLatLng();
      if (tempCircleRef.current) tempCircleRef.current.setLatLng(p);
    });
    m.on('dragend', (e: L.LeafletEvent) => {
      const p = (e.target as L.Marker).getLatLng();
      propsRef.current.onDraftMove(p.lat, p.lng);
    });
    tempMarkerRef.current = m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, geoVersion]);

  // --- Imperative view control (the page's event handlers drive these) ------
  function focusSource(id: string) {
    const map = mapRef.current;
    if (!map) return;
    const s = propsRef.current.sources.find((x) => x.id === id);
    if (!s || !hasCoords(s)) return;
    map.invalidateSize(false); // refresh cached size first, else the fit lands off-center
    const feats = isShapeSource(s) ? featuresFor(s, getGeo()) : [];
    if (feats.length) {
      map.fitBounds(L.geoJSON(featureCollection(feats)).getBounds().pad(0.15)); // county/state outline
    } else if (s.precision === 'area' && (s.radius_km || 0) > 0) {
      map.fitBounds(L.latLng(s.lat, s.lng).toBounds((s.radius_km || 0) * 2000).pad(0.15)); // circle region
    } else {
      map.setView([s.lat, s.lng], 13); // exact spot — close + centered
    }
    markersRef.current[s.id]?.openPopup();
    containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  useImperativeHandle(ref, (): EcoMapHandle => ({
    focusSource,
    fitVisible() {
      const map = mapRef.current;
      if (!map) return;
      map.invalidateSize(false);
      const { sources: src, visibleIds: vis } = propsRef.current;
      const pts = src.filter((s) => hasCoords(s) && (!vis || vis.has(s.id)));
      if (!pts.length) return;
      if (pts.length === 1) {
        focusSource(pts[0].id);
        return;
      }
      // Dots-only: frame the points themselves (no shape/region geometry).
      let bounds: L.LatLngBounds | null = null;
      pts.forEach((s) => {
        const b = L.latLngBounds([s.lat!, s.lng!], [s.lat!, s.lng!]);
        bounds = bounds ? bounds.extend(b) : b;
      });
      if (bounds) map.fitBounds((bounds as L.LatLngBounds).pad(0.15));
    },
    fitRecipePoints(pts, opts) {
      const map = mapRef.current;
      if (!map) return;
      map.invalidateSize(false); // tab may have been hidden — refresh cached size so the fit centers right
      if (opts?.fly) {
        // One long eased move, ~1.8s: fast out of the world view, slow into
        // the frame. Slower than a UI transition on purpose — this is the
        // exhibit's one piece of theatre, and it has to be readable as travel.
        const flight = { duration: 1.8, easeLinearity: 0.2 };
        if (pts.length === 1) map.flyTo(pts[0], 7, flight);
        else if (pts.length > 1) map.flyToBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 6, ...flight });
        return;
      }
      if (pts.length === 1) map.setView(pts[0], 7);
      else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 7 });
    },
    setRegionView() {
      mapRef.current?.setView(ECO_HOME, ECO_REGION_ZOOM);
    },
    setWorldView() {
      const map = mapRef.current;
      if (!map) return;
      const pts = propsRef.current.sources.filter(hasCoords).map((s) => [s.lat, s.lng] as [number, number]);
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 6 });
      else map.setView([20, 0], 2);
    },
    setView(lat, lng, zoom) {
      mapRef.current?.setView([lat, lng], zoom);
    },
    panTo(lat, lng) {
      mapRef.current?.panTo([lat, lng]);
    },
    fitDraftShapes(d) {
      const map = mapRef.current;
      const feats = featuresFor(d, getGeo());
      if (!feats.length || !map) return null;
      const b = L.geoJSON(featureCollection(feats)).getBounds();
      const c = b.getCenter();
      map.fitBounds(b.pad(0.2));
      return { lat: c.lat, lng: c.lng };
    },
    closePopup() {
      mapRef.current?.closePopup();
    },
  }));

  // Persistent map host: React owns this div's existence, Leaflet owns its
  // contents — nothing here re-renders on the poll. isolation:isolate (in the
  // CSS module) scopes Leaflet's internal z-index stack (panes/controls run up
  // to 1000) into its own stacking context so it can't paint over the shell.
  return (
    <div
      ref={containerRef}
      className={[styles.map, props.embed ? styles.mapEmbed : ''].filter(Boolean).join(' ')}
    />
  );
});
