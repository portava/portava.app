/**
 * lib/paymentsMode.ts — key-prefix classification and the live-mode decision.
 *
 * Pure unit tests: no env is read except the object passed in, no fetch.
 * The provider call sites that USE this decision are pinned end to end in
 * src/test/paymentsLiveGuard.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/paymentsMode.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyProviderKey,
  liveAllowed,
  evaluateProviderKey,
  assertProviderKeyAllowed,
  assertWebhookLivemodeAllowed,
  PaymentsLiveModeRefusedError,
  paymentsStartupSummary,
  mockIdentityPermitted,
} from "../lib/paymentsMode.js";

describe("classifyProviderKey", () => {
  it("Stripe: sk_test_/rk_test_ are test, sk_live_/rk_live_ are live, everything else unknown", () => {
    assert.equal(classifyProviderKey("stripe", "sk_test_abc"), "test");
    assert.equal(classifyProviderKey("stripe", "rk_test_abc"), "test");
    assert.equal(classifyProviderKey("stripe", "sk_live_abc"), "live");
    assert.equal(classifyProviderKey("stripe", "rk_live_abc"), "live");
    for (const k of ["pk_test_abc", "pk_live_abc", "whsec_abc", "sk_abc", "SK_TEST_abc", " sk_test_abc", "", "persona_sandbox_x"]) {
      assert.equal(classifyProviderKey("stripe", k), "unknown", k);
    }
    assert.equal(classifyProviderKey("stripe", undefined), "unknown");
  });

  it("Persona: persona_sandbox_ is test, persona_production_ is live, everything else unknown", () => {
    assert.equal(classifyProviderKey("persona", "persona_sandbox_abc"), "test");
    assert.equal(classifyProviderKey("persona", "persona_production_abc"), "live");
    for (const k of ["sk_test_abc", "persona_abc", "", "PERSONA_SANDBOX_abc"]) {
      assert.equal(classifyProviderKey("persona", k), "unknown", k);
    }
  });
});

describe("liveAllowed", () => {
  it("is true only for the exact string \"true\"", () => {
    assert.equal(liveAllowed({ PAYMENTS_ALLOW_LIVE: "true" } as any), true);
    for (const v of [undefined, "", "1", "TRUE", "True", "yes", " true", "true "]) {
      assert.equal(liveAllowed({ PAYMENTS_ALLOW_LIVE: v } as any), false, String(v));
    }
  });
});

describe("evaluateProviderKey", () => {
  it("returns a typed decision that never carries the key", () => {
    const key = "sk_live_SECRETVALUE123";
    const d = evaluateProviderKey("stripe", key, {} as any);
    assert.deepEqual(d, {
      provider: "stripe",
      keyPresent: true,
      mode: "live",
      liveAllowed: false,
      allowed: false,
      refusal: "live_key_not_allowed",
    });
    assert.ok(!JSON.stringify(d).includes("SECRETVALUE"));
  });

  it("test keys are allowed; unknown keys are refused even with live allowed", () => {
    assert.equal(evaluateProviderKey("stripe", "sk_test_x", {} as any).allowed, true);
    const u = evaluateProviderKey("stripe", "pk_live_x", { PAYMENTS_ALLOW_LIVE: "true" } as any);
    assert.equal(u.allowed, false);
    assert.equal(u.refusal, "unknown_key_prefix");
    const l = evaluateProviderKey("stripe", "sk_live_x", { PAYMENTS_ALLOW_LIVE: "true" } as any);
    assert.equal(l.allowed, true);
    assert.equal(l.refusal, null);
  });

  it("an absent key is reported as absent, not as a mode", () => {
    const d = evaluateProviderKey("persona", "   ", {} as any);
    assert.equal(d.keyPresent, false);
    assert.equal(d.allowed, false);
    assert.equal(d.refusal, "key_absent");
  });
});

describe("assertProviderKeyAllowed / assertWebhookLivemodeAllowed", () => {
  it("throws PaymentsLiveModeRefusedError with a stable code and no key material", () => {
    const key = "rk_live_SECRETVALUE456";
    let err: unknown;
    try { assertProviderKeyAllowed("stripe", key, {} as any); } catch (e) { err = e; }
    assert.ok(err instanceof PaymentsLiveModeRefusedError);
    assert.equal(err.code, "payments_live_mode_refused");
    assert.equal(err.decision.refusal, "live_key_not_allowed");
    assert.ok(!err.message.includes("SECRETVALUE"));
    assert.match(err.message, /live key not allowed/);
  });

  it("does not throw for a test key or an allowed live key", () => {
    assert.doesNotThrow(() => assertProviderKeyAllowed("stripe", "sk_test_x", {} as any));
    assert.doesNotThrow(() => assertProviderKeyAllowed("persona", "persona_production_x", { PAYMENTS_ALLOW_LIVE: "true" } as any));
  });

  it("webhook: only livemode === true is refused, and only while live is not allowed", () => {
    assert.throws(() => assertWebhookLivemodeAllowed("stripe", true, {} as any), PaymentsLiveModeRefusedError);
    for (const v of [false, undefined, null, "true", 1]) {
      assert.doesNotThrow(() => assertWebhookLivemodeAllowed("stripe", v, {} as any), String(v));
    }
    assert.doesNotThrow(() => assertWebhookLivemodeAllowed("stripe", true, { PAYMENTS_ALLOW_LIVE: "true" } as any));
  });
});

describe("paymentsStartupSummary", () => {
  it("reports provider name, key presence, key mode and live-allowed — nothing else", () => {
    const s = paymentsStartupSummary({ IDENTITY_PROVIDER: "Stripe", STRIPE_IDENTITY_SECRET_KEY: "sk_live_SECRETVALUE789" } as any);
    assert.deepEqual(s, { identityProvider: "stripe", keyPresent: true, keyMode: "live", liveAllowed: false, keyRefused: true });
    assert.ok(!JSON.stringify(s).includes("SECRETVALUE"));
    assert.deepEqual(paymentsStartupSummary({} as any), {
      identityProvider: "mock", keyPresent: false, keyMode: "none", liveAllowed: false, keyRefused: false,
    });
  });
});

describe("mockIdentityPermitted", () => {
  it("needs a local signal, and refuses production and Replit deployments", () => {
    assert.equal(mockIdentityPermitted({ NODE_ENV: "development" } as any), true);
    assert.equal(mockIdentityPermitted({ NODE_ENV: "test" } as any), true);
    assert.equal(mockIdentityPermitted({ NODE_TEST_CONTEXT: "child-v8" } as any), true);
    assert.equal(mockIdentityPermitted({} as any), false, "a bare `start` (no NODE_ENV) is what the deployment runs");
    assert.equal(mockIdentityPermitted({ NODE_ENV: "production" } as any), false);
    assert.equal(mockIdentityPermitted({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" } as any), false);
    assert.equal(mockIdentityPermitted({ NODE_TEST_CONTEXT: "child-v8", REPLIT_DEPLOYMENT: "1" } as any), false);
  });
});
