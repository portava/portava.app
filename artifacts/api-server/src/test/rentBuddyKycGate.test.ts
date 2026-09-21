/**
 * Rent-a-Buddy booking KYC gate (audit P1 item 8)
 *
 * Under test:
 *   services/identityVerification/readiness.ts — non-throwing provider probe
 *   lib/rentBuddyKycGate.ts                    — fail-closed booking gate
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyKycGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { identityProviderStatus } from "../services/identityVerification/readiness.js";
import { checkBookingKycGate, KYC_OVERRIDE_FLAG } from "../lib/rentBuddyKycGate.js";

// ── Fake client returning a flag row ─────────────────────────────────────────

function flagClient(opts: { enabled?: boolean; error?: string; throws?: boolean } = {}) {
  const seen: string[] = [];
  return {
    _seen: seen,
    from() {
      const q: any = {
        select: () => q,
        eq: (_c: string, v: any) => { seen.push(v); return q; },
        maybeSingle: async () => {
          if (opts.throws) throw new Error("connection reset");
          if (opts.error) return { data: null, error: { message: opts.error } };
          return { data: opts.enabled === undefined ? null : { enabled: opts.enabled }, error: null };
        },
      };
      return q;
    },
  };
}

// ── identityProviderStatus ───────────────────────────────────────────────────

describe("identityProviderStatus", () => {
  it("mock is operational outside production but not in production", () => {
    assert.equal(identityProviderStatus({ IDENTITY_PROVIDER: "mock" } as any).operational, true);
    assert.equal(
      identityProviderStatus({ IDENTITY_PROVIDER: "mock", NODE_ENV: "production" } as any).operational,
      false,
    );
  });

  it("defaults to mock when IDENTITY_PROVIDER is unset", () => {
    const s = identityProviderStatus({ NODE_ENV: "production" } as any);
    assert.equal(s.provider, "mock");
    assert.equal(s.operational, false);
  });

  it("stripe and persona are NOT operational, and the reason says why ACCURATELY", () => {
    // The load-bearing half is `operational === false`: it is what keeps the
    // Rent-a-Buddy booking gate closed while no real verification can complete.
    //
    // The REASON is load-bearing too, and it used to be wrong. It read "that
    // adapter in providers.ts is still a stub (every method throws)", and this
    // test asserted /stub/i against it. Both adapters were then implemented
    // (census-trust §14, TV-6b) — so the probe an operator reads to find out
    // what is missing, and the test guarding that probe, would together have
    // kept telling them to go write an adapter that already exists, while the
    // actual blocker (no sandbox transcript, so the payload mapping is
    // unverified) went unnamed.
    //
    // Asserting "not a stub" AND "names the certification that is missing" is
    // what stops the message drifting back into a description of the code
    // rather than of the gap.
    const stripe = identityProviderStatus({
      IDENTITY_PROVIDER: "stripe",
      STRIPE_IDENTITY_SECRET_KEY: "sk_test_x",
      NODE_ENV: "production",
    } as any);
    assert.equal(stripe.operational, false);
    assert.doesNotMatch(stripe.reason, /stub/i, "the adapters are no longer stubs — say what IS missing");
    assert.match(stripe.reason, /sandbox/i, "the reason must name the evidence that would open the gate");
    assert.match(stripe.reason, /IMPLEMENTED_PROVIDERS/, "and the switch that would open it");

    const persona = identityProviderStatus({
      IDENTITY_PROVIDER: "persona",
      PERSONA_API_KEY: "pk_x",
      NODE_ENV: "production",
    } as any);
    assert.equal(persona.operational, false);
    assert.doesNotMatch(persona.reason, /stub/i);
    assert.match(persona.reason, /sandbox/i);
  });

  it("rejects an unknown provider name", () => {
    const s = identityProviderStatus({ IDENTITY_PROVIDER: "acme" } as any);
    assert.equal(s.operational, false);
    assert.match(s.reason, /Unknown/i);
  });

  it("never throws, unlike getIdentityProvider()", () => {
    assert.doesNotThrow(() =>
      identityProviderStatus({ IDENTITY_PROVIDER: "mock", NODE_ENV: "production" } as any),
    );
  });
});

// ── checkBookingKycGate ──────────────────────────────────────────────────────
//
// The suite runs with NODE_ENV unset, so the default mock provider reports
// operational; production behaviour is exercised by overriding NODE_ENV.

describe("checkBookingKycGate", () => {
  const withProdEnv = async (fn: () => Promise<void>) => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try { await fn(); } finally {
      if (prev === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prev;
    }
  };

  it("allows bookings when verification is operational", async () => {
    const gate = await checkBookingKycGate(flagClient());
    assert.equal(gate.allowed, true);
  });

  it("blocks with 503 when verification is non-operational and no override", async () => {
    await withProdEnv(async () => {
      const c = flagClient({ enabled: false });
      const gate = await checkBookingKycGate(c);

      assert.equal(gate.allowed, false);
      assert.equal(gate.httpStatus, 503);
      assert.equal(gate.code, "verification_unavailable");
      assert.ok(c._seen.includes(KYC_OVERRIDE_FLAG), "must consult the override flag");
    });
  });

  it("blocks when the override flag row is missing entirely", async () => {
    await withProdEnv(async () => {
      const gate = await checkBookingKycGate(flagClient()); // no row
      assert.equal(gate.allowed, false);
    });
  });

  it("fails CLOSED when the flag lookup errors", async () => {
    await withProdEnv(async () => {
      const gate = await checkBookingKycGate(flagClient({ error: "relation missing" }));
      assert.equal(gate.allowed, false, "a DB error must not open bookings");
    });
  });

  it("fails CLOSED when the flag lookup throws", async () => {
    await withProdEnv(async () => {
      const gate = await checkBookingKycGate(flagClient({ throws: true }));
      assert.equal(gate.allowed, false);
    });
  });

  it("allows bookings only when the override flag is explicitly true", async () => {
    await withProdEnv(async () => {
      const gate = await checkBookingKycGate(flagClient({ enabled: true }));
      assert.equal(gate.allowed, true);
    });
  });

  it("does not leak provider or env detail to the caller", async () => {
    await withProdEnv(async () => {
      const gate = await checkBookingKycGate(flagClient({ enabled: false }));
      const msg = gate.message ?? "";
      for (const leak of ["IDENTITY_PROVIDER", "mock", "stripe", "persona", "STRIPE", "PERSONA"]) {
        assert.ok(!msg.includes(leak), `message leaked "${leak}": ${msg}`);
      }
    });
  });
});
