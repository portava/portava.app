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
 *      traveller did not write. The prompt asks; this check enforces. It runs
 *      on every `caption` variant at the HARD level, and at the stricter TRAVEL
 *      level on the two fields above (see `inventedFacts`).
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
  'Keep their meaning and their voice. Add NOTHING they did not write: no place, venue, person, date, day, time, ' +
  'number, food, drink, weather, activity or event. If their words name none of these, your caption names none either.';

// ── The check ─────────────────────────────────────────────────────────────────

/**
 * `hard`   — every `caption` variant. Only what is a fact whatever the language
 *            around it: a capitalised word in mid-sentence (a name, a venue, a
 *            month), a digit, a calendar name, a handle, a hashtag, a link.
 * `travel` — the two G141 fields. `hard`, plus: the FIRST word of a sentence is
 *            judged too (a name can open a sentence), number words, a closed
 *            list of words that assert company, time, food, place, activity or
 *            weather, and any run of a script without letter case (where no
 *            name can be told from a word, so the run must be the traveller's).
 */
export type FactLevel = 'hard' | 'travel';

/** Words that open a sentence without stating anything (travel level only). */
const STARTERS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', "it's", 'what', 'such', 'so', 'just', 'here',
  'there', 'how', 'oh', 'wow', 'yes', 'no', 'not', 'nothing', 'never', 'always', 'still', 'simply', 'truly',
  'really', 'all', 'every', 'another', 'some', 'more', 'most', 'too', 'very', 'and', 'but', 'or', 'yet', 'my',
  'me', 'you', 'your', 'at', 'in', 'on', 'with', 'from', 'to', 'by', 'for', 'of', 'after', 'before', 'during',
]);

/** "I" and its contractions are capitalised everywhere and state nothing. */
const FIRST_PERSON: ReadonlySet<string> = new Set(['i', "i'm", "i've", "i'd", "i'll"]);

/**
 * Month and weekday names: a date, in any case. Words that are also ordinary
 * words (`may`, `march`, `sun`, `sat`, `wed`, `mon`) are left to the name rule,
 * which catches their capitalised, mid-sentence form.
 */
const CALENDAR: ReadonlySet<string> = new Set([
  'january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'tue', 'tues', 'thu', 'thur', 'thurs', 'fri',
]);

/** Counts written as words (travel level). */
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty',
  'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'dozen', 'couple', 'pair', 'both',
  'twice', 'thrice', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'single', 'double', 'triple', 'several', 'few', 'many',
]);

/**
 * Words that assert a travel fact the traveller may not have stated (travel
 * level). A CLOSED list, so it is a backstop and not the whole check: the name,
 * number and first-word rules are the structural part. A word here passes when
 * the traveller wrote it (or its singular) themselves.
 */
const TRAVEL_CLAIMS: ReadonlySet<string> = new Set([
  // company
  'we', 'us', 'our', 'ours', 'ourselves', 'together', 'they', 'them', 'their', 'he', 'she', 'him', 'her', 'his',
  'friend', 'family', 'mom', 'mum', 'mother', 'dad', 'father', 'parent', 'wife', 'husband', 'partner', 'boyfriend',
  'girlfriend', 'fiance', 'fiancé', 'fiancée', 'kid', 'child', 'children', 'son', 'daughter', 'brother', 'sister',
  'sibling', 'cousin', 'grandma', 'grandpa', 'crew', 'team', 'colleague', 'coworker', 'buddy', 'buddies', 'bestie',
  'guide', 'host', 'everyone', 'everybody', 'stranger', 'local',
  // time
  'today', 'tonight', 'yesterday', 'tomorrow', 'morning', 'afternoon', 'evening', 'night', 'overnight', 'midnight',
  'noon', 'sunrise', 'sunset', 'dawn', 'dusk', 'weekend', 'week', 'month', 'year', 'hour', 'minute', 'ago',
  'birthday', 'anniversary', 'honeymoon', 'holiday', 'vacation', 'summer', 'winter', 'autumn', 'spring',
  // food and drink
  'breakfast', 'brunch', 'lunch', 'dinner', 'supper', 'dessert', 'coffee', 'tea', 'beer', 'wine', 'cocktail',
  'drink', 'sushi', 'pizza', 'pasta', 'noodle', 'pho', 'ramen', 'taco', 'bbq', 'barbecue', 'seafood', 'steak',
  'burger', 'curry', 'dumpling', 'icecream', 'gelato',
  // place
  'beach', 'mountain', 'lake', 'river', 'sea', 'ocean', 'island', 'temple', 'church', 'museum', 'market', 'cafe',
  'café', 'restaurant', 'bar', 'rooftop', 'hotel', 'hostel', 'airport', 'station', 'park', 'street', 'alley',
  'downtown', 'harbor', 'harbour', 'bay', 'waterfall', 'trail', 'village', 'pool', 'spa', 'castle', 'palace',
  'bridge', 'tower', 'garden', 'shrine', 'pagoda', 'cave', 'valley', 'volcano', 'desert', 'jungle', 'forest',
  // activity and event
  'hike', 'hiking', 'swim', 'swimming', 'surf', 'surfing', 'dive', 'diving', 'snorkel', 'snorkeling', 'kayak',
  'kayaking', 'cycling', 'tour', 'concert', 'festival', 'party', 'wedding', 'show', 'match', 'class', 'cruise',
  'flight', 'ferry', 'roadtrip', 'safari', 'climb', 'climbing', 'ski', 'skiing',
  // weather
  'rain', 'rainy', 'sunny', 'snow', 'snowy', 'storm', 'stormy', 'cloudy', 'foggy', 'windy', 'humid',
]);

const WORD_RE = /[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}'\-]*[\p{L}\p{M}\p{N}])?/gu;
const HANDLE_OR_TAG_RE = /[@#][\p{L}\p{N}_][\p{L}\p{N}_.]*/gu;
const LINK_RE = /(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/giu;

function fold(s: string): string {
  return s.normalize('NFC').replace(/[’‘`]/g, "'");
}

function stripPossessive(w: string): string {
  return w.endsWith("'s") ? w.slice(0, -2) : w;
}

/** The forms a word is matched under: itself, without a possessive, and a naive singular. */
function forms(word: string): string[] {
  const w = stripPossessive(word.toLowerCase());
  const out = new Set<string>([word.toLowerCase(), w]);
  if (w.length > 3 && w.endsWith('ies')) out.add(`${w.slice(0, -3)}y`);
  if (w.length > 3 && w.endsWith('es')) out.add(w.slice(0, -2));
  if (w.length > 2 && w.endsWith('s')) out.add(w.slice(0, -1));
  for (const part of w.split('-')) if (part && part !== w) out.add(part);
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
    const prev = index > 0 ? text[index - 1]! : '';
    if (prev === '@' || prev === '#') continue; // judged whole, above

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

    if (CALENDAR.has(stripPossessive(lower))) { findings.push(`date:${word}`); continue; }

    // A capitalised word: a name, a venue, a month — unless it is "I", or it only opens a sentence.
    if (/^[\p{Lu}\p{Lt}]/u.test(word) && !FIRST_PERSON.has(lower)) {
      const starts = opensSentence(text, index);
      if (!starts) { findings.push(`name:${word}`); continue; }
      if (level === 'travel' && !STARTERS.has(stripPossessive(lower))) { findings.push(`name:${word}`); continue; }
    }

    if (level !== 'travel') continue;

    const fs = forms(word);
    if (fs.some((f) => NUMBER_WORDS.has(f))) { findings.push(`count:${word}`); continue; }
    if (fs.some((f) => TRAVEL_CLAIMS.has(f))) { findings.push(`claim:${word}`); continue; }
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
