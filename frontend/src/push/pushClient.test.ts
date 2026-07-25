import { describe, expect, it } from 'vitest';
import { urlBase64ToUint8Array } from './pushClient';

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key into the matching bytes', () => {
    // 'hello' base64-encoded, then converted to the base64url alphabet
    // (this string happens not to need +/ or padding substitution, so add a
    // case that does below).
    const bytes = urlBase64ToUint8Array('aGVsbG8=');
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]); // 'hello'
  });

  it('handles base64url characters (-/_) and missing padding', () => {
    // byte sequence [251, 239, 190] -> base64 '++++Puw==' style output; use
    // a value whose standard-base64 form contains '+' and '/' so the
    // url-safe '-'/'_' substitution is actually exercised.
    const standard = btoa(String.fromCharCode(0xfb, 0xff, 0xbf));
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(urlSafe).not.toBe(standard); // sanity: this fixture exercises -/_

    const bytes = urlBase64ToUint8Array(urlSafe);
    expect(Array.from(bytes)).toEqual([0xfb, 0xff, 0xbf]);
  });
});
