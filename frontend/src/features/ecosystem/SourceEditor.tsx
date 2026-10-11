/**
 * SourceEditor.tsx — the add/edit form for a food source (port of _ecoPanel +
 * the draft-editing helpers _ecoDraftSet / _ecoGeocode / _ecoSuggestUSDA /
 * _ecoUseCircle / _ecoSaveKey / _ecoSetCoord). Adding renders inline below
 * the map (so you can tap to place the pin); editing sits in the shared Sheet
 * — the page owns that split, this form is the same either way.
 *
 * Mount one instance per editing session (key it on the draft's id) so the
 * address/USDA messages and key prompt reset like the old globals did.
 *
 * The origin section records where the placement information came from. The
 * two lookups fill it themselves — an address search writes "geocoded" with
 * what OpenStreetMap matched, the USDA button writes "usda-nass" with the
 * dataset, the figure that ranked the counties, each county's number, and the
 * day — and anything else (the package, a visit, a study) is typed by hand.
 * Prompt for that part: "save the source origin information like USDA or
 * whatever in the table and display it."
 */
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { ECO_GEO, ECO_GEO_ORDER, ECO_ORIGIN, ECO_ORIGIN_ORDER, ECO_TX, ECO_TX_ORDER } from './axes';
import { geocodeAddress, saveUsdaKey, usdaSuggest } from './api';
import type { UsdaSuggestion } from './api';
import type { EcoMapHandle } from './EcoMap';
import { loadGeo } from './geo';
import type { EcoDraft } from './types';
import styles from './SourceEditor.module.css';

export interface SourceEditorProps {
  draft: EcoDraft;
  editing: boolean;
  onPatch: (patch: Partial<EcoDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
  /** Editing only — runs the shared confirm flow (page closes this editor first). */
  onDelete: (id: string, name: string) => void;
  /** Failure toast (page's ToastStack) — for assist calls that error out.
   * "No match" answers stay inline; only real failures escalate to a toast. */
  onError: (message: string) => void;
  map: RefObject<EcoMapHandle | null>;
}

function coordText(v: number | null): string {
  return typeof v === 'number' ? String(v) : '';
}

export function SourceEditor({ draft, editing, onPatch, onSave, onCancel, onDelete, onError, map }: SourceEditorProps) {
  const [addr, setAddr] = useState('');
  const [addrMsg, setAddrMsg] = useState('');
  const [usdaMsg, setUsdaMsg] = useState('');
  const [keyPrompt, setKeyPrompt] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  // Local text mirrors of the coord fields, so partial input ("3.", "-") isn't
  // clobbered mid-keystroke, while map taps / geocoding still flow back in.
  const [latText, setLatText] = useState(() => coordText(draft.lat));
  const [lngText, setLngText] = useState(() => coordText(draft.lng));

  useEffect(() => {
    setLatText((cur) => (parseFloat(cur) === draft.lat ? cur : coordText(draft.lat)));
  }, [draft.lat]);
  useEffect(() => {
    setLngText((cur) => (parseFloat(cur) === draft.lng ? cur : coordText(draft.lng)));
  }, [draft.lng]);

  const area = draft.precision === 'area';
  const hasLoc = typeof draft.lat === 'number' && typeof draft.lng === 'number';

  function setPrecision(v: 'point' | 'area') {
    const patch: Partial<EcoDraft> = { precision: v };
    if (v === 'area') {
      let kind = draft.area_kind;
      if (!['circle', 'counties', 'state'].includes(kind)) {
        kind = 'circle';
        patch.area_kind = 'circle';
      }
      if (kind === 'circle' && !(draft.radius_km > 0)) patch.radius_km = 100;
    }
    onPatch(patch);
  }

  /** Switch a shape region back to a plain circle. */
  function useCircle() {
    const patch: Partial<EcoDraft> = { area_kind: 'circle', counties: [], region_name: '' };
    if (!(draft.radius_km > 0)) patch.radius_km = 100;
    // a hand circle is a hunch, not USDA — neither the axis nor the origin
    // may keep claiming USDA once its outline is gone
    const patchExtra: Partial<EcoDraft> = { county_detail: [] };
    if (draft.geo_source === 'proxy') patchExtra.geo_source = 'guess';
    if (draft.origin === 'usda-nass') patchExtra.origin = 'hand';
    Object.assign(patch, patchExtra);
    onPatch(patch);
  }

  /** Typed-in coordinates (one field at a time). Syncs the pin once both are
   * valid numbers, leaving the map alone while only one is filled in. */
  function setCoord(field: 'lat' | 'lng', val: string) {
    if (field === 'lat') setLatText(val);
    else setLngText(val);
    const n = parseFloat(val);
    const patch: Partial<EcoDraft> = { [field]: isNaN(n) ? null : n };
    const other = field === 'lat' ? draft.lng : draft.lat;
    onPatch(patch);
    if (!isNaN(n) && typeof other === 'number') {
      const lat = field === 'lat' ? n : other;
      const lng = field === 'lng' ? n : other;
      map.current?.panTo(lat, lng);
    }
  }

  /** Geocode a typed address → pin (server-side, via the /geocode endpoint). */
  async function geocode() {
    const q = addr.trim();
    if (!q) {
      setAddrMsg('Type an address or place first.');
      return;
    }
    setAddrMsg('Searching…');
    let j;
    try {
      j = await geocodeAddress(q);
    } catch {
      setAddrMsg('Network error reaching the geocoder.');
      onError('Address lookup failed.');
      return;
    }
    if (!j || !j.ok || typeof j.lat !== 'number' || typeof j.lng !== 'number') {
      setAddrMsg(j?.reason || 'No match found.');
      return;
    }
    // a geocoded address is a deliberate, exact placement — and the lookup
    // is where the information came from
    onPatch({
      precision: 'point',
      lat: j.lat,
      lng: j.lng,
      geo_source: 'placed',
      origin: 'geocoded',
      origin_detail: j.origin_detail || '',
      origin_url: j.origin_url || '',
      origin_date: j.origin_date || '',
    });
    map.current?.setView(j.lat, j.lng, 13);
    setAddrMsg(j.label ? 'Found: ' + j.label : 'Found it — adjust or save.');
  }

  /** USDA "suggest region" assist (asks where USDA says this is grown). */
  async function suggestUSDA() {
    if (!draft.name.trim()) {
      setUsdaMsg('Type the food name first.');
      return;
    }
    setUsdaMsg('Asking USDA…');
    let j: UsdaSuggestion;
    try {
      j = await usdaSuggest(draft.name.trim());
    } catch {
      setUsdaMsg('Network error reaching USDA.');
      onError('USDA region suggestion failed.');
      return;
    }
    if (j?.ok && j.mode === 'counties') {
      await loadGeo().catch(() => {});
      const patch: Partial<EcoDraft> = {
        precision: 'area',
        area_kind: 'counties',
        counties: j.counties || [],
        region_name: '',
        radius_km: 0,
        geo_source: 'proxy', // USDA = where it's generally grown, not this item
        // the origin record, with USDA's number for each county
        origin: 'usda-nass',
        origin_detail: j.origin_detail || '',
        origin_url: j.origin_url || '',
        origin_date: j.origin_date || '',
        county_detail: j.detail || [],
      };
      if (!draft.note) patch.note = j.note || '';
      if ((draft.transparency || 'unrated') === 'unrated') patch.transparency = 'partial';
      setKeyPrompt(false);
      const c = map.current?.fitDraftShapes({
        area_kind: 'counties',
        counties: patch.counties || [],
        region_name: '',
      });
      if (c) {
        patch.lat = c.lat;
        patch.lng = c.lng;
      }
      onPatch(patch);
      setUsdaMsg('Placed ' + (j.label || 'counties') + '. Adjust or save.');
      return;
    }
    if (j?.ok && j.mode === 'state') {
      await loadGeo().catch(() => {});
      const patch: Partial<EcoDraft> = {
        precision: 'area',
        area_kind: 'state',
        region_name: j.region_name || '',
        counties: [],
        radius_km: 0,
        lat: typeof j.lat === 'number' ? j.lat : null,
        lng: typeof j.lng === 'number' ? j.lng : null,
        geo_source: 'proxy', // USDA = where it's generally grown, not this item
        origin: 'usda-nass',
        origin_detail: j.origin_detail || '',
        origin_url: j.origin_url || '',
        origin_date: j.origin_date || '',
        county_detail: [],
      };
      if (!draft.note) patch.note = j.note || '';
      if ((draft.transparency || 'unrated') === 'unrated') patch.transparency = 'partial';
      setKeyPrompt(false);
      const c = map.current?.fitDraftShapes({
        area_kind: 'state',
        counties: [],
        region_name: patch.region_name || '',
      });
      if (c) {
        patch.lat = c.lat;
        patch.lng = c.lng;
      } else if (typeof j.lat === 'number' && typeof j.lng === 'number') {
        map.current?.setView(j.lat, j.lng, 6);
      }
      onPatch(patch);
      setUsdaMsg('Placed ' + (j.label || 'state') + '. Adjust or save.');
      return;
    }
    if (j?.need_key) {
      setKeyPrompt(true);
      setUsdaMsg(j.reason || 'Add a free USDA key.');
      return;
    }
    setUsdaMsg(j?.reason || 'No suggestion available.');
  }

  async function saveKey() {
    const v = keyValue.trim();
    if (!v) {
      setUsdaMsg('Paste a key first.');
      return;
    }
    try {
      await saveUsdaKey(v);
      setKeyPrompt(false);
      setUsdaMsg('Key saved — tap “Suggest region” again.');
    } catch {
      setUsdaMsg('Could not save the key.');
      onError('Saving the USDA key failed.');
    }
  }

  const countyCount = new Set(draft.counties || []).size;

  return (
    <div>
      <input
        type="text"
        className={styles.input}
        value={draft.name}
        onChange={(e) => onPatch({ name: e.target.value })}
        placeholder="What food? (e.g. HEB chuck roast)"
      />
      <input
        type="text"
        className={`${styles.input} ${styles.noteInput}`}
        value={draft.note}
        onChange={(e) => onPatch({ note: e.target.value })}
        placeholder="Sourcing note (vendor, what's known…)"
      />

      <div className={styles.axisLabel}>How disclosed is the origin?</div>
      <div className={styles.btnRow}>
        {ECO_TX_ORDER.map((k) => {
          const t = ECO_TX[k];
          const on = draft.transparency === k;
          return (
            <button
              key={k}
              type="button"
              title={t.blurb}
              className={styles.txBtn}
              style={{
                borderColor: on ? t.color : 'var(--border)',
                background: on ? t.color + '22' : 'none',
              }}
              onClick={() => onPatch({ transparency: k })}
            >
              <span className={styles.txDot} style={{ background: t.color }} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className={styles.segRow}>
        <button
          type="button"
          className={`${styles.segBtn} ${!area ? styles.segBtnOn : ''}`}
          onClick={() => setPrecision('point')}
        >
          ● Exact spot
        </button>
        <button
          type="button"
          className={`${styles.segBtn} ${area ? styles.segBtnOn : ''}`}
          onClick={() => setPrecision('area')}
        >
          ◯ Rough region
        </button>
      </div>

      {area && draft.area_kind === 'counties' ? (
        <div className={styles.regionInfo}>
          🗺 {countyCount} county outline{countyCount === 1 ? '' : 's'} from USDA
          <button type="button" className={styles.useCircleBtn} onClick={useCircle}>
            use a circle
          </button>
        </div>
      ) : null}
      {area && draft.area_kind === 'state' ? (
        <div className={styles.regionInfo}>
          🗺 {draft.region_name || 'state'} outline
          <button type="button" className={styles.useCircleBtn} onClick={useCircle}>
            use a circle
          </button>
        </div>
      ) : null}
      {area && draft.area_kind === 'circle' ? (
        <div className={styles.radiusWrap}>
          <label className={styles.radiusLabel}>
            Region radius: <b>{Math.round(draft.radius_km || 0)}</b> km
          </label>
          <input
            type="range"
            min={5}
            max={2000}
            step={5}
            value={draft.radius_km || 100}
            onChange={(e) => onPatch({ radius_km: parseFloat(e.target.value) || 0 })}
            className={styles.radiusSlider}
          />
        </div>
      ) : null}

      {!area ? (
        <div className={styles.pointWrap}>
          <div className={styles.pointHint}>
            Set the spot — tap the map, search an address, or type coordinates:
          </div>
          <div className={styles.addrRow}>
            <input
              type="text"
              className={styles.input}
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void geocode();
                }
              }}
              placeholder="Address or place (e.g. 1100 Congress Ave, Austin TX)"
            />
            <button type="button" className={styles.findBtn} onClick={() => void geocode()}>
              Find
            </button>
          </div>
          <div className={styles.msg}>{addrMsg}</div>
          <div className={styles.coordRow}>
            <input
              type="number"
              step="any"
              className={styles.input}
              value={latText}
              onChange={(e) => setCoord('lat', e.target.value)}
              placeholder="latitude"
            />
            <input
              type="number"
              step="any"
              className={styles.input}
              value={lngText}
              onChange={(e) => setCoord('lng', e.target.value)}
              placeholder="longitude"
            />
          </div>
        </div>
      ) : null}

      <div className={styles.usdaWrap}>
        <button type="button" className={styles.usdaBtn} onClick={() => void suggestUSDA()}>
          📍 Suggest region from USDA
        </button>
        {usdaMsg ? <div className={styles.msg}>{usdaMsg}</div> : null}
        {keyPrompt ? (
          <div className={styles.keyWrap}>
            <input
              type="text"
              className={styles.input}
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              placeholder="Paste your free USDA QuickStats key"
            />
            <div className={styles.keyRow}>
              <button type="button" className={styles.keySaveBtn} onClick={() => void saveKey()}>
                Save key
              </button>
              <a
                href="https://quickstats.nass.usda.gov/api"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.keyLink}
              >
                Get a free key ↗
              </a>
            </div>
          </div>
        ) : null}
      </div>

      <div className={styles.axisLabel}>How was this dot placed?</div>
      <div className={styles.btnRow}>
        {ECO_GEO_ORDER.map((k) => {
          const t = ECO_GEO[k];
          const on = draft.geo_source === k;
          return (
            <button
              key={k}
              type="button"
              title={t.blurb}
              className={`${styles.geoBtn} ${on ? styles.geoBtnOn : ''}`}
              onClick={() => onPatch({ geo_source: k })}
            >
              {t.icon} {t.label}
            </button>
          );
        })}
      </div>

      {/* Where the information came from — the origin record. */}
      <div className={styles.axisLabel}>Where did this information come from?</div>
      <div className={styles.btnRow}>
        {ECO_ORIGIN_ORDER.map((k) => {
          const t = ECO_ORIGIN[k];
          const on = draft.origin === k;
          return (
            <button
              key={k}
              type="button"
              className={`${styles.geoBtn} ${on ? styles.geoBtnOn : ''}`}
              onClick={() => onPatch({ origin: k })}
            >
              {t.icon} {t.label}
            </button>
          );
        })}
      </div>
      <input
        type="text"
        className={`${styles.input} ${styles.noteInput}`}
        value={draft.origin_detail}
        onChange={(e) => onPatch({ origin_detail: e.target.value })}
        placeholder="The citation — which dataset, what the label said, who you asked…"
      />
      <div className={styles.coordRow}>
        <input
          type="url"
          className={styles.input}
          value={draft.origin_url}
          onChange={(e) => onPatch({ origin_url: e.target.value })}
          placeholder="Link to check it (optional)"
        />
        <input
          type="date"
          className={styles.input}
          value={draft.origin_date}
          onChange={(e) => onPatch({ origin_date: e.target.value })}
          aria-label="When it was looked up"
        />
      </div>

      {!editing && draft.food_label ? (
        <div className={styles.regionInfo}>🔗 Will be linked to {draft.food_label}</div>
      ) : null}

      <div className={styles.locLine}>
        {hasLoc ? (
          <span className={styles.locSet}>
            📍 {(draft.lat as number).toFixed(3)}, {(draft.lng as number).toFixed(3)}
          </span>
        ) : (
          <span className={styles.locUnset}>No location set yet</span>
        )}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.saveBtn} onClick={onSave}>
          {editing ? 'Save' : 'Add to map'}
        </button>
        <button type="button" className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        {editing && draft.id ? (
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={() => onDelete(draft.id as string, draft.name || '')}
          >
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}
