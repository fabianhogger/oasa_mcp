import { fold } from './normalize.js';
import { keysFor } from './translit.js';

/**
 * Ranked name matching with explicit ambiguity.
 *
 * The governing rule: never silently pick a stop. Athens stop names repeat
 * heavily — «ΠΛ. ΣΥΝΤΑΓΜΑΤΟΣ» exists several times for different directions,
 * and «ΒΕΝΙΖΕΛΟΥ» exists in many suburbs. Guessing produces a confidently
 * wrong answer ("your bus is in 4 minutes" — at a stop across the city), which
 * is far worse than asking the caller to choose. So a close field returns the
 * shortlist instead of a winner.
 */

export interface Searchable {
  /** Names to match against, in any script; nulls are ignored. */
  names: Array<string | null | undefined>;
  /** An exact-match identifier such as a LineID ("040", "Α1", "X95"). */
  id?: string | null | undefined;
  /** Rows sharing a group key are the same real place, so they merge rather than conflict. */
  groupKey?: string | null | undefined;
}

export interface Scored<T> {
  item: T;
  score: number;
}

export type MatchDecision = 'unique' | 'ambiguous' | 'none';

export interface MatchResult<T> {
  decision: MatchDecision;
  /** Best first. Empty when `decision` is 'none'. */
  candidates: Array<Scored<T>>;
  /** Set only when `decision` is 'unique'. */
  best: T | undefined;
}

const MIN_SCORE = 0.55;
const STRONG = 0.95;
const GAP = 0.15;

/** Damerau-Levenshtein, bounded: we only care whether it's *close*. */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      // Transposition, the common typo this adds over plain Levenshtein.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev[j - 2] === undefined ? v : prev[j - 2]! + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** Score one query key against one candidate key. */
function scoreKey(q: string, k: string): number {
  if (q === k) return 1;
  if (k.startsWith(q)) return 0.9;

  const qt = q.split(' ').filter(Boolean);
  const kt = k.split(' ').filter(Boolean);
  if (qt.length > 0 && qt.every((t) => kt.some((x) => x === t || x.startsWith(t)))) return 0.82;

  if (k.includes(q)) return 0.75;

  // Only consider edit distance for queries long enough for it to mean something.
  if (q.length >= 4) {
    const max = Math.max(1, Math.floor(Math.min(q.length, k.length) * 0.2));
    const d = editDistance(q, k, max);
    if (d <= max) {
      const ratio = 1 - d / Math.max(q.length, k.length);
      if (ratio >= 0.8) return 0.45 + 0.35 * ratio;
    }
  }
  return 0;
}

export function search<T extends Searchable>(
  query: string,
  items: readonly T[],
  opts: { limit?: number } = {},
): MatchResult<T> {
  const limit = opts.limit ?? 10;
  const foldedQuery = fold(query);
  if (foldedQuery === '') return { decision: 'none', candidates: [], best: undefined };

  // An exact identifier match is unambiguous by construction and wins outright:
  // someone asking for line "040" means that line, not a stop whose name is similar.
  const idHits = items.filter((it) => it.id != null && fold(it.id) === foldedQuery);
  if (idHits.length > 0) {
    const candidates = idHits.map((item) => ({ item, score: 1 }));
    return idHits.length === 1 || sameGroup(idHits)
      ? { decision: 'unique', candidates, best: idHits[0]! }
      : { decision: 'ambiguous', candidates, best: undefined };
  }

  const queryKeys = keysFor(query);
  const scored: Array<Scored<T>> = [];
  for (const item of items) {
    let best = 0;
    for (const name of item.names) {
      if (name == null || name === '') continue;
      for (const k of keysFor(name)) {
        for (const q of queryKeys) {
          const s = scoreKey(q, k);
          if (s > best) best = s;
          if (best === 1) break;
        }
        if (best === 1) break;
      }
      if (best === 1) break;
    }
    if (best >= MIN_SCORE) scored.push({ item, score: best });
  }

  if (scored.length === 0) return { decision: 'none', candidates: [], best: undefined };

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!;
  const second = scored[1];

  // Several records for the same real place (direction variants) are not a
  // conflict — they are one answer, so resolve rather than ask.
  const decisive =
    scored.length === 1 ||
    sameGroup(scored.map((s) => s.item)) ||
    (top.score >= STRONG && second !== undefined && top.score - second.score >= GAP);

  return {
    decision: decisive ? 'unique' : 'ambiguous',
    candidates: scored.slice(0, limit),
    best: decisive ? top.item : undefined,
  };
}

function sameGroup<T extends Searchable>(items: readonly T[]): boolean {
  const first = items[0]?.groupKey;
  if (first == null || first === '') return false;
  return items.every((i) => i.groupKey === first);
}
