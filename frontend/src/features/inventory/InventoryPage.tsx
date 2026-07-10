/**
 * Inventory tab — React port of templates/index.html #tab-inventory +
 * static/js/inventory.js + static/js/archivals.js. Layout order matches the
 * old page: priority notes, restock banner, Buy List, Consumables (active),
 * Durables (archivals catalog), Past Consumables — plus the ?buy=<name>
 * deep-link detail view that replaces /item/buy/<name>.
 *
 * Deliberately skipped (matching the rest of the React migration):
 * the pending-approvals modal and the per-tab tagged-todo strip.
 */
import { useRef, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { ActiveInventorySection } from './ActiveInventorySection';
import { ArchivalModal } from './ArchivalModal';
import { ArchivalsSection } from './ArchivalsSection';
import { BuyItemDetail } from './BuyItemDetail';
import { BuyItemModal } from './BuyItemModal';
import { BuyListSection } from './BuyListSection';
import { ConfirmDialog, PromptDialog } from './Modal';
import type { ConfirmState, PromptState } from './Modal';
import { PastInventorySection } from './PastInventorySection';
import { PriorityNotesCard } from './PriorityNotesCard';
import { RestockBanner } from './RestockBanner';
import {
  activeItems,
  asList,
  knownCategories,
  pastItems,
  runningLowItems,
} from './inventoryHelpers';
import type { ActiveItem, ArchivalItem, BuyItem } from './types';
import { useInventoryActions, useInventoryData, useToasts } from './useInventoryData';
import type { InventoryActions } from './useInventoryData';
import styles from './inventory.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

export interface InventoryPageProps {
  /** ?buy=<name> — opens the buy-item detail instead of the tab. */
  buyName?: string;
}

export function InventoryPage({ buyName }: InventoryPageProps) {
  const { data, isLoading, isError, error, refetch } = useInventoryData();
  const { toasts, push, dismiss } = useToasts();
  const actions = useInventoryActions(push);
  const isPublic = isPublicMode();

  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  /** Buy-list row modal (name of the item being edited). */
  const [buyModalName, setBuyModalName] = useState<string | null>(null);
  /** Archival modal: 'new' | item id | null. */
  const [archModal, setArchModal] = useState<string | null>(null);

  // Show all / Collapse all — null means each section keeps its own default;
  // the handler flips the live <details> like the old toggleInventoryCollapse.
  const sectionsRef = useRef<HTMLDivElement>(null);
  const [forcedOpen, setForcedOpen] = useState<boolean | null>(null);
  function toggleCollapse() {
    const details = sectionsRef.current?.querySelectorAll('details') || [];
    const anyOpen = Array.from(details).some((d) => d.open);
    details.forEach((d) => {
      d.open = !anyOpen;
    });
    setForcedOpen(!anyOpen);
  }
  const sectionOpen = (defaultOpen: boolean) => forcedOpen ?? defaultOpen;

  const buyList = asList<BuyItem>(data?.buy_list);
  const allActive = asList<ActiveItem>(data?.active_inventory);
  const archivals = asList<ArchivalItem>(data?.archivals);
  const active = activeItems(allActive);
  const past = pastItems(allActive);

  function confirmDeleteBuy(name: string) {
    setConfirm({ label: name, onConfirm: () => actions.removeBuy(name) });
  }
  function confirmDeleteActive(name: string) {
    setConfirm({ label: name, onConfirm: () => actions.removeActive(name) });
  }
  function promptRetire(name: string) {
    setPrompt({
      message: `Retire "${name}" — your thoughts on it (didn't work, side effects, finished, etc):`,
      initial: '',
      onSave: (v) => actions.retire(name, v.trim()),
    });
  }
  function promptEditReview(name: string) {
    const item = allActive.find((i) => i.name === name);
    setPrompt({
      message: `Review for "${name}":`,
      initial: item?.review || '',
      onSave: (v) => actions.editReview(name, v.trim()),
    });
  }

  const overlays = (
    <>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <PromptDialog state={prompt} onClose={() => setPrompt(null)} />
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      {!isPublic ? <NotesPill tab="inventory" onError={push} /> : null}
    </>
  );

  // --- deep-link detail view (?buy=<name>, the old /item/buy/<name>) ---
  if (buyName) {
    const item = buyList.find((i) => i.name === buyName) || null;
    return (
      <div className={styles.page}>
        {isLoading && !data ? (
          <div className={styles.bannerLoading}>Loading…</div>
        ) : isError && !data ? (
          <div className={styles.bannerError}>
            <span>{error instanceof Error && error.message ? error.message : "Couldn't load data."}</span>
            <button type="button" onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <BuyItemDetail
            item={item}
            knownCategories={knownCategories(buyList, allActive)}
            onSave={actions.updateBuy}
            onError={push}
          />
        )}
        {overlays}
      </div>
    );
  }

  const buyModalItem = buyModalName ? buyList.find((i) => i.name === buyModalName) || null : null;
  const archModalItem =
    archModal && archModal !== 'new' ? archivals.find((i) => i.id === archModal) || null : null;

  return (
    <div className={styles.page}>
      <div ref={sectionsRef}>
        <div className={styles.headerRow}>
          <h1 className={styles.pageTitle}>Inventory</h1>
          <button type="button" className={styles.collapseBtn} onClick={toggleCollapse}>
            {forcedOpen === false ? 'Show all' : 'Collapse all'}
          </button>
        </div>

        {isLoading && !data ? <div className={styles.bannerLoading}>Loading…</div> : null}
        {isError && !data ? (
          <div className={styles.bannerError}>
            <span>{error instanceof Error && error.message ? error.message : "Couldn't load data."}</span>
            <button type="button" onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        ) : null}

        {data ? (
          <>
            <PriorityNotesCard
              serverText={typeof data.priority_notes === 'string' ? data.priority_notes : ''}
            />
            <RestockBanner lows={runningLowItems(allActive)} />
            <BuyListSection
              items={buyList}
              open={sectionOpen(true)}
              onOpenItem={setBuyModalName}
              onSetKind={actions.setBuyKind}
              onMarkBought={actions.markBought}
              onDelete={confirmDeleteBuy}
              onAdd={actions.addBuy}
            />
            <ActiveInventorySection
              items={active}
              open={sectionOpen(true)}
              onRestock={actions.restock}
              onRetire={promptRetire}
              onDelete={confirmDeleteActive}
            />
            <ArchivalsSection
              items={archivals}
              open={sectionOpen(true)}
              onOpenItem={setArchModal}
              onAdd={() => setArchModal('new')}
            />
            <PastInventorySection
              items={past}
              open={sectionOpen(false)}
              onEditReview={promptEditReview}
              onUnretire={actions.unretire}
              onDelete={confirmDeleteActive}
            />
          </>
        ) : null}
      </div>

      {buyModalItem ? (
        <BuyItemModal
          key={buyModalItem.name}
          item={buyModalItem}
          knownCategories={knownCategories(buyList, allActive)}
          onClose={() => setBuyModalName(null)}
          onSave={actions.updateBuy}
          onDelete={confirmDeleteBuy}
          onError={push}
        />
      ) : null}

      {archModal === 'new' || archModalItem ? (
        <ArchivalModalHost
          key={archModal === 'new' ? 'new' : archModalItem?.id}
          item={archModal === 'new' ? null : archModalItem}
          allItems={archivals}
          onClose={() => setArchModal(null)}
          onError={push}
          actions={actions}
          onDelete={(id, name) =>
            setConfirm({
              label: name,
              onConfirm: () => {
                actions.removeArchival(id);
                setArchModal(null);
              },
            })
          }
        />
      ) : null}

      {overlays}
    </div>
  );
}

// Small indirection so ArchivalModal's props stay flat/testable while the page
// owns the confirm dialog + action plumbing.
function ArchivalModalHost({
  item,
  allItems,
  onClose,
  onError,
  onDelete,
  actions,
}: {
  item: ArchivalItem | null;
  allItems: ArchivalItem[];
  onClose: () => void;
  onError: (message: string) => void;
  onDelete: (id: string, name: string) => void;
  actions: InventoryActions;
}) {
  return (
    <ArchivalModal
      item={item}
      allItems={allItems}
      onClose={onClose}
      onError={onError}
      onSaveAdd={actions.saveArchivalAdd}
      onSaveUpdate={actions.saveArchivalUpdate}
      onDelete={onDelete}
      onAddPhotos={actions.addPhotos}
      onRemovePhoto={actions.removePhoto}
      onSetMainPhoto={actions.setMainPhoto}
    />
  );
}
