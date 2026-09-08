/**
 * Two Circle handlers that answered from writes and reads nobody looked at.
 *
 * ── 1. POST /circle/contexts/:type/:id/check-in — THE SECOND WRITE WAS
 *       DESTRUCTURED AWAY ───────────────────────────────────────────────────
 *     const [checkinResult] = await Promise.all([
 *       sc.from("circle_checkins").insert(...)…,
 *       sc.from("circle_presence").upsert(...),      // <- result dropped
 *     ]);
 *     if (checkinResult.error) { … }
 *
 * The array pattern bound only the first element, so the presence upsert's
 * `.error` could not be observed even in principle. supabase-js RESOLVES a
 * failed write as `{ error }`, so a `circle_presence` row that never landed
 * produced a 201 naming a check-in id.
 *
 * circle_presence is the row OTHER PEOPLE read (lib/circleAccessGuard.ts step 8,
 * GET …/my-presence, the compass "circle_active" card); circle_checkins is the
 * private log. So the silent failure leaves a member's circle looking at their
 * PREVIOUS venue and status while they believe they have just published a move.
 *
 * ── 2. GET /circle/settings — A FABRICATED "SHARING IS OFF" ────────────────
 *     const { data } = await sc.from("circle_visibility_settings")…
 *     globalEnabled: (data as any)?.global_enabled ?? false,
 *     isPaused:      (data as any)?.is_paused      ?? false,
 *
 * `.error` unbound, so an unreadable settings row produced a complete, confident
 * privacy answer: sharing OFF, not paused, no consent recorded. This is the
 * screen a person opens to check whether they are broadcasting their location,
 * and the reassuring reading is the false one — being shown "off" while sharing
 * is on is what stops somebody acting.
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ─────────────────────────────
 *   - Exact statuses and exact error codes throughout; `!== 200` would pass on a
 *     crash-500 and `>= 500` would admit one.
 *   - Check-in keeps its 201 when the presence write fails — the direction is
 *     deliberately unchanged, because the check-in row IS committed and
 *     refusing after it would invite a duplicate on retry. So the ONLY thing
 *     that can distinguish the two cases is `presenceUpdated`, and BOTH cases
 *     assert it explicitly (true / false); an undefined field fails both.
 *   - The presence write is failed by `table:op`, and the paired success case
 *     runs on the same fake, so a 201 with `presenceUpdated: false` cannot come
 *     from the check-in insert having failed instead.
 *   - GET /circle/settings pairs the outage against the ABSENT row, which is a
 *     real state (a user who never touched Circle) and must still answer 200
 *     with the defaults. Without that pairing a fix that refused whenever the
 *     row was missing would pass.
 *   - `req.log` IS shimmed. Both new paths log.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/circleCheckinAndSettingsOutage.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const USER = "aaaaaaaa-8888-8888-8888-888888888888";
const TRIP = "bbbbbbbb-9999-9999-9999-999999999999";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

interface Opts {
  /** Fail writes keyed `table:op`, e.g. "circle_presence:upsert". */
  failWrites?: string[];
  /** Fail reads keyed `table` or `table:projectedColumn`. */
  failReads?: string[];
  /** circle_visibility_settings row, or null for "never configured". */
  settingsRow?: Record<string, unknown> | null;
}

function makeClient(o: Opts) {
  const failWrites = new Set(o.failWrites ?? []);
  const failReads = new Set(o.failReads ?? []);

  const builder = (table: string): any => {
    let op = "select";
    let projection = "";
    const settle = () => {
      if (op !== "select") {
        if (failWrites.has(`${table}:${op}`)) return { data: null, error: DB_ERROR };
        if (table === "circle_checkins") return { data: { id: "chk-1", checkin_type: "arrived", created_at: "2026-09-08T00:00:00Z" }, error: null };
        return { data: null, error: null };
      }
      if (failReads.has(table) || failReads.has(`${table}:${projection.replace(/\s/g, "")}`)) {
        return { data: null, error: DB_ERROR };
      }
      if (table === "profiles") return { data: { id: USER, account_status: "active", handle: "u", name: null }, error: null };
      if (table === "feature_flags") return { data: { enabled: true }, error: null };
      // Accepted trip membership — required by isAcceptedMember before check-in.
      if (table === "trip_members") return { data: { user_id: USER, role: "member", status: "accepted", trip_id: TRIP }, error: null };
      if (table === "circle_visibility_settings") return { data: o.settingsRow ?? null, error: null };
      return { data: null, error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(settle()).then(res, rej);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(settle());
        if (prop === "select") return (cols?: string) => { if (op === "select") projection = cols ?? ""; return b; };
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
          return (..._a: any[]) => { op = String(prop); return b; };
        }
        return (..._a: any[]) => b;
      },
    });
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: (table: string) => builder(table),
  } as any;
}

function install(o: Opts) {
  const c = makeClient(o);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  const { default: circleRouter } = await import("../routes/circle.js");
  app.use(circleRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); _clearTestClient(); _setTestServiceClient(null); });

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { authorization: "Bearer t" };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("POST /circle/contexts/trip/:id/check-in — the presence snapshot", () => {
  it("both writes land: 201 with presenceUpdated true", async () => {
    install({});
    const r = await call("POST", `/circle/contexts/trip/${TRIP}/check-in`, { checkinType: "arrived", venueLabel: "Cafe" });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, "chk-1");
    assert.equal(r.body.presenceUpdated, true);
  });

  it("circle_presence upsert FAILS: still 201 (the check-in committed) but presenceUpdated is false", async () => {
    install({ failWrites: ["circle_presence:upsert"] });
    const r = await call("POST", `/circle/contexts/trip/${TRIP}/check-in`, { checkinType: "arrived", venueLabel: "Cafe" });
    // The direction is deliberately unchanged, so status and id are identical to
    // the case above. `presenceUpdated` is the only thing that can tell them
    // apart, which is exactly the signal that did not exist before.
    assert.equal(r.status, 201);
    assert.equal(r.body.id, "chk-1");
    assert.equal(r.body.presenceUpdated, false);
  });

  it("circle_checkins insert FAILS: refuses, so presenceUpdated is not standing in for the wrong write", async () => {
    install({ failWrites: ["circle_checkins:insert"] });
    const r = await call("POST", `/circle/contexts/trip/${TRIP}/check-in`, { checkinType: "arrived" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });
});

describe("GET /circle/settings — an unreadable settings row", () => {
  it("row present: reports it", async () => {
    install({ settingsRow: { global_enabled: true, is_paused: false, visibility_mode: "status_only" } });
    const r = await call("GET", "/circle/settings");
    assert.equal(r.status, 200);
    assert.equal(r.body.globalEnabled, true);
    assert.equal(r.body.isPaused, false);
  });

  it("row genuinely absent: still 200 with the never-configured defaults", async () => {
    // A real state, and the one the outage used to impersonate. Without this
    // case a fix that refused on a missing row would pass the next test.
    install({ settingsRow: null });
    const r = await call("GET", "/circle/settings");
    assert.equal(r.status, 200);
    assert.equal(r.body.globalEnabled, false);
    assert.equal(r.body.isPaused, false);
  });

  it("read FAILS: refuses instead of reporting 'sharing is off, not paused'", async () => {
    install({ failReads: ["circle_visibility_settings"] });
    const r = await call("GET", "/circle/settings");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    assert.equal(r.body.globalEnabled, undefined);
    assert.equal(r.body.isPaused, undefined);
  });
});
