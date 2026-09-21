/**
 * TV-1a — `POST /api/verification/session` upserts the row in `created` status.
 *
 * ── THE REQUIREMENT, AND WHY THE WORD IS THE WHOLE OF IT ────────────────────
 * `docs/trust/verified-foundation-plan.md` phase V-1 states the route "upserts
 * the row in `created` status", and `db/migrations/0161_identity_verification.sql`
 * writes the lifecycle into the schema twice — once as a comment,
 *
 *     -- created -> pending -> processing -> verified | failed | expired | canceled
 *
 * and once as the column default, `status text not null default 'created'`.
 * The route ignored both and inserted `"pending"` explicitly, so every session
 * in the table was born one state further along than it had reached: a row that
 * says the provider is working on the check when the user has not yet opened
 * the hosted flow.
 *
 * ── WHY THIS IS NOT COSMETIC, AND WHY IT IS ALSO NOT URGENT ─────────────────
 * Nothing distinguishes the two today — `created`, `pending` and `processing`
 * are all "live" to `uq_identity_verifications_active`, to the 23505 recovery
 * lookup in this same route, to `retention.ts` (which purges neither), and to
 * the client's poll. So this fix changes no behaviour, and this file does not
 * pretend otherwise. What it buys is that the FIRST consumer to care — a
 * funnel metric that asks how many sessions were opened but never started, the
 * `>2.0 attempts per verified user` measurement of V-6, or an abandonment
 * sweep — finds a column that means what the schema says it means, instead of
 * silently measuring zero of a state that is never written.
 *
 * ── WHAT WOULD TURN THIS RED ───────────────────────────────────────────────
 * Test 1 goes red if the insert writes any status but `created` — it reads the
 * value the route actually SENT, out of the double's recorded write, not out of
 * the source. Test 2 is the control that stops test 1 from being satisfied by a
 * status the schema would reject: it requires the written status to be one the
 * route's OWN active-session recovery query looks for, so a value outside the
 * live set (`"new"`, `"opened"`, a typo) fails even though it is not
 * `"pending"`. Test 3 is the no-regression control — the route still answers
 * 201 with the redirect URL, so "fix" by breaking the insert does not pass.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationSessionCreatedStatus.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import verificationRouter from "../routes/verification.js";

/**
 * The statuses `uq_identity_verifications_active` treats as a live attempt, and
 * the exact set the route's own 23505 recovery path queries
 * (`routes/verification.ts` — `.in("status", ["created", "pending", "processing"])`).
 * Spelled out here rather than imported because the point of test 2 is to hold
 * the route to a set it cannot edit from under the assertion.
 */
const LIVE_STATUSES = ["created", "pending", "processing"];

/**
 * A fresh user id per case: the session route is rate limited to 3 per 24 h per
 * user in an in-process counter that no hook resets, so re-using one id would
 * make the third case a 429 and the assertion would read as a route defect.
 */
let seq = 0;
function freshUser(): string {
  seq += 1;
  return `ee000000-0000-4000-a000-0000000000${String(seq).padStart(2, "0")}`;
}

function install(userId: string, token: string): FakeClientSpec {
  const spec: FakeClientSpec = {
    rows: {
      // account_status must be readable or requireUser's ban gate refuses
      // before the route is entered and the 403 would look like the defect.
      profiles: [{ id: userId, account_status: "active", verification_level: "none" }],
      identity_verifications: [],
    },
    users: { [token]: userId },
  };
  const client = makeFailClosedClient(spec);
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return spec;
}

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  // Without this shim the handler CRASHES on req.log.error and a 500-from-crash
  // would be mistaken for a route-level refusal.
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

async function createSession(token: string) {
  const res = await fetch(`${base}/verification/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ level: "id_selfie" }),
  });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
}

/** The status the route actually SENT, read out of the recorded insert. */
function insertedStatus(spec: FakeClientSpec): unknown {
  const writes = spec.inserted?.["identity_verifications"] ?? [];
  assert.equal(
    writes.length,
    1,
    "the route must issue exactly one identity_verifications insert — " +
      `it issued ${writes.length}, so the status assertion below would be measuring nothing`,
  );
  return writes[0]?.status;
}

describe("TV-1a: POST /verification/session writes the row in `created` status", () => {
  it("the inserted row's status is `created`, not `pending`", async () => {
    const user = freshUser();
    const token = `tok-${user}`;
    const spec = install(user, token);

    const res = await createSession(token);
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);

    assert.equal(
      insertedStatus(spec),
      "created",
      "verified-foundation-plan V-1 says the session row is upserted in `created`; " +
        "0161_identity_verification.sql makes `created` the column default and the first " +
        "state of the documented lifecycle. Writing `pending` at insert time means the " +
        "`created` state is never observed by anything, ever",
    );
  });

  it("CONTROL: the written status is one the route's own active-session recovery looks for", async () => {
    // Stops test 1 from being satisfiable by a status the live CHECK would
    // reject, or by one the 23505 branch could never find again. If the insert
    // ever writes a value outside this set, the unique index does not fire and
    // a user with a live session is told to start another one.
    const user = freshUser();
    const token = `tok-${user}`;
    const spec = install(user, token);

    await createSession(token);

    assert.ok(
      LIVE_STATUSES.includes(insertedStatus(spec) as string),
      `the session row must be born in one of ${JSON.stringify(LIVE_STATUSES)} — ` +
        `got ${JSON.stringify(insertedStatus(spec))}`,
    );
  });

  it("CONTROL: the route still answers 201 with a redirect URL", async () => {
    // A "fix" that broke the insert would satisfy neither of these.
    const user = freshUser();
    const token = `tok-${user}`;
    install(user, token);

    const res = await createSession(token);
    assert.equal(res.status, 201);
    assert.equal(typeof res.body.redirectUrl, "string");
    assert.ok(res.body.redirectUrl.length > 0, "the hosted-flow URL is what the client opens");
    assert.equal(typeof res.body.providerSessionId, "string");
  });
});
