/**
 * IG-06 Trail capture — reachable end-to-end, and its serve path.
 *
 * THE DEFECT (audit 2026-09-04). routes/intel.ts observationSchema had no
 * `captureSurface` field, so every observation reached IntelCaptureService as
 * 'quick_signal'; mapQuickSignal returned null for the two Trail contexts (exit,
 * movement); and the client Trail sheet (app/intel/trail.tsx) therefore got 400
 * invalid_payload on every submission. lib/trailFollowup's aggregation and AT-10
 * block filter had no production caller. No test imported routes/intel.ts.
 *
 * Proves, through the REAL router over loopback HTTP and the real service:
 *   • a going-next declaration {captureSurface:'trail', context:'movement'} is
 *     accepted, stored as experience.next_move on the trail surface with the
 *     2128 TTL (30 min), and still can never become a single-user claim;
 *   • the default surface is unchanged (no captureSurface ⇒ quick_signal);
 *   • surfaces still cannot emit each other's claims;
 *   • intel_trail_followup OFF withholds the trail write (nothing stored), and
 *     the D4 consent gate still applies on the trail surface;
 *   • the §6 exit prompt maps to experience.exit_reason but is NOT contracted
 *     (no §4 row, no TTL) — refused, never silently stored without expiry;
 *   • lib/trailServe reads through the flag, the AT-10 block filter and the
 *     aggregate, fail-closed at every step, and exposes no actor identity;
 *   • the internal cohort read route is admin-only and flag-gated.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import intelRouter from "../routes/intel.js";
import { proposeClaim } from "../services/intel/IntelCaptureService.js";
import { mapQuickSignal, PHASE1_CAPTURE_CLAIM_TYPES } from "../lib/quickSignal.js";
import { PHASE1_TRAIL_CAPTURE_CLAIM_TYPES, mapTrailSignal, MOVEMENT_PRIVACY_V1 } from "../lib/trailFollowup.js";
import { CLAIM_TYPES, PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import {
  readTrailMovement, cohortFloorMet, TRAIL_SIGNAL_MAX_AGE_MINUTES, TRAIL_COHORT_FLOOR,
} from "../lib/trailServe.js";
import { INTEL_FLAG_DEPENDENCIES, type IntelFlag } from "../lib/intelContracts.js";

/**
 * Flags for a fixture, DERIVED from the §26 dependency graph (a flag may only be
 * honoured when everything it depends on is also on). Hard-coding the set would
 * turn every "the write lands" assertion vacuous the moment the chain grows: the
 * fixture would stop clearing the gate and the test would pass on the refusal.
 */
function chainOn(flag: IntelFlag): Record<string, boolean> {
  const out: Record<string, boolean> = { [flag]: true };
  const frontier = [...INTEL_FLAG_DEPENDENCIES[flag]];
  while (frontier.length) {
    const next = frontier.pop()!;
    if (next in out) continue;
    out[next] = true;
    frontier.push(...INTEL_FLAG_DEPENDENCIES[next]);
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ADMIN = "11111111-1111-4111-8111-11111111aaaa";
const VIEWER = "11111111-1111-4111-8111-11111111bbbb";
const A = "11111111-1111-4111-8111-1111111111a1";
const B = "11111111-1111-4111-8111-1111111111b2";
const C = "11111111-1111-4111-8111-1111111111c3";
const D = "11111111-1111-4111-8111-1111111111d4";
const PLACE = "22222222-2222-4222-8222-222222222222";
const PLACE_2 = "22222222-2222-4222-8222-222222222223";
/** An origin with no observations at all — "nothing here", to contrast with "withheld". */
const PLACE_3 = "22222222-2222-4222-8222-222222222224";
const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const OBSERVED = new Date(NOW.getTime() - 5 * 60_000).toISOString();
const NEXT_MOVE_TTL_MS = 1800 * 1000;

// ── Fake supabase client ──────────────────────────────────────────────────────
// Generic table store with the filter verbs every helper on these paths uses
// (eq / in / is / lte / gte / or). Unknown tables answer empty, so a query the
// route did not anticipate cannot accidentally be answered "correctly".
// `_reads` records every table touched — the fail-closed tests assert on it.
type Row = Record<string, any>;
interface FakeOpts {
  flags: Record<string, boolean>;
  places?: string[];
  /** actor -> consent state. Absent actor = NO consent row (fail-closed). */
  consent?: Record<string, boolean | "withdrawn">;
  /** user id -> profile fields (role, account_status). The bearer token IS the user id. */
  profiles?: Record<string, Row>;
  blocks?: Row[];
  blocksError?: boolean;
  observations?: Row[];
}

function makeDb(opts: FakeOpts) {
  const tables: Record<string, Row[]> = {
    feature_flags: Object.entries(opts.flags).map(([flag, enabled]) => ({ flag, enabled })),
    places: (opts.places ?? []).map((id) => ({ id })),
    intel_contribution_consent: Object.entries(opts.consent ?? {}).map(([user_id, state]) => ({
      user_id, enabled: state !== false, withdrawn_at: state === "withdrawn" ? NOW_ISO : null,
    })),
    profiles: Object.entries(opts.profiles ?? {}).map(([id, r]) => ({ id, account_status: "active", role: "user", ...r })),
    blocks: opts.blocks ?? [],
    intel_observations: opts.observations ?? [],
    intel_claims: [],
    intel_confirmations: [],
  };
  const reads: string[] = [];
  let seq = 0;

  function from(table: string) {
    reads.push(table);
    let op: "select" | "insert" | "insert_select" | "update" | "update_select" = "select";
    let payload: any = null;
    const filters: Array<{ col: string; val: any; kind: string }> = [];
    let orClause: string | null = null;

    const orMatch = (row: Row) =>
      orClause === null ||
      orClause.split(",").some((part) => {
        const [col, , ...rest] = part.split(".");
        return row[col] === rest.join(".");
      });
    const match = (row: Row) =>
      orMatch(row) &&
      filters.every((f) => {
        const cell = row[f.col];
        switch (f.kind) {
          case "in": return (f.val as any[]).includes(cell);
          case "is": return (cell ?? null) === f.val;
          case "lte": return String(cell ?? "") <= String(f.val);
          case "gte": return String(cell ?? "") >= String(f.val);
          default: return cell === f.val;
        }
      });

    function run(): { data: any; error: any } {
      if (table === "blocks" && opts.blocksError) return { data: null, error: { message: "blocks unavailable" } };
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        const row = { id: `row-${++seq}`, schema_version: 1, created_at: NOW_ISO, ...payload };
        if (table === "intel_observations" && store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key))
          return { data: null, error: { code: "23505", message: "duplicate observation" } };
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      if (op === "update" || op === "update_select") {
        const updated: Row[] = [];
        for (const r of store) if (match(r)) { Object.assign(r, payload); updated.push(r); }
        return { data: op === "update_select" ? updated : null, error: null };
      }
      return { data: store.filter(match), error: null };
    }
    const one = () => {
      const r = run();
      return Promise.resolve(Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r);
    };

    const b: any = {
      select() { op = op === "insert" ? "insert_select" : op === "update" ? "update_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(patch: any) { op = "update"; payload = patch; return b; },
      eq(c: string, v: any) { filters.push({ col: c, val: v, kind: "eq" }); return b; },
      in(c: string, v: any[]) { filters.push({ col: c, val: v, kind: "in" }); return b; },
      is(c: string, v: any) { filters.push({ col: c, val: v, kind: "is" }); return b; },
      lte(c: string, v: any) { filters.push({ col: c, val: v, kind: "lte" }); return b; },
      gte(c: string, v: any) { filters.push({ col: c, val: v, kind: "gte" }); return b; },
      or(clause: string) { orClause = clause; return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle: one,
      single: one,
      then(resolve: (r: any) => any, reject?: (e: any) => any) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return b;
  }

  const auth = {
    async getUser(token: string) {
      return tables.profiles.some((p) => p.id === token)
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  return { from, auth, _tables: tables, _reads: reads };
}

// ── Loopback HTTP harness over the REAL router ────────────────────────────────
const app = express();
app.use(express.json());
app.use(intelRouter);
const server = http.createServer(app);
let base = "";

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });

async function post(path: string, body: unknown, as = ACTOR, key = `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${as}`, "idempotency-key": key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
async function get(path: string, as: string) {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${as}` } });
  return { status: res.status, body: (await res.json()) as any };
}

const bothOn = chainOn("intel_trail_followup");
const captureDb = (flags: Record<string, boolean>, over: Partial<FakeOpts> = {}) =>
  makeDb({ flags, places: [PLACE], consent: { [ACTOR]: true }, profiles: { [ACTOR]: {} }, ...over });

const trailBody = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE, observedAt: OBSERVED, captureSurface: "trail", context: "movement", option: "Shoreditch", ...over,
});

// ── Contract pins ─────────────────────────────────────────────────────────────
describe("IG-06 — the Trail contract the fix relies on (§4 / §29 / 2128)", () => {
  it("the trail surface stores exactly experience.next_move (§29 'input capture'), with the 2128 TTL row", () => {
    assert.deepEqual([...PHASE1_TRAIL_CAPTURE_CLAIM_TYPES], ["experience.next_move"]);
    const spec = CLAIM_TYPES.find((c) => c.claimType === "experience.next_move");
    assert.ok(spec, "next_move must be a registered claim type");
    assert.equal(spec!.ttlSeconds, 1800, "§4: 30 min");
    const migration = readFileSync(join(HERE, "../migrations/2128_intel_contracts_seed.sql"), "utf8");
    assert.ok(migration.includes("('experience.next_move', 1800,"), "2128 seeds the next_move freshness policy at 1800 s");
  });

  it("experience.exit_reason is mapped vocabulary but NOT a contracted claim — no registry row, no surface", () => {
    assert.equal(CLAIM_TYPES.some((c) => c.claimType === "experience.exit_reason"), false, "not in the §4 registry / no TTL");
    assert.equal((PHASE1_TRAIL_CAPTURE_CLAIM_TYPES as readonly string[]).includes("experience.exit_reason"), false);
    assert.equal(PHASE1_CAPTURE_CLAIM_TYPES.includes("experience.exit_reason"), false);
  });

  it("next_move is NOT on the quick_signal list — §29 capture is realised on the Trail surface, not by widening quick_signal", () => {
    assert.equal(PHASE1_CAPTURE_CLAIM_TYPES.includes("experience.next_move"), false);
  });

  it("mapQuickSignal now answers the two Trail contexts through the ONE trail mapping", () => {
    assert.deepEqual(mapQuickSignal("movement", "Shoreditch"), { claimType: "experience.next_move", value: { destinationArea: "Shoreditch" } });
    assert.deepEqual(mapQuickSignal("movement", "Shoreditch"), mapTrailSignal("movement", "Shoreditch"));
    assert.deepEqual(mapQuickSignal("exit", "too crowded"), { claimType: "experience.exit_reason", value: { reason: "too_crowded" } });
    assert.equal(mapQuickSignal("movement", "   "), null, "blank destination fails closed");
    assert.equal(mapQuickSignal("movement", "x".repeat(121)), null, "over-long destination fails closed");
    assert.equal(mapQuickSignal("exit", "made up"), null);
    // The Quick Signal contexts are untouched.
    assert.deepEqual(mapQuickSignal("arrival", "busy"), { claimType: "crowd.level", value: { level: "busy" } });
    assert.deepEqual(mapQuickSignal("entrance", "<10"), { claimType: "queue.wait", value: { minMinutes: 0, maxMinutes: 10 } });
  });
});

// ── The HTTP defect ───────────────────────────────────────────────────────────
describe("IG-06 — POST /v1/intel/observations reaches the trail surface", () => {
  it("accepts a going-next declaration on captureSurface:'trail' and stores experience.next_move with the 30-min TTL", async () => {
    const db = captureDb(bothOn);
    _setTestClient(db, true);
    const r = await post("/v1/intel/observations", trailBody(), ACTOR, "trail-http-1");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.observation.claimType, "experience.next_move");
    assert.deepEqual(r.body.observation.value, { destinationArea: "Shoreditch" });
    assert.equal(r.body.observation.visibility, "private", "a Trail declaration is private by default");
    assert.equal(r.body.deduped, false);

    const stored = db._tables.intel_observations;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].capture_surface, "trail");
    assert.equal(stored[0].actor_id, ACTOR, "actor comes from the session, never the body");
    assert.equal(Date.parse(stored[0].expires_at) - Date.parse(stored[0].observed_at), NEXT_MOVE_TTL_MS, "expiry derives from the 2128 TTL");
    assert.equal(stored[0].group_key, null, "no group key is derived for the trail surface (independence stays uncertified)");
  });

  it("the stored next_move is a candidate for AGGREGATION only — it can never be minted as a single-user claim", async () => {
    const db = captureDb(bothOn);
    _setTestClient(db, true);
    const r = await post("/v1/intel/observations", trailBody(), ACTOR, "trail-http-2");
    assert.equal(r.status, 201);
    const proposed = await proposeClaim(db as any, db._tables.intel_observations[0]);
    assert.equal(proposed.ok, false);
    assert.equal(proposed.reason, "must_aggregate");
    assert.equal(db._tables.intel_claims.length, 0);
  });

  it("is idempotent over HTTP — a replayed Idempotency-Key returns the stored row, no duplicate", async () => {
    const db = captureDb(bothOn);
    _setTestClient(db, true);
    const first = await post("/v1/intel/observations", trailBody(), ACTOR, "trail-http-replay");
    const again = await post("/v1/intel/observations", trailBody(), ACTOR, "trail-http-replay");
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.deduped, true);
    assert.equal(db._tables.intel_observations.length, 1);
  });

  it("intel_trail_followup OFF withholds the trail write even with quick_signal ON — nothing stored", async () => {
    const db = captureDb({ intel_capture_quick_signal: true, intel_trail_followup: false });
    _setTestClient(db, true);
    const r = await post("/v1/intel/observations", trailBody(), ACTOR, "trail-http-off");
    assert.equal(r.body.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("the §26 chain is enforced over HTTP: the trail flag alone is not enough to store a declaration", async () => {
    // The surface's own flag is ON; every flag it DEPENDS on is off. §26:
    // "a flag may only be honoured when everything it depends on is also on".
    const deps = INTEL_FLAG_DEPENDENCIES.intel_trail_followup;
    assert.ok(deps.length > 0, "the trail flag must declare a dependency for this test to mean anything");
    const flags: Record<string, boolean> = { intel_trail_followup: true };
    for (const d of deps) flags[d] = false;
    const db = captureDb(flags);
    _setTestClient(db, true);
    const r = await post("/v1/intel/observations", trailBody(), ACTOR, "trail-http-chain");
    assert.equal(r.body.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("the D4 consent gate applies on the trail surface too — no consent row → 403, nothing stored", async () => {
    const db = captureDb(bothOn, { consent: {} });
    _setTestClient(db, true);
    const r = await post("/v1/intel/observations", trailBody(), ACTOR, "trail-http-consent");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("the default surface is unchanged: no captureSurface ⇒ quick_signal, a Quick Signal still lands as before", async () => {
    const db = captureDb(bothOn);
    _setTestClient(db, true);
    const r = await post("/v1/intel/observations", { subjectId: PLACE, observedAt: OBSERVED, context: "arrival", option: "busy" }, ACTOR, "qs-http-1");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.observation.claimType, "crowd.level");
    assert.equal(db._tables.intel_observations[0].capture_surface, "quick_signal");
  });

  it("surfaces still cannot emit each other's claims — a movement context without captureSurface:'trail' is refused", async () => {
    const db = captureDb(bothOn);
    _setTestClient(db, true);
    const asQuick = await post("/v1/intel/observations", trailBody({ captureSurface: undefined }), ACTOR, "iso-1");
    assert.equal(asQuick.status, 400);
    assert.equal(asQuick.body.error, "invalid_payload");
    assert.match(String(asQuick.body.message), /quick_signal capture surface/);

    const asTrail = await post("/v1/intel/observations", trailBody({ context: "arrival", option: "busy" }), ACTOR, "iso-2");
    assert.equal(asTrail.status, 400);
    assert.match(String(asTrail.body.message), /crowd\.level is not a contracted claim on the trail capture surface/);
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("the §6 exit prompt on the trail surface is refused as an uncontracted claim — never stored without a TTL", async () => {
    const db = captureDb(bothOn);
    _setTestClient(db, true);
    const r = await post("/v1/intel/observations", trailBody({ context: "exit", option: "too crowded" }), ACTOR, "exit-1");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    assert.match(String(r.body.message), /experience\.exit_reason is not a contracted claim/);
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("rejects an unknown captureSurface at the schema", async () => {
    const db = captureDb(bothOn);
    _setTestClient(db, true);
    const r = await post("/v1/intel/observations", trailBody({ captureSurface: "moment" }), ACTOR, "bad-surface");
    assert.equal(r.status, 400);
    assert.equal(db._tables.intel_observations.length, 0);
  });
});

// ── Serve path: lib/trailServe ────────────────────────────────────────────────
const nextMoveRow = (actor: string, over: Row = {}): Row => ({
  actor_id: actor,
  subject_id: PLACE,
  claim_type: "experience.next_move",
  moderation_state: "pending",
  value: { destinationArea: "soho" },
  group_key: `group-${actor}`,
  observed_at: OBSERVED,
  expires_at: new Date(Date.parse(OBSERVED) + NEXT_MOVE_TTL_MS).toISOString(),
  ...over,
});
// The dependency chain is always on unless a case overrides it explicitly, so a
// case that flips `intel_trail_followup` is testing that flag and nothing else.
const serveDb = (flags: Record<string, boolean>, over: Partial<FakeOpts> = {}) =>
  makeDb({ flags: { ...chainOn("intel_trail_followup"), ...flags }, consent: { [A]: true, [B]: true, [C]: true }, ...over });

// ── §13 cohort-floor fixtures ─────────────────────────────────────────────────
/**
 * Cohorts are SIZED FROM THE FLOOR, never from the literal 15. The serve path
 * now filters on the floor instead of labelling it, so a fixture that hard-coded
 * the size would stop clearing (or start clearing) the moment the shared
 * PRIVACY_THRESHOLD_V1 moved, and every "the bucket is served" assertion below
 * would go vacuous without a single test turning red.
 */
const cohortActor = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
/** `n` actors, each in a party of its own: groups = n, maxSingleGroupShare = 1/n. */
const soloPartyRows = (n: number, over: Row = {}, idOffset = 0): Row[] =>
  Array.from({ length: n }, (_, i) => nextMoveRow(cohortActor(idOffset + i), over));
const consentFor = (rows: Row[], extra: Record<string, boolean | "withdrawn"> = {}) => {
  const out: Record<string, boolean | "withdrawn"> = { ...extra };
  for (const r of rows) if (!(r.actor_id in out)) out[r.actor_id] = true;
  return out;
};
/**
 * The smallest cohort that clears every rule of the floor at once: minUniqueActors
 * people in minUniqueActors independent parties, so groups clears too and the
 * dominant share is 1/minUniqueActors — comfortably under maxSingleGroupShare for
 * any sane floor. Asserted, not assumed, in the guard test below.
 */
const CLEARING_ROWS = soloPartyRows(MOVEMENT_PRIVACY_V1.minUniqueActors);
/** One person short of the actor floor — everything else about it is identical. */
const SUB_FLOOR_ROWS = soloPartyRows(MOVEMENT_PRIVACY_V1.minUniqueActors - 1);

describe("IG-06 — lib/trailServe is the production caller of the aggregate + AT-10 filter", () => {
  it("refuses with flag_off and reads NOTHING when intel_trail_followup is off", async () => {
    const db = serveDb({ intel_trail_followup: false }, { observations: [nextMoveRow(A), nextMoveRow(B)] });
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.refusal, "flag_off");
    assert.deepEqual(read.buckets, []);
    assert.ok(!db._reads.includes("intel_observations"), "no observation read behind an off flag");
    assert.ok(!db._reads.includes("blocks"));
  });

  it("refuses with flag_off — and reads NOTHING — when a DEPENDENCY of the trail flag is off (§26 chain)", async () => {
    const deps = INTEL_FLAG_DEPENDENCIES.intel_trail_followup;
    assert.ok(deps.length > 0, "the trail flag must declare a dependency for this test to mean anything");
    const flags: Record<string, boolean> = { intel_trail_followup: true };
    for (const d of deps) flags[d] = false;
    const db = serveDb(flags, { observations: [nextMoveRow(A), nextMoveRow(B)] });
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.refusal, "flag_off");
    assert.deepEqual(read.buckets, []);
    assert.ok(!db._reads.includes("intel_observations"), "no observation read behind an unhonourable flag");
    assert.ok(!db._reads.includes("blocks"));
  });

  it("refuses with blocks_unreadable — and reads no observations — when the blocked set cannot be read (AT-10 cannot be honoured)", async () => {
    const db = serveDb({ intel_trail_followup: true }, { blocksError: true, observations: [nextMoveRow(A)] });
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.refusal, "blocks_unreadable");
    assert.deepEqual(read.buckets, []);
    assert.ok(!db._reads.includes("intel_observations"));
  });

  it("fails closed without a client or without a viewer identity", async () => {
    assert.equal((await readTrailMovement(null, VIEWER)).refusal, "no_service_client");
    const db = serveDb({ intel_trail_followup: true });
    assert.equal((await readTrailMovement(db as any, "")).refusal, "blocks_unreadable");
  });

  it("the clearing fixture really does clear every rule of the floor (guards every assertion below)", () => {
    const rows = CLEARING_ROWS;
    assert.equal(rows.length, MOVEMENT_PRIVACY_V1.minUniqueActors);
    assert.ok(rows.length >= MOVEMENT_PRIVACY_V1.minGroups, "one party each, so groups = actors");
    assert.ok(1 / rows.length <= MOVEMENT_PRIVACY_V1.maxSingleGroupShare, "dominant share is 1/n");
    assert.equal(new Set(rows.map((r) => r.group_key)).size, rows.length, "each actor is its own party");
  });

  it("AT-10: a blocked actor's Trail row is hidden from the viewer, the rest aggregate — and no actor id leaves", async () => {
    // A cohort that clears the floor PLUS one blocked actor in the same bucket.
    // Without the filter the bucket would count one more person; the assertion
    // is on the exact size, so the filter cannot be silently skipped.
    const rows = [...CLEARING_ROWS, nextMoveRow(A)];
    const db = serveDb(
      { intel_trail_followup: true },
      { blocks: [{ blocker_id: VIEWER, blocked_id: A }], consent: consentFor(rows), observations: rows },
    );
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.refusal, null);
    assert.equal(read.buckets.length, 1);
    const [bucket] = read.buckets;
    assert.equal(bucket.originId, PLACE);
    assert.equal(bucket.destinationArea, "soho");
    assert.equal(bucket.uniqueActors, MOVEMENT_PRIVACY_V1.minUniqueActors, "the blocked actor is not counted");
    assert.equal(bucket.groups, MOVEMENT_PRIVACY_V1.minUniqueActors);
    assert.equal(bucket.ungroupedPresent, false);
    assert.equal(bucket.cohortFloorMet, true);
    const wire = JSON.stringify(read);
    for (const id of [A, B, C, VIEWER, ...CLEARING_ROWS.map((r) => r.actor_id)])
      assert.ok(!wire.includes(id), `actor identity must not leave the read: ${id}`);
    // AT-10 hides a blocked person's CONTRIBUTION. A count of what was hidden
    // would announce that contribution exists — to a viewer who already knows
    // exactly who their block counterparties are. It must not be on the wire.
    assert.ok(!Object.hasOwn(read, "hiddenByBlock"), "no hidden-row counter");
    assert.ok(!wire.includes("hiddenByBlock"));
  });

  it("the block is bidirectional — an actor who blocked the viewer is hidden too", async () => {
    const rows = [...CLEARING_ROWS, nextMoveRow(B)];
    const db = serveDb(
      { intel_trail_followup: true },
      { blocks: [{ blocker_id: B, blocked_id: VIEWER }], consent: consentFor(rows), observations: rows },
    );
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.buckets.length, 1);
    assert.equal(read.buckets[0].uniqueActors, MOVEMENT_PRIVACY_V1.minUniqueActors);
  });

  it("excludes expired and withdrawn-consent rows and drops ungrouped rows from the cohort (fail-closed independence)", async () => {
    const rows = [
      ...CLEARING_ROWS,
      nextMoveRow(B),                                   // consent withdrawn → ineligible
      nextMoveRow(C, { group_key: null }),              // no certified group → excluded
      nextMoveRow(D, { expires_at: new Date(NOW.getTime() - 1000).toISOString() }), // expired → gone
    ];
    const db = serveDb(
      { intel_trail_followup: true },
      { consent: consentFor(rows, { [B]: "withdrawn", [C]: true }), observations: rows },
    );
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.refusal, null);
    assert.equal(read.anyDroppedIneligible, true, "withdrawn consent");
    assert.equal(read.buckets.length, 1);
    assert.equal(read.buckets[0].uniqueActors, MOVEMENT_PRIVACY_V1.minUniqueActors, "only the consented, grouped cohort counts");
    assert.equal(read.buckets[0].ungroupedPresent, true, "C had no group key");
    // `droppedUngrouped` is a count over rows the independence gate REMOVED.
    // Only its existence bit may leave; the magnitude never does.
    assert.ok(!Object.hasOwn(read.buckets[0], "droppedUngrouped"));
    assert.ok(!JSON.stringify(read).includes("droppedUngrouped"));
  });

  it("empties the cohort (rather than refusing) when the consent read fails", async () => {
    const db = serveDb({ intel_trail_followup: true }, { observations: [nextMoveRow(A)] });
    const realFrom = db.from;
    (db as any).from = (table: string) =>
      table === "intel_contribution_consent"
        ? { select: () => ({ in: () => ({ eq: () => ({ is: () => Promise.resolve({ data: null, error: { message: "consent down" } }) }) }) }) }
        : realFrom(table);
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.refusal, null);
    assert.deepEqual(read.buckets, []);
    assert.equal(read.anyDroppedIneligible, true);
    // Nothing reached aggregation, so nothing was withheld BY THE FLOOR. The two
    // reasons stay distinct: `anyDroppedIneligible` is the consent pipeline,
    // `withheldBelowFloor` is the §13 gate.
    assert.equal(read.withheldBelowFloor, false);
  });

  it("scopes to an origin place when asked, and the freshness window is the next_move TTL", async () => {
    const rows = [
      ...CLEARING_ROWS,
      ...soloPartyRows(MOVEMENT_PRIVACY_V1.minUniqueActors, { subject_id: PLACE_2 }, 1000),
    ];
    const db = serveDb({ intel_trail_followup: true }, { consent: consentFor(rows), observations: rows });
    const scoped = await readTrailMovement(db as any, VIEWER, { now: NOW, originId: PLACE });
    assert.equal(scoped.buckets.length, 1);
    assert.equal(scoped.buckets[0].originId, PLACE);
    const all = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(all.buckets.length, 2);
    assert.equal(TRAIL_SIGNAL_MAX_AGE_MINUTES, 30);
  });

  it("cohortFloorMet reports the §13 counts and nothing else", () => {
    const at = { originId: PLACE, destinationArea: "soho", bucketStart: NOW_ISO, droppedUngrouped: 0,
      uniqueActors: MOVEMENT_PRIVACY_V1.minUniqueActors, groups: MOVEMENT_PRIVACY_V1.minGroups, maxSingleGroupShare: MOVEMENT_PRIVACY_V1.maxSingleGroupShare };
    assert.equal(cohortFloorMet(at), true);
    assert.equal(cohortFloorMet({ ...at, uniqueActors: at.uniqueActors - 1 }), false);
    assert.equal(cohortFloorMet({ ...at, groups: at.groups - 1 }), false);
    assert.equal(cohortFloorMet({ ...at, maxSingleGroupShare: at.maxSingleGroupShare + 0.01 }), false);
  });
});

// ── The §13 floor is a FILTER, not a label ────────────────────────────────────
/**
 * THE DEFECT (privacy audit 2026-09-05, HIGH). readTrailMovement built every
 * bucket as `{ ...aggregate, cohortFloorMet }` and served the lot. A bucket
 * standing on ONE person went on the wire fully populated — uniqueActors 1,
 * groups 1, maxSingleGroupShare 1, plus the (origin, destinationArea,
 * bucketStart) tuple naming exactly where that person said they were going —
 * merely FLAGGED `cohortFloorMet: false`. requireAdmin did not save it:
 * "internal" is an access control, not an anonymity guarantee, and an admin
 * could difference an unscoped read against a scoped one to recover the same
 * number arithmetically.
 *
 * The rule these tests hold the module to: it is not enough for the objects to
 * be gated. Any count, share, tuple, timestamp or label COMPUTED OVER ungated
 * rows is a disclosure, even when the rows themselves are never served.
 */
const KEEP_OUT_KEYS = ["uniqueActors", "groups", "maxSingleGroupShare", "originId", "destinationArea", "bucketStart"];

/** Every string that appears anywhere in the JSON of a read, flattened. */
const wireOf = (read: unknown) => JSON.stringify(read);
/**
 * The same, minus `cohortFloor` — the CONSTANT policy record, which names the
 * rules (and so contains the words "minUniqueActors", "maxSingleGroupShare"…)
 * without measuring anything. It is identical for every caller at every scope,
 * so it is excluded from the keep-out scan rather than exempting the words
 * themselves, which would blind the scan to a real measurement of the same name.
 */
const dataWireOf = (read: Record<string, unknown>) => {
  const { cohortFloor, ...rest } = read;
  assert.deepEqual(cohortFloor, TRAIL_COHORT_FLOOR, "cohortFloor must be the constant, never a measurement");
  return JSON.stringify(rest);
};

describe("IG-06 privacy — a sub-floor cohort yields no readable count", () => {
  const readOf = async (rows: Row[], opts: Parameters<typeof readTrailMovement>[2] = {}) => {
    const db = serveDb({ intel_trail_followup: true }, { consent: consentFor(rows), observations: rows });
    return readTrailMovement(db as any, VIEWER, { now: NOW, ...opts });
  };

  it("a cohort of ONE is not served at all — no bucket, no counts, not even its tuple", async () => {
    const read = await readOf(soloPartyRows(1));
    assert.equal(read.refusal, null, "this is a successful read, not a refusal");
    assert.deepEqual(read.buckets, [], "no bucket may stand on one person");
    const wire = dataWireOf({ ...read });
    for (const k of KEEP_OUT_KEYS)
      assert.ok(!wire.includes(k), `a sub-floor read must not carry ${k}: ${wire}`);
    assert.ok(!wire.includes("soho"), "not even the destination area");
    assert.ok(!wire.includes(PLACE), "not even the origin");
  });

  it("one person short of the floor is still withheld — the boundary is >=, not >", async () => {
    const below = await readOf(SUB_FLOOR_ROWS);
    assert.deepEqual(below.buckets, []);
    assert.equal(below.withheldBelowFloor, true);
    const at = await readOf(CLEARING_ROWS);
    assert.equal(at.buckets.length, 1, "exactly at the floor, the bucket is served");
    assert.equal(at.withheldBelowFloor, false);
  });

  it("each of the three floor rules withholds on its own, not just the actor count", async () => {
    const n = MOVEMENT_PRIVACY_V1.minUniqueActors;
    // Enough people, but ONE party: independence fails (and so does the share).
    const oneParty = soloPartyRows(n).map((r) => ({ ...r, group_key: "one-party" }));
    assert.deepEqual((await readOf(oneParty)).buckets, [], "one party is not independent");
    assert.equal((await readOf(oneParty)).withheldBelowFloor, true);

    // Enough people AND enough parties, but one party dominates the cohort.
    // Sized from the floor: the dominant party takes more than maxSingleGroupShare.
    const dominant = Math.floor(n * MOVEMENT_PRIVACY_V1.maxSingleGroupShare) + 1;
    assert.ok(dominant / n > MOVEMENT_PRIVACY_V1.maxSingleGroupShare, "the fixture really does exceed the share");
    assert.ok(n - dominant + 1 >= MOVEMENT_PRIVACY_V1.minGroups, "…while still clearing the group floor");
    const lopsided = soloPartyRows(n).map((r, i) => (i < dominant ? { ...r, group_key: "dominant" } : r));
    const read = await readOf(lopsided);
    assert.deepEqual(read.buckets, [], "a dominant party is not a cohort");
    assert.equal(read.withheldBelowFloor, true);
  });

  it("the refusal stays VISIBLE — withheld is distinguishable from empty", async () => {
    const withheld = await readOf(soloPartyRows(1));
    const empty = await readOf([]);
    assert.deepEqual(withheld.buckets, []);
    assert.deepEqual(empty.buckets, []);
    assert.notEqual(
      withheld.withheldBelowFloor, empty.withheldBelowFloor,
      "'we could not look' must not read the same as 'nothing here'",
    );
    assert.equal(withheld.withheldBelowFloor, true);
    assert.equal(empty.withheldBelowFloor, false);
    // …and the floor itself is published so an empty result is interpretable.
    assert.deepEqual(withheld.cohortFloor, TRAIL_COHORT_FLOOR);
    assert.deepEqual(empty.cohortFloor, TRAIL_COHORT_FLOOR);
  });

  it("the withheld signal is an EXISTENCE BIT, never a magnitude — 1 and 14 read identically", async () => {
    // The differencing attack this closes is arithmetic, so the proof is
    // byte-equality: if any field anywhere in the response varied with the size
    // of a withheld cohort, these two responses could not be identical.
    const one = await readOf(soloPartyRows(1));
    const many = await readOf(SUB_FLOOR_ROWS);
    assert.ok(SUB_FLOOR_ROWS.length > 1, "the two fixtures must actually differ in size");
    assert.equal(wireOf(one), wireOf(many));
    assert.equal(typeof one.withheldBelowFloor, "boolean");
  });

  it("a served bucket carries no measurement taken over rows the gate removed", async () => {
    const rows = [...CLEARING_ROWS, nextMoveRow(A, { group_key: null }), nextMoveRow(B, { group_key: null })];
    const db = serveDb({ intel_trail_followup: true }, { consent: consentFor(rows), observations: rows });
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.buckets.length, 1);
    const [bucket] = read.buckets;
    assert.equal(bucket.uniqueActors, MOVEMENT_PRIVACY_V1.minUniqueActors, "the ungrouped rows are not in the cohort");
    assert.equal(bucket.ungroupedPresent, true, "…but their existence is not silently hidden either");
    // TWO ungrouped rows and ONE bit: the projection is enumerated, so the
    // aggregate's `droppedUngrouped` count cannot ride along on a spread.
    assert.ok(!wireOf(read).includes("droppedUngrouped"));
    const oneUngrouped = [...CLEARING_ROWS, nextMoveRow(A, { group_key: null })];
    const db2 = serveDb(
      { intel_trail_followup: true },
      { consent: consentFor(oneUngrouped), observations: oneUngrouped },
    );
    const read2 = await readTrailMovement(db2 as any, VIEWER, { now: NOW });
    assert.equal(wireOf(read.buckets), wireOf(read2.buckets), "one dropped row reads the same as two");
  });
});

describe("IG-06 privacy — overlapping reads cannot be differenced into a cohort size", () => {
  /**
   * PLACE holds a cohort that clears the floor; PLACE_2 holds a sub-floor one.
   * An admin may scope by origin, so they get three views of the same data and
   * may subtract them from one another however they like.
   */
  const worldOf = (subFloorSize: number) => {
    const rows = [
      ...CLEARING_ROWS,
      ...soloPartyRows(subFloorSize, { subject_id: PLACE_2 }, 1000),
    ];
    return serveDb({ intel_trail_followup: true }, { consent: consentFor(rows), observations: rows });
  };

  it("the unscoped total minus the scoped total is ZERO, not the hidden cohort's size", async () => {
    const db = worldOf(MOVEMENT_PRIVACY_V1.minUniqueActors - 1);
    const all = await readTrailMovement(db as any, VIEWER, { now: NOW });
    const clearing = await readTrailMovement(db as any, VIEWER, { now: NOW, originId: PLACE });
    const hidden = await readTrailMovement(db as any, VIEWER, { now: NOW, originId: PLACE_2 });

    const total = (r: { buckets: { uniqueActors: number }[] }) => r.buckets.reduce((s, b) => s + b.uniqueActors, 0);
    assert.equal(total(all) - total(clearing), 0, "differencing recovers nothing");
    assert.deepEqual(hidden.buckets, [], "the sub-floor origin serves no bucket at any scope");
    assert.equal(all.buckets.length, clearing.buckets.length, "no extra tuple appears in the wider view");
  });

  it("a served bucket is scope-INVARIANT — that, not secrecy, is what makes it safe to subtract", async () => {
    const db = worldOf(MOVEMENT_PRIVACY_V1.minUniqueActors - 1);
    const all = await readTrailMovement(db as any, VIEWER, { now: NOW });
    const scoped = await readTrailMovement(db as any, VIEWER, { now: NOW, originId: PLACE });
    assert.deepEqual(all.buckets, scoped.buckets, "same bucket, same numbers, whatever the scope");
  });

  it("the withheld bit is monotone under union: f(A ∪ B) = f(A) ∨ f(B), which is not invertible", async () => {
    const db = worldOf(1);
    const all = await readTrailMovement(db as any, VIEWER, { now: NOW });
    const a = await readTrailMovement(db as any, VIEWER, { now: NOW, originId: PLACE });
    const b = await readTrailMovement(db as any, VIEWER, { now: NOW, originId: PLACE_2 });
    assert.equal(all.withheldBelowFloor, a.withheldBelowFloor || b.withheldBelowFloor);
    assert.equal(a.withheldBelowFloor, false);
    assert.equal(b.withheldBelowFloor, true);
  });

  it("the ENTIRE response is identical whether the hidden cohort is 1 person or 14", async () => {
    const small = await readTrailMovement(worldOf(1) as any, VIEWER, { now: NOW });
    const large = await readTrailMovement(
      worldOf(MOVEMENT_PRIVACY_V1.minUniqueActors - 1) as any, VIEWER, { now: NOW },
    );
    assert.equal(wireOf(small), wireOf(large));
    const smallScoped = await readTrailMovement(worldOf(1) as any, VIEWER, { now: NOW, originId: PLACE_2 });
    const largeScoped = await readTrailMovement(
      worldOf(MOVEMENT_PRIVACY_V1.minUniqueActors - 1) as any, VIEWER, { now: NOW, originId: PLACE_2 },
    );
    assert.equal(wireOf(smallScoped), wireOf(largeScoped), "…at the narrowest scope the caller can ask for, too");
  });
});

// ── The movement floor must TRACK the shared threshold, not restate it ────────
describe("IG-06 — MOVEMENT_PRIVACY_V1 is derived from PRIVACY_THRESHOLD_V1", () => {
  /**
   * MOVEMENT_PRIVACY_V1 used to write out 15 / 5 / 0.2 / 30 / 10 as literals —
   * a copy of the shared PRIVACY_THRESHOLD_V1 under a comment calling them "the
   * defaults". Tightening the shared gate would have left every movement reader
   * on the old floor with nothing red to show for it. These assertions compare
   * the two records field by field, so the copy cannot come back.
   */
  it("every field tracks the shared record — nothing is restated", () => {
    assert.equal(MOVEMENT_PRIVACY_V1.minUniqueActors, PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(MOVEMENT_PRIVACY_V1.minGroups, PRIVACY_THRESHOLD_V1.minIndependentGroups);
    assert.equal(MOVEMENT_PRIVACY_V1.maxSingleGroupShare, PRIVACY_THRESHOLD_V1.maxSingleGroupShare);
    assert.equal(MOVEMENT_PRIVACY_V1.minTimeBucketMinutes, PRIVACY_THRESHOLD_V1.timeBucketMinutes);
    assert.equal(MOVEMENT_PRIVACY_V1.minPublicationDelayMinutes, PRIVACY_THRESHOLD_V1.publicationDelayMinutes);
  });

  it("the served floor tracks it in turn, so a tightening reaches the wire", () => {
    assert.deepEqual(TRAIL_COHORT_FLOOR, {
      minUniqueActors: PRIVACY_THRESHOLD_V1.minUniqueActors,
      minGroups: PRIVACY_THRESHOLD_V1.minIndependentGroups,
      maxSingleGroupShare: PRIVACY_THRESHOLD_V1.maxSingleGroupShare,
    });
  });

  it("the floor the read ENFORCES is the one it publishes — the filter and the label cannot drift", async () => {
    // A cohort sized one below the SHARED threshold must be withheld, so the
    // enforcement path is anchored to PRIVACY_THRESHOLD_V1 and not to a local
    // constant that merely happens to agree with it today.
    const rows = soloPartyRows(PRIVACY_THRESHOLD_V1.minUniqueActors - 1);
    const db = serveDb({ intel_trail_followup: true }, { consent: consentFor(rows), observations: rows });
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.deepEqual(read.buckets, []);
    assert.equal(read.cohortFloor.minUniqueActors, PRIVACY_THRESHOLD_V1.minUniqueActors);
  });
});

// ── Serve path: the internal route ────────────────────────────────────────────
describe("IG-06 — GET /v1/internal/intel/trail/movement is admin-only and flag-gated", () => {
  const routeDb = (flags: Record<string, boolean>, observations: Row[] = CLEARING_ROWS) =>
    serveDb(flags, {
      profiles: { [ADMIN]: { role: "admin" }, [ACTOR]: { role: "user" } },
      consent: consentFor(observations),
      observations,
    });

  it("serves the cohort read to an admin", async () => {
    const db = routeDb({ intel_trail_followup: true });
    _setTestClient(db, true);
    const r = await get("/v1/internal/intel/trail/movement", ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refusal, null);
    assert.equal(r.body.buckets.length, 1);
    assert.equal(r.body.buckets[0].uniqueActors, MOVEMENT_PRIVACY_V1.minUniqueActors);
    assert.equal(r.body.buckets[0].cohortFloorMet, true);
    assert.equal(r.body.withheldBelowFloor, false);
    assert.deepEqual(r.body.cohortFloor, TRAIL_COHORT_FLOOR);
    assert.ok(!JSON.stringify(r.body).includes(A), "no actor identity on the wire");
  });

  it("a sub-floor cohort reaches the admin as a VISIBLE refusal carrying no numbers", async () => {
    // The same request an admin would make to difference two origins. Over the
    // real router, over real HTTP: nothing about the withheld cohort — not its
    // size, not its origin, not where it was heading — is in the response.
    const db = routeDb({ intel_trail_followup: true }, soloPartyRows(1));
    _setTestClient(db, true);
    const r = await get("/v1/internal/intel/trail/movement", ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refusal, null);
    assert.deepEqual(r.body.buckets, []);
    assert.equal(r.body.withheldBelowFloor, true, "the refusal is visible");
    const wire = dataWireOf(r.body as Record<string, unknown>);
    for (const k of KEEP_OUT_KEYS)
      assert.ok(!wire.includes(k), `${k} must not reach an admin for a sub-floor cohort: ${wire}`);
    assert.ok(!wire.includes(PLACE));
    assert.ok(!wire.includes("soho"));
  });

  it("scoping to the sub-floor origin returns the same nothing as scoping to an empty one", async () => {
    const rows = [...CLEARING_ROWS, ...soloPartyRows(1, { subject_id: PLACE_2 }, 1000)];
    const db = routeDb({ intel_trail_followup: true }, rows);
    _setTestClient(db, true);
    const hidden = await get(`/v1/internal/intel/trail/movement?subjectId=${PLACE_2}`, ADMIN);
    const nowhere = await get(`/v1/internal/intel/trail/movement?subjectId=${PLACE_3}`, ADMIN);
    assert.equal(hidden.status, 200);
    assert.equal(nowhere.status, 200);
    assert.deepEqual(hidden.body.buckets, []);
    assert.deepEqual(nowhere.body.buckets, []);
    // The ONE bit that separates them is the visible refusal, and it carries no
    // magnitude — so it cannot be differenced into "one person moved from here".
    assert.equal(hidden.body.withheldBelowFloor, true);
    assert.equal(nowhere.body.withheldBelowFloor, false);
    assert.deepEqual(
      { ...hidden.body, withheldBelowFloor: null }, { ...nowhere.body, withheldBelowFloor: null },
      "nothing else about the two responses differs",
    );
  });

  it("refuses an ordinary authenticated user", async () => {
    const db = routeDb({ intel_trail_followup: true });
    _setTestClient(db, true);
    const r = await get("/v1/internal/intel/trail/movement", ACTOR);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("is feature_disabled when intel_trail_followup is off", async () => {
    const db = routeDb({ intel_trail_followup: false });
    _setTestClient(db, true);
    const r = await get("/v1/internal/intel/trail/movement", ADMIN);
    assert.equal(r.body.error, "feature_disabled");
    assert.ok(!db._reads.includes("intel_observations"));
  });

  it("validates the optional subjectId filter", async () => {
    const db = routeDb({ intel_trail_followup: true });
    _setTestClient(db, true);
    const bad = await get("/v1/internal/intel/trail/movement?subjectId=not-a-uuid", ADMIN);
    assert.equal(bad.status, 400);
    const scoped = await get(`/v1/internal/intel/trail/movement?subjectId=${PLACE_2}`, ADMIN);
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.body.buckets, []);
  });
});
