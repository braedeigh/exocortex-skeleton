/**
 * EcosystemPage.tsx — the Food area's map (/food): where her food comes from.
 * React port of templates/index.html #tab-ecosystem + static/js/ecosystem.js.
 * The same page is the public /food-map and its ?embed=1 exhibit.
 *
 * Layout (top to bottom): section title + subtitle, the Food area's row of
 * doors (FoodNav — on /food only, never on the public map), controls, the
 * persistent Leaflet map, legend, the "one food" banner, the open source's
 * panel, recipe-trace panel, inline add form, the Foods panel (every food,
 * traced or not), and the source list. Editing an existing source opens the
 * shared Sheet. The map instance lives in EcoMap and survives the 5s poll;
 * everything here re-renders freely.
 *
 * Everything is navigable: a source opens from its list row, its map popup
 * ("Details"), a food's chip, or a traced recipe line; a food shows only its
 * sources on the map. The open source and food ride in the address
 * (?source=<id>, ?food=<id>) so a view can be bookmarked or shared, and a
 * food's page (/food/foods/<name>) links straight here. On /food the Food
 * search box above the doors (foodSearch.ts) narrows the map, the Foods panel
 * and the source list to what matches, and frames the matches. A food with no
 * source yet gets the shared "Request linking" button in its banner, which
 * queues it for research without linking anything.
 *
 * The data is SQL now (sourcestore.py via /api/data/ecosystem): sources carry
 * their links to foods and products, and every recipe line carries its food,
 * so tracing follows links rather than matching words.
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
import { FoodNav } from './FoodNav';
import { matchingFoodIds, matchingSourceIds, normalizeQuery, useFoodSearch } from './foodSearch';
import { FoodsPanel } from './FoodsPanel';
import type { FoodFilter } from './FoodsPanel';
import { RecipePanel } from './RecipePanel';
import { RequestLinkButton } from './RequestLinkButton';
import { isFoodRequested } from './requestLink';
import { SourceEditor } from './SourceEditor';
import { SourceList } from './SourceList';
import { SourcePanel, foodPageHref } from './SourcePanel';
import type { SourcePayload } from './api';
import { ecoRecipeSourceIds, ecoRecipeSourcing } from './ecoMatch';
import { ECO_TX, ECO_TX_ORDER } from './axes';
import { draftFromSource, newDraft } from './types';
import type { EcoDraft, EcoFood, EcoIngredient, EcoSource, Transparency } from './types';
import { useEcosystemData, useSourceMutations } from './useEcosystemData';
import { computeVisibleIds } from './visibility';
import styles from './EcosystemPage.module.css';
import foodAreaStyles from './FoodArea.module.css';

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
 * the full page. It opens centered over the sources near home, all of them
 * in view at once (EcoMap's fitHome, padded so the caption and key don't
 * cover a dot; in a small frame the caption shrinks to a title and the key
 * hides — embedLayout.ts); a ?recipe= is traced in place rather than flown
 * to.
 *
 * Prompts that produced it: "iframe with some flashy thing to make people
 * wanna click into the whole interface" — with the recipe pre-traced; then
 * "center over everything showing all at once"; then "make it center over
 * the US stuff actually".
 */
/** Keep ?source= / ?food= / ?recipe= in the address bar in step with what's
 * open, without a navigation (replaceState), so the view can be shared. */
function syncAddress(params: { source: string | null; food: number | null; recipe: string }) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const set = (key: string, value: string | null) => {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  };
  set('source', params.source);
  set('food', params.food != null ? String(params.food) : null);
  set('recipe', params.recipe || null);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url.href);
}

export function EcosystemPage({
  initialRecipeId = '',
  initialSourceId = '',
  initialFoodId = null,
  embed = false,
  nav = false,
}: {
  initialRecipeId?: string;
  initialSourceId?: string;
  initialFoodId?: number | null;
  embed?: boolean;
  /** Show the Food area's row of doors — /food sets it, /food-map doesn't. */
  nav?: boolean;
} = {}) {
  const { data, isLoading, error } = useEcosystemData();
  const { toasts, push, dismiss } = useToasts();
  const { save, remove, link, unlink } = useSourceMutations(push);
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
  // The open source's panel, and the one food whose sources the map shows.
  const [openSourceId, setOpenSourceId] = useState<string | null>(initialSourceId || null);
  const [foodId, setFoodId] = useState<number | null>(initialFoodId);
  const [foodFilter, setFoodFilter] = useState<FoodFilter>('all');
  const [foodSearch, setFoodSearch] = useState('');

  const didInitialFit = useRef(false);
  const fittedRecipe = useRef<string | null>(null);

  const sources: EcoSource[] = useMemo(() => data?.ecosystem?.sources ?? [], [data]);
  const recipes = useMemo(() => data?.eco_recipes ?? [], [data]);
  const foods: EcoFood[] = useMemo(() => data?.eco_foods ?? [], [data]);
  const origins = useMemo(() => data?.eco_origins ?? {}, [data]);
  const openSource = useMemo(
    () => sources.find((s) => s.id === openSourceId) || null,
    [sources, openSourceId],
  );
  const shownFood = useMemo(() => foods.find((f) => f.id === foodId) || null, [foods, foodId]);
  const activeRecipe = useMemo(
    () => recipes.find((r) => r.id === recipeId) || null,
    [recipes, recipeId],
  );
  // Narrow everything to the Food search's words — only on /food, where the
  // box is; the public map never sees a search she typed elsewhere.
  const [areaSearch] = useFoodSearch();
  const needle = nav && canEdit ? normalizeQuery(areaSearch) : '';
  const searchSourceIds = useMemo(
    () => matchingSourceIds(needle, sources, foods, recipes),
    [needle, sources, foods, recipes],
  );
  const searchFoodIds = useMemo(() => matchingFoodIds(needle, foods, recipes), [needle, foods, recipes]);
  const shownSources = useMemo(
    () => (searchSourceIds ? sources.filter((s) => searchSourceIds.has(s.id)) : sources),
    [sources, searchSourceIds],
  );
  const shownFoods = useMemo(
    () => (needle ? foods.filter((f) => searchFoodIds.has(f.id)) : foods),
    [needle, foods, searchFoodIds],
  );

  // The map's filters stack, and the search is one more layer on top.
  const visibleIds = useMemo(() => {
    const ids = computeVisibleIds(sources, txFilter, activeRecipe, soloId, foodId);
    if (!searchSourceIds) return ids;
    return ids ? new Set([...ids].filter((id) => searchSourceIds.has(id))) : searchSourceIds;
  }, [sources, txFilter, activeRecipe, soloId, foodId, searchSourceIds]);

  // Frame the matches once she stops typing — a debounce, so the map doesn't
  // lurch on every letter. Clearing the search goes back to the home view.
  const searchFitted = useRef('');
  useEffect(() => {
    if (!data || needle === searchFitted.current) return;
    const t = setTimeout(() => {
      searchFitted.current = needle;
      if (!needle) {
        mapRef.current?.fitHome();
        return;
      }
      const pts = shownSources
        .filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
        .map((s) => [s.lat as number, s.lng as number] as [number, number]);
      if (pts.length) mapRef.current?.fitRecipePoints(pts);
    }, 500);
    return () => clearTimeout(t);
  }, [data, needle, shownSources]);

  useEffect(() => {
    if (!embed) syncAddress({ source: openSourceId, food: foodId, recipe: recipeId });
  }, [embed, openSourceId, foodId, recipeId]);

  // A ?source= deep link zooms to it once the data (and so the dot) is in.
  const zoomedDeepLink = useRef(false);
  useEffect(() => {
    if (!data || zoomedDeepLink.current || !initialSourceId) return;
    zoomedDeepLink.current = true;
    const t = setTimeout(() => mapRef.current?.focusSource(initialSourceId), 50);
    return () => clearTimeout(t);
  }, [data, initialSourceId]);

  // If the solo'd source disappears (deleted elsewhere), drop the filter
  // instead of stranding an empty map with no banner to clear it.
  useEffect(() => {
    if (soloId && sources.length && !sources.some((s) => s.id === soloId)) setSoloId(null);
    if (openSourceId && data && !sources.some((s) => s.id === openSourceId)) setOpenSourceId(null);
  }, [soloId, openSourceId, sources, data]);

  // The host div was hidden until the route opened — after the first data
  // lands, center over her sources near home with every one of them in view
  // (once, not on every poll; EcoMap.fitHome). A lone far-off source stays
  // off-frame rather than shrinking home to a speck; "Whole world" brings it
  // in. The exhibit opens the same way, recipe or not.
  useEffect(() => {
    if (!data || didInitialFit.current) return;
    didInitialFit.current = true;
    const t = setTimeout(() => mapRef.current?.fitHome(), 0);
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
    setOpenSourceId(next);
    if (next) {
      setRecipeId('');
      setFoodId(null);
      fittedRecipe.current = null;
      // after the markers re-sync for the new filter: zoom + open its popup
      setTimeout(() => mapRef.current?.focusSource(next), 0);
    }
  }

  /** Open a source's panel and zoom to it, leaving the other dots in view. */
  function openSourcePanel(id: string) {
    setOpenSourceId(id);
    mapRef.current?.closePopup();
    setTimeout(() => mapRef.current?.focusSource(id), 0);
  }

  function closeSourcePanel() {
    if (soloId === openSourceId) setSoloId(null);
    setOpenSourceId(null);
  }

  /** Show only one food's sources on the map (null clears). */
  function showFood(id: number | null) {
    setFoodId(id);
    setSoloId(null);
    if (id != null) setTimeout(() => mapRef.current?.fitVisible(), 0);
  }

  function linkTo(sourceId: string, target: { food?: number; product_id?: number }) {
    link.mutate({ sourceId, target });
  }

  /** Open the add form for a food: named after it, and linked to it on save. */
  function placeFood(food: EcoFood) {
    setOpenSourceId(null);
    setDraft({ ...newDraft(), name: food.name, food: food.id, food_label: food.name });
    setTimeout(() => addPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
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

  /** Open the add-source form pre-filled with an untraced ingredient's name
   * (and linked to its food on save, when the line has one), so placing it
   * is one tap → name already typed → suggest region or tap the map. */
  function placeIngredient(ing: EcoIngredient) {
    setDraft({
      ...newDraft(),
      name: (ing.item || '').trim(),
      food: ing.food_id ?? null,
      food_label: ing.food_name || undefined,
    });
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
      origin: draft.origin || 'unknown',
      origin_detail: (draft.origin_detail || '').trim(),
      origin_url: (draft.origin_url || '').trim(),
      origin_date: draft.origin_date || '',
      county_detail: kind === 'counties' ? draft.county_detail || [] : [],
    };
    if (draft.id) payload.id = draft.id;
    else if (draft.product_id) payload.product_id = draft.product_id;
    else if (draft.food != null) payload.food = draft.food;
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
      <div className={styles.sectionTitle}>Food</div>
      <div className={styles.subtitle}>
        Where your food comes from. Add a source, then place it on the map &mdash; a soft circle
        marks a rough region rather than an exact spot.
      </div>
      {nav && canEdit ? <FoodNav current="map" /> : null}
      {needle ? (
        <p className={foodAreaStyles.searchNote}>
          {shownSources.length || shownFoods.length
            ? `Showing ${shownSources.length} of ${sources.length} sources and ${shownFoods.length} of ${foods.length} foods that match “${areaSearch.trim()}”.`
            : `Nothing on the map matches “${areaSearch.trim()}”.`}
        </p>
      ) : null}

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
        onOpenSource={openSourcePanel}
      />

      <EcoLegend />

      {shownFood ? (
        <div className={styles.addCard}>
          <div className={styles.addTitle}>
            Where {shownFood.name} comes from &middot; {shownFood.source_ids.length} source
            {shownFood.source_ids.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canEdit && !draft ? (
              <button type="button" className={styles.confirmDeleteBtn} style={{ background: 'var(--accent)' }} onClick={() => placeFood(shownFood)}>
                ＋ Place a source
              </button>
            ) : null}
            {canEdit && !shownFood.source_ids.length ? (
              <RequestLinkButton
                foodId={shownFood.id}
                foodName={shownFood.name}
                requested={isFoodRequested(data?.eco_requested, shownFood.id, shownFood.name)}
                from="map"
                onError={push}
              />
            ) : null}
            {canEdit ? (
              <a
                className={styles.confirmCancelBtn}
                style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
                href={foodPageHref(shownFood.name)}
              >
                Its page
              </a>
            ) : null}
            <button type="button" className={styles.confirmCancelBtn} onClick={() => showFood(null)}>
              Show all
            </button>
          </div>
        </div>
      ) : null}

      {openSource && !draft ? (
        <SourcePanel
          key={openSource.id}
          source={openSource}
          foods={foods}
          recipes={recipes}
          origins={origins}
          canEdit={canEdit}
          onClose={closeSourcePanel}
          onEdit={editOpen}
          onZoom={(id) => mapRef.current?.focusSource(id)}
          onShowFood={(id) => {
            closeSourcePanel();
            showFood(id);
          }}
          onTraceRecipe={(id) => {
            closeSourcePanel();
            setRecipe(id);
          }}
          onLink={linkTo}
          onUnlink={(id) => unlink.mutate(id)}
        />
      ) : null}

      {/* Hidden while adding/editing a source, or while a single item is
          isolated from the list — reappears when that filter is cleared. */}
      {activeRecipe && !draft && !soloId ? (
        <RecipePanel
          recipe={activeRecipe}
          sources={sources}
          canEdit={canEdit}
          onOpenSource={openSourcePanel}
          onPlaceIngredient={placeIngredient}
          onLinkSuggestion={(sourceId, id) => linkTo(sourceId, { food: id })}
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

      <FoodsPanel
        foods={shownFoods}
        sources={sources}
        filter={foodFilter}
        onFilter={setFoodFilter}
        search={foodSearch}
        onSearch={setFoodSearch}
        selectedFoodId={foodId}
        onSelectFood={showFood}
        onOpenSource={openSourcePanel}
        openSource={draft ? null : openSource}
        canEdit={canEdit}
        onLinkHere={(id) => openSource && linkTo(openSource.id, { food: id })}
        onPlace={placeFood}
      />

      {/* While searching, an empty list would read as "no sources yet" — the note above says it instead. */}
      {needle && !shownSources.length ? null : (
        <SourceList
          sources={shownSources}
          search={search}
          onSearch={setSearch}
          txFilter={txFilter}
          onTxFilter={setTxFilter}
          soloId={soloId}
          onToggleSolo={toggleSolo}
          canEdit={canEdit}
          onEdit={editOpen}
        />
      )}

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
