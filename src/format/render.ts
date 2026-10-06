/**
 * Output shaped for a model reader.
 *
 * Two rules drive everything here. First, never return raw upstream JSON: the
 * line list alone is 150 KB and would swamp a context window for no benefit.
 * Second, always name the units and both languages — `*DescrEng` is frequently
 * null, so an English-only rendering silently loses stops.
 */

export type Language = 'el' | 'en' | 'both';

/** Combine the Greek and English names per the caller's preference. */
export function name(
  el: string | null | undefined,
  en: string | null | undefined,
  lang: Language,
): string {
  const g = el?.trim() || null;
  const e = en?.trim() || null;
  if (lang === 'el') return g ?? e ?? '—';
  if (lang === 'en') return e ?? g ?? '—';
  if (g && e && g !== e) return `${g} (${e})`;
  return g ?? e ?? '—';
}

export interface Column<T> {
  header: string;
  get: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
}

/**
 * A fixed-width table.
 *
 * Plain aligned text rather than JSON or Markdown: it is the most compact
 * form a model reads reliably, and it keeps column meaning next to the value.
 */
export function table<T>(rows: readonly T[], columns: ReadonlyArray<Column<T>>): string {
  if (rows.length === 0) return '(none)';
  const cells = rows.map((r) =>
    columns.map((c) => {
      const v = c.get(r);
      return v === null || v === undefined || v === '' ? '—' : String(v);
    }),
  );
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((row) => displayWidth(row[i] ?? ''))),
  );
  const line = (vals: string[]): string =>
    vals
      .map((v, i) => {
        const pad = widths[i]! - displayWidth(v);
        const spaces = ' '.repeat(Math.max(0, pad));
        return columns[i]!.align === 'right' ? spaces + v : v + spaces;
      })
      .join('  ')
      .trimEnd();

  return [line(columns.map((c) => c.header)), ...cells.map(line)].join('\n');
}

/** Greek text is single-width; this exists so padding stays honest if that changes. */
function displayWidth(s: string): number {
  return [...s].length;
}

/** A trailing note when a list was cut short, so the model knows to narrow. */
export function showing(shown: number, total: number): string | null {
  return total > shown ? `showing ${shown} of ${total}` : null;
}

export function joinSections(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.trim() !== '').join('\n\n');
}

export function round(n: number | null | undefined, places = 5): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
