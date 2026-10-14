/**
 * Postcards and Memories: writing help that never invents a travel fact
 * (Global Input Intelligence spec §22, "Postcards / Memories: writing
 * assistance without inventing travel facts"; census-input-intelligence G141).
 *
 * WHERE THIS SITS. `aiWriting.ts` owns the §22 path: the per-request opt-in,
 * the `compass_ai_writing_enabled` flag, the one existing model call and the
 * §47 screen. This module adds three things to it, and nothing else:
 *
 *   1. TWO FIELD IDS under the existing `caption` context, `postcard.caption`
 *      and `memory.caption`. No new InputContext: the union stays at the
 *      spec's 29 members (G19, `test/inputPolicyContractParity.test.ts`). Whether
 *      `caption` + a field id is the right home for them is owner question
 *      Q-G141-1; this is its fail-closed default.
 *   2. THE CONTEXT RULE for those two fields. The model is sent the traveller's
 *      own words and nothing else: no city, country, category or date from the
 *      draft, and no Memory, Passport or Trip fact read from the database
 *      (OD-INPUT-3: Compass memory is not used for input assistance by
 *      default). The task tells it to polish, not to add.
 *   3. A DETERMINISTIC CHECK that drops any variant stating something the
 *      traveller did not write. The prompt asks; this check enforces. On the
 *      two fields above it is an ALLOWLIST — every word is the traveller's own
 *      or one of a closed set of connecting and feeling words — and on every
 *      other `caption` a blocklist floor (see `inventedFacts`).
 *
 * AND ONE GATE, for an EXISTING Memory (the edit screen sends its id as
 * `sessionContext.memoryId`): the caption is the Memory's content, so it goes
 * to the model only when the owner's controls allow it. DO_NOT_RESURFACE,
 * KEEP_PRIVATE_FOREVER and RETAIN_BUT_DO_NOT_PERSONALIZE keep it out — the set
 * memoryReaderGuard derives for its model-mediated reader (`compass_tools`),
 * which is the set MEM-NARR-1 (PR #720) applies to the Memory narrative. A
 * Memory that is not the caller's, is deleted, or whose controls cannot be
 * read gets no AI at all. Never throws.
 */
import { readMemoryControls } from '../../services/memory/memoryResurfacingControls';
import { controlsExcluding } from '../../services/memory/memoryReaderGuard';

/** The two §22 writing fields G141 names. Both resolve to the `caption` context. */
export const TRAVEL_WRITING_FIELD_IDS = Object.freeze({
  postcardCaption: 'postcard.caption',
  memoryCaption: 'memory.caption',
} as const);

const TRAVEL_FIELDS: ReadonlySet<string> = new Set<string>(Object.values(TRAVEL_WRITING_FIELD_IDS));

/** True for a Postcard or Memory caption field, whatever context the request named. */
export function isTravelWritingField(fieldId: string | null | undefined): boolean {
  return typeof fieldId === 'string' && TRAVEL_FIELDS.has(fieldId);
}

/** The task for the two fields: polish the traveller's words; add nothing. */
export const TRAVEL_WRITING_TASK =
  "Polish the traveler's OWN words into ONE short caption (under 200 characters), in the language they wrote it in. " +
  'Keep their meaning and their voice. Use their words; add only small connecting words and words of feeling ' +
  '(for example: what a, so, really, loved, great, lovely, unforgettable). Keep every "not", "no" or "wish" they wrote. ' +
  'Add NOTHING they did not write: no place, venue, person, date, day, time, number, food, drink, weather, activity, ' +
  'event, comparison, superlative or emoji.';

// ── The check ─────────────────────────────────────────────────────────────────

/**
 * `hard`   — every `caption` variant (G139's generic caption as well). What is a
 *            fact whatever the words around it, refused unless the traveller
 *            supplied it: a capitalised word in mid-sentence (a name, a venue, a
 *            month), a number, a month or weekday name, a handle, a hashtag, a
 *            link, an emoji or other symbol, and any invisible format character.
 *            A BLOCKLIST: it only refuses what it can name. The floor for every
 *            caption.
 * `travel` — the two G141 fields. An ALLOWLIST. Every word must be one of:
 *              - a word the traveller wrote, compared exactly (with or without a
 *                possessive). No word is stemmed and no plural is guessed: a
 *                plural passes only when the traveller wrote that plural;
 *              - one of CONNECTING_WORDS, a closed vocabulary.
 *            And:
 *              - a word the traveller capitalised in mid-sentence is a NAME: it
 *                may appear only capitalised ("dinner with Sunny" never gives
 *                "a sunny dinner"), and a word capitalised in mid-sentence in
 *                the draft must be capitalised in the traveller's words (the
 *                trade-off this costs is owner question Q-G141-6);
 *              - a number is the WHOLE numeric token ("4.5", "8:30", "1,000",
 *                "5th", "18%") and must equal one the traveller wrote; it keeps
 *                a word beside it that it had there, and it keeps its unit, its
 *                am/pm and its ordinal suffix ("8 pm" never gives "8 am", "5th
 *                day" never "5 days", "18 km" never "18 hours");
 *              - each emoji or flag must be one of the traveller's own emoji, as
 *                a whole (no flag from the junction of two, no part of a family
 *                sequence); any other symbol (`% + → ° $`…) and any invisible
 *                format character the traveller did not write is refused;
 *              - a run of a script without letter case must be a whole token of
 *                the traveller's words (no "北京" from "北京烤鸭");
 *              - negation, absence and wish are COUNTED: the draft has as many of
 *                each as the traveller wrote ("not", "can't" = "cant" = "cannot",
 *                "no", "never", "wish"/"wished"/"wishing", "missed", "closed",
 *                "cancelled", "tried"…), so none is dropped or added.
 *
 * WHAT IT CANNOT CATCH, measured and stated (census-input-intelligence §46.7):
 * a variant built ONLY from the traveller's words and the vocabulary can still
 * re-relate them — re-ordering ("dinner with Marcus" → "Marcus loved dinner"),
 * swapping their own prepositions ("ramen in Tokyo" → "ramen from Tokyo"),
 * moving a negation to another clause, swapping two of their numbers that share
 * a neighbour ("left at 6, back at 11" → "left at 11, back at 6"); an endearment
 * addressed to someone ("…, my love"); a sentence-initial word that is also a
 * name ("Joy. Great dinner tonight"); and other languages.
 */
export type FactLevel = 'hard' | 'travel';

/**
 * The only words a Postcard or Memory caption may add (travel level). Closed,
 * English, lower-case. A word belongs here only if it states nothing about the
 * trip: no place or venue, person, company or relation (so no `we`, `our`,
 * `with`, `you`), date, time, season or month (no `may`), count or order (`one`,
 * `first`, `again`), comparison or ranking (no `best`, `better`, `most`), food or
 * drink, weather, activity, agency or movement (no `made`, `out`, `way`). Feeling
 * and praise are the traveller's polish, not a travel fact. Matched as written
 * or without a possessive — never through a guessed singular. Negations and
 * wishes are here but are counted against the traveller's own (NEGATION_KEY).
 */
export const CONNECTING_WORDS: ReadonlySet<string> = new Set([
  // articles, determiners, conjunctions, prepositions
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for', 'of', 'in', 'on', 'at', 'to', 'from',
  'by', 'about', 'like', 'as', 'than', 'that', 'this', 'these', 'those', 'what', 'which', 'who', 'how', 'why',
  'when', 'where', 'such', 'all', 'every', 'each', 'some', 'any', 'no', 'not', 'nothing', 'everything',
  'something', 'anything', 'if', 'because', 'though', 'although',
  'just', 'only', 'even', 'also', 'too', 'very', 'really', 'truly', 'simply', 'absolutely', 'totally',
  'completely', 'pretty', 'quite', 'ever', 'never', 'forever', 'always', 'still', 'here', 'there',
  'much', 'lot', 'lots', 'bit', 'little', 'enough', 'whole', 'entire', 'own', 'same', 'kind', 'thing',
  'things',
  // first person singular and "it"
  'i', 'me', 'my', 'mine', 'myself', 'it', 'its', 'itself',
  "i'm", "i've", "i'd", "i'll", "it's", "that's", "what's", "here's", "there's",
  "don't", "doesn't", "didn't", "can't", "couldn't", "won't", "wouldn't", "isn't", "wasn't", "aren't", "weren't",
  "haven't", "hasn't", "hadn't", "shouldn't",
  // auxiliaries and modals
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'done', 'have', 'has', 'had',
  'having', 'can', 'could', 'will', 'would', 'should', 'might', 'must',
  // feeling (verbs that report the traveller's own feeling, not an act)
  'love', 'loved', 'loves', 'loving', 'enjoy', 'enjoyed', 'enjoying', 'liked', 'adore', 'adored', 'feel', 'felt',
  'feeling', 'feels', 'miss', 'remember', 'forget', 'want', 'wanted', 'wish', 'hope', 'need', 'worth',
  // praise (no comparatives or superlatives: "the best ramen in Tokyo" is a claim about Tokyo)
  'great', 'good', 'nice', 'lovely', 'amazing', 'amazingly', 'awesome', 'beautiful', 'beautifully', 'perfect',
  'perfectly', 'wonderful', 'wonderfully', 'fantastic', 'incredible', 'incredibly', 'unforgettable', 'memorable',
  'special', 'magical', 'magic', 'fun', 'happy', 'joy', 'joyful', 'favorite', 'favourite', 'cool', 'epic',
  'stunning', 'gorgeous', 'sweet', 'unreal', 'brilliant', 'spectacular', 'breathtaking', 'blissful', 'bliss',
  'dreamy', 'wild', 'crazy', 'pure', 'sheer', 'real', 'true', 'lucky', 'grateful', 'thankful', 'blessed', 'glad',
  'excited', 'proud',
  // words for the moment itself
  'moment', 'moments', 'memory', 'memories', 'time', 'times', 'vibe', 'vibes', 'feelings', 'experience', 'life',
  // interjections
  'oh', 'wow', 'yay', 'ah', 'aww', 'omg', 'lol', 'haha', 'woo', 'yes', 'yeah', 'yep', 'hey',
]);

/**
 * Negation, absence and wish, COUNTED (travel level): the draft must carry as
 * many of each as the traveller wrote — none dropped, none added. "not the best
 * ramen" → "the best ramen", "no sushi" → "sushi", "wished I'd gone to Nobu" →
 * "at Nobu", "Jen couldn't come" → "with Jen", "missed the sunset" → "the
 * sunset" all invert the traveller's words using only their words. Spellings
 * of one negation count as one: "not", "cannot", any "…n't" and the forms
 * travellers type without the apostrophe ("cant", "dont"…) are all `not`;
 * "wish", "wished", "wishing", "wishes" are all `wish`.
 */
const NEGATION_KEY: ReadonlyMap<string, string> = new Map([
  ...['not', 'cannot', 'cant', 'dont', 'wont', 'didnt', 'doesnt', 'isnt', 'wasnt', 'arent', 'werent', 'couldnt',
    'wouldnt', 'shouldnt', 'havent', 'hasnt', 'hadnt', 'aint', 'mustnt', 'neednt', 'mightnt', 'shant', 'darent',
    'oughtnt'].map((w) => [w, 'not'] as const),
  ...['no', 'never', 'nothing', 'none', 'nobody', 'nowhere', 'nor', 'neither', 'without', 'almost', 'nearly',
    'hardly', 'barely', 'except', 'instead', 'unable'].map((w) => [w, w] as const),
  // A wish or a want, and the absence words, in every inflection: the key is the stem.
  ...stemKeys({
    wish: ['wish', 'wishes', 'wished', 'wishing'], want: ['want', 'wants', 'wanted', 'wanting'],
    hope: ['hope', 'hopes', 'hoped', 'hoping'], miss: ['miss', 'misses', 'missed', 'missing'],
    close: ['close', 'closes', 'closed', 'closing'], cancel: ['cancel', 'cancels', 'cancelled', 'canceled', 'cancelling', 'canceling'],
    try: ['try', 'tries', 'tried', 'trying'], skip: ['skip', 'skips', 'skipped', 'skipping'],
    lose: ['lose', 'loses', 'lost', 'losing'], fail: ['fail', 'fails', 'failed', 'failing'],
    postpone: ['postpone', 'postpones', 'postponed', 'postponing'], delay: ['delay', 'delays', 'delayed', 'delaying'],
    shut: ['shut', 'shuts', 'shutting'], sell: ['sold'], forget: ['forget', 'forgets', 'forgot', 'forgotten', 'forgetting'],
  }),
]);

function stemKeys(groups: Record<string, readonly string[]>): Array<readonly [string, string]> {
  return Object.entries(groups).flatMap(([key, forms]) => forms.map((f) => [f, key] as const));
}

/** Two-word wishes and counterfactuals, counted like the words above: "if only", "would have", "could've"… */
const NEGATION_PAIRS: ReadonlyMap<string, string> = new Map([
  ['if only', 'if only'], ['would have', 'would have'], ['could have', 'could have'], ['should have', 'should have'],
  ["would've", 'would have'], ["could've", 'could have'], ["should've", 'should have'], ["i'd have", 'would have'],
]);

/** A number's neighbour that is part of what the number says: its unit, its am/pm, its ordinal suffix. It must stay. */
const NUMBER_UNITS: ReadonlySet<string> = new Set([
  'am', 'pm', 'st', 'nd', 'rd', 'th', 'km', 'kms', 'm', 'mi', 'mile', 'miles', 'ft', 'kg', 'g', 'lb', 'lbs', 'h', 'hr',
  'hrs', 'hour', 'hours', 'min', 'mins', 'minute', 'minutes', 'sec', 'secs', 'second', 'seconds', 'day', 'days',
  'night', 'nights', 'week', 'weeks', 'month', 'months', 'year', 'years', 'yen', 'usd', 'eur', 'dollar', 'dollars',
  'euro', 'euros', 'baht', 'dong', 'peso', 'pesos', 'percent', 'x', 'k', 'people', 'person', 'times',
]);

/**
 * Month and weekday names: a date, in any case (hard level). Words that are
 * also ordinary words (`may`, `march`, `sun`, `sat`, `wed`, `mon`) are left to
 * the name rule, which catches their capitalised, mid-sentence form.
 */
const CALENDAR: ReadonlySet<string> = new Set([
  'january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'tue', 'tues', 'thu', 'thur', 'thurs', 'fri',
]);

/** "I" and its contractions are capitalised everywhere and state nothing. */
const FIRST_PERSON: ReadonlySet<string> = new Set(['i', "i'm", "i've", "i'd", "i'll"]);

/**
 * A word: letters, combining marks and digits, with inner apostrophes. A
 * number is the WHOLE numeric token: "." "," ":" "/" "-" "–" between digits join
 * it ("4.5", "1,000", "8:30", "12/3", "12-3"), "% ‰ ° ′ ″" after a digit stay on
 * it ("18%"), and a currency sign or a minus/dash before it, with no letter or
 * digit before that, joins it too ("$18", "-5"): "$18" is not "18". A hyphen
 * SEPARATES, so each half is judged on its own. Emoji (with their variation
 * selectors) are taken out first (EMOJI_RE), so a combining mark left standing
 * on its own is judged like a word: it must be the traveller's.
 */
const WORD_RE = /(?:(?<![\p{L}\p{M}\p{N}])[-\u{2013}]?\p{Sc}?(?=\p{Nd}))?[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}]|'(?=[\p{L}\p{M}\p{N}])|(?<=\p{Nd})[.,:/\-\u{2013}](?=\p{Nd})|(?<=\p{Nd})[%‰°′″])*/gu;
const HANDLE_OR_TAG_RE = /[@#][\p{L}\p{N}_][\p{L}\p{N}_.]*/gu;
/** A link, as its domain ("nobu.com", "www.nobu.com", "https://x.io/…"): even one built from words the traveller wrote apart. */
const DOMAIN_RE = /[\p{L}\p{N}][\p{L}\p{N}-]*\.[a-z]{2,}(?:\.[a-z]{2,})?(?![\p{L}\p{N}])/giu;
/**
 * One emoji as a reader sees it: a flag (two regional indicators), or a
 * pictograph with its variation selector, skin tone, keycap, tag sequence and
 * zero-width-joined parts. A flag is a country, 🍣 a dish, 👫 a relation.
 */
const EMOJI_RE = /\p{Regional_Indicator}{2}|[\p{Extended_Pictographic}\p{Regional_Indicator}](?:[\u{FE0E}\u{FE0F}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]|\u200D[\p{Extended_Pictographic}\p{Regional_Indicator}])*/gu;

/** Every apostrophe a keyboard produces (’ ‘ ` ´ ʼ ʻ ˈ ＇) is one apostrophe, so "can´t" is "can't". */
function fold(s: string): string {
  return s.normalize('NFC').replace(/[\u{2019}\u{2018}\u{60}\u{B4}\u{2BC}\u{2BB}\u{2C8}\u{FF07}]/gu, "'");
}

function stripPossessive(w: string): string {
  return w.endsWith("'s") ? w.slice(0, -2) : w;
}

interface Token { raw: string; lower: string; index: number; end: number; starts: boolean }

/** True when the word at `index` opens a sentence: nothing but punctuation, space or emoji before it since the last full stop. */
function opensSentence(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (/[.!?…\n]/u.test(ch)) return true;
    if (/[\p{L}\p{N}]/u.test(ch)) return false;
  }
  return true;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const index = m.index ?? 0;
    out.push({ raw: stripPossessive(m[0]), lower: stripPossessive(m[0].toLowerCase()), index, end: index + m[0].length, starts: opensSentence(text, index) });
  }
  return out;
}

const hasDigit = (w: string) => /\p{Nd}/u.test(w);
const isCaseless = (w: string) => /\p{Lo}/u.test(w);
const isCapitalised = (w: string) => /^[\p{Lu}\p{Lt}]/u.test(w);
/** The negation, absence or wish a word carries, or null. */
const negationKey = (w: string): string | null => NEGATION_KEY.get(w) ?? (w.endsWith("n't") ? 'not' : null);
/**
 * True when the vocabulary word `w` (4+ letters, so "it"/"unit" and "to"/"into" never collide) is the un-/dis- form
 * of one of the traveller's words, or theirs is the un-/dis- form of `w`.
 */
function inverts(w: string, known: ReadonlySet<string>): boolean {
  if (w.length < 4) return false;
  for (const pre of ['un', 'dis']) {
    if (known.has(pre + w)) return true;
    if (w.startsWith(pre) && w.length >= pre.length + 4 && known.has(w.slice(pre.length))) return true;
  }
  return false;
}
/** "GREAT", "TOKYO": shouting, not a name signal (a name is Capitalised, not all capitals). */
const isAllCaps = (w: string) => /\p{L}{2,}/u.test(w) && w === w.toUpperCase() && w !== w.toLowerCase();
/** An emoji compared as the reader sees it: without its text/emoji presentation selector. */
const emojiKey = (e: string) => e.replace(/[\u{FE0E}\u{FE0F}]/gu, '');

/**
 * Where a traveller's number sits: the number as written (or compacted, "8 pm"
 * → "8pm") and the words either side of it. `mustPrev`/`mustNext` are the
 * neighbours that are part of what the number SAYS — the letters of its own
 * token ("5" in "5th" must keep "th"), or a unit, am/pm or ordinal written
 * after it ("8 pm" must keep "pm") — and must stay.
 */
interface NumberAt { form: string; prev: string | null; next: string | null; mustPrev?: string; mustNext?: string }

/** Every number the traveller wrote, as a whole token, with its neighbours. */
function groundNumbers(g: readonly Token[], text: string): NumberAt[] {
  const out: NumberAt[] = [];
  const at = (i: number) => (i >= 0 && i < g.length ? g[i]!.lower : null);
  const unit = (w: string | null) => (w !== null && NUMBER_UNITS.has(w) ? w : undefined);
  for (let i = 0; i < g.length; i++) {
    const t = g[i]!;
    if (!hasDigit(t.lower)) continue;
    out.push({ form: t.lower, prev: at(i - 1), next: at(i + 1), mustNext: unit(at(i + 1)) });
    // The number inside a mixed token ("8pm", "21st"): the whole numeric run, and the token's own letters are its
    // mandatory neighbours on their side — "8pm" may become "8 pm", never "8 am"; "5th" never "5 days".
    if (/\p{L}/u.test(t.lower)) {
      for (const r of t.lower.matchAll(/\p{Nd}+(?:[.,:]\p{Nd}+)*/gu)) {
        const s = r.index ?? 0;
        const before = t.lower.slice(0, s).match(/\p{L}+$/u)?.[0];
        const after = t.lower.slice(s + r[0].length).match(/^\p{L}+/u)?.[0];
        out.push({ form: r[0], prev: before ?? at(i - 1), next: after ?? at(i + 1), mustPrev: before, mustNext: after ?? unit(at(i + 1)) });
      }
    }
    // A number and the word it is written against, joined ("8 pm" → "8pm"): only digits+letters, never two numbers.
    for (const j of [i - 1, i + 1]) {
      const u = j >= 0 && j < g.length ? g[j]! : null;
      if (!u || hasDigit(u.lower) || !/^\p{L}+$/u.test(u.lower)) continue;
      const [a, b] = j < i ? [u, t] : [t, u];
      if (!/^\s+$/u.test(text.slice(a.end, b.index))) continue;
      const lo = Math.min(i, j), hi = Math.max(i, j);
      out.push({ form: a.lower + b.lower, prev: at(lo - 1), next: at(hi + 1) });
    }
  }
  return out;
}

/**
 * What a variant states that the traveller did not. Empty means the variant
 * may be shown. `ground` is everything the traveller supplied for this request:
 * for the two G141 fields, their own words and nothing else; for any other
 * caption, their words plus the coarse fields they sent (§29). Each finding is
 * `class:word` — for tests only, never logged (it is model output over the
 * traveller's own text).
 */
export function inventedFacts(variant: string, ground: readonly string[], level: FactLevel): string[] {
  const travel = level === 'travel';
  const rawText = fold(String(variant ?? ''));
  const groundRaw = fold(ground.filter((g) => typeof g === 'string').join('\n'));
  const groundLower = groundRaw.toLowerCase();
  const findings: string[] = [];

  // Emoji and flags: each must be one of the traveller's own emoji AS A WHOLE — never a flag read across the junction
  // of two of theirs, never part of their family sequence. Judged, then blanked out.
  const groundEmoji = new Set([...groundRaw.matchAll(EMOJI_RE)].map((m) => emojiKey(m[0])));
  for (const m of rawText.matchAll(EMOJI_RE)) if (!groundEmoji.has(emojiKey(m[0]))) findings.push(`emoji:${m[0]}`);
  const text = rawText.replace(EMOJI_RE, ' ');
  const groundText = groundRaw.replace(EMOJI_RE, ' ');
  // Any other symbol — currency, maths and arrows (`$ + → =`), `%`, `°`… — the traveller did not write.
  for (const m of text.matchAll(/[\p{S}%‰′″*†‡§¶/]/gu)) if (!groundText.includes(m[0])) findings.push(`symbol:${m[0]}`);
  // An invisible format character outside an emoji splits or hides a word ("To\u200Bby" reads "Toby").
  for (const m of text.matchAll(/\p{Cf}/gu)) findings.push(`invisible:U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`);

  // Handles, hashtags and links are facts verbatim: the traveller wrote them or they are not here.
  // Each one equal to one of the traveller's own, whole — never a prefix ("@marcus" is not "@marcus_k").
  const refKey = (r: string) => r.toLowerCase().replace(/\.+$/u, '');
  const groundRefs = new Set([...groundText.matchAll(HANDLE_OR_TAG_RE), ...groundText.matchAll(DOMAIN_RE)].map((m) => refKey(m[0])));
  for (const m of text.matchAll(HANDLE_OR_TAG_RE)) if (!groundRefs.has(refKey(m[0]))) findings.push(`ref:${m[0]}`);
  for (const m of text.matchAll(DOMAIN_RE)) if (!groundRefs.has(refKey(m[0]))) findings.push(`link:${m[0]}`);

  const g = tokens(groundText);
  const d = tokens(text);
  // The traveller's words, exactly. A word they capitalised in mid-sentence (not shouting) is a NAME: it is known only
  // capitalised, never as a lower-case word ("dinner with Sunny" gives no "sunny"). No plural is guessed.
  const knownLower = new Set<string>();
  const knownCased = new Set<string>();
  const knownAnyCase = new Set<string>();
  for (const t of g) {
    knownAnyCase.add(t.lower);
    knownCased.add(t.raw);
    const name = isCapitalised(t.raw) && !t.starts && !isAllCaps(t.raw) && !FIRST_PERSON.has(t.lower);
    if (!name) knownLower.add(t.lower);
    // The letters beside a number ("pm" in "8pm") are words the traveller wrote.
    if (hasDigit(t.lower)) for (const r of t.lower.matchAll(/\p{L}+/gu)) { knownLower.add(r[0]); knownAnyCase.add(r[0]); }
  }
  const numbers = groundNumbers(g, groundText);

  for (let i = 0; i < d.length; i++) {
    const t = d[i]!;
    const prev = i > 0 ? d[i - 1]!.lower : null;
    const next = i + 1 < d.length ? d[i + 1]!.lower : null;

    // A number: one the traveller wrote as a whole token; at the travel level, still beside a word it had there and
    // with its unit, am/pm or ordinal suffix.
    if (hasDigit(t.lower)) {
      // A unit written after the draft's number must be one the number had: "2" never gains "am" or "times".
      const gainsUnit = next !== null && NUMBER_UNITS.has(next);
      const ok = numbers.some((n) => n.form === t.lower
        && (!travel || ((n.mustPrev === undefined || n.mustPrev === prev) && (n.mustNext === undefined || n.mustNext === next)
          && (!gainsUnit || n.mustNext === next)
          && ((n.prev !== null && n.prev === prev) || (n.next !== null && n.next === next)))));
      if (!ok) findings.push(`number:${t.raw}`);
      continue;
    }

    // A script without letter case: no name can be told from a word, so it must be a whole token the traveller wrote.
    if (isCaseless(t.lower)) {
      if (travel && !g.some((u) => u.raw === t.raw)) findings.push(`caseless:${t.raw}`);
      continue;
    }

    const capitalisedMid = isCapitalised(t.raw) && !t.starts && !FIRST_PERSON.has(t.lower);

    if (travel) {
      // A capitalised word in mid-sentence is a name: the traveller's, as they capitalised it, or refused.
      if (capitalisedMid) { if (!knownCased.has(t.raw)) findings.push(`name:${t.raw}`); continue; }
      // A name of theirs may open a sentence as written ("Marcus loved it").
      if (t.starts && knownCased.has(t.raw)) continue;
      // The allowlist: the traveller's words (names only as names) or the closed connecting vocabulary — nothing else.
      if (!knownLower.has(t.lower) && !CONNECTING_WORDS.has(t.lower)) { findings.push(`word:${t.raw}`); continue; }
      // A vocabulary word that inverts one of theirs: "happy" for their "unhappy", "liked" for "disliked",
      // "unforgettable" for "forgettable".
      if (!knownLower.has(t.lower) && inverts(t.lower, knownLower)) findings.push(`inverted:${t.raw}`);
      continue;
    }

    // hard: a month or weekday name, and a capitalised word in mid-sentence (a name, a venue).
    if (knownAnyCase.has(t.lower)) continue;
    if (CALENDAR.has(t.lower)) { findings.push(`date:${t.raw}`); continue; }
    if (capitalisedMid) findings.push(`name:${t.raw}`);
  }

  // Negation, absence and wish, counted: as many of each as the traveller wrote — none dropped, none added.
  if (travel) {
    const count = (ts: readonly Token[]) => {
      const c = new Map<string, number>();
      const add = (k: string) => c.set(k, (c.get(k) ?? 0) + 1);
      for (let i = 0; i < ts.length; i++) {
        const k = negationKey(ts[i]!.lower); if (k) add(k);
        const pair = NEGATION_PAIRS.get(ts[i]!.lower) ?? (i + 1 < ts.length ? NEGATION_PAIRS.get(`${ts[i]!.lower} ${ts[i + 1]!.lower}`) : undefined);
        if (pair) add(pair);
      }
      return c;
    };
    const gNeg = count(g), dNeg = count(d);
    for (const [k, n] of gNeg) if ((dNeg.get(k) ?? 0) < n) findings.push(`dropped:${k}`);
    for (const [k, n] of dNeg) if ((gNeg.get(k) ?? 0) < n) findings.push(`added:${k}`);
  }
  return findings;
}

// ── The Memory gate (edit screen) ─────────────────────────────────────────────

/** The controls that keep a Memory's caption from the model: memoryReaderGuard's model-mediated reader, as MEM-NARR-1. */
export const TRAVEL_WRITING_EXCLUDING_CONTROLS = controlsExcluding('compass_tools');

export type TravelWritingGate =
  | { open: true }
  | { open: false; reason: 'memory_not_found' | 'memory_unreadable' | 'excluded_by_control' | 'controls_unreadable' };

/**
 * May this request's text go to the model? Open for a Postcard caption and for
 * a NEW Memory (no id: nothing is stored yet, so no control can exist). For an
 * existing Memory, open only when it is the caller's own, not deleted, and
 * carries none of the three controls; every read that fails closes it.
 */
export async function travelWritingGate(
  sc: any,
  p: { fieldId: string | null | undefined; userId: string | null | undefined; memoryId: string | null | undefined },
): Promise<TravelWritingGate> {
  if (p.fieldId !== TRAVEL_WRITING_FIELD_IDS.memoryCaption || !p.memoryId) return { open: true };
  const userId = typeof p.userId === 'string' ? p.userId : '';
  if (!userId) return { open: false, reason: 'memory_not_found' };
  type MemoryOwnerRow = { id?: unknown; owner_id?: unknown; state?: unknown };
  let row: MemoryOwnerRow | null = null;
  try {
    const { data, error } = await sc.from('memories').select('id, owner_id, state').eq('id', p.memoryId).maybeSingle();
    if (error) return { open: false, reason: 'memory_unreadable' };
    row = (data as MemoryOwnerRow | null) ?? null;
  } catch {
    return { open: false, reason: 'memory_unreadable' };
  }
  if (!row || row.owner_id !== userId || row.state === 'deleted' || row.state === 'removed') {
    return { open: false, reason: 'memory_not_found' };
  }
  const read = await readMemoryControls(sc, userId, [p.memoryId]);
  if (read.state === 'absent') return { open: true }; // 3671 not applied: no control can exist
  if (read.state === 'unreadable') return { open: false, reason: 'controls_unreadable' };
  for (const c of read.byMemory.get(p.memoryId) ?? []) {
    if (TRAVEL_WRITING_EXCLUDING_CONTROLS.has(c)) return { open: false, reason: 'excluded_by_control' };
  }
  return { open: true };
}
