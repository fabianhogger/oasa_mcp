/**
 * Text folding for Greek transit names.
 *
 * Three problems have to be solved at once:
 *
 * 1. Accents and case. Users type "Σύνταγμα", "ΣΥΝΤΑΓΜΑ", "syntagma".
 * 2. Final sigma. «ΚΑΝΙΓΓΟΣ» vs «Κανιγγος» vs «κανιγγοσ» — ς and σ must collide.
 * 3. Homoglyph corruption, which is real and present in live OASA data:
 *      "ΓΚΥΖH"            — Latin H for Greek Η   (webGetLines)
 *      "ΧΕΙΜΕΡΙΝO ΚΥΡΙΑΚΗ" — Latin O for Greek Ο  (getScheduleDaysMasterline)
 *      "ΑNWO ΠΑΤΗSIA"     — Latin N, W, S, I      (documented getSchedLines)
 *    Without folding these, a search for the correctly-spelled Greek name
 *    silently fails to match the record, which is the worst kind of bug here:
 *    it looks like "no such stop" rather than an encoding fault.
 */

/** Latin letters that are visually identical to a Greek letter, mapped to Greek. */
const HOMOGLYPHS: Record<string, string> = {
  A: 'Α', B: 'Β', E: 'Ε', H: 'Η', I: 'Ι', K: 'Κ', M: 'Μ', N: 'Ν',
  O: 'Ο', P: 'Ρ', T: 'Τ', X: 'Χ', Y: 'Υ', Z: 'Ζ',
  // Not strictly homoglyphs, but used the same way in this data set.
  W: 'Ω', S: 'Σ', C: 'Σ', U: 'Υ', G: 'Γ', L: 'Λ', D: 'Δ', F: 'Φ', R: 'Ρ', V: 'Β',
};

/**
 * Fold a name to a comparison key.
 *
 * Order matters: strip diacritics before uppercasing, because Greek uppercasing
 * has its own accent rules that would otherwise have to be reasoned about.
 */
export function fold(input: unknown): string {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFD').replace(/\p{M}+/gu, '');
  s = s.toUpperCase();
  // Final sigma, plus the standalone sigma symbol.
  s = s.replace(/[ςϲ]/gu, 'Σ').replace(/΢/gu, 'Σ');
  s = s.replace(/[A-Z]/g, (c) => HOMOGLYPHS[c] ?? c);
  // Collapse everything that isn't a letter or digit; keeps token boundaries.
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s;
}

/**
 * Fold without homoglyph repair, preserving the original script.
 *
 * Needed because homoglyph repair is only correct for text that is *meant* to
 * be Greek. Applied to a Latin-script query it does damage: Latin "P" looks
 * like Greek "Ρ", but Greek "Ρ" transliterates back as "R", so "Peiraias"
 * would become "Reiraias". Callers therefore build keys from both this and
 * `fold`, and let whichever interpretation is right do the matching.
 */
export function foldKeepScript(input: unknown): string {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFD').replace(/\p{M}+/gu, '');
  s = s.toUpperCase();
  s = s.replace(/[ςϲ]/gu, 'Σ').replace(/\u03A2/gu, 'Σ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s;
}

/** Fold and split into tokens. */
export function tokens(input: unknown): string[] {
  const f = fold(input);
  return f === '' ? [] : f.split(' ');
}
