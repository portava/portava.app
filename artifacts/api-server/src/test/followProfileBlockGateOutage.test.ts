/**
 * GET /users/:userId and GET /users/by-handle/:handle — an unreadable `blocks`
 * table is not "nobody is blocked".
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Both handlers resolve the block state with a HEAD count:
 *
 *     needBlockCheck
 *       ? sc.from("blocks").select("blocker_id", { count: "exact", head: true })…
 *       : Promise.resolve({ count: 0 })
 *     …
 *     const targetBlockedCaller = ((targetBlockedCallerRes as any).count ?? 0) > 0;
 *
 * `.error` was never bound. supabase-js RESOLVES on a database error, and a
 * failed count comes back as `{ count: null, error }` — so `count ?? 0` turned
 * an unreadable `blocks` table into `0`, `0 > 0` into `false`, and BOTH block
 * guards into "not blocked". `blocks` is an EXCLUSION table: a row means DENY,
 * so an empty read is the PERMISSIVE answer and this is fail-open by
 * construction. The consequence is not abstract — the full passport of a person
 * who had blocked this caller (name, handle, bio, home city, current city,
 * travel styles, follower counts, shared-destination reason) was served to them
 * with a 200 because the database blinked.
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ──────────────────────────────
 *   - Status is asserted EXACTLY (503) together with `error === "degraded_unavailable"`
 *     and `retryable === true`. `status !== 200` would pass on a crash-500, and
 *     `>= 500` would admit one too.
 *   - The refusal case additionally asserts the body does NOT carry `handle` or
 *     `name`, so "refused" cannot be satisfied by an error page that still leaked
 *     the profile.
 *   - `req.log` IS shimmed. The guard logs before refusing; without the shim a
 *     crash-500 could impersonate a fail-closed refusal.
 *   - Every outage case is PAIRED with the two readable cases it must be
 *     distinguishable from: no block (200 passport) and a real block (200
 *     `unavailable/blocked`). Before the fix the outage produced byte-identical
 *     output to the first of those.
 *   - The error is keyed on the `blocks` TABLE only, and the paired 200 cases run
 *     against the same fake with the same `profiles` rows — so a 503 cannot be
 *     coming from a broken profile read.
 *   - An UNAUTHENTICATED request is asserted to still return 200 while the
 *     `blocks` table is failing. That branch never issues the read
 *     (`Promise.resolve({ count: 0, error: null })`), and the assertion is what
 *     stops the fix degenerating into "always refuse", which would also make
 *     every outage assertion above pass.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/followProfileBlockGateOutage.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestServiceClient } from "../lib/supabase.js";

const CALLER = "11111111-1111-1111-1111-111111111111";
const TARGET = "22222222-2222-2222-2222-222222222222";
const HANDLE = "targetuser";

/** A real PostgREST-shaped failure, RESOLVED (never thrown), as supabase-js does. */
const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

type Row = Record<string, unknown>;

const TARGET_PROFILE: Row = {
  id: TARGET,
  handle: HANDLE,
  name: "Target Person",
  avatar_url: null,
  bio: "bio",
  home_city: "Lisbon",
  home_country: "PT",
  current_city: "Porto",
  interests: [],
  verified: false,
  is_private: false,
  passport_visibility: "public",
  created_at: "2026-01-01T00:00:00Z",
  account_status: "active",
  is_official: false,
};

interface Opts {
  /** null = unauthenticated (no Authorization header is sent for these). */
  callerId: string | null;
  /** Fail every read of these tables (resolved `{ error }`, never thrown). */
  failTables?: string[];
  /** blocks rows present: "none" | "target_blocked_caller" | "caller_blocked_target" */
  blockState?: "none" | "target_blocked_caller" | "caller_blocked_target";
}

function makeClient(o: Opts) {
  const fail = new Set(o.failTables ?? []);
  const blockState = o.blockState ?? "none";

  const builder = (table: string): any => {
    const filters: Array<[string, unknown]> = [];
    let countMode = false;
    const b: any = {
      select: (_cols?: string, opts?: any) => { if (opts?.count) countMode = true; return b; },
      eq: (col: string, val: unknown) => { filters.push([col, val]); return b; },
      neq: () => b, in: () => b, or: () => b, ilike: (col: string, val: unknown) => { filters.push([col, val]); return b; },
      contains: () => b, order: () => b, limit: () => b, gte: () => b, lte: () => b, lt: () => b, gt: () => b,
      maybeSingle: () => Promise.resolve(resolveOne()),
      single: () => Promise.resolve(resolveOne()),
      then: (resolve: (v: any) => any, reject?: any) =>
        Promise.resolve(countMode ? resolveCount() : resolveList()).then(resolve, reject),
    };

    const get = (col: string) => filters.find(([c]) => c === col)?.[1];

    function resolveOne() {
      if (fail.has(table)) return { data: null, error: DB_ERROR };
      if (table === "profiles") {
        const byId = get("id");
        const byHandle = get("handle");
        if (byId === TARGET || (typeof byHandle === "string" && byHandle.toLowerCase() === HANDLE)) {
          return { data: TARGET_PROFILE, error: null };
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    function resolveList() {
      if (fail.has(table)) return { data: null, error: DB_ERROR };
      return { data: [], error: null };
    }
    function resolveCount() {
      // A FAILED count resolves as { count: null, error } — this is the shape
      // the defect read as zero.
      if (fail.has(table)) return { data: null, count: null, error: DB_ERROR };
      if (table !== "blocks") return { data: null, count: 0, error: null };
      const blocker = get("blocker_id");
      const blocked = get("blocked_id");
      const callerBlockedTarget = blocker === o.callerId && blocked === TARGET;
      const targetBlockedCaller = blocker === TARGET && blocked === o.callerId;
      if (blockState === "caller_blocked_target" && callerBlockedTarget) return { data: null, count: 1, error: null };
      if (blockState === "target_blocked_caller" && targetBlockedCaller) return { data: null, count: 1, error: null };
      return { data: null, count: 0, error: null };
    }

    return b;
  };

  return {
    auth: {
      getUser: async () =>
        o.callerId
          ? { data: { user: { id: o.callerId } }, error: null }
          : { data: { user: null }, error: { message: "no session" } },
    },
    from: (table: string) => builder(table),
  } as any;
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // REQUIRED. The guard under test logs before refusing; without this shim it
  // throws and a 500-from-crash would masquerade as a fail-closed refusal.
  app.use((req: any, _res, next) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  const { default: followsRouter } = await import("../routes/follows.js");
  app.use(followsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestServiceClient(null);
});

function get(path: string, authed: boolean): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method: "GET", headers: authed ? { authorization: "Bearer t" } : {} },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let body: any = null;
          try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const PATHS: Array<[string, string]> = [
  ["GET /users/:userId", `/users/${TARGET}`],
  ["GET /users/by-handle/:handle", `/users/by-handle/${HANDLE}`],
];

for (const [label, path] of PATHS) {
  describe(`${label} — block gate vs an unreadable blocks table`, () => {
    it("READABLE + no block: serves the passport (the answer the outage used to forge)", async () => {
      _setTestServiceClient(makeClient({ callerId: CALLER, blockState: "none" }));
      const r = await get(path, true);
      assert.equal(r.status, 200);
      assert.equal(r.body.unavailable, undefined);
      assert.equal(r.body.handle, HANDLE);
    });

    it("READABLE + target blocked caller: hides the profile", async () => {
      _setTestServiceClient(makeClient({ callerId: CALLER, blockState: "target_blocked_caller" }));
      const r = await get(path, true);
      assert.equal(r.status, 200);
      assert.equal(r.body.unavailable, true);
      assert.equal(r.body.reason, "blocked");
      assert.equal(r.body.isBlocker, false);
      assert.equal(r.body.handle, undefined);
    });

    it("READABLE + caller blocked target: serves the unblock stub", async () => {
      _setTestServiceClient(makeClient({ callerId: CALLER, blockState: "caller_blocked_target" }));
      const r = await get(path, true);
      assert.equal(r.status, 200);
      assert.equal(r.body.unavailable, true);
      assert.equal(r.body.isBlocker, true);
      assert.equal(r.body.handle, undefined);
    });

    it("UNREADABLE blocks: refuses with 503 degraded_unavailable and leaks no profile", async () => {
      _setTestServiceClient(makeClient({ callerId: CALLER, failTables: ["blocks"] }));
      const r = await get(path, true);
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.retryable, true);
      // The refusal must be a refusal, not an error page that still carried the
      // passport: none of the leaked fields may appear.
      assert.equal(r.body.handle, undefined);
      assert.equal(r.body.name, undefined);
      assert.equal(r.body.homeCity, undefined);
      assert.equal(r.body.unavailable, undefined);
    });

    it("UNAUTHENTICATED + unreadable blocks: still 200 — that branch never reads blocks", async () => {
      // Anti-vacuity. Without this, a fix that simply refused every request
      // would satisfy every outage assertion above.
      _setTestServiceClient(makeClient({ callerId: null, failTables: ["blocks"] }));
      const r = await get(path, false);
      assert.equal(r.status, 200);
      assert.equal(r.body.handle, HANDLE);
    });
  });
}
