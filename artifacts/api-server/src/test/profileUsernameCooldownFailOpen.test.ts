/**
 * USERNAME CHANGES — an unreadable restriction is not an absent restriction,
 * and "I could not check" is not "it is available".
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error. Three reads on the username path
 * bound only `data`, so a failed query and an empty result were the same value,
 * and at every one of them the empty result is the PERMISSIVE answer:
 *
 *   1. PATCH /me/profile — the 30-day cooldown reads
 *      `profiles.username_updated_at` and enforces only `if (currentProfile?.
 *      username_updated_at && …)`. An unreadable row therefore SKIPPED the
 *      cooldown entirely. The restriction vanished exactly when the table could
 *      not be read.
 *   2. PATCH /me/profile — the uniqueness check reads whether anyone else holds
 *      the name. An unreadable row read as "nobody does". The live schema's
 *      `profiles_username_lower_unique` backstops the correctness half, so the
 *      UPDATE would fail 23505 rather than mint a duplicate — but the caller
 *      was handed a raw constraint error instead of "that name is taken", after
 *      the same failed read had already waived their cooldown.
 *   3. GET /users/check-username answered `{ available: true }`. That is a
 *      wrong statement the user will act on, and acting on it is expensive:
 *      the PATCH it leads to is behind the 30-day cooldown, so a name this
 *      endpoint calls free and the PATCH then rejects costs them a month.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 * "Nobody holds this name" and "the table could not be read" produce the same
 * `data: null`, so every failure case here is paired with a healthy one where
 * the row is PRESENT and readable — a cooldown that genuinely applies, a name
 * that is genuinely taken, and a name that is genuinely free. A change that
 * refused every username operation would satisfy all three failure assertions
 * and would break the feature; those three healthy cases are what stop it.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/profileUsernameCooldownFailOpen.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import profileRouter from "../routes/profile.js";

const ME = "ee000000-0000-4000-a000-000000000055";
const OTHER = "ee000000-0000-4000-a000-000000000056";
const TOK = "tok-user";

const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

/** Changed 3 days ago — well inside the 30-day cooldown. */
const RECENTLY_CHANGED = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
/** Changed 400 days ago — the cooldown has long expired. */
const LONG_AGO = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();

function install(spec: FakeClientSpec) {
  spec.users = { [TOK]: ME };
  const client = makeFailClosedClient(spec);
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return client;
}

function profiles(mine: Record<string, any>, others: Record<string, any>[] = []) {
  return [
    { id: ME, account_status: "active", username: "olduser", handle: "olduser", ...mine },
    ...others,
  ];
}

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  // Without the shim these handlers CRASH on req.log.error and a
  // 500-from-crash would masquerade as the refusal under test.
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", profileRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(() => { server.close(); });

async function patchUsername(username: string) {
  const res = await fetch(`${base}/me/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOK}` },
    body: JSON.stringify({ username }),
  });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
}

async function checkUsername(username: string) {
  const res = await fetch(`${base}/users/check-username?username=${encodeURIComponent(username)}`, {
    headers: { authorization: `Bearer ${TOK}` },
  });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
}

describe("username cooldown: an unread restriction is not an absent one", () => {
  it("HEALTHY: a recent change inside the window is refused with rate_limited", async () => {
    install({ rows: { profiles: profiles({ username_updated_at: RECENTLY_CHANGED }) } });

    const res = await patchUsername("brandnewname");
    assert.equal(res.status, 429, "assert the CODE — a 400 would mean the request died at validation");
    assert.equal(res.body.error, "rate_limited");
  });

  it("HEALTHY: a change outside the window is allowed through the cooldown gate", async () => {
    const spec: FakeClientSpec = {
      rows: { profiles: profiles({ username_updated_at: LONG_AGO }) },
    };
    install(spec);

    const res = await patchUsername("brandnewname");
    assert.notEqual(res.status, 429, "an expired cooldown must not block the change");
    assert.equal(res.status, 200, "and the change must actually go through");
  });

  it("FAILS CLOSED: an unreadable profiles row does not waive the cooldown", async () => {
    let reads = 0;
    install({
      rows: { profiles: profiles({ username_updated_at: RECENTLY_CHANGED }) },
      failOn: (ctx) => {
        if (ctx.table !== "profiles") return null;
        reads += 1;
        // EXACTLY the second `profiles` read, and no other. The first is
        // requireUser's account_status ban gate, whose 503 would be mistaken
        // for this refusal. The THIRD is the sibling username-availability
        // read, which has its own fail-closed branch — failing it too made this
        // case pass off that branch instead, and the hand-revert of the
        // cooldown fix stayed GREEN. One read, one gate, one reason.
        return reads === 2 ? READ_ERROR : null;
      },
    });

    const res = await patchUsername("brandnewname");
    // Reaching read 2 is reaching the cooldown read. It must not go FURTHER:
    // the fix returns right there, so a 3rd read would mean the cooldown gate
    // was passed and some later branch is answering instead.
    assert.equal(reads, 2, `expected the handler to stop AT the cooldown read; saw ${reads} profiles read(s)`);
    assert.equal(res.status, 500, "a cooldown that could not be read must not be treated as expired");
    assert.equal(res.body.error, "db_error");
    // NOTE: the message cannot discriminate — lib/errorEnvelope.ts replaces a
    // db_error detail with a generic string. The `reads === 2` assertion above
    // is what proves this refusal is the COOLDOWN's and not the sibling
    // availability check's: with the cooldown fix hand-reverted the handler
    // reads on past it (3+ reads) and answers 200.
  });
});

describe("username availability: 'could not check' is not 'available'", () => {
  it("HEALTHY: a name held by someone else reports taken", async () => {
    install({
      rows: {
        profiles: profiles({ username_updated_at: null }, [
          { id: OTHER, account_status: "active", username: "brandnewname" },
        ]),
      },
    });

    const res = await checkUsername("brandnewname");
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
  });

  it("HEALTHY: a free name reports available", async () => {
    install({ rows: { profiles: profiles({ username_updated_at: null }) } });

    const res = await checkUsername("brandnewname");
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true, "a genuinely free name must still come back free");
  });

  it("FAILS CLOSED: an unreadable profiles is not reported as 'available'", async () => {
    let reads = 0;
    install({
      rows: {
        // The name IS taken. Only the read fails, so "there was nothing to
        // find" is not an available reading of the result.
        profiles: profiles({ username_updated_at: null }, [
          { id: OTHER, account_status: "active", username: "brandnewname" },
        ]),
      },
      failOn: (ctx) => {
        if (ctx.table !== "profiles") return null;
        reads += 1;
        return reads >= 2 ? READ_ERROR : null;
      },
    });

    const res = await checkUsername("brandnewname");
    assert.ok(reads >= 2, `expected the handler to reach the availability read; saw ${reads}`);
    assert.equal(res.status, 500, "assert the CODE: 200 here is the endpoint making a claim it cannot support");
    assert.equal(res.body.error, "db_error");
    assert.notEqual(
      res.body.available,
      true,
      "calling a taken name free costs the user 30 days when the PATCH then rejects it",
    );
  });
});
