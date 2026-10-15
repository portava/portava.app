/**
 * memoryNarrative — §2 MemoryNarrativeService's PURE half: the structured facts
 * a summary may say, the deterministic renderer that says them, and the check
 * an AI draft must pass before anyone sees it.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Spec v1
 *   §1   "AI may summarize supported evidence, but may not manufacture historical
 *        facts, emotional states, participants, places, or outcomes." (:33)
 *   §2   MemoryNarrativeService — "Generate optional editable summaries from
 *        structured facts." (:62-63)
 *   §18  NarrativeDerivative — "Optional AI summary" (:534-535)
 *   §28.4  "Never let AI prose write canonical historical facts directly." (:738)
 *   §28.16 "Always preserve original user voice and original-language text when
 *        generating summaries/translations." (:750)
 *   §28.17 "Always provide a deterministic fallback renderer if AI presentation
 *        fails." (:751)
 * CENSUS: census-highlights-memories H14, H172, H265 (B58 cluster MEM-NARR-1).
 *
 * PURE. No database, no network, no logger: projectionRegistry.ts imports the
 * renderer for NarrativeDerivative, and a registry builder must stay a pure,
 * replayable function of its rows (§28.12). The I/O half — reading the facts,
 * the flag, the consent, the owner's controls and calling the model — is
 * memoryNarrativeService.ts.
 *
 * ── WHAT A FACT IS HERE ──────────────────────────────────────────────────────
 * Only the OWNER's own record of ONE Memory, as stored:
 *   title, caption        — the owner's words, VERBATIM (never trimmed inside,
 *                           never translated, never "improved");
 *   occurred_on           — the day it STARTED (`starts_at`), in the time zone of
 *                           the place it was recorded at when that is known, and
 *                           otherwise only as precisely as every time zone on
 *                           Earth agrees (day, else month, else year, else none).
 *                           `created_at` is when the Memory was MADE, not when it
 *                           happened, so it is never used as the date;
 *   place                 — the stored city and country;
 *   photo_count           — how many items the Memory holds;
 *   people_count          — how many people the owner tagged AND who approved.
 * Never: a venue name (the catalog's name is the CURRENT one, possibly renamed
 * since — H71 — and MEM-CANON's occurrence-time name, 3804, is behind its own
 * flag and not one of these facts yet), the owner's place CORRECTIONS (3673
 * touch place ids, which no fact uses — city and country are sent as stored),
 * a coordinate, a participant's name or handle, an item caption, a trip title
 * (it may be another crew member's words), or any other person's content.
 *
 * ── ORIGINAL VOICE (H265) ────────────────────────────────────────────────────
 * Every narrative carries `original_text` (title and caption exactly as stored)
 * and `original_language: "und"`: no language is stored for a Memory and none is
 * guessed. The deterministic summary QUOTES the owner's words; an AI draft that
 * quotes them must quote them exactly, or it is refused.
 */
import tzLookup from "tz-lookup";
import { publicationPrecision } from "../../lib/memoryLocationPrecision.js";

// ── Names ─────────────────────────────────────────────────────────────────────

/** The deterministic renderer. Bump it when the template's output changes. */
export const NARRATIVE_RENDERER = "deterministic@1";
/** §18 NarrativeDerivative's builder version (projectionRegistry.ts). */
export const NARRATIVE_BUILDER_VERSION = "narrative@1";
/** The existing model (lib/openai.ts, as aiWriting.ts and Compass use it). No new provider. */
export const NARRATIVE_AI_MODEL = "gpt-5-mini";
export const NARRATIVE_AI_RENDERER = `ai:${NARRATIVE_AI_MODEL}@1`;
/** Seeded FALSE by migration 3802. */
export const MEMORY_NARRATIVE_AI_FLAG = "memory_narrative_ai_enabled";
/** No language is stored for a Memory; BCP 47 "undetermined". Never guessed. */
export const ORIGINAL_LANGUAGE_UNDETERMINED = "und";

/**
 * The disclosure a grant is recorded under. The server stamps this version on a
 * grant, and a grant is refused unless the client says it displayed exactly it.
 *
 * ENGINEERING DRAFT (open owner question Q-NARR-6). It needs LEGAL REVIEW before
 * memory_narrative_ai_enabled is turned on; changing the words means a new
 * version, so every earlier grant stops being valid for the new text. (Revised
 * in fix round 1 of PR #720 — "as stored", not "at the location setting you
 * chose", which is untrue while the §10 gate is off — while still v1: no
 * database holds 3802, so nobody has granted against any text.)
 */
export const MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION = "memory_narrative_ai_v1";
export const MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT =
  "Optional AI summaries. When you ask for one, Portava sends a few facts about that one Memory to an AI " +
  "service (OpenAI, through our hosting provider's AI integration) to draft a short summary: your title and " +
  "caption exactly as you wrote them, the date, the city and country as stored with the Memory (less, or " +
  "none, if you set its location to show less), and " +
  "how many photos and tagged people it has. Map coordinates, the names of people you tagged, photo captions " +
  "and anything someone else wrote are never sent. Memories you set to not resurface, to keep private forever, " +
  "or to not personalize are never sent. The draft is checked against those facts, shown only to you, and " +
  "not saved by Portava unless you choose to use it. You can turn this off at any time.";

// ── Inputs ────────────────────────────────────────────────────────────────────

/** The `memories` columns a narrative reads. A subset of the registry's MemorySourceRow. */
export interface NarrativeMemoryRow {
  id: string;
  owner_id: string;
  title: string | null;
  caption: string | null;
  starts_at: string | null;
  location_city: string | null;
  location_country: string | null;
  location_lat: number | string | null;
  location_lng: number | string | null;
  /** 2338; present only when the precision gate let the reader select it. */
  location_precision?: unknown;
}

export interface NarrativeCounts {
  /** Items on the Memory (the owner's own view: every item). */
  photos: number;
  /** Tags the owner made that the tagged person APPROVED. A count; never who. */
  people: number;
}

// ── Facts ─────────────────────────────────────────────────────────────────────

export type NarrativeFactKind = "title" | "occurred_on" | "place" | "photo_count" | "people_count" | "caption";

export interface NarrativeFact {
  /** `${memory_id}:${kind}` — stable across renders of the same Memory. */
  fact_id: string;
  kind: NarrativeFactKind;
  /** What the fact says, as the summary renders it. */
  text: string;
}

export function factId(memoryId: string, kind: NarrativeFactKind): string {
  return `${memoryId}:${kind}`;
}

/** Non-empty after trimming, or null. The stored value itself is never altered. */
function present(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function finiteCoordinate(v: unknown, limit: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

export interface OccurrenceDate {
  text: string;
  granularity: "day" | "month" | "year";
  /** `place_time_zone`: the zone of the recorded coordinate. `every_time_zone`: true in all of them. */
  basis: "place_time_zone" | "every_time_zone";
}

const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
const MONTH: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" };
const YEAR: Intl.DateTimeFormatOptions = { year: "numeric" };

function fmt(ms: number, opts: Intl.DateTimeFormatOptions, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone }).format(new Date(ms));
}

/**
 * The day a Memory started, said only as precisely as the record supports.
 *
 * `starts_at` is an instant. Which DAY it was depends on where it happened: 01:00
 * in Da Nang is the previous evening in UTC. With a recorded coordinate the
 * place's own zone decides (tz-lookup, offline, as CompassGraphEngine and the
 * geo resolver use it). Without one, the date is stated only to the precision on
 * which UTC−12 and UTC+14 — every zone in use — agree: the day, else the month,
 * else the year, else nothing. A summary that names the wrong day has invented a
 * fact, so it says less rather than guess.
 */
export function occurrenceDate(m: Pick<NarrativeMemoryRow, "starts_at" | "location_lat" | "location_lng">): OccurrenceDate | null {
  const ms = typeof m.starts_at === "string" ? Date.parse(m.starts_at) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const lat = finiteCoordinate(m.location_lat, 90);
  const lng = finiteCoordinate(m.location_lng, 180);
  if (lat !== null && lng !== null) {
    try {
      const zone = tzLookup(lat, lng);
      return { text: fmt(ms, DAY, zone), granularity: "day", basis: "place_time_zone" };
    } catch {
      // An unresolvable zone is "no zone": fall through to the bounded reading.
    }
  }
  const west = ms - 12 * 3600_000; // UTC−12
  const east = ms + 14 * 3600_000; // UTC+14
  for (const [opts, granularity] of [[DAY, "day"], [MONTH, "month"], [YEAR, "year"]] as const) {
    const a = fmt(west, opts, "UTC");
    if (a === fmt(east, opts, "UTC")) return { text: a, granularity, basis: "every_time_zone" };
  }
  return null;
}

/** "City, Country", either half alone, or null. As stored; the owner's own view. */
export function placeText(m: Pick<NarrativeMemoryRow, "location_city" | "location_country">): string | null {
  const city = present(m.location_city)?.trim() ?? null;
  const country = present(m.location_country)?.trim() ?? null;
  if (city && country) return `${city}, ${country}`;
  return city ?? country;
}

/** Every fact the OWNER's narrative may state, in render order. */
export function collectNarrativeFacts(m: NarrativeMemoryRow, counts: NarrativeCounts): NarrativeFact[] {
  const out: NarrativeFact[] = [];
  const title = present(m.title);
  if (title) out.push({ fact_id: factId(m.id, "title"), kind: "title", text: title.trim() });
  const date = occurrenceDate(m);
  if (date) out.push({ fact_id: factId(m.id, "occurred_on"), kind: "occurred_on", text: date.text });
  const place = placeText(m);
  if (place) out.push({ fact_id: factId(m.id, "place"), kind: "place", text: place });
  if (counts.photos > 0) out.push({ fact_id: factId(m.id, "photo_count"), kind: "photo_count", text: String(counts.photos) });
  if (counts.people > 0) out.push({ fact_id: factId(m.id, "people_count"), kind: "people_count", text: String(counts.people) });
  const caption = present(m.caption);
  if (caption) out.push({ fact_id: factId(m.id, "caption"), kind: "caption", text: caption.trim() });
  return out;
}

// ── The deterministic renderer ────────────────────────────────────────────────

/** One clause of a summary and the facts it states. `after` is the fixed separator that follows it. */
export interface NarrativeSegment {
  text: string;
  fact_ids: string[];
  after: string;
}

/** The only text a deterministic summary may contain outside its segments. */
export const NARRATIVE_SEPARATORS: readonly string[] = ["", ".", ", ", ". "];

export interface OriginalText {
  title: string | null;
  caption: string | null;
}

export interface MemoryNarrative {
  memory_id: string;
  renderer: string;
  summary: string;
  segments: NarrativeSegment[];
  supporting_fact_ids: string[];
  facts: NarrativeFact[];
  /** H265: the owner's words exactly as stored — not trimmed, not translated. */
  original_text: OriginalText;
  original_language: typeof ORIGINAL_LANGUAGE_UNDETERMINED;
  /** A draft for the owner to edit; saving it is the owner's own PATCH /memories/:id. */
  editable: true;
  /** Nothing about a narrative is stored by the server (Q-NARR-4, fail-closed default). */
  stored: false;
}

export const EMPTY_NARRATIVE_SUMMARY = "This Memory has no details to summarize yet.";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The template. Every clause is a segment naming the facts it states, worded
 * as the fact plus the template's own fixed words ("A Memory from", "in",
 * "with", "You wrote:"); the text between clauses is one of
 * NARRATIVE_SEPARATORS. So `summary` is exactly the concatenation of
 * `text + after` — a reader can check, mechanically, that nothing in it came
 * from anywhere but a fact or the template.
 */
export function renderDeterministicNarrative(m: NarrativeMemoryRow, counts: NarrativeCounts): MemoryNarrative {
  const facts = collectNarrativeFacts(m, counts);
  const by = new Map(facts.map((f) => [f.kind, f] as const));
  const segs: Array<{ text: string; fact_ids: string[] }[]> = [];

  const first: { text: string; fact_ids: string[] }[] = [];
  const title = by.get("title");
  const date = by.get("occurred_on");
  const place = by.get("place");
  if (title) first.push({ text: `“${title.text}”`, fact_ids: [title.fact_id] });
  if (date) first.push({ text: `${title ? "" : "A Memory from "}${date.text}`, fact_ids: [date.fact_id] });
  if (place) first.push({ text: `${title || date ? "in " : "A Memory in "}${place.text}`, fact_ids: [place.fact_id] });
  if (first.length > 0) segs.push(first);

  const second: { text: string; fact_ids: string[] }[] = [];
  const photos = by.get("photo_count");
  const people = by.get("people_count");
  if (photos) second.push({ text: plural(counts.photos, "photo", "photos"), fact_ids: [photos.fact_id] });
  if (people) second.push({ text: `${photos ? "with" : "With"} ${plural(counts.people, "person", "people")}`, fact_ids: [people.fact_id] });
  if (second.length > 0) segs.push(second);

  // The owner's caption closes the summary in their own words, with their own
  // punctuation: nothing is appended after it.
  const caption = by.get("caption");
  if (caption) segs.push([{ text: `You wrote: “${caption.text}”`, fact_ids: [caption.fact_id] }]);

  const segments: NarrativeSegment[] = [];
  segs.forEach((sentence, si) => {
    const isCaption = caption !== undefined && si === segs.length - 1;
    const isLast = si === segs.length - 1;
    sentence.forEach((s, i) => {
      const after = i < sentence.length - 1 ? ", " : isCaption ? "" : isLast ? "." : ". ";
      segments.push({ ...s, after });
    });
  });

  const summary = segments.length === 0 ? EMPTY_NARRATIVE_SUMMARY : segments.map((s) => s.text + s.after).join("");
  return {
    memory_id: m.id,
    renderer: NARRATIVE_RENDERER,
    summary,
    segments,
    supporting_fact_ids: segments.flatMap((s) => s.fact_ids),
    facts,
    original_text: { title: typeof m.title === "string" ? m.title : null, caption: typeof m.caption === "string" ? m.caption : null },
    original_language: ORIGINAL_LANGUAGE_UNDETERMINED,
    editable: true,
    stored: false,
  };
}

// ── What the model may be sent (Q-NARR-2, fail-closed default) ────────────────

/**
 * The facts an AI draft is built from. The OWNER's own record only, and less of
 * it than the owner sees: the place at the Memory's §10 publication rung (the
 * model is not the owner), never a coordinate, never a name of a tagged person,
 * never a count of zero (nothing to say is said by omission).
 */
export interface NarrativeAiFacts {
  title: string | null;
  caption: string | null;
  date: string | null;
  place: string | null;
  photos: number | null;
  people: number | null;
}

export type PrecisionGateState = "on" | "off" | "unreadable";

/**
 * The place as a NON-OWNER may be told it (lib/memoryLocationPrecision.ts
 * publicationPrecision): exact / venue / neighborhood / city ⇒ city and country;
 * country ⇒ the country alone; hidden ⇒ nothing. An unreadable precision gate
 * sends no place at all (memoryPrecisionGate.ts: a failure never publishes more).
 */
export function aiPlaceText(m: NarrativeMemoryRow, gate: PrecisionGateState): string | null {
  if (gate === "unreadable") return null;
  const rung = publicationPrecision(m, gate === "on");
  if (rung === "hidden") return null;
  if (rung === "country") return present(m.location_country)?.trim() ?? null;
  return placeText(m);
}

export function narrativeAiFacts(m: NarrativeMemoryRow, counts: NarrativeCounts, gate: PrecisionGateState): NarrativeAiFacts {
  return {
    title: present(m.title)?.trim() ?? null,
    caption: present(m.caption)?.trim() ?? null,
    date: occurrenceDate(m)?.text ?? null,
    place: aiPlaceText(m, gate),
    photos: counts.photos > 0 ? counts.photos : null,
    people: counts.people > 0 ? counts.people : null,
  };
}

/** The fact ids an AI draft rests on: exactly the facts it was sent. */
export function aiSupportingFactIds(memoryId: string, f: NarrativeAiFacts): string[] {
  const ids: string[] = [];
  if (f.title !== null) ids.push(factId(memoryId, "title"));
  if (f.date !== null) ids.push(factId(memoryId, "occurred_on"));
  if (f.place !== null) ids.push(factId(memoryId, "place"));
  if (f.photos !== null) ids.push(factId(memoryId, "photo_count"));
  if (f.people !== null) ids.push(factId(memoryId, "people_count"));
  if (f.caption !== null) ids.push(factId(memoryId, "caption"));
  return ids;
}

export const NARRATIVE_AI_SYSTEM_PROMPT =
  "You draft a one-sentence summary of one travel Memory for the person who owns it, in English, at most 40 " +
  "words, using ONLY the facts in the user message. Use the title exactly as written, and the place, the date " +
  "and the counts exactly as given (\"2 people\", \"4 photos\"); join them only with simple words such as a, " +
  "the, in, on, at, from, with, and. Add no other word: no person, name, pronoun, place, venue, time, food, " +
  "activity, weather, season, feeling or outcome. Do not quote, paraphrase or translate the caption. No " +
  "quotation marks, emoji, hashtags, @-mentions or links. Reply with the summary text only.";

/** The model input: the system rule and the facts as JSON, null facts omitted. */
export function buildNarrativeAiMessages(f: NarrativeAiFacts): Array<{ role: "system" | "user"; content: string }> {
  const sent: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(f)) if (v !== null) sent[k] = v;
  return [
    { role: "system", content: NARRATIVE_AI_SYSTEM_PROMPT },
    { role: "user", content: `Facts (JSON):\n${JSON.stringify(sent)}` },
  ];
}

// ── The check every AI draft must pass (§1, §28.4, §28.16) ────────────────────
//
// AN ALLOWLIST, NOT A BLOCKLIST. The first version of this check listed words a
// draft could NOT use without support and accepted everything else; the PR #720
// verifier found 50 of 81 adversarial drafts accepted while inventing people,
// venues, weather, emoji, selective quotes and other languages. Here every word
// outside an exact quote of the owner's own text must be accounted for by the
// facts the model was sent, or by a short fixed list of connecting words. A
// word nothing accounts for is refused.

export type AiNarrativeRejection = "empty_output" | "too_long" | "altered_owner_text" | "unsupported_fact";

export type AiNarrativeCheck =
  | { ok: true; summary: string }
  /** `detail` names what failed, for tests. It is never logged and never sent. */
  | { ok: false; reason: AiNarrativeRejection; detail: string };

export const AI_NARRATIVE_MAX_CHARS = 400;
export const AI_NARRATIVE_MAX_WORDS = 80;

/** Number words, accepted ONLY as a count bound to its noun ("two people"). */
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
});

/**
 * The ONLY words a draft may use that the facts do not supply: articles,
 * prepositions, conjunctions and the second person, plus the product's own word
 * "Memory". None of them names a person, a place, a time, a quantity, a
 * feeling, an activity or a negation — so none of them can, alone, assert
 * something the record does not hold. ("wrote" and "titled" are NOT here: they
 * attribute words to the owner, so they are accepted only right before the
 * owner's own words — ATTRIBUTING_WORDS.)
 */
export const NARRATIVE_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "this", "that", "of", "in", "on", "at", "to", "from", "with", "and", "for", "by",
  "during", "about", "your", "you", "it", "its", "was", "is", "as", "here", "there",
  "where", "which", "when", "memory", "memories",
]);

/**
 * Words that say WHOSE words follow. "wrote" is accepted only immediately before
 * a whole quote or whole run of the title or caption; "titled" only before the
 * title. "You wrote Vietnam." would attribute to the owner words they never wrote.
 */
const ATTRIBUTING_WORDS: Readonly<Record<string, ReadonlySet<OwnerTextKind>>> = Object.freeze({
  wrote: new Set<OwnerTextKind>(["title", "caption"]),
  titled: new Set<OwnerTextKind>(["title"]),
});
type OwnerTextKind = "title" | "caption";

/** Nouns a count binds to, accepted only when that count is one of the facts. */
const PHOTO_NOUNS: ReadonlySet<string> = new Set(["photo", "photos", "picture", "pictures", "item", "items"]);
const PEOPLE_NOUNS: ReadonlySet<string> = new Set(["person", "people"]);
/** A singular count noun with no number before it asserts a count of ONE ("a person"). */
const SINGULAR_COUNT_NOUNS: ReadonlySet<string> = new Set(["photo", "picture", "item", "person"]);
const isCountNoun = (t: string): boolean => PHOTO_NOUNS.has(t) || PEOPLE_NOUNS.has(t);

/** Characters a draft may contain besides letters, marks, ASCII digits and whitespace. Everything else (emoji, symbols, @ # / & %, other digits) is refused. */
const ALLOWED_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "(", ")", "-", "–", "—", "…", "'", "’", "‘", "\"", "“", "”", "«", "»", "„", "「", "」", "『", "』"]);
/** Quotation marks. ' and ’ BETWEEN two letters are apostrophes, not quotes. */
const QUOTE_MARKS = /["“”‘’'«»„「」『』]/u;
const APOSTROPHE = "\uE000";
const QUOTE_GAP = "\uE001";

const TOKEN = /[\p{L}\p{M}\p{Nd}]+(?:\uE000[\p{L}\p{M}]+)*/gu;

/** Word-internal apostrophes (' or ’) become one placeholder, so they are part of the word and not a quote. */
function protectApostrophes(s: string): string {
  return s.replace(/(?<=[\p{L}\p{M}])['’](?=[\p{L}\p{M}])/gu, APOSTROPHE);
}

/** Tokens, lowercased, NFC, apostrophes normalised. */
function wordsOf(s: string): string[] {
  return (protectApostrophes(s.normalize("NFC")).match(TOKEN) ?? []).map((t) => t.toLowerCase());
}

/** A word as looked up: lowercased, the possessive 's dropped ("Nang's" is "Nang"). */
function lookupKey(token: string): string {
  return token.replace(new RegExp(`${APOSTROPHE}s$`, "u"), "");
}

/** Owner text compared whole: NFC, trimmed, apostrophes and trailing sentence punctuation normalised. */
function ownerForm(s: string): string {
  return s.normalize("NFC").replace(/’/g, "'").trim().replace(/[.!?…]+$/u, "").trim();
}

/** The date fact's parts: "13 March 2025" / "March 2025" / "2025". */
function dateParts(date: string | null): { day: number | null; month: string | null; year: number | null } {
  const m = date ? /^(?:(\d{1,2}) )?(?:(\p{L}+) )?(\d{4})$/u.exec(date) : null;
  return m ? { day: m[1] ? Number(m[1]) : null, month: m[2] ? m[2].toLowerCase() : null, year: Number(m[3]) } : { day: null, month: null, year: null };
}

/** Every occurrence of `seq` in `tokens`: the indexes it covers, and where each occurrence starts. */
function occurrences(tokens: readonly string[], seq: readonly string[]): { covered: Set<number>; starts: Set<number> } {
  const covered = new Set<number>();
  const starts = new Set<number>();
  if (seq.length === 0) return { covered, starts };
  for (let i = 0; i + seq.length <= tokens.length; i++) {
    if (seq.every((w, j) => tokens[i + j] === w)) { starts.add(i); for (let j = 0; j < seq.length; j++) covered.add(i + j); }
  }
  return { covered, starts };
}

/** The value of a digit or NUMBER_WORDS token, or null. */
function countValue(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const w = NUMBER_WORDS[token];
  return w === undefined ? null : w;
}

/**
 * Accept an AI draft only if every word in it is accounted for by the facts it
 * was sent (an ALLOWLIST). What this GUARANTEES:
 *
 *   1. Characters: letters, marks, ASCII digits, whitespace and ordinary
 *      punctuation only — no emoji, no symbol, no @ # / & %, no non-ASCII digit.
 *   2. Quotes: a quoted span (straight or curly, single or double, «», 「」) must
 *      be the owner's WHOLE title or WHOLE caption, exactly (ignoring only the
 *      final full stop) — no selective or re-spaced quote, no paraphrase in
 *      quotes; an unmatched quotation mark is refused (§28.16).
 *   3. The owner's words outside quotes: a title or caption word is accepted
 *      only inside a contiguous occurrence of the WHOLE title or WHOLE caption,
 *      so the owner's words cannot be re-cut ("Not the best night" never yields
 *      "the best night").
 *   4. Numbers: every number is bound by the grammar of the facts — a digit or
 *      number word immediately before "photos"/"people" (or their singulars)
 *      must equal that count, and each count is stated once ("4 photos and 4
 *      photos" is refused); a day must be the date's day next to its month, or
 *      "the 13th" when nothing counted follows ("the 13th person", "the 13th of
 *      the people" are refused); a year must be the date's year. Any other
 *      number, number word or ordinal is refused.
 *   5. Counts without a number: a singular count noun ("a person", "a photo")
 *      says ONE and is accepted only when that count is 1; a plural ("photos")
 *      says more than one and needs a count of at least 2; neither is accepted
 *      when that count is not a fact.
 *   6. The date's month only inside the date (next to its day or year, or "the
 *      13th of March"): alone, "march" or "may" is a homonym the facts do not
 *      state.
 *   7. "wrote" / "titled" only immediately before the owner's own words — a whole
 *      quote or whole run of the title or caption ("titled": the title only):
 *      "You wrote Vietnam." would put words in the owner's mouth.
 *   8. Every other word must be a word of the place fact or one of
 *      NARRATIVE_FUNCTION_WORDS. Anything else — a name in any case or position,
 *      a venue, an activity, food, weather, a season, a feeling, a pronoun
 *      implying company, a negation, a word of another language — is refused.
 *      So drafts are English-only apart from the owner's own words and the
 *      stored place.
 *
 * What it CANNOT guarantee (open owner question Q-NARR-7): what the accepted
 * words say ABOUT EACH OTHER. A word allowlist checks words, not relations:
 *   - a relation asserted between true facts with allowed words — "Vietnam is in
 *     Da Nang.", "2 people from Vietnam", "the people of Vietnam";
 *   - order — "Sunset walk to Vietnam from Da Nang" (a journey the record does
 *     not hold), or facts juxtaposed so a reader infers a link;
 *   - homonyms of place words — "a bath in Bath, England" (the month's homonyms
 *     are closed by rule 6; a place word cannot be, it is the place's name).
 * Every word is true; what they assert together is the model's. Refused drafts
 * cost the owner nothing: the caller serves the template.
 */
export function checkAiNarrative(raw: string, f: NarrativeAiFacts): AiNarrativeCheck {
  let text = String(raw ?? "").normalize("NFC").trim();
  const wrapped = /^[“"]([^“”"]*)[”"]$/u.exec(text);
  if (wrapped) text = wrapped[1]!.trim();
  if (text.length === 0) return { ok: false, reason: "empty_output", detail: "blank" };
  if (text.length > AI_NARRATIVE_MAX_CHARS || wordsOf(text).length > AI_NARRATIVE_MAX_WORDS) {
    return { ok: false, reason: "too_long", detail: `${text.length} chars` };
  }

  // 1. Characters.
  for (const ch of text) {
    if (/[\p{L}\p{M}0-9\s]/u.test(ch) || ALLOWED_PUNCTUATION.has(ch)) continue;
    return { ok: false, reason: "unsupported_fact", detail: `symbol: ${ch}` };
  }

  // 2. Quotes: split on quotation marks; odd pieces are quoted.
  const pieces = protectApostrophes(text).split(QUOTE_MARKS);
  if (pieces.length % 2 === 0) return { ok: false, reason: "altered_owner_text", detail: "unmatched quotation mark" };
  const ownerTexts: Array<[OwnerTextKind, string | null]> = [["title", f.title], ["caption", f.caption]];
  const unquoted: string[] = [];
  const gapKinds: Array<Set<OwnerTextKind>> = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!.replace(new RegExp(APOSTROPHE, "gu"), "'");
    if (i % 2 === 0) { unquoted.push(pieces[i]!); continue; }
    const kinds = new Set(ownerTexts.filter(([, t]) => t !== null && ownerForm(t) === ownerForm(piece)).map(([k]) => k));
    if (kinds.size === 0 || ownerForm(piece).length === 0) {
      return { ok: false, reason: "altered_owner_text", detail: `quoted: ${piece}` };
    }
    gapKinds.push(kinds);
    unquoted.push(` ${QUOTE_GAP} `);
  }

  // 3. The owner's words, whole: which tokens they cover, and where each title or caption run (or quote) starts.
  const tokens = (unquoted.join("").match(new RegExp(`${TOKEN.source}|${QUOTE_GAP}`, "gu")) ?? []).map((t) => t.toLowerCase());
  const covered = new Set<number>();
  const ownerStarts = new Map<number, Set<OwnerTextKind>>();
  const markStart = (i: number, k: OwnerTextKind) => { if (!ownerStarts.has(i)) ownerStarts.set(i, new Set()); ownerStarts.get(i)!.add(k); };
  for (const [kind, own] of ownerTexts) {
    if (own === null) continue;
    const occ = occurrences(tokens, wordsOf(own));
    for (const i of occ.covered) covered.add(i);
    for (const i of occ.starts) markStart(i, kind);
  }
  let gap = 0;
  tokens.forEach((t, i) => { if (t === QUOTE_GAP) for (const k of gapKinds[gap++] ?? []) markStart(i, k); });

  // 4 and 5. Every other word.
  const place = new Set((f.place ? wordsOf(f.place) : []).map(lookupKey));
  const d = dateParts(f.date);
  const dayAt = (t: string | undefined): boolean => {
    const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(t ?? "");
    return m !== null && d.day !== null && Number(m[1]) === d.day;
  };
  const yearAt = (t: string | undefined): boolean => /^\d{4}$/.test(t ?? "") && Number(t) === d.year;
  const countedKinds = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === QUOTE_GAP || covered.has(i)) continue;
    const key = lookupKey(token);
    const next = tokens[i + 1] ?? "";
    const prev = tokens[i - 1] ?? "";
    const digits = /^\d+$/.test(token) ? Number(token) : null;
    const ordinal = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(token);
    const word = NUMBER_WORDS[token];
    const count = countValue(token);
    if (count !== null && isCountNoun(next)) {
      const kind = PHOTO_NOUNS.has(next) ? "photos" : "people";
      const fact = kind === "photos" ? f.photos : f.people;
      if (fact === null || count !== fact) return { ok: false, reason: "unsupported_fact", detail: `count: ${token} ${next}` };
      // Each count is stated once: "4 photos and 4 photos" reads as more than the facts hold.
      if (countedKinds.has(kind)) return { ok: false, reason: "unsupported_fact", detail: `repeated: ${token} ${next}` };
      countedKinds.add(kind);
      continue;
    }
    if (place.has(key)) continue;
    if (digits !== null || ordinal !== null || word !== undefined) {
      if (word !== undefined) return { ok: false, reason: "unsupported_fact", detail: `number word: ${token}` };
      const value = digits ?? Number(ordinal![1]);
      const isYear = digits !== null && /^\d{4}$/.test(token) && value === d.year;
      const nextToMonth = d.month !== null && (prev === d.month || next === d.month || (ordinal !== null && next === "of" && tokens[i + 2] === d.month));
      // "the 13th" alone is the day only when it is not counting something: "the 13th person", "the 13th of the people" are refused.
      const theDay = ordinal !== null && prev === "the" && !isCountNoun(next) && next !== "of";
      const isDay = d.day !== null && value === d.day && (digits === null || /^\d{1,2}$/.test(token)) && (nextToMonth || theDay);
      if (isYear || isDay) continue;
      return { ok: false, reason: "unsupported_fact", detail: `number: ${token}` };
    }
    // The date's month only as part of the date ("13 March 2025", "March 2025", "the 13th of March"):
    // alone, "march" or "may" is a homonym the facts do not state.
    if (d.month !== null && key === d.month) {
      if (dayAt(prev) || dayAt(next) || yearAt(next) || yearAt(prev) || (prev === "of" && dayAt(tokens[i - 2]))) continue;
      return { ok: false, reason: "unsupported_fact", detail: `word: ${token}` };
    }
    if (isCountNoun(key)) {
      const fact = PHOTO_NOUNS.has(key) ? f.photos : f.people;
      if (fact === null) return { ok: false, reason: "unsupported_fact", detail: `word: ${token}` };
      // After a bound number it was checked above. Without one, a singular says ONE and a plural says MORE THAN ONE.
      if (countValue(prev) === null && (SINGULAR_COUNT_NOUNS.has(key) ? fact !== 1 : fact < 2)) {
        return { ok: false, reason: "unsupported_fact", detail: `count: ${token}` };
      }
      continue;
    }
    const attributes = ATTRIBUTING_WORDS[key];
    if (attributes !== undefined) {
      const following = ownerStarts.get(i + 1);
      if (following && [...following].some((k) => attributes.has(k))) continue;
      return { ok: false, reason: "unsupported_fact", detail: `word: ${token}` };
    }
    if (NARRATIVE_FUNCTION_WORDS.has(key)) continue;
    return { ok: false, reason: "unsupported_fact", detail: `word: ${token}` };
  }
  return { ok: true, summary: text };
}
