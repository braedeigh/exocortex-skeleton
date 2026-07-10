import { describe, expect, it } from 'vitest';
import {
  SPECIAL_KEYS,
  autosizeHeight,
  swipeToScroll,
  terminalSrc,
  uploadedPathsMessage,
  uploadingLabel,
} from './phoneLogic';

describe('swipeToScroll', () => {
  it('ignores drags under the 50px threshold', () => {
    expect(swipeToScroll(0)).toBeNull();
    expect(swipeToScroll(49)).toBeNull();
    expect(swipeToScroll(-49)).toBeNull();
  });

  it('turns a downward drag into an upward scroll (pulling history down)', () => {
    expect(swipeToScroll(50)).toEqual({ direction: 'up', lines: 3 });
  });

  it('turns an upward drag into a downward scroll', () => {
    expect(swipeToScroll(-80)).toEqual({ direction: 'down', lines: 5 });
  });

  it('floors at 1 line per 15px of drag', () => {
    expect(swipeToScroll(74)).toEqual({ direction: 'up', lines: 4 });
  });

  it('clamps long swipes at 30 lines', () => {
    expect(swipeToScroll(1000)).toEqual({ direction: 'up', lines: 30 });
    expect(swipeToScroll(-1000)).toEqual({ direction: 'down', lines: 30 });
  });
});

describe('SPECIAL_KEYS', () => {
  it('sends the exact tmux key names phone.html sent', () => {
    expect(SPECIAL_KEYS.map((k) => k.key)).toEqual(['Enter', 'Escape', 'C-c', 'C-o', 'Up', 'Down']);
  });

  it('keeps the toolbar labels', () => {
    expect(SPECIAL_KEYS.map((k) => k.label)).toEqual(['ret', 'esc', '^C', '^O', '▲', '▼']);
  });
});

describe('autosizeHeight', () => {
  it('tracks content height below the cap', () => {
    expect(autosizeHeight(64)).toBe(64);
  });

  it('caps at 100px like phone.html', () => {
    expect(autosizeHeight(240)).toBe(100);
  });
});

describe('uploadingLabel', () => {
  it('is singular for one photo', () => {
    expect(uploadingLabel(1)).toBe('Uploading photo…');
  });

  it('counts multiple photos', () => {
    expect(uploadingLabel(3)).toBe('Uploading 3 photos…');
  });
});

describe('uploadedPathsMessage', () => {
  it('wraps a single path in an [uploaded: …] ref', () => {
    expect(uploadedPathsMessage(['/tmp/a.jpg'])).toBe('[uploaded: /tmp/a.jpg]');
  });

  it('newline-joins multiple refs', () => {
    expect(uploadedPathsMessage(['/tmp/a.jpg', '/tmp/b.jpg'])).toBe(
      '[uploaded: /tmp/a.jpg]\n[uploaded: /tmp/b.jpg]',
    );
  });
});

describe('terminalSrc', () => {
  it('points at ttyd with the session as arg', () => {
    expect(terminalSrc('chat')).toBe('/terminal/?arg=chat');
  });

  it('URL-encodes the session name', () => {
    expect(terminalSrc('a b')).toBe('/terminal/?arg=a%20b');
  });
});
