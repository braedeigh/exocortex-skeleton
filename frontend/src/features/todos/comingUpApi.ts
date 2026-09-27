/**
 * comingUpApi.ts — the To-dos page's line to Coming up (routes/coming_up.py):
 * dated events and topics the Keeper wakes with, and the reminders it gets
 * sent at their set time. Items she makes here are hers (`manual`) and skip
 * approval; a Keeper's arrive through the approval pop-over instead.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';

export interface ComingUpItem {
  id: string;
  kind: 'event' | 'topic';
  title: string;
  note: string;
  /** YYYY-MM-DD — the first day. */
  date: string;
  /** HH:MM, when it happens — '' for all day. */
  time: string;
  /** YYYY-MM-DD for a multi-day event, else ''. */
  end_date: string;
  /** 'YYYY-MM-DD HH:MM' — when the System reminder goes into the Keeper's
   * chat. '' = no ping; it only shows in the morning's list. */
  remind_at: string;
  lead_days: number;
  created_by: 'manual' | 'keeper';
  status: 'pending' | 'fired' | 'missed' | 'dismissed';
  fired_at: string | null;
  /** list only: inside its lead window right now. */
  near?: boolean;
  /** near list only: 'today' / 'tomorrow' / 'in 3 days' / 'on now, …'. */
  when?: string;
}

export interface ComingUpList {
  today: string;
  near: ComingUpItem[];
  items: ComingUpItem[];
}

/** What the form sends — the item minus everything the server decides. */
export type ComingUpDraft = Pick<
  ComingUpItem,
  'kind' | 'title' | 'note' | 'date' | 'time' | 'end_date' | 'remind_at' | 'lead_days'
>;

const KEY = ['coming-up'] as const;

export function useComingUp() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ComingUpList>('/api/coming_up'),
    staleTime: 60_000,
  });
}

/** Add, edit and dismiss — each refreshes the list when it lands. */
export function useComingUpActions() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const add = useMutation({
    mutationFn: (draft: ComingUpDraft) => api.post('/api/coming_up', draft),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: ComingUpDraft }) =>
      api.post(`/api/coming_up/${encodeURIComponent(id)}`, draft),
    onSuccess: refresh,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/api/coming_up/${encodeURIComponent(id)}/dismiss`),
    onSuccess: refresh,
  });
  return { add, edit, dismiss };
}
