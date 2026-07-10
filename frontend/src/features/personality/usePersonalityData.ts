import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPersonalityDoc, savePersonalityDoc, type PersonalityDocResponse } from './api';
import { parsePersonalitySections, replaceSectionBlock } from './personalityDoc';

export const PERSONALITY_DOC_KEY = ['personalityDoc'] as const;

/**
 * The whole doc. The legacy page fetched exactly once on load and then owned
 * the doc locally (its saves were the only writer) — mirror that: no polling
 * and no focus refetch, so the cached doc can never shift underneath an open
 * editor with unsaved keystrokes. Our own saves update the cache directly.
 */
export function usePersonalityDoc(enabled = true) {
  return useQuery({
    queryKey: PERSONALITY_DOC_KEY,
    queryFn: ({ signal }) => getPersonalityDoc(signal),
    refetchOnWindowFocus: false,
    enabled,
  });
}

/**
 * Save one section's edited block: splice it into the *current* cached doc at
 * the section's line range (sections are re-parsed here so consecutive
 * debounced saves always splice against the latest doc, exactly like the
 * legacy doSave reparsing after every save), POST the whole doc, then write
 * the new doc into the cache — no refetch, no flicker. Throws on failure so
 * the caller can show "Save error".
 */
export function useSaveSection() {
  const queryClient = useQueryClient();
  return useCallback(
    async (sectionIdx: number, newBlock: string) => {
      const doc = queryClient.getQueryData<PersonalityDocResponse>(PERSONALITY_DOC_KEY)?.content ?? '';
      const section = parsePersonalitySections(doc)[sectionIdx];
      if (!section) throw new Error('Section not found');
      const newMd = replaceSectionBlock(doc, section, newBlock);
      await savePersonalityDoc(newMd);
      queryClient.setQueryData<PersonalityDocResponse>(PERSONALITY_DOC_KEY, { content: newMd });
    },
    [queryClient],
  );
}
