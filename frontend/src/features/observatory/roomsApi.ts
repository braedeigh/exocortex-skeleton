/**
 * roomsApi.ts — the desktop app's rooms: fetching the list and changing it.
 *
 * In the desktop app (shell/standalone.ts) the rooms on the Observatory are a
 * list the person edits: add one, rename one, delete one. The list lives on
 * the desktop server (standalone_app.py, /api/standalone/rooms). This file
 * fetches it, sends the three changes, and after each answer copies the list
 * into api.ts (setDesktopRooms) so every lane helper there reads the same
 * rooms.
 *
 * On the normal site none of this runs: the rooms are fixed and the query is
 * switched off.
 *
 * Touches: api.ts (the copy of the list), RoomsDialog.tsx (the editor),
 * RosterPage.tsx, SessionDialog.tsx, ArchivePage.tsx and
 * terrain/TerrainAgentBar.tsx (they call useRooms so they redraw when the
 * list changes).
 *
 * Her ask: "2 rooms, personal and code, with the option to add more or
 * delete or rename."
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { isStandalone } from '../../shell/standalone';
import { offeredRooms, setDesktopRooms, type RoomInfo } from './api';

const ROOMS_KEY = ['standalone-rooms'] as const;

/** What every rooms route answers: the whole list, in display order. */
interface RoomsAnswer {
  rooms: { id: string; name: string }[];
}

/** Copy a server answer into api.ts before anything redraws from it. */
function accept(answer: RoomsAnswer): RoomsAnswer {
  setDesktopRooms(Array.isArray(answer?.rooms) ? answer.rooms : null);
  return answer;
}

/**
 * The rooms to draw, kept fresh in the desktop app.
 *
 * Returns api.ts's offeredRooms() — the fixed rooms on the site, the
 * person's list in the desktop app — and re-renders the caller whenever the
 * desktop list is fetched or changed.
 */
export function useRooms(): RoomInfo[] {
  useQuery({
    queryKey: ROOMS_KEY,
    queryFn: ({ signal }) => api.get<RoomsAnswer>('/api/standalone/rooms', signal).then(accept),
    enabled: isStandalone(),
    staleTime: 60_000,
  });
  return offeredRooms();
}

/** The three changes a person can make to the room list. Each answers with
 * the whole new list; a refusal (deleting the last room) rejects with the
 * server's own sentence as the error's message. */
export function useRoomActions() {
  const queryClient = useQueryClient();
  const store = (answer: RoomsAnswer) => {
    queryClient.setQueryData(ROOMS_KEY, accept(answer));
    return answer;
  };
  return {
    addRoom: (name: string) => api.post<RoomsAnswer>('/api/standalone/rooms', { name }).then(store),
    renameRoom: (id: string, name: string) =>
      api.post<RoomsAnswer>(`/api/standalone/rooms/${encodeURIComponent(id)}`, { name }).then(store),
    /** The room's sessions move to the first room left. */
    deleteRoom: (id: string) =>
      api.delete<RoomsAnswer>(`/api/standalone/rooms/${encodeURIComponent(id)}`).then(store),
  };
}
