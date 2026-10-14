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
 *              - a word the traveller wrote, compared exactly (any case at the
 *                start of a sentence, with or without a possessive). The draft
 *                word is NEVER stemmed; a plural is accepted only when the
 *                traveller wrote its singular in lower case (3+ letters, not a
 *                connecting word), never from a name;
 *              - one of CONNECTING_WORDS, a closed vocabulary.
 *            And:
 *              - a word capitalised in mid-sentence must appear capitalised in
 *                the traveller's words (a name stays the traveller's name);
 *              - a number must be one the traveller wrote, as a whole token, and
 *                keep a word beside it that it had there (no "18 trips" from
 *                "table 18", no "1" from "18");
 *              - emoji, flags and symbols must appear in the traveller's words
 *                exactly; any invisible format character is refused;
 *              - a run of a script without letter case must be a whole token of
 *                the traveller's words (no "北京" from "北京烤鸭");
 *              - every negation or wish the traveller wrote must stay, and none
 *                may be added (no "Sushi tonight!" from "no sushi tonight").
 *
 * WHAT IT CANNOT CATCH, measured and stated (census-input-intelligence §46.7):
 * a variant built ONLY from the traveller's words and the vocabulary can still
 * re-relate them — re-ordering ("dinner with Marcus" → "Marcus made dinner" is
 * refused only because `made` is not in the vocabulary; "Marcus and dinner"
 * re-ordered is not), swapping their own prepositions ("ramen in Tokyo" →
 * "ramen from Tokyo"), an endearment addressed to someone ("…, my love"), and a
 * sentence-initial word that is also a name ("Joy. Great dinner tonight").
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
 * wishes are here but are held to the traveller's own (NEGATIONS).
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
 * Negation, absence and wish: a draft must keep every one the traveller wrote
 * and add none (travel level). "not the best ramen" → "the best ramen", "no
 * sushi" → "sushi", "wish I'd gone to Nobu" → "at Nobu", "Jen couldn't come" →
 * "with Jen" all invert the traveller's words using only their words. Any word
 * ending in "n't" counts too.
 */
const NEGATIONS: ReadonlySet<string> = new Set([
  'not', 'no', 'never', 'nothing', 'none', 'nobody', 'nowhere', 'nor', 'neither', 'without', 'cannot', 'wish',
  'almost', 'nearly', 'hardly', 'barely', 'except', 'instead',
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
 * hyphen SEPARATES, so each half is judged on its own. Emoji (with their
 * variation selectors) are taken out first (EMOJI_RE), so a combining mark left
 * standing on its own is judged like a word: it must be the traveller's.
 */
const WORD_RE = /[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}']*[\p{L}\p{M}\p{N}])?/gu;
const HANDLE_OR_TAG_RE = /[@#][\p{L}\p{N}_][\p{L}\p{N}_.]*/gu;
const LINK_RE = /(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/giu;
/**
 * One emoji as a reader sees it: a flag (two regional indicators), or a
 * pictograph with its variation selector, skin tone, keycap, tag sequence and
 * zero-width-joined parts. A flag is a country, 🍣 a dish, 👫 a relation.
 */
const EMOJI_RE = /\p{Regional_Indicator}{2}|[\p{Extended_Pictographic}\p{Regional_Indicator}](?:[\u{FE0E}\u{FE0F}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]|\u200D[\p{Extended_Pictographic}\p{Regional_Indicator}])*/gu;

function fold(s: string): string {
  return s.normalize('NFC').replace(/[’‘`]/g, "'");
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
const isNegation = (w: string) => NEGATIONS.has(w) || w.endsWith("n't");

/** Where a traveller's number sits: the number as written (or compacted, "8 pm" → "8pm") and the words either side of it. */
interface NumberAt { form: string; prev: string | null; next: string | null }

/** Every number the traveller wrote, as a whole token, with its neighbours. */
function groundNumbers(g: readonly Token[], text: string): NumberAt[] {
  const out: NumberAt[] = [];
  const at = (i: number) => (i >= 0 && i < g.length ? g[i]!.lower : null);
  for (let i = 0; i < g.length; i++) {
    const t = g[i]!;
    if (!hasDigit(t.lower)) continue;
    out.push({ form: t.lower, prev: at(i - 1), next: at(i + 1) });
    // The digits inside a mixed token ("8pm", "21st"), maximal runs only: "8" with "pm" beside it, never "1" from "21st".
    if (/\p{L}/u.test(t.lower)) {
      for (const r of t.lower.matchAll(/\p{Nd}+/gu)) {
        const s = r.index ?? 0;
        const before = t.lower.slice(0, s).match(/\p{L}+$/u)?.[0] ?? null;
        const after = t.lower.slice(s + r[0].length).match(/^\p{L}+/u)?.[0] ?? null;
        out.push({ form: r[0], prev: before ?? at(i - 1), next: after ?? at(i + 1) });
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

  // Emoji, flags and symbols: the traveller's own, verbatim, or refused. Judged as a whole and then blanked out.
  for (const m of rawText.matchAll(EMOJI_RE)) if (!groundRaw.includes(m[0])) findings.push(`emoji:${m[0]}`);
  const text = rawText.replace(EMOJI_RE, ' ');
  const groundText = groundRaw.replace(EMOJI_RE, ' ');
  for (const m of text.matchAll(/[\p{So}\p{Sc}]/gu)) if (!groundRaw.includes(m[0])) findings.push(`symbol:${m[0]}`);
  // An invisible format character outside an emoji splits or hides a word ("To\u200Bby" reads "Toby").
  for (const m of text.matchAll(/\p{Cf}/gu)) findings.push(`invisible:U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`);

  // Handles, hashtags and links are facts verbatim: the traveller wrote them or they are not here.
  for (const m of text.matchAll(HANDLE_OR_TAG_RE)) if (!groundLower.includes(m[0].toLowerCase())) findings.push(`ref:${m[0]}`);
  for (const m of text.matchAll(LINK_RE)) if (!groundLower.includes(m[0].toLowerCase())) findings.push(`link:${m[0]}`);

  const g = tokens(groundText);
  const d = tokens(text);
  // The traveller's words, exactly: lower-case, and as capitalised in mid-sentence (their names).
  const knownLower = new Set<string>();
  const knownCased = new Set<string>();
  const plurals = new Set<string>();
  for (const t of g) {
    knownLower.add(t.lower);
    knownCased.add(t.raw);
    // The letters beside a number ("pm" in "8pm") are words the traveller wrote.
    if (hasDigit(t.lower)) for (const r of t.lower.matchAll(/\p{L}+/gu)) knownLower.add(r[0]);
    // A plural only FROM a lower-case word the traveller wrote (or one opening a sentence): never from a name.
    const plain = !isCapitalised(t.raw) || t.starts;
    if (plain && t.lower.length >= 3 && !CONNECTING_WORDS.has(t.lower) && /^\p{Ll}+$/u.test(t.lower)) {
      plurals.add(`${t.lower}s`);
      plurals.add(`${t.lower}es`);
      if (t.lower.endsWith('y')) plurals.add(`${t.lower.slice(0, -1)}ies`);
    }
  }
  const numbers = groundNumbers(g, groundText);

  for (let i = 0; i < d.length; i++) {
    const t = d[i]!;
    const prev = i > 0 ? d[i - 1]!.lower : null;
    const next = i + 1 < d.length ? d[i + 1]!.lower : null;

    // A number: one the traveller wrote as a whole token; at the travel level, still beside a word it had there.
    if (hasDigit(t.lower)) {
      const ok = numbers.some((n) => n.form === t.lower
        && (!travel || (n.prev !== null && n.prev === prev) || (n.next !== null && n.next === next)));
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
      // The allowlist: the traveller's words, a plural of one, or the closed connecting vocabulary — nothing else.
      if (!knownLower.has(t.lower) && !plurals.has(t.lower) && !CONNECTING_WORDS.has(t.lower)) findings.push(`word:${t.raw}`);
      continue;
    }

    // hard: a month or weekday name, and a capitalised word in mid-sentence (a name, a venue).
    if (knownLower.has(t.lower)) continue;
    if (CALENDAR.has(t.lower)) { findings.push(`date:${t.raw}`); continue; }
    if (capitalisedMid) findings.push(`name:${t.raw}`);
  }

  // Negation and wish: every one the traveller wrote stays, and none is added.
  if (travel) {
    const gNeg = new Set(g.map((t) => t.lower).filter(isNegation));
    const dNeg = new Set(d.map((t) => t.lower).filter(isNegation));
    for (const w of gNeg) if (!dNeg.has(w)) findings.push(`dropped:${w}`);
    for (const w of dNeg) if (!gNeg.has(w)) findings.push(`added:${w}`);
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
