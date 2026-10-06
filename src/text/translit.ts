import { applyExonyms } from './aliases.js';
import { fold, foldKeepScript } from './normalize.js';

/**
 * Greek → Latin keys, so a query typed in Latin letters matches a Greek name.
 *
 * Two keys are produced per name:
 *
 *  - a readable ELOT-743-ish transliteration, and
 *  - a lossy "skeleton" that collapses the sounds Greek spells several ways.
 *
 * The skeleton is what actually does the work. Greek has many-to-one vowel
 * sounds (Η, Ι, Υ, ΕΙ, ΟΙ all read as "i") and users transliterate
 * inconsistently, so "syntagma" / "sintagma" / "sydagma" must all collide.
 * Going the other way — Latin → Greek — would be one-to-many and far more
 * error-prone, so we only ever reduce.
 *
 * Upstream is itself inconsistent: a single payload spells one stop both
 * "KANIGGOS" and "KANIGKOS", so the skeleton has to absorb that too.
 */

/** Longest-first, so digraphs win over their component letters. */
const DIGRAPHS: Array<[string, string]> = [
  ['ΟΥ', 'OU'], ['ΑΥ', 'AV'], ['ΕΥ', 'EV'], ['ΗΥ', 'IV'],
  ['ΑΙ', 'AI'], ['ΕΙ', 'EI'], ['ΟΙ', 'OI'], ['ΥΙ', 'YI'],
  ['ΜΠ', 'B'], ['ΝΤ', 'D'], ['ΓΚ', 'G'], ['ΓΓ', 'NG'],
  ['ΤΣ', 'TS'], ['ΤΖ', 'TZ'], ['ΓΧ', 'NCH'],
];

const SINGLES: Record<string, string> = {
  Α: 'A', Β: 'V', Γ: 'G', Δ: 'D', Ε: 'E', Ζ: 'Z', Η: 'I', Θ: 'TH',
  Ι: 'I', Κ: 'K', Λ: 'L', Μ: 'M', Ν: 'N', Ξ: 'X', Ο: 'O', Π: 'P',
  Ρ: 'R', Σ: 'S', Τ: 'T', Υ: 'Y', Φ: 'F', Χ: 'CH', Ψ: 'PS', Ω: 'O',
};

/** Readable transliteration of an already-folded Greek string. */
export function toLatin(folded: string): string {
  let s = folded;
  for (const [gr, la] of DIGRAPHS) s = s.split(gr).join(la);
  s = s.replace(/[Ά-ώ]/gu, (c) => SINGLES[c] ?? c);
  return s;
}

/**
 * Reduce a Latin string to its sound skeleton.
 *
 * Every rule here exists to make a real-world spelling variant collide with
 * the canonical one.
 */
export function skeleton(latin: string): string {
  let s = latin.toUpperCase();
  s = s.replace(/[^A-Z0-9 ]+/g, '');
  s = s.replace(/PH/g, 'F');
  s = s.replace(/TH/g, '0'); // a placeholder letter, so TH ≠ T + H
  s = s.replace(/CH|KH/g, 'H');
  s = s.replace(/PS/g, 'S');
  s = s.replace(/NG|GK|GG/g, 'G'); // KANIGGOS ≈ KANIGKOS
  s = s.replace(/MB|MP/g, 'B');
  s = s.replace(/NT|ND/g, 'D');
  s = s.replace(/[EI]Y/g, 'I');
  s = s.replace(/OI/g, 'I'); // ΟΙ reads as "i": ΟΜΟΝΟΙΑ ≈ Omonia
  s = s.replace(/OU/g, 'U');
  s = s.replace(/[HYJ]/g, 'I'); // Η/Υ/Ι all read as "i"
  s = s.replace(/[AE]I/g, 'I');
  s = s.replace(/W/g, 'O');
  s = s.replace(/[VB]/g, 'V');
  s = s.replace(/[KQC]/g, 'K');
  s = s.replace(/Z/g, 'S');
  s = s.replace(/(.)\1+/g, '$1'); // collapse doubles
  return s.trim();
}

/**
 * All comparison keys for one name. Matching is key-set against key-set, so a
 * Greek query and a Latin query both find the same record.
 */
export function keysFor(name: unknown): string[] {
  const f = fold(name);
  if (f === '') return [];
  const latin = toLatin(f);
  const out = new Set<string>([f, latin, skeleton(latin)]);
  // Also key the string as written, without homoglyph repair, so a Latin-script
  // query is skeletonised as Latin rather than being bounced through Greek.
  out.add(skeleton(foldKeepScript(name)));
  // English exonyms ("Piraeus" for ΠΕΙΡΑΙΑΣ) need an explicit alias; phonetic
  // reduction alone can never relate a name to a different name.
  const exonym = applyExonyms(name);
  if (exonym) {
    const exLatin = toLatin(exonym);
    out.add(exonym);
    out.add(exLatin);
    out.add(skeleton(exLatin));
  }
  out.delete('');
  return [...out];
}
