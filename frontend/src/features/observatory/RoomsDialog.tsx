/**
 * RoomsDialog — the desktop app's room editor: rename, delete, add.
 *
 * Opened from the "Edit rooms" button under the rooms on the roster
 * (RosterPage.tsx), in the desktop app only. One row per room: its name in a
 * box with a Save button that appears once the name is changed, and a Delete
 * button. Under the rows, a box to add a room.
 *
 * Deleting asks first, and says where the room's sessions go (the server
 * moves them to the first room left). The last room can't be deleted; the
 * server refuses and its sentence is shown.
 *
 * Touches: roomsApi.ts (the calls), RosterPage.module.css (the sheet's
 * shared styles), RoomsDialog.module.css (its rows).
 *
 * Her ask: "2 rooms, personal and code, with the option to add more or
 * delete or rename."
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../../ui';
import type { RoomInfo } from './api';
import { useRoomActions, useRooms } from './roomsApi';
import sheetStyles from './RosterPage.module.css';
import styles from './RoomsDialog.module.css';

const NAME_MAX = 40;

export function RoomsDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after any change, so the roster can re-read its sessions (a
   * deleted room's sessions have moved). */
  onChanged: () => void;
}) {
  const rooms = useRooms();
  const { addRoom, renameRoom, deleteRoom } = useRoomActions();
  // Names being typed, by room id. A room not in here shows its saved name.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');

  // Start clean each time the sheet opens: no half-typed names from last time.
  useEffect(() => {
    if (open) {
      setDrafts({});
      setNewName('');
      setProblem('');
    }
  }, [open]);

  // Send one change, show the server's sentence if it refuses. One at a
  // time, so two answers can't land out of order.
  const send = (change: Promise<unknown>, after?: () => void) => {
    setSending(true);
    setProblem('');
    change
      .then(() => {
        after?.();
        onChanged();
      })
      .catch((error: unknown) => {
        setProblem(error instanceof Error && error.message ? error.message : 'That didn’t go through.');
      })
      .finally(() => setSending(false));
  };

  const clearDraft = (id: string) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });

  const rename = (room: RoomInfo) => {
    const name = (drafts[room.id] ?? '').trim();
    if (!name || name === room.name) return clearDraft(room.id);
    send(renameRoom(room.id, name), () => clearDraft(room.id));
  };

  // Destructive, so it confirms first and says what happens to the sessions.
  const remove = (room: RoomInfo) => {
    const destination = rooms.find((other) => other.id !== room.id);
    const question = destination
      ? `Delete the room “${room.name}”? Its sessions move to “${destination.name}”.`
      : `Delete the room “${room.name}”?`;
    if (!window.confirm(question)) return;
    send(deleteRoom(room.id));
  };

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    send(addRoom(name), () => setNewName(''));
  };

  return (
    <Sheet open={open} title="Rooms" onClose={onClose}>
      <div className={sheetStyles.dialogBody}>
        <p className={styles.lead}>
          A room is a heading that groups sessions. Rename them, add your own, or delete the ones you don&rsquo;t use.
        </p>
        <ul className={styles.rows}>
          {rooms.map((room) => {
            const draft = drafts[room.id];
            const changed = draft !== undefined && draft.trim() !== '' && draft.trim() !== room.name;
            return (
              <li key={room.id} className={styles.row}>
                <input
                  type="text"
                  className={sheetStyles.dialogInput}
                  aria-label={`Name of the room ${room.name}`}
                  maxLength={NAME_MAX}
                  value={draft ?? room.name}
                  onChange={(event) => setDrafts((current) => ({ ...current, [room.id]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') rename(room);
                  }}
                />
                {changed ? (
                  <button type="button" className={styles.rowBtn} onClick={() => rename(room)} disabled={sending}>
                    Save
                  </button>
                ) : null}
                <button
                  type="button"
                  className={[styles.rowBtn, styles.deleteBtn].join(' ')}
                  onClick={() => remove(room)}
                  disabled={sending || rooms.length <= 1}
                  title={rooms.length <= 1 ? 'The last room can’t be deleted' : undefined}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>

        <div className={styles.row}>
          <input
            type="text"
            className={sheetStyles.dialogInput}
            placeholder="New room name"
            aria-label="New room name"
            maxLength={NAME_MAX}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add();
            }}
          />
          <button type="button" className={styles.rowBtn} onClick={add} disabled={sending || !newName.trim()}>
            Add room
          </button>
        </div>

        {problem ? (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
