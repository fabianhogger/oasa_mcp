import { describe, expect, it } from 'vitest';
import { search, type Searchable } from '../../src/text/match.js';

interface Stop extends Searchable {
  codeNo: string;
}
const stop = (codeNo: string, el: string, en: string | null = null, groupKey?: string): Stop => ({
  codeNo,
  names: [el, en],
  ...(groupKey === undefined ? {} : { groupKey }),
});

describe('search', () => {
  it('finds a single clear match', () => {
    const r = search('Syntagma', [stop('1', 'ΣΥΝΤΑΓΜΑ'), stop('2', 'ΟΜΟΝΟΙΑ')]);
    expect(r.decision).toBe('unique');
    expect(r.best?.codeNo).toBe('1');
  });

  it('refuses to guess between same-named stops', () => {
    // The core safety property: a wrong stop yields a confidently wrong ETA.
    const r = search('Venizelou', [
      stop('400058', 'ΒΕΝΙΖΕΛΟΥ', 'VENIZELOY'),
      stop('400036', 'ΒΕΝΙΖΕΛΟΥ', 'VENIZELOY'),
      stop('900111', 'ΒΕΝΙΖΕΛΟΥ', 'VENIZELOY'),
    ]);
    expect(r.decision).toBe('ambiguous');
    expect(r.best).toBeUndefined();
    expect(r.candidates).toHaveLength(3);
  });

  it('merges direction variants of one place instead of asking', () => {
    const r = search('Syntagma', [
      stop('060060', 'ΠΛ. ΣΥΝΤΑΓΜΑΤΟΣ', 'SYNTAGMA', 'SYNTAGMA-SQ'),
      stop('060061', 'ΠΛ. ΣΥΝΤΑΓΜΑΤΟΣ', 'SYNTAGMA', 'SYNTAGMA-SQ'),
    ]);
    expect(r.decision).toBe('unique');
  });

  it('lets an exact line id win outright', () => {
    const lines: Searchable[] = [
      { names: ['ΠΕΙΡΑΙΑΣ - ΣΥΝΤΑΓΜΑ'], id: '040' },
      { names: ['ΚΑΤΙ ΑΛΛΟ 040 ΟΔΟΣ'], id: '999' },
    ];
    const r = search('040', lines);
    expect(r.decision).toBe('unique');
    expect(r.best?.id).toBe('040');
  });

  it('matches a Greek-lettered line id', () => {
    const r = search('Α1', [{ names: ['ΒΟΥΛΑ - ΑΘΗΝΑ'], id: 'Α1' }]);
    expect(r.decision).toBe('unique');
  });

  it('reports nothing for a name that is not present', () => {
    const r = search('Reykjavik', [stop('1', 'ΣΥΝΤΑΓΜΑ')]);
    expect(r.decision).toBe('none');
    expect(r.candidates).toEqual([]);
  });

  it('tolerates a typo', () => {
    const r = search('Monastriaki', [stop('1', 'ΜΟΝΑΣΤΗΡΑΚΙ'), stop('2', 'ΠΕΙΡΑΙΑΣ')]);
    expect(r.decision).toBe('unique');
    expect(r.best?.codeNo).toBe('1');
  });

  it('ranks the better match first when it must ask', () => {
    const r = search('ΠΑΤΗΣΙΑ', [
      stop('1', 'ΑΝΩ ΠΑΤΗΣΙΑ'),
      stop('2', 'ΠΑΤΗΣΙΑ'),
      stop('3', 'ΚΑΤΩ ΠΑΤΗΣΙΑ'),
    ]);
    expect(r.candidates[0]!.item.codeNo).toBe('2');
  });

  it('finds a record whose stored name is homoglyph-corrupted', () => {
    // Real corruption from getSchedLines: Latin N, W, S, I inside Greek text.
    const r = search('Ano Patisia', [stop('1', 'ΑNWO ΠΑΤΗSIA'), stop('2', 'ΟΜΟΝΟΙΑ')]);
    expect(r.decision).toBe('unique');
    expect(r.best?.codeNo).toBe('1');
  });

  it('ignores empty and null names without crashing', () => {
    const r = search('Syntagma', [{ names: [null, '', undefined] }, stop('2', 'ΣΥΝΤΑΓΜΑ')]);
    expect(r.decision).toBe('unique');
  });

  it('returns none for an empty query', () => {
    expect(search('', [stop('1', 'ΣΥΝΤΑΓΜΑ')]).decision).toBe('none');
    expect(search('   ', [stop('1', 'ΣΥΝΤΑΓΜΑ')]).decision).toBe('none');
  });

  it('honours the limit when shortlisting', () => {
    const many = Array.from({ length: 30 }, (_, i) => stop(String(i), 'ΒΕΝΙΖΕΛΟΥ'));
    expect(search('Venizelou', many, { limit: 5 }).candidates).toHaveLength(5);
  });
});
