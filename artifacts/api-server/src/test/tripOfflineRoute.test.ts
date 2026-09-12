/**
 * Trips spec §18 THROUGH the product (census-trips TR334, TR343, TR349,
 * TR451; the §23 "offline member for 6h" scenario's server half, TR421):
 * GET /trips/:tripId/offline-bundle and POST /trips/:tripId/operations.
 *
 *   the bundle is signed with the server's secret and verifies; without a
 *   secret none is issued (503, not an unsigned one); a non-member is refused;
 *   a replayed queue reaches the kernel in the order the traveller acted, each
 *   operation with its own idempotency key and expected version; a sensitive
 *   operation without revalidation never reaches the kernel and comes back
 *   TRIP_OFFLINE_REVALIDATION_REQUIRED with the current version; a gated or
 *   unknown type is TRIP_OFFLINE_QUEUE_REJECTED; a kernel conflict is reported
 *   on the operation, never as an overwrite; a bundle carried back is verified
 *   and dated, an edited one is not a bundle, a version-behind one is
 *   TRIP_OFFLINE_BUNDLE_STALE.
 *
 * Run: node --import tsx/esm --test src/test/tripOfflineRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { verifyOfflineBundle } from "../services/trips/TripOfflineBundle.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const OUTSIDER_ID = "33333333-3333-4333-8333-333333333333";
const TRIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8";
const PLAN_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const SECRET = "offline-bundle-test-secret-0001";
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const opId = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${String(n).padStart(2, "0")}`;

type Row = Record<string, any>;
function makeClient(opts: { kernelOn?: boolean; version?: number } = {}) {
  const version = opts.version ?? 7;
  const db: Record<string, Row[]> = {
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version, start_date: "2026-09-13", end_date: "2026-09-15", title: "Lisbon" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
    ],
    feature_flags: opts.kernelOn === false ? [] : [{ flag: "trip_kernel_enabled", enabled: true }],
    trip_plan_items: [
      { id: PLAN_ID, trip_id: TRIP_ID, title: "Museum", status: "confirmed", day_date: "2026-09-14", starts_at: new Date(NOW + 3_600_000).toISOString(), ends_at: null, location_name: "MAAT", removed_at: null },
    ],
    trip_reservations: [{ id: "r1", trip_id: TRIP_ID, title: "Hotel", location_name: "Av. da Liberdade 1", starts_at: ago(20), status: "confirmed" }],
    trip_commitments: [],
  };
  const kernel: Array<{ p_command: Row }> = [];
  const receipts = new Map<string, Row>();
  let v = version;
  return {
    db, kernel,
    auth: { getUser: async (token: string) => {
      const id = token === "owner-token" ? OWNER_ID : token === "member-token" ? MEMBER_ID : token === "outsider-token" ? OUTSIDER_ID : null;
      return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid" } };
    } },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const chain: any = {
        select: () => chain, order: () => chain, limit: () => chain, gte: () => chain, gt: () => chain, not: () => chain, or: () => chain,
        eq: (c: string, val: any) => { filters.push((r) => r[c] === val); return chain; },
        in: (c: string, vals: any[]) => { filters.push((r) => vals.includes(r[c])); return chain; },
        is: (c: string, val: any) => { filters.push((r) => (r[c] ?? null) === val); return chain; },
        maybeSingle: async () => ({ data: rowsNow()[0] ?? null, error: null }),
        single: async () => ({ data: rowsNow()[0] ?? null, error: null }),
        then: (onF: any, onR: any) => Promise.resolve({ data: rowsNow(), error: null }).then(onF, onR),
      };
      return chain;
    },
    rpc: async (name: string, args: { p_command: Row }) => {
      assert.equal(name, "trip_kernel_execute");
      const c = args.p_command; kernel.push(args);
      const key = `${c.trip_id}:${c.idempotency_key}`;
      const prior = receipts.get(key);
      if (prior) return { data: { ...prior, duplicate: true }, error: null };
      if (c.expected_trip_version != null && c.expected_trip_version !== v) {
        return { data: { ok: false, reason: "TRIP_VERSION_CONFLICT", detail: "stale", current_version: v, expected_version: c.expected_trip_version, contract_version: 2 }, error: null };
      }
      v += 1;
      const receipt = { ok: true, duplicate: false, version: v, event_id: `ev-${v}`, sequence: v, result: { applied: c.type }, contract_version: 2 };
      receipts.set(key, receipt);
      db.trips![0]!.version = v;
      return { data: receipt, error: null };
    },
    storage: { createBucket: async () => ({ error: null }), from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

let server: Server; let port = 0;
function install(c: ReturnType<typeof makeClient>) { _setTestClient(c as any, true); _setTestServiceClient(c as any); return c; }
async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const join = (n: number, over: Row = {}) => ({ operationId: opId(n), tripId: TRIP_ID, expectedTripVersion: null, type: "JOIN_PLAN", payload: { plan_id: PLAN_ID }, clientOccurredAt: ago(6 - n * 0.1), idempotencyKey: `join-${n}`, ...over });

describe("§18 offline — the server's half", () => {
  let savedSecret: string | undefined;
  before(() => new Promise<void>((resolve) => { savedSecret = process.env.TRIP_OFFLINE_BUNDLE_SECRET; process.env.TRIP_OFFLINE_BUNDLE_SECRET = SECRET; server = createServer(app); server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); }); }));
  after(() => new Promise<void>((resolve) => { if (savedSecret === undefined) delete process.env.TRIP_OFFLINE_BUNDLE_SECRET; else process.env.TRIP_OFFLINE_BUNDLE_SECRET = savedSecret; _setTestClient(null as any, false); _setTestServiceClient(null as any); server.close(() => resolve()); }));

  it("GET offline-bundle: signed with the server's secret, versioned at the trip's version, verifiable; the plan and the addresses are in it", async () => {
    install(makeClient());
    const r = await call("GET", `/trips/${TRIP_ID}/offline-bundle`, "member-token");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.algorithm, "hmac-sha256");
    assert.equal(r.body.bundle.sourceTripVersion, 7);
    assert.equal(verifyOfflineBundle(r.body.bundle, r.body.signature, SECRET), true);
    assert.equal(r.body.bundle.contents.activePlan.id, PLAN_ID);
    assert.ok(r.body.bundle.contents.criticalAddresses.some((a: any) => a.kind === "reservation" && a.address === "Av. da Liberdade 1"));
    assert.match(r.body.readings.commitments, /trip_operational_projections_enabled is off/);
  });
  it("GET offline-bundle: a non-member is refused; without a secret none is issued", async () => {
    install(makeClient());
    assert.equal((await call("GET", `/trips/${TRIP_ID}/offline-bundle`, "outsider-token")).status, 403);
    const saved = process.env.TRIP_OFFLINE_BUNDLE_SECRET; const savedSession = process.env.SESSION_SECRET;
    delete process.env.TRIP_OFFLINE_BUNDLE_SECRET; delete process.env.SESSION_SECRET;
    try {
      const r = await call("GET", `/trips/${TRIP_ID}/offline-bundle`, "member-token");
      assert.equal(r.status, 503, JSON.stringify(r.body)); assert.match(String(r.body.message), /unsigned bundle is not issued/);
    } finally { process.env.TRIP_OFFLINE_BUNDLE_SECRET = saved; if (savedSession !== undefined) process.env.SESSION_SECRET = savedSession; }
  });

  it("POST operations: the queue reaches the kernel in the order acted, each with its own key; a duplicate returns its receipt and no second transition", async () => {
    const c = install(makeClient());
    const later = join(2); const earlier = join(1);
    const r = await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: [later, earlier, { ...earlier, operationId: opId(3) }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // op1 and op3 share a clientOccurredAt (op3 is op1 re-sent), so they sort by operationId ahead of op2.
    assert.deepEqual(c.kernel.map((k) => k.p_command.idempotency_key), ["join-1", "join-1", "join-2"], "ordered by clientOccurredAt, then operationId; the second is the first's key again");
    assert.equal(c.kernel[0]!.p_command.actor_user_id, MEMBER_ID, "the actor is the token's");
    assert.equal(c.kernel[0]!.p_command.correlation_id, opId(1), "the operation id correlates the command");
    assert.deepEqual(r.body.results.map((x: any) => [x.operationId.slice(-2), x.ok, x.duplicate]), [["01", true, false], ["03", true, true], ["02", true, false]]);
    assert.equal(r.body.counts.replayed, 3); assert.equal(r.body.counts.duplicates, 1);
    assert.equal(r.body.currentVersion, 9, "two transitions, not three");
  });
  it("POST operations: a sensitive operation without revalidation never reaches the kernel; with expected === current it does", async () => {
    const c = install(makeClient({ version: 7 }));
    const sensitive = { ...join(1), type: "REMOVE_COMMITMENT", payload: { commitment_id: "x" }, idempotencyKey: "rm-1" };
    const r = await call("POST", `/trips/${TRIP_ID}/operations`, "owner-token", { operations: [sensitive, { ...sensitive, operationId: opId(2), idempotencyKey: "rm-2", expectedTripVersion: 7 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [held, done] = r.body.results;
    assert.equal(held.decision, "revalidate"); assert.equal(held.reasonCode, "TRIP_OFFLINE_REVALIDATION_REQUIRED"); assert.equal(held.currentVersion, 7);
    assert.equal(done.decision, "replay"); assert.equal(done.ok, true);
    assert.deepEqual(c.kernel.map((k) => k.p_command.idempotency_key), ["rm-2"], "only the revalidated one was issued");
    assert.equal(r.body.counts.revalidate, 1);
  });
  it("POST operations: a stale expected version is a conflict on that operation, the rest still replay — no overwrite", async () => {
    const c = install(makeClient({ version: 7 }));
    const r = await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: [join(1, { expectedTripVersion: 5 }), join(2)] });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].ok, false); assert.equal(r.body.results[0].reasonCode, "TRIP_VERSION_CONFLICT"); assert.equal(r.body.results[0].currentVersion, 7);
    assert.equal(r.body.results[1].ok, true);
    assert.equal(c.db.trips![0]!.version, 8, "exactly one transition happened");
    assert.equal(r.body.counts.conflicted, 1);
  });
  it("POST operations: a gated type and an unknown type are rejected by name; a foreign trip id is 400; more than the cap is 400", async () => {
    const c = install(makeClient());
    const r = await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: [join(1, { type: "COMPLETE_ACTIVITY" }), join(2, { type: "SAVE_IDEA" })] });
    assert.equal(r.status, 200);
    assert.ok(r.body.results.every((x: any) => x.decision === "reject" && x.reasonCode === "TRIP_OFFLINE_QUEUE_REJECTED"));
    assert.deepEqual(c.kernel, []);
    assert.equal((await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: [join(1, { tripId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1" })] })).status, 400);
    assert.equal((await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: Array.from({ length: 51 }, (_, i) => join(i % 40, { operationId: opId(i), idempotencyKey: `k${i}` })) })).status, 400);
  });
  it("POST operations: kernel flag off — every replay is TRIP_KERNEL_UNAVAILABLE on its operation, never a silent 200", async () => {
    install(makeClient({ kernelOn: false }));
    const r = await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: [join(1)] });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].ok, false); assert.equal(r.body.results[0].reasonCode, "TRIP_KERNEL_UNAVAILABLE");
    assert.equal(r.body.counts.refused, 1);
  });
  it("POST operations: the bundle carried back is verified and dated — current, version-behind (TRIP_OFFLINE_BUNDLE_STALE), and edited (not a bundle)", async () => {
    const c = install(makeClient({ version: 7 }));
    const issued = (await call("GET", `/trips/${TRIP_ID}/offline-bundle`, "member-token")).body;
    const current = await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: [join(1)], bundle: { bundle: issued.bundle, signature: issued.signature } });
    assert.equal(current.body.bundle.verified, true, JSON.stringify(current.body.bundle));
    assert.equal(current.body.bundle.stale, false, "read at 7, reconnecting at 7: current — dated against the version the client met on reconnect, before its own operations moved it");
    // The owner moved the trip on while the client was away.
    c.db.trips![0]!.version = 9;
    const behind = await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: [join(3)], bundle: { bundle: issued.bundle, signature: issued.signature } });
    assert.equal(behind.body.bundle.verified, true);
    assert.equal(behind.body.bundle.stale, true); assert.equal(behind.body.bundle.because, "version_behind"); assert.equal(behind.body.bundle.reasonCode, "TRIP_OFFLINE_BUNDLE_STALE");
    assert.match(behind.body.bundle.detail, /version 7 and the trip is at 9/);
    const edited = { ...issued.bundle, contents: { ...issued.bundle.contents, criticalAddresses: [] } };
    const forged = await call("POST", `/trips/${TRIP_ID}/operations`, "member-token", { operations: [join(2)], bundle: { bundle: edited, signature: issued.signature } });
    assert.equal(forged.body.bundle.verified, false); assert.match(forged.body.bundle.detail, /does not verify/);
  });
});
