import { describe, expect, it } from 'vitest';
import { SECTIONS, convIdOf, pageLabel, sectionById, sectionForUrl } from './sections';

describe('which section a page belongs to', () => {
  it('puts the roster and every conversation under Observatory', () => {
    expect(sectionForUrl('/observatory')?.id).toBe('observatory');
    expect(sectionForUrl('/observatory/session?conv=abc')?.id).toBe('observatory');
    expect(sectionForUrl('/observatory/archive')?.id).toBe('observatory');
  });

  it('gives Pond to Pond even though Terrain also claims /terrain', () => {
    // Longest claim wins — first-match would make the Pond tab unreachable.
    expect(sectionForUrl('/terrain/pond')?.id).toBe('pond');
    expect(sectionForUrl('/terrain/map')?.id).toBe('terrain');
    expect(sectionForUrl('/terrain/usage')?.id).toBe('terrain');
  });

  it('treats every dashboard route as the one Dashboard section', () => {
    expect(sectionForUrl('/todos')?.id).toBe('dashboard');
    expect(sectionForUrl('/money')?.id).toBe('dashboard');
    expect(sectionForUrl('/travel')?.id).toBe('dashboard');
  });

  it('gives /ecosystem to Ecosystem even though Dashboard claims the same path', () => {
    // Equal-length claims tie, and the first listed wins — so Ecosystem must
    // stay above Dashboard in SECTIONS or its tab could never light up.
    expect(sectionForUrl('/ecosystem')?.id).toBe('ecosystem');
    expect(sectionForUrl('/ecosystem?recipe=abc')?.id).toBe('ecosystem');
    expect(pageLabel('/ecosystem')).toBe('Ecosystem');
  });

  it('gives /kitchen to Kitchen even though Dashboard claims the same path', () => {
    expect(sectionForUrl('/kitchen')?.id).toBe('kitchen');
    expect(pageLabel('/kitchen')).toBe('Kitchen');
  });

  it('is not fooled by a path that merely starts the same way', () => {
    expect(sectionForUrl('/codex')).toBeNull();
    expect(sectionForUrl('/journalling')).toBeNull();
  });

  it('ignores the query string and a trailing slash', () => {
    expect(sectionForUrl('/code?repo=skeleton&path=a.py')?.id).toBe('code');
    expect(sectionForUrl('/journal/')?.id).toBe('journal');
  });

  it('returns nothing for a page no section claims', () => {
    expect(sectionForUrl('/')).toBeNull();
  });
});

describe('shortcut sections', () => {
  it('the Keeper is pinnable but never lights up — it lives inside the Observatory', () => {
    const keeper = sectionById('keeper');
    expect(keeper?.claims).toEqual([]);
    // Reading the Keeper conversation, the tab that is active is Observatory.
    expect(sectionForUrl(keeper!.home)?.id).toBe('observatory');
  });

  it('every section has a front page that resolves back to itself or its parent', () => {
    for (const s of SECTIONS) {
      const landed = sectionForUrl(s.home);
      if (s.claims.length === 0) continue; // shortcuts belong to someone else
      expect(landed?.id, `${s.id} home should belong to ${s.id}`).toBe(s.id);
    }
  });
});

describe('what the active tab is called', () => {
  it('wears the section name on its own front page', () => {
    expect(pageLabel('/observatory')).toBe('Observatory');
    expect(pageLabel('/terrain/map')).toBe('Terrain');
    expect(pageLabel('/todos')).toBe('Dashboard');
  });

  it('wears the filename in the code reader', () => {
    expect(pageLabel('/code?repo=skeleton&path=routes/observatory.py')).toBe('observatory.py');
    expect(pageLabel('/code')).toBe('Code');
  });

  it('wears the room name in a section with rooms', () => {
    expect(pageLabel('/terrain/usage')).toBe('Usage');
    expect(pageLabel('/observatory/archive')).toBe('Archive');
  });

  it('falls back to the section for a page it cannot name', () => {
    // A conversation — the URL carries an opaque id, so the roster fills this
    // in later and this is what shows until it does.
    expect(pageLabel('/observatory/session?conv=abc123')).toBe('Session');
  });
});

describe('spotting a conversation', () => {
  it('finds the conversation id so its real title can be swapped in', () => {
    expect(convIdOf('/observatory/session?conv=abc123')).toBe('abc123');
  });

  it('has no id to offer for the roster, or for the unresolved sentinel', () => {
    expect(convIdOf('/observatory')).toBeNull();
    expect(convIdOf('/observatory/session?conv=latest')).toBeNull();
    expect(convIdOf('/journal')).toBeNull();
  });
});
