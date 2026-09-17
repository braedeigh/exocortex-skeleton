/**
 * EcosystemPage.tsx — the ECOSYSTEM tab: a map of where her food comes from.
 * React port of templates/index.html #tab-ecosystem + static/js/ecosystem.js.
 *
 * Layout (top to bottom, matching the old tab): section title + subtitle,
 * controls, the persistent Leaflet map, legend, recipe-trace panel, inline
 * add form, source list. Editing an existing source opens the shared Sheet
 * (the old page used its focused-editor modal). The map instance lives in
 * EcoMap and survives the 5s poll; everything here re-renders freely.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet, ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../todos/useTodayData';
import { EcoControls } from './EcoControls';
import type { EcoView } from './EcoControls';
import { EcoLegend } from './EcoLegend';
import { EcoMap } from './EcoMap';
import type { EcoMapHandle } from './EcoMap';
import { RecipePanel } from './RecipePanel';
import { SourceEditor } from './SourceEditor';
import { SourceList } from './SourceList';
import type { SourcePayload } from './api';
import { ecoRecipeSourceIds, ecoRecipeSourcing } from './ecoMatch';
import { ECO_TX, ECO_TX_ORDER } from './axes';
import { draftFromSource, newDraft } from './types';
import type { EcoDraft, EcoSource, Transparency } from './types';
import { useEcosystemData, useSourceMutations } from './useEcosystemData';
import { computeVisibleIds } from './visibility';
import styles from './EcosystemPage.module.css';

/** Editing is owner-only. On the public standalone map (/food-map, a later
 * task that will reuse this module) VIEW_MODE is "public" — the Add button
 * and per-source Edit/Delete are withheld; viewers still get the map, legend,
 * transparency filters and recipe tracing, read-only. */
function canEditNow(): boolean {
  return typeof window === 'undefined' || !window.VIEW_MODE || window.VIEW_MODE === 'authed';
}

/**
 * `embed` is the exhibit view (/food-map?embed=1): just the map, filling the
 * frame, with a frosted caption, the colour key as chips, and one door out to
 * the full page. It opens centered over every source with all of them in
 * view at once (EcoMap's fitVisible, padded so the caption and key don't
 * cover a dot); a ?recipe= is traced in place rather than flown to.
 *
 * Prompts that produced it: "iframe with some flashy thing to make people
 * wanna click into the whole interface" — with the recipe pre-traced; then
 * "center over everything showing all at once".
 */
export function EcosystemPage({
  initialRecipeId = '',
  embed = false,
}: { initialRecipeId?: string; embed?: boolean } = {}) {
  const { data, isLoading, error } = useEcosystemData();
  const { toasts, push, dismiss } = useToasts();
  const { save, remove } = useSourceMutations(push);
  const canEdit = canEditNow();

  const mapRef = useRef<EcoMapHandle>(null);
  const addPanelRef = useRef<HTMLDivElement>(null);

  const [view, setViewState] = useState<EcoView>('region');
  const [txFilter, setTxFilterState] = useState<Transparency | ''>('');
  // ?recipe= deep link (kitchen's "View on map"): trace that recipe on load.
  const [recipeId, setRecipeId] = useState(initialRecipeId);
  const [soloId, setSoloId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<EcoDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const didInitialFit = useRef(false);
  const fittedRecipe = useRef<string | null>(null);

  const sources: EcoSource[] = useMemo(() => data?.ecosystem?.sources ?? [], [data]);
  const recipes = useMemo(() => data?.eco_recipes ?? [], [data]);
  const activeRecipe = useMemo(
    () => recipes.find((r) => r.id === recipeId) || null,
    [recipes, recipeId],
  );
  const visibleIds = useMemo(
    () => computeVisibleIds(sources, txFilter, activeRecipe, soloId),
    [sources, txFilter, activeRecipe, soloId],
  );

  // If the solo'd source disappears (deleted elsewhere), drop the filter
  // instead of stranding an empty map with no banner to clear it.
  useEffect(() => {
    if (soloId && sources.length && !sources.some((s) => s.id === soloId)) setSoloId(null);
  }, [soloId, sources]);

  // The host div was hidden until the route opened — after the first data
  // lands, center over all her sources with every one in view (once, not on
  // every poll). Without this the map sits on the fixed home view and
  // far-flung sources hang off the edge. The exhibit opens the same way,
  // recipe or not: the whole map, all at once.
  useEffect(() => {
    if (!data || didInitialFit.current) return;
    didInitialFit.current = true;
    const t = setTimeout(() => mapRef.current?.fitVisible(), 0);
    return () => clearTimeout(t);
  }, [data]);

  // Frame a freshly-selected recipe's sources once per selection (the poll
  // must not keep re-fitting). Reads sources through a ref so a data refresh
  // doesn't re-trigger the fit. Not in the exhibit: there a ?recipe= traces
  // (highlights) its sources while the view stays on everything.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const activeRecipeId = activeRecipe?.id ?? null;
  useEffect(() => {
    if (!activeRecipeId) {
      fittedRecipe.current = null;
      return;
    }
    if (fittedRecipe.current === activeRecipeId) return;
    fittedRecipe.current = activeRecipeId;
    if (embed) return;
    const recipe = recipes.find((r) => r.id === activeRecipeId) || null;
    const ids = ecoRecipeSourceIds(recipe, sourcesRef.current);
    const pts = sourcesRef.current
      .filter((s) => ids.has(s.id) && typeof s.lat === 'number' && typeof s.lng === 'number')
      .map((s) => [s.lat as number, s.lng as number] as [number, number]);
    mapRef.current?.fitRecipePoints(pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRecipeId]);

  function setView(v: EcoView) {
    setViewState(v);
    if (v === 'world') mapRef.current?.setWorldView();
    else mapRef.current?.setRegionView();
  }

  function setRecipe(id: string) {
    setRecipeId(id);
    setSoloId(null); // a recipe pick clears any single-item filter
  }

  /** Single-item filter: clicking a source in the list shows only that one on
   * the map (click it again, or "Show all", to clear). Picking one also
   * clears any traced recipe — otherwise the stacked recipe filter can hide
   * the very item just clicked. */
  function toggleSolo(id: string) {
    const next = soloId === id ? null : id;
    setSoloId(next);
    if (next) {
      setRecipeId('');
      fittedRecipe.current = null;
      // after the markers re-sync for the new filter: zoom + open its popup
      setTimeout(() => mapRef.current?.focusSource(next), 0);
    }
  }

  /** The transparency chip filters the MAP too (not just the list). Changing
   * it resets any single-item pick — you re-stack one by clicking a row. */
  function setTxFilter(key: Transparency | '') {
    setTxFilterState(key);
    setSoloId(null);
    setTimeout(() => mapRef.current?.fitVisible(), 0); // zoom + center over the filtered group
  }

  function addNew() {
    setDraft(newDraft());
  }

  function editOpen(id: string) {
    const s = sources.find((x) => x.id === id);
    if (!s) return;
    mapRef.current?.closePopup();
    setDraft(draftFromSource(s));
    if (typeof s.lat === 'number' && typeof s.lng === 'number') {
      mapRef.current?.panTo(s.lat, s.lng);
    }
  }

  function cancelDraft() {
    setDraft(null);
  }

  function patchDraft(patch: Partial<EcoDraft>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  function placeDraftPin(lat: number, lng: number) {
    setDraft((d) => (d ? { ...d, lat, lng } : d));
  }

  /** Open the add-source form pre-filled with an untraced ingredient's name,
   * so placing it is one tap → name already typed → suggest region or tap the
   * map. */
  function placeIngredient(name: string) {
    setDraft({ ...newDraft(), name: name || '' });
    setTimeout(
      () => addPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
      0,
    );
  }

  function saveDraft() {
    if (!draft) return;
    if (!draft.name.trim()) {
      push('Name the food first.');
      return;
    }
    if (typeof draft.lat !== 'number' || typeof draft.lng !== 'number') {
      push('Tap the map to set a location first.');
      return;
    }
    const kind = draft.precision === 'area' ? draft.area_kind || 'circle' : 'circle';
    const payload: SourcePayload = {
      name: draft.name.trim(),
      note: (draft.note || '').trim(),
      lat: draft.lat,
      lng: draft.lng,
      precision: draft.precision,
      radius_km: draft.precision === 'area' && kind === 'circle' ? draft.radius_km || 0 : 0,
      transparency: draft.transparency || 'unrated',
      area_kind: kind,
      counties: kind === 'counties' ? draft.counties || [] : [],
      region_name: kind === 'state' ? draft.region_name || '' : '',
      geo_source: draft.geo_source || 'unrated',
    };
    if (draft.id) payload.id = draft.id;
    save.mutate(payload, {
      onSuccess: () => setDraft(null), // close the editor immediately; the invalidate paints the marker
    });
  }

  function requestDelete(id: string, name: string) {
    mapRef.current?.closePopup();
    setConfirmDelete({ id, name });
  }

  /** Delete from inside the edit sheet: close it first, then run the shared
   * confirm flow (the two dialogs would otherwise stack). */
  function requestDeleteFromEdit(id: string, name: string) {
    setDraft(null);
    requestDelete(id, name);
  }

  function confirmDeleteNow() {
    if (!confirmDelete) return;
    if (soloId === confirmDelete.id) setSoloId(null);
    remove.mutate(confirmDelete.id);
    setConfirmDelete(null);
  }

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading&hellip;</div>
      </div>
    );
  }
  // Error page only when there's nothing to show — a failed background poll
  // must keep rendering the data we have (and never unmount the Leaflet map).
  if (!data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  const adding = !!draft && !draft.id;
  const editing = !!draft && !!draft.id;

  if (embed) {
    const sourcing = activeRecipe ? ecoRecipeSourcing(activeRecipe, sources) : null;
    const door = `/food-map${recipeId ? `?recipe=${encodeURIComponent(recipeId)}` : ''}`;
    return (
      <div className={styles.embedPage}>
        <EcoMap
          ref={mapRef}
          sources={sources}
          visibleIds={visibleIds}
          draft={null}
          canEdit={false}
          embed
          onMapClick={() => {}}
          onDraftMove={() => {}}
          onEditSource={() => {}}
          onDeleteSource={() => {}}
        />
        {/* The caption is written OUTWARD, to a stranger: what this is and
            what the colour means. It never takes the pointer, so the map
            drags straight through it. */}
        <div className={styles.embedCaption}>
          <div className={styles.embedTitle}>{activeRecipe ? activeRecipe.name : 'Where my food comes from'}</div>
          {sourcing ? (
            <div className={styles.embedCount}>
              {sourcing.traced.length} of {sourcing.total} ingredients traced
              {sourcing.pantry.length ? ` · ${sourcing.pantry.length} pantry staples set aside` : ''}
            </div>
          ) : null}
          <p className={styles.embedLine}>
            One dinner, traced to where public records say each ingredient is grown. Color is how
            much can actually be known.
          </p>
        </div>
        <div className={styles.embedLegend} aria-label="Transparency key">
          {ECO_TX_ORDER.map((k) => (
            <span key={k} className={styles.embedChip}>
              <span className={styles.embedDot} style={{ background: ECO_TX[k].color }} />
              {ECO_TX[k].label}
            </span>
          ))}
        </div>
        <a className={styles.embedOpen} href={door} target="_top" rel="noopener">
          Explore the map <span aria-hidden="true">&#8599;</span>
        </a>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.sectionTitle}>Ecosystem &middot; Food</div>
      <div className={styles.subtitle}>
        Where your food comes from. Add a source, then place it on the map &mdash; a soft circle
        marks a rough region rather than an exact spot.
      </div>

      <EcoControls
        view={view}
        onSetView={setView}
        recipes={recipes}
        recipeId={recipeId}
        onSetRecipe={setRecipe}
        adding={!!draft}
        canEdit={canEdit}
        onAddNew={addNew}
      />

      <EcoMap
        ref={mapRef}
        sources={sources}
        visibleIds={visibleIds}
        draft={draft}
        canEdit={canEdit}
        onMapClick={placeDraftPin}
        onDraftMove={placeDraftPin}
        onEditSource={editOpen}
        onDeleteSource={requestDelete}
      />

      <EcoLegend />

      {/* Hidden while adding/editing a source, or while a single item is
          isolated from the list — reappears when that filter is cleared. */}
      {activeRecipe && !draft && !soloId ? (
        <RecipePanel
          recipe={activeRecipe}
          sources={sources}
          canEdit={canEdit}
          onFocusSource={(id) => mapRef.current?.focusSource(id)}
          onPlaceIngredient={placeIngredient}
          onClear={() => setRecipe('')}
        />
      ) : null}

      {/* Adding renders inline (below the map, so you can tap to place a pin);
          editing opens the shared Sheet, like other pages' focused editors. */}
      {adding && draft ? (
        <div ref={addPanelRef} className={styles.addCard}>
          <div className={styles.addTitle}>New food source</div>
          <SourceEditor
            key="new"
            draft={draft}
            editing={false}
            onPatch={patchDraft}
            onSave={saveDraft}
            onCancel={cancelDraft}
            onDelete={requestDeleteFromEdit}
            onError={push}
            map={mapRef}
          />
        </div>
      ) : null}

      <SourceList
        sources={sources}
        search={search}
        onSearch={setSearch}
        txFilter={txFilter}
        onTxFilter={setTxFilter}
        soloId={soloId}
        onToggleSolo={toggleSolo}
        canEdit={canEdit}
        onEdit={editOpen}
      />

      <Sheet open={editing} title="Edit source" onClose={cancelDraft}>
        {editing && draft ? (
          <SourceEditor
            key={draft.id}
            draft={draft}
            editing
            onPatch={patchDraft}
            onSave={saveDraft}
            onCancel={cancelDraft}
            onDelete={requestDeleteFromEdit}
            onError={push}
            map={mapRef}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={!!confirmDelete}
        title="Remove from the map?"
        onClose={() => setConfirmDelete(null)}
      >
        <p className={styles.confirmText}>
          Remove <b>{confirmDelete?.name}</b> from the map?
        </p>
        <div className={styles.confirmActions}>
          <button type="button" className={styles.confirmDeleteBtn} onClick={confirmDeleteNow}>
            Remove
          </button>
          <button
            type="button"
            className={styles.confirmCancelBtn}
            onClick={() => setConfirmDelete(null)}
          >
            Cancel
          </button>
        </div>
      </Sheet>

      <ToastStack toasts={toasts} onDismiss={dismiss} />
      {canEdit ? <NotesPill onError={push} tab="ecosystem" /> : null}
    </div>
  );
}
