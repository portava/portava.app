/**
 * POST /users/me/close-friends — two reads whose failure was reported as a fact
 * about the caller's relationships.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *     const { data: profile }   = await sc.from("profiles")…      // error unbound
 *     if (!profile)   → 404 "User not found"
 *     const { data: followRow } = await sc.from("user_follows")…  // error unbound
 *     if (!followRow) → 403 "You must follow this user before adding them to Close Friends"
 *
 * supabase-js RESOLVES on a database error, so `data` is null both when the row
 * is genuinely absent and when the read never happened, and each check spent
 * those two outcomes on the same refusal. The DIRECTION is safe — nobody is
 * added to a Close Friends audience by a read that failed — but the STATEMENT
 * is false and specific: "that user does not exist" about a user who does, and
 * "you must follow this user" to somebody who already follows them. Close
 * Friends is the audience for a user's most restricted stories
 * (lib/mediaAccess.ts `isCloseFriend`, routes/stories.ts), so a fabricated claim
 * about the caller's own follow edge is not a cosmetic wording problem.
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ──────────────────────────────
 *   - Exact statuses with exact error codes. `!== 200` would pass on a crash.
 *   - Each outage case is PAIRED with the readable case whose answer it used to
 *     be indistinguishable from: the genuinely-missing user must STILL be 404,
 *     and the genuine non-follower must STILL be 403. Without those two, a fix
 *     that returned 503 unconditionally would pass.
 *   - The `profiles` error is keyed on the PROJECTED COLUMN (`id`), not the
 *     table. `requireUser` reads `profiles.account_status` on every
 *     authenticated request and refuses with the same 503 `degraded_unavailable`
 *     (lib/http.ts) — failing the whole table would make this assertion pass
 *     without the guard under test ever running. That is the measured false
 *     green from commit 38eba369 and it is avoided here by construction; the
 *     "profiles read fails" case additionally asserts the guard's own message
 *     text so it cannot be requireUser's refusal wearing the same code.
 *   - `req.log` IS shimmed: both new guards log before refusing.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/friendCloseFriendsAddOutage.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const CALLER = "aaaaaaaa-6666-6666-6666-666666666666";
const FRIEND = "bbbbbbbb-7777-7777-7777-777777777777";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

interface Opts {
  profileExists: boolean;
  followExists: boolean;
  /** Keys are `table` or `table:projectedColumn`. */
  errors?: Record<string, { code: string; message: string }>;
}

function makeClient(o: Opts) {
  const errors = o.errors ?? {};
  const builder = (table: string): any => {
    let projection = "";
    let op = "select";
    const errFor = () =>
      errors[`${table}:${projection.replace(/\s/g, "")}`] ??
      Object.entries(errors).find(([k]) => {
        const [t, col] = k.split(":");
        return t === table && (col === undefined || projection.split(",").map((c) => c.trim()).includes(col));
      })?.[1] ??
      null;

    const settle = () => {
      const e = errFor();
      if (e) return { data: null, error: e };
      if (op !== "select") return { data: null, error: null };
      if (table === "profiles") {
        if (projection.includes("account_status")) return { data: { account_status: "active" }, error: null };
        return { data: o.profileExists ? { id: FRIEND } : null, error: null };
      }
      if (table === "user_follows") return { data: o.followExists ? { following_id: FRIEND } : null, error: null };
      return { data: null, error: null };
    };

    const b: any = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(settle()).then(res, rej);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(settle());
        if (prop === "select") return (cols?: string) => { projection = cols ?? ""; return b; };
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
          return (..._a: any[]) => { op = String(prop); return b; };
        }
        return (..._a: any[]) => b;
      },
    });
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: CALLER } }, error: null }) },
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
  const { default: cfRouter } = await import("../routes/closeFriends.js");
  app.use(cfRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); _clearTestClient(); _setTestServiceClient(null); });

function post(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/users/me/close-friends`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("POST /users/me/close-friends", () => {
  it("both reads succeed and both rows exist: 200 ok", async () => {
    install({ profileExists: true, followExists: true });
    const r = await post({ userId: FRIEND });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("target genuinely absent: still 404 not_found", async () => {
    install({ profileExists: false, followExists: true });
    const r = await post({ userId: FRIEND });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
  });

  it("caller genuinely does not follow: still 403 forbidden", async () => {
    install({ profileExists: true, followExists: false });
    const r = await post({ userId: FRIEND });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("profiles existence read FAILS: 503, not 'User not found'", async () => {
    // Keyed on the projected `id`, NOT the whole table: requireUser's
    // `account_status` read must keep working or this route is never reached.
    install({ profileExists: true, followExists: true, errors: { "profiles:id": DB_ERROR } });
    const r = await post({ userId: FRIEND });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    // This message belongs to THIS guard. requireUser's own 503 carries a
    // different one, so the assertion proves the request reached the route.
    assert.match(String(r.body.message), /could not verify that user/i);
  });

  it("user_follows read FAILS: 503, not 'you must follow this user'", async () => {
    install({ profileExists: true, followExists: true, errors: { user_follows: DB_ERROR } });
    const r = await post({ userId: FRIEND });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.match(String(r.body.message), /could not verify your follow relationship/i);
  });
});
