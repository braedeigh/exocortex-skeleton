import { describe, expect, it } from 'vitest';
import { splitPhotos } from './photoRefs';

describe('splitPhotos', () => {
  it('takes a lone photo marker out of the text', () => {
    expect(splitPhotos('[uploaded: /opt/x/data/uploads/20260918_204338_677011_IMG_3467.png]')).toEqual({
      text: '',
      photos: [{ name: '20260918_204338_677011_IMG_3467.png', caption: '' }],
    });
  });

  it('keeps the words around a photo', () => {
    expect(splitPhotos('look at this\n\n[uploaded: /u/20260101_a.jpeg]\n\nso pretty')).toEqual({
      text: 'look at this\n\nso pretty',
      photos: [{ name: '20260101_a.jpeg', caption: '' }],
    });
  });

  it('carries the keeper description along as a caption', () => {
    expect(splitPhotos('[uploaded: /u/20260711_IMG_2437.jpeg — mirror selfie in an antique shop]').photos).toEqual([
      { name: '20260711_IMG_2437.jpeg', caption: 'mirror selfie in an antique shop' },
    ]);
  });

  it('finds several photos in order', () => {
    const { photos } = splitPhotos('[uploaded: /u/a.png] and [uploaded: /u/b.JPG]');
    expect(photos.map((p) => p.name)).toEqual(['a.png', 'b.JPG']);
  });

  it('leaves uploads that are not photos in the text', () => {
    const body = '[uploaded: /u/20260707_225634_paste.txt — her own writing:]';
    expect(splitPhotos(body)).toEqual({ text: body, photos: [] });
  });

  it('leaves a body with no photos exactly as it was', () => {
    expect(splitPhotos('  just words  ').text).toBe('  just words  ');
  });
});
