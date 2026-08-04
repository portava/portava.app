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

  it("stripe and persona are NOT operational while their adapters are stubs", () => {
    // Even with the credential present — the adapter still throws on every call.
    const stripe = identityProviderStatus({
      IDENTITY_PROVIDER: "stripe",
      STRIPE_IDENTITY_SECRET_KEY: "sk_test_x",
      NODE_ENV: "production",
    } as any);
    assert.equal(stripe.operational, false);
    assert.match(stripe.reason, /stub/i);

    const persona = identityProviderStatus({
      IDENTITY_PROVIDER: "persona",
      PERSONA_API_KEY: "pk_x",
      NODE_ENV: "production",
    } as any);
    assert.equal(persona.operational, false);
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
