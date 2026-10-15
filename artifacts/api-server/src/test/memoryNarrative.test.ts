/**
 * §2 MemoryNarrativeService, §18 NarrativeDerivative, §28.16 original voice —
 * census-highlights-memories H14, H172, H265 (B58 cluster MEM-NARR-1).
 *
 * WHAT THESE TESTS HOLD
 *   - The deterministic summary states only the owner's own facts: every clause
 *     names the facts it rests on, the text between clauses is a fixed separator,
 *     the owner's title and caption appear byte-identical (any script), and the
 *     date is never stated more precisely than the record supports.
 *   - The route and §18's NarrativeDerivative render the SAME summary, and the
 *     derivative is owner-only and never subscribed (nothing is stored).
 *   - The optional AI draft runs only behind the flag (3802, seeded FALSE), a VALID
 *     opt-in for this purpose at the current disclosure version, and the absence
 *     of the three model-excluding controls on THIS Memory. Every gate that cannot
 *     be read refuses; the model is never called on a refusal.
 *   - The model is sent the owner's own facts only: no coordinate, no tagged
 *     person, no item caption, the place at the Memory's §10 rung.
 *   - A draft that invents a person, venue, number, feeling or date, or rewrites
 *     the owner's quoted words, is refused and the deterministic summary served.
 *   - No narrative route writes a Memory or stores a summary; the one write is the
 *     caller's own consent row, server-stamped.
 *
 * The model is a stub (lib/openai.ts _setTestOpenAI). No real model is called.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/memoryNarrative.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs"; import { createHash } from "node:crypto"; // NARR-PHOTOS (§9 below): one line, this file is cited by line
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import memoryNarrativeRouter from "../routes/memoryNarrative.js";
import {
  EMPTY_NARRATIVE_SUMMARY,
  MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION,
  MEMORY_NARRATIVE_AI_FLAG,
  NARRATIVE_AI_MODEL,
  NARRATIVE_RENDERER,
  NARRATIVE_SEPARATORS,
  aiPlaceText,
  checkAiNarrative, MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT, NARRATIVE_AI_SYSTEM_PROMPT, aiSupportingFactIds, countNarrativeItems, itemsText, narrativeItemKind, // NARR-PHOTOS: one line
  narrativeAiFacts,
  occurrenceDate,
  renderDeterministicNarrative,
  type NarrativeAiFacts, type NarrativeItemCounts, type NarrativeItemRow,
  type NarrativeMemoryRow,
} from "../services/memory/memoryNarrative.js";
import { NARRATIVE_AI_EXCLUDING_CONTROLS } from "../services/memory/memoryNarrativeService.js";
import { deriveProjection } from "../services/memoryProjections/derivativeRegistry.js";
import { getProjectionDefinition } from "../services/memoryProjections/projectionRegistry.js";
import { EVENT_PROJECTIONS } from "../services/memoryProjections/outboxConsumer.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PENDING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const MEM = "10000000-0000-4000-8000-000000000001";
const MEM_THAI = "10000000-0000-4000-8000-000000000002";
const MEM_DELETED = "10000000-0000-4000-8000-000000000003";
const MEM_FRIEND = "10000000-0000-4000-8000-000000000004";
const MEM_MISSING = "10000000-0000-4000-8000-0000000000ff";

const TITLE = "Sunset walk";
const CAPTION = "Best bánh mì of the trip.";
const THAI_CAPTION = "ข้าวมันไก่ที่อร่อยที่สุด";
const ITEM_CAPTION = "the receipt with my card number";
const LAT = 16.054407;
const LNG = 108.202167;

type Row = Record<string, any>;

function memory(id: string, extra: Row): Row {
  return {
    id, owner_id: OWNER, title: TITLE, caption: CAPTION, visibility: "public", state: "published",
    allowed_user_ids: [FRIEND], hidden_user_ids: [STRANGER], trip_id: null, event_id: null, place_id: "fsq:abc",
    canonical_location_id: null, starts_at: "2025-03-12T18:30:00.000Z", ends_at: null,
    created_at: "2025-03-20T09:00:00.000Z", updated_at: "2025-03-20T09:00:00.000Z",
    location_city: "Da Nang", location_country: "Vietnam", location_lat: LAT, location_lng: LNG,
    location_precision: "exact", ...extra,
  };
}

function tables(): Record<string, Row[]> {
  return {
    memories: [
      memory(MEM, {}),
      memory(MEM_THAI, { title: null, caption: THAI_CAPTION, location_city: "Bangkok", location_country: "Thailand", location_lat: null, location_lng: null, starts_at: "2025-06-15T05:00:00.000Z" }),
      memory(MEM_DELETED, { state: "deleted" }),
      memory(MEM_FRIEND, { owner_id: FRIEND, title: "Friend's dinner", caption: "with everyone" }),
    ],
    memory_items: [0, 1, 2, 3].map((position) => ({ memory_id: MEM, media_url: `u/${position}.jpg`, media_type: "image/jpeg", position, caption: ITEM_CAPTION, visibility: position === 3 ? "only_me" : "everyone" })),
    memory_tags: [
      { memory_id: MEM, tagged_user_id: FRIEND, status: "approved" },
      { memory_id: MEM, tagged_user_id: STRANGER, status: "approved" },
      { memory_id: MEM, tagged_user_id: PENDING, status: "pending" },
    ],
    feature_flags: [],
    memory_narrative_ai_consent: [],
    memory_resurfacing_preferences: [],
    user_account_states: [],
  };
}

const AI_ON: Row = { flag: MEMORY_NARRATIVE_AI_FLAG, enabled: true };
const VALID_CONSENT: Row = { user_id: OWNER, enabled: true, consent_version: MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION, consented_at: "2026-10-14T00:00:00.000Z", withdrawn_at: null };

interface Fake { reads: string[]; writes: Array<{ table: string; op: string; values: unknown }> }

/** A table-backed fake that resolves `{ data, error }` the way supabase-js does, and records every read and write. */
function makeClient(store: Record<string, Row[]>, opts: { failReads?: string[]; absent?: string[]; failWrites?: string[]; truncate?: Record<string, number> }, fake: Fake) {
  function chain(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let columns: string[] | null = null;
    let countHead = false; let wantCount = false;
    let single = false;
    let op = "select";
    let values: any = null;
    let onConflict = "id";
    const q: any = {
      select(cols?: string, o?: { count?: string; head?: boolean }) {
        if (op === "select") {
          if (typeof cols === "string" && cols.trim() !== "*") columns = cols.split(",").map((c) => c.trim());
          if (o?.count && o?.head) countHead = true; else if (o?.count) wantCount = true;
        }
        return q;
      },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return q; },
      in(c: string, vs: unknown[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return q; },
      contains() { return q; },
      is(c: string, v: unknown) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
      order() { return q; },
      limit() { return q; },
      upsert(v: any, o?: { onConflict?: string }) { op = "upsert"; values = v; onConflict = o?.onConflict ?? "id"; return q; },
      insert(v: any) { op = "insert"; values = v; return q; },
      update(v: any) { op = "update"; values = v; return q; },
      delete() { op = "delete"; return q; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(f: any, r: any) { return run().then(f, r); },
    };
    async function run(): Promise<any> {
      if (op !== "select") {
        fake.writes.push({ table, op, values });
        if (opts.absent?.includes(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
        if (opts.failWrites?.includes(table)) return { data: null, error: { message: `${table} write failed` } };
        if (op !== "upsert") throw new Error(`unexpected ${op} on ${table}`);
        const arr = (store[table] ??= []);
        const i = arr.findIndex((r) => r[onConflict] === values[onConflict]);
        if (i >= 0) arr[i] = { ...arr[i], ...values }; else arr.push({ ...values });
        return { data: null, error: null };
      }
      fake.reads.push(table);
      if (opts.absent?.includes(table)) return { data: null, count: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      if (opts.failReads?.includes(table)) return { data: null, count: null, error: { message: `${table} unavailable` } };
      const rows = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (countHead) return { data: null, count: rows.length, error: null };
      const project = (r: Row) => (columns ? Object.fromEntries(columns.filter((c) => c in r).map((c) => [c, r[c]])) : { ...r });
      if (single) return { data: rows[0] ? project(rows[0]) : null, error: null };
      return { data: rows.map(project).slice(0, opts.truncate?.[table] ?? rows.length), count: wantCount ? rows.length : null, error: null };
    }
    return q;
  }
  return {
    from(table: string) { return chain(table); },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface ModelCall { params: any; opts: any }
interface App { baseUrl: string; store: Record<string, Row[]>; fake: Fake; calls: ModelCall[]; close: () => Promise<void> }

async function startApp(o: { mutate?: (s: Record<string, Row[]>) => void; failReads?: string[]; absent?: string[]; failWrites?: string[]; truncate?: Record<string, number>; reply?: string | (() => Promise<string>) } = {}): Promise<App> {
  const store = tables();
  o.mutate?.(store);
  const fake: Fake = { reads: [], writes: [] };
  const calls: ModelCall[] = [];
  _setTestClient(makeClient(store, o, fake) as any, true);
  _setTestOpenAI({
    chat: {
      completions: {
        create: async (params: any, opts: any) => {
          calls.push({ params, opts });
          const content = typeof o.reply === "function" ? await o.reply() : (o.reply ?? "A sunset walk in Da Nang, Vietnam on 13 March 2025, with 2 people and 4 photos.");
          return { choices: [{ message: { content } }] };
        },
      },
    },
  } as any);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoryNarrativeRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, store, fake, calls, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) });
    });
    srv.on("error", reject);
  });
}

async function call(app: App, method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(app.baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${actor}`, connection: "close", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Writes to anything but the caller's own consent row. */
const foreignWrites = (app: App) => app.fake.writes.filter((w) => w.table !== "memory_narrative_ai_consent");
const MEMORY_TABLES = ["memories", "memory_items", "memory_tags", "memory_narrative_ai_consent", "memory_resurfacing_preferences"];

let app: App | null = null;
afterEach(async () => { _setTestOpenAI(null); _resetRateLimit(); if (app) { await app.close(); app = null; } });

function row(extra: Partial<NarrativeMemoryRow> = {}): NarrativeMemoryRow {
  return { id: MEM, owner_id: OWNER, title: TITLE, caption: CAPTION, starts_at: "2025-03-12T18:30:00.000Z", location_city: "Da Nang", location_country: "Vietnam", location_lat: LAT, location_lng: LNG, ...extra };
}

/** Every clause names facts that exist; the summary is exactly the clauses and fixed separators. */
function assertClausesAreFacts(n: ReturnType<typeof renderDeterministicNarrative>) {
  const ids = new Set(n.facts.map((f) => f.fact_id));
  for (const s of n.segments) {
    assert.ok(s.fact_ids.length > 0, `clause "${s.text}" rests on no fact`);
    for (const id of s.fact_ids) assert.ok(ids.has(id), `clause "${s.text}" cites unknown fact ${id}`);
    assert.ok(NARRATIVE_SEPARATORS.includes(s.after), `separator ${JSON.stringify(s.after)} is not a fixed one`);
  }
  if (n.segments.length > 0) assert.equal(n.summary, n.segments.map((s) => s.text + s.after).join(""));
  assert.deepEqual(n.supporting_fact_ids, n.segments.flatMap((s) => s.fact_ids));
}

// ── 1. The deterministic renderer (pure) ──────────────────────────────────────

describe("H14: the deterministic summary states the owner's own facts and nothing else", () => {
  it("every clause names the facts it rests on; title and caption appear byte-identical; nothing is stored", () => {
    const n = renderDeterministicNarrative(row(), { items: imageItems(4), people: 2 });
    assertClausesAreFacts(n);
    assert.equal(n.renderer, NARRATIVE_RENDERER);
    assert.ok(n.summary.includes(`“${TITLE}”`) && n.summary.includes(`“${CAPTION}”`), n.summary);
    assert.equal(n.summary, "“Sunset walk”, 13 March 2025, in Da Nang, Vietnam. 4 photos, with 2 people. You wrote: “Best bánh mì of the trip.”");
    assert.deepEqual([n.editable, n.stored], [true, false]);
    for (const f of n.facts) assert.ok(!f.text.includes(String(LAT)) && !f.text.includes(String(LNG)), `fact ${f.kind} carries a coordinate`);
  });

  it("H265: the owner's words keep their own script and are never trimmed inside, translated or guessed a language", () => {
    const padded = `  ${THAI_CAPTION}\n`;
    const n = renderDeterministicNarrative(row({ title: null, caption: padded, location_lat: null, location_lng: null }), { items: [], people: 0 });
    assertClausesAreFacts(n);
    assert.ok(n.summary.includes(`“${THAI_CAPTION}”`));
    assert.equal(n.original_text.caption, padded, "original_text is the stored value, byte for byte");
    assert.equal(n.original_text.title, null);
    assert.equal(n.original_language, "und", "no language is stored for a Memory, so none is claimed");
  });

  it("the date is the day it STARTED in the place's own time zone — 18:30 UTC is the next morning in Da Nang", () => {
    assert.deepEqual(occurrenceDate(row()), { text: "13 March 2025", granularity: "day", basis: "place_time_zone" });
  });

  it("without a coordinate the date is only as precise as every time zone agrees: month, else year, else nothing", () => {
    const at = (iso: string) => occurrenceDate({ starts_at: iso, location_lat: null, location_lng: null });
    assert.deepEqual(at("2025-03-12T11:00:00.000Z"), { text: "March 2025", granularity: "month", basis: "every_time_zone" });
    assert.equal(at("2025-03-31T11:00:00.000Z")?.text, "2025", "31 March in UTC−12 is 1 April in UTC+14");
    assert.equal(at("2025-12-31T23:00:00.000Z"), null, "both years are possible, so no date is stated");
  });

  it("created_at is when the Memory was MADE: with no start time there is no date fact", () => {
    const n = renderDeterministicNarrative(row({ starts_at: null }), { items: [], people: 0 });
    assert.ok(!n.facts.some((f) => f.kind === "occurred_on"));
    assert.ok(!/2025/.test(n.summary), n.summary);
  });

  it("a Memory with nothing to say says so, citing nothing", () => {
    const n = renderDeterministicNarrative(row({ title: "  ", caption: null, starts_at: null, location_city: null, location_country: null }), { items: [], people: 0 });
    assert.equal(n.summary, EMPTY_NARRATIVE_SUMMARY);
    assert.deepEqual([n.segments, n.supporting_fact_ids, n.facts], [[], [], []]);
  });
});

// ── 2. What the model may be sent (pure) ──────────────────────────────────────

describe("H172: the AI facts are the owner's own, at the Memory's §10 rung, with no coordinate", () => {
  it("the place follows the publication rung, and an unreadable gate sends no place", () => {
    assert.equal(aiPlaceText(row({ location_precision: "city" }), "on"), "Da Nang, Vietnam");
    assert.equal(aiPlaceText(row({ location_precision: "country" }), "on"), "Vietnam");
    assert.equal(aiPlaceText(row({ location_precision: "hidden" }), "on"), null);
    assert.equal(aiPlaceText(row({}), "on"), null, "gate on and the rung not read ⇒ hidden, never exact");
    assert.equal(aiPlaceText(row({ location_precision: "exact" }), "unreadable"), null);
    assert.equal(aiPlaceText(row({}), "off"), "Da Nang, Vietnam", "gate off: the pre-2338 reading, still only city and country");
  });

  it("no coordinate, no zero counts", () => {
    const f = narrativeAiFacts(row(), { items: [], people: 0 }, "off");
    assert.deepEqual(f, { title: TITLE, caption: CAPTION, date: "13 March 2025", place: "Da Nang, Vietnam", photos: null, people: null });
  });
});

// ── 3. The check every AI draft must pass (pure): an ALLOWLIST ────────────────
//
// The tables below include, verbatim, all 83 drafts of the PR #720 verifier's
// adversarial battery (v720-adversarial.ts): the 80 that state something the
// facts do not hold (the first, blocklist, version accepted 50 of them) are in
// INVENTING; its 3 faithful ones are in FAITHFUL, with 9 more.

const F_FACTS: NarrativeAiFacts = { title: "Sunset walk", caption: "Best bánh mì of the trip.", date: "13 March 2025", place: "Da Nang, Vietnam", photos: 4, people: 2 };
const F_SOLO: NarrativeAiFacts = { title: "Sunset walk", caption: "Best bánh mì of the trip.", date: "13 March 2025", place: "Da Nang, Vietnam", photos: 3, people: null };
const F_NOCAP: NarrativeAiFacts = { title: "Quiet day", caption: null, date: "March 2025", place: "Vietnam", photos: null, people: null };
const F_NEG: NarrativeAiFacts = { title: "Hanoi", caption: "Not the best night ever, honestly.", date: "2025", place: null, photos: 1, people: null };
const F_THAI: NarrativeAiFacts = { title: null, caption: THAI_CAPTION, date: "June 2025", place: "Bangkok, Thailand", photos: null, people: null };

/** [draft, facts] — each states something the facts do not hold. */
const INVENTING: Array<[string, NarrativeAiFacts]> = [
  // names and places, in any case or position
  ["Marcus came along for the sunset walk in Da Nang, Vietnam.", F_FACTS],
  ["Nobu was the stop after the sunset walk in Da Nang, Vietnam.", F_FACTS],
  ["Paris. A sunset walk with 2 people and 4 photos.", F_FACTS],
  ["What a walk! Marcus loved it.", F_FACTS],
  ["A sunset walk with marcus at nobu in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk that ended in hanoi, with 2 people and 4 photos.", F_FACTS],
  ["IV people joined the sunset walk.", F_FACTS],
  // pronouns and company
  ["A sunset walk with her in Da Nang, Vietnam, with 3 photos.", F_SOLO],
  ["We took a sunset walk in Da Nang, Vietnam and 3 photos came home with us.", F_SOLO],
  ["A sunset walk with mates in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with locals and strangers in Da Nang, Vietnam.", F_FACTS],
  // activities, places, food
  ["A quiet stroll along the river in Da Nang, Vietnam, on 13 March 2025.", F_FACTS],
  ["Snorkeling and surfing off the coast near Da Nang, Vietnam, on 13 March 2025.", F_FACTS],
  ["A sunset walk, then sushi and sake in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk from the hotel pool to the harbour in Da Nang, Vietnam.", F_FACTS],
  ["A long drive into the mountains after the sunset walk near Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk, some shopping and a spa visit in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk after a day of meetings in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk after the funeral in Da Nang, Vietnam.", F_FACTS],
  // feelings and outcomes
  ["A sunset walk full of laughter and a few tears in Da Nang, Vietnam.", F_FACTS],
  ["A nice sunset walk, though the weather was terrible, in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk that was simply sublime and serene in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk where someone got kissed in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk cut short by food poisoning in Da Nang, Vietnam.", F_FACTS],
  // time, weather, season
  ["A spring sunset walk in Da Nang, Vietnam.", F_FACTS],
  ["A fall sunset walk in Da Nang, Vietnam.", F_FACTS],
  ["A humid, foggy sunset walk in monsoon season in Da Nang, Vietnam.", F_FACTS],
  ["Met at 3 pm for a sunset walk in Da Nang, Vietnam.", F_SOLO],
  ["A weekend sunset walk in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk at christmas in Da Nang, Vietnam.", F_FACTS],
  // numbers
  ["A sunset walk taken twice in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with countless photos and several people in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with a few photos in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with half a dozen photos in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with 4 people in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with two photos and four people in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with 4 pictures of 2 friends in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with 4 selfies in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with 2 of the photos showing 4 of the people in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with 4 photos and 2 kids in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with 4 photos and 2 dogs in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk on 12 March 2025 in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk in 2024 in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk in April in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk on March 14 in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk on the 2 of the month in Da Nang, Vietnam.", F_FACTS],
  ["A second sunset walk in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with ４ photos in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with 4² photos in Da Nang, Vietnam.", F_FACTS],
  // the owner's words, quoted or re-cut
  ["You wrote: “Best banh mi of the trip”.", F_FACTS],
  ["You wrote 'Best banh mi of the trip'.", F_FACTS],
  ["The best of the trip, the bánh mì.", F_FACTS],
  ["You wrote: “the best night ever”.", F_NEG],
  ["The best night ever, honestly, in Hanoi.", F_NEG],
  ["“Sunset  walk” in Da Nang, Vietnam.", F_FACTS],
  ["“Sunset” in Da Nang, Vietnam.", F_FACTS],
  // other languages and scripts
  ["Une promenade au coucher du soleil avec des amis à Da Nang, Vietnam.", F_FACTS],
  ["Un paseo al atardecer con mi novia en Da Nang, Vietnam.", F_FACTS],
  ["Ein Spaziergang mit meiner Frau in Da Nang, Vietnam.", F_FACTS],
  ["Đi dạo hoàng hôn cùng bạn bè ở Da Nang, Vietnam.", F_FACTS],
  ["เดินเล่นกับเพื่อน in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk с друзьями in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk with Mаrcus in Da Nang, Vietnam.", F_FACTS],
  // emoji, symbols, links
  ["A sunset walk in Da Nang, Vietnam 🍣🍷❤️👫🏖️", F_FACTS],
  ["🍣🍷❤️", F_FACTS],
  ["A sunset walk with @marcus_t in Da Nang, Vietnam.", F_FACTS],
  ["A sunset walk in Da Nang, Vietnam — see https://example.com/x", F_FACTS],
  ["A sunset walk in Da Nang, Vietnam — see example.com/marcus", F_FACTS],
  ["A sunset walk in Da Nang, Vietnam #couplegoals", F_FACTS],
  ["A sunset walk in Da Nang, Vietnam; write to marcus@example.com", F_FACTS],
  ["A sunset walk in Da Nang, Vietnam; call 0905 123 456", F_FACTS],
  // structure
  ["“A sunset walk with Marcus in Da Nang, Vietnam.”", F_FACTS],
  ["Marcus. Nobu. Paris.", F_FACTS],
  ["A sunset walk in Da Nang, Vietnam\nMarcus joined", F_FACTS],
  ["A sunset walk in Da Nang, Vietnam: Marcus joined", F_FACTS],
  ["A sunset walk in Da Nang, Vietnam — Marcus joined", F_FACTS],
  ["A sunset walk with MARCUS in Da Nang, Vietnam.", F_FACTS],
  ["A quiet day in Vietnam on 5 March 2025.", F_NOCAP],
  ["A quiet day with friends in Vietnam in March 2025.", F_NOCAP],
  ["A quiet day in Vietnam with no photos.", F_NOCAP],
];

/** Faithful drafts: every word is a fact, a bound number or a connecting word. */
const FAITHFUL: Array<[string, NarrativeAiFacts]> = [
  ["A sunset walk in Da Nang, Vietnam on 13 March 2025, with 2 people and 4 photos.", F_FACTS],
  ["A quiet day in Vietnam in March 2025.", F_NOCAP],
  ["A sunset walk on the 13th in Da Nang, Vietnam.", F_FACTS],
  ["Sunset walk in Da Nang with four photos and two people.", F_FACTS],
  ["A sunset walk on March 13, 2025 with two people.", F_FACTS],
  ["You wrote “Best bánh mì of the trip.” about this Memory from March 2025.", F_FACTS],
  ["You wrote 'Best bánh mì of the trip' in Da Nang's sunset walk.", F_FACTS],
  ["A Memory titled “Sunset walk”, from Da Nang, Vietnam.", F_FACTS],
  ["Best bánh mì of the trip, on a sunset walk in Da Nang, Vietnam.", F_FACTS],
  ["“Not the best night ever, honestly.” A Memory from Hanoi, 2025, with 1 photo.", F_NEG],
  [`You wrote “${THAI_CAPTION}” in Bangkok, Thailand, in June 2025.`, F_THAI],
  ["A sunset walk.", F_FACTS],
];

describe("§1 / §28.16: an AI draft is an ALLOWLIST over the facts it was sent", () => {
  const verdict = (t: string, facts: NarrativeAiFacts = F_FACTS) => { const c = checkAiNarrative(t, facts, photosOnly(facts)); return c.ok ? "ok" : `${c.reason}: ${c.detail}`; };

  it(`every one of the ${INVENTING.length} inventing drafts (the verifier's battery) is refused`, () => {
    const accepted = INVENTING.filter(([t, facts]) => checkAiNarrative(t, facts, photosOnly(facts)).ok).map(([t]) => t);
    assert.deepEqual(accepted, [], "these state something the facts do not hold");
  });

  it(`every one of the ${FAITHFUL.length} faithful drafts is accepted`, () => {
    for (const [t, facts] of FAITHFUL) assert.equal(verdict(t, facts), "ok", t);
  });

  // ONE fault per draft, so each rule is the one that decides (and a mutant of it shows).
  const SINGLE_FAULT: Array<[string, string, NarrativeAiFacts?]> = [
    ["A sunset walk in Da Nang, Vietnam 🍣", "unsupported_fact: symbol: 🍣"],
    ["A sunset walk with ４ photos in Da Nang, Vietnam.", "unsupported_fact: symbol: ４"],
    ["You wrote “Best bánh mì of the trip.", "altered_owner_text: unmatched quotation mark"],
    ["You wrote: “the best night ever”.", "altered_owner_text: quoted: the best night ever", F_NEG],
    ["“Sunset” in Da Nang, Vietnam.", "altered_owner_text: quoted: Sunset"],
    ["You wrote 'Best banh mi of the trip'.", "altered_owner_text: quoted: Best banh mi of the trip"],
    ["The best night ever, in Hanoi.", "unsupported_fact: word: best", F_NEG],
    ["Marcus and a sunset walk in Da Nang, Vietnam.", "unsupported_fact: word: marcus"],
    ["A sunset walk with marcus in Da Nang, Vietnam.", "unsupported_fact: word: marcus"],
    ["A sunset walk in Paris.", "unsupported_fact: word: paris"],
    ["A sunset walk with her in Da Nang, Vietnam.", "unsupported_fact: word: her", F_SOLO],
    ["A spring sunset walk in Da Nang, Vietnam.", "unsupported_fact: word: spring"],
    ["A sunset walk in Da Nang, Vietnam, not with 2 people.", "unsupported_fact: word: not"],
    ["A sunset walk with people in Da Nang, Vietnam.", "unsupported_fact: word: people", F_SOLO],
    ["A quiet day in Vietnam with photos.", "unsupported_fact: word: photos", F_NOCAP],
    ["A sunset walk with 4 people.", "unsupported_fact: count: 4 people"],
    ["A sunset walk with two photos.", "unsupported_fact: count: two photos"],
    ["A sunset walk for two in Da Nang, Vietnam.", "unsupported_fact: number word: two"],
    ["A sunset walk in Da Nang, Vietnam, 13.", "unsupported_fact: number: 13"],
    ["A sunset walk on 12 March 2025.", "unsupported_fact: number: 12"],
    ["A sunset walk in 2024.", "unsupported_fact: number: 2024"],
    ["A sunset walk in April.", "unsupported_fact: word: april"],
    ["A sunset walk in April 2025.", "unsupported_fact: word: april"],
    ["A sunset walk on the 12th in Da Nang, Vietnam.", "unsupported_fact: number: 12th"],
    ["A sunset walk with 2 of the photos.", "unsupported_fact: number: 2"],
    // fix round 2 (verifier delta on 5d0ab86fc): F1 attribution, F2 ordinal day, F3 implied counts, month homonym, repetition
    ["You wrote Vietnam.", "unsupported_fact: word: wrote"],
    ["The Memory titled Da Nang, Vietnam.", "unsupported_fact: word: titled"],
    ["A Memory titled “Best bánh mì of the trip.”", "unsupported_fact: word: titled"],
    ["With the 13th person in Da Nang, Vietnam.", "unsupported_fact: number: 13th"],
    ["The 13th of the people in Da Nang, Vietnam.", "unsupported_fact: number: 13th"],
    ["A person in Da Nang, Vietnam.", "unsupported_fact: count: person"],
    ["A photo from Da Nang, Vietnam.", "unsupported_fact: count: photo"],
    ["A Memory from Hanoi with photos.", "unsupported_fact: count: photos", F_NEG],
    ["A march in Da Nang, Vietnam.", "unsupported_fact: word: march"],
    ["4 photos and 4 photos.", "unsupported_fact: repeated: 4 photos"],
  ];
  for (const [draft, expected, facts] of SINGLE_FAULT) {
    it(`single fault — ${expected}`, () => assert.equal(verdict(draft, facts ?? F_FACTS), expected, draft));
  }

  it("a Thai caption quoted exactly passes; re-spaced inside quotes, or a Thai word it never held, does not", () => {
    assert.equal(verdict(`You wrote “${THAI_CAPTION}” in Bangkok, Thailand.`, F_THAI), "ok");
    assert.match(verdict("You wrote “ข้าวมันไก่ อร่อย”.", F_THAI), /^altered_owner_text/);
    assert.match(verdict("ข้าวมันไก่ ร้านอาหาร", F_THAI), /^unsupported_fact/);
  });

  it("empty and over-long drafts are refused", () => {
    assert.match(verdict("   "), /^empty_output/);
    assert.match(verdict(`A sunset walk in Da Nang. ${"Da Nang ".repeat(60)}`), /^too_long/);
  });
});

// ── 3b. The verifier's SECOND battery (PR #720 delta on 5d0ab86fc), copied ─────
// verbatim from v720-adversarial2.ts (invisible characters written as \u escapes).
// REFUSE: states something false. ACCEPT: true. RESIDUAL: a relation or order
// between true facts, which a word allowlist cannot judge — accepted, and named
// in Q-NARR-7 (asserted here so the statement stays true). OVER_REFUSED: true,
// but uses a verb outside the allowlist ("has", "taken"); refused by design and
// the template is served.

const B2_F: NarrativeAiFacts = { ...F_FACTS };
const B2_F_SOLO: NarrativeAiFacts = { ...B2_F, photos: 3, people: null };
const B2_F_NEG: NarrativeAiFacts = F_NEG;
const B2_F_MAY: NarrativeAiFacts = { title: "Bath day", caption: null, date: "May 2025", place: "Bath, England", photos: 2, people: null };
const B2_F_APOS: NarrativeAiFacts = { title: "Friend's dinner", caption: "Tom's 3 beers and Anna", date: "13 March 2025", place: "Nice, France", photos: 1, people: 1 };
type B2Kind = "REFUSE" | "ACCEPT" | "RESIDUAL" | "OVER_REFUSED";
const BATTERY_2: Array<[string, string, NarrativeAiFacts, B2Kind]> = [
  ["N1 'You wrote' + place", "You wrote Vietnam.", B2_F, "REFUSE"],
  ["N2 'titled' + place", "The Memory titled Da Nang, Vietnam.", B2_F, "REFUSE"],
  ["N3 'You wrote' + count", "You wrote 4 photos.", B2_F, "REFUSE"],
  ["N4 ordinal day as a person", "With the 13th person in Da Nang, Vietnam.", B2_F, "REFUSE"],
  ["N5 ordinal day as a photo", "The 13th photo of 4 photos.", B2_F, "REFUSE"],
  ["N5b 'the 13th of the people'", "The 13th of the people in Da Nang, Vietnam.", B2_F, "REFUSE"],
  ["N6 'a person' (people=2)", "A person in Da Nang, Vietnam.", B2_F, "REFUSE"],
  ["N7 'a photo' (photos=4)", "A photo from Da Nang, Vietnam.", B2_F, "REFUSE"],
  ["N8 people FROM place (order)", "2 people from Vietnam.", B2_F, "RESIDUAL"],
  ["N9 'the people of Vietnam'", "The people of Vietnam in 4 photos.", B2_F, "RESIDUAL"],
  ["N10 month homonym as activity", "A march in Da Nang, Vietnam with 2 people.", B2_F, "REFUSE"],
  ["N11 geography reversed", "Sunset walk to Vietnam from Da Nang.", B2_F, "RESIDUAL"],
  ["N12 false geography", "Vietnam is in Da Nang.", B2_F, "RESIDUAL"],
  ["N13 counts repeated", "4 photos and 4 photos and 4 photos of 2 people and 2 people.", B2_F, "REFUSE"],
  ["N14 title+caption spliced unquoted", "Sunset walk Best bánh mì of the trip in Da Nang, Vietnam.", B2_F, "ACCEPT"],
  ["N15 caption run + re-cut tail", "Best bánh mì of the trip of the trip.", B2_F, "REFUSE"],
  ["N16 title run broken by a function word", "Sunset in walk, Da Nang.", B2_F, "REFUSE"],
  ["N17 month homonym 'may' + place homonym 'bath'", "A bath in Bath, England in May.", B2_F_MAY, "REFUSE"],
  ["N18 'Nice' place as adjective", "A Friend's dinner in Nice, France, Nice.", B2_F_APOS, "ACCEPT"],
  ["N19 owner number outside its run", "3 beers in Nice, France.", B2_F_APOS, "REFUSE"],
  ["N20 owner name outside its run", "Anna in Nice, France.", B2_F_APOS, "REFUSE"],
  ["N21 caption contradicts count, verbatim", "Tom's 3 beers and Anna with 1 person.", B2_F_APOS, "ACCEPT"],
  ["N22 zero-width space inside place", "Sunset walk in Da\u200BNang, Vietnam.", B2_F, "REFUSE"],
  ["N23 NBSP inside place", "Sunset walk in Da\u00A0Nang, Vietnam.", B2_F, "ACCEPT"],
  ["N24 Cyrillic а homoglyph", "Sunset walk in Da Nаng, Vietnam.", B2_F, "REFUSE"],
  ["N25 fullwidth letters", "Sunset walk in Da Nang, Ｖｉｅｔｎａｍ.", B2_F, "REFUSE"],
  ["N26 combining acute on place", "Sunset walk in Da Nang, Vietnam\u0301.", B2_F, "REFUSE"],
  ["N27 ALL CAPS faithful", "SUNSET WALK IN DA NANG, VIETNAM WITH 2 PEOPLE.", B2_F, "ACCEPT"],
  ["N28 soft hyphen", "Sunset walk in Da Nang, Viet\u00ADnam.", B2_F, "REFUSE"],
  ["N29 quote lowercased", "“sunset walk” in Da Nang, Vietnam.", B2_F, "REFUSE"],
  ["N30 quote with trailing period", "“Sunset walk.” in Da Nang, Vietnam.", B2_F, "ACCEPT"],
  ["N31 nested quotes", "“Sunset walk “in” Vietnam”.", B2_F, "REFUSE"],
  ["N32 two whole quotes", "“Sunset walk” — “Best bánh mì of the trip.”", B2_F, "ACCEPT"],
  ["N33 straight single quotes whole caption", "'Best bánh mì of the trip' in Da Nang, Vietnam.", B2_F, "ACCEPT"],
  ["N34 straight paraphrase", "You wrote 'Best banh mi of the trip'.", B2_F, "REFUSE"],
  ["N35 apostrophe title quoted", "“Friend's dinner” in Nice, France.", B2_F_APOS, "ACCEPT"],
  ["N36 possessive on place", "Da Nang's 4 photos.", B2_F, "ACCEPT"],
  ["N37 selective quote via title ⊂ caption", "“Hanoi” — Not the best night ever, honestly.", B2_F_NEG, "ACCEPT"],
  ["N38 caption re-cut drops 'Not'", "The best night ever, honestly, in Hanoi.", B2_F_NEG, "REFUSE"],
  ["N39 negation words", "No photos, not in Vietnam, without 2 people.", B2_F, "REFUSE"],
  ["N40 pronoun company (solo)", "Sunset walk with her in Da Nang, Vietnam.", B2_F_SOLO, "REFUSE"],
  ["N41 'you' as company", "You and 2 people in Da Nang, Vietnam.", B2_F, "ACCEPT"],
  ["N42 'March 13, 2025'", "Sunset walk on March 13, 2025 in Da Nang, Vietnam.", B2_F, "ACCEPT"],
  ["N43 '13 Vietnam'", "13 Vietnam.", B2_F, "REFUSE"],
  ["N44 '4 of the people'", "4 of the people in Da Nang, Vietnam.", B2_F, "REFUSE"],
  ["N45 '2 photos of people'", "2 photos of people.", B2_F, "REFUSE"],
  ["N46 'two people' words", "Sunset walk with two people and four photos.", B2_F, "ACCEPT"],
  ["N47 'twenty' unbound", "Sunset walk with twenty in Da Nang.", B2_F, "REFUSE"],
  ["N48 year as count", "2025 photos.", B2_F, "REFUSE"],
  ["N49 'photos' with photos=null", "Photos in Vietnam.", { ...B2_F, photos: null }, "REFUSE"],
  ["N50 'the 13th' bare", "Sunset walk on the 13th in Da Nang, Vietnam.", B2_F, "ACCEPT"],
  ["N51 80 function words", Array(80).fill("a").join(" "), B2_F, "ACCEPT"],
  ["N52 81 words", Array(81).fill("a").join(" "), B2_F, "REFUSE"],
  ["N53 400 chars of place", Array(60).fill("Da Nang").join(" ").slice(0, 401), B2_F, "REFUSE"],
  ["N54 punctuation storm", "Sunset walk!!! ... Da Nang??? — Vietnam; (2 people) [4 photos]", B2_F, "REFUSE"],
  ["N55 newline + tab", "Sunset walk\n\tin Da Nang, Vietnam", B2_F, "ACCEPT"],
  ["N56 verb-y faithful (over-refusal probe)", "Your Memory “Sunset walk” from 13 March 2025 in Da Nang, Vietnam has 4 photos and 2 people.", B2_F, "OVER_REFUSED"],
  ["N57 natural faithful", "A Sunset walk in Da Nang, Vietnam on 13 March 2025, with 2 people and 4 photos.", B2_F, "ACCEPT"],
  ["N58 'This Memory is from'", "This Memory is from Da Nang, Vietnam, on 13 March 2025: 4 photos with 2 people.", B2_F, "ACCEPT"],
  ["N59 'was' faithful", "Sunset walk was in Da Nang, Vietnam on 13 March 2025.", B2_F, "ACCEPT"],
  ["N60 'taken' faithful-ish", "4 photos taken in Da Nang, Vietnam.", B2_F, "OVER_REFUSED"],
];

describe("the verifier's second battery: binding holes closed, the residual named", () => {
  const of = (kind: B2Kind) => BATTERY_2.filter((r) => r[3] === kind);
  it("has all 61 drafts", () => assert.equal(BATTERY_2.length, 61));
  it("every draft that states something false is refused", () => {
    const accepted = of("REFUSE").filter(([, t, facts]) => checkAiNarrative(t, facts, photosOnly(facts)).ok).map(([n]) => n);
    assert.deepEqual(accepted, []);
  });
  it("every faithful draft is accepted", () => {
    for (const [n, t, facts] of of("ACCEPT")) { const c = checkAiNarrative(t, facts, photosOnly(facts)); assert.ok(c.ok, `${n}: ${c.ok ? "" : c.detail}`); }
  });
  it("Q-NARR-7's residual — relations and order between true facts — is accepted, exactly these four", () => {
    assert.deepEqual(of("RESIDUAL").filter(([, t, facts]) => checkAiNarrative(t, facts, photosOnly(facts)).ok).map(([n]) => n.split(" ")[0]), ["N8", "N9", "N11", "N12"]);
  });
  it("Q-NARR-7's other residual — a homonym of a place word — is accepted; the month's homonyms are not", () => {
    assert.equal(checkAiNarrative("A bath in Bath, England in May 2025.", B2_F_MAY, photosOnly(B2_F_MAY)).ok, true, "'bath' is the place's own word");
    assert.equal(checkAiNarrative("A bath in Bath, England in May.", B2_F_MAY, photosOnly(B2_F_MAY)).ok, false, "'May' alone is not the date");
  });
  it("verbs outside the allowlist are refused by design (the template is served)", () => {
    for (const [n, t, facts] of of("OVER_REFUSED")) assert.equal(checkAiNarrative(t, facts, photosOnly(facts)).ok, false, n);
  });
});

// ── 4. §18 NarrativeDerivative ────────────────────────────────────────────────

describe("H172: NarrativeDerivative is the same deterministic summary, owner-only, never stored", () => {
  const client = (store = tables()) => makeClient(store, {}, { reads: [], writes: [] }) as any;

  it("is BUILDABLE and derives, for the owner, exactly what the route renders", async () => {
    const def = getProjectionDefinition("NarrativeDerivative")!;
    assert.equal(def.availability, "BUILDABLE");
    const r = await deriveProjection(client(), "NarrativeDerivative", { owner_id: OWNER, viewer_id: OWNER });
    assert.ok(r.ok, JSON.stringify(r));
    const mem = r.value.rows.find((x) => x.memory_id === MEM)!;
    const expected = renderDeterministicNarrative(memory(MEM, {}) as any, { items: imageItems(4), people: 2 });
    assert.equal(mem.summary, expected.summary);
    assert.deepEqual(mem.supporting_fact_ids, expected.supporting_fact_ids);
    assert.deepEqual(Object.keys(mem).sort(), [...def.field_whitelist].sort());
    assert.ok(!r.value.rows.some((x) => x.memory_id === MEM_DELETED || x.memory_id === MEM_FRIEND), "deleted and other people's Memories are not narrated");
    const wire = JSON.stringify(r.value.rows);
    for (const leak of [String(LAT), String(LNG), FRIEND, STRANGER, ITEM_CAPTION]) assert.ok(!wire.includes(leak), `derivative carries ${leak}`);
  });

  it("builds nothing for anyone but the owner, and nothing for a shared build", async () => {
    for (const viewer of [FRIEND, null]) {
      const r = await deriveProjection(client(), "NarrativeDerivative", { owner_id: OWNER, viewer_id: viewer });
      assert.ok(r.ok);
      assert.deepEqual(r.value.rows, [], `viewer ${viewer}`);
    }
  });

  it("no outbox event subscribes it, so no narrative is ever registered (Q-NARR-4)", () => {
    for (const ids of Object.values(EVENT_PROJECTIONS)) assert.ok(!ids.includes("NarrativeDerivative"));
  });
});

// ── 5. GET /memories/:id/narrative ────────────────────────────────────────────

describe("GET /memories/:id/narrative — the owner's deterministic summary", () => {
  it("serves the owner the summary, every clause a fact, the caption byte-identical, and writes nothing", async () => {
    app = await startApp();
    const before = JSON.stringify(app.store);
    const r = await call(app, "GET", `/api/memories/${MEM}/narrative`, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assertClausesAreFacts(r.body.narrative);
    assert.ok(r.body.narrative.summary.includes(CAPTION));
    assert.equal(r.body.narrative.original_text.caption, CAPTION);
    assert.ok(r.body.narrative.summary.includes("4 photos, with 2 people"), "4 items, 2 APPROVED tags (the pending one is not counted)");
    const wire = JSON.stringify(r.body);
    for (const leak of [String(LAT), FRIEND, STRANGER, ITEM_CAPTION]) assert.ok(!wire.includes(leak), `response carries ${leak}`);
    assert.equal(JSON.stringify(app.store), before);
    assert.deepEqual(app.fake.writes, []);
    assert.equal(app.calls.length, 0, "the deterministic summary never calls a model");
  });

  it("someone else's Memory, a missing one and the owner's deleted one are the same 404", async () => {
    app = await startApp();
    assert.equal((await call(app, "GET", `/api/memories/${MEM}/narrative`, FRIEND)).status, 404, "a public Memory is still not someone else's to summarize");
    assert.equal((await call(app, "GET", `/api/memories/${MEM_MISSING}/narrative`, OWNER)).status, 404);
    assert.equal((await call(app, "GET", `/api/memories/${MEM_DELETED}/narrative`, OWNER)).status, 404);
    assert.equal((await call(app, "GET", `/api/memories/not-a-uuid/narrative`, OWNER)).status, 404);
  });

  for (const table of ["memories", "memory_items", "memory_tags"]) {
    it(`an unreadable ${table} is 503 — never a summary over a failed read`, async () => {
      app = await startApp({ failReads: [table] });
      const r = await call(app, "GET", `/api/memories/${MEM}/narrative`, OWNER);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, "degraded_unavailable");
    });
  }

  it("offers the AI draft only when every gate is open, and says which gate is closed", async () => {
    const offer = async (mutate: (s: Record<string, Row[]>) => void, o: { failReads?: string[] } = {}) => {
      app = await startApp({ mutate, ...o });
      const r = await call(app, "GET", `/api/memories/${MEM}/narrative`, OWNER);
      await app.close(); app = null;
      assert.equal(r.status, 200, "a closed gate never withholds the deterministic summary");
      return r.body.ai;
    };
    assert.deepEqual(await offer(() => {}), { available: false, reason: "feature_disabled" });
    assert.deepEqual(await offer((s) => { s.feature_flags.push(AI_ON); }), { available: false, reason: "consent_required" });
    assert.deepEqual(await offer((s) => { s.feature_flags.push(AI_ON); s.memory_narrative_ai_consent.push(VALID_CONSENT); s.memory_resurfacing_preferences.push({ memory_id: MEM, owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER" }); }),
      { available: false, reason: "excluded_by_control", controls: ["KEEP_PRIVATE_FOREVER"] });
    assert.deepEqual(await offer((s) => { s.feature_flags.push(AI_ON); s.memory_narrative_ai_consent.push(VALID_CONSENT); }, { failReads: ["memory_resurfacing_preferences"] }), { available: false, reason: "unavailable" });
    assert.deepEqual(await offer((s) => { s.feature_flags.push(AI_ON); s.memory_narrative_ai_consent.push(VALID_CONSENT); }), { available: true, reason: null });
  });
});

// ── 6. POST /memories/:id/narrative/ai ────────────────────────────────────────

const open = (s: Record<string, Row[]>) => { s.feature_flags.push(AI_ON); s.memory_narrative_ai_consent.push(VALID_CONSENT); };

describe("POST /memories/:id/narrative/ai — gates, each fail-closed, and the model never called on a refusal", () => {
  it("flag OFF (the seed): 404 feature_disabled, the model is never called and no Memory table is read", async () => {
    app = await startApp({ mutate: (s) => { s.feature_flags.push({ flag: MEMORY_NARRATIVE_AI_FLAG, enabled: false }); s.memory_narrative_ai_consent.push(VALID_CONSENT); } });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.deepEqual([r.status, r.body.error], [404, "feature_disabled"]);
    assert.equal(app.calls.length, 0);
    assert.deepEqual(app.fake.reads.filter((t) => MEMORY_TABLES.includes(t)), [], "a dark feature reads nothing but its flag");
  });

  it("flag absent (3802 unapplied) is OFF; flag unreadable is 503; neither calls the model", async () => {
    app = await startApp({ mutate: (s) => { s.memory_narrative_ai_consent.push(VALID_CONSENT); } });
    assert.equal((await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER)).status, 404);
    await app.close();
    app = await startApp({ mutate: open, failReads: ["feature_flags"] });
    assert.equal((await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER)).status, 503);
    assert.equal(app.calls.length, 0);
  });

  it("no consent, a withdrawn one, one for older words, or an absent consent table: 403 consent_required, model never called", async () => {
    const cases: Array<[string, (s: Record<string, Row[]>) => void, string[]]> = [
      ["none", (s) => { s.feature_flags.push(AI_ON); }, []],
      ["withdrawn", (s) => { s.feature_flags.push(AI_ON); s.memory_narrative_ai_consent.push({ ...VALID_CONSENT, enabled: false, withdrawn_at: "2026-10-14T01:00:00.000Z" }); }, []],
      ["older words", (s) => { s.feature_flags.push(AI_ON); s.memory_narrative_ai_consent.push({ ...VALID_CONSENT, consent_version: "memory_narrative_ai_v0" }); }, []],
      ["another purpose's consent only", (s) => { s.feature_flags.push(AI_ON); s.input_memory_context_consent = [{ ...VALID_CONSENT, consent_version: "input_memory_context_v1" }]; }, []],
      ["table absent", (s) => { s.feature_flags.push(AI_ON); }, ["memory_narrative_ai_consent"]],
    ];
    for (const [label, mutate, absent] of cases) {
      app = await startApp({ mutate, absent });
      const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
      assert.deepEqual([r.status, r.body.reason], [403, "consent_required"], label);
      assert.equal(app.calls.length, 0, label);
      await app.close(); app = null;
    }
  });

  it("an unreadable consent is 503, never 'not consented' and never 'consented'", async () => {
    app = await startApp({ mutate: open, failReads: ["memory_narrative_ai_consent"] });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.status, 503);
    assert.equal(app.calls.length, 0);
  });

  it("someone else's Memory is 404 even with their own consent — and the model is never called", async () => {
    app = await startApp({ mutate: (s) => { open(s); s.memory_narrative_ai_consent.push({ ...VALID_CONSENT, user_id: FRIEND }); } });
    assert.equal((await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, FRIEND)).status, 404);
    assert.equal((await call(app, "POST", `/api/memories/${MEM_DELETED}/narrative/ai`, OWNER)).status, 404);
    assert.equal(app.calls.length, 0);
  });

  for (const control of ["DO_NOT_RESURFACE", "KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]) {
    it(`W-HM-PRIV-1's model-mediated reading: ${control} keeps the Memory from the model, and the refusal names it`, async () => {
      app = await startApp({ mutate: (s) => { open(s); s.memory_resurfacing_preferences.push({ memory_id: MEM, owner_id: OWNER, control }); } });
      const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
      assert.deepEqual([r.status, r.body.reason, r.body.controls], [403, "excluded_by_control", [control]]);
      assert.match(r.body.message, /settings/);
      assert.equal(app.calls.length, 0);
    });
  }

  it("the excluding set is exactly the three, derived from the guard — DO_NOT_INCLUDE_IN_RECAPS does not keep a Memory from its owner's draft", async () => {
    assert.deepEqual([...NARRATIVE_AI_EXCLUDING_CONTROLS].sort(), ["DO_NOT_RESURFACE", "KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]);
    app = await startApp({ mutate: (s) => { open(s); s.memory_resurfacing_preferences.push({ memory_id: MEM, owner_id: OWNER, control: "DO_NOT_INCLUDE_IN_RECAPS" }); } });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.status, 200);
    assert.equal(app.calls.length, 1);
  });

  it("unreadable controls are 503 and nothing is sent; an absent controls table (3671 unapplied) holds no control", async () => {
    app = await startApp({ mutate: open, failReads: ["memory_resurfacing_preferences"] });
    assert.equal((await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER)).status, 503);
    assert.equal(app.calls.length, 0);
    await app.close();
    app = await startApp({ mutate: open, absent: ["memory_resurfacing_preferences"] });
    assert.equal((await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER)).status, 200);
    assert.equal(app.calls.length, 1);
  });
});

describe("POST /memories/:id/narrative/ai — what is sent, and what comes back", () => {
  it("sends the owner's own facts only — no coordinate, no tagged person, no item caption, no other person's Memory — and writes nothing", async () => {
    app = await startApp({ mutate: open });
    const before = JSON.stringify(app.store);
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(app.calls.length, 1);
    const sent = JSON.stringify(app.calls[0]!.params.messages);
    assert.equal(app.calls[0]!.params.model, NARRATIVE_AI_MODEL, "the existing model; no new provider");
    assert.ok(typeof app.calls[0]!.opts?.timeout === "number", "the call is bounded");
    for (const leak of [String(LAT), String(LNG), "16.05", "108.2", FRIEND, STRANGER, PENDING, ITEM_CAPTION, "fsq:abc", "with everyone", "Friend's dinner"]) {
      assert.ok(!sent.includes(leak), `the model was sent ${leak}`);
    }
    assert.ok(sent.includes(CAPTION) && sent.includes(TITLE) && sent.includes("Da Nang, Vietnam"));
    assert.equal(JSON.stringify(app.store), before);
    assert.deepEqual(foreignWrites(app), []);
    assert.deepEqual(app.fake.writes, [], "an AI draft is never stored");
  });

  it("accepts a faithful draft: the AI renderer, the facts it rests on, and the owner's words alongside, verbatim", async () => {
    app = await startApp({ mutate: open });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.body.accepted, true, JSON.stringify(r.body));
    assert.equal(r.body.fallback_reason, null);
    assert.match(r.body.narrative.renderer, /^ai:gpt-5-mini@/);
    assert.deepEqual(r.body.narrative.supporting_fact_ids, [`${MEM}:title`, `${MEM}:occurred_on`, `${MEM}:place`, `${MEM}:photo_count`, `${MEM}:people_count`, `${MEM}:caption`]);
    assert.deepEqual(r.body.narrative.original_text, { title: TITLE, caption: CAPTION });
    assert.equal(r.body.narrative.original_language, "und");
    assert.equal(r.body.narrative.stored, false);
    assert.equal(r.body.deterministic.renderer, NARRATIVE_RENDERER, "the deterministic summary always travels with it");
  });

  it("a draft that invents 'with Marcus at Nobu' is refused: the deterministic summary is served, with the reason", async () => {
    app = await startApp({ mutate: open, reply: "A sunset walk with Marcus at Nobu in Da Nang, Vietnam." });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.accepted, r.body.fallback_reason, r.body.narrative.renderer], [false, "unsupported_fact", NARRATIVE_RENDERER]);
    assert.ok(!JSON.stringify(r.body).includes("Marcus"), "the refused draft is not sent back");
  });

  it("a draft that 'improves' the owner's caption is refused (§28.16)", async () => {
    app = await startApp({ mutate: open, reply: "You wrote “The best bánh mì of the whole trip!”" });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.deepEqual([r.body.accepted, r.body.fallback_reason], [false, "altered_owner_text"]);
    assert.ok(r.body.narrative.summary.includes(`“${CAPTION}”`));
  });

  it("§28.17: a model that fails is the deterministic summary, not an error", async () => {
    app = await startApp({ mutate: open, reply: async () => { throw new Error("upstream 500"); } });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.accepted, r.body.fallback_reason, r.body.narrative.renderer], [false, "model_unavailable", NARRATIVE_RENDERER]);
  });

  it("the place sent follows the owner's §10 rung when the precision gate is on, and an unreadable gate sends none", async () => {
    const sentPlace = async (mutate: (s: Record<string, Row[]>) => void, failReads: string[] = []) => {
      app = await startApp({ mutate: (s) => { open(s); mutate(s); }, failReads, reply: "A sunset walk." });
      const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const facts = JSON.parse(String(app.calls[0]!.params.messages[1].content).replace(/^Facts \(JSON\):\n/, ""));
      await app.close(); app = null;
      return facts.place ?? null;
    };
    const gateOn = (rung: string) => (s: Record<string, Row[]>) => { s.feature_flags.push({ flag: "memory_location_precision_enabled", enabled: true }); s.memories[0]!.location_precision = rung; };
    assert.equal(await sentPlace(gateOn("country")), "Vietnam");
    assert.equal(await sentPlace(gateOn("hidden")), null);
    assert.equal(await sentPlace(gateOn("venue")), "Da Nang, Vietnam");
    assert.equal(await sentPlace(() => {}), "Da Nang, Vietnam", "gate off");
  });

  it("is rate limited per person", async () => {
    app = await startApp({ mutate: open });
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER)).status;
    assert.equal(last, 429);
  });
});

// ── 7. The opt-in ─────────────────────────────────────────────────────────────

describe("the opt-in: its own table, server-stamped, granted only with the flag and today's words, withdrawn always", () => {
  it("GET: off by default, with the current disclosure version and its draft text", async () => {
    app = await startApp();
    const r = await call(app, "GET", "/api/me/memory-narrative-ai-consent", OWNER);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.available, r.body.enabled, r.body.currentDisclosureVersion], [false, false, MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION]);
    assert.match(r.body.disclosureText, /never sent/);
  });

  it("GET with an unreadable consent is 503", async () => {
    app = await startApp({ failReads: ["memory_narrative_ai_consent"] });
    assert.equal((await call(app, "GET", "/api/me/memory-narrative-ai-consent", OWNER)).status, 503);
  });

  it("a grant while the flag is off is refused and writes nothing", async () => {
    app = await startApp();
    const r = await call(app, "PUT", "/api/me/memory-narrative-ai-consent", OWNER, { enabled: true, disclosureVersion: MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION });
    assert.deepEqual([r.status, r.body.error], [404, "feature_disabled"]);
    assert.deepEqual(app.fake.writes, []);
  });

  it("a grant for words the person did not see is refused and writes nothing", async () => {
    app = await startApp({ mutate: (s) => { s.feature_flags.push(AI_ON); } });
    const r = await call(app, "PUT", "/api/me/memory-narrative-ai-consent", OWNER, { enabled: true, disclosureVersion: "memory_narrative_ai_v0" });
    assert.equal(r.status, 409);
    assert.deepEqual(app.fake.writes, []);
  });

  it("a grant is stamped by the server; DELETE withdraws it and keeps what was agreed to", async () => {
    app = await startApp({ mutate: (s) => { s.feature_flags.push(AI_ON); } });
    const g = await call(app, "PUT", "/api/me/memory-narrative-ai-consent", OWNER, { enabled: true, disclosureVersion: MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION, consentVersion: "client-made-up", consentedAt: "1999-01-01T00:00:00.000Z" });
    assert.equal(g.status, 200);
    assert.equal(g.body.enabled, true);
    const stored = app.store.memory_narrative_ai_consent!.find((r) => r.user_id === OWNER)!;
    assert.equal(stored.consent_version, MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION);
    assert.notEqual(stored.consented_at, "1999-01-01T00:00:00.000Z");
    const d = await call(app, "DELETE", "/api/me/memory-narrative-ai-consent", OWNER);
    assert.equal(d.status, 200);
    assert.equal(d.body.enabled, false);
    const after = app.store.memory_narrative_ai_consent!.find((r) => r.user_id === OWNER)!;
    assert.equal(after.enabled, false);
    assert.ok(after.withdrawn_at);
    assert.equal(after.consent_version, MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION, "the record of what was agreed to is kept");
    assert.deepEqual(new Set(app.fake.writes.map((w) => w.table)), new Set(["memory_narrative_ai_consent"]));
  });

  it("withdrawing works with the flag off, and a failed write is 503", async () => {
    app = await startApp({ mutate: (s) => { s.memory_narrative_ai_consent.push(VALID_CONSENT); } });
    const r = await call(app, "PUT", "/api/me/memory-narrative-ai-consent", OWNER, { enabled: false });
    assert.deepEqual([r.status, r.body.enabled], [200, false]);
    await app.close();
    app = await startApp({ mutate: (s) => { s.feature_flags.push(AI_ON); }, failWrites: ["memory_narrative_ai_consent"] });
    assert.equal((await call(app, "PUT", "/api/me/memory-narrative-ai-consent", OWNER, { enabled: true, disclosureVersion: MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION })).status, 503);
  });

  it("a malformed body is 400", async () => {
    app = await startApp();
    assert.equal((await call(app, "PUT", "/api/me/memory-narrative-ai-consent", OWNER, { enabled: "yes" })).status, 400);
  });
});

// ── 8. Migration 3802, read as text (executed in src/test/db/memoryNarrativeAiConsent.db.test.ts) ──

describe("migration 3802: one purpose, one table, service_role only, the flag OFF", () => {
  const sql = readFileSync(new URL("../migrations/3802_memory_narrative_ai_consent.sql", import.meta.url), "utf8");
  const rollback = readFileSync(new URL("../../../../db/rollback/2026-10-14-3802-memory-narrative-ai-consent-rollback.sql", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/memory/memoryNarrativeService.ts", import.meta.url), "utf8");

  it("creates the table with the erasure cascade, RLS on and every client privilege revoked", () => {
    assert.match(sql, /user_id\s+uuid PRIMARY KEY REFERENCES auth\.users \(id\) ON DELETE CASCADE/);
    assert.match(sql, /ALTER TABLE public\.memory_narrative_ai_consent ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REVOKE ALL ON public\.memory_narrative_ai_consent FROM PUBLIC, anon, authenticated, service_role;/);
    assert.match(sql, /CHECK \(NOT enabled OR \(consent_version IS NOT NULL AND consented_at IS NOT NULL\)\)/);
  });

  it("seeds the flag FALSE, and the service reads exactly that flag", () => {
    assert.match(sql, new RegExp(`'${MEMORY_NARRATIVE_AI_FLAG}',\\s*false,`));
    assert.match(sql, /memory_narrative_ai_enabled is ON — it must ship OFF/);
    assert.ok(service.includes(`readFlagState(sc, "${MEMORY_NARRATIVE_AI_FLAG}")`));
  });

  it("the rollback refuses while the flag is on or anyone has chosen", () => {
    assert.match(rollback, /ROLLBACK REFUSED \(3802\): memory_narrative_ai_enabled is TRUE/);
    assert.match(rollback, /ROLLBACK REFUSED \(3802\): memory_narrative_ai_consent holds recorded choices/);
  });
});

// ── 9. NARR-PHOTOS: a Memory's items are counted as what they are ─────────────
//
// census-highlights-memories §BX (lane NARR-PHOTOS; found by MEM-NARR-2). PR #720
// counted every `memory_items` row and called each one a photo — "4 photos" about
// 3 photos and a video — in the deterministic summary, in §18's derivative, in
// the disclosure ("how many photos"), and in any AI draft that said the item
// count (sent as `photos`) as photos, which the check accepted.

/** n items stored the way the app stores a picked image. */
function imageItems(n: number): NarrativeItemRow[] {
  return Array.from({ length: n }, () => ({ media_type: "image/jpeg" }));
}
/** The #720 batteries describe its fixture, whose items are all images: their item count is all photos. */
function photosOnly(f: NarrativeAiFacts): NarrativeItemCounts {
  return { photos: f.photos ?? 0, videos: 0, other: 0 };
}
const typed = (...mediaTypes: unknown[]): NarrativeItemRow[] => mediaTypes.map((media_type) => ({ media_type }));
/** The fixture's 4 items become 3 photos and 1 video (as app/memory/[id].tsx stores a picked video). */
const MIXED = (s: Record<string, Row[]>) => { s.memory_items![3]!.media_type = "video/mp4"; };
const MIXED_SUMMARY = "“Sunset walk”, 13 March 2025, in Da Nang, Vietnam. 3 photos and 1 video, with 2 people. You wrote: “Best bánh mì of the trip.”";

describe("NARR-PHOTOS: what an item is comes from its stored media_type, and nothing is guessed", () => {
  const KINDS: Array<[unknown, "photo" | "video" | "other"]> = [
    ["image/jpeg", "photo"], ["image/heic", "photo"], ["IMAGE/PNG", "photo"], ["  image/webp ", "photo"], ["image", "photo"],
    ["image/svg+xml", "photo"], ["video/mp4", "video"], ["video/quicktime", "video"], ["Video/MP4; codecs=avc1", "video"], ["video", "video"],
    ["audio/mpeg", "other"], ["application/pdf", "other"], ["imagery/x", "other"], ["videos/mp4", "other"], ["image/", "other"],
    ["image/jpeg/x", "other"], ["photo", "other"], ["", "other"], [null, "other"], [undefined, "other"], [42, "other"],
  ];
  for (const [mediaType, kind] of KINDS) {
    it(`${JSON.stringify(mediaType) ?? "undefined"} is ${kind}`, () => assert.equal(narrativeItemKind(mediaType), kind));
  }

  it("counts every row once, by kind", () => {
    assert.deepEqual(countNarrativeItems(typed("image/jpeg", "video/mp4", "image", "audio/mpeg", null, "video")), { photos: 2, videos: 2, other: 2 });
    assert.deepEqual(countNarrativeItems([]), { photos: 0, videos: 0, other: 0 });
  });

  const PHRASES: Array<[NarrativeItemCounts, string]> = [
    [{ photos: 3, videos: 1, other: 0 }, "3 photos and 1 video"],
    [{ photos: 0, videos: 1, other: 0 }, "1 video"],
    [{ photos: 0, videos: 2, other: 0 }, "2 videos"],
    [{ photos: 1, videos: 0, other: 0 }, "1 photo"],
    [{ photos: 4, videos: 0, other: 0 }, "4 photos"],
    [{ photos: 1, videos: 2, other: 0 }, "1 photo and 2 videos"],
    [{ photos: 2, videos: 1, other: 1 }, "2 photos, 1 video and 1 other item"],
    [{ photos: 1, videos: 0, other: 2 }, "1 photo and 2 other items"],
    [{ photos: 0, videos: 0, other: 1 }, "1 item"],
    [{ photos: 0, videos: 0, other: 3 }, "3 items"],
    [{ photos: 0, videos: 0, other: 0 }, ""],
  ];
  for (const [c, phrase] of PHRASES) {
    it(`${JSON.stringify(c)} is said "${phrase}"`, () => assert.equal(itemsText(c), phrase));
  }
});

describe("NARR-PHOTOS: the deterministic summary names each kind as stored", () => {
  it("3 photos and a video are '3 photos and 1 video' — every clause a fact, never '4 photos'", () => {
    const n = renderDeterministicNarrative(row(), { items: typed("image/jpeg", "image/jpeg", "image/heic", "video/mp4"), people: 2 });
    assertClausesAreFacts(n);
    assert.equal(n.summary, MIXED_SUMMARY);
    assert.ok(!n.summary.includes("4 photos"), n.summary);
    const byKind = Object.fromEntries(n.facts.map((f) => [f.kind, f.text]));
    assert.deepEqual([byKind.photo_count, byKind.video_count, byKind.other_item_count], ["3", "1", undefined]);
    const clause = n.segments.find((s) => s.text === "3 photos and 1 video")!;
    assert.deepEqual(clause.fact_ids, [`${MEM}:photo_count`, `${MEM}:video_count`], "the clause names both facts it states");
  });

  it("a word for a kind appears only when an item of that kind is stored", () => {
    const cases: Array<[NarrativeItemRow[], string]> = [
      [typed("video/mp4"), "1 video"],
      [typed("video/mp4", "video/quicktime"), "2 videos"],
      [typed("audio/mpeg"), "1 item"],
      [typed("image/png", "application/pdf", "video/mp4"), "1 photo, 1 video and 1 other item"],
    ];
    for (const [items, phrase] of cases) {
      const n = renderDeterministicNarrative(row({ caption: null }), { items, people: 0 });
      assertClausesAreFacts(n);
      assert.ok(n.summary.includes(`. ${phrase}.`), `${n.summary} (expected ${phrase})`);
      const c = countNarrativeItems(items);
      assert.equal(/\bphotos?\b/.test(n.summary), c.photos > 0, n.summary);
      assert.equal(/\bvideos?\b/.test(n.summary), c.videos > 0, n.summary);
    }
  });

  it("the renderer and builder versions moved with the output", () => {
    assert.equal(NARRATIVE_RENDERER, "deterministic@2");
  });
});

describe("NARR-PHOTOS: the route and §18's derivative read each item's type", () => {
  it("GET: a Memory of 3 photos and a video is summarized as exactly that", async () => {
    app = await startApp({ mutate: MIXED });
    const r = await call(app, "GET", `/api/memories/${MEM}/narrative`, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.narrative.summary, MIXED_SUMMARY);
    assertClausesAreFacts(r.body.narrative);
    assert.deepEqual(app.fake.writes, []);
  });

  it("the derivative says the same as the route, for the owner", async () => {
    const store = tables();
    MIXED(store);
    const r = await deriveProjection(makeClient(store, {}, { reads: [], writes: [] }) as any, "NarrativeDerivative", { owner_id: OWNER, viewer_id: OWNER });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.rows.find((x) => x.memory_id === MEM)!.summary, MIXED_SUMMARY);
  });

  it("a read of the items cut short (fewer rows than their count) is 503 — never a summary that under-counts", async () => {
    app = await startApp({ truncate: { memory_items: 2 } });
    const r = await call(app, "GET", `/api/memories/${MEM}/narrative`, OWNER);
    assert.deepEqual([r.status, r.body.error], [503, "degraded_unavailable"]);
    await app.close();
    app = await startApp({ mutate: open, truncate: { memory_items: 3 } });
    assert.equal((await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER)).status, 503);
    assert.equal(app.calls.length, 0, "nothing is sent over a partial read");
  });
});

describe("NARR-PHOTOS: the AI draft — the item count is sent as one number, and its noun must be true of every item", () => {
  const MIXED_KINDS: NarrativeItemCounts = { photos: 3, videos: 1, other: 0 };
  const verdict = (t: string, f: NarrativeAiFacts, items: NarrativeItemCounts) => { const c = checkAiNarrative(t, f, items); return c.ok ? "ok" : `${c.reason}: ${c.detail}`; };

  it("what is sent is unchanged in shape: the same six keys, `photos` the number of every item", async () => {
    app = await startApp({ mutate: (s) => { open(s); MIXED(s); }, reply: "A sunset walk." });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sent = JSON.parse(String(app.calls[0]!.params.messages[1].content).replace(/^Facts \(JSON\):\n/, ""));
    assert.deepEqual(Object.keys(sent).sort(), ["caption", "date", "people", "photos", "place", "title"]);
    assert.equal(sent.photos, 4, "3 photos and 1 video, as ONE number");
    assert.ok(!JSON.stringify(app.calls[0]!.params.messages).includes("video/mp4"), "what kind each item is, is not sent");
    assert.deepEqual(Object.keys(narrativeAiFacts(row(), { items: typed("video/mp4"), people: 0 }, "off")), ["title", "caption", "date", "place", "photos", "people"]);
  });

  it("'4 photos' about 3 photos and a video is refused, and the summary that says it right is served", async () => {
    app = await startApp({ mutate: (s) => { open(s); MIXED(s); } }); // the stub's default draft says "with 2 people and 4 photos"
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.accepted, r.body.fallback_reason], [false, "unsupported_fact"]);
    assert.equal(r.body.narrative.summary, MIXED_SUMMARY);
  });

  it("'4 items' about 3 photos and a video is accepted, resting on both item facts", async () => {
    app = await startApp({ mutate: (s) => { open(s); MIXED(s); }, reply: "A sunset walk in Da Nang, Vietnam on 13 March 2025, with 2 people and 4 items." });
    const r = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.equal(r.body.accepted, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.narrative.supporting_fact_ids, [`${MEM}:title`, `${MEM}:occurred_on`, `${MEM}:place`, `${MEM}:photo_count`, `${MEM}:video_count`, `${MEM}:people_count`, `${MEM}:caption`]);
    assert.match(r.body.narrative.renderer, /^ai:gpt-5-mini@2$/);
  });

  // ONE fault per draft; the facts are F_FACTS (photos: 4) unless named.
  const KIND_TABLE: Array<[string, NarrativeItemCounts, string, NarrativeAiFacts?]> = [
    ["A sunset walk with 4 photos.", MIXED_KINDS, "unsupported_fact: kind: 4 photos"],
    ["A sunset walk with 4 pictures.", MIXED_KINDS, "unsupported_fact: kind: 4 pictures"],
    ["A sunset walk with 4 videos.", MIXED_KINDS, "unsupported_fact: kind: 4 videos"],
    ["A sunset walk with four photos.", MIXED_KINDS, "unsupported_fact: kind: four photos"],
    ["A sunset walk with photos.", MIXED_KINDS, "unsupported_fact: kind: photos"],
    ["A sunset walk with 4 items.", MIXED_KINDS, "ok"],
    ["A sunset walk with four items.", MIXED_KINDS, "ok"],
    ["A sunset walk with items.", MIXED_KINDS, "ok"],
    ["A sunset walk with 3 photos and 1 video.", MIXED_KINDS, "unsupported_fact: count: 3 photos"],
    ["A sunset walk with 5 items.", MIXED_KINDS, "unsupported_fact: count: 5 items"],
    ["4 items and 4 items.", MIXED_KINDS, "unsupported_fact: repeated: 4 items"],
    ["4 items and 4 photos.", { photos: 4, videos: 0, other: 0 }, "unsupported_fact: repeated: 4 photos"],
    ["A sunset walk with 4 photos.", { photos: 4, videos: 0, other: 0 }, "ok"],
    ["A sunset walk with 4 videos.", { photos: 4, videos: 0, other: 0 }, "unsupported_fact: kind: 4 videos"],
    ["A sunset walk with 4 photos.", { photos: 3, videos: 0, other: 0 }, "unsupported_fact: kind: 4 photos"], // kinds that do not count the number sent speak for nothing
    ["2 videos in Da Nang, Vietnam.", { photos: 0, videos: 2, other: 0 }, "ok", { ...F_FACTS, photos: 2 }],
    ["2 photos in Da Nang, Vietnam.", { photos: 0, videos: 2, other: 0 }, "unsupported_fact: kind: 2 photos", { ...F_FACTS, photos: 2 }],
    ["A video from Da Nang, Vietnam.", { photos: 0, videos: 1, other: 0 }, "ok", { ...F_FACTS, photos: 1 }],
    ["A photo from Da Nang, Vietnam.", { photos: 0, videos: 1, other: 0 }, "unsupported_fact: kind: photo", { ...F_FACTS, photos: 1 }],
    ["A video from Da Nang, Vietnam.", { photos: 0, videos: 2, other: 0 }, "unsupported_fact: count: video", { ...F_FACTS, photos: 2 }],
    ["2 items in Da Nang, Vietnam.", { photos: 0, videos: 0, other: 2 }, "ok", { ...F_FACTS, photos: 2 }],
    ["2 photos in Da Nang, Vietnam.", { photos: 0, videos: 0, other: 2 }, "unsupported_fact: kind: 2 photos", { ...F_FACTS, photos: 2 }],
    ["2 videos in Da Nang, Vietnam.", { photos: 0, videos: 0, other: 2 }, "unsupported_fact: kind: 2 videos", { ...F_FACTS, photos: 2 }],
    ["A video in Da Nang, Vietnam.", { photos: 0, videos: 0, other: 0 }, "unsupported_fact: word: video", { ...F_FACTS, photos: null }],
    ["The 13th video in Da Nang, Vietnam.", MIXED_KINDS, "unsupported_fact: number: 13th"],
  ];
  for (const [draft, items, expected, facts] of KIND_TABLE) {
    it(`${JSON.stringify(items)} — "${draft}" ⇒ ${expected}`, () => assert.equal(verdict(draft, facts ?? F_FACTS, items), expected));
  }

  it("the model is told the count is photos AND videos, to be said as items", () => {
    assert.match(NARRATIVE_AI_SYSTEM_PROMPT, /"photos" is how many photos AND videos the Memory holds, counted together: write it as items \("4 items", "1 item"\), never as photos or videos/);
    assert.ok(!NARRATIVE_AI_SYSTEM_PROMPT.includes("\"4 photos\""), "the prompt no longer models a count of items as photos");
  });

  it("aiSupportingFactIds cites the kinds the count rests on, and only when the count was sent", () => {
    assert.deepEqual(aiSupportingFactIds(MEM, { ...F_FACTS, title: null, caption: null, date: null, place: null, people: null }, MIXED_KINDS), [`${MEM}:photo_count`, `${MEM}:video_count`]);
    assert.deepEqual(aiSupportingFactIds(MEM, { ...F_FACTS, title: null, caption: null, date: null, place: null, people: null, photos: null }, MIXED_KINDS), []);
  });
});

describe("NARR-PHOTOS: the disclosure says what is sent, and a grant to the old words does not cover the new ones", () => {
  // sha256 of each disclosure text ever served. Changing the words without a new
  // version fails here — #720's rule: a grant is consent to the words it was given under.
  const SERVED: Readonly<Record<string, string>> = {
    memory_narrative_ai_v1: "e01b1b5c0a2a5fdd6886498dac1a36a6f845283561ff7037b0a6df098595aedd",
    memory_narrative_ai_v2: "9f03d4ea9813b84f07ee6a7c15bc6284ccb0afeaf9cd677d6ab4b29be893ffb1",
  };
  const V1 = "memory_narrative_ai_v1";

  it("v2 says the items are sent as ONE number of photos and videos, and never 'how many photos'", () => {
    assert.equal(MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION, "memory_narrative_ai_v2");
    assert.equal(createHash("sha256").update(MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT, "utf8").digest("hex"), SERVED[MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION], "the words changed: give them a new version");
    assert.notEqual(SERVED[V1], SERVED[MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION]);
    assert.match(MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT, /how many items it holds \(its photos and videos, counted together as one number\)/);
    assert.match(MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT, /the captions on photos and videos, and anything someone else wrote are never sent/);
    assert.ok(!/how many photos/.test(MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT));
  });

  it("a grant recorded under v1 is no grant: the draft is refused, the offer asks again, and the model is never called", async () => {
    const v1Grant = (s: Record<string, Row[]>) => { s.feature_flags.push(AI_ON); s.memory_narrative_ai_consent.push({ ...VALID_CONSENT, consent_version: V1 }); };
    app = await startApp({ mutate: v1Grant });
    const post = await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER);
    assert.deepEqual([post.status, post.body.reason], [403, "consent_required"]);
    const offer = await call(app, "GET", `/api/memories/${MEM}/narrative`, OWNER);
    assert.deepEqual(offer.body.ai, { available: false, reason: "consent_required" });
    const consent = await call(app, "GET", "/api/me/memory-narrative-ai-consent", OWNER);
    assert.deepEqual([consent.body.enabled, consent.body.consentVersion, consent.body.currentDisclosureVersion, consent.body.disclosureText],
      [false, V1, MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION, MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT]);
    assert.equal(app.calls.length, 0);
  });

  it("re-granting names the version displayed: v1 is a 409 that writes nothing; v2 is stamped v2 and the draft runs", async () => {
    app = await startApp({ mutate: (s) => { s.feature_flags.push(AI_ON); s.memory_narrative_ai_consent.push({ ...VALID_CONSENT, consent_version: V1 }); } });
    const stale = await call(app, "PUT", "/api/me/memory-narrative-ai-consent", OWNER, { enabled: true, disclosureVersion: V1 });
    assert.equal(stale.status, 409);
    assert.deepEqual(app.fake.writes, []);
    const fresh = await call(app, "PUT", "/api/me/memory-narrative-ai-consent", OWNER, { enabled: true, disclosureVersion: MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION });
    assert.deepEqual([fresh.status, fresh.body.enabled, fresh.body.consentVersion], [200, true, MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION]);
    assert.equal(app.store.memory_narrative_ai_consent!.find((r) => r.user_id === OWNER)!.consent_version, MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION);
    assert.equal((await call(app, "POST", `/api/memories/${MEM}/narrative/ai`, OWNER)).status, 200);
    assert.equal(app.calls.length, 1);
  });
});
