/**
 * AN UNPROCESSABLE VERIFICATION WEBHOOK MUST NOT BE ANSWERED "HANDLED".
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * verified-foundation-plan.md, privacy invariant 5: "Webhooks are
 * signature-verified in every real adapter; an unverified webhook THROWS, NEVER
 * SILENTLY ACCEPTS." Trust architecture upgrade v2 TRV2-05 restates the
 * production half: "Mock provider is refused in production."
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Those two rules met in one branch and cancelled each other out.
 * `getIdentityProvider()` THROWS when the configured provider cannot be used —
 * which in production is the normal, correct, designed behaviour for the
 * default `IDENTITY_PROVIDER=mock` (providers.ts:105-111, the mechanism that
 * satisfies invariant 4). `webhookHandler` caught that throw, discarded it
 * unbound, and answered **200** under the comment "provider not configured;
 * treat as irrelevant".
 *
 * 200 is not "irrelevant" to a provider. Stripe Identity and Persona both treat
 * a 2xx as final delivery and stop retrying. So on the one deployment where the
 * refusal is load-bearing, the public webhook endpoint accepted every event,
 * wrote nothing, logged nothing, and told the provider the result had been
 * handled. A verification a user paid for would be gone with no trace on either
 * side — the exact failure audit H5 fixed for the PERSIST path (5xx so the
 * provider retries) left open one branch earlier.
 *
 * "Never silently accepts" is a statement about the RESPONSE, not only about
 * the adapter. This file measures the response.
 *
 * ── WHY 503 AND NOT 400 ─────────────────────────────────────────────────────
 * 400 is reserved, and already used, for a signature that FAILED
 * (verification.ts webhookHandler's handleWebhook catch). A provider that is
 * not configured is a fault on this side; the event is valid and unread. 5xx is
 * the class that means "retry me", and it matches the persist-failure branch
 * below it, so a provider's dead-letter queue collects the events instead of
 * this server destroying them.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationWebhookProviderUnavailable.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webhookHandler } from "../routes/verification.js";
import { getIdentityProvider } from "../services/identityVerification/providers.js";

interface FakeRes {
  statusCode: number | null;
  jsonBody: unknown;
  sendStatus(code: number): void;
  status(code: number): FakeRes;
  json(body: unknown): void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    jsonBody: undefined,
    sendStatus(code: number) { res.statusCode = code; },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.jsonBody = body; },
  };
  return res;
}

function makeReq(logged: { error: unknown[][]; warn: unknown[][] }) {
  return {
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ sessionId: "mock_whatever", outcome: "approve" })),
    log: {
      error: (...a: unknown[]) => { logged.error.push(a); },
      warn:  (...a: unknown[]) => { logged.warn.push(a); },
      info:  () => {},
      debug: () => {},
    },
  } as any;
}

const ORIGINAL_PROVIDER = process.env["IDENTITY_PROVIDER"];
const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];

afterEach(() => {
  if (ORIGINAL_PROVIDER === undefined) delete process.env["IDENTITY_PROVIDER"];
  else process.env["IDENTITY_PROVIDER"] = ORIGINAL_PROVIDER;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
});

describe("verification webhook when the provider factory refuses", () => {
  it("PROOF OF PREMISE: the factory really does throw for mock in production", () => {
    process.env["NODE_ENV"] = "production";
    process.env["IDENTITY_PROVIDER"] = "mock";
    assert.throws(
      () => getIdentityProvider(),
      /not allowed in production/,
      "invariant 4 is the mechanism this test depends on; if it stops throwing, this test proves nothing",
    );
  });

  it("mock refused in production: answers 5xx, not 200", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["IDENTITY_PROVIDER"] = "mock";
    const logged = { error: [] as unknown[][], warn: [] as unknown[][] };
    const res = makeRes();

    await webhookHandler(makeReq(logged), res);

    assert.notEqual(
      res.statusCode,
      200,
      "200 tells the provider the event was handled and stops its retries; the event was not handled",
    );
    assert.ok(
      res.statusCode !== null && res.statusCode >= 500 && res.statusCode < 600,
      `expected a 5xx so the provider retries or dead-letters; got ${res.statusCode}`,
    );
  });

  it("mock refused in production: the refusal is LOGGED, not discarded", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["IDENTITY_PROVIDER"] = "mock";
    const logged = { error: [] as unknown[][], warn: [] as unknown[][] };

    await webhookHandler(makeReq(logged), makeRes());

    assert.ok(
      logged.error.length > 0,
      "the catch bound no error and logged nothing, so a production deployment discarding every " +
        "KYC webhook produced no operator signal at all",
    );
  });

  it("an unknown IDENTITY_PROVIDER is the same refusal, in any environment", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["IDENTITY_PROVIDER"] = "not-a-provider";
    const logged = { error: [] as unknown[][], warn: [] as unknown[][] };
    const res = makeRes();

    await webhookHandler(makeReq(logged), res);

    assert.ok(
      res.statusCode !== null && res.statusCode >= 500,
      `a misconfigured provider name must not be reported as handled; got ${res.statusCode}`,
    );
  });

  it("CONTROL: a configured provider still reaches the adapter and answers 200 on an irrelevant event", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["IDENTITY_PROVIDER"] = "mock";
    const logged = { error: [] as unknown[][], warn: [] as unknown[][] };
    const res = makeRes();

    // A body the mock adapter normalizes to null (no sessionId) — a genuinely
    // irrelevant event, which SHOULD be acknowledged. Without this control the
    // fix could be "always 5xx", which would break every real delivery.
    const req = makeReq(logged);
    req.body = Buffer.from(JSON.stringify({ hello: "world" }));

    await webhookHandler(req, res);

    assert.equal(res.statusCode, 200, "an event the adapter deliberately ignores is still handled");
  });
});
