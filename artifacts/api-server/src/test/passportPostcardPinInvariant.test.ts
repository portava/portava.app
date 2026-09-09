/**
 * passportPostcardPinInvariant — "pinning enforces one-per-user" is enforced by
 * ONE statement, and that statement's result was thrown away.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * PATCH /api/passport/postcards/:id with `{ pin: true }` did:
 *
 *     await client.from("passport_postcards")
 *       .update({ pinned_at: null })
 *       .eq("user_id", user.id)
 *       .not("id", "eq", postcardId);        // result DISCARDED
 *     patch.pinned_at = new Date().toISOString();
 *
 * There is no unique index behind the one-pin rule — the route's own docblock
 * ("Pinning enforces one-per-user") is a promise kept solely by that clear.
 * supabase-js RESOLVES on a database error, and this statement bound nothing at
 * all, so a failed clear fell straight through: the new pin was written anyway
 * and the owner received a 200 with TWO pinned postcards. The invariant was
 * broken and the break was reported as success.
 *
 * ── HOW THIS IS MEASURED, NOT ASSUMED ───────────────────────────────────────
 * BOTH statements in this handler write `passport_postcards`, and the fake's
 * `failWritesOn` hook keys on the TABLE only — failing the table wholesale
 * would also fail the SECOND update, which already checks its error, so the
 * pre-fix code would refuse for the wrong reason and the test would be a false
 * green. So the failure is injected on exactly one STATEMENT: the client
 * delegates to `makeFailClosedClient` (the contract-checked double) and only
 * overrides the settle of the update whose payload is the clear-others shape
 * `{ pinned_at: null }`. Everything else, including the second update, runs
 * against the real double.
 *
 * Test 1 is the control on the same seed: healthy, the clear IS issued and the
 * pin lands — so the fixture provably exercises the statement being failed.
 * The 500 in test 2 is asserted by exact status AND error code, so a crash
 * (which the real app.js error handler would also render) cannot be mistaken
 * for the refusal.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD_A = "11111111-1111-4111-8111-111111111111";
const CARD_B = "22222222-2222-4222-8222-222222222222";
const TOKEN = "tok-owner";

function seed(): FakeClientSpec {
  return {
    rows: {
      profiles: [{ id: OWNER, username: "o", account_status: "active" }],
      passport_postcards: [
        { id: CARD_A, user_id: OWNER, pinned_at: null, note: null, visibility: "public" },
        { id: CARD_B, user_id: OWNER, pinned_at: "2026-01-01T00:00:00Z", note: null, visibility: "public" },
      ],
    },
    users: { [TOKEN]: OWNER },
  };
}

/** The clear-others UPDATE — the only statement whose payload is exactly `{ pinned_at: null }`. */
function isClearOthers(payload: any): boolean {
  return payload
    && Object.keys(payload).length === 1
    && Object.prototype.hasOwnProperty.call(payload, "pinned_at")
    && payload.pinned_at === null;
}

function client(spec: FakeClientSpec, failClearOthers: boolean) {
  const base = makeFailClosedClient(spec);
  if (!failClearOthers) return base;
  const realFrom = base.from.bind(base);
  base.from = (table: string) => {
    const b = realFrom(table);
    if (table !== "passport_postcards") return b;
    let payload: any = null;
    const realUpdate = b.update.bind(b);
    const realThen = b.then.bind(b);
    b.update = (p: any, o?: any) => { payload = p; return realUpdate(p, o); };
    b.then = (onF: any, onR: any) =>
      isClearOthers(payload)
        ? Promise.resolve({
            data: null,
            error: { message: "connection terminated unexpectedly", code: "57P01" },
            count: null,
          }).then(onF, onR)
        : realThen(onF, onR);
    return b;
  };
  return base;
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

async function pin(): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/passport/postcards/${CARD_A}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ pin: true }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("1. control: a healthy pin clears the other pin and succeeds", async () => {
  const s = seed();
  _setTestClient(client(s, false), true);
  const { status, body } = await pin();
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

  const writes = s.updated?.passport_postcards ?? [];
  assert.equal(writes.length, 2, "both statements ran: the clear, then the pin");
  assert.ok(
    writes.some(isClearOthers),
    "the clear-others statement IS issued on this path — so failing it below is meaningful",
  );
  assert.ok(
    writes.some((w: any) => typeof w.pinned_at === "string"),
    "…and the new pin is written",
  );
});

test("2. a failed clear-others must not still write the new pin and report 200", async () => {
  const s = seed();
  _setTestClient(client(s, true), true);
  const { status, body } = await pin();

  assert.equal(status, 500, `expected 500, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "db_error", "an exact code — a crash would not be this one");

  const writes = s.updated?.passport_postcards ?? [];
  assert.equal(
    writes.filter((w: any) => typeof w.pinned_at === "string").length, 0,
    "the new pin must NOT be written when the previous pin could not be cleared — " +
      "that is how the owner ended up with two pinned postcards and a 200",
  );
});

test("3. unpinning is unaffected — it issues no clear-others at all", async () => {
  const s = seed();
  _setTestClient(client(s, true), true);
  const r = await fetch(`${baseUrl}/api/passport/postcards/${CARD_A}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ note: "just a note" }),
  });
  assert.equal(r.status, 200, "a patch that does not pin never touches the invariant");
});
