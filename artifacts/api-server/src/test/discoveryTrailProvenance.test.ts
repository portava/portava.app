/**
 * The Trails surface's two "could not measure" distinctions, pinned.
 *
 * census-discovery rows: DC-17 (`10` §5 — a derived feature retains its source
 * event window, feature version, model version and computation time) and DC-05
 * (§11 health, on the path that actually reaches the shipping ranker).
 *
 * WHY THIS FILE EXISTS — two gaps, both measured before it was written
 * ===================================================================
 * 1. census-discovery §38.6 item 1: *"`TrailService.ts` drops it at two sites
 *    with no reason given."* Both sites took `.values` off the momentum
 *    loader's `MomentumMap` and discarded the `provenance` beside it, so the
 *    ONE derived input that orders `trending_now` — and the ONE that decides
 *    the boolean `trending` — arrived at a client with no statement of what
 *    corpus it was computed over. The row's own reading is that the reader
 *    exists and the consumer does not.
 *
 * 2. census-discovery §40.2 closed a fabricated positive: `readOpenReportCounts`
 *    used to discard its `error` and return `{}`, which `computeTrailHealth`
 *    read as a measured "no open reports" and `trailHealthScale` turned into a
 *    HIGHER multiplier on served rank. The fix landed. **Nothing tested it.**
 *    Measured directly: mutating `return undefined` to `return {}` in
 *    `readOpenReportCounts` left `discoveryTrailRoutes` 58/58 and
 *    `discoveryTrailModifier` 60/60 green. The single-Trail twin
 *    (`readOpenReportCount`) IS pinned — the same mutation there turns three
 *    tests red — so the class was half-covered, on the half that does not reach
 *    the ranker. This file covers the half that does.
 *
 * WHAT THIS FILE DOES NOT CLAIM
 * =============================
 * Neither row moves. Migration 2910 is applied to no production database and
 * `discovery_ranking_modifiers_enabled` is seeded FALSE, so everything below is
 * proven against the app-side contract and not against a live schema. DC-17's
 * remaining leg is stated at the bottom of this header rather than hidden:
 *
 *   `loadLocalMomentum` degrades a FAILED `rank_events` read into an EMPTY map
 *   that still carries a full provenance. So "provenance present, no momentum"
 *   still covers both *the window was read and nothing surged* and *the read
 *   failed*. That collapse is in `lib/discoveryLocalMomentum.ts`, which this
 *   lane does not own. What TrailService CAN say, and now does, is the third
 *   state: no reading was taken at all.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx --test src/test/discoveryTrailProvenance.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import {
  getTrailModules, trailTrending, loadViewerTrailModifier,
} from "../services/trails/TrailService.js";
import { toPublicProvenance } from "../routes/trails.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";
import {
  _resetLocalMomentumCacheForTest, MOMENTUM_BASELINE_WINDOW_MS, LOCAL_MOMENTUM_MODEL_VERSION, LOCAL_MOMENTUM_FEATURE_VERSION,
} from "../lib/discoveryLocalMomentum.js";
import {
  DISCOVERY_MODEL_VERSION, DISCOVERY_FEATURE_VERSION,
} from "../lib/discoveryRankProvenance.js";

const USER = "11111111-1111-4111-8111-111111111111";
const T_A = "22222222-2222-4222-8222-2222222222a1";
const PLACE_A = "33333333-3333-4333-8333-3333333333a1";
const PLACE_B = "33333333-3333-4333-8333-3333333333b1";
const POST_A = "33333333-3333-4333-8333-3333333333c1";

const NOW = 1_770_000_000_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Row = Record<string, any>;

/**
 * A PostgREST-shaped fake, deliberately NOT shared with
 * `discoveryTrailRoutes.test.ts`.
 *
 * That file's fake has no `.range()`, and `loadLocalMomentum` pages with
 * `.range()` — so every momentum read in that suite lands in the loader's own
 * `catch` and returns the empty map. Reusing it here would mean asserting about
 * a provenance produced by a read that never happened, which is precisely the
 * defect class this file is about. This fake pages properly, so the window
 * asserted below is a window the loader really computed over.
 *
 * `erroring` makes a PRESENT table's read fail with a statement timeout. That is
 * the distinction that matters: a missing relation is a true fact about a
 * deployment, a timeout is *the answer is unknown*, and code that cannot tell
 * them apart reports an unknown as an absence.
 */
function makeDb(seed: Record<string, Row[]>, erroring: string[] = []) {
  const tables: Record<string, Row[]> = {
    trails: [], content_trails: [], trail_follows: [],
    trail_reports: [], trail_health_snapshots: [], rank_events: [],
    ...seed,
  };
  const broken = new Set(erroring);

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    const store = () => (tables[table] ??= []);
    const fail = () => ({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    const rows = () => {
      let out = store().filter((r) => filters.every((f) => f(r)));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };
    const run = () => (broken.has(table) ? fail() : { data: rows(), error: null });

    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt(c: string, v: any) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      // lib/blocks.fetchBlockedSet narrows inside `.or()`; the Trail pages are
      // viewer-scoped by it (census-discovery §51). A missing `.or` throws
      // there, reads as an unreadable block list, and withholds every member.
      or(expr: string) { filters.push(orPredicate(expr)); return b; },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      maybeSingle() {
        if (broken.has(table)) return Promise.resolve(fail());
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      // Writes are accepted and discarded: the only one these paths make is
      // `recordTrailHealthSnapshot`, a fire-and-forget diagnostic. Every
      // terminal here resolves a PLAIN `{data,error}` and never the builder
      // itself — a builder carrying `.then` that resolves to itself is an
      // infinite thenable chain, not a stub.
      insert() {
        const settled = { data: null, error: null };
        const r: any = {
          select: () => r,
          maybeSingle: () => Promise.resolve(settled),
          then: (res: any) => Promise.resolve(settled).then(res),
        };
        return r;
      },
      then(res: (r: any) => any, rej?: (e: any) => any) {
        return Promise.resolve(run()).then(res, rej);
      },
    };
    return b;
  }
  return { from, _tables: tables };
}

const trail = (id: string, over: Row = {}): Row => ({
  id, slug: `slug-${id.slice(-4)}`, title: `Trail ${id.slice(-4)}`, description: null,
  destination: "bangkok", place_scope: null, parent_trail_id: null,
  review_state: "approved",
  lifecycle_status: "active", created_by: USER,
  created_at: iso(86_400_000), updated_at: iso(86_400_000), ...over,
});

const member = (id: string, over: Row = {}): Row => ({
  id, trail_id: T_A, source_type: "place", source_id: PLACE_A,
  relationship: "primary", signal: null, source: "user", confidence: 0.9,
  contributor_id: USER, content_state: "just_arrived", created_at: iso(3_600_000), ...over,
});

/** `surface: "discovery"` and a non-analytics outcome, or the loader filters it out. */
const event = (itemId: string, msAgo: number): Row => ({
  id: `e-${itemId}-${msAgo}`, item_id: itemId, surface: "discovery",
  outcome: "save", served_at: iso(msAgo), outcome_at: iso(msAgo),
});

const db = (seed: Record<string, Row[]>, erroring: string[] = []) => {
  _resetLocalMomentumCacheForTest();
  return makeDb(seed, erroring);
};

// ── A loopback app, so the wire projection is proved at its real URL ────────
//
// The service half can be right while the route drops the field, which is the
// same "reader exists, consumer does not" shape §38.6 names. Asserting over HTTP
// is the only way to say the field REACHES a client.

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${USER}`, "content-type": "application/json" },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The fake with the `auth.getUser` the routes' `requireUser` needs. */
const servedDb = (seed: Record<string, Row[]>, erroring: string[] = []) => {
  const d: any = db(seed, erroring);
  d.auth = {
    async getUser(token: string) {
      return token === USER
        ? { data: { user: { id: USER } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  d._tables.profiles = [{ id: USER, account_status: "active", role: "user" }];
  _setTestClient(d, true);
  return d;
};

// ── DC-17 — the reading's provenance survives into the service ──────────────

describe("DC-17 — `trending_now`'s derived input retains its window (§38.6 item 1)", () => {
  it("carries all FOUR of `10` §5's facts, and the two versions are the SHARED constants", async () => {
    const sc = db({
      trails: [trail(T_A)],
      content_trails: [member("m1")],
      rank_events: Array.from({ length: 8 }, (_, i) => event(PLACE_A, 3_600_000 + i)),
    });

    const r = await getTrailModules(sc, T_A, { nowMs: NOW });
    assert.equal(r.refusal, null);
    const p = r.momentumProvenance;
    assert.ok(p, "the momentum loader's provenance must reach the caller, not be dropped");

    // Fact 1 — the SOURCE EVENT WINDOW, as the same two numbers the filter used.
    assert.equal(p.window.kind, "bounded");
    assert.equal(p.window.endMs, NOW, "the window ends at the clock the computation was handed");
    assert.equal(
      p.window.startMs, NOW - MOMENTUM_BASELINE_WINDOW_MS,
      "the stated start must be the baseline cut-off the bucketing actually applied",
    );
    // Facts 2 and 3 — the kernel's OWN versions (§68), never the Compass ranker's.
    assert.equal(p.modelVersion, LOCAL_MOMENTUM_MODEL_VERSION); assert.notEqual(p.modelVersion, DISCOVERY_MODEL_VERSION);
    assert.equal(p.featureVersion, LOCAL_MOMENTUM_FEATURE_VERSION);
    // Fact 4 — the COMPUTATION clock, not the read-back clock.
    assert.equal(p.computedAt, NOW);
  });

  it("a Trail with no `place` members reports NO provenance — no window was consulted", async () => {
    const sc = db({
      trails: [trail(T_A)],
      // A post membership: real content, but nothing the momentum loader reads.
      content_trails: [member("m1", { source_type: "post", source_id: POST_A })],
    });

    const r = await getTrailModules(sc, T_A, { nowMs: NOW });
    assert.equal(r.refusal, null);
    assert.equal(
      r.momentumProvenance, null,
      "a provenance here would describe a computation that never ran",
    );
  });

  it("`trailTrending` publishes the window behind its BOOLEAN, and null when it took no reading", async () => {
    const withMembers = db({
      trails: [trail(T_A)],
      content_trails: [member("m1")],
      rank_events: Array.from({ length: 8 }, (_, i) => event(PLACE_A, 3_600_000 + i)),
    });
    const measured = await trailTrending(withMembers, T_A, NOW);
    assert.equal(measured.refusal, null);
    assert.ok(measured.momentumProvenance, "a boolean with no window is a claim about an unspecified corpus");
    assert.equal(measured.momentumProvenance.window.endMs, NOW);

    const empty = db({ trails: [trail(T_A)], content_trails: [] });
    const unmeasured = await trailTrending(empty, T_A, NOW);
    assert.equal(unmeasured.refusal, null);
    assert.equal(unmeasured.momentum, null);
    assert.equal(
      unmeasured.momentumProvenance, null,
      "`not trending` and `never measured` must not serialise alike",
    );
  });

  it("a refusal carries no provenance — a window nothing was read over is not a measurement", async () => {
    const sc = db({ trails: [trail(T_A)], content_trails: [member("m1")] }, ["content_trails"]);
    const r = await getTrailModules(sc, T_A, { nowMs: NOW });
    assert.notEqual(r.refusal, null);
    assert.equal(r.momentumProvenance, null);

    const t = await trailTrending(sc, T_A, NOW);
    assert.notEqual(t.refusal, null);
    assert.equal(t.momentumProvenance, null);
  });
});

// ── DC-17 on the wire ───────────────────────────────────────────────────────

describe("DC-17 — the wire projection keeps THREE absences apart", () => {
  it("no record at all is `null`, never a record with a blank window", () => {
    assert.equal(toPublicProvenance(null), null);
  });

  it("a bounded window reports its span, and every one of the four facts survives", () => {
    const pub = toPublicProvenance({
      modelVersion: DISCOVERY_MODEL_VERSION,
      featureVersion: DISCOVERY_FEATURE_VERSION,
      window: { kind: "bounded", startMs: NOW - 1000, endMs: NOW },
      computedAt: NOW,
    })!;
    assert.equal(pub.spanMs, 1000);
    assert.equal(pub.window.startMs, NOW - 1000);
    assert.equal(pub.window.endMs, NOW);
    assert.equal(pub.modelVersion, DISCOVERY_MODEL_VERSION);
    assert.equal(pub.featureVersion, DISCOVERY_FEATURE_VERSION);
    assert.equal(pub.computedAt, NOW);
  });

  it("a window that admitted NOTHING is spanMs 0 — a measurement, not an absence", () => {
    const pub = toPublicProvenance({
      modelVersion: DISCOVERY_MODEL_VERSION,
      featureVersion: DISCOVERY_FEATURE_VERSION,
      window: { kind: "bounded", startMs: NOW, endMs: NOW },
      computedAt: NOW,
    })!;
    assert.equal(pub.spanMs, 0);
  });

  it("an UNBOUNDED start is spanMs null — `Number(null)` is 0 and would report it as empty", () => {
    const pub = toPublicProvenance({
      modelVersion: DISCOVERY_MODEL_VERSION,
      featureVersion: DISCOVERY_FEATURE_VERSION,
      window: { kind: "unbounded_start", startMs: null, endMs: NOW },
      computedAt: NOW,
    })!;
    assert.equal(
      pub.spanMs, null,
      "a corpus with no oldest event and a window that admitted nothing must not serialise alike",
    );
    assert.equal(pub.window.startMs, null);
  });
});

// ── DC-05 / §40.2 — the fabricated positive, at the BATCH scale ─────────────

describe("§11 — an unreadable `trail_reports` must not flatter the modifier the RANKER receives", () => {
  /**
   * A Trail whose other metrics are imperfect, so that admitting a perfect
   * `report_rate: 0` into the mean actually moves the scale. One contributor,
   * one place, two members: contributor_concentration and place_diversity are
   * both at their worst achievable value, which is what makes the difference
   * observable rather than rounded away.
   */
  const seed = () => ({
    trails: [trail(T_A)],
    trail_follows: [{ trail_id: T_A, user_id: USER }],
    content_trails: [
      member("m1"),
      member("m2", { source_id: PLACE_A, created_at: iso(40 * 86_400_000), confidence: 0.2 }),
    ],
  });

  it("an unreadable report count scales DIFFERENTLY from a table with no open reports", async () => {
    const clean = await loadViewerTrailModifier(
      db(seed()), USER, [PLACE_A], { nowMs: NOW },
    );
    const unread = await loadViewerTrailModifier(
      db(seed(), ["trail_reports"]), USER, [PLACE_A], { nowMs: NOW },
    );

    assert.equal(clean.refusal, null);
    assert.equal(unread.refusal, null);
    assert.ok(clean.trailAffinity[PLACE_A] > 0, "the clean case must produce a real affinity to compare against");
    assert.ok(unread.trailAffinity[PLACE_A] > 0, "a failed diagnostic must not erase the Trail");

    assert.notEqual(
      unread.trailAffinity[PLACE_A], clean.trailAffinity[PLACE_A],
      "a `trail_reports` outage must not be served as the claim `this Trail has no open reports` — "
      + "that claim raises the health multiplier and therefore served rank",
    );
  });

  it("an unreadable count does not flatter: it must not score ABOVE the no-reports case", async () => {
    const clean = await loadViewerTrailModifier(db(seed()), USER, [PLACE_A], { nowMs: NOW });
    const unread = await loadViewerTrailModifier(
      db(seed(), ["trail_reports"]), USER, [PLACE_A], { nowMs: NOW },
    );
    assert.ok(
      unread.trailAffinity[PLACE_A] <= clean.trailAffinity[PLACE_A],
      "an outage flattering exactly the Trails it could not read is §40.2's defect returning",
    );
  });

  it("an EMPTY `trail_reports` read is a measurement — the Trail is not marked unmeasured", async () => {
    // Same seed, reports readable and empty. The point is that the clean case
    // is a real path and not an artefact of the fake: it must differ from the
    // unread case in the direction health predicts, and it must not refuse.
    const r = await loadViewerTrailModifier(db(seed()), USER, [PLACE_A], { nowMs: NOW });
    assert.equal(r.refusal, null);
    assert.deepEqual(r.followedTrailIds, [T_A]);
  });

  it("an unreadable report count never turns into a REFUSAL — a diagnostic must not fail the read", async () => {
    const r = await loadViewerTrailModifier(
      db(seed(), ["trail_reports"]), USER, [PLACE_A], { nowMs: NOW },
    );
    assert.equal(r.refusal, null, "`trail_reports` is a health input, not the Trail itself");
    assert.deepEqual(r.followedTrailIds, [T_A]);
  });
});

// ── DC-17 at the URL — the projection must actually REACH a client ──────────
//
// A service that retains the record while the route drops it is §38.6's finding
// unchanged: the reader exists, the consumer does not. These go over loopback
// HTTP through the real router.

describe("DC-17 — `readingProvenance` reaches the wire at both Trail URLs", () => {
  it("GET /modules publishes the four facts and the span", async () => {
    servedDb({
      trails: [trail(T_A)],
      content_trails: [member("m1")],
      rank_events: Array.from({ length: 8 }, (_, i) => event(PLACE_A, 3_600_000 + i)),
    });
    const r = await get(`/v1/discovery/trails/${T_A}/modules`);
    assert.equal(r.status, 200);
    const p = r.body.readingProvenance;
    assert.ok(p, "the window behind `trending_now`'s order must not stop at the service");
    assert.equal(p.modelVersion, LOCAL_MOMENTUM_MODEL_VERSION);   // §68: the kernel's own, not the ranker's
    assert.equal(p.featureVersion, LOCAL_MOMENTUM_FEATURE_VERSION);
    assert.equal(typeof p.computedAt, "number");
    assert.equal(p.window.kind, "bounded");
    assert.equal(p.spanMs, MOMENTUM_BASELINE_WINDOW_MS);
  });

  it("GET /modules publishes null when no reading was taken", async () => {
    servedDb({
      trails: [trail(T_A)],
      content_trails: [member("m1", { source_type: "post", source_id: POST_A })],
    });
    const r = await get(`/v1/discovery/trails/${T_A}/modules`);
    assert.equal(r.status, 200);
    assert.equal(r.body.readingProvenance, null);
  });

  it("GET /trending publishes the window beside the boolean", async () => {
    servedDb({
      trails: [trail(T_A)],
      content_trails: [member("m1")],
      rank_events: Array.from({ length: 8 }, (_, i) => event(PLACE_A, 3_600_000 + i)),
    });
    const r = await get(`/v1/discovery/trails/${T_A}/trending`);
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.trending, "boolean");
    assert.ok(r.body.readingProvenance, "a boolean with no window names no corpus");
    assert.equal(r.body.readingProvenance.window.kind, "bounded");
  });

  it("GET /trending distinguishes `not trending` from `never measured`", async () => {
    servedDb({ trails: [trail(T_A)], content_trails: [] });
    const r = await get(`/v1/discovery/trails/${T_A}/trending`);
    assert.equal(r.status, 200);
    assert.equal(r.body.trending, false); // §64.13: DC-17's contract, kept by §61.17 — an EMPTY Trail (or one whose every member is withheld from this viewer) is a measured false; only a FAILED read is null
    assert.equal(
      r.body.readingProvenance, null,
      "`trending:false` with no provenance is the unmeasured case and must be visible as such",
    );
  });

  it("`11` §4 still holds: the new field adds NO number and no new occurrence of the word", async () => {
    // The route suite pins `/trending` with a blunt substring assertion — the
    // body must not contain "momentum" at all — and that is the reason the wire
    // field here is `readingProvenance` rather than `momentumProvenance`. Both
    // halves are re-asserted so the two names cannot drift back together.
    //
    // `/modules` is NOT held to the same substring rule, and the difference is
    // deliberate rather than an oversight: §8's `objective` vocabulary is
    // published on purpose and one of its five words IS "momentum". So the rule
    // there is the one `11` §4 actually states — no raw SCORE — checked as: the
    // only occurrences of the word are `objective` labels, and every number the
    // provenance adds is a timestamp or a window bound.
    servedDb({
      trails: [trail(T_A)],
      content_trails: [member("m1"), member("m2", { source_id: PLACE_B })],
      rank_events: Array.from({ length: 8 }, (_, i) => event(PLACE_A, 3_600_000 + i)),
    });

    const trending = await get(`/v1/discovery/trails/${T_A}/trending`);
    assert.equal(trending.status, 200);
    assert.ok(
      !JSON.stringify(trending.body).includes("momentum"),
      "`11` §4's tripwire on /trending must survive this field",
    );

    const modules = await get(`/v1/discovery/trails/${T_A}/modules`);
    assert.equal(modules.status, 200);
    const occurrences = JSON.stringify(modules.body).split("momentum").length - 1;
    const objectives = modules.body.modules.filter((m: any) => m.objective === "momentum").length;
    assert.equal(
      occurrences, objectives,
      "the only `momentum` on /modules is §8's published objective label — a score would add another",
    );
    // The provenance publishes four facts and none of them is a score.
    const p = modules.body.readingProvenance;
    assert.deepEqual(
      Object.keys(p).sort(),
      ["computedAt", "featureVersion", "modelVersion", "spanMs", "window"],
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2026-10-17 (wave 4) — the protected-zone rule on EVERY Trail momentum reading.
//
// The trend API's rule (lib/discoveryTrendProducerPrivacy, which
// loadLocalMomentum, the rebuild scheduler and the candidate retrievals apply):
// while ANY active protected zone exists no momentum is computed, and an
// unreadable zone policy is never "no zones". TrailService computed momentum
// over live rank_events — `trending_now` on both module paths, GET …/trending's
// order and boolean, and DV-25's Trail momentum in the ranker's modifier — with
// no zone read at all (wave-3 handback, "TrailService trending_now ... no zone
// guard").
//   TZ1–TZ3  getTrailModules' trending_now: active zone, unreadable policy, inactive zone
//   TZ4      the flag-on module path (trailModulesExplored)
//   TZ5–TZ6  trailTrending: no order, no boolean — unknown, never "not trending"
//   TZ7      loadViewerTrailModifier: Trail momentum withheld is "no information" (unscaled)
//   TZ8      the admin evidence names the reason
//   TZ9–TZ10 the wire
// Appended at the foot so no line above that a census cites moves.
// ═════════════════════════════════════════════════════════════════════════════
import { TRAIL_EXPLORATION_FLAG } from "../services/trails/trailExploration.js";
import { trailTrendEvidence } from "../services/trails/trailAdmin.js";

const ACTIVE_ZONE: Row = { id: "zone-1", active: true };
/** A Trail with one place member whose Discovery saves surge in the last hour, at `now`. */
const surging = (now: number, over: Record<string, Row[]> = {}): Record<string, Row[]> => ({
  trails: [trail(T_A)],
  content_trails: [member("m1")],
  rank_events: Array.from({ length: 8 }, (_, i) => ({
    id: `z-${i}`, item_id: PLACE_A, surface: "discovery", outcome: "save",
    served_at: new Date(now - 3_600_000 - i).toISOString(), outcome_at: new Date(now - 3_600_000 - i).toISOString(),
  })),
  ...over,
});
const trendingNow = (r: { modules: Array<{ key: string; items: unknown[] }> }) => r.modules.find((m) => m.key === "trending_now");

describe("2026-10-17 (wave 4) — no Trail momentum while a protected zone is active; an unreadable policy fails closed", () => {
  it("TZ1. getTrailModules: with an active zone trending_now is empty, no reading is published, and the reason is named", async () => {
    const open = await getTrailModules(db(surging(NOW)), T_A, { nowMs: NOW });
    assert.equal(open.refusal, null);
    assert.deepEqual(trendingNow(open)?.items.map((i: any) => i.sourceId), [PLACE_A], "control: with no zone the surging place is trending_now");
    assert.ok(open.momentumProvenance, "control: and a reading was taken");
    assert.equal((open as any).momentumWithheld, undefined, "control: nothing withheld");

    const r = await getTrailModules(db(surging(NOW, { protected_zones: [ACTIVE_ZONE] })), T_A, { nowMs: NOW });
    assert.equal(r.refusal, null, "a zone withholds a reading; it does not refuse the Trail");
    assert.deepEqual(trendingNow(r)?.items, [], "no momentum while a protected zone is active");
    assert.equal(r.momentumProvenance, null, "no reading entered the page, so none is published");
    assert.equal((r as any).momentumWithheld, "protected_zone_filter_required");
    assert.ok(r.modules.find((m) => m.key === "just_arrived")?.items.length, "the other modules are untouched");
  });

  it("TZ2. getTrailModules: an unreadable zone policy is never 'no zones' — trending_now is empty and the reason says unreadable", async () => {
    const r = await getTrailModules(db(surging(NOW), ["protected_zones"]), T_A, { nowMs: NOW });
    assert.equal(r.refusal, null);
    assert.deepEqual(trendingNow(r)?.items, []);
    assert.equal(r.momentumProvenance, null);
    assert.equal((r as any).momentumWithheld, "protected_zone_policy_unreadable");
  });

  it("TZ3. an INACTIVE zone is no zone: the reading stands", async () => {
    const r = await getTrailModules(db(surging(NOW, { protected_zones: [{ ...ACTIVE_ZONE, active: false }] })), T_A, { nowMs: NOW });
    assert.deepEqual(trendingNow(r)?.items.map((i: any) => i.sourceId), [PLACE_A]);
    assert.ok(r.momentumProvenance);
    assert.equal((r as any).momentumWithheld, undefined);
  });

  it("TZ4. the flag-on path (discovery_trail_exploration_enabled): the same rule, both ways", async () => {
    const flags = { feature_flags: [{ flag: TRAIL_EXPLORATION_FLAG, enabled: true }] };
    const open = await getTrailModules(db(surging(NOW, flags)), T_A, { nowMs: NOW });
    assert.ok(open.modules.some((m) => m.key === "hidden_gems"), "control: this IS the flag-on path");
    assert.deepEqual(trendingNow(open)?.items.map((i: any) => i.sourceId), [PLACE_A], "control: trending_now carries the surge");
    for (const [over, erroring, reason] of [
      [{ ...flags, protected_zones: [ACTIVE_ZONE] }, [], "protected_zone_filter_required"],
      [flags, ["protected_zones"], "protected_zone_policy_unreadable"],
    ] as const) {
      const r = await getTrailModules(db(surging(NOW, over), [...erroring]), T_A, { nowMs: NOW });
      assert.ok(r.modules.some((m) => m.key === "hidden_gems"), reason);
      assert.deepEqual(trendingNow(r)?.items, [], reason);
      assert.equal(r.momentumProvenance, null, reason);
      assert.equal((r as any).momentumWithheld, reason);
    }
  });

  it("TZ5. trailTrending with an active zone: no order, no boolean — unknown (momentumUnread), never a measured 'not trending'", async () => {
    const open = await trailTrending(db(surging(NOW)), T_A, NOW);
    assert.ok((open.momentum ?? 0) > 0, "control: the Trail is measured as trending with no zone");
    assert.deepEqual(open.items.map((i) => i.sourceId), [PLACE_A], "control: and the surging place is listed");

    const r = await trailTrending(db(surging(NOW, { protected_zones: [ACTIVE_ZONE] })), T_A, NOW);
    assert.equal(r.refusal, null);
    assert.equal(r.momentum, null, "no Trail momentum is computed");
    assert.equal(r.momentumUnread, true, "the route serves this as unknown (null), never as a measured false");
    assert.deepEqual(r.items, [], "no momentum-ordered list");
    assert.equal(r.momentumProvenance, null);
    assert.equal((r as any).momentumWithheld, "protected_zone_filter_required");
  });

  it("TZ6. trailTrending with an unreadable zone policy fails closed the same way", async () => {
    const r = await trailTrending(db(surging(NOW), ["protected_zones"]), T_A, NOW);
    assert.equal(r.momentum, null);
    assert.equal(r.momentumUnread, true);
    assert.deepEqual(r.items, []);
    assert.equal(r.momentumProvenance, null);
    assert.equal((r as any).momentumWithheld, "protected_zone_policy_unreadable");
    // An empty Trail is still a measured false: there is no reading to withhold.
    const empty = await trailTrending(db({ trails: [trail(T_A)], content_trails: [], protected_zones: [ACTIVE_ZONE] }), T_A, NOW);
    assert.equal(empty.momentum, null);
    assert.equal(empty.momentumUnread, undefined);
  });

  it("TZ7. loadViewerTrailModifier: with a zone active or unreadable, DV-25's Trail momentum is withheld — the affinity is the unscaled 'no information' one, not the measured one", async () => {
    // A followed Trail whose members saw NO events: measured-and-flat momentum
    // scales the affinity to the floor; no momentum information leaves it unscaled.
    const seed = (over: Record<string, Row[]> = {}) => ({ trails: [trail(T_A)], trail_follows: [{ trail_id: T_A, user_id: USER }], content_trails: [member("m1")], ...over });
    const measured = await loadViewerTrailModifier(db(seed()), USER, [PLACE_A], { nowMs: NOW });
    const unscaled = await loadViewerTrailModifier(db(seed(), ["rank_events"]), USER, [PLACE_A], { nowMs: NOW });
    assert.ok(measured.trailAffinity[PLACE_A]! > 0 && unscaled.trailAffinity[PLACE_A]! > 0);
    assert.notEqual(measured.trailAffinity[PLACE_A], unscaled.trailAffinity[PLACE_A], "control: the momentum reading moves the affinity");

    const zoned = await loadViewerTrailModifier(db(seed({ protected_zones: [ACTIVE_ZONE] })), USER, [PLACE_A], { nowMs: NOW });
    const unread = await loadViewerTrailModifier(db(seed(), ["protected_zones"]), USER, [PLACE_A], { nowMs: NOW });
    for (const r of [zoned, unread]) {
      assert.equal(r.refusal, null, "a withheld input never refuses the modifier");
      assert.deepEqual(r.followedTrailIds, [T_A]);
      assert.equal(r.trailAffinity[PLACE_A], unscaled.trailAffinity[PLACE_A], "no momentum entered the affinity");
    }
  });

  it("TZ8. the admin trend evidence names WHY the reading is absent", async () => {
    const r = await trailTrendEvidence(db(surging(NOW, { protected_zones: [ACTIVE_ZONE] })), T_A, NOW);
    assert.equal(r.ok, true);
    const v = (r as any).value;
    assert.equal(v.momentum, null);
    assert.equal(v.momentumUnread, true);
    assert.deepEqual(v.items, []);
    assert.equal(v.momentumWithheld, "protected_zone_filter_required");
    const open = await trailTrendEvidence(db(surging(NOW)), T_A, NOW);
    assert.equal((open as any).value.momentumWithheld, undefined, "control: nothing withheld with no zone");
  });

  it("TZ9. GET …/trending with an active zone serves trending: null and no list — and the tripwire on the word still holds", async () => {
    servedDb(surging(Date.now()));
    const open = await get(`/v1/discovery/trails/${T_A}/trending`);
    assert.equal(open.status, 200);
    assert.equal(open.body.trending, true, "control: the surge is served as trending with no zone");

    servedDb(surging(Date.now(), { protected_zones: [ACTIVE_ZONE] }));
    const r = await get(`/v1/discovery/trails/${T_A}/trending`);
    assert.equal(r.status, 200);
    assert.equal(r.body.trending, null, "withheld is unknown, never a measured false");
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.readingProvenance, null);
    assert.ok(!JSON.stringify(r.body).includes("momentum"), "`11` §4's tripwire on /trending");
  });

  it("TZ10. GET …/modules with an unreadable zone policy serves an empty trending_now and no reading", async () => {
    servedDb(surging(Date.now()), ["protected_zones"]);
    const r = await get(`/v1/discovery/trails/${T_A}/modules`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.modules.find((m: any) => m.key === "trending_now").items, []);
    assert.equal(r.body.readingProvenance, null);
  });
});
