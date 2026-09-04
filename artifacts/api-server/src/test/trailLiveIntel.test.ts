/**
 * §19 GET /v1/trails/:id/live-intel — the trail LIVE-intel read model.
 *
 * A trail is a route_plan; its stops are route_stops that point at a place. This
 * serves the same LIVE claim envelopes the place card serves, so every live gate
 * is inherited from lib/liveClaimRead. It is NOT crowd-movement output.
 *
 * Proven here, through the real lib and the real router over loopback HTTP:
 *   • fail-closed authorization — unknown, and unauthorised, are the SAME 404;
 *     owner and accepted trip member are allowed; a stranger is not;
 *   • only PLACE stops (source_type='place', uuid source_id) are read;
 *   • live gating passes straight through — Live off ⇒ each stop has [] claims;
 *     Live on + promoted scope + fresh snapshot ⇒ the claim envelope shows;
 *   • the movement aggregate is NEVER touched (no intel_observations read);
 *   • the response carries schemaVersion + generatedAt + an ETag, and honours
 *     If-None-Match with a 304.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import { computeETag } from "../routes/trails.js";
import { readTrailLiveIntel } from "../lib/trailLiveIntel.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";

const OWNER = "11111111-1111-4111-8111-1111111111a1";
const MEMBER = "11111111-1111-4111-8111-1111111111b2";
const STRANGER = "11111111-1111-4111-8111-1111111111c3";
const TRAIL = "33333333-3333-4333-8333-333333333333";
const TRAIL_SOLO = "33333333-3333-4333-8333-333333333334";
const TRIP = "44444444-4444-4444-8444-444444444444";
const PLACE_A = "22222222-2222-4222-8222-2222222222a1";
const PLACE_B = "22222222-2222-4222-8222-2222222222b2";
const MISSING = "99999999-9999-4999-8999-999999999999";
const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const FUTURE = new Date(NOW.getTime() + 60_000).toISOString();

type Row = Record<string, any>;
interface FakeOpts {
  flags?: Record<string, boolean>;
  routePlans?: Row[];
  routeStops?: Row[];
  tripMembers?: Row[];
  promotedScopes?: Row[];
  snapshots?: Row[];
  profiles?: string[];
}

function makeDb(opts: FakeOpts) {
  const tables: Record<string, Row[]> = {
    feature_flags: Object.entries(opts.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled })),
    route_plans: opts.routePlans ?? [],
    route_stops: opts.routeStops ?? [],
    trip_members: opts.tripMembers ?? [],
    intel_live_promoted_scopes: opts.promotedScopes ?? [],
    intel_state_snapshots: opts.snapshots ?? [],
    intel_observations: [],
    profiles: (opts.profiles ?? [OWNER, MEMBER, STRANGER]).map((id) => ({ id, account_status: "active", role: "user" })),
  };
  const reads: string[] = [];
  function from(table: string) {
    reads.push(table);
    const filters: Array<{ col: string; val: any; kind: string }> = [];
    const match = (row: Row) =>
      filters.every((f) => {
        const cell = row[f.col];
        switch (f.kind) {
          case "in": return (f.val as any[]).includes(cell);
          case "is": return (cell ?? null) === f.val;
          case "gt": return String(cell ?? "") > String(f.val);
          default: return cell === f.val;
        }
      });
    function run() {
      const store = tables[table] ?? (tables[table] = []);
      if (table === "feature_flags") {
        const flag = filters.find((f) => f.col === "flag")?.val;
        const row = store.find((r) => r.flag === flag);
        return { data: row ? { enabled: !!row.enabled } : null, error: null };
      }
      return { data: store.filter(match), error: null };
    }
    const one = () => {
      const r = run();
      return Promise.resolve(Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r);
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push({ col: c, val: v, kind: "eq" }); return b; },
      in(c: string, v: any[]) { filters.push({ col: c, val: v, kind: "in" }); return b; },
      is(c: string, v: any) { filters.push({ col: c, val: v, kind: "is" }); return b; },
      gt(c: string, v: any) { filters.push({ col: c, val: v, kind: "gt" }); return b; },
      order() { return b; },
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

const LIVE_ON = {
  intel_live_label_crowd: true,
  intel_claim_projection_crowd: true,
  intel_capture_quick_signal: true,
  intel_limited_live: true,
  disable_intel_live_labels: false,
};

const ownedTrail = (over: Partial<FakeOpts> = {}): FakeOpts => ({
  flags: LIVE_ON,
  routePlans: [{ id: TRAIL, owner_user_id: OWNER, trip_id: TRIP }],
  routeStops: [
    { id: "s1", route_plan_id: TRAIL, source_type: "place", source_id: PLACE_A, title: "Bar A", order_index: 0 },
    { id: "s2", route_plan_id: TRAIL, source_type: "manual", source_id: null, title: "Walk", order_index: 1 },
    { id: "s3", route_plan_id: TRAIL, source_type: "place", source_id: PLACE_B, title: "Club B", order_index: 2 },
  ],
  tripMembers: [{ trip_id: TRIP, user_id: MEMBER, status: "accepted" }],
  ...over,
});

describe("readTrailLiveIntel — authorization is fail-closed", () => {
  it("owner is authorized and sees only the PLACE stops (manual stop filtered)", async () => {
    _clearPromotedScopeCache();
    const r = await readTrailLiveIntel(makeDb(ownedTrail()) as any, OWNER, TRAIL, { now: NOW });
    assert.equal(r.refusal, null);
    assert.deepEqual(r.stops.map((s) => s.subjectId), [PLACE_A, PLACE_B]);
    assert.deepEqual(r.stops.map((s) => s.orderIndex), [0, 2]);
  });

  it("an ACCEPTED trip member is authorized", async () => {
    _clearPromotedScopeCache();
    const r = await readTrailLiveIntel(makeDb(ownedTrail()) as any, MEMBER, TRAIL, { now: NOW });
    assert.equal(r.refusal, null);
    assert.equal(r.stops.length, 2);
  });

  it("a stranger gets unknown_trail (existence not leaked)", async () => {
    _clearPromotedScopeCache();
    const r = await readTrailLiveIntel(makeDb(ownedTrail()) as any, STRANGER, TRAIL, { now: NOW });
    assert.equal(r.refusal, "unknown_trail");
    assert.deepEqual(r.stops, []);
  });

  it("a non-accepted member is not authorized", async () => {
    _clearPromotedScopeCache();
    const db = makeDb(ownedTrail({ tripMembers: [{ trip_id: TRIP, user_id: MEMBER, status: "invited" }] }));
    const r = await readTrailLiveIntel(db as any, MEMBER, TRAIL, { now: NOW });
    assert.equal(r.refusal, "unknown_trail");
  });

  it("a missing trail is unknown_trail", async () => {
    _clearPromotedScopeCache();
    const r = await readTrailLiveIntel(makeDb(ownedTrail()) as any, OWNER, MISSING, { now: NOW });
    assert.equal(r.refusal, "unknown_trail");
  });

  it("no client → no_service_client; bad viewer/id → unknown_trail", async () => {
    assert.equal((await readTrailLiveIntel(null, OWNER, TRAIL)).refusal, "no_service_client");
    assert.equal((await readTrailLiveIntel(makeDb(ownedTrail()) as any, "", TRAIL)).refusal, "unknown_trail");
    assert.equal((await readTrailLiveIntel(makeDb(ownedTrail()) as any, OWNER, "not-a-uuid")).refusal, "unknown_trail");
  });
});

describe("readTrailLiveIntel — live gating passes straight through", () => {
  it("Live OFF ⇒ each place stop has an empty claims array (never a refusal)", async () => {
    _clearPromotedScopeCache();
    const db = makeDb(ownedTrail({ flags: { ...LIVE_ON, intel_limited_live: false } }));
    const r = await readTrailLiveIntel(db as any, OWNER, TRAIL, { now: NOW });
    assert.equal(r.refusal, null);
    assert.ok(r.stops.every((s) => s.claims.length === 0));
    // The movement aggregate must never be touched by this read.
    assert.equal(db._reads.includes("intel_observations"), false);
  });

  it("Live ON + promoted scope + fresh snapshot ⇒ the claim envelope shows", async () => {
    _clearPromotedScopeCache();
    const db = makeDb(ownedTrail({
      promotedScopes: [{ scope_key: `|crowd.level` }],
      snapshots: [{
        id: "snap-A", subject_id: PLACE_A, zone_id: null, claim_type: "crowd.level",
        value: { level: "busy" }, confidence: 0.8, source_count: 30,
        observed_at: NOW_ISO, expires_at: FUTURE, privacy_eligible: true,
      }],
    }));
    const r = await readTrailLiveIntel(db as any, OWNER, TRAIL, { now: NOW });
    assert.equal(r.refusal, null);
    const stopA = r.stops.find((s) => s.subjectId === PLACE_A)!;
    assert.equal(stopA.claims.length, 1);
    assert.equal(stopA.claims[0].claimType, "crowd.level");
    // PLACE_B has no snapshot → empty, but still present and ordered.
    assert.equal(r.stops.find((s) => s.subjectId === PLACE_B)!.claims.length, 0);
    assert.equal(db._reads.includes("intel_observations"), false, "not the movement path");
  });
});

// ── Route over loopback HTTP ──────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";
before(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as any).port}`; });
after(() => { server.close(); _clearTestClient(); });

async function get(id: string, as: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/trails/${id}/live-intel`, { headers: { authorization: `Bearer ${as}`, ...headers } });
  const etag = res.headers.get("etag");
  const text = await res.text();
  return { status: res.status, etag, body: text ? JSON.parse(text) : null };
}

describe("GET /v1/trails/:id/live-intel over the real router", () => {
  it("owner gets 200 with schemaVersion, generatedAt and an ETag; stranger gets 404", async () => {
    _clearPromotedScopeCache();
    _setTestClient(makeDb(ownedTrail()), true);
    const ok = await get(TRAIL, OWNER);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.schemaVersion, 1);
    assert.ok(ok.body.generatedAt);
    assert.ok(ok.etag, "an ETag is set");
    assert.equal(ok.body.stops.length, 2);

    _clearPromotedScopeCache();
    _setTestClient(makeDb(ownedTrail()), true);
    const denied = await get(TRAIL, STRANGER);
    assert.equal(denied.status, 404);
  });

  it("a missing trail is 404 (indistinguishable from unauthorised)", async () => {
    _clearPromotedScopeCache();
    _setTestClient(makeDb(ownedTrail()), true);
    const r = await get(MISSING, OWNER);
    assert.equal(r.status, 404);
  });

  it("an invalid uuid is 400", async () => {
    _setTestClient(makeDb(ownedTrail()), true);
    const r = await get("not-a-uuid", OWNER);
    assert.equal(r.status, 400);
  });

  it("If-None-Match with the current ETag returns 304", async () => {
    _clearPromotedScopeCache();
    _setTestClient(makeDb(ownedTrail()), true);
    const first = await get(TRAIL, OWNER);
    assert.equal(first.status, 200);
    _clearPromotedScopeCache();
    _setTestClient(makeDb(ownedTrail()), true);
    const revalidate = await get(TRAIL, OWNER, { "If-None-Match": first.etag! });
    assert.equal(revalidate.status, 304);
  });

  it("computeETag is stable for equal content and differs for different content", () => {
    assert.equal(computeETag({ a: 1 }), computeETag({ a: 1 }));
    assert.notEqual(computeETag({ a: 1 }), computeETag({ a: 2 }));
  });
});
