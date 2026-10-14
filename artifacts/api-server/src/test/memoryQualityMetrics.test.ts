/**
 * §24 false_memory_rate (census H217) and do_again_conversion (census H222),
 * census-highlights-memories §BK.
 *
 * WHAT THESE TESTS HOLD
 *   - The definitions are the plan's fail-closed defaults (each an OWNER
 *     QUESTION). SURFACED = what GET /me/memory-candidates showed. CORRECTED =
 *     the kept Memory's stored value of a shown component now differs. Clearing
 *     counts. A fill, a revert, a dismissal and a deletion do not. A MERGE
 *     survivor and an ambiguous link are excluded from both sides.
 *   - The time half has no client correction surface, so the overall
 *     false_memory_rate is UNPRODUCIBLE, never a structural low. A guard pins
 *     the declaration against the client source.
 *   - A Do Again plan converts when the same person saves the same place to a
 *     trip inside the window. The rate is over MATURED plans only. Re-compiles
 *     of one plan are one plan.
 *   - Nothing is ever 0 when it was not measured: empty, unreadable and
 *     possibly-truncated sources are UNPRODUCIBLE, with a null count.
 *   - Counts and rates only leave the server: the admin route and the log
 *     line carry no identifier.
 *   - End to end over the REAL routers: the candidate inbox, PATCH
 *     /memories/:id, the Do Again compile and the admin route, on one
 *     table-backed fake.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/memoryQualityMetrics.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoryCandidatesRouter from "../routes/memoryCandidates.js";
import memoryActionsRouter from "../routes/memoryActions.js";
import memoriesRouter from "../routes/memories.js";
import adminMemoryMetricsRouter from "../routes/adminMemoryMetrics.js";
import { resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";
import { _setMemoryActionDeps } from "../services/memory/memoryActionService.js";
import { _resetMemoryKernelMetrics, MEMORY_METRICS_NOT_MEASURABLE } from "../services/memory/memoryKernelMetrics.js";
import {
  CORRECTION_SURFACES,
  DO_AGAIN_ATTRIBUTION_WINDOW_MS,
  MAX_TRACKED_PLANS,
  MAX_TRACKED_SURFACED,
  MEMORY_QUALITY_METRICS,
  _resetMemoryQualityMetrics,
  _setMemoryQualityClock,
  computeDoAgainConversion,
  computeFalseMemoryRate,
  noteCandidatesSurfaced,
  noteDoAgainCompiled,
  placeCorrected,
  readDoAgainConversion,
  readFalseMemoryRate,
  recordQualityMetrics,
  timeCorrected,
  type DoAgainPlanRecord,
  type KeptMemoryState,
  type SurfacedCandidate,
} from "../services/memory/memoryQualityMetrics.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "adadadad-adad-4ada-8ada-adadadadadad";
const TRIP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEM_DA = "10000000-0000-4000-8000-000000000001";
const MEM_DA2 = "10000000-0000-4000-8000-000000000002";
const PLACE_OPEN = "20000000-0000-4000-8000-000000000001";
const PLACE_TWO = "20000000-0000-4000-8000-000000000002";

// ── Pure: false_memory_rate ─────────────────────────────────────────────────

const H = 3_600_000;
const T0 = Date.parse("2026-03-02T19:00:00.000Z");

function shown(episodeId: string, over: Partial<SurfacedCandidate> = {}): SurfacedCandidate {
  return {
    episodeId, ownerId: OWNER, surfacedAtMs: T0 + 1000 * H,
    time: { startedAtMs: T0, endedAtMs: T0 + 1.5 * H },
    place: { city: "Lisbon", country: "Portugal" },
    ...over,
  };
}
function kept(id: string, over: Partial<KeptMemoryState> = {}): KeptMemoryState {
  return {
    id, ownerId: OWNER, state: "published",
    startsAt: new Date(T0).toISOString(), endsAt: new Date(T0 + 1.5 * H).toISOString(),
    city: "Lisbon", country: "Portugal", ...over,
  };
}
const BOTH_CORRECTABLE = { time: "test: a time surface", place: "test: a place surface" } as const;

describe("false_memory_rate — the definition (pure)", () => {
  it("nothing surfaced is UNPRODUCIBLE with a null value — never 0", () => {
    const r = computeFalseMemoryRate({ surfaced: [], links: new Map(), memories: new Map(), mergeSurvivors: new Set() });
    assert.equal(r.status, "UNPRODUCIBLE");
    assert.equal(r.value, null);
    assert.equal(r.denominator, 0);
    assert.match(String(r.blockedBy), /no inferred assertion has been surfaced/);
    assert.equal(r.byAssertion.place.status, "UNPRODUCIBLE");
    assert.equal(r.byAssertion.time.value, null);
  });

  it("with today's surfaces the total is UNPRODUCIBLE on the time half; the place half is its own rate", () => {
    const r = computeFalseMemoryRate({
      surfaced: [shown("e1"), shown("e2")],
      links: new Map([["e1", ["m1"]]]),
      memories: new Map([["m1", kept("m1", { city: "Sintra" })]]),
      mergeSurvivors: new Set(),
    });
    assert.equal(r.status, "UNPRODUCIBLE", "a time correction cannot be made from the app, so the total would be low by construction");
    assert.equal(r.value, null);
    assert.match(String(r.blockedBy), /^time: no client surface corrects a kept Memory's time/);
    assert.equal(r.numerator, 1);
    assert.equal(r.denominator, 4, "2 time + 2 place assertions surfaced");
    assert.deepEqual([r.byAssertion.place.status, r.byAssertion.place.value, r.byAssertion.place.surfaced, r.byAssertion.place.corrected], ["OK", 0.5, 2, 1]);
    assert.deepEqual([r.byAssertion.time.status, r.byAssertion.time.value, r.byAssertion.time.surfaced, r.byAssertion.time.corrected], ["UNPRODUCIBLE", null, 2, 0]);
    assert.equal(r.byAssertion.time.correctionSurface, null);
    assert.equal(r.population.kept, 1);
  });

  it("when every kind has a surface, the total is corrected over surfaced across both kinds", () => {
    const r = computeFalseMemoryRate({
      surfaced: [shown("e1"), shown("e2"), shown("e3", { place: null })],
      links: new Map([["e1", ["m1"]], ["e2", ["m2"]]]),
      memories: new Map([
        ["m1", kept("m1", { city: "Sintra" })],
        ["m2", kept("m2", { startsAt: new Date(T0 + 2 * H).toISOString() })],
      ]),
      mergeSurvivors: new Set(),
      correctionSurfaces: BOTH_CORRECTABLE,
    });
    assert.equal(r.status, "OK");
    assert.equal(r.numerator, 2);
    assert.equal(r.denominator, 5, "3 time + 2 place: e3 showed no place, so it asserted none");
    assert.equal(r.value, 0.4);
    assert.equal(r.byAssertion.time.value, 0.3333);
    assert.equal(r.byAssertion.place.value, 0.5);
  });

  it("dismissed, pending and deleted are surfaced and NOT corrected; another owner's Memory is not this keep", () => {
    const r = computeFalseMemoryRate({
      surfaced: [shown("dismissed"), shown("deleted"), shown("foreign")],
      links: new Map([["deleted", ["md"]], ["foreign", ["mf"]]]),
      memories: new Map([
        ["md", kept("md", { state: "deleted", city: "Elsewhere" })],
        ["mf", kept("mf", { ownerId: OTHER, city: "Elsewhere" })],
      ]),
      mergeSurvivors: new Set(),
      correctionSurfaces: BOTH_CORRECTABLE,
    });
    assert.equal(r.status, "OK");
    assert.deepEqual([r.numerator, r.denominator, r.value, r.population.kept], [0, 6, 0, 0]);
  });

  it("a MERGE survivor and an ambiguous link are excluded from BOTH sides", () => {
    const r = computeFalseMemoryRate({
      surfaced: [shown("merged"), shown("twice"), shown("plain")],
      links: new Map([["merged", ["ms"]], ["twice", ["ma", "mb"]], ["plain", ["mp"]]]),
      memories: new Map([
        ["ms", kept("ms", { city: "Porto" })],
        ["ma", kept("ma", { city: "Porto" })],
        ["mb", kept("mb")],
        ["mp", kept("mp", { city: "Porto" })],
      ]),
      mergeSurvivors: new Set(["ms"]),
      correctionSurfaces: BOTH_CORRECTABLE,
    });
    assert.deepEqual([r.population.excludedMerged, r.population.excludedAmbiguousLink], [1, 1]);
    assert.deepEqual([r.numerator, r.denominator, r.value], [1, 2, 0.5], "only 'plain' remains: its place was corrected");
  });

  it("every excluded ⇒ UNPRODUCIBLE, not 0", () => {
    const r = computeFalseMemoryRate({
      surfaced: [shown("merged")], links: new Map([["merged", ["ms"]]]), memories: new Map([["ms", kept("ms")]]),
      mergeSurvivors: new Set(["ms"]), correctionSurfaces: BOTH_CORRECTABLE,
    });
    assert.equal(r.status, "UNPRODUCIBLE");
    assert.match(String(r.blockedBy), /excluded/);
  });
});

describe("what counts as a correction (pure)", () => {
  const time = { startedAtMs: T0, endedAtMs: T0 + H };
  it("time: a moved start, a moved shown end, or a cleared start is a correction", () => {
    assert.equal(timeCorrected(time, kept("m", { startsAt: new Date(T0).toISOString(), endsAt: new Date(T0 + H).toISOString() })), false);
    assert.equal(timeCorrected(time, kept("m", { startsAt: "2026-03-02T19:00:00+00:00", endsAt: "2026-03-02T20:00:00.000000+00:00" })), false, "the same instant spelled differently is not a correction");
    assert.equal(timeCorrected(time, kept("m", { startsAt: new Date(T0 + 60_000).toISOString(), endsAt: new Date(T0 + H).toISOString() })), true);
    assert.equal(timeCorrected(time, kept("m", { startsAt: new Date(T0).toISOString(), endsAt: new Date(T0 + 2 * H).toISOString() })), true);
    assert.equal(timeCorrected(time, kept("m", { startsAt: null, endsAt: new Date(T0 + H).toISOString() })), true);
    assert.equal(timeCorrected(time, kept("m", { startsAt: new Date(T0).toISOString(), endsAt: null })), true, "a shown end that was cleared");
  });
  it("time: an end that was NOT shown is not a correction when the owner adds one", () => {
    assert.equal(timeCorrected({ startedAtMs: T0, endedAtMs: null }, kept("m", { startsAt: new Date(T0).toISOString(), endsAt: new Date(T0 + H).toISOString() })), false);
  });
  it("place: case and spacing are not a correction; a different word, or a cleared one, is", () => {
    const p = { city: "Lisbon", country: "Portugal" };
    assert.equal(placeCorrected(p, kept("m", { city: "  lisbon ", country: "PORTUGAL" })), false);
    assert.equal(placeCorrected(p, kept("m", { city: "Sintra" })), true);
    assert.equal(placeCorrected(p, kept("m", { city: null })), true, "clearing a shown city is a correction");
    assert.equal(placeCorrected(p, kept("m", { country: "Spain" })), true);
  });
  it("place: filling a component that was NOT shown is not a correction (§AF F10: a first-time fill is not a correction)", () => {
    assert.equal(placeCorrected({ city: null, country: "Portugal" }, kept("m", { city: "Portugal", country: "Portugal" })), false,
      "the edit screen writes the country into locationCity for a country-only Memory; that fill is not a correction of the country");
  });
});

// ── Pure: do_again_conversion ───────────────────────────────────────────────

const W = DO_AGAIN_ATTRIBUTION_WINDOW_MS;
const plan = (over: Partial<DoAgainPlanRecord> = {}): DoAgainPlanRecord =>
  ({ viewerId: OWNER, memoryId: MEM_DA, placeId: PLACE_OPEN, openedAtMs: T0, compiles: 1, ...over });

describe("do_again_conversion — the definition (pure)", () => {
  it("no plan ⇒ UNPRODUCIBLE; only pending plans ⇒ UNPRODUCIBLE — never 0", () => {
    const none = computeDoAgainConversion({ plans: [], saves: [], nowMs: T0 });
    assert.deepEqual([none.status, none.value, none.denominator], ["UNPRODUCIBLE", null, 0]);
    assert.match(String(none.blockedBy), /no Do Again plan has been served/);
    const open = computeDoAgainConversion({ plans: [plan()], saves: [], nowMs: T0 + W - 1 });
    assert.deepEqual([open.status, open.value, open.plans.pending], ["UNPRODUCIBLE", null, 1]);
    assert.match(String(open.blockedBy), /finished its attribution window/);
  });

  it("a save by the same person of the same place inside the window converts the plan", () => {
    const r = computeDoAgainConversion({
      plans: [plan(), plan({ memoryId: MEM_DA2, placeId: PLACE_TWO })],
      saves: [{ userId: OWNER, placeId: PLACE_OPEN, savedAtMs: T0 + 60_000 }],
      nowMs: T0 + W,
    });
    assert.deepEqual([r.status, r.numerator, r.denominator, r.value], ["OK", 1, 2, 0.5]);
  });

  it("the window's edges, another person, another place and a pending plan do not convert", () => {
    const r = computeDoAgainConversion({
      plans: [plan(), plan({ memoryId: MEM_DA2, openedAtMs: T0 + W })],
      saves: [
        { userId: OWNER, placeId: PLACE_OPEN, savedAtMs: T0 - 1 },           // before the plan
        { userId: OWNER, placeId: PLACE_OPEN, savedAtMs: T0 + W },           // the window is half-open
        { userId: OTHER, placeId: PLACE_OPEN, savedAtMs: T0 + 1 },           // someone else
        { userId: OWNER, placeId: PLACE_TWO, savedAtMs: T0 + 1 },            // another place
        { userId: OWNER, placeId: PLACE_OPEN, savedAtMs: T0 + W + 1 },       // the pending plan's save
      ],
      nowMs: T0 + W + 2,
    });
    assert.deepEqual([r.numerator, r.denominator, r.value, r.plans.pending], [0, 1, 0, 1]);
  });

  it("the saved place at T0 itself converts (the window starts at the plan)", () => {
    const r = computeDoAgainConversion({ plans: [plan()], saves: [{ userId: OWNER, placeId: PLACE_OPEN, savedAtMs: T0 }], nowMs: T0 + W });
    assert.equal(r.value, 1);
  });
});

// ── In-process recorders ────────────────────────────────────────────────────

const view = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, startedAt: "2026-03-02T19:00:00.000Z", endedAt: "2026-03-02T20:30:00.000Z", city: "Lisbon", country: "Portugal", ...over }) as any;

describe("the recorders", () => {
  beforeEach(() => { _resetMemoryQualityMetrics(); _setMemoryQualityClock(null); });
  afterEach(() => { _setMemoryQualityClock(null); });

  it("a candidate listed twice is surfaced once; a place is asserted only when one was shown", async () => {
    noteCandidatesSurfaced(OWNER, [view("e1"), view("e2", { city: null, country: "  " })]);
    noteCandidatesSurfaced(OWNER, [view("e1")]);
    const r = await readFalseMemoryRate(makeClient({ memory_evidence: [], memories: [] }, {}) as any);
    assert.equal(r.population.tracked, 2);
    assert.equal(r.byAssertion.time.surfaced, 2);
    assert.equal(r.byAssertion.place.surfaced, 1, "a blank country is not a shown place");
  });

  it("never throws on a malformed view, and skips a candidate with no readable time", () => {
    assert.doesNotThrow(() => noteCandidatesSurfaced(OWNER, [view("bad", { startedAt: "not a time" }), null as any]));
  });

  it("is bounded: the oldest surfaced candidate goes first, and the eviction is counted", async () => {
    noteCandidatesSurfaced(OWNER, Array.from({ length: MAX_TRACKED_SURFACED + 3 }, (_, i) => view(`e${i}`)));
    const r = await readFalseMemoryRate(makeClient({ memory_evidence: [], memories: [] }, {}) as any);
    assert.equal(r.population.tracked, MAX_TRACKED_SURFACED);
    assert.equal(r.population.evicted, 3);
  });

  it("re-compiles of one plan inside its window are ONE plan; after the window it is a new plan", async () => {
    let now = T0;
    _setMemoryQualityClock(() => now);
    noteDoAgainCompiled({ viewerId: OWNER, memoryId: MEM_DA, placeId: PLACE_OPEN });
    now = T0 + 60_000;
    noteDoAgainCompiled({ viewerId: OWNER, memoryId: MEM_DA, placeId: PLACE_OPEN });
    now = T0 + W;
    noteDoAgainCompiled({ viewerId: OWNER, memoryId: MEM_DA, placeId: PLACE_OPEN });
    now = T0 + 2 * W;
    const r = await readDoAgainConversion(makeClient({ trip_saved_places: [] }, {}) as any);
    assert.equal(r.plans.tracked, 2);
    assert.equal(r.plans.compiles, 3);
    assert.equal(r.plans.matured, 2);
  });

  it("the plan log is bounded and counts its evictions", async () => {
    _setMemoryQualityClock(() => T0);
    for (let i = 0; i < MAX_TRACKED_PLANS + 2; i++) noteDoAgainCompiled({ viewerId: OWNER, memoryId: `m${i}`, placeId: PLACE_OPEN });
    const r = await readDoAgainConversion(makeClient({ trip_saved_places: [] }, {}) as any);
    assert.equal(r.plans.tracked, MAX_TRACKED_PLANS);
    assert.equal(r.plans.evicted, 2);
  });
});

// ── The log half of the export ──────────────────────────────────────────────

describe("the log line carries counts and rates only", () => {
  it("one line per metric, UNPRODUCIBLE said in the message, no identifier", () => {
    const lines: Array<{ obj: any; msg: string }> = [];
    const r1 = computeFalseMemoryRate({ surfaced: [shown("e1")], links: new Map([["e1", ["m1"]]]), memories: new Map([["m1", kept("m1")]]), mergeSurvivors: new Set() });
    const r2 = computeDoAgainConversion({ plans: [plan()], saves: [], nowMs: T0 + W });
    recordQualityMetrics({ info: (obj, msg) => lines.push({ obj, msg }) }, [r1, r2]);
    assert.deepEqual(lines.map((l) => l.obj.metric), ["false_memory_rate", "do_again_conversion"]);
    assert.match(lines[0]!.msg, /UNPRODUCIBLE, not 0/);
    assert.equal(lines[1]!.obj.value, 0);
    const text = JSON.stringify(lines);
    for (const id of [OWNER, MEM_DA, PLACE_OPEN, "e1", "m1"]) assert.ok(!text.includes(`"${id}"`) && !text.includes(id + '"'), `${id} leaked into a log line`);
    assert.doesNotThrow(() => recordQualityMetrics(undefined, [r1]));
  });
});

// ── The client cannot correct a time: the declaration is pinned ─────────────

describe("CORRECTION_SURFACES is pinned to the client source", () => {
  it("UpdateMemoryInput has no startsAt/endsAt, and the time surface is declared null to match", () => {
    const src = readFileSync(path.join(REPO, "travel-buddy-standalone/src/services/memories.ts"), "utf8");
    const m = /export interface UpdateMemoryInput \{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "UpdateMemoryInput not found — re-point this guard at the client's Memory PATCH input");
    const body = m![1]!;
    assert.match(body, /locationCity\?/, "the place surface is there");
    const clientCanCorrectTime = /\b(startsAt|endsAt)\??\s*:/.test(body);
    assert.equal(clientCanCorrectTime, CORRECTION_SURFACES.time !== null,
      "the client's PATCH input and CORRECTION_SURFACES.time disagree: if the app can now correct a Memory's time, name that surface in CORRECTION_SURFACES.time (memoryQualityMetrics.ts)");
    const edit = readFileSync(path.join(REPO, "travel-buddy-standalone/app/memory/edit.tsx"), "utf8");
    assert.equal(/\b(startsAt|endsAt)\b/.test(edit), CORRECTION_SURFACES.time !== null, "app/memory/edit.tsx and CORRECTION_SURFACES.time disagree");
    assert.notEqual(CORRECTION_SURFACES.place, null);
  });
});

// ── The two names left the kernel module's refused set ──────────────────────

describe("the refused set and the emitted set are disjoint", () => {
  it("false_memory_rate and do_again_conversion are emitted here and refused nowhere", () => {
    for (const n of Object.values(MEMORY_QUALITY_METRICS)) {
      assert.ok(!(n in MEMORY_METRICS_NOT_MEASURABLE), `${n} is emitted by memoryQualityMetrics and must not also be refused`);
    }
  });
});

// ── End to end over the real routers ───────────────────────────────────────

type Store = Record<string, any[]>;
let gen = 0;
const newId = () => `e${String(++gen).padStart(7, "0")}-0000-4000-8000-000000000000`;

interface FakeOpts { failReads?: Set<string> }

/** A table-backed PostgREST stand-in that APPLIES writes; 2320's replay and dedupe keys modelled. Unknown tables read empty. */
function makeClient(store: Store, opts: FakeOpts) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, wantRows = false;
    let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null;
    let upsertOpts: { ignoreDuplicates?: boolean } = {};
    let limitN: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    const obj: any = {
      select() { if (mode !== "select") wantRows = true; return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any, o: any) { mode = "upsert"; payload = d; upsertOpts = o ?? {}; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      not(c: string, op: string, v: any) { filters.push((r) => (op === "is" && v === null ? r[c] != null : r[c] !== v)); return obj; },
      gt(c: string, v: any) { filters.push((r) => r[c] != null && Date.parse(String(r[c])) > Date.parse(String(v))); return obj; },
      gte(c: string, v: any) { filters.push((r) => r[c] != null && String(r[c]) >= String(v)); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] != null && String(r[c]) < String(v)); return obj; },
      lte(c: string, v: any) { filters.push((r) => r[c] != null && String(r[c]) <= String(v)); return obj; },
      order(col: string, o?: any) { orderBy = { col, asc: o?.ascending !== false }; return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(f: any, r: any) { return run().then(f, r); },
    };
    const err = (message: string, code?: string) => ({ data: null, error: { message, code } });
    async function run(): Promise<any> {
      await new Promise((r) => setTimeout(r, 0));
      if (mode === "select" && opts.failReads?.has(table)) return err(`${table} unavailable`, "57014");
      const all = (store[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r }));
        const written: any[] = [];
        for (const r of incoming) {
          if (table === "memory_episodes") {
            const dup = all.find((x) => x.user_id === r.user_id && x.detection_reason === r.detection_reason
              && x.detector_version === r.detector_version && x.detection_digest === r.detection_digest);
            if (dup) return err("duplicate key value violates unique constraint \"memory_episodes_replay_key\"", "23505");
            Object.assign(r, { id: newId(), state: r.state ?? "candidate", significance: null, significance_basis: null,
              state_changed_at: "2026-10-05T00:00:00.000Z", merged_into_id: null, sensitivity: "normal",
              retention_class: "trip_context", created_at: `2026-10-05T00:00:${String(gen % 60).padStart(2, "0")}.000Z`, updated_at: "2026-10-05T00:00:00.000Z" });
          } else if (table === "memory_evidence") {
            const dup = all.find((x) => x.episode_id === r.episode_id && x.source_table === r.source_table
              && x.source_id === r.source_id && x.truth_level === r.truth_level);
            if (dup) { if (mode === "upsert" && upsertOpts.ignoreDuplicates) continue; return err("duplicate key", "23505"); }
            Object.assign(r, { id: newId(), recorded_at: "2026-10-05T00:00:00.000Z" });
          } else {
            if (r.id != null && all.some((x) => x.id === r.id)) return err(`duplicate key value violates unique constraint "${table}_pkey"`, "23505");
            r.id = r.id ?? newId();
          }
          all.push(r);
          written.push(r);
        }
        if (!wantRows) return { data: null, error: null };
        return { data: single ? written[0] ?? null : written, error: null };
      }
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        store[table] = all.filter((r) => !matched.includes(r));
        return { data: wantRows ? matched : null, error: null };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        if (!wantRows) return { data: null, error: null };
        return { data: single ? (matched[0] ? { ...matched[0] } : null) : matched.map((r) => ({ ...r })), error: null };
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        matched = [...matched].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limitN != null) matched = matched.slice(0, limitN);
      if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

const media = (n: number, captured: string) => ({
  id: `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`, owner_user_id: OWNER, media_type: "image", mime_type: "image/jpeg",
  public_url: `https://cdn.example.test/u/${OWNER}/p${n}.jpg`, captured_at: captured, source_type: "user", moderation_status: "approved",
  processing_status: "ready", deleted_at: null, provenance: null, created_at: "2026-03-02T22:00:00.000Z",
});

function seed(): Store {
  const memory = (id: string, placeId: string) => ({
    id, owner_id: OWNER, title: "Ramen night", caption: null, visibility: "only_me", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: placeId, canonical_location_id: null, location_city: "Tokyo", location_country: "Japan",
    location_lat: 35.66, location_lng: 139.7, starts_at: "2025-03-03T11:00:00.000Z", ends_at: null,
    state: "published", created_at: "2025-03-03T12:00:00.000Z", updated_at: "2025-03-03T12:00:00.000Z",
  });
  const place = (id: string, name: string) => ({
    id, name, primary_category: "food", latitude: 35.661, longitude: 139.701, address: "1-22-7 Jinnan", city: "Tokyo",
    country_code: "JP", status: "active", merged_into_place_id: null, canonical_location_id: null,
  });
  return {
    feature_flags: [],
    profiles: [{ id: ADMIN, role: "admin" }, { id: OWNER, role: "user", account_status: "active", name: "Owner", handle: "owner" }, { id: OTHER, role: "user" }],
    trips: [{ id: TRIP, owner_id: OWNER, title: "Lisbon", start_date: "2026-03-01", end_date: "2026-03-05", destination_city: "Lisbon", destination_country: "Portugal", status: "completed" }],
    trip_members: [],
    media_assets: [
      media(1, "2026-03-02T19:00:00.000Z"), media(2, "2026-03-02T19:40:00.000Z"), media(3, "2026-03-02T20:30:00.000Z"),
      media(4, "2026-03-03T14:00:00.000Z"), media(5, "2026-03-03T15:10:00.000Z"),
    ],
    memories: [memory(MEM_DA, PLACE_OPEN), memory(MEM_DA2, PLACE_TWO)],
    memory_items: [],
    memory_episodes: [],
    memory_evidence: [],
    places: [place(PLACE_OPEN, "Ichiran Shibuya"), place(PLACE_TWO, "Tsukiji Outer Market")],
    trip_saved_places: [],
    blocks: [],
  };
}

interface App { base: string; store: Store; close: () => Promise<void> }

async function start(opts: FakeOpts & { mutate?: (s: Store) => void } = {}): Promise<App> {
  resetHighlightSchemaMemo();
  const store = seed();
  opts.mutate?.(store);
  _setTestClient(makeClient(store, opts) as any, true);
  _setMemoryActionDeps({
    liveStatus: async () => null,
    tripWindows: async () => ({ ok: false, info: "test: free time not checked" }) as any,
    restrictiveGemCeiling: async () => ({ determined: true, ceiling: null }),
  });
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }; n(); });
  app.use("/api", memoryCandidatesRouter);
  app.use("/api", memoryActionsRouter);
  app.use("/api", adminMemoryMetricsRouter);
  app.use("/api", memoriesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

async function call(app: App, method: string, p: string, actor: string, body?: unknown) {
  const res = await fetch(app.base + p, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const metrics = async (app: App) => {
  const r = await call(app, "GET", "/api/admin/memory/metrics", ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

/** No identifier of any seeded row may appear anywhere in an admin response. */
function assertNoIds(app: App, body: unknown) {
  const text = JSON.stringify(body);
  const ids = new Set<string>([OWNER, OTHER, TRIP, MEM_DA, MEM_DA2, PLACE_OPEN, PLACE_TWO]);
  for (const t of ["memory_episodes", "memories", "memory_evidence", "media_assets"]) for (const r of app.store[t] ?? []) if (r.id) ids.add(String(r.id));
  for (const id of ids) assert.ok(!text.includes(id), `the admin response carries ${id}`);
  for (const word of ["Lisbon", "Sintra", "Portugal"]) assert.ok(!text.includes(word), `the admin response carries the place text "${word}"`);
}

let app: App | null = null;
beforeEach(() => { _resetMemoryKernelMetrics(); _resetMemoryQualityMetrics(); _setMemoryQualityClock(null); });
afterEach(async () => { _setMemoryActionDeps(null); _setMemoryQualityClock(null); if (app) { await app.close(); app = null; } });

describe("GET /admin/memory/metrics — end to end over the real routers", () => {
  it("is admin-only", async () => {
    app = await start();
    const r = await call(app, "GET", "/api/admin/memory/metrics", OWNER);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  it("on a fresh process both figures are UNPRODUCIBLE with a null value — never 0 — and the kernel sample rides along", async () => {
    app = await start();
    const b = await metrics(app);
    for (const k of ["false_memory_rate", "do_again_conversion"]) {
      assert.equal(b.quality[k].status, "UNPRODUCIBLE", k);
      assert.equal(b.quality[k].value, null, k);
      assert.equal(typeof b.quality[k].blockedBy, "string", k);
    }
    assert.equal(b.kernel.engineVersion, "memory-kernel-metrics@3");
    assert.deepEqual(b.kernel.notMeasurable, []);
    assert.match(b.scope, /this process/);
  });

  it("H217: the inbox surfaces, the owner keeps one and corrects its place through PATCH /memories/:id — place 1/2, total UNPRODUCIBLE on the time half", async () => {
    app = await start();
    assert.equal((await call(app, "POST", "/api/me/memory-candidates/detect", OWNER, { tripId: TRIP })).status, 200);
    const list = await call(app, "GET", "/api/me/memory-candidates", OWNER);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.candidates.length, 2);
    const [a] = [...list.body.candidates].sort((x: any, y: any) => String(x.startedAt).localeCompare(String(y.startedAt)));
    assert.equal(a.city, "Lisbon", "the inbox SHOWS the inferred place");
    const kept = await call(app, "POST", `/api/me/memory-candidates/${a.id}/confirm`, OWNER, {});
    assert.equal(kept.status, 200, JSON.stringify(kept.body));

    let b = await metrics(app);
    let fm = b.quality.false_memory_rate;
    assert.deepEqual([fm.byAssertion.place.surfaced, fm.byAssertion.place.corrected, fm.byAssertion.place.value], [2, 0, 0], "kept as shown: not a correction");
    assert.equal(fm.population.kept, 1);

    // The owner says it was not Lisbon — through the real edit route.
    const patched = await call(app, "PATCH", `/api/memories/${kept.body.memoryId}`, OWNER, { locationCity: "Sintra" });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    // A second listing shows the same candidate again: still one surfacing.
    await call(app, "GET", "/api/me/memory-candidates", OWNER);

    b = await metrics(app);
    fm = b.quality.false_memory_rate;
    assert.deepEqual([fm.byAssertion.place.status, fm.byAssertion.place.surfaced, fm.byAssertion.place.corrected, fm.byAssertion.place.value], ["OK", 2, 1, 0.5]);
    assert.deepEqual([fm.byAssertion.time.status, fm.byAssertion.time.surfaced, fm.byAssertion.time.corrected], ["UNPRODUCIBLE", 2, 0]);
    assert.equal(fm.status, "UNPRODUCIBLE");
    assert.equal(fm.value, null);
    assert.match(fm.blockedBy, /time: no client surface/);
    assert.deepEqual([fm.numerator, fm.denominator], [1, 4]);

    // The bare API CAN move the time; that is counted, and the total stays refused.
    const timed = await call(app, "PATCH", `/api/memories/${kept.body.memoryId}`, OWNER, { startsAt: "2026-03-02T18:00:00.000Z" });
    assert.equal(timed.status, 200, JSON.stringify(timed.body));
    fm = (await metrics(app)).quality.false_memory_rate;
    assert.equal(fm.byAssertion.time.corrected, 1);
    assert.equal(fm.status, "UNPRODUCIBLE");
    assertNoIds(app, b);
  });

  it("H217: a dismissed candidate is surfaced and not corrected; a candidate never listed is not surfaced", async () => {
    app = await start();
    await call(app, "POST", "/api/me/memory-candidates/detect", OWNER, { tripId: TRIP });
    // Detection alone shows nothing in the inbox's terms: no surfacing yet.
    assert.equal((await metrics(app)).quality.false_memory_rate.population.tracked, 0);
    const list = await call(app, "GET", "/api/me/memory-candidates", OWNER);
    const [a] = list.body.candidates;
    assert.equal((await call(app, "POST", `/api/me/memory-candidates/${a.id}/reject`, OWNER)).status, 200);
    const fm = (await metrics(app)).quality.false_memory_rate;
    assert.deepEqual([fm.byAssertion.place.surfaced, fm.byAssertion.place.corrected, fm.population.kept], [2, 0, 0]);
  });

  it("H217: memory_evidence unreadable ⇒ UNPRODUCIBLE with a null corrected count — not 0", async () => {
    app = await start();
    await call(app, "POST", "/api/me/memory-candidates/detect", OWNER, { tripId: TRIP });
    await call(app, "GET", "/api/me/memory-candidates", OWNER);
    const fm = await readFalseMemoryRate(makeClient(app.store, { failReads: new Set(["memory_evidence"]) }) as any);
    assert.equal(fm.status, "UNPRODUCIBLE");
    assert.match(String(fm.blockedBy), /memory_evidence could not be read/);
    assert.equal(fm.numerator, null);
    assert.equal(fm.byAssertion.place.status, "UNPRODUCIBLE", "the place half must not answer 0 over an unread source");
    assert.equal(fm.byAssertion.place.corrected, null);
    assert.equal(fm.byAssertion.place.surfaced, 2, "what was surfaced is still known");
    for (const t of ["memories", "memory_id_redirects"]) {
      // Each later source fails the figure too — once there is a link to follow.
      const store: Store = JSON.parse(JSON.stringify(app.store));
      store.memory_evidence.push({ episode_id: store.memory_episodes[0].id, user_id: OWNER, source_table: "memories", truth_level: "asserted", source_id: MEM_DA });
      const r = await readFalseMemoryRate(makeClient(store, { failReads: new Set([t]) }) as any);
      assert.equal(r.status, "UNPRODUCIBLE", t);
      assert.equal(r.numerator, null, t);
      assert.match(String(r.blockedBy), new RegExp(t), t);
    }
  });

  it("H217: a read that may be truncated is UNPRODUCIBLE, not a partial count", async () => {
    app = await start();
    await call(app, "POST", "/api/me/memory-candidates/detect", OWNER, { tripId: TRIP });
    await call(app, "GET", "/api/me/memory-candidates", OWNER);
    const ep = app.store.memory_episodes[0].id;
    for (let i = 0; i < 1000; i++) app.store.memory_evidence.push({ episode_id: ep, user_id: OWNER, source_table: "memories", truth_level: "asserted", source_id: `x${i}` });
    const r = await readFalseMemoryRate(makeClient(app.store, {}) as any);
    assert.equal(r.status, "UNPRODUCIBLE");
    assert.match(String(r.blockedBy), /truncated/);
  });

  it("H217: a Memory that absorbed another by MERGE is excluded; memory_id_redirects absent (3676 unapplied) means no merge", async () => {
    app = await start();
    await call(app, "POST", "/api/me/memory-candidates/detect", OWNER, { tripId: TRIP });
    await call(app, "GET", "/api/me/memory-candidates", OWNER);
    const [e1, e2] = app.store.memory_episodes;
    app.store.memory_evidence.push(
      { episode_id: e1.id, user_id: OWNER, source_table: "memories", truth_level: "asserted", source_id: MEM_DA },
      { episode_id: e2.id, user_id: OWNER, source_table: "memories", truth_level: "asserted", source_id: MEM_DA2 },
    );
    const absent = await readFalseMemoryRate({ ...makeClient(app.store, {}), from: (t: string) => (t === "memory_id_redirects"
      ? { select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: null, error: { code: "42P01", message: "relation \"public.memory_id_redirects\" does not exist" } }) }) }) }) }
      : makeClient(app.store, {}).from(t)) } as any);
    assert.equal(absent.population.excludedMerged, 0);
    assert.equal(absent.byAssertion.place.corrected, 2, "both Tokyo Memories differ from the shown Lisbon");
    app.store.memory_id_redirects = [{ old_memory_id: "99999999-0000-4000-8000-000000000000", new_memory_id: MEM_DA, reason: "merged" }];
    const merged = await readFalseMemoryRate(makeClient(app.store, {}) as any);
    assert.equal(merged.population.excludedMerged, 1);
    assert.deepEqual([merged.byAssertion.place.surfaced, merged.byAssertion.place.corrected], [1, 1]);
  });

  it("H217: a keep link written under ANOTHER user is not this owner's keep", async () => {
    app = await start();
    await call(app, "POST", "/api/me/memory-candidates/detect", OWNER, { tripId: TRIP });
    await call(app, "GET", "/api/me/memory-candidates", OWNER);
    const [e1] = app.store.memory_episodes;
    app.store.memory_evidence.push({ episode_id: e1.id, user_id: OTHER, source_table: "memories", truth_level: "asserted", source_id: MEM_DA });
    const r = await readFalseMemoryRate(makeClient(app.store, {}) as any);
    assert.deepEqual([r.population.kept, r.byAssertion.place.corrected], [0, 0]);
    app.store.memory_evidence.at(-1)!.user_id = OWNER;
    const mine = await readFalseMemoryRate(makeClient(app.store, {}) as any);
    assert.deepEqual([mine.population.kept, mine.byAssertion.place.corrected], [1, 1], "the same link under the owner IS the keep (MEM_DA says Tokyo, not the shown Lisbon)");
  });

  it("H222: a served Do Again plan, re-picked once, and saved to a trip inside the window converts; an unsaved plan does not", async () => {
    let now = Date.now();
    _setMemoryQualityClock(() => now);
    app = await start();
    const c1 = await call(app, "GET", `/api/memories/${MEM_DA}/actions/DO_AGAIN`, OWNER);
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    assert.equal(c1.body.compiled.addToTrip.id, PLACE_OPEN);
    now += 60_000;
    assert.equal((await call(app, "GET", `/api/memories/${MEM_DA}/actions/DO_AGAIN`, OWNER)).status, 200);
    assert.equal((await call(app, "GET", `/api/memories/${MEM_DA2}/actions/DO_AGAIN`, OWNER)).status, 200);
    // Not every action is a plan: an Add-to-trip compile is not Do Again.
    assert.equal((await call(app, "GET", `/api/memories/${MEM_DA2}/actions/ADD_TO_TRIP`, OWNER)).status, 200);

    // The Do Again sheet's picker saves the place to a trip (the row POST /trips/:tripId/saved-places writes).
    app.store.trip_saved_places.push({ id: newId(), trip_id: TRIP, user_id: OWNER, place_id: PLACE_OPEN, place_name: "Ichiran Shibuya", saved_at: new Date(now + 5 * 60_000).toISOString() });

    let da = (await metrics(app)).quality.do_again_conversion;
    assert.equal(da.status, "UNPRODUCIBLE", "inside the window nothing has matured: a rate now would be biased down");
    assert.deepEqual([da.plans.tracked, da.plans.pending, da.plans.compiles], [2, 2, 3]);

    now += DO_AGAIN_ATTRIBUTION_WINDOW_MS;
    const b = await metrics(app);
    da = b.quality.do_again_conversion;
    assert.deepEqual([da.status, da.numerator, da.denominator, da.value], ["OK", 1, 2, 0.5]);
    assert.match(da.definition, /PLANNING conversion/);
    assertNoIds(app, b);
  });

  it("H222: trip_saved_places unreadable ⇒ UNPRODUCIBLE with a null numerator — not 0", async () => {
    let now = Date.now();
    _setMemoryQualityClock(() => now);
    app = await start();
    assert.equal((await call(app, "GET", `/api/memories/${MEM_DA}/actions/DO_AGAIN`, OWNER)).status, 200);
    now += DO_AGAIN_ATTRIBUTION_WINDOW_MS;
    const r = await readDoAgainConversion(makeClient(app.store, { failReads: new Set(["trip_saved_places"]) }) as any);
    assert.deepEqual([r.status, r.value, r.numerator, r.denominator], ["UNPRODUCIBLE", null, null, 1]);
    assert.match(String(r.blockedBy), /trip_saved_places could not be read/);
  });

  it("H222: a trip_saved_places read that may be truncated is UNPRODUCIBLE", async () => {
    let now = Date.now();
    _setMemoryQualityClock(() => now);
    app = await start();
    await call(app, "GET", `/api/memories/${MEM_DA}/actions/DO_AGAIN`, OWNER);
    for (let i = 0; i < 1000; i++) app.store.trip_saved_places.push({ trip_id: `t${i}`, user_id: OWNER, place_id: PLACE_OPEN, saved_at: new Date(now + 1000).toISOString() });
    now += DO_AGAIN_ATTRIBUTION_WINDOW_MS;
    const r = await readDoAgainConversion(makeClient(app.store, {}) as any);
    assert.equal(r.status, "UNPRODUCIBLE");
    assert.match(String(r.blockedBy), /truncated/);
  });

  it("H222: a refused compile is not a plan", async () => {
    app = await start({ mutate: (s) => { s.places[0].status = "closed"; } });
    const r = await call(app, "GET", `/api/memories/${MEM_DA}/actions/DO_AGAIN`, OWNER);
    assert.notEqual(r.status, 200);
    assert.equal((await metrics(app)).quality.do_again_conversion.plans.tracked, 0);
  });
});
