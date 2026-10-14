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
 * Never: a venue name (the only stored one is the catalog's CURRENT name, which
 * may be post-rename — H71 — so it waits for MEM-CANON's occurrence-time name),
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
 * version, so every earlier grant stops being valid for the new text.
 */
export const MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION = "memory_narrative_ai_v1";
export const MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT =
  "Optional AI summaries. When you ask for one, Portava sends a few facts about that one Memory to an AI " +
  "service (OpenAI, through our hosting provider's AI integration) to draft a short summary: your title and " +
  "caption exactly as you wrote them, the date, the city and country at the location setting you chose, and " +
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
 * The template. Every clause is a segment naming the facts it states; the text
 * between clauses is one of NARRATIVE_SEPARATORS. So `summary` is exactly the
 * concatenation of `text + after` — a reader can check, mechanically, that no
 * word in it came from anywhere but a fact.
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
  "You draft a short summary of one travel Memory for the person who owns it. Use ONLY the facts in the " +
  "user message. Write one or two plain sentences, at most 50 words, in English. Do not add any person, " +
  "name, place, venue, date, time, number, food, activity, weather, feeling or outcome that is not in the " +
  "facts. Do not quote, translate or rewrite the owner's title or caption: the app shows their own words " +
  "separately. Do not use quotation marks, hashtags, @-mentions or links. Reply with the summary text only.";

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

export type AiNarrativeRejection = "empty_output" | "too_long" | "altered_owner_text" | "unsupported_fact";

export type AiNarrativeCheck =
  | { ok: true; summary: string }
  /** `detail` names what failed, for tests. It is never logged and never sent. */
  | { ok: false; reason: AiNarrativeRejection; detail: string };

export const AI_NARRATIVE_MAX_CHARS = 400;
export const AI_NARRATIVE_MAX_WORDS = 80;

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
});

/**
 * Words that ASSERT something a Memory's facts would have to support: quantity,
 * sequence or return, company, feeling, time of day, weather, season, and what
 * was done or where. Each is allowed only when the owner's own facts contain it.
 * Capitalised words (names, venues, months, weekdays) are checked separately:
 * every one must be in the facts.
 */
const CLAIM_WORDS: ReadonlySet<string> = new Set([
  // quantity / sequence / return
  "dozen", "dozens", "hundred", "hundreds", "thousand", "thousands", "first", "second", "third", "fourth",
  "fifth", "last", "final", "again", "return", "returned", "returning", "revisit", "revisited", "anniversary",
  // company — §1 "participants"
  "friend", "friends", "family", "families", "wife", "husband", "partner", "partners", "boyfriend", "girlfriend",
  "fiance", "fiancé", "fiancee", "fiancée", "spouse", "kid", "kids", "child", "children", "son", "daughter",
  "baby", "mom", "mum", "mother", "dad", "father", "parents", "brother", "sister", "siblings", "cousin",
  "cousins", "grandma", "grandpa", "grandmother", "grandfather", "aunt", "uncle", "colleague", "colleagues",
  "coworker", "coworkers", "team", "teammates", "crew", "group", "couple", "together", "alone", "solo",
  "everyone", "everybody", "guest", "guests",
  // feeling — §1 "emotional states"
  "happy", "happiest", "happiness", "sad", "joy", "joyful", "joyous", "love", "loved", "loving", "lovely",
  "amazing", "unforgettable", "beautiful", "gorgeous", "magical", "magic", "romantic", "excited", "exciting",
  "excitement", "fun", "wonderful", "perfect", "best", "favorite", "favourite", "memorable", "special",
  "relaxing", "relaxed", "peaceful", "calm", "delicious", "tasty", "stunning", "incredible", "awesome", "great",
  "nostalgic", "emotional", "proud", "grateful", "thrilled", "cozy", "cosy", "epic", "breathtaking",
  "adventure", "adventurous", "tired", "exhausted", "scary", "nervous", "bittersweet", "cherished", "treasured",
  // time of day, weather, season — "historical facts"
  "morning", "afternoon", "evening", "night", "tonight", "sunset", "sunrise", "noon", "midnight", "dawn", "dusk",
  "sunny", "rainy", "rain", "snow", "snowy", "cloudy", "hot", "cold", "warm", "storm", "stormy", "windy",
  "summer", "winter", "autumn",
  // what was done, and where — "places" and "outcomes"
  "dinner", "lunch", "breakfast", "brunch", "meal", "drinks", "drink", "coffee", "beer", "wine", "cocktail",
  "cocktails", "party", "wedding", "birthday", "concert", "festival", "hike", "hiking", "swim", "swimming",
  "beach", "museum", "market", "temple", "restaurant", "cafe", "café", "bar", "club", "show", "game", "match",
  "celebration", "celebrated", "celebrating", "holiday", "vacation", "honeymoon", "graduation", "proposal",
  "engaged", "engagement", "food", "ate", "eating", "dancing", "danced", "trip", "trips", "journey",
]);

/** Capitalised mid-sentence words that are the product's own vocabulary, not a claim. */
const CAPITALISED_VOCABULARY: ReadonlySet<string> = new Set(["Memory", "Memories"]);

const TOKEN = /[\p{L}\p{M}\p{Nd}]+(?:['’][\p{L}\p{M}]+)*/gu;

function tokensOf(s: string): string[] {
  return s.normalize("NFC").match(TOKEN) ?? [];
}

function asciiNumbers(s: string): number[] {
  return (s.match(/\d+/g) ?? []).map((d) => Number(d));
}

/** Quoted spans. Unmatched double-quote marks are reported as `null` (fail closed). */
function quotedSpans(text: string): Array<string | null> {
  const spans: Array<string | null> = [];
  let rest = text;
  const pairs: RegExp[] = [/“([^“”]*)”/g, /"([^"]*)"/g, /«([^«»]*)»/g, /„([^„“”]*)[“”]/g, /「([^「」]*)」/g, /『([^『』]*)』/g,
    /(?<![\p{L}\p{N}])‘([^‘’]*?)’(?![\p{L}\p{N}])/gu];
  for (const re of pairs) {
    rest = rest.replace(re, (_m, inner: string) => { spans.push(inner); return " "; });
  }
  if (/[“”"«»„「」『』]/.test(rest)) spans.push(null);
  return spans;
}

/** Is this word written in a script with no letter case (CJK, Thai, Arabic, Hebrew, Devanagari …)? */
function caseless(token: string): boolean {
  return /\p{Lo}/u.test(token) && !/[\p{Lu}\p{Ll}]/u.test(token);
}

function sentenceInitial(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/[\s“"‘'(«„「『]+$/u, "");
  return before.length === 0 || /[.!?]$/.test(before);
}

function variants(word: string): string[] {
  const w = word.toLowerCase();
  return [w, `${w}s`, w.endsWith("s") ? w.slice(0, -1) : w, w.endsWith("es") ? w.slice(0, -2) : w];
}

/**
 * Accept an AI draft only if everything it asserts is in the facts it was sent.
 *
 *   - quoted text must be the owner's title or caption, EXACTLY (§28.16): a
 *     "polished" caption is the owner's voice rewritten, and is refused;
 *   - every number (digits or words) must be a number the facts contain;
 *   - every capitalised word mid-sentence (a name, a venue, a month, a weekday)
 *     and every word in a caseless script must appear in the facts;
 *   - every CLAIM_WORDS word — company, feeling, time, weather, activity — must
 *     appear in the facts (§1: no participants, emotional states, places or
 *     outcomes the record does not hold);
 *   - hashtags, @-mentions and links must appear in the facts.
 * Anything else is refused, and the caller serves the deterministic summary.
 * Deliberately strict: a refused good draft costs the owner nothing (they get
 * the template), an accepted invented fact is the defect §1 forbids.
 */
export function checkAiNarrative(raw: string, f: NarrativeAiFacts): AiNarrativeCheck {
  let text = String(raw ?? "").normalize("NFC").trim();
  const wrapped = /^[“"]([^“”"]*)[”"]$/.exec(text);
  if (wrapped) text = wrapped[1]!.trim();
  if (text.length === 0) return { ok: false, reason: "empty_output", detail: "blank" };
  if (text.length > AI_NARRATIVE_MAX_CHARS || tokensOf(text).length > AI_NARRATIVE_MAX_WORDS) {
    return { ok: false, reason: "too_long", detail: `${text.length} chars` };
  }

  const owners = [f.title, f.caption].filter((x): x is string => x !== null).map((x) => x.normalize("NFC"));
  for (const span of quotedSpans(text)) {
    if (span === null || span.length === 0 || !owners.some((o) => o.includes(span))) {
      return { ok: false, reason: "altered_owner_text", detail: span === null ? "unmatched quotation mark" : `quoted: ${span}` };
    }
  }

  const corpusParts = [f.title, f.caption, f.date, f.place].filter((x): x is string => x !== null).map((x) => x.normalize("NFC"));
  const corpusText = corpusParts.join("\n");
  const corpusLower = corpusText.toLowerCase();
  const corpusTokens = new Set(tokensOf(corpusText).map((t) => t.toLowerCase()));
  const corpusNumbers = new Set<number>([...asciiNumbers(corpusText), ...(f.photos !== null ? [f.photos] : []), ...(f.people !== null ? [f.people] : [])]);
  const inCorpus = (w: string) => variants(w).some((v) => corpusTokens.has(v));

  for (const m of text.matchAll(/(?:https?:\/\/|www\.)\S+|[#@][\p{L}\p{N}_]+/giu)) {
    if (!corpusLower.includes(m[0].toLowerCase())) return { ok: false, reason: "unsupported_fact", detail: `handle or link: ${m[0]}` };
  }
  for (const n of asciiNumbers(text)) {
    if (!corpusNumbers.has(n)) return { ok: false, reason: "unsupported_fact", detail: `number: ${n}` };
  }

  for (const m of text.matchAll(TOKEN)) {
    const token = m[0];
    const lower = token.toLowerCase();
    if (/^\d+$/.test(token)) continue; // checked above
    if (/\p{Nd}/u.test(token) && !corpusText.includes(token)) return { ok: false, reason: "unsupported_fact", detail: `digits: ${token}` };
    if (caseless(token)) {
      if (!corpusText.includes(token)) return { ok: false, reason: "unsupported_fact", detail: `caseless: ${token}` };
      continue;
    }
    if (lower in NUMBER_WORDS) {
      if (!corpusNumbers.has(NUMBER_WORDS[lower]!) && !inCorpus(lower)) return { ok: false, reason: "unsupported_fact", detail: `number word: ${token}` };
      continue;
    }
    if (/^\p{Lu}/u.test(token) && !sentenceInitial(text, m.index ?? 0) && !CAPITALISED_VOCABULARY.has(token)) {
      if (!inCorpus(token)) return { ok: false, reason: "unsupported_fact", detail: `name: ${token}` };
      continue;
    }
    if (CLAIM_WORDS.has(lower) && !inCorpus(lower)) return { ok: false, reason: "unsupported_fact", detail: `claim: ${token}` };
  }
  return { ok: true, summary: text };
}
