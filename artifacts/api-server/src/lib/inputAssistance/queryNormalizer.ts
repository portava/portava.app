/**
 * QueryNormalizer (§10, §40) — the single normalization service.
 *
 * §40 names `QueryNormalizer` as one of the server domain services and §10
 * describes what it owes: diacritic-insensitive matching that preserves the
 * display spelling, transliteration where supported, punctuation and emoji
 * handling appropriate to the field context, and phone/keyboard typo tolerance
 * *where confidence is sufficient*.
 *
 * Before this file there was no such service. `gateway.ts` called three
 * unrelated helpers inline — `applyAliases` (Discovery's fixed misspelling
 * table), `sanitizeQuery` (Discovery's PostgREST metacharacter guard) and
 * `normalizeLocationName` (the location service's fold) — and the client module
 * that wanted one said so in a comment: *"Real alias resolution belongs to the
 * server's QueryNormalizer (§40)"*. Three of §10's four clauses had no
 * implementation at all:
 *
 *   - TRANSLITERATION was closed-up Latin variants only (`danang`,
 *     `hochiminh`). No script mapping existed, so `กรุงเทพ` or `胡志明市`
 *     resolved nothing in a product whose launch cities are in Vietnam,
 *     Thailand and the Philippines.
 *   - EMOJI were not handled anywhere: they survived `sanitizeQuery` into the
 *     `ilike` pattern and matched nothing.
 *   - TYPO TOLERANCE was the fixed alias table and nothing else. A misspelling
 *     that was not one of its ~60 keys was simply a miss, and NO confidence was
 *     computed, so §10's "where confidence is sufficient" had no measurable
 *     quantity behind it.
 *
 * Everything here is PURE — no Supabase, no network, no clock — so each clause
 * is unit-testable and mutation-testable on its own.
 *
 * ── WHY CORRECTION IS TWO-BANDED AND NEVER DESTRUCTIVE ───────────────────────
 *
 * §2 requires the user's raw input to be preserved and §19 forbids a silent
 * guess. So a correction NEVER replaces the user's text: it changes only the
 * key candidate generation is run against, and only above
 * {@link APPLY_CONFIDENCE}. Between {@link SUGGEST_CONFIDENCE} and that bar the
 * original query is searched unchanged and the correction is offered as a row
 * the user may tap. Below {@link SUGGEST_CONFIDENCE} nothing happens at all.
 *
 * An input that is AMBIGUOUS — two vocabulary entries tie at the best distance —
 * produces no correction in either band, whatever its raw score. "Where
 * confidence is sufficient" is a statement about a unique winner, not about a
 * number, and two equally-close candidates are exactly the case §19 says must
 * not be guessed.
 */
import { applyAliases } from '../../routes/discoverySearchHelpers';
import { sanitizeQuery } from '../../routes/discoverySearch';
import { searchKey } from '../canonicalLocations';
import type { InputContext, InputSuggestion } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// §10 — Transliteration where supported
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Native-script EXONYMS for the cities Portava actually launches in, plus the
 * majors a traveller in the region types. A per-character romanizer cannot
 * produce these: Han characters carry no phonetic value to transliterate from,
 * so the only correct mapping is a curated dictionary. Keys are the native
 * spelling with whitespace collapsed; values are the Latin form the canonical
 * registry is keyed by (post-`searchKey`, so "ho chi minh" not "Ho Chi Minh
 * City").
 *
 * This dictionary is deliberately SMALL and deliberately EXPLICIT. Adding a row
 * is a decision about one city, not a change to an algorithm, and a wrong row
 * can only misroute the single string it names.
 */
export const NATIVE_CITY_NAMES: Record<string, string> = {
  // ── Thai ──────────────────────────────────────────────────────────────────
  'กรุงเทพ': 'bangkok',
  'กรุงเทพมหานคร': 'bangkok',
  'เชียงใหม่': 'chiang mai',
  'ภูเก็ต': 'phuket',
  'พัทยา': 'pattaya',
  'เกาะสมุย': 'koh samui',
  'กระบี่': 'krabi',
  // ── Chinese (simplified + traditional) ────────────────────────────────────
  '胡志明市': 'ho chi minh',
  '西贡': 'ho chi minh',
  '曼谷': 'bangkok',
  '东京': 'tokyo',
  '東京': 'tokyo',
  '首尔': 'seoul',
  '香港': 'hong kong',
  '新加坡': 'singapore',
  '台北': 'taipei',
  '河内': 'hanoi',
  '岘港': 'da nang',
  '马尼拉': 'manila',
  '吉隆坡': 'kuala lumpur',
  // ── Japanese ──────────────────────────────────────────────────────────────
  'とうきょう': 'tokyo',
  'トウキョウ': 'tokyo',
  '大阪': 'osaka',
  'おおさか': 'osaka',
  '京都': 'kyoto',
  // ── Korean ────────────────────────────────────────────────────────────────
  '서울': 'seoul',
  '부산': 'busan',
  // ── Arabic ────────────────────────────────────────────────────────────────
  'دبي': 'dubai',
  'أبوظبي': 'abu dhabi',
  'القاهرة': 'cairo',
  'إسطنبول': 'istanbul',
  // ── Cyrillic (the per-character map below romanizes these too; the explicit
  //    rows exist because the ENGLISH exonym differs from the romanization —
  //    "moskva" is not what the canonical registry stores).
  'москва': 'moscow',
  'санкт-петербург': 'saint petersburg',
  // ── Greek ─────────────────────────────────────────────────────────────────
  'αθήνα': 'athens',
  'θεσσαλονίκη': 'thessaloniki',
};

/**
 * Per-character romanization for the alphabetic scripts where it is well
 * defined. Unlike the dictionary above this generalizes: any Cyrillic, Greek or
 * Thai string romanizes, not only a listed city.
 *
 * Thai is the loosest of the three — it is an abugida with implicit vowels and
 * no word spacing, so this is a CONSONANT/VOWEL approximation in the spirit of
 * RTGS, good enough to make `เชียงใหม่` land near `chiang mai` under the typo
 * tolerance below, and not claimed to be more than that.
 */
const SCRIPT_MAP: Record<string, string> = {
  // Cyrillic (Russian/Ukrainian core)
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z',
  'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
  'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh',
  'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya', 'і': 'i', 'ї': 'yi',
  'є': 'ye', 'ґ': 'g',
  // Greek
  'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i',
  'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's',
  'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o',
  // Thai consonants
  'ก': 'k', 'ข': 'kh', 'ค': 'kh', 'ฆ': 'kh', 'ง': 'ng', 'จ': 'ch', 'ฉ': 'ch', 'ช': 'ch',
  'ซ': 's', 'ฌ': 'ch', 'ญ': 'y', 'ฎ': 'd', 'ฏ': 't', 'ฐ': 'th', 'ฑ': 'th', 'ฒ': 'th',
  'ณ': 'n', 'ด': 'd', 'ต': 't', 'ถ': 'th', 'ท': 'th', 'ธ': 'th', 'น': 'n', 'บ': 'b',
  'ป': 'p', 'ผ': 'ph', 'ฝ': 'f', 'พ': 'ph', 'ฟ': 'f', 'ภ': 'ph', 'ม': 'm', 'ย': 'y',
  'ร': 'r', 'ฤ': 'rue', 'ล': 'l', 'ว': 'w', 'ศ': 's', 'ษ': 's', 'ส': 's', 'ห': 'h',
  'ฬ': 'l', 'อ': 'o', 'ฮ': 'h',
  // Thai vowels / signs
  'ะ': 'a', 'า': 'a', 'ิ': 'i', 'ี': 'i', 'ึ': 'ue', 'ื': 'ue', 'ุ': 'u', 'ู': 'u',
  'เ': 'e', 'แ': 'ae', 'โ': 'o', 'ใ': 'ai', 'ไ': 'ai', 'ำ': 'am', 'ั': 'a', '็': '',
  '่': '', '้': '', '๊': '', '๋': '', '์': '', 'ฺ': '', 'ๆ': '',
};

/** True when the string contains at least one character SCRIPT_MAP romanizes. */
function hasNonLatinScript(s: string): boolean {
  for (const ch of s) if (SCRIPT_MAP[ch.toLowerCase()] !== undefined) return true;
  return false;
}

/**
 * Transliterate a query to Latin (§10 "transliteration where supported").
 *
 * Order matters and is deliberate: the curated exonym dictionary is consulted
 * FIRST, on the whole trimmed string and then token by token, because a
 * romanization of `москва` is `moskva` and the canonical registry stores
 * `Moscow`. Only what the dictionary does not claim is romanized per character.
 *
 * Pure ASCII input is returned byte-identical — this never touches a Latin
 * query, so nothing that works today can change shape because of it.
 */
export function transliterate(raw: string): string {
  const input = (raw ?? '').trim();
  if (!input) return input;

  const collapsed = input.replace(/\s+/g, ' ');
  const whole = NATIVE_CITY_NAMES[collapsed] ?? NATIVE_CITY_NAMES[collapsed.toLowerCase()];
  if (whole) return whole;

  // Nothing to do for a query that carries no mapped script and no mapped token.
  const tokens = collapsed.split(' ');
  const anyMapped = tokens.some(
    (t) => NATIVE_CITY_NAMES[t] !== undefined || NATIVE_CITY_NAMES[t.toLowerCase()] !== undefined,
  );
  if (!anyMapped && !hasNonLatinScript(collapsed)) return input;

  const out = tokens.map((tok) => {
    const dict = NATIVE_CITY_NAMES[tok] ?? NATIVE_CITY_NAMES[tok.toLowerCase()];
    if (dict) return dict;
    if (!hasNonLatinScript(tok)) return tok;
    let acc = '';
    for (const ch of tok) {
      const lower = ch.toLowerCase();
      const mapped = SCRIPT_MAP[lower];
      acc += mapped === undefined ? ch : mapped;
    }
    return acc;
  });
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 — Punctuation and emoji handling appropriate to field context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every codepoint class that renders as a pictograph, plus the joiners and
 * modifiers that glue a sequence together (ZWJ, variation selector 16, skin
 * tone modifiers, regional indicators for flags, keycap combining marks).
 * Stripping the base without the modifiers leaves orphan combining marks in the
 * query, which is why they are in the same class.
 */
const EMOJI_RE =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{FE0E}\u{20E3}\u{200D}]/gu;

/** True when the string contains at least one emoji codepoint. */
export function containsEmoji(s: string): boolean {
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(s ?? '');
}

/**
 * Remove emoji from a SEARCH key and collapse the whitespace they leave behind.
 *
 * This is applied to the candidate-generation key only — never to the label,
 * the `replacementText`, or anything the user sees. An emoji in an `ilike`
 * pattern matches no row in any Portava table, so leaving one in the key is not
 * neutral: it turns a query that would have matched into one that cannot.
 */
export function stripEmoji(s: string): string {
  if (!s) return s;
  return s.replace(EMOJI_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * §10 "appropriate to field context". Emoji are stripped from the key for every
 * context that RESOLVES the text against stored rows. They are left alone for
 * the free-text writing contexts, where the typed characters are the user's
 * prose rather than a lookup key and the gateway only consults them when a
 * `@`/`#` sigil is present (and the sigil path has its own canonicalization).
 */
const EMOJI_PRESERVING_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'caption',
  'comment',
  'telegraph_message',
  'display_name',
  'generic_text',
]);

/** Whether this context strips emoji from its search key. */
export function stripsEmoji(context: InputContext): boolean {
  return !EMOJI_PRESERVING_CONTEXTS.has(context);
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 — Phone / keyboard typo tolerance where confidence is sufficient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * QWERTY physical adjacency, which is also the layout of every soft keyboard
 * the app ships against. A substitution between two ADJACENT keys is far more
 * likely to be a slip than a different word, so it costs less than an arbitrary
 * substitution — that is the whole of "keyboard-adjacency model" in §10.
 */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

const ADJACENCY: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    if (!m.has(a)) m.set(a, new Set());
    m.get(a)!.add(b);
  };
  KEYBOARD_ROWS.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]!;
      add(ch, row[c - 1] ?? '');
      add(ch, row[c + 1] ?? '');
      for (const dr of [-1, 1]) {
        const other = KEYBOARD_ROWS[r + dr];
        if (!other) continue;
        // Staggered rows: a key sits between the two keys above/below it.
        add(ch, other[c] ?? '');
        add(ch, other[c - 1] ?? '');
        add(ch, other[c + 1] ?? '');
      }
    }
  });
  return m;
})();

/** True when two letters are neighbours on a QWERTY keyboard. */
export function keyboardAdjacent(a: string, b: string): boolean {
  return ADJACENCY.get(a)?.has(b) === true;
}

/** Substitution cost for two adjacent keys (a slip), vs. 1 for any other swap. */
export const ADJACENT_SUBSTITUTION_COST = 0.5;
/** Transposition cost — "bangkok"→"bagnkok" is one of the commonest phone errors. */
export const TRANSPOSITION_COST = 0.6;

/**
 * Damerau-Levenshtein distance with a keyboard-weighted substitution cost.
 *
 * Returns a REAL number, not an integer: an adjacent-key substitution
 * contributes {@link ADJACENT_SUBSTITUTION_COST} and an adjacent transposition
 * {@link TRANSPOSITION_COST}, so "bwngkok" (w is next to a) scores strictly
 * closer to "bangkok" than "bzngkok" does.
 */
export function weightedDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const ca = a[i - 1]!;
      const cb = b[j - 1]!;
      const sub = ca === cb ? 0 : keyboardAdjacent(ca, cb) ? ADJACENT_SUBSTITUTION_COST : 1;
      let best = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + sub,
      );
      if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb) {
        best = Math.min(best, d[i - 2]![j - 2]! + TRANSPOSITION_COST);
      }
      d[i]![j] = best;
    }
  }
  return d[m]![n]!;
}

/**
 * The similarity §10 calls confidence: 1 − (weighted distance / the longer
 * length). 1.0 is identical; a one-letter slip in an eight-letter city is
 * ~0.94; two unrelated words are near 0.
 */
export function typoConfidence(typed: string, candidate: string): number {
  if (!typed || !candidate) return 0;
  if (typed === candidate) return 1;
  const longer = Math.max(typed.length, candidate.length);
  return Math.max(0, 1 - weightedDistance(typed, candidate) / longer);
}

/**
 * At or above this, the corrected term REPLACES the search key (the original is
 * still shown to the user and still offered as a row — nothing is destroyed).
 */
export const APPLY_CONFIDENCE = 0.8;
/** At or above this, the correction is OFFERED but the typed key is searched. */
export const SUGGEST_CONFIDENCE = 0.68;
/** Shorter words are not corrected: at 3 letters every neighbour is "close". */
export const MIN_CORRECTABLE_LENGTH = 4;

/**
 * The vocabulary typo tolerance corrects TOWARD.
 *
 * Deliberately small and hand-held. Every entry is either a launch-region city
 * the product ships with or a travel-domain noun the search path already
 * indexes, so a correction can only ever move a query toward something the
 * corpus can actually match. It is exported so a test can assert its shape and
 * a later phase can widen it from the canonical registry without changing the
 * algorithm.
 */
export const TYPO_VOCABULARY: readonly string[] = [
  // Launch-region cities (the canonical registry's own keys).
  'bangkok', 'chiang mai', 'phuket', 'pattaya', 'krabi', 'koh samui',
  'da nang', 'hanoi', 'ho chi minh', 'hoi an', 'nha trang', 'phu quoc', 'hue',
  'manila', 'cebu', 'boracay', 'siargao', 'palawan', 'davao', 'bohol',
  'singapore', 'kuala lumpur', 'penang', 'jakarta', 'bali', 'ubud', 'lombok',
  'phnom penh', 'siem reap', 'vientiane', 'luang prabang', 'yangon',
  'tokyo', 'osaka', 'kyoto', 'seoul', 'busan', 'taipei', 'hong kong',
  'dubai', 'istanbul', 'lisbon', 'barcelona', 'paris', 'london', 'berlin',
  'mexico city', 'medellin', 'buenos aires', 'lima', 'rio de janeiro',
  // Travel-domain nouns the search path indexes.
  'restaurant', 'cafe', 'coffee', 'bakery', 'brunch', 'street food',
  'nightlife', 'cocktail', 'rooftop', 'beach', 'island', 'waterfall',
  'temple', 'museum', 'market', 'hostel', 'hotel', 'coworking', 'sunset',
  'snorkeling', 'diving', 'hiking', 'massage', 'nightclub', 'brewery',
];

const VOCAB_SET = new Set(TYPO_VOCABULARY);

/** A single correction the normalizer decided on, with the evidence for it. */
export interface TypoCorrection {
  /** The token (or whole phrase) as the user typed it. */
  from: string;
  /** The vocabulary entry it was corrected toward. */
  to: string;
  /** §10 confidence in [0,1]. */
  confidence: number;
  /**
   * `'applied'` — at or above {@link APPLY_CONFIDENCE}; the search key used the
   * corrected form. `'offered'` — between the two bars; the typed key was
   * searched unchanged and the correction is only a row the user may tap.
   */
  disposition: 'applied' | 'offered';
}

/**
 * Find the single best vocabulary match for one typed token.
 *
 * Returns null — no correction, in either band — when the token is already
 * vocabulary, when it is too short, or when TWO vocabulary entries tie at the
 * best distance. The tie rule is the "where confidence is sufficient" clause:
 * `bang` sits one edit from nothing in particular, but a token equidistant from
 * two real cities is precisely the §19 case that must be offered, never guessed,
 * and this layer has no way to offer two.
 */
export function bestCorrection(
  token: string,
  vocabulary: readonly string[] = TYPO_VOCABULARY,
): { to: string; confidence: number } | null {
  const t = (token ?? '').toLowerCase().trim();
  if (t.length < MIN_CORRECTABLE_LENGTH) return null;
  if (VOCAB_SET.has(t) || vocabulary.includes(t)) return null;

  let best: { to: string; confidence: number } | null = null;
  let tied = false;
  for (const cand of vocabulary) {
    // A candidate more than a third longer/shorter is not a typo of this token.
    if (Math.abs(cand.length - t.length) > Math.max(2, Math.ceil(t.length / 3))) continue;
    const confidence = typoConfidence(t, cand);
    if (best === null || confidence > best.confidence + 1e-9) {
      best = { to: cand, confidence };
      tied = false;
    } else if (Math.abs(confidence - best.confidence) <= 1e-9) {
      tied = true;
    }
  }
  if (best === null || tied) return null;
  if (best.confidence < SUGGEST_CONFIDENCE) return null;
  return best;
}

/**
 * Correct a whole query. The multi-word vocabulary entries ("chiang mai",
 * "street food") are tried against the WHOLE phrase first, then each token is
 * corrected on its own. At most one correction is reported per query — the
 * strongest — because the client shows one correction row, and because two
 * simultaneous guesses compound into an input the user never typed.
 */
export function correctTypos(
  query: string,
  vocabulary: readonly string[] = TYPO_VOCABULARY,
): { text: string; correction: TypoCorrection | null } {
  const q = (query ?? '').trim();
  if (!q) return { text: q, correction: null };

  const phrase = bestCorrection(q.toLowerCase(), vocabulary);
  const tokens = q.split(/\s+/);
  let tokenBest: { index: number; to: string; confidence: number } | null = null;
  if (tokens.length > 1) {
    tokens.forEach((tok, i) => {
      const hit = bestCorrection(tok, vocabulary);
      if (hit && (tokenBest === null || hit.confidence > tokenBest.confidence)) {
        tokenBest = { index: i, to: hit.to, confidence: hit.confidence };
      }
    });
  }

  const usePhrase =
    phrase !== null && (tokenBest === null || phrase.confidence >= (tokenBest as { confidence: number }).confidence);

  if (usePhrase && phrase) {
    const disposition = phrase.confidence >= APPLY_CONFIDENCE ? 'applied' : 'offered';
    return {
      text: disposition === 'applied' ? phrase.to : q,
      correction: { from: q, to: phrase.to, confidence: phrase.confidence, disposition },
    };
  }
  if (tokenBest) {
    const tb = tokenBest as { index: number; to: string; confidence: number };
    const disposition = tb.confidence >= APPLY_CONFIDENCE ? 'applied' : 'offered';
    const repaired = tokens.map((tok, i) => (i === tb.index ? tb.to : tok)).join(' ');
    return {
      text: disposition === 'applied' ? repaired : q,
      correction: {
        from: tokens[tb.index]!,
        to: tb.to,
        confidence: tb.confidence,
        disposition,
      },
    };
  }
  return { text: q, correction: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The service itself
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the gateway needs out of one normalization pass. */
export interface NormalizedQuery {
  /** The user's text, trimmed and otherwise untouched (§2 raw preservation). */
  raw: string;
  /** `'@'` / `'#'` when the field carried a §26 sigil, else null. */
  sigil: '@' | '#' | null;
  /**
   * The PostgREST-safe key candidate generation runs against FIRST. It is
   * transliterated, emoji-handled and alias-expanded — but never typo-corrected,
   * so the user's own spelling always gets the first query.
   */
  query: string;
  /**
   * The typo-corrected key, present only when the correction cleared
   * {@link APPLY_CONFIDENCE}. The gateway uses it as a SECOND attempt after the
   * user's own spelling returned nothing, which is what makes correction
   * strictly additive: a query that resolves today cannot be rerouted by it.
   */
  correctedQuery: string | null;
  /**
   * The alias-expanded text BEFORE sanitization and before correction — the
   * exact string the §18 semantic parser and the temporal extractor consumed
   * before this service existed, preserved so their behaviour is unchanged.
   */
  aliased: string;
  /** The canonical geographic fold of {@link query} (diacritic + stroke). */
  foldedKey: string;
  /** Set when a script was romanized (§10 transliteration). */
  transliteratedFrom: string | null;
  /** True when emoji were removed from the key for this context (§10). */
  emojiStripped: boolean;
  /** The §10 typo correction, if any, with its confidence and disposition. */
  correction: TypoCorrection | null;
}

export interface NormalizeOptions {
  /** The field context — decides emoji handling (§10 "appropriate to field context"). */
  context: InputContext;
  /** Skip typo correction (e.g. a handle query, where a typo is a different person). */
  allowTypoCorrection?: boolean;
  /** Override the correction vocabulary (tests, and later phases). */
  vocabulary?: readonly string[];
  /** Hard cap on the emitted key. Matches the gateway's existing 80-char clamp. */
  maxLength?: number;
}

/**
 * Normalize once, for everybody (§40).
 *
 * Pipeline, in this order and for these reasons:
 *   1. trim + sigil strip      — `@`/`#` are routing, not query text (§26).
 *   2. transliterate           — a Thai/CJK/Cyrillic query becomes Latin before
 *                                anything else tries to fold or alias it.
 *   3. emoji handling          — context-appropriate; never touches the raw text.
 *   4. applyAliases            — Discovery's curated misspelling/synonym table,
 *                                unchanged, still first claim on a known typo.
 *   5. typo correction         — only what the alias table did NOT already fix.
 *   6. sanitizeQuery + clamp   — the existing PostgREST metacharacter guard.
 */
export function normalizeQuery(text: string, opts: NormalizeOptions): NormalizedQuery {
  const raw = (text ?? '').trim();
  const sigil: '@' | '#' | null = raw.startsWith('@') ? '@' : raw.startsWith('#') ? '#' : null;
  const body = sigil ? raw.slice(1) : raw;

  const romanized = transliterate(body);
  const transliteratedFrom = romanized !== body ? body : null;

  const wantsStrip = stripsEmoji(opts.context);
  const hadEmoji = containsEmoji(romanized);
  const deEmoji = wantsStrip && hadEmoji ? stripEmoji(romanized) : romanized;

  const aliased = applyAliases(deEmoji);

  // Typo correction never runs on a handle: `@jon` and `@jos` are two people,
  // and "correcting" one into the other is the worst possible outcome for a
  // field whose job is identity.
  const allowTypos = opts.allowTypoCorrection !== false && sigil !== '@';
  const { text: corrected, correction } = allowTypos
    ? correctTypos(aliased, opts.vocabulary ?? TYPO_VOCABULARY)
    : { text: aliased, correction: null as TypoCorrection | null };

  const max = opts.maxLength ?? 80;
  const query = sanitizeQuery(aliased).slice(0, max);
  const correctedKey = sanitizeQuery(corrected).slice(0, max);

  return {
    raw,
    sigil,
    query,
    correctedQuery:
      correction?.disposition === 'applied' && correctedKey !== query ? correctedKey : null,
    aliased,
    foldedKey: searchKey(query),
    transliteratedFrom,
    emojiStripped: wantsStrip && hadEmoji,
    correction,
  };
}

/**
 * Project a §10 typo correction as a `correction` assistance row.
 *
 * The row is never destructive and never automatic: its action is
 * `replace_text`, so tapping it is the user's decision and the field is still
 * editable afterwards (§2/§22 — nothing is silently inserted). When the
 * correction was already APPLIED to the search key the row says so, which is
 * §2's "preserve the user's raw input" obligation discharged in the UI: the
 * user can see that `bangkkok` was searched as `bangkok` and can put their own
 * spelling back.
 *
 * Confidence is the measured similarity, clamped strictly below the exact-match
 * band so a correction can never outrank a canonical entity (§9).
 */
export function buildTypoCorrectionRow(
  context: InputContext,
  policyVersion: string,
  correction: TypoCorrection,
): InputSuggestion {
  const applied = correction.disposition === 'applied';
  return {
    id: `${context}:correction:${correction.from}:${correction.to}`,
    type: 'correction',
    context,
    label: applied ? `Showing results for "${correction.to}"` : `Did you mean "${correction.to}"?`,
    subtitle: applied ? `You typed "${correction.from}"` : undefined,
    replacementText: correction.to,
    action: { type: 'replace_text', text: correction.to },
    structuredValue: {
      kind: 'typo_correction',
      from: correction.from,
      to: correction.to,
      confidence: correction.confidence,
      disposition: correction.disposition,
    },
    confidence: Math.min(correction.confidence, 0.9),
    source: 'local',
    reason: 'Spelling correction',
    policyVersion,
  };
}
