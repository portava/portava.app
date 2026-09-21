/**
 * GET /api/verification/status — "you are not verified" must be a READ, not a
 * read FAILURE.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * The handler reported the caller's verification level from
 *
 *     const { data: profile } = await sc.from("profiles")
 *       .select("verification_level, verified_at").eq("id", user.id).maybeSingle();
 *     …
 *     verificationLevel: (profile as any)?.verification_level ?? "none",
 *
 * `error` was never bound. supabase-js RESOLVES on a database error, so an
 * unreadable `profiles` and a user who has genuinely never verified both arrive
 * as `data: null`, and `?? "none"` collapsed them into the same answer.
 *
 * ── WHY THE DIRECTION MATTERS HERE ──────────────────────────────────────────
 * ID verification is not cosmetic in this system: routes/rentABuddyRollout.ts
 * refuses a booking outright when MVP mode is engaged and the travelling party
 * is not ID-verified, and lib/travelerVerification.ts derives `idVerified` from
 * exactly this `verification_level` column. So a client that reads "none" out
 * of a transient hiccup and caches it shows a verified user a verification wall
 * on a surface they are entitled to. It is also, plainly, a false statement
 * about a person that they have no way to act on — they cannot re-verify their
 * way out of a database error, and the route offers them nothing that would
 * tell them so.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 * "This user is genuinely unverified" and "this user's profile could not be
 * read" are the two cases that used to be one, so both are asserted here
 * alongside the verified case. A fix that refused every status poll would
 * satisfy the failure assertion and would break the verification screen for
 * everyone; the two healthy cases are what stop that.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationStatusUnreadableProfile.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import verificationRouter from "../routes/verification.js";

const ME = "cc000000-0000-4000-a000-000000000033";
const TOK = "tok-verif";
const VERIFIED_AT = "2026-05-01T00:00:00.000Z";

const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

function install(spec: FakeClientSpec) {
  spec.users = { [TOK]: ME };
  const client = makeFailClosedClient(spec);
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return client;
}

function profileRow(extra: Record<string, any>) {
  // account_status must be readable or requireUser's ban gate refuses before
  // the route is ever entered, and the 503 would be mistaken for the fix.
  return { id: ME, account_status: "active", ...extra };
}

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  // Without this shim the handler CRASHES on req.log.error and a
  // 500-from-crash would masquerade as the fail-closed refusal being tested.
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", verificationRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(() => { server.close(); });

async function status() {
  const res = await fetch(`${base}/verification/status`, {
    headers: { authorization: `Bearer ${TOK}` },
  });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
}

describe("GET /verification/status", () => {
  it("HEALTHY: a verified profile reports its level", async () => {
    install({
      rows: {
        profiles: [profileRow({ verification_level: "id_selfie", verified_at: VERIFIED_AT })],
        identity_verifications: [
          { id: "v1", user_id: ME, status: "verified", created_at: "2026-05-01T00:00:00.000Z" },
        ],
      },
    });

    const res = await status();
    assert.equal(res.status, 200);
    assert.equal(res.body.verificationLevel, "id_selfie");
    assert.equal(res.body.verifiedAt, VERIFIED_AT);
  });

  it("HEALTHY: a genuinely unverified profile reports 'none'", async () => {
    install({
      rows: {
        profiles: [profileRow({ verification_level: null, verified_at: null })],
        identity_verifications: [],
      },
    });

    const res = await status();
    assert.equal(res.status, 200, "an unverified user must still get an answer");
    assert.equal(res.body.verificationLevel, "none");
    assert.equal(res.body.verifiedAt, null);
    assert.equal(res.body.verificationRow, null);
  });

  it("FAILS CLOSED: an unreadable profiles row is not reported as 'none'", async () => {
    // The user IS verified, so no "there was nothing to find" reading of the
    // result is available. requireUser reads `profiles` too and must SUCCEED,
    // or its ban gate answers 503 before the handler runs and the refusal would
    // not be the one under test. The two reads are distinguished by column,
    // which the double deliberately does not model, so they are distinguished
    // by ORDER instead: the ban gate reads first.
    let profileReads = 0;
    install({
      rows: {
        profiles: [profileRow({ verification_level: "id_selfie", verified_at: VERIFIED_AT })],
        identity_verifications: [
          { id: "v1", user_id: ME, status: "verified", created_at: "2026-05-01T00:00:00.000Z" },
        ],
      },
      failOn: (ctx) => {
        if (ctx.table !== "profiles") return null;
        profileReads += 1;
        // 1st = requireUser's account_status gate (must succeed).
        // 2nd = this handler's verification-level read (fails).
        return profileReads >= 2 ? READ_ERROR : null;
      },
    });

    const res = await status();
    assert.ok(profileReads >= 2, `expected the handler to reach its profiles read; saw ${profileReads}`);
    assert.equal(
      res.status,
      500,
      "assert the CODE: a 401/503 here would be the ban gate answering, not the verification read",
    );
    assert.equal(res.body.error, "db_error");
    assert.notEqual(
      res.body.verificationLevel,
      "none",
      "telling a verified person they are unverified is a false statement they cannot act on",
    );
  });
});
