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
  '(for example: what a, so, really, loved, great, lovely, unforgettable). Add NOTHING they did not write: no place, ' +
  'venue, person, date, day, time, number, food, drink, weather, activity or event.';

// ── The check ─────────────────────────────────────────────────────────────────

/**
 * `hard`   — every `caption` variant (G139's generic caption as well). What is a
 *            fact whatever the words around it: a capitalised word in
 *            mid-sentence (a name, a venue, a month), a number in digits, a month
 *            or weekday name, a handle, a hashtag, a link. A BLOCKLIST, so it only
 *            refuses what it can name; it is the floor for every caption.
 * `travel` — the two G141 fields. An ALLOWLIST: every word must be one the
 *            traveller wrote (in any case, singular or plural, with or without
 *            a possessive) or one of CONNECTING_WORDS, a closed vocabulary of
 *            function words, first-person and addressee pronouns, auxiliaries,
 *            and words of feeling and praise that state no place, person,
 *            date, time, count, food, weather or activity. Anything else —
 *            a word the list does not know, in any language — is refused.
 *            Handles, links and digits are held to the traveller's own as at
 *            the hard level, and a run of a script without letter case must
 *            appear in the traveller's words as written.
 *
 * WHAT THE ALLOWLIST CANNOT CATCH, stated rather than discovered: a variant
 * that REARRANGES the traveller's own words into a different claim ("dinner
 * with Marcus" → "Marcus made dinner") uses only their words and passes. The
 * task forbids it and the traveller sees and edits every proposal before it is
 * used (§22); no word they did not write can appear.
 */
export type FactLevel = 'hard' | 'travel';

/**
 * The only words a Postcard or Memory caption may add (travel level). Closed,
 * English, lower-case. A word belongs here only if it states nothing about the
 * trip: no place or venue, person or company (so no `we`, `our`, `they`), date,
 * time or season, count or order (`one`, `first`, `again`), food or drink,
 * weather, activity or movement (`went`, `visited`). Feeling and praise are
 * the traveller's polish, not a travel fact. Matched as written or without a
 * possessive — never through a guessed singular, so `goods`/`news` do not ride
 * in on `good`/`new`.
 */
export const CONNECTING_WORDS: ReadonlySet<string> = new Set([
  // articles, determiners, conjunctions, prepositions
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for', 'of', 'in', 'on', 'at', 'to', 'from', 'with',
  'by', 'about', 'like', 'as', 'than', 'that', 'this', 'these', 'those', 'what', 'which', 'who', 'how', 'why',
  'when', 'where', 'such', 'all', 'every', 'each', 'some', 'any', 'no', 'not', 'nothing', 'everything',
  'something', 'anything', 'if', 'because', 'though', 'although', 'into', 'onto', 'up', 'out', 'off', 'over',
  'through', 'just', 'only', 'even', 'also', 'too', 'very', 'really', 'truly', 'simply', 'absolutely', 'totally',
  'completely', 'pretty', 'quite', 'ever', 'never', 'forever', 'always', 'still', 'here', 'there', 'more', 'most',
  'much', 'lot', 'lots', 'bit', 'little', 'enough', 'whole', 'entire', 'own', 'same', 'kind', 'way', 'thing',
  'things',
  // first person singular, the reader, and "it"
  'i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself', 'it', 'its', 'itself',
  "i'm", "i've", "i'd", "i'll", "it's", "that's", "what's", "here's", "there's", "you're", "you've", "you'll",
  "don't", "doesn't", "didn't", "can't", "couldn't", "won't", "wouldn't", "isn't", "wasn't", "aren't", "weren't",
  "haven't", "hasn't", "hadn't", "shouldn't",
  // auxiliaries and modals
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'done', 'have', 'has', 'had',
  'having', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must',
  // feeling (verbs that report the traveller's own feeling, not an act)
  'love', 'loved', 'loves', 'loving', 'enjoy', 'enjoyed', 'enjoying', 'liked', 'adore', 'adored', 'feel', 'felt',
  'feeling', 'feels', 'miss', 'remember', 'forget', 'want', 'wanted', 'wish', 'hope', 'need', 'made', 'make',
  'worth',
  // praise
  'great', 'greater', 'greatest', 'good', 'better', 'best', 'nice', 'nicer', 'nicest', 'lovely', 'loveliest',
  'amazing', 'amazingly', 'awesome', 'beautiful', 'beautifully', 'perfect', 'perfectly', 'wonderful',
  'wonderfully', 'fantastic', 'incredible', 'incredibly', 'unforgettable', 'memorable', 'special', 'magical',
  'magic', 'fun', 'happy', 'happiest', 'joy', 'joyful', 'favorite', 'favourite', 'cool', 'coolest', 'epic',
  'stunning', 'gorgeous', 'sweet', 'sweetest', 'unreal', 'brilliant', 'spectacular', 'breathtaking', 'blissful',
  'bliss', 'dreamy', 'wild', 'crazy', 'pure', 'sheer', 'real', 'true', 'lucky', 'grateful', 'thankful', 'blessed',
  'glad', 'excited', 'proud',
  // words for the moment itself
  'moment', 'moments', 'memory', 'memories', 'time', 'times', 'vibe', 'vibes', 'feelings', 'experience', 'life',
  // interjections
  'oh', 'wow', 'yay', 'ah', 'aww', 'omg', 'lol', 'haha', 'woo', 'yes', 'yeah', 'yep', 'hey',
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
 * A word: it starts with a letter or digit, then letters, combining marks and
 * digits, with inner apostrophes. A hyphen SEPARATES, so each half is judged on
 * its own; a lone mark (an emoji's variation selector) is not a word.
 */
const WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}']*[\p{L}\p{M}\p{N}])?/gu;
const HANDLE_OR_TAG_RE = /[@#][\p{L}\p{N}_][\p{L}\p{N}_.]*/gu;
const LINK_RE = /(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/giu;

function fold(s: string): string {
  return s.normalize('NFC').replace(/[’‘`]/g, "'");
}

function stripPossessive(w: string): string {
  return w.endsWith("'s") ? w.slice(0, -2) : w;
}

/**
 * The forms a word is matched against the TRAVELLER'S words under: itself,
 * without a possessive, and a naive singular — so "dinners" is the traveller's
 * "dinner". Only for the ground: CONNECTING_WORDS is matched without guessing.
 */
function forms(word: string): string[] {
  const w = stripPossessive(word.toLowerCase());
  const out = new Set<string>([word.toLowerCase(), w]);
  if (w.length > 3 && w.endsWith('ies')) out.add(`${w.slice(0, -3)}y`);
  if (w.length > 3 && w.endsWith('es')) out.add(w.slice(0, -2));
  if (w.length > 2 && w.endsWith('s')) out.add(w.slice(0, -1));
  return [...out];
}

/** Every form of every word in what the traveller (and only the traveller) supplied. */
function groundWords(ground: string): Set<string> {
  const out = new Set<string>();
  for (const m of ground.matchAll(WORD_RE)) for (const f of forms(m[0])) out.add(f);
  return out;
}

/** True when the word at `index` opens a sentence: nothing but punctuation, space or emoji before it since the last full stop. */
function opensSentence(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (/[.!?…\n]/u.test(ch)) return true;
    if (/[\p{L}\p{N}]/u.test(ch)) return false;
  }
  return true;
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
  const text = fold(String(variant ?? ''));
  const groundText = fold(ground.filter((g) => typeof g === 'string').join('\n'));
  const groundLower = groundText.toLowerCase();
  const groundCompact = groundLower.replace(/\s+/g, '');
  const known = groundWords(groundText);
  const isKnown = (w: string) => forms(w).some((f) => known.has(f));
  const findings: string[] = [];

  // Handles, hashtags and links are facts verbatim: the traveller wrote them or they are not here.
  // (The words inside one are judged again below; a word the traveller wrote passes there too.)
  for (const m of text.matchAll(HANDLE_OR_TAG_RE)) {
    if (!groundLower.includes(m[0].toLowerCase())) findings.push(`ref:${m[0]}`);
  }
  for (const m of text.matchAll(LINK_RE)) {
    if (!groundLower.includes(m[0].toLowerCase())) findings.push(`link:${m[0]}`);
  }

  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0];
    const lower = word.toLowerCase();
    const index = m.index ?? 0;

    // A number in digits ("3rd", "8pm", "2019") is a count, a date or a time.
    if (/\p{Nd}/u.test(word)) {
      if (!known.has(lower) && !groundCompact.includes(lower)) findings.push(`number:${word}`);
      continue;
    }

    // A script without letter case: no name can be told from a word, so the whole run must be the traveller's.
    if (/\p{Lo}/u.test(word)) {
      if (level === 'travel' && !groundText.includes(word)) findings.push(`caseless:${word}`);
      continue;
    }

    if (isKnown(word)) continue;

    if (level === 'travel') {
      // The allowlist: the traveller's words (above) or the closed connecting vocabulary — nothing else.
      if (!CONNECTING_WORDS.has(lower) && !CONNECTING_WORDS.has(stripPossessive(lower))) findings.push(`word:${word}`);
      continue;
    }

    // hard: a month or weekday name, and a capitalised word in mid-sentence (a name, a venue).
    if (CALENDAR.has(stripPossessive(lower))) { findings.push(`date:${word}`); continue; }
    if (/^[\p{Lu}\p{Lt}]/u.test(word) && !FIRST_PERSON.has(lower) && !opensSentence(text, index)) findings.push(`name:${word}`);
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
