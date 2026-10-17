/**
 * census-compass (wave 5, 2026-10-17) — the admin Compass dashboard counts the
 * abuse flags DETECTED in the last 30 days.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/adminCompassAbuseFlagsWindow.test.ts
 *
 * THE DEFECT. GET /api/admin/compass/dashboard read
 * `compass_abuse_flags ... .gte("created_at", thirtyDaysAgo)`. The table has no
 * `created_at`: its time column is `detected_at` (2026-08-19 production
 * baseline; the 2026-09-22 production capture; no migration adds one). PostgREST
 * failed the read with 42703 on every call, the dashboard's reader took the
 * resolved `{ data: null, error }` as "no rows", and the `abuse` block reported
 * `total: 0` with empty breakdowns whatever the abuse scanner had recorded.
 * Found by test/schemaColumnProductionScan.test.ts (class A: the column exists
 * nowhere).
 *
 * THE FIX. Filter on `detected_at`. Proven here on schemaStrictSupabase, which
 * answers 42703 for a column the live schema does not have:
 *   1. the dashboard's abuse block counts exactly the flags detected inside the
 *      window, by severity and by status;
 *   2. no statement of the dashboard names a dead `compass_abuse_flags` column;
 *   3. a flag detected 31 days ago is outside the window.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import adminCompassRouter from "../routes/adminCompass.js";

const ADMIN = "a0a0a0a0-0000-4000-a000-0000000000a0";
const TOKEN = "tok-admin";
const DAY = 24 * 60 * 60 * 1000;

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLog; } };

function flag(id: string, daysAgo: number, severity: string, status: string) {
  return {
    id, pattern_type: "rapid_follow", involved_users: [], severity, status, evidence: {},
    reach_reduction_applied: false, reward_zeroed: false, admin_notes: null,
    detected_at: new Date(Date.now() - daysAgo * DAY).toISOString(), resolved_at: null,
  };
}

function world(): Seed {
  return {
    profiles: [{ id: ADMIN, role: "admin", handle: "admin" }],
    user_account_states: [],
    compass_abuse_flags: [
      flag("f-1", 1, "high", "pending"),
      flag("f-2", 10, "severe", "confirmed"),
      flag("f-3", 29, "high", "dismissed"),
      flag("f-old", 31, "low", "pending"),
    ],
  };
}

const auth = { getUser: async (token: string) => (token === TOKEN ? { data: { user: { id: ADMIN } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", adminCompassRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

function install(seed: Seed) {
  const strict = makeSchemaStrictClient(seed);
  const client = { from: (t: string) => strict.from(t), auth };
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  return strict;
}

async function dashboard(): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}/api/admin/compass/dashboard`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw };
}

describe("schema-strict: GET /api/admin/compass/dashboard counts abuse flags detected in the last 30 days", () => {
  it("counts the three flags inside the window, by severity and by status", async () => {
    install(world());
    const r = await dashboard();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.abuse, {
      total: 3,
      bySeverity: { high: 2, severe: 1 },
      byStatus: { pending: 1, confirmed: 1, dismissed: 1 },
    });
  });

  it("names no column compass_abuse_flags does not have (the 42703 that zeroed the block)", async () => {
    const strict = install(world());
    await dashboard();
    assert.deepEqual(strict.deadColumnErrors.filter((e) => e.table === "compass_abuse_flags"), []);
  });

  it("a flag detected 31 days ago is outside the window; none inside answers an empty block", async () => {
    const seed = world();
    seed.compass_abuse_flags = [flag("f-old", 31, "low", "pending")];
    install(seed);
    const r = await dashboard();
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.abuse, { total: 0, bySeverity: {}, byStatus: {} });
  });
});
