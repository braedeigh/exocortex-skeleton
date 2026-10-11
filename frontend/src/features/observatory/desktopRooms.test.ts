/**
 * desktopRooms.test.ts — the desktop app's editable rooms, as the lane
 * helpers in api.ts see them.
 *
 * In the desktop app a person adds, renames and deletes rooms, so the
 * helpers every page uses to place and name a session have to follow the
 * server's list. These tests walk that list through the changes a person
 * makes, and check the normal site still has its fixed rooms.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRoom, laneBlurb, laneLabel, offeredRooms, setDesktopRooms, strayRoom, toLane } from './api';

/** Run as the desktop app: the flag the desktop server writes into the page. */
function asDesktop() {
  vi.stubGlobal('window', { STANDALONE: true });
}

afterEach(() => {
  setDesktopRooms(null);
  vi.unstubAllGlobals();
});

describe('rooms in the desktop app', () => {
  it('starts with Personal and Code before the server has answered', () => {
    asDesktop();
    expect(offeredRooms()).toEqual([
      { id: 'personal', name: 'Personal' },
      { id: 'coding', name: 'Code' },
    ]);
  });

  it('follows the list through an add, a rename and a delete', () => {
    asDesktop();
    // Added: a room whose id the page has never heard of keeps its sessions.
    setDesktopRooms([
      { id: 'personal', name: 'Personal' },
      { id: 'coding', name: 'Code' },
      { id: 'room-3', name: 'Experiments' },
    ]);
    expect(toLane('room-3')).toBe('room-3');
    expect(isRoom(toLane('room-3'))).toBe(true);
    expect(laneLabel(toLane('room-3'))).toBe('Experiments');

    // Renamed: the new name is what every surface shows.
    setDesktopRooms([
      { id: 'personal', name: 'Home' },
      { id: 'coding', name: 'Code' },
      { id: 'room-3', name: 'Experiments' },
    ]);
    expect(laneLabel('personal')).toBe('Home');

    // Deleted: the first room is gone, so a session still carrying its lane
    // has no room and is shown in the first room left instead of vanishing.
    setDesktopRooms([
      { id: 'coding', name: 'Code' },
      { id: 'room-3', name: 'Experiments' },
    ]);
    expect(isRoom('personal')).toBe(false);
    expect(strayRoom()).toBe('coding');
    expect(offeredRooms().map((room) => room.name)).toEqual(['Code', 'Experiments']);
  });

  it('says where a room works without the owner\'s own wording', () => {
    asDesktop();
    for (const lane of ['personal', 'coding'] as const) {
      expect(laneBlurb(lane)).not.toMatch(/vault|both repos|you’re the one watching/);
      expect(laneBlurb(lane).length).toBeGreaterThan(0);
    }
  });
});

describe('rooms on the normal site', () => {
  it('stay the fixed two, whatever a desktop list says', () => {
    setDesktopRooms([{ id: 'room-3', name: 'Experiments' }]);
    expect(offeredRooms()).toEqual([
      { id: 'personal', name: 'Personal' },
      { id: 'coding', name: 'Coding' },
    ]);
    expect(toLane('room-3')).toBe('orchestra');
    expect(strayRoom()).toBe('coding');
    expect(laneLabel('orchestra')).toBe('Orchestra');
  });
});
