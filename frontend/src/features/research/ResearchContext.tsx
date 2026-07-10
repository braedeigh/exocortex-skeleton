/**
 * ResearchContext.tsx — one context for the whole research workspace, playing
 * the role of the old module-global state + window-global handler functions
 * in static/js/research.js. ResearchPage builds the value; every card/row
 * consumes it instead of drilling a dozen callbacks.
 */

import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';
import type { ResearchMutations } from './useResearchData';
import type { ComposerState, EdgeFile, Entry, LibraryFile, ResearchState, Topic } from './types';

export type PushToast = (
  message: string,
  opts?: { tone?: 'error' | 'info'; actionLabel?: string; onAction?: () => void; duration?: number },
) => void;

export interface ResearchCtxValue {
  state: ResearchState;
  byId: Record<string, Topic>;
  docTexts: Set<string>;
  /** research/*.md corpus, newest first (Library card) */
  library: LibraryFile[];
  /** distiller edge/<topic-id>.md notes, pinned per thread */
  edge: EdgeFile[];
  /** entry ids with a full-text fetch in flight ("⌛ fetching…") */
  fetchingText: Set<string>;
  /** entry ids with a metadata pull in flight ("✨ fetching…") */
  annotatingMeta: Set<string>;

  composer: ComposerState;
  setComposer: Dispatch<SetStateAction<ComposerState>>;

  /** two-step delete: first call arms the key (returns false), second within
   * 3s fires (returns true) */
  requestConfirm: (key: string) => boolean;
  confirmKey: string | null;

  mutations: ResearchMutations;
  push: PushToast;

  actions: {
    // composer flows
    addEntry: (extraTopicId?: string) => void;
    addAndResearch: (extraTopicId?: string) => void;
    startAnswer: (id: string) => void;
    cancelAnswer: () => void;
    clearReQuote: () => void;
    toggleContext: (id: string) => void;
    /** annotator "follow up": aim the composer at the owning entry with the
     * highlighted exact text + reply-chain context */
    startFollowUp: (noteId: string, exact: string) => void;
    focusComposer: () => void;
    // entries
    deleteEntry: (e: Entry) => void;
    deepResearch: (id: string) => void;
    fetchText: (id: string) => void;
    annotateSourceMeta: (id: string) => void;
    // topics
    deleteTopic: (t: Topic) => void;
    fileUnfiled: () => void;
    // overlays / nav
    openThread: (id: string) => void;
    openLibraryFile: (path: string) => void;
    openAnnotator: (doc: string, title: string) => void;
  };
}

const Ctx = createContext<ResearchCtxValue | null>(null);

export const ResearchProvider = Ctx.Provider;

export function useResearchCtx(): ResearchCtxValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useResearchCtx outside ResearchProvider');
  return value;
}
