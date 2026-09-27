/**
 * SourcePanel.tsx — one source, opened: everything the map knows about it,
 * and a door to everything it touches.
 *
 * What this file does: shows a selected source's honest labels (transparency,
 * how the dot was placed, its footprint), WHERE THAT INFORMATION CAME FROM
 * (USDA, an address lookup, the package, a visit… with the citation, date and
 * link), USDA's per-county figures when its outline came from there, the foods
 * and products linked to it (each opens that food's page under Research, or
 * shows the food's sources on the map), and the recipes that use them (tap to
 * trace). The owner can link another food or product here, or unlink one.
 *
 * Opened from the source list, a map popup's "Details", or ?source=<id>.
 * Data comes from the page (EcosystemPage.tsx); writes go through api.ts →
 * routes/ecosystem.py → sourcestore.py.
 *
 * Prompt that produced this file: "i want all the sources to be navigable and
 * stuff" — and "save the source origin information like USDA or whatever in
 * the table and display it."
 */
import { useMemo, useState } from 'react';
import { ECO_ORIGIN, countyFigure, geoSourceInfo, metaLabel, originOf, txInfo } from './axes';
import type { EcoFood, EcoRecipe, EcoSource } from './types';
import styles from './Panels.module.css';

export interface SourcePanelProps {
  source: EcoSource;
  foods: EcoFood[];
  recipes: EcoRecipe[];
  /** origin word → what it means (server's sourcestore.ORIGINS) */
  origins: Record<string, string>;
  canEdit: boolean;
  onClose: () => void;
  onEdit: (id: string) => void;
  onZoom: (id: string) => void;
  onShowFood: (foodId: number) => void;
  onTraceRecipe: (recipeId: string) => void;
  onLink: (sourceId: string, target: { food?: number; product_id?: number }) => void;
  onUnlink: (linkId: number) => void;
}

/** A food's page under Research — the food's profile. */
export function foodPageHref(name: string): string {
  return `/research/foods/${encodeURIComponent(name)}`;
}

export function SourcePanel({
  source,
  foods,
  recipes,
  origins,
  canEdit,
  onClose,
  onEdit,
  onZoom,
  onShowFood,
  onTraceRecipe,
  onLink,
  onUnlink,
}: SourcePanelProps) {
  const [pickText, setPickText] = useState('');
  const [confirmUnlink, setConfirmUnlink] = useState<number | null>(null);

  const tx = txInfo(source);
  const geo = geoSourceInfo(source);
  const originKind = originOf(source);
  const origin = ECO_ORIGIN[originKind];
  const links = source.links || [];
  const linkedFoodIds = useMemo(
    () => new Set(links.map((l) => l.food_id).filter((id): id is number => typeof id === 'number')),
    [links],
  );

  // Recipes that use it: any recipe with a line whose food is linked here.
  const usedIn = useMemo(
    () => recipes.filter((r) => (r.ingredients || []).some((i) => i.food_id != null && linkedFoodIds.has(i.food_id))),
    [recipes, linkedFoodIds],
  );

  // The link picker: foods and their products matching what's typed, minus
  // what's already linked. Products are the stronger claim (this carton).
  const candidates = useMemo(() => {
    const q = pickText.trim().toLowerCase();
    if (!q) return [];
    const linkedProducts = new Set(links.map((l) => l.product_id).filter(Boolean));
    const out: { key: string; label: string; sub: string; target: { food?: number; product_id?: number } }[] = [];
    for (const f of foods) {
      const foodHit = f.name.toLowerCase().includes(q);
      if (foodHit && !links.some((l) => l.food_id === f.id && !l.product_id && !l.via_product)) {
        out.push({ key: `f${f.id}`, label: f.name, sub: 'the food, in general', target: { food: f.id } });
      }
      for (const p of f.products) {
        if ((foodHit || p.name.toLowerCase().includes(q)) && !linkedProducts.has(p.id)) {
          out.push({ key: `p${p.id}`, label: p.name, sub: `a product of ${f.name}${p.store ? ' · ' + p.store : ''}`, target: { product_id: p.id } });
        }
      }
      if (out.length > 30) break;
    }
    return out;
  }, [pickText, foods, links]);

  return (
    <div className={`${styles.card} ${styles.cardActive}`}>
      <div className={styles.header}>
        <span className={styles.dot} style={{ background: tx.color, width: 14, height: 14 }} />
        <div className={styles.title}>{source.name}</div>
        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close source">
          ×
        </button>
      </div>

      {source.note ? <div className={styles.note}>{source.note}</div> : null}
      <div className={styles.chips}>
        <span className={styles.chip}>
          <span className={styles.dot} style={{ background: tx.color }} />
          {tx.label}
        </span>
        {source.geo_source && source.geo_source !== 'unrated' ? (
          <span className={styles.chip} title={geo.blurb}>
            {geo.icon} {geo.label}
          </span>
        ) : null}
        <span className={styles.chip}>{metaLabel(source)}</span>
      </div>
      {source.geo_source === 'proxy' ? (
        <div className={styles.muted} style={{ marginTop: 6 }}>
          Where this is generally grown — not necessarily where this item came from.
        </div>
      ) : null}

      {/* Where the information came from: the origin record. */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Where this information came from</div>
        <div className={styles.origin}>
          <div className={styles.originHead}>
            {origin.icon} {origin.label}
            {source.origin_date ? <span className={styles.muted}> · looked up {source.origin_date}</span> : null}
          </div>
          {origins[originKind] ? <div className={styles.originMeaning}>{origins[originKind]}</div> : null}
          {source.origin_detail ? <div className={styles.originDetail}>{source.origin_detail}</div> : null}
          {source.origin_url ? (
            <a className={styles.originLink} href={source.origin_url} target="_blank" rel="noopener noreferrer">
              Check it at the source ↗
            </a>
          ) : null}
        </div>
      </div>

      {/* USDA's per-county figures, biggest first, when the outline came from there. */}
      {source.county_detail && source.county_detail.length ? (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Counties ({source.county_detail.length})</div>
          <table className={styles.table}>
            <tbody>
              {source.county_detail.map((c) => (
                <tr key={c.fips}>
                  <td>
                    {c.county ? `${c.county}${c.state ? ', ' + c.state : ''}` : `County ${c.fips}`}
                  </td>
                  <td>{countyFigure(c.value, c.unit) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {source.county_detail.every((c) => typeof c.value !== 'number') ? (
            <div className={styles.muted} style={{ marginTop: 4 }}>
              USDA's figures weren't saved for these (placed before origins were kept). Asking USDA again
              from Edit fills them in.
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The foods and products linked here — each a door to its page. */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Foods from here ({links.length})</div>
        {links.length ? (
          links.map((l) => (
            <div key={l.id} className={styles.row}>
              <div className={styles.rowMain}>
                {/* The food's page is the owner's; the public map names it only. */}
                {l.food_name && canEdit ? (
                  <a className={styles.rowName} href={foodPageHref(l.food_name)}>
                    {l.food_name}
                  </a>
                ) : l.food_name ? (
                  <span className={styles.rowName}>{l.food_name}</span>
                ) : (
                  <span className={styles.rowName}>(no food)</span>
                )}
                <div className={styles.rowSub}>
                  {l.product_name
                    ? `this product: ${l.product_name}${l.product_store ? ' · ' + l.product_store : ''}`
                    : l.via_product
                      ? 'one product of it'
                      : 'the food, in general'}
                </div>
              </div>
              {typeof l.food_id === 'number' ? (
                <button type="button" className={styles.btn} onClick={() => onShowFood(l.food_id as number)}>
                  Its sources
                </button>
              ) : null}
              {canEdit ? (
                confirmUnlink === l.id ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => {
                      onUnlink(l.id);
                      setConfirmUnlink(null);
                    }}
                  >
                    Unlink
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={`Unlink ${l.food_name || ''}`}
                    onClick={() => setConfirmUnlink(l.id)}
                  >
                    ×
                  </button>
                )
              ) : null}
            </div>
          ))
        ) : (
          <div className={styles.muted}>No food is linked to this source yet.</div>
        )}
        {canEdit ? (
          <div style={{ marginTop: 8 }}>
            <input
              type="text"
              className={styles.search}
              value={pickText}
              onChange={(e) => setPickText(e.target.value)}
              placeholder="Link a food or product… (type to search)"
            />
            {candidates.map((c) => (
              <div key={c.key} className={styles.row}>
                <div className={styles.rowMain}>
                  <div className={styles.rowName}>{c.label}</div>
                  <div className={styles.rowSub}>{c.sub}</div>
                </div>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnAccent}`}
                  onClick={() => {
                    onLink(source.id, c.target);
                    setPickText('');
                  }}
                >
                  ＋ Link
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {usedIn.length ? (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Recipes that use it</div>
          {usedIn.map((r) => (
            <div key={r.id} className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowName}>{r.name}</div>
              </div>
              <button type="button" className={styles.btn} onClick={() => onTraceRecipe(r.id)}>
                Trace
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className={styles.actions}>
        <button type="button" className={`${styles.btn} ${styles.btnAccent}`} onClick={() => onZoom(source.id)}>
          Zoom to it
        </button>
        {canEdit ? (
          <button type="button" className={styles.btn} onClick={() => onEdit(source.id)}>
            Edit
          </button>
        ) : null}
      </div>
    </div>
  );
}
