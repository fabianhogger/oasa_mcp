import { fold } from './normalize.js';

/**
 * English exonyms for Athens places.
 *
 * Transliteration cannot bridge these: "Piraeus" is the English *name* of
 * Πειραιάς, not a rendering of its sounds, so no phonetic reduction will ever
 * make them collide. People do type them, so they need an explicit table.
 *
 * Kept deliberately small — only places where the English form is in common
 * use and differs from a straight transliteration.
 */
const EXONYMS: Array<[string, string]> = [
  ['PIRAEUS', 'ΠΕΙΡΑΙΑΣ'],
  ['ATHENS', 'ΑΘΗΝΑ'],
  ['THEBES', 'ΘΗΒΑ'],
  ['EUBOEA', 'ΕΥΒΟΙΑ'],
  ['SALAMIS', 'ΣΑΛΑΜΙΝΑ'],
  ['MARATHON', 'ΜΑΡΑΘΩΝΑΣ'],
  ['CORINTH', 'ΚΟΡΙΝΘΟΣ'],
  ['ELEUSIS', 'ΕΛΕΥΣΙΝΑ'],
  ['ACROPOLIS', 'ΑΚΡΟΠΟΛΗ'],
  ['AIRPORT', 'ΑΕΡΟΔΡΟΜΙΟ'],
];

const TABLE = new Map<string, string>();
for (const [en, el] of EXONYMS) {
  TABLE.set(fold(en), el);
  TABLE.set(fold(el), el);
}

/**
 * Rewrite any exonym tokens in a query to their Greek equivalent, so the
 * ordinary transliteration path can then do the matching.
 */
export function applyExonyms(input: unknown): string | null {
  const f = fold(input);
  if (f === '') return null;
  let changed = false;
  const out = f.split(' ').map((t) => {
    const hit = TABLE.get(t);
    if (hit && hit !== t) {
      changed = true;
      return fold(hit);
    }
    return t;
  });
  return changed ? out.join(' ') : null;
}
