/**
 * deityHelpers.ts — pure logic for deity profiles, ported from
 * static/js/meditation.js (_deityParseName / _deityParseMantra / _deityName
 * and the list's sort).
 */

import type { DeityProfile } from './types';

/** Display name comes from the first `# H1` line of the pasted markdown. */
export function parseDeityName(body: string | null | undefined): string {
  const lines = String(body || '').split('\n');
  for (const l of lines) {
    const m = l.match(/^#\s+(.*\S)\s*$/);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * Short mantra preview for the list: the first non-empty line after a
 * "Romanized text" label (bold markers ignored), else nothing.
 */
export function parseDeityMantra(body: string | null | undefined): string {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/romanized\s*text/i.test(lines[i].replace(/\*/g, ''))) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) return lines[j].trim();
      }
    }
  }
  return '';
}

export function deityDisplayName(p: DeityProfile): string {
  return p.name || parseDeityName(p.body) || 'Untitled';
}

/** List order: alphabetical by display name. */
export function sortProfiles(profiles: DeityProfile[]): DeityProfile[] {
  return profiles.slice().sort((a, b) => deityDisplayName(a).localeCompare(deityDisplayName(b)));
}
