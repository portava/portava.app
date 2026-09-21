/**
 * GET /api/airport/sessions/:id/buddies — honours the marketplace master flag
 * and fails CLOSED when the blocks table cannot be read.
 *
 * node:test + node:assert (NOT vitest). Real router, fake table-backed DB.
 *
 * THE DEFECT. This route read rent_buddy_profiles behind the layover flag
 * alone. Every other reader of that table (lib/buddyMapRead.ts,
 * routes/rentABuddy.ts) gates on `rent_buddy_enabled`, which is FALSE in
 * production — so the layover dashboard, which calls this route on every load,
 * was the one surface serving buddy profiles while the marketplace was off.
 * Its blocks read also destructured `{ data }` without `error`; supabase-js
 * resolves `{ data: null, error }` on failure, so an outage read as "nobody is
 * blocked" and the route recommended meeting a blocked person.
 *
 * Run: node --import tsx/esm --test src/test/layoverBuddiesMasterFlag.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;
const TOKEN = "buddies-token";
const USER_ID = "user-1";

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function stage(opts: { rentBuddyEnabled: boolean; blocks?: any[]; blocksFail?: boolean }) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "rent_buddy_enabled", enabled: opts.rentBuddyEnabled },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID })],
    rent_buddy_profiles: [
      { id: "b1", user_id: "buddy-1", display_name: "Amy", city: "Taoyuan", status: "active", review_count: 3, verified: true },
      { id: "b2", user_id: "buddy-2", display_name: "Ben", city: "Taoyuan", status: "active", review_count: 1, verified: false },
    ],
    rent_buddy_availability: [],
    blocks: opts.blocks ?? [],
  };
  const db = makeLayoverDb(tables, {
    users: { [TOKEN]: USER_ID },
    failures: opts.blocksFail ? { "blocks:select": { message: "relation unavailable" } } : {},
  });
  _setTestClient(db, true);
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("GET /airport/sessions/:id/buddies", () => {
  it("positive control: master flag ON, clean blocks read → both buddies served", async () => {
    stage({ rentBuddyEnabled: true });
    const r = await get("/api/airport/sessions/session-1/buddies");
    assert.equal(r.status, 200);
    assert.equal(r.body.buddies.length, 2);
  });

  it("master flag OFF → no buddies, even though matching active profiles exist", async () => {
    stage({ rentBuddyEnabled: false });
    const r = await get("/api/airport/sessions/session-1/buddies");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.buddies, []);
    assert.equal(r.body.reason, "rent_buddy_not_enabled");
  });

  it("master flag row ABSENT → no buddies (fail-closed reader)", async () => {
    stage({ rentBuddyEnabled: true });
    // remove the row after staging
    _setTestClient(makeLayoverDb({
      feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({ user_id: USER_ID })],
      rent_buddy_profiles: [{ id: "b1", user_id: "buddy-1", city: "Taoyuan", status: "active", review_count: 3 }],
    }, { users: { [TOKEN]: USER_ID } }), true);
    const r = await get("/api/airport/sessions/session-1/buddies");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.buddies, []);
  });

  it("a block in either direction removes that buddy", async () => {
    stage({ rentBuddyEnabled: true, blocks: [{ blocker_id: "buddy-2", blocked_id: USER_ID }] });
    const r = await get("/api/airport/sessions/session-1/buddies");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.buddies.map((b: any) => b.userId), ["buddy-1"]);
  });

  it("an UNREADABLE blocks table → no buddies (fail closed), not 'nobody is blocked'", async () => {
    stage({ rentBuddyEnabled: true, blocksFail: true });
    const r = await get("/api/airport/sessions/session-1/buddies");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.buddies, []);
  });
});
