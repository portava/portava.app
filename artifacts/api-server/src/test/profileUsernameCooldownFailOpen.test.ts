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
import { RESERVED_USERNAMES, USERNAME_RE } from "../lib/usernameRules.js";
import profileRouter from "../routes/profile.js";

const ME = "ee000000-0000-4000-a000-000000000055";
const OTHER = "ee000000-0000-4000-a000-000000000056";
const TOK = "tok-user";

const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

/** Read counter for the §23 alternatives fail-closed case below. */
let readCount = 0;

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

// ── §23 / G147 — "unavailable" is answered with ALTERNATIVES ─────────────────
//
// The census row (docs/architecture/census-input-intelligence.md, G147) read
// "No alternatives are ever suggested". This is the LIVE surface: both username
// entry points the app ships — app/profile/edit/identity.tsx and
// app/(auth)/onboarding.tsx — reach availability through
// hooks/useUsernameAvailability → services/profile.checkUsername → this
// endpoint. Before the change the response carried `available` and `reason` and
// nothing else, so there was no `alternatives` key for these assertions to read.
//
// MUTATION-PROOFS:
//   F. delete the `.filter((c) => !taken.has(c))` in suggestUsernameAlternatives
//      ⇒ "every offered handle is genuinely free" goes RED — the endpoint offers
//      a handle another profile already holds.
//   G. replace `if (error) return null` with a permissive empty list ⇒ the
//      unreadable-registry case goes RED: an outage would be answered with five
//      handles claimed free.

describe("§23 — a taken username comes back with alternatives (G147)", () => {
  it("HEALTHY: a taken name is answered with free alternatives", async () => {
    install({
      rows: {
        profiles: profiles({ username_updated_at: null }, [
          { id: OTHER, account_status: "active", username: "brandnewname" },
          // The first candidate is ALSO taken, so a generator that merely
          // appends suffixes without checking would be caught here.
          { id: "ee000000-0000-4000-a000-000000000057", account_status: "active", username: "brandnewname1" },
        ]),
      },
    });

    const res = await checkUsername("brandnewname");
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
    assert.ok(Array.isArray(res.body.alternatives), "an unavailable handle must carry alternatives");
    assert.ok(res.body.alternatives.length > 0, "at least one usable handle must be offered");
    assert.ok(
      !res.body.alternatives.includes("brandnewname"),
      "the handle the user typed is not an alternative to itself",
    );
    assert.ok(
      !res.body.alternatives.includes("brandnewname1"),
      "every offered handle is genuinely free — brandnewname1 is held by another profile",
    );
    assert.ok(res.body.alternatives.includes("brandnewname2"), "the next free candidate takes its place");
  });

  it("HEALTHY: a reserved name is also answered with alternatives", async () => {
    install({ rows: { profiles: profiles({ username_updated_at: null }) } });

    const res = await checkUsername("admin");
    assert.equal(res.body.available, false);
    assert.equal(res.body.reason, "That username is reserved");
    assert.ok(res.body.alternatives?.length > 0, "a reserved handle is unavailable too, and §23 answers it");
    for (const alt of res.body.alternatives) {
      assert.ok(!RESERVED_USERNAMES.has(alt), `${alt} must not itself be reserved`);
      assert.ok(USERNAME_RE.test(alt), `${alt} must satisfy the handle rules the write path enforces`);
    }
  });

  it("a FREE name carries no alternatives — there is nothing to replace", async () => {
    install({ rows: { profiles: profiles({ username_updated_at: null }) } });

    const res = await checkUsername("brandnewname");
    assert.equal(res.body.available, true);
    assert.equal(res.body.alternatives, undefined);
  });

  it("FAILS CLOSED: an unreadable registry offers NO alternatives, never free-looking ones", async () => {
    // EXACTLY the third `profiles` read, and no other. Read 1 is requireUser's
    // account_status ban gate and read 2 is the availability check — failing
    // either would answer 500 before the alternatives branch is reached, and the
    // assertion below would then pass off someone else's refusal. Read 3 IS the
    // alternatives lookup: the verdict must still arrive, WITHOUT offers.
    readCount = 0;
    install({
      rows: {
        profiles: profiles({ username_updated_at: null }, [
          { id: OTHER, account_status: "active", username: "brandnewname" },
        ]),
      },
      failOn: (ctx) => (ctx.table === "profiles" && (readCount += 1) === 3 ? READ_ERROR : null),
    });

    const res = await checkUsername("brandnewname");
    assert.equal(readCount, 3, `expected the alternatives read to be reached; saw ${readCount} profiles read(s)`);
    assert.equal(res.status, 200, "the availability verdict itself is unaffected");
    assert.equal(res.body.available, false, "the name is still taken");
    assert.equal(res.body.alternatives, undefined,
      "'these handles are free' may not be asserted out of a failed read");
  });
});
