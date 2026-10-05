/**
 * lib/rentBuddyIdentityEligibility.ts — the per-person decision behind every
 * booking-creation path (owner 2026-10-04: no unverified bookings; adults only;
 * Trust restrictions enforced on the server). Route-level proof that all five
 * paths call it lives in rentABuddyGateConsolidation.test.ts and
 * rentABuddySpecRequest.test.ts; this file proves the decision, refusal by
 * refusal, and that a failed read is a 503, never a verdict about a person.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyIdentityEligibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBookingParties, requireVerifiedBookingParties } from "../lib/rentBuddyIdentityEligibility.js";
import type { CurrentIdentityVerification } from "../services/identityVerification/currentVerification.js";
import type { RestrictionState } from "../services/trust/TrustRestrictionService.js";

const T = "traveler-1";
const B = "buddy-user-1";

const verified = (adult = true): CurrentIdentityVerification => ({
  state: "verified", verificationId: "iv", provider: "stripe", providerMode: "live",
  verifiedAt: "2026-09-01T00:00:00Z", adult, documentCountry: "US", level: "id_verified",
});
const clear = (): RestrictionState => ({ canHost: true, canJoinPrivatePlans: true, canMessage: true, canJoinLocationPlans: true, activeRestrictions: [] });

function deps(v: Record<string, CurrentIdentityVerification>, r: Record<string, RestrictionState> = {}, pay: BuddyPaymentReadiness = { state: "ready" }) {
  return {
    readVerification: async (_db: unknown, id: string) => v[id] ?? { state: "not_verified" as const, reason: "no_verification" as const },
    readRestrictions: async (_db: unknown, id: string) => r[id] ?? clear(), readPaymentReadiness: async () => pay, // the buddy's payment-provider state (OD-PAY-10); "ready" unless a test says otherwise
  };
}

describe("checkBookingParties", () => {
  it("both verified adults, no restriction -> allowed", async () => {
    assert.deepEqual(await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps({ [T]: verified(), [B]: verified() })), { allowed: true });
  });

  it("traveller not verified -> 403 identity_verification_required, side traveler", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps({ [B]: verified() }));
    assert.equal(r.allowed, false);
    if (r.allowed) return;
    assert.equal(r.httpStatus, 403);
    assert.equal(r.code, "identity_verification_required");
    assert.equal(r.side, "traveler");
  });

  it("traveller verified only on a SANDBOX key is told to verify again (not 'verify for the first time')", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps({ [T]: { state: "not_verified", reason: "sandbox_verification" }, [B]: verified() }));
    assert.equal(r.allowed, false);
    if (!r.allowed) assert.match(r.message, /again/);
  });

  it("traveller verified but age unknown or under 18 -> 403 age_requirement (no payments for minors)", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps({ [T]: verified(false), [B]: verified() }));
    assert.equal(r.allowed, false);
    if (!r.allowed) assert.equal(r.code, "age_requirement");
  });

  it("traveller under a private_plan_access restriction -> 403 account_restricted, with where to see it and appeal", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps(
      { [T]: verified(), [B]: verified() },
      { [T]: { ...clear(), canJoinPrivatePlans: false, activeRestrictions: ["private_plan_access"] } },
    ));
    assert.equal(r.allowed, false);
    if (r.allowed) return;
    assert.equal(r.code, "account_restricted");
    assert.match(r.message, /appeal/i);
  });

  it("buddy not verified, a minor, or under a hosting restriction -> the SAME opaque 403 buddy_unavailable", async () => {
    const cases: Array<[string, ReturnType<typeof deps>]> = [
      ["unverified", deps({ [T]: verified() })],
      ["minor", deps({ [T]: verified(), [B]: verified(false) })],
      ["hosting-restricted", deps({ [T]: verified(), [B]: verified() }, { [B]: { ...clear(), canHost: false, activeRestrictions: ["hosting"] } })],
    ];
    const bodies = new Set<string>();
    for (const [name, d] of cases) {
      const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, d);
      assert.equal(r.allowed, false, name);
      if (r.allowed) continue;
      assert.equal(r.code, "buddy_unavailable", name);
      bodies.add(r.message);
    }
    assert.equal(bodies.size, 1, "the traveller cannot tell WHY a buddy is unavailable");
  });

  it("a buddy profile with no user behind it cannot be booked", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: null }, deps({ [T]: verified() }));
    assert.equal(r.allowed, false);
    if (!r.allowed) assert.equal(r.code, "buddy_unavailable");
  });

  it("an UNREADABLE verification on either side -> 503, never a verdict about the person", async () => {
    for (const who of [T, B]) {
      const v: Record<string, CurrentIdentityVerification> = { [T]: verified(), [B]: verified(), [who]: { state: "unreadable", detail: "x" } };
      const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps(v));
      assert.equal(r.allowed, false);
      if (!r.allowed) { assert.equal(r.httpStatus, 503); assert.equal(r.code, "verification_unavailable"); }
    }
  });

  it("a restriction read that FAILED CLOSED -> 503 'try again', never a restriction message", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps(
      { [T]: verified(), [B]: verified() },
      { [B]: { canHost: false, canJoinPrivatePlans: false, canMessage: false, canJoinLocationPlans: false, activeRestrictions: [], degraded: true, degradedReason: "fail_closed" } },
    ));
    assert.equal(r.allowed, false);
    if (!r.allowed) { assert.equal(r.httpStatus, 503); assert.doesNotMatch(r.message, /restrict/i); }
  });

  it("a reader that THROWS -> 503", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, {
      readVerification: async () => { throw new Error("socket"); },
      readRestrictions: async () => clear(),
    });
    assert.equal(r.allowed, false);
    if (!r.allowed) assert.equal(r.httpStatus, 503);
  });
});

describe("requireVerifiedBookingParties writes the refusal in the house shape", () => {
  it("writes status + { error, side, message } and returns false; returns true without writing when allowed", async () => {
    const rec: { status?: number; body?: any } = {};
    const res = { status(s: number) { rec.status = s; return this; }, json(b: unknown) { rec.body = b; return this; } };
    assert.equal(await requireVerifiedBookingParties({}, res, { travelerId: T, buddyUserId: B }, deps({ [B]: verified() })), false);
    assert.equal(rec.status, 403);
    assert.deepEqual(Object.keys(rec.body).sort(), ["error", "message", "side"]);

    const rec2: { status?: number } = {};
    const res2 = { status(s: number) { rec2.status = s; return this; }, json() { return this; } };
    assert.equal(await requireVerifiedBookingParties({}, res2, { travelerId: T, buddyUserId: B }, deps({ [T]: verified(), [B]: verified() })), true);
    assert.equal(rec2.status, undefined);
  });
});

// ── OD-PAY-10, second half: the buddy's payment-provider verification ─────────
// "Require identity and payment-provider verification before someone can offer
// or book the service." Appended at the foot so every cited line keeps its number.
import type { BuddyPaymentReadiness } from "../services/payments/bookingPayments/recipientReadiness.js";
import { readBuddyPaymentReadiness } from "../services/payments/bookingPayments/recipientReadiness.js";

describe("the buddy's payment-provider verification is part of the booking decision (OD-PAY-10)", () => {
  const both = { [T]: verified(), [B]: verified() };

  it("every not-ready state -> the SAME opaque 403 buddy_unavailable, nothing about payouts", async () => {
    for (const why of ["no_party", "no_recipient", "onboarding_incomplete", "charges_disabled"] as const) {
      const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps(both, {}, { state: "not_ready", why }));
      assert.equal(r.allowed, false, why);
      if (r.allowed) continue;
      assert.equal(r.httpStatus, 403, why);
      assert.equal(r.code, "buddy_unavailable", why);
      assert.equal(r.message, "This Buddy can't take bookings right now.", why);
      assert.doesNotMatch(r.message, /pay|onboard|charge|verif/i, why);
    }
  });

  it("an UNREADABLE recipient -> 503, never a verdict about the buddy", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps(both, {}, { state: "unreadable" }));
    assert.equal(r.allowed, false);
    if (r.allowed) return;
    assert.equal(r.httpStatus, 503);
    assert.equal(r.code, "payment_verification_unavailable");
    assert.equal(r.side, null);
    assert.doesNotMatch(r.message, /buddy|pay|onboard/i);
  });

  it("the traveller still learns what THEY must do first: an unverified traveller is told to verify, not that the buddy is unavailable", async () => {
    const r = await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps({ [B]: verified() }, {}, { state: "not_ready", why: "no_recipient" }));
    assert.equal(r.allowed, false);
    if (!r.allowed) assert.equal(r.code, "identity_verification_required");
  });

  it("ready + both verified -> allowed (the positive control)", async () => {
    assert.deepEqual(await checkBookingParties({}, { travelerId: T, buddyUserId: B }, deps(both, {}, { state: "ready" })), { allowed: true });
  });
});

describe("readBuddyPaymentReadiness reads the stored recipient row", () => {
  const rec = (o: Record<string, unknown> = {}) => ({
    partyId: "p-1", provider: "fake", recipientRef: "fake_acct_1", country: "US", settlementCurrency: "USD",
    onboarding: "verified", chargesEnabled: true, payoutsEnabled: true, requirementsDue: [], providerUpdatedAt: null, ...o,
  }) as any;
  const store = (party: any, recipient: any) => ({
    partyForProfile: async () => party,
    getRecipient: async () => recipient,
  });
  const ok = (v: unknown) => ({ ok: true as const, value: v as any });
  const fail = { ok: false as const, detail: "relation does not exist" };

  it("verified + charges enabled -> ready", async () => {
    assert.deepEqual(await readBuddyPaymentReadiness(store(ok("p-1"), ok(rec())), B), { state: "ready" });
  });
  it("no party / no recipient / onboarding not verified / charges disabled -> not_ready, each named", async () => {
    assert.deepEqual(await readBuddyPaymentReadiness(store(ok(null), ok(null)), B), { state: "not_ready", why: "no_party" });
    assert.deepEqual(await readBuddyPaymentReadiness(store(ok("p-1"), ok(null)), B), { state: "not_ready", why: "no_recipient" });
    for (const onboarding of ["not_started", "in_progress", "pending_verification", "restricted", "rejected"]) {
      assert.deepEqual(await readBuddyPaymentReadiness(store(ok("p-1"), ok(rec({ onboarding }))), B), { state: "not_ready", why: "onboarding_incomplete" }, onboarding);
    }
    assert.deepEqual(await readBuddyPaymentReadiness(store(ok("p-1"), ok(rec({ chargesEnabled: false }))), B), { state: "not_ready", why: "charges_disabled" });
  });
  it("either read failing, or throwing, -> unreadable", async () => {
    assert.deepEqual(await readBuddyPaymentReadiness(store(fail, ok(null)), B), { state: "unreadable" });
    assert.deepEqual(await readBuddyPaymentReadiness(store(ok("p-1"), fail), B), { state: "unreadable" });
    assert.deepEqual(await readBuddyPaymentReadiness({ partyForProfile: async () => { throw new Error("x"); }, getRecipient: async () => ok(null) } as any, B), { state: "unreadable" });
  });
});
