import { describe, expect, it } from 'vitest';
import { fold, tokens } from '../../src/text/normalize.js';
import { keysFor, skeleton, toLatin } from '../../src/text/translit.js';

/** Do two names share any comparison key? */
const collide = (a: string, b: string): boolean =>
  keysFor(a).some((k) => keysFor(b).includes(k));

describe('fold', () => {
  it('erases accents and case', () => {
    expect(fold('Σύνταγμα')).toBe(fold('ΣΥΝΤΑΓΜΑ'));
    expect(fold('συνταγμα')).toBe(fold('ΣΥΝΤΑΓΜΑ'));
    expect(fold('Ομόνοια')).toBe(fold('ΟΜΟΝΟΙΑ'));
  });

  it('collapses final sigma', () => {
    expect(fold('Κανιγγος')).toBe(fold('ΚΑΝΙΓΓΟΣ'));
    expect(fold('κανιγγος')).toBe(fold('ΚΑΝΙΓΓΟΣ'));
  });

  it('handles the two-mark vowels', () => {
    expect(fold('ΐ')).toBe(fold('Ι'));
    expect(fold('ΰ')).toBe(fold('Υ'));
  });

  it('strips punctuation but keeps token boundaries', () => {
    expect(fold('ΠΛ. ΚΑΝΙΓΓΟΣ')).toBe('ΠΛ ΚΑΝΙΓΓΟΣ');
    expect(tokens('ΠΛ. ΚΑΝΙΓΓΟΣ')).toEqual(['ΠΛ', 'ΚΑΝΙΓΓΟΣ']);
  });

  it('repairs the homoglyph corruption present in live OASA data', () => {
    // Each of these is a real value captured from the API, where a Latin
    // letter has been substituted for its Greek look-alike.
    expect(fold('ΓΚΥΖH')).toBe(fold('ΓΚΥΖΗ')); // Latin H, webGetLines
    expect(fold('ΧΕΙΜΕΡΙΝO')).toBe(fold('ΧΕΙΜΕΡΙΝΟ')); // Latin O
    expect(fold('ΑNWO ΠΑΤΗSIA')).toBe(fold('ΑΝΩΟ ΠΑΤΗΣΙΑ')); // N, W, S, I
  });

  it('is empty for non-strings', () => {
    expect(fold(null)).toBe('');
    expect(fold(42)).toBe('');
  });
});

describe('transliteration', () => {
  it('produces a readable Latin form', () => {
    expect(toLatin(fold('ΣΥΝΤΑΓΜΑ'))).toBe('SYDAGMA');
    expect(toLatin(fold('ΟΜΟΝΟΙΑ'))).toBe('OMONOIA');
  });

  it('absorbs the γγ/γκ inconsistency upstream has in one payload', () => {
    // webRoutesForStop spells the same stop both ways.
    expect(skeleton('KANIGGOS')).toBe(skeleton('KANIGKOS'));
  });
});

describe('cross-script matching', () => {
  const cases: Array<[string, string]> = [
    ['Syntagma', 'ΣΥΝΤΑΓΜΑ'],
    ['syntagma', 'Σύνταγμα'],
    ['sintagma', 'ΣΥΝΤΑΓΜΑ'],
    ['Omonia', 'ΟΜΟΝΟΙΑ'],
    ['omonoia', 'ΟΜΟΝΟΙΑ'],
    ['Monastiraki', 'ΜΟΝΑΣΤΗΡΑΚΙ'],
    ['monastiraki', 'Μοναστηράκι'],
    ['Kanigos', 'ΚΑΝΙΓΓΟΣ'],
    ['Peiraias', 'ΠΕΙΡΑΙΑΣ'],
    // Exonym: the English name, not a transliteration of the Greek.
    ['Piraeus', 'ΠΕΙΡΑΙΑΣ'],
    ['Athens', 'ΑΘΗΝΑ'],
    ['airport', 'ΑΕΡΟΔΡΟΜΙΟ'],
    ['Kifisia', 'ΚΗΦΙΣΙΑ'],
    ['Glyfada', 'ΓΛΥΦΑΔΑ'],
    ['Ano Patisia', 'ΑΝΩ ΠΑΤΗΣΙΑ'],
    // The corrupted record must still be findable by its correct spelling.
    ['Ano Patisia', 'ΑNWO ΠΑΤΗSIA'],
    ['ΑΝΩ ΠΑΤΗΣΙΑ', 'ΑNWO ΠΑΤΗSIA'],
    ['Gkyzi', 'ΓΚΥΖH'],
  ];

  for (const [query, name] of cases) {
    it(`matches ${JSON.stringify(query)} to ${JSON.stringify(name)}`, () => {
      expect(collide(query, name)).toBe(true);
    });
  }

  it('does not collide genuinely different names', () => {
    expect(collide('ΣΥΝΤΑΓΜΑ', 'ΟΜΟΝΟΙΑ')).toBe(false);
    expect(collide('Syntagma', 'Monastiraki')).toBe(false);
    expect(collide('ΠΕΙΡΑΙΑΣ', 'ΚΗΦΙΣΙΑ')).toBe(false);
  });
});
