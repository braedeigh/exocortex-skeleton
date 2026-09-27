import { useCallback, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { AddToListSection } from './AddToListSection';
import {
  addCatalogItem,
  deleteMealNote,
  discardParsedRecipe,
  previewParsedReceipt,
  previewParsedRecipe,
  removeCatalogItem,
  scanReceipt,
} from './api';
import { CatalogEditorModal } from './CatalogEditorModal';
import { capitalize } from './catalogHelpers';
import { CategoriesEditorModal } from './CategoriesEditorModal';
import { CategoryOrderModal } from './CategoryOrderModal';
import { CategoryPickerModal } from './CategoryPickerModal';
import { ConfirmModal, useConfirm } from './ConfirmModal';
import { DoneShoppingModal } from './DoneShoppingModal';
import { GroceryListCard } from './GroceryListCard';
import { MealNotesSection } from './MealNotesSection';
import { GroceryNoteModal, ItemNoteModal } from './NoteModals';
import { PurchaseHistorySection } from './PurchaseHistorySection';
import { prefillAisles } from './receiptHelpers';
import { ReceiptImportModal } from './ReceiptImportModal';
import { RecipeDetailView } from './RecipeDetailView';
import { RecipeEditView } from './RecipeEditView';
import { RecipeImportModal } from './RecipeImportModal';
import { RecipeSendModal } from './RecipeSendModal';
import { RecipesSection } from './RecipesSection';
import { SpendTrendSection } from './SpendTrendSection';
import type { Recipe, ReceiptHeader, ReceiptRow } from './types';
import {
  useGroceryActions,
  useInvalidateKitchen,
  useKitchenData,
  useParsedReceipts,
  useParsedRecipes,
  useRecipeActions,
  useToasts,
} from './useKitchenData';
import styles from './kitchen.module.css';

const AISLES_SENTINEL = '@aisles';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

interface CatModalState {
  name: string;
  resolve: (category: string | null) => void;
}

interface ReceiptImportState {
  filename: string;
  header: ReceiptHeader;
  rows: ReceiptRow[];
}

export function KitchenPage() {
  const { data, isLoading, isError, error } = useKitchenData();
  const parsedReceiptsQuery = useParsedReceipts();
  const parsedRecipesQuery = useParsedRecipes();
  const { toasts, push, dismiss } = useToasts();
  const actions = useGroceryActions(push);
  const recipeActions = useRecipeActions(push);
  const invalidate = useInvalidateKitchen();
  const { request: confirmRequest, confirm, close: closeConfirm } = useConfirm();
  const isPublic = isPublicMode();

  // --- view state ---
  const [recipeView, setRecipeView] = useState<string | null>(null);
  const [recipeEditing, setRecipeEditing] = useState(false);
  // Post-shop receipt prompt: dismissed per "trip" (resets when items get added).
  const [receiptDismissed, setReceiptDismissed] = useState(false);
  const [doneModalOpen, setDoneModalOpen] = useState(false);
  const [catModal, setCatModal] = useState<CatModalState | null>(null);
  const [groceryNoteFor, setGroceryNoteFor] = useState<string | null>(null);
  const [itemNoteFor, setItemNoteFor] = useState<string | null>(null);
  const [catalogEditorOpen, setCatalogEditorOpen] = useState(false);
  const [categoriesEditorOpen, setCategoriesEditorOpen] = useState(false);
  const [categoryOrderOpen, setCategoryOrderOpen] = useState(false);
  const [receiptImport, setReceiptImport] = useState<ReceiptImportState | null>(null);
  const [recipeImport, setRecipeImport] = useState<{ filename: string; recipe: Recipe } | null>(null);
  const [sendRecipeId, setSendRecipeId] = useState<string | null>(null);

  // Shared "create a kitchen category" flow (_createKitchenCategory): validate,
  // refuse the sentinel, insert just before '@aisles', persist the order.
  const createCategoryNamed = useCallback(
    async (raw: string): Promise<string | null> => {
      const name = (raw || '').trim().toLowerCase();
      if (!name) return null;
      if (name === AISLES_SENTINEL) {
        push('@aisles is reserved');
        return null;
      }
      const order = (data?.kitchen_category_order || []).slice();
      if (!order.includes(name)) {
        const aislesAt = order.indexOf(AISLES_SENTINEL);
        if (aislesAt >= 0) order.splice(aislesAt, 0, name);
        else order.push(name);
        try {
          await actions.categoryOrder(order);
        } catch (e) {
          push(`Failed to add category: ${e instanceof Error ? e.message : e}`);
          return null;
        }
      }
      return name;
    },
    [data, actions, push],
  );

  const createCategoryPrompt = useCallback(
    () => createCategoryNamed(window.prompt('New category name:') || ''),
    [createCategoryNamed],
  );

  /** Category-picker modal as a promise (openKitchenCatModal). */
  const pickCategory = useCallback(
    (name: string) =>
      new Promise<string | null>((resolve) => {
        setCatModal({ name, resolve });
      }),
    [],
  );

  async function uploadReceipt(file: File) {
    try {
      const res = await scanReceipt(file);
      // Each receipt is its own Reading Room helper run now (routes/helpers.py);
      // the parsed result shows up in the import list below when it lands.
      push(`Receipt sent to Claude (${res.filename}). It'll appear below once parsed — or watch it under Helpers in the Observatory.`, 'info');
      setReceiptDismissed(true); // hide banner after scan
    } catch (e) {
      push(e instanceof Error ? e.message : 'Upload failed');
    }
  }

  async function openReceiptImport(filename: string) {
    try {
      const res = await previewParsedReceipt(filename);
      if (res.error) {
        push(res.error);
        return;
      }
      const rows = prefillAisles(res.rows || [], data?.kitchen_aisles || {});
      setReceiptImport({ filename, header: res.header || {}, rows });
    } catch (e) {
      push(`Failed to load receipt: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function openRecipeImport(filename: string) {
    try {
      const recipe = await previewParsedRecipe(filename);
      if (recipe.error) {
        push(recipe.error);
        return;
      }
      setRecipeImport({ filename, recipe });
    } catch (e) {
      push(`Failed to load recipe: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function discardParsed(filename: string) {
    if (!window.confirm('Discard this parsed recipe? The original URL/image file is kept.')) return;
    try {
      await discardParsedRecipe(filename);
    } catch (e) {
      push(`Discard failed: ${e instanceof Error ? e.message : e}`);
    }
    void parsedRecipesQuery.refetch();
  }

  function confirmRemoveGrocery(name: string) {
    confirm({
      message: (
        <>
          Remove <b>{name}</b>?
        </>
      ),
      onConfirm: () => actions.remove(name),
    });
  }

  function confirmClearAll() {
    confirm({
      message: (
        <>
          Clear ALL items from the grocery list?
          <br />
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
            This removes everything, checked and unchecked. It does not log a kitchen trip.
          </span>
        </>
      ),
      confirmLabel: 'Yes, clear all',
      onConfirm: () => actions.clearAll(),
    });
  }

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading&hellip;</div>
      </div>
    );
  }

  // Error page only when there's nothing to show — a failed background poll
  // (isError with stale data still cached) must not blank a working page.
  if (!data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          Failed to load: {isError && error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  const recipes = data.recipes || [];
  const viewedRecipe = recipeView ? recipes.find((r) => r.id === recipeView) || null : null;
  const sendRecipe = sendRecipeId ? recipes.find((r) => r.id === sendRecipeId) || null : null;
  const parsedReceipts = parsedReceiptsQuery.data?.receipts || [];
  const parsedRecipes = parsedRecipesQuery.data?.recipes || [];

  return (
    <div className={styles.page}>
      {viewedRecipe && recipeEditing && !isPublic ? (
        <RecipeEditView
          key={viewedRecipe.id}
          recipe={viewedRecipe}
          serverDate={data.server_date}
          onCancel={() => setRecipeEditing(false)}
          onSaved={() => {
            setRecipeEditing(false);
            invalidate();
          }}
          onSavedVariant={(newId) => {
            setRecipeEditing(false);
            setRecipeView(newId);
            invalidate();
          }}
          onConfirmDelete={(id, name) =>
            confirm({
              message: (
                <>
                  Remove the recipe <b>{name}</b>?
                </>
              ),
              onConfirm: () => {
                recipeActions.remove(id);
                setRecipeEditing(false);
                setRecipeView(null);
              },
            })
          }
          onError={push}
        />
      ) : viewedRecipe ? (
        <RecipeDetailView
          key={viewedRecipe.id}
          recipe={viewedRecipe}
          allRecipes={recipes}
          sources={data.ecosystem?.sources || []}
          ecoRecipe={data.eco_recipes?.find((r) => r.id === viewedRecipe.id) ?? null}
          onBack={() => {
            setRecipeView(null);
            window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
          }}
          onEdit={() => setRecipeEditing(true)}
          onSendToList={() => setSendRecipeId(viewedRecipe.id)}
          onViewRecipe={(id) => {
            setRecipeView(id);
            window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
          }}
          saveMyNotes={recipeActions.saveMyNotes}
          isPublic={isPublic}
        />
      ) : (
        <div style={{ marginBottom: 20 }}>
          <GroceryListCard
            data={data}
            actions={actions}
            receiptDismissed={receiptDismissed}
            onDismissReceipt={() => setReceiptDismissed(true)}
            onScanReceipt={(file) => void uploadReceipt(file)}
            parsedReceipts={parsedReceipts}
            onOpenImport={(filename) => void openReceiptImport(filename)}
            onEditOrder={() => setCategoryOrderOpen(true)}
            onEditNote={setGroceryNoteFor}
            onConfirmRemove={confirmRemoveGrocery}
            onConfirmClearAll={confirmClearAll}
            onAllChecked={() => setDoneModalOpen(true)}
            isPublic={isPublic}
          />

          {!isPublic ? (
            <AddToListSection
              data={data}
              actions={actions}
              pickCategory={pickCategory}
              addWithCategory={actions.addWithCategory}
              onOpenCatalogEditor={() => setCatalogEditorOpen(true)}
              onOpenItemNote={setItemNoteFor}
              onItemAdded={() => setReceiptDismissed(false)}
            />
          ) : null}

          <RecipesSection
            recipes={recipes}
            parsedRecipes={parsedRecipes}
            onReviewParsed={(f) => void openRecipeImport(f)}
            onDiscardParsed={(f) => void discardParsed(f)}
            onView={(id) => {
              setRecipeView(id);
              setRecipeEditing(false);
              window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
            }}
            onSendToList={setSendRecipeId}
            onError={push}
            refetchParsed={() => void parsedRecipesQuery.refetch()}
            isPublic={isPublic}
          />

          <MealNotesSection
            notes={data.meal_notes || []}
            invalidate={invalidate}
            onError={push}
            isPublic={isPublic}
            onConfirmDelete={(index, note) => {
              const preview = (note.text || '').slice(0, 60) + ((note.text || '').length > 60 ? '…' : '');
              confirm({
                message: (
                  <>
                    Remove this meal note?
                    <br />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, fontStyle: 'italic' }}>
                      &quot;{preview}&quot;
                    </span>
                  </>
                ),
                onConfirm: () => {
                  void deleteMealNote(index)
                    .then(invalidate)
                    .catch((e: unknown) => push(`Delete failed: ${e instanceof Error ? e.message : e}`));
                },
              });
            }}
          />

          <PurchaseHistorySection data={data} />

          <SpendTrendSection trips={data.kitchen_trips || []} />
        </div>
      )}

      {/* --- modals --- */}

      {catModal ? (
        <CategoryPickerModal
          name={catModal.name}
          categoryOrder={data.kitchen_category_order}
          onPick={(cat) => {
            catModal.resolve(cat);
            setCatModal(null);
          }}
          onNewCategory={() => {
            void createCategoryPrompt().then((created) => {
              if (created) {
                catModal.resolve(created);
                setCatModal(null);
              }
            });
          }}
          onCancel={() => {
            catModal.resolve(null);
            setCatModal(null);
          }}
        />
      ) : null}

      {doneModalOpen ? (
        <DoneShoppingModal
          onScanReceipt={(file) => {
            setDoneModalOpen(false);
            // Clear checked items first (the trip is finished), then scan.
            actions.clearChecked();
            void uploadReceipt(file);
            setReceiptDismissed(true);
          }}
          onFinishWithoutReceipt={() => {
            setDoneModalOpen(false);
            actions.clearChecked();
            setReceiptDismissed(true);
          }}
          onNotYet={() => {
            setDoneModalOpen(false);
            setReceiptDismissed(true); // the auto-pop won't fire again this trip
          }}
        />
      ) : null}

      {groceryNoteFor ? (
        <GroceryNoteModal
          name={groceryNoteFor}
          initial={(data.kitchen_list || []).find((i) => i.name === groceryNoteFor)?.note || ''}
          onSave={(note) => actions.note(groceryNoteFor, note)}
          onClose={() => setGroceryNoteFor(null)}
        />
      ) : null}

      {itemNoteFor ? (
        <ItemNoteModal
          name={itemNoteFor}
          category={(data.kitchen_known_items || {})[itemNoteFor] || 'other'}
          initial={(data.kitchen_item_notes || {})[itemNoteFor] || ''}
          onSave={(note) => actions.catalogNote(itemNoteFor, note)}
          onClose={() => setItemNoteFor(null)}
        />
      ) : null}

      {catalogEditorOpen ? (
        <CatalogEditorModal
          data={data}
          onClose={() => setCatalogEditorOpen(false)}
          onError={push}
          invalidate={invalidate}
          onConfirmDelete={(name) =>
            confirm({
              message: (
                <>
                  Remove <b>{capitalize(name)}</b>?
                </>
              ),
              onConfirm: () => {
                void removeCatalogItem(name)
                  .then(invalidate)
                  .catch((e: unknown) => push(`Delete failed: ${e instanceof Error ? e.message : e}`));
              },
            })
          }
          onManageCategories={() => setCategoriesEditorOpen(true)}
          onSetCategory={(name, category) => {
            void addCatalogItem(name, category)
              .then(invalidate)
              .catch((e: unknown) => push(`Couldn't save: ${e instanceof Error ? e.message : e}`));
          }}
          createCategory={createCategoryPrompt}
        />
      ) : null}

      {categoriesEditorOpen ? (
        <CategoriesEditorModal
          data={data}
          onClose={() => setCategoriesEditorOpen(false)}
          onError={push}
          invalidate={invalidate}
          createCategoryNamed={createCategoryNamed}
        />
      ) : null}

      {categoryOrderOpen ? (
        <CategoryOrderModal
          order={data.kitchen_category_order || []}
          onSave={(order) => actions.categoryOrder(order)}
          onClose={() => setCategoryOrderOpen(false)}
        />
      ) : null}

      {receiptImport ? (
        <ReceiptImportModal
          filename={receiptImport.filename}
          header={receiptImport.header}
          initialRows={receiptImport.rows}
          data={data}
          onClose={() => setReceiptImport(null)}
          onImported={() => {
            invalidate(); // pulls fresh kitchen_trips + counts
            void parsedReceiptsQuery.refetch();
          }}
          onError={push}
          createCategoryNamed={createCategoryNamed}
        />
      ) : null}

      {recipeImport ? (
        <RecipeImportModal
          filename={recipeImport.filename}
          recipe={recipeImport.recipe}
          onClose={() => setRecipeImport(null)}
          onSaved={() => {
            invalidate();
            void parsedRecipesQuery.refetch();
          }}
          onDiscard={(f) => {
            void discardParsedRecipe(f)
              .catch((e: unknown) => push(`Discard failed: ${e instanceof Error ? e.message : e}`))
              .then(() => void parsedRecipesQuery.refetch());
          }}
          onError={push}
        />
      ) : null}

      {sendRecipe ? (
        <RecipeSendModal
          recipe={sendRecipe}
          data={data}
          onClose={() => setSendRecipeId(null)}
          onSent={(summary) => {
            push(summary, 'info');
            invalidate();
          }}
          onError={push}
        />
      ) : null}

      <ConfirmModal request={confirmRequest} onClose={closeConfirm} />

      {!isPublic ? <NotesPill onError={push} tab="kitchen" /> : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
