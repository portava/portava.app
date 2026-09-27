/**
 * census-discovery §57 — A07 (Sensing `:129`) and A03 (Sensing `:135`, §5.1),
 * verified on controlled data with the flags ON IN THIS PROCESS ONLY.
 *
 * Nothing here turns a flag on anywhere real: every flag is a row in the
 * in-memory PostgREST double (helpers/fakeMapDb), created and discarded per
 * test. `discovery_live_rank_enabled` (2850) and
 * `discovery_candidate_projection_enabled` (2361) stay FALSE-seeded on every
 * database.
 *
 * THE CRITERIA, IN THE SPEC'S WORDS
 * =================================
 * Sensing `:129`: "Safety constraints outrank opportunity/vibe. A dangerous
 * place must never simultaneously be promoted as 'best move now'."
 *   P. POSITION — a demoted place is never first, and never ahead of ANY row
 *      not shown to be dangerous. Before §57 the demotion was scoped to the
 *      60-row live window, so rows past it — never graded, never shown safe or
 *      unsafe — sat BEHIND a place the same serve had just graded dangerous,
 *      and a page whose head was all dangerous led with one. (P1 was seen RED.)
 *   L. LABEL — no channel of the rendered candidate says "go now" about it.
 *      Two channels exist: `whyNow` (the live reasons) and `reasons` (`01`
 *      §11's plain language, whose `nearby_now` renders "Close to you and open
 *      around now."). Before §57 an unsafe place's why-now read "crowd unsafe
 *      density · trajectory building · reported vibe lively" and its reasons
 *      still said "open around now". (L1 and L2 were seen RED.)
 * Sensing `:135` / §5.1: a server-built candidate with why-now, why-for-user,
 * confidence, freshness and truth class, "prediction must never be rendered
 * indistinguishably from observation".
 *   T. TRUTH — a forecast reaches the wire only in the forecast vocabulary and
 *      with no validity (so the client, which shows a why-now only while it is
 *      valid, never shows it as current); the candidate's own truth class never
 *      claims a class no producer backs.
 *   E. EXPIRY — an expired reading neither demotes nor explains; a current one
 *      is sent with a validity that runs out at its own horizon.
 *   F. A FAILED STATE READ moves nothing and labels nothing.
 *   R. RETRIES — the same request twice ranks and labels identically.
 *
 *   S. THE COMPASS SERVE POINTS (`compass_candidate_hit`, `compass_fresh_rank`)
 *      run no Discovery live grade: their order is Compass's pipeline's, whose
 *      own Live exclusion is gated separately by COMPASS_LIVE_CONSTRAINTS_ENABLED
 *      (compass/CompassLiveConstraints). The demotion-only pass they need,
 *      `withDiscoveryLiveSafety`, is tested here; the route wiring is a hunk in
 *      a file this lane does not own, and its route test is
 *      discoveryLiveSafetyCompassPath.test.ts (C1, TODO until the hunk lands).
 *
 * Run: node --import tsx/esm --test src/test/discoveryLiveSafetyPrecedence.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";

import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearPromotedScopeCache, type LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateLiveRankFlagCache, withDiscoveryLiveRank, withDiscoveryLiveSafety } from "../lib/discoveryLiveRankRead.js";
import { LIVE_RANK_WINDOW, gradeLiveRow, rankDiscoveryLive, type LiveRankRow } from "../lib/discoveryLiveRank.js";
import {
  SAFETY_WITHHELD_REASON,
  invalidateCandidateProjectionFlagCache,
  projectDiscoveryCandidate,
  withSafetyPrecedence,
  type DiscoveryCandidate,
} from "../lib/discoveryCandidate.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";

const USER  = "bbbb2222-0000-0000-0000-000000000002";
const TOKEN = "live-safety-tok";
const KEY   = "miami:for_you:10"; // cacheKey(destination, category, radiusKm)

const NOW = Date.now();
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];
const LIVE_RANK_ON = { flag: "discovery_live_rank_enabled", enabled: true };
const PROJECTION_ON = { flag: "discovery_candidate_projection_enabled", enabled: true };
/** PDE ranks the cache-A serve, so `reasons` are grounded (lib/discoveryEngineMode's one row). */
const PDE_MODE = { flag: "DISCOVERY_ENGINE_MODE", enabled: true, metadata: { mode: "pde", cohort: { kind: "all" } } };

/** A canonical-looking uuid for place `n`. */
const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;

function place(n: number, over: Partial<DiscoveryPlace> = {}): DiscoveryPlace {
  const id = uuid(n);
  return {
    id: `db/${id}`, canonicalPlaceId: id, name: `Place ${n}`, category: "for_you",
    type: "traveler_pick", description: null, distanceKm: 1, lat: 25.77, lng: -80.19,
    tags: [], address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount: 1,
    ...over,
  } as DiscoveryPlace;
}

let snapSeq = 0;
function snapshot(subject: string, over: Record<string, unknown> = {}) {
  snapSeq += 1;
  return {
    id: `snap-${snapSeq}`,
    subject_id: subject,
    zone_id: null,
    claim_type: "crowd.level",
    value: { level: "quiet" },
    confidence: 0.9,
    source_count: 30,
    observed_at: iso(-3),
    expires_at: iso(45),
    privacy_eligible: true,
    conflict_state: "none",
    source_class: "firsthand_unverified",
    computed_at: iso(-3),
    ...over,
  };
}
const unsafe = (subject: string, over: Record<string, unknown> = {}) =>
  snapshot(subject, { value: { level: "unsafe_density" }, ...over });

function world(flags: Array<Record<string, unknown>>, snapshots: any[] = []): FakeState {
  return {
    feature_flags: [...LIVE_GATES_OPEN, ...flags],
    intel_live_promoted_scopes: [
      { scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }, { scope_key: "|vibe.state" },
    ],
    intel_state_snapshots: snapshots,
  };
}

/**
 * The double, plus a sink for the serve path's own writes. A PDE-ranked serve is
 * `served: true` and writes impressions fire-and-forget (lib/discoveryPde,
 * lib/rankLog); the read double refuses every write verb on purpose, so those
 * writes are accepted here, and nothing in this file asserts on them — this
 * suite is about what is RENDERED, not about the impression log.
 */
function withWriteSink(client: any): any {
  const accept = () => {
    const done: any = {
      select: () => done,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (r: any, j?: any) => Promise.resolve({ data: null, error: null }).then(r, j),
    };
    return done;
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => new Proxy(target.from(table), {
          get(b, p) {
            if (p === "insert" || p === "upsert" || p === "update" || p === "delete") return () => accept();
            const v = b[p];
            return typeof v === "function" ? v.bind(b) : v;
          },
        });
      }
      if (prop === "rpc") return async () => ({ data: null, error: null });
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

interface Body {
  places: Array<{ id: string; candidate?: DiscoveryCandidate }>;
  total: number;
  meta: { cacheLevel: string; liveRank?: { mode: string; readable: boolean; windowSize: number; demoted: number } };
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(discoveryRouter);
  return app;
}

describe("§57 — Sensing :129 / :135 on GET /discovery, flags ON in-process only", () => {
  let server: Server;
  let url: string;

  const reset = () => {
    invalidateDiscoveryEngineModeCache();
    invalidateLiveRankFlagCache();
    invalidateCandidateProjectionFlagCache();
    _clearPromotedScopeCache();
  };

  beforeEach(async () => {
    server = createServer(makeApp());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    server.unref();
    url = `http://127.0.0.1:${(server.address() as any).port as number}`;
    _setTestDbPlacesOverride(async () => []);
    reset();
  });
  afterEach(async () => {
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    reset();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function get(state: FakeState, cached: DiscoveryPlace[], query = ""): Promise<Body> {
    reset();
    _setTestServiceClient(withWriteSink(makeFakeMapDb(state, { token: TOKEN, userId: USER })));
    _injectTestCacheEntry(KEY, cached);
    const res = await fetch(`${url}/discovery?destination=Miami&lat=25.77&lng=-80.19${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Body;
  }

  // ── P. position ─────────────────────────────────────────────────────────

  describe("P. a demoted place is never first, and never ahead of a row not shown dangerous", () => {
    it("P1 the whole live window is dangerous and two rows lie past it: the page leads with those two, never with a dangerous place", async () => {
      const cached = Array.from({ length: LIVE_RANK_WINDOW + 2 }, (_, i) => place(i + 1));
      const dangerous = cached.slice(0, LIVE_RANK_WINDOW);
      const body = await get(world([LIVE_RANK_ON], dangerous.map((p) => unsafe(p.canonicalPlaceId!))), cached, "&intentMode=social");
      assert.equal(body.meta.liveRank?.demoted, LIVE_RANK_WINDOW, "every window row must actually be graded dangerous");
      assert.deepEqual(
        body.places.slice(0, 2).map((p) => p.id),
        cached.slice(LIVE_RANK_WINDOW).map((p) => p.id),
        `a dangerous place led the page — got ${JSON.stringify(body.places.slice(0, 3).map((p) => p.id))}`,
      );
      assert.equal(body.total, cached.length, "safety may reorder, never drop");
    });

    it("P2 walked page by page, no dangerous row precedes any row that is not dangerous, anywhere in the list", async () => {
      const cached = Array.from({ length: LIVE_RANK_WINDOW + 5 }, (_, i) => place(i + 1));
      // Dangerous rows scattered through the head, including position 0.
      const dangerousIdx = new Set([0, 3, 17, 40, LIVE_RANK_WINDOW - 1]);
      const snaps = [...dangerousIdx].map((i) => unsafe(cached[i]!.canonicalPlaceId!));
      const served: string[] = [];
      for (let page = 1; page <= 4; page++) {
        const body = await get(world([LIVE_RANK_ON], snaps), cached, `&intentMode=high_energy&page=${page}`);
        served.push(...body.places.map((p) => p.id));
      }
      assert.equal(served.length, cached.length);
      const dangerousIds = new Set([...dangerousIdx].map((i) => cached[i]!.id));
      const firstDangerous = served.findIndex((id) => dangerousIds.has(id));
      assert.equal(firstDangerous, cached.length - dangerousIdx.size, `a safe row sat behind a dangerous one: ${JSON.stringify(served.slice(firstDangerous - 1, firstDangerous + 3))}`);
      assert.notEqual(served[0], cached[0]!.id, "the dangerous row that was cached first is still first");
    });

    it("P3 the serve-point function itself (the cold path calls the same one): demoted rows go behind the rows past the window", async () => {
      const rows = Array.from({ length: LIVE_RANK_WINDOW + 3 }, (_, i) => ({ id: `r${i}`, canonicalPlaceId: `c${i}`, distanceKm: 1 }));
      const unsafeEnv = (subjectId: string): LiveClaimEnvelope[] => [{
        id: `env-${subjectId}`, claimType: "crowd.level", value: { level: "unsafe_density" }, confidence: 0.9, band: "live",
        sourceClass: "firsthand_unverified", sourceCountBucket: "several", observedAt: iso(-3), validUntil: iso(30),
        state: "live", conflictState: "none", conflict: null,
      } as unknown as LiveClaimEnvelope];
      const stub = makeFakeMapDb({ feature_flags: [LIVE_RANK_ON] }, { token: TOKEN, userId: USER });
      const out = await withDiscoveryLiveRank(stub, rows, {
        mode: "explore", nowMs: NOW, gatesOpen: async () => true,
        readEnvelopes: async (s) => (s === "c0" || s === "c1" ? unsafeEnv(s) : []),
      });
      assert.equal(out.applied, true);
      const ids = out.places.map((r) => r.id);
      assert.deepEqual(ids.slice(-2), ["r0", "r1"], "the two dangerous rows must be LAST, behind the tail");
      assert.deepEqual(ids.slice(0, -2), rows.slice(2).map((r) => r.id), "everything else keeps its order");
    });

    it("P4 the pure engine agrees when handed the whole list: a demoted row follows the ungraded tail", () => {
      const env = (level: string) => ({
        id: `e-${level}`, claimType: "crowd.level", value: { level }, confidence: 0.9, band: "live",
        sourceClass: "firsthand_unverified", sourceCountBucket: "several", observedAt: iso(-3), validUntil: iso(30),
        state: "live", conflictState: "none", conflict: null,
      }) as unknown as LiveClaimEnvelope;
      const rows: LiveRankRow[] = Array.from({ length: LIVE_RANK_WINDOW + 2 }, (_, i) => ({
        id: `r${i}`, subjectId: `s${i}`, envelopes: i === 0 ? [env("unsafe_density")] : [], readable: true, distanceKm: 1,
      }));
      const out = rankDiscoveryLive(rows, { mode: "explore", nowMs: NOW });
      assert.equal(out.ranked[out.ranked.length - 1]!.id, "r0");
      assert.equal(out.ranked[0]!.id, "r1");
    });
  });

  // ── S. the safety-only pass, for an order Discovery does not own ────────

  describe("S. withDiscoveryLiveSafety — the demotion, and nothing else, for the Compass serve points", () => {
    const envOf = (subjectId: string, level: string): LiveClaimEnvelope[] => [{
      id: `env-${subjectId}-${level}`, claimType: "crowd.level", value: { level }, confidence: 0.9, band: "live",
      sourceClass: "firsthand_unverified", sourceCountBucket: "several", observedAt: iso(-3), validUntil: iso(30),
      state: "live", conflictState: "none", conflict: null,
    } as unknown as LiveClaimEnvelope];
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, canonicalPlaceId: `c${i}`, distanceKm: 0.2 }));

    it("S1 flag OFF: the very same array, and not one claim read", async () => {
      let reads = 0;
      const stub = makeFakeMapDb({ feature_flags: [] }, { token: TOKEN, userId: USER });
      const out = await withDiscoveryLiveSafety(stub, rows, { gatesOpen: async () => true, readEnvelopes: async () => { reads += 1; return []; } });
      assert.equal(out.places, rows);
      assert.equal(out.applied, false);
      assert.equal(reads, 0);
    });

    it("S2 flag ON: a dangerous row goes last, and NO live influence is spent — a row with a glowing reading does not move", async () => {
      const stub = makeFakeMapDb({ feature_flags: [LIVE_RANK_ON] }, { token: TOKEN, userId: USER });
      const out = await withDiscoveryLiveSafety(stub, rows, {
        mode: "quiet", nowMs: NOW, gatesOpen: async () => true,
        // c0 is dangerous; c5 is the quiet place a QUIET viewer would be promoted to by the ranker.
        readEnvelopes: async (s) => (s === "c0" ? envOf(s, "unsafe_density") : s === "c5" ? envOf(s, "quiet") : []),
      });
      assert.equal(out.applied, true);
      assert.deepEqual(out.places.map((r) => r.id), ["r1", "r2", "r3", "r4", "r5", "r0"],
        "only the dangerous row may move — anything else is ranking on an order Compass owns");
      assert.equal(out.demoted, 1);
      assert.deepEqual([...out.byId.keys()], ["r0"], "the grades handed on are the DEMOTED rows only, so no other why-now appears");
      // The ranker, by contrast, WOULD have moved r5: the pass is not the ranker.
      const ranked = await withDiscoveryLiveRank(stub, rows, {
        mode: "quiet", nowMs: NOW, gatesOpen: async () => true,
        readEnvelopes: async (s) => (s === "c0" ? envOf(s, "unsafe_density") : s === "c5" ? envOf(s, "quiet") : []),
      });
      assert.notDeepEqual(ranked.places.map((r) => r.id), out.places.map((r) => r.id), "control: the live ranker does spend influence here");
    });

    it("S3 flag ON, nothing dangerous: the very same array", async () => {
      const stub = makeFakeMapDb({ feature_flags: [LIVE_RANK_ON] }, { token: TOKEN, userId: USER });
      const out = await withDiscoveryLiveSafety(stub, rows, { nowMs: NOW, gatesOpen: async () => true, readEnvelopes: async (s) => envOf(s, "busy") });
      assert.equal(out.places, rows);
      assert.equal(out.byId.size, 0);
    });
  });

  // ── L. label ───────────────────────────────────────────────────────────

  describe("L. no rendered channel says 'go now' about a dangerous place", () => {
    it("L1 why-now: a dangerous place's live reasons are the safety reading ALONE — no trajectory, no vibe, no queue", async () => {
      const cached = [place(1), place(2), place(3)];
      const p1 = cached[0]!.canonicalPlaceId!;
      const body = await get(world([LIVE_RANK_ON, PROJECTION_ON], [
        unsafe(p1),
        snapshot(p1, { claim_type: "crowd.trajectory", value: { trajectory: "building" } }),
        snapshot(p1, { claim_type: "vibe.state", value: { state: "lively" } }),
        snapshot(cached[1]!.canonicalPlaceId!, { value: { level: "busy" } }),
      ]), cached, "&intentMode=social");
      const byId = new Map(body.places.map((p) => [p.id, p]));
      assert.deepEqual(byId.get(cached[0]!.id)?.candidate?.whyNow, ["crowd_unsafe_density"]);
      assert.deepEqual(byId.get(cached[1]!.id)?.candidate?.whyNow, ["crowd_busy"], "a safe place keeps its own reasons");
      assert.equal(body.places[body.places.length - 1]!.id, cached[0]!.id);
    });

    it("L2 reasons: on a PDE-ranked serve a dangerous place does not carry `nearby_now` (\"…open around now.\") while its safe neighbours do", async () => {
      const cached = [place(1), place(2), place(3)];
      const body = await get(world([LIVE_RANK_ON, PROJECTION_ON, PDE_MODE], [unsafe(cached[0]!.canonicalPlaceId!)]), cached, "&intentMode=explore");
      const byId = new Map(body.places.map((p) => [p.id, p]));
      const safe = byId.get(cached[1]!.id)!.candidate!;
      assert.equal(safe.rankedBy, "pde", "the serve must actually be PDE-ranked, or `reasons` is empty and this proves nothing");
      assert.ok(safe.reasons.some((r) => r.code === SAFETY_WITHHELD_REASON), "control: a safe neighbour carries nearby_now");
      const dangerous = byId.get(cached[0]!.id)!.candidate!;
      assert.equal(dangerous.reasons.some((r) => r.code === SAFETY_WITHHELD_REASON), false,
        `a dangerous place was told "${dangerous.reasons.map((r) => r.text).join(" / ")}"`);
      assert.deepEqual(dangerous.whyForUser, safe.whyForUser, "the ranker's own feature record is not rewritten — only the rendered 'now' claim is withheld");
    });

    it("L3 withSafetyPrecedence is inert without a grade, and on a grade that is not demoted", () => {
      const c = { id: "x", reasons: [{ code: "nearby_now", text: "Close to you and open around now." }] } as unknown as DiscoveryCandidate;
      assert.equal(withSafetyPrecedence({ liveRankById: null }, c), c, "flags off ⇒ the same object, untouched");
      const safeGrade = gradeLiveRow({ id: "x", subjectId: "s", envelopes: [], readable: true, distanceKm: 1 }, { mode: "explore", nowMs: NOW });
      assert.equal(withSafetyPrecedence({ liveRankById: new Map([["x", safeGrade]]) }, c), c);
    });
  });

  // ── T. truth ───────────────────────────────────────────────────────────

  describe("T. a prediction is never rendered as an observation", () => {
    it("T1 an EMERGING trajectory reaches the candidate only as `forecast_*`, with NO validity — so it is never shown as current", () => {
      const emerging = {
        id: "e-emerging", claimType: "crowd.trajectory", value: { trajectory: "building" }, confidence: 0.6, band: "likely_current",
        sourceClass: "firsthand_unverified", sourceCountBucket: "few", observedAt: iso(-3), validUntil: iso(30),
        state: "emerging", conflictState: "none", conflict: null,
      } as unknown as LiveClaimEnvelope;
      const grade = gradeLiveRow({ id: "db/x", subjectId: "s", envelopes: [emerging], readable: true, distanceKm: 1 }, { mode: "tonight", nowMs: NOW });
      assert.equal(grade.evidence, "forecast", "the fixture must actually be a forecast");
      const c = projectDiscoveryCandidate({ id: "db/x", canonicalPlaceId: "x" }, {
        cacheLevel: "L1", cachedAt: NOW, scoredById: null, rankedBy: "none", liveRankById: new Map([["db/x", grade]]), nowMs: NOW,
      });
      assert.ok(c.whyNow && c.whyNow.length > 0);
      for (const token of c.whyNow!) assert.match(token, /^forecast_/, `a forecast was sent as "${token}"`);
      assert.equal(c.whyNowValidForMs, null, "a forecast carries no validity, so the client's why-now rule never shows it as current");
      assert.ok(["corroborated", "observed", "stale", "unknown"].includes(c.truthClass), `the candidate claimed ${c.truthClass}`);
    });
  });

  // ── E. expiry ──────────────────────────────────────────────────────────

  describe("E. stale state expires", () => {
    it("E1 an EXPIRED unsafe reading neither demotes nor explains; a current one is sent with a validity that ends at its horizon", async () => {
      const cached = [place(1), place(2), place(3)];
      const body = await get(world([LIVE_RANK_ON, PROJECTION_ON], [
        unsafe(cached[0]!.canonicalPlaceId!, { observed_at: iso(-60), expires_at: iso(-1) }),
        snapshot(cached[1]!.canonicalPlaceId!, { value: { level: "busy" }, expires_at: iso(10) }),
      ]), cached, "&intentMode=explore");
      assert.equal(body.meta.liveRank?.demoted, 0, "an expired safety reading still demoted");
      assert.equal(body.places[0]!.id, cached[0]!.id, "the expired reading still moved the row");
      assert.equal(body.places[0]!.candidate?.whyNow, null);
      const valid = body.places.find((p) => p.id === cached[1]!.id)!.candidate!;
      assert.deepEqual(valid.whyNow, ["crowd_busy"]);
      assert.ok(valid.whyNowValidForMs !== null && valid.whyNowValidForMs <= 10 * 60_000 && valid.whyNowValidForMs > 9 * 60_000,
        `validity ${valid.whyNowValidForMs} is not the reading's own horizon`);
    });
  });

  // ── F. a failed state read ─────────────────────────────────────────────

  describe("F. a failed state read moves nothing and labels nothing", () => {
    it("F1 the snapshot table errors: the cached order is served, nothing is demoted or explained, and a would-be-unsafe row is not promoted", async () => {
      const cached = [place(1), place(2), place(3)];
      const state = world([LIVE_RANK_ON, PROJECTION_ON]);
      state.intel_state_snapshots = { error: { message: "snapshots down" } };
      const body = await get(state, cached, "&intentMode=social");
      assert.deepEqual(body.places.map((p) => p.id), cached.map((p) => p.id));
      assert.equal(body.meta.liveRank?.demoted, 0);
      for (const p of body.places) assert.equal(p.candidate?.whyNow, null, `${p.id} was explained by a read that failed`);
    });
  });

  // ── R. retries ─────────────────────────────────────────────────────────

  describe("R. the same request twice ranks and labels identically", () => {
    it("R1 order, demotion and every rendered label repeat exactly", async () => {
      const cached = Array.from({ length: 6 }, (_, i) => place(i + 1));
      const w = world([LIVE_RANK_ON, PROJECTION_ON, PDE_MODE], [
        unsafe(cached[2]!.canonicalPlaceId!),
        snapshot(cached[4]!.canonicalPlaceId!, { value: { level: "busy" } }),
      ]);
      const view = (b: Body) => ({
        ids: b.places.map((p) => p.id),
        liveRank: b.meta.liveRank,
        labels: b.places.map((p) => ({ whyNow: p.candidate?.whyNow, reasons: p.candidate?.reasons, truthClass: p.candidate?.truthClass })),
      });
      const one = view(await get(w, cached, "&intentMode=social"));
      const two = view(await get(w, cached, "&intentMode=social"));
      assert.deepEqual(two, one);
      assert.equal(one.ids[one.ids.length - 1], cached[2]!.id);
    });
  });
});
