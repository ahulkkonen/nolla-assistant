import { describe, expect, it } from 'vitest';
import { HttpError } from './api.ts';
import { fileError, formatBytes, jobQueue } from './files.ts';

describe('files helpers', () => {
  it('formats sizes in binary steps with a decimal comma', () => {
    expect(formatBytes(512)).toBe('512 t');
    expect(formatBytes(12.4 * 1024 ** 2)).toBe('12,4 Mt');
    expect(formatBytes(10 * 1024 ** 3)).toBe('10 Gt');
  });

  it('maps route errors, a bare 413 and no answer at all', () => {
    expect(fileError(new HttpError(409, 'exists'))).toBe('Nimi on jo käytössä.');
    expect(fileError(new HttpError(413))).toBe('Tiedosto on yli 200 Mt.');
    expect(fileError(new HttpError(413), { too_large: 'Liite on yli 25 Mt.' })).toBe(
      'Liite on yli 25 Mt.',
    );
    expect(fileError(new HttpError(0))).toBe('Ei yhteyttä. Yritä uudelleen.');
    expect(fileError(new Error('x'))).toBe('Toiminto epäonnistui.');
  });

  it('runs at most `limit` jobs at once, in order, and reports idle once', async () => {
    const release: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    let idle = 0;
    const q = jobQueue(
      3,
      (n: number) =>
        new Promise<void>((resolve) => {
          order.push(n);
          peak = Math.max(peak, ++running);
          release.push(() => {
            running--;
            resolve();
          });
        }),
      () => idle++,
    );
    q.add([1, 2, 3, 4, 5, 6]);
    q.remove((n) => n === 6);
    expect(order).toEqual([1, 2, 3]);
    while (release.length) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(3);
    expect(idle).toBe(1);
  });
});
