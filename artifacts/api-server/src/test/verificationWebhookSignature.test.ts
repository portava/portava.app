/**
 * TV-P5 — privacy invariant 5: "Webhooks are signature-verified in every real
 * adapter; an unverified webhook throws, never silently accepts."
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS.
 *
 * The naive version of this test — "call handleWebhook with a bad signature and
 * assert it throws" — PASSES against the unimplemented stub, because the stub
 * throws `Error('Stripe Identity adapter not configured.')` from every method.
 * That is census-trust's own §4 trap: a test that cannot fail is worse than no
 * test. So every negative case here asserts the REASON for the throw
 * (`WebhookSignatureError` + a specific `code`), not merely that something was
 * thrown, and there is a positive case that a CORRECTLY signed webhook is
 * accepted and normalized — which no stub can satisfy.
 *
 * The last describe() quantifies the invariant over the set of real providers
 * the factory can return, rather than naming stripe and persona by hand, so a
 * third adapter added without signature verification turns this red.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { getIdentityProvider } from "../services/identityVerification/providers.js";
import {
  WebhookSignatureError,
  REAL_PROVIDER_NAMES,
} from "../services/identityVerification/webhookSignature.js";
import type { WebhookEvent } from "../services/identityVerification/types.js";

const SECRET = "whsec_test_2f0d0a1b5c7e";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build the `t=…,v1=…` header both vendors use, for an arbitrary secret. */
function signed(rawBody: string, secret: string, atSeconds: number): string {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${atSeconds}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${atSeconds},v1=${mac}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const STRIPE_VERIFIED_BODY = JSON.stringify({
  id: "evt_1NAbCdEf",
  type: "identity.verification_session.verified",
  data: {
    object: {
      id: "vs_1NAbCdEf",
      object: "identity.verification_session",
      status: "verified",
      last_verification_report: "vr_1NAbCdEf",
      options: { document: { require_matching_selfie: true } },
      verified_outputs: {
        dob: { day: 4, month: 7, year: 1990 },
        address: { country: "PH" },
      },
    },
  },
});

const PERSONA_COMPLETED_BODY = JSON.stringify({
  data: {
    type: "event",
    id: "evt_persona_1",
    attributes: {
      name: "inquiry.completed",
      payload: {
        data: {
          type: "inquiry",
          id: "inq_ABCDEF",
          attributes: {
            status: "completed",
            birthdate: "1990-07-04",
            "country-code": "PH",
          },
        },
      },
    },
  },
});

/** Everything a provider needs from an incoming request. */
function event(headerName: string, headerValue: string | undefined, rawBody: string): WebhookEvent {
  const headers: Record<string, string | string[] | undefined> = {};
  if (headerValue !== undefined) headers[headerName] = headerValue;
  return { headers, rawBody };
}

async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

// ── env isolation ────────────────────────────────────────────────────────────

let savedProvider: string | undefined;
let savedSecret: string | undefined;
let savedNodeEnv: string | undefined;

before(() => {
  savedProvider = process.env["IDENTITY_PROVIDER"];
  savedSecret = process.env["IDENTITY_WEBHOOK_SECRET"];
  savedNodeEnv = process.env["NODE_ENV"];
});

after(() => {
  if (savedProvider === undefined) delete process.env["IDENTITY_PROVIDER"];
  else process.env["IDENTITY_PROVIDER"] = savedProvider;
  if (savedSecret === undefined) delete process.env["IDENTITY_WEBHOOK_SECRET"];
  else process.env["IDENTITY_WEBHOOK_SECRET"] = savedSecret;
  if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = savedNodeEnv;
});

function useProvider(name: string): void {
  process.env["IDENTITY_PROVIDER"] = name;
  delete process.env["NODE_ENV"];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-vendor cases. Both vendors sign `${timestamp}.${rawBody}` with HMAC-SHA256
// and present it as `t=…,v1=…`; the header NAME is what differs.
// ─────────────────────────────────────────────────────────────────────────────

const VENDORS = [
  {
    name: "stripe",
    header: "stripe-signature",
    body: STRIPE_VERIFIED_BODY,
    expectedSessionId: "vs_1NAbCdEf",
  },
  {
    name: "persona",
    header: "persona-signature",
    body: PERSONA_COMPLETED_BODY,
    expectedSessionId: "inq_ABCDEF",
  },
] as const;

for (const vendor of VENDORS) {
  describe(`TV-P5: ${vendor.name} adapter verifies its webhook signature`, () => {
    it("ACCEPTS a correctly signed webhook and normalizes it (no stub can pass this)", async () => {
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      const result = await provider.handleWebhook(
        event(vendor.header, signed(vendor.body, SECRET, nowSec()), vendor.body),
      );

      assert.ok(result, "a correctly signed, relevant webhook must normalize to a result");
      assert.equal(result.provider, vendor.name);
      assert.equal(result.providerSessionId, vendor.expectedSessionId);
      assert.equal(result.status, "verified");
    });

    it("REJECTS a tampered body with signature_mismatch (signature covers the body)", async () => {
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      const t = nowSec();
      const header = signed(vendor.body, SECRET, t);
      const tampered = vendor.body.replace("PH", "US");
      assert.notEqual(tampered, vendor.body, "fixture must actually change");

      const err = await thrown(() => provider.handleWebhook(event(vendor.header, header, tampered)));
      assert.ok(err instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${String(err)}`);
      assert.equal((err as WebhookSignatureError).code, "signature_mismatch");
    });

    it("REJECTS a signature made with a different secret", async () => {
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      const header = signed(vendor.body, "whsec_attacker", nowSec());
      const err = await thrown(() => provider.handleWebhook(event(vendor.header, header, vendor.body)));
      assert.ok(err instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${String(err)}`);
      assert.equal((err as WebhookSignatureError).code, "signature_mismatch");
    });

    it("REJECTS a missing signature header", async () => {
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      const err = await thrown(() => provider.handleWebhook(event(vendor.header, undefined, vendor.body)));
      assert.ok(err instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${String(err)}`);
      assert.equal((err as WebhookSignatureError).code, "signature_header_missing");
    });

    it("REJECTS a malformed signature header (no v1 component)", async () => {
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      const err = await thrown(() =>
        provider.handleWebhook(event(vendor.header, `t=${nowSec()}`, vendor.body)),
      );
      assert.ok(err instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${String(err)}`);
      assert.equal((err as WebhookSignatureError).code, "signature_header_malformed");
    });

    it("REJECTS a replayed webhook whose timestamp is outside tolerance", async () => {
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      // Correctly signed — but for a timestamp two hours old. A captured
      // delivery must not be replayable forever.
      const stale = nowSec() - 2 * 60 * 60;
      const err = await thrown(() =>
        provider.handleWebhook(event(vendor.header, signed(vendor.body, SECRET, stale), vendor.body)),
      );
      assert.ok(err instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${String(err)}`);
      assert.equal((err as WebhookSignatureError).code, "signature_timestamp_out_of_tolerance");
    });

    it("REFUSES — does not accept — when no signing secret is configured", async () => {
      useProvider(vendor.name);
      delete process.env["IDENTITY_WEBHOOK_SECRET"];
      const provider = getIdentityProvider();

      // The dangerous implementation is "no secret set, so skip the check".
      // Unconfigured must fail CLOSED: the route turns this into a 400 and the
      // provider retries, rather than an unsigned body being written to
      // identity_verifications.
      const err = await thrown(() =>
        provider.handleWebhook(event(vendor.header, signed(vendor.body, SECRET, nowSec()), vendor.body)),
      );
      assert.ok(err instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${String(err)}`);
      assert.equal((err as WebhookSignatureError).code, "secret_not_configured");
    });

    it("REJECTS a PREFIX of the correct digest — comparison is length-checked, not startsWith", async () => {
      // Added because a mutation survived. Replacing the length check with
      // `expected.startsWith(offered)` passed all nineteen other assertions in
      // this file: every negative case offered a WRONG digest, and none offered
      // a SHORT but correct one. A prefix-accepting comparator is forgeable in
      // 16 guesses per byte, so the mutation that survived was the real bug.
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      const t = nowSec();
      const full = signed(vendor.body, SECRET, t).split("v1=")[1]!;
      for (const len of [2, 8, 32, full.length - 1]) {
        const err = await thrown(() =>
          provider.handleWebhook(event(vendor.header, `t=${t},v1=${full.slice(0, len)}`, vendor.body)),
        );
        assert.ok(
          err instanceof WebhookSignatureError,
          `${len}-char prefix of the correct digest must be rejected, got ${String(err)}`,
        );
        assert.equal((err as WebhookSignatureError).code, "signature_mismatch");
      }
    });

    it("REJECTS a non-hex digest of the right length (Buffer.from truncates silently)", async () => {
      // `Buffer.from("zz…", "hex")` does not throw — it stops at the first
      // non-hex character and returns a SHORT buffer, which would make
      // timingSafeEqual throw rather than return false if the byte lengths were
      // not re-checked after decoding.
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      const t = nowSec();
      const err = await thrown(() =>
        provider.handleWebhook(event(vendor.header, `t=${t},v1=${"z".repeat(64)}`, vendor.body)),
      );
      assert.ok(err instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${String(err)}`);
      assert.equal((err as WebhookSignatureError).code, "signature_mismatch");
    });

    it("does not leak the signing secret or the raw body in the error message", async () => {
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();

      const err = await thrown(() =>
        provider.handleWebhook(event(vendor.header, signed(vendor.body, "whsec_attacker", nowSec()), vendor.body)),
      );
      const msg = String((err as Error)?.message ?? "");
      assert.equal(msg.includes(SECRET), false, "error message must not contain the signing secret");
      assert.equal(msg.includes("1990"), false, "error message must not echo webhook payload contents");
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The invariant is "EVERY real adapter", so quantify over the set rather than
// over a hand-written list. Adding a third real provider without signature
// verification turns this red without anyone remembering to extend the file.
// ─────────────────────────────────────────────────────────────────────────────

describe("TV-P5: the invariant holds for every real provider the factory can return", () => {
  it("REAL_PROVIDER_NAMES is non-empty and excludes the mock", () => {
    assert.ok(REAL_PROVIDER_NAMES.length > 0, "there must be at least one real adapter");
    assert.equal(REAL_PROVIDER_NAMES.includes("mock" as never), false);
  });

  it("every real adapter refuses an unsigned body with a signature error", async () => {
    for (const name of REAL_PROVIDER_NAMES) {
      useProvider(name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();
      const err = await thrown(() =>
        provider.handleWebhook({ headers: {}, rawBody: '{"hello":"world"}' }),
      );
      assert.ok(
        err instanceof WebhookSignatureError,
        `${name}: unsigned webhook must raise WebhookSignatureError, got ${String(err)}`,
      );
    }
  });

  it("every real adapter reads its signature header case-insensitively", async () => {
    // Express lowercases incoming headers, but WebhookEvent.headers is a plain
    // record and nothing in the type enforces the case. An adapter that only
    // matches one spelling silently rejects (or, worse, silently accepts)
    // depending on how it was written.
    for (const vendor of VENDORS) {
      useProvider(vendor.name);
      process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
      const provider = getIdentityProvider();
      const upper = vendor.header
        .split("-")
        .map((p) => p[0]!.toUpperCase() + p.slice(1))
        .join("-");
      const result = await provider.handleWebhook(
        event(upper, signed(vendor.body, SECRET, nowSec()), vendor.body),
      );
      assert.ok(result, `${vendor.name}: header ${upper} must be accepted`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The adapter is only load-bearing if the throw reaches the public endpoint.
// census-trust §5: a behaviour must be wired to a REACHABLE CALLER, not merely
// exported. `webhookHandler` is what `app.ts` mounts at
// POST /api/verification/webhook, behind express.raw().
// ─────────────────────────────────────────────────────────────────────────────

describe("TV-P5: the signature refusal reaches POST /api/verification/webhook", () => {
  function makeRes() {
    const res = {
      statusCode: null as number | null,
      jsonBody: undefined as unknown,
      sendStatus(code: number) { res.statusCode = code; },
      status(code: number) { res.statusCode = code; return res; },
      json(body: unknown) { res.jsonBody = body; },
    };
    return res;
  }

  function makeReq(headers: Record<string, string>, rawBody: string) {
    return {
      headers,
      body: Buffer.from(rawBody, "utf8"),
      log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    } as any;
  }

  it("answers 400 invalid_signature for a forged Stripe delivery", async () => {
    useProvider("stripe");
    process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
    const { webhookHandler } = await import("../routes/verification.js");

    const res = makeRes();
    await webhookHandler(
      makeReq(
        { "stripe-signature": signed(STRIPE_VERIFIED_BODY, "whsec_attacker", nowSec()) },
        STRIPE_VERIFIED_BODY,
      ),
      res,
    );

    assert.equal(res.statusCode, 400, "a forged signature must not be accepted");
    assert.equal((res.jsonBody as any)?.error, "invalid_signature");
  });

  it("answers 400 invalid_signature when the endpoint secret is unset", async () => {
    // The deployment that has not been configured yet is the one where a
    // bypass would be reached. It must refuse, not accept.
    useProvider("persona");
    delete process.env["IDENTITY_WEBHOOK_SECRET"];
    const { webhookHandler } = await import("../routes/verification.js");

    const res = makeRes();
    await webhookHandler(
      makeReq(
        { "persona-signature": signed(PERSONA_COMPLETED_BODY, SECRET, nowSec()) },
        PERSONA_COMPLETED_BODY,
      ),
      res,
    );

    assert.equal(res.statusCode, 400);
    assert.equal((res.jsonBody as any)?.error, "invalid_signature");
  });

  it("CONTROL: a correctly signed delivery gets PAST signature verification", async () => {
    // Without this control the two assertions above are satisfied by an adapter
    // that rejects everything. This one proves the gate is a gate and not a
    // wall. It does NOT assert 200: persistResult runs next and this suite has
    // no database, so the only claim is that the refusal was not the signature.
    useProvider("stripe");
    process.env["IDENTITY_WEBHOOK_SECRET"] = SECRET;
    const { webhookHandler } = await import("../routes/verification.js");

    const res = makeRes();
    await webhookHandler(
      makeReq(
        { "stripe-signature": signed(STRIPE_VERIFIED_BODY, SECRET, nowSec()) },
        STRIPE_VERIFIED_BODY,
      ),
      res,
    );

    assert.notEqual(res.statusCode, 400, "a correctly signed delivery must not be called forged");
    assert.equal((res.jsonBody as any)?.error, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A HOLE IN THE GUARD ABOVE, CLOSED.
//
// The "every real provider" suite iterates REAL_PROVIDER_NAMES, which is a
// hand-maintained list in webhookSignature.ts. If a third adapter is added to
// the factory and NOT added to that list, the suite keeps passing while saying
// "every real adapter" — it would be quantifying over a set that no longer
// matches the thing it claims to quantify over. That is the same defect
// census-trust §12.9 reported against its own migration parser: a guard that
// agrees with the thing it is checking.
//
// So the list is checked against its two sources of truth: the declared
// provider vocabulary in types.ts, and the factory's own dispatch branches read
// out of providers.ts. Source-reading is deliberate — the factory returns one
// adapter per call and no runtime API enumerates its branches.
// ─────────────────────────────────────────────────────────────────────────────

describe("TV-P5: REAL_PROVIDER_NAMES cannot drift from the factory it quantifies over", () => {
  const SRC_DIR = new URL("../services/identityVerification/", import.meta.url);

  async function source(file: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return readFile(new URL(file, SRC_DIR), "utf8");
  }

  it("covers every non-mock member of the declared VerificationProviderName union", async () => {
    const types = await source("types.ts");
    const decl = /export type VerificationProviderName\s*=([^;]+);/.exec(types);
    assert.ok(decl, "VerificationProviderName must still be a declared union in types.ts");
    const declared = [...decl[1]!.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    assert.ok(declared.includes("mock"), `parser sanity: expected 'mock' among ${declared.join(",")}`);

    const realDeclared = declared.filter((n) => n !== "mock").sort();
    assert.deepEqual(
      [...REAL_PROVIDER_NAMES].sort(),
      realDeclared,
      "a provider declared in types.ts but missing from REAL_PROVIDER_NAMES is a real adapter this suite never checks",
    );
  });

  it("covers every non-mock branch the factory can actually return", async () => {
    const providers = await source("providers.ts");
    // `if (name === 'stripe') return stripeProvider;`
    const branches = [...providers.matchAll(/name\s*===\s*'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    assert.ok(branches.includes("mock"), `parser sanity: expected a 'mock' branch among ${branches.join(",")}`);

    const realBranches = [...new Set(branches.filter((n) => n !== "mock"))].sort();
    assert.deepEqual(
      [...REAL_PROVIDER_NAMES].sort(),
      realBranches,
      "the factory can return an adapter this suite's 'every real adapter' claim does not cover",
    );
  });
});
