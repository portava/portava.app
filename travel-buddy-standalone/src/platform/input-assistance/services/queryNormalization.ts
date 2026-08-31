/**
 * Global Input Intelligence — client-side query normalization (spec §10, §34).
 *
 * "Prefer local: Simple normalization" (§34). This does the cheap, safe folding
 * on-device so cache keys and local prefix matching tolerate case, whitespace,
 * and diacritics — WITHOUT destroying the display spelling (§10 "Never normalize
 * stored canonical display names destructively"). Canonical alias resolution
 * and transliteration remain server-owned; the small alias map here is only a
 * degraded-mode / offline nicety, not the source of truth.
 *
 * Pure module — unit-testable, no React/network.
 *
 * NOTE (later phases): the alias/abbreviation map is intentionally tiny and
 * launch-city focused. Do not grow it into a hardcoded city list (the existing
 * `compassIntent.ts` ~45-city list is called out as brittle in the audit). Real
 * alias resolution belongs to the server's QueryNormalizer (§40).
 */

/**
 * Latin letters that carry a stroke/ligature rather than a combining diacritic
 * — NFKD does NOT decompose these, so the combining-mark strip below misses
 * them. This map folds them to a base form so, e.g., "danang" matches "Đà
 * Nẵng" (đ→d) — which matters directly for launch cities. Keys are lowercase.
 */
const SPECIAL_LETTER_FOLDS: Record<string, string> = {
  đ: 'd',
  ð: 'd',
  ø: 'o',
  ł: 'l',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
};

/** Fold to a normalized match key: NFKD, strip diacritics, lowercase, fold
 *  non-decomposing stroke letters, collapse whitespace. Use for cache keys and
 *  local prefix comparison only — never for stored display names (§10). */
export function foldForMatch(input: string): string {
  return input
    .normalize('NFKD')
    // Strip combining diacritical marks (U+0300–U+036F).
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[đðøłßæœþ]/g, (ch) => SPECIAL_LETTER_FOLDS[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Safe whitespace + unicode normalization that PRESERVES display spelling
 *  (keeps diacritics and case). Use before showing user text back. */
export function normalizeDisplay(input: string): string {
  return input.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Small local alias/abbreviation map (§10 examples). Keys are already folded
 * (see foldForMatch). Values are canonical DISPLAY spellings. Offline/degraded
 * use only — the server is authoritative when online.
 */
const LOCAL_ALIASES: Record<string, string> = {
  'da nang': 'Đà Nẵng',
  danang: 'Đà Nẵng',
  hcmc: 'Ho Chi Minh City',
  saigon: 'Ho Chi Minh City',
  'phu qouc': 'Phu Quoc',
  'phu quoc': 'Phu Quoc',
  bkk: 'Bangkok',
};

/**
 * Resolve a known local alias to its canonical display spelling, or `null` when
 * there is no confident local match. Never guesses — an unknown input returns
 * null so the raw user text is preserved (§2 low-confidence preserves input).
 */
export function resolveLocalAlias(input: string): string | null {
  const folded = foldForMatch(input);
  return LOCAL_ALIASES[folded] ?? null;
}

/** True when `query` is a case/diacritic-insensitive prefix of `candidate`. */
export function isFoldedPrefix(query: string, candidate: string): boolean {
  const q = foldForMatch(query);
  if (!q) return false;
  return foldForMatch(candidate).startsWith(q);
}
