import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MATCH_THRESHOLD } from './sanctions.js';
import { jaroWinkler, nameSimilarity, normaliseName } from './name-match.js';

const similar = (a: string, b: string) => nameSimilarity(normaliseName(a), normaliseName(b));

describe('name matching', () => {
  it('ignores case, accents, punctuation, order and connectives', () => {
    expect(normaliseName("José-María  O'Neil")).toBe('JOSE MARIA O NEIL');
    expect(similar('BADEGE, Eric', 'eric badege')).toBe(1);
    expect(similar('Mohammed bin Salem', 'Salem Mohammed')).toBe(1);
    expect(similar('Acme Trading LLC', 'ACME TRADING')).toBe(1);
  });

  it('catches common transliteration and spelling differences', () => {
    expect(similar('Muhammad Hassan', 'Mohammed Hassan')).toBeGreaterThan(MATCH_THRESHOLD);
    expect(similar('Erik Badege', 'Eric Badege')).toBeGreaterThan(MATCH_THRESHOLD);
    expect(similar('Yusuf Khan', 'Yousuf Khan')).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it('does not match unrelated names', () => {
    expect(similar('John Smith', 'Eric Badege')).toBeLessThan(MATCH_THRESHOLD);
    expect(similar('Fatima Ali', 'Fatima Noor')).toBeLessThan(MATCH_THRESHOLD);
  });

  it('treats one shared word against a full name as weak evidence', () => {
    expect(similar('Khan', 'Yousuf Ahmed Khan')).toBeLessThan(MATCH_THRESHOLD);
  });

  it('matches a partial name when several words agree', () => {
    expect(similar('Yousuf Khan', 'Yousuf Ahmed Khan')).toBe(1);
  });

  it('keeps a name made up only of connectives', () => {
    expect(normaliseName('Al Bin')).toBe('AL BIN');
  });

  it('is symmetric and bounded', () => {
    const word = fc.stringMatching(/^[A-Z]{1,12}$/);
    fc.assert(
      fc.property(word, word, (a, b) => {
        const score = jaroWinkler(a, b);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }),
    );
    const name = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(' '));
    fc.assert(
      fc.property(name, (n) => {
        expect(nameSimilarity(n, n)).toBe(1);
      }),
    );
  });
});
