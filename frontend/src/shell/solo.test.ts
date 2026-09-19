import { describe, expect, it } from 'vitest';
import { isSoloSearch, soloCodeHref } from './solo';

describe('isSoloSearch', () => {
  it('accepts the URL as written and as the router rewrites it', () => {
    expect(isSoloSearch('?solo=1')).toBe(true);
    expect(isSoloSearch('?solo=true')).toBe(true);
    expect(isSoloSearch('?repo=skeleton&path=server.py&solo=1')).toBe(true);
  });
  it('is off otherwise', () => {
    expect(isSoloSearch('')).toBe(false);
    expect(isSoloSearch('?solo=0')).toBe(false);
    expect(isSoloSearch('?solo=')).toBe(false);
    expect(isSoloSearch('?repo=skeleton&path=server.py')).toBe(false);
  });
});

describe('soloCodeHref', () => {
  it('builds a /code address that reads back as solo', () => {
    const href = soloCodeHref('skeleton', 'routes/spa.py');
    expect(href.startsWith('/code?')).toBe(true);
    expect(isSoloSearch(href.slice(href.indexOf('?')))).toBe(true);
  });
  it('keeps a path with spaces and slashes intact', () => {
    const href = soloCodeHref('vault', 'docs/my notes/a&b.md');
    const search = new URLSearchParams(href.slice(href.indexOf('?')));
    expect(search.get('path')).toBe('docs/my notes/a&b.md');
    expect(search.get('repo')).toBe('vault');
  });
});
