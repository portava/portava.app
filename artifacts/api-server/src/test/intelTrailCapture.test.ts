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
import { CLAIM_TYPES } from "../lib/intelContracts.js";
import { readTrailMovement, cohortFloorMet, TRAIL_SIGNAL_MAX_AGE_MINUTES } from "../lib/trailServe.js";
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

  it("AT-10: a blocked actor's Trail row is hidden from the viewer, the rest aggregate — and no actor id leaves", async () => {
    const db = serveDb(
      { intel_trail_followup: true },
      { blocks: [{ blocker_id: VIEWER, blocked_id: A }], observations: [nextMoveRow(A), nextMoveRow(B), nextMoveRow(C)] },
    );
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.refusal, null);
    assert.equal(read.hiddenByBlock, 1);
    assert.equal(read.buckets.length, 1);
    const [bucket] = read.buckets;
    assert.equal(bucket.originId, PLACE);
    assert.equal(bucket.destinationArea, "soho");
    assert.equal(bucket.uniqueActors, 2);
    assert.equal(bucket.groups, 2);
    assert.equal(bucket.droppedUngrouped, 0);
    assert.equal(bucket.cohortFloorMet, false, "two people are not a §13 cohort");
    const wire = JSON.stringify(read);
    for (const id of [A, B, C, VIEWER]) assert.ok(!wire.includes(id), `actor identity must not leave the read: ${id}`);
  });

  it("the block is bidirectional — an actor who blocked the viewer is hidden too", async () => {
    const db = serveDb(
      { intel_trail_followup: true },
      { blocks: [{ blocker_id: B, blocked_id: VIEWER }], observations: [nextMoveRow(A), nextMoveRow(B)] },
    );
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.hiddenByBlock, 1);
    assert.equal(read.buckets[0].uniqueActors, 1);
  });

  it("excludes expired and withdrawn-consent rows and drops ungrouped rows from the cohort (fail-closed independence)", async () => {
    const db = serveDb(
      { intel_trail_followup: true },
      {
        consent: { [A]: true, [B]: "withdrawn", [C]: true },
        observations: [
          nextMoveRow(A),
          nextMoveRow(B),                                   // consent withdrawn → ineligible
          nextMoveRow(C, { group_key: null }),              // no certified group → droppedUngrouped
          nextMoveRow(D, { expires_at: new Date(NOW.getTime() - 1000).toISOString() }), // expired → gone
        ],
      },
    );
    const read = await readTrailMovement(db as any, VIEWER, { now: NOW });
    assert.equal(read.refusal, null);
    assert.equal(read.droppedIneligible, 1, "withdrawn consent");
    assert.equal(read.buckets.length, 1);
    assert.equal(read.buckets[0].uniqueActors, 1, "only A is counted");
    assert.equal(read.buckets[0].droppedUngrouped, 1, "C had no group key");
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
    assert.equal(read.droppedIneligible, 1);
  });

  it("scopes to an origin place when asked, and the freshness window is the next_move TTL", async () => {
    const db = serveDb(
      { intel_trail_followup: true },
      { observations: [nextMoveRow(A), nextMoveRow(B, { subject_id: PLACE_2 })] },
    );
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

// ── Serve path: the internal route ────────────────────────────────────────────
describe("IG-06 — GET /v1/internal/intel/trail/movement is admin-only and flag-gated", () => {
  const routeDb = (flags: Record<string, boolean>) =>
    serveDb(flags, {
      profiles: { [ADMIN]: { role: "admin" }, [ACTOR]: { role: "user" } },
      observations: [nextMoveRow(A), nextMoveRow(B)],
    });

  it("serves the cohort read to an admin", async () => {
    const db = routeDb({ intel_trail_followup: true });
    _setTestClient(db, true);
    const r = await get("/v1/internal/intel/trail/movement", ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refusal, null);
    assert.equal(r.body.buckets.length, 1);
    assert.equal(r.body.buckets[0].uniqueActors, 2);
    assert.equal(r.body.buckets[0].cohortFloorMet, false);
    assert.ok(!JSON.stringify(r.body).includes(A), "no actor identity on the wire");
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
