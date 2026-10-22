/**
 * The overview says whether its snapshotId can be compared across reads.
 *
 * With layover_canonical_snapshot_enabled OFF the overview certifies a new snapshot on every GET, so its snapshotId is
 * new on every read. The layover screen compared it against the routed map's snapshot and, finding them different,
 * showed "The plan has changed. Refresh to see routes" forever and refreshed the map in a loop (owner's iPhone,
 * 2026-10-22). The route now publishes `snapshotComparable`, and the client (comparableOverviewSnapshotId in
 * travel-buddy-standalone/src/lib/layoverRoutedMap.ts) compares ids only when it is true.
 *
 * It is true only when THIS response's record came out of the canonical door (canonicalOutcomeOf(record).canonical):
 * the door runs only with BOTH layover_canonical_snapshot_enabled and layover_decision_persistence_enabled on, and a
 * refusal inside it serves an uncited candidate whose id is new again. "The flag is on" was not enough: with the
 * canonical flag on and persistence off the ids still differ on every read, and the first version of this field
 * said true there.
 *
 * NOT PINNED HERE: that two canonical reads share one id. The door's read is an embedded FK join this fake does not
 * model, so every read here stores a new snapshot. src/test/db/layoverSurfaceConsistency.db.test.ts pins the shared
 * id on the migrated schema, and pins snapshotComparable true beside it.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverOverviewSnapshotComparable.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "comparable-token";
const USER = "comparable-user";
const SESSION = "session-comparable";
const HOUR = 3_600_000;

let server: http.Server;
let base = "";

function stage(flags: { canonical: boolean; persistence: boolean }, failures: Record<string, { message: string }> = {}) {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_canonical_snapshot_enabled", enabled: flags.canonical },
      { flag: "layover_decision_persistence_enabled", enabled: flags.persistence },
    ],
    airport_profiles: [airportRow({ verified: true })],
    layover_sessions: [
      sessionRow({
        id: SESSION, user_id: USER, status: "active",
        arrival_time: new Date(now - 10 * 60_000).toISOString(),
        departure_time: new Date(now + 9 * HOUR).toISOString(),
      }),
    ],
    layover_plan_stops: [], layover_recommendations: [], layover_events: [],
    trip_plan_items: [], trips: [], trip_members: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER }, failures }) as any, true);
}

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let acc = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { acc += c; });
        res.on("end", () => { let b: any; try { b = acc ? JSON.parse(acc) : null; } catch { b = acc; } resolve({ status: res.statusCode ?? 0, body: b }); });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const overview = () => get(`/api/airport/sessions/${SESSION}/overview`);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => { server?.close(); _setTestClient(null as any, false); });

describe("GET /airport/sessions/:id/overview — snapshotComparable", () => {
  it("flags off (production today): false, and the id really is new on every read", async () => {
    stage({ canonical: false, persistence: false });
    const a = await overview();
    await new Promise((r) => setTimeout(r, 5));
    const b = await overview();
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.body.snapshotComparable, false);
    assert.equal(b.body.snapshotComparable, false);
    assert.ok(a.body.snapshotId && b.body.snapshotId, "both reads publish an id");
    assert.notEqual(a.body.snapshotId, b.body.snapshotId, "the reason the field exists: two reads, two ids");
  });

  it("the canonical flag alone is not the canonical door: false (persistence is the second switch)", async () => {
    stage({ canonical: true, persistence: false });
    const a = await overview();
    await new Promise((r) => setTimeout(r, 5));
    const b = await overview();
    assert.equal(a.body.snapshotComparable, false);
    assert.notEqual(a.body.snapshotId, b.body.snapshotId, "still a new id per read, so true here would bring the loop back");
  });

  it("both switches on and the door stored the snapshot: true", async () => {
    stage({ canonical: true, persistence: true });
    const r = await overview();
    assert.equal(r.status, 200);
    assert.equal(r.body.persisted?.state, "recorded", "the door stored it (not vacuous: this is the canonical arm)");
    assert.equal(r.body.snapshotComparable, true);
  });

  it("both switches on but the door refused (the store failed): false — the candidate it served is uncited", async () => {
    const down = { message: "store unavailable" };
    stage({ canonical: true, persistence: true }, { "layover_certified_computations:insert": down, "layover_certified_computations:upsert": down });
    const r = await overview();
    assert.equal(r.status, 200, "a refused store still answers the traveller");
    assert.notEqual(r.body.persisted?.state, "recorded", "the store really failed (not vacuous)");
    assert.equal(r.body.snapshotComparable, false);
  });
});
