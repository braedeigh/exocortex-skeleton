/**
 * ShareRecipe.tsx — the Share button on one of her recipes, and what it opens:
 * the link to hand out, a Copy button, how many times it's been opened, and
 * Stop sharing (which asks first, then kills every link to the recipe).
 *
 * The link opens SharedRecipePage (/share/r/<token>): the recipe and what a
 * serving gives against the *reader's* targets, with nothing else of hers.
 * The calls are in ./shareApi.ts; the rules on what's shown are in
 * recipe_shares.py. Mounted by RecipeDetailView.tsx for her own view only.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyShares, MY_SHARES_KEY, shareRecipe, shareUrl, unshareRecipe } from './shareApi';
import styles from './kitchen.module.css';

export function ShareRecipe({ recipeId }: { recipeId: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { data: shares } = useQuery({ queryKey: MY_SHARES_KEY, queryFn: ({ signal }) => getMyShares(signal) });
  const mine = shares?.[recipeId];
  const refresh = () => client.invalidateQueries({ queryKey: MY_SHARES_KEY });
  const share = useMutation({ mutationFn: () => shareRecipe(recipeId), onSuccess: refresh });
  const unshare = useMutation({
    mutationFn: () => unshareRecipe(recipeId),
    onSuccess: () => {
      setOpen(false);
      refresh();
    },
  });

  // Copy the link, falling back to selecting it when the clipboard is refused.
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link:', url);
    }
  };

  const openPanel = () => {
    setOpen((was) => !was);
    if (!mine && !share.isPending) share.mutate();
  };

  return (
    <>
      <button type="button" className={styles.mutedBtn} style={{ minHeight: 40 }} onClick={openPanel}>
        {mine ? 'Shared' : 'Share'}
      </button>
      {open ? (
        <div className={styles.card} style={{ flexBasis: '100%', margin: '8px 0 0', padding: '12px 14px' }}>
          {mine ? (
            <>
              <div style={{ fontSize: 14, marginBottom: 6 }}>
                Anyone with this link can see the recipe and what a serving gives against their own targets —
                nothing else of yours.
              </div>
              <div style={{ fontSize: 14, wordBreak: 'break-all', margin: '0 0 8px' }}>
                <a href={shareUrl(mine.token)} target="_blank" rel="noreferrer">
                  {shareUrl(mine.token)}
                </a>
              </div>
              <div className={styles.rowFlex}>
                <button type="button" className={styles.greenBtn} style={{ minHeight: 40 }} onClick={() => copy(shareUrl(mine.token))}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <button
                  type="button"
                  className={styles.mutedBtn}
                  style={{ minHeight: 40 }}
                  disabled={unshare.isPending}
                  onClick={() => {
                    if (window.confirm('Stop sharing this recipe? The link will stop working for everyone who has it.')) {
                      unshare.mutate();
                    }
                  }}
                >
                  Stop sharing
                </button>
                <span className={styles.muted12}>
                  Opened {mine.views} {mine.views === 1 ? 'time' : 'times'}. Listed with the other shared recipes at{' '}
                  <a href="/share/recipes" target="_blank" rel="noreferrer">/share/recipes</a>.
                </span>
              </div>
              <div className={styles.muted12} style={{ marginTop: 6 }}>
                For now the link only opens on your tailnet; people outside it need the public website.
              </div>
            </>
          ) : share.isError ? (
            <div className={styles.muted12}>Couldn't share it: {String(share.error)}</div>
          ) : (
            <div className={styles.muted12}>Making the link…</div>
          )}
        </div>
      ) : null}
    </>
  );
}
