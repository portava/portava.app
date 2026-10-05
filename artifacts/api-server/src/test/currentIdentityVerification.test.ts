/**
 * currentVerification.ts — the one definition of "holds a current, REAL
 * identity verification" (owner 2026-10-04: no unverified bookings, no tester
 * bypass, no sandbox verification key; verified badge for a defined current
 * state only).
 *
 * Every case asserts the STATE the reader reports from rows, including the
 * refusal and failure cases: a sandbox approval, an unrecorded mode, a mock
 * approval on a hosted deployment, a revoked profile level, a later failed
 * attempt, an unknown age, and both unreadable reads.
 *
 * Run: node --import tsx/esm --test src/test/currentIdentityVerification.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readCurrentIdentityVerification,
  sessionProviderMode,
  providerModeCounts,
  FINISHED_ATTEMPT_STATUSES,
} from "../services/identityVerification/currentVerification.js";

type Row = Record<string, unknown>;

/** A small supabase-shaped double: filters, ordering, limit and maybeSingle over seeded rows. */
function db(seed: { identity_verifications?: Row[]; profiles?: Row[] }, fail: { table?: string } = {}) {
  const calls: Array<{ table: string; filters: string[] }> = [];
  return {
    calls,
    from(table: string) {
      let rows = [...(((seed as any)[table] ?? []) as Row[])];
      const filters: string[] = [];
      calls.push({ table, filters });
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push(`eq:${c}`); rows = rows.filter((r) => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { filters.push(`in:${c}`); rows = rows.filter((r) => vs.includes(r[c])); return q; },
        order: (c: string, o: { ascending: boolean }) => {
          rows.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (o.ascending ? 1 : -1));
          return q;
        },
        limit: (n: number) => { rows = rows.slice(0, n); return q; },
        maybeSingle: async () =>
          fail.table === table ? { data: null, error: { message: "boom" } } : { data: rows[0] ?? null, error: null },
      };
      return q;
    },
  };
}

const LOCAL = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
const HOSTED = { NODE_ENV: "production", REPLIT_DEPLOYMENT: "1" } as unknown as NodeJS.ProcessEnv; const UNDER_NODE_TEST = { NODE_TEST_CONTEXT: "child-v8" } as unknown as NodeJS.ProcessEnv; // Step 5(d): only this makes a mock approval count

const U = "11111111-1111-4111-8111-111111111111";
const attempt = (o: Row): Row => ({
  id: "iv-1", user_id: U, provider: "stripe", provider_mode: "live", status: "verified",
  is_over_18: true, document_country: "US", verified_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", ...o,
});
const profile = (level: string): Row => ({ id: U, verification_level: level });

describe("readCurrentIdentityVerification — the verified state", () => {
  it("a LIVE verified attempt with an identity level is verified, adult, with its country", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({})], profiles: [profile("id_verified")] }), U, HOSTED);
    assert.equal(r.state, "verified");
    if (r.state !== "verified") return;
    assert.equal(r.adult, true);
    assert.equal(r.documentCountry, "US");
    assert.equal(r.providerMode, "live");
    assert.equal(r.level, "id_verified");
  });

  it("id_selfie_verified is an identity level too", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({})], profiles: [profile("id_selfie_verified")] }), U, HOSTED);
    assert.equal(r.state, "verified");
  });

  it("is_over_18 unknown (null) is verified but NOT adult — unknown is never adult", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({ is_over_18: null })], profiles: [profile("id_verified")] }), U, HOSTED);
    assert.equal(r.state, "verified");
    if (r.state === "verified") assert.equal(r.adult, false);
  });
});

describe("readCurrentIdentityVerification — every way it is NOT verified", () => {
  it("a SANDBOX (test-key) approval does not count — owner: no sandbox verification key", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({ provider_mode: "test" })], profiles: [profile("id_verified")] }), U, HOSTED);
    assert.deepEqual(r, { state: "not_verified", reason: "sandbox_verification" });
  });

  it("an attempt with no recorded mode (every row before 3930) does not count", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({ provider_mode: null })], profiles: [profile("id_verified")] }), U, HOSTED);
    assert.deepEqual(r, { state: "not_verified", reason: "mode_unrecorded" });
  });

  it("a local-mock approval counts under node --test only — not by NODE_ENV=test alone, and NOT on a hosted deployment", async () => {
    const seed = { identity_verifications: [attempt({ provider: "mock", provider_mode: "local_mock" })], profiles: [profile("id_verified")] };
    assert.equal((await readCurrentIdentityVerification(db(seed), U, UNDER_NODE_TEST)).state, "verified"); assert.deepEqual(await readCurrentIdentityVerification(db(seed), U, LOCAL), { state: "not_verified", reason: "mock_verification" });
    assert.deepEqual(await readCurrentIdentityVerification(db(seed), U, HOSTED), { state: "not_verified", reason: "mock_verification" });
  });

  it("a platform-standing label (buddy_verified, basic_verified …) is NOT an identity check", async () => {
    for (const level of ["none", "basic_verified", "trusted_traveler", "host_verified", "buddy_verified"]) {
      const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({})], profiles: [profile(level)] }), U, HOSTED);
      assert.deepEqual(r, { state: "not_verified", reason: "profile_level_not_identity" }, level);
    }
  });

  it("an admin revocation (profile level cleared to none) ends the state even though the attempt row still says verified", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({})], profiles: [profile("none")] }), U, HOSTED);
    assert.equal(r.state, "not_verified");
  });

  it("a LATER failed attempt ends an earlier success; an in-progress one does not", async () => {
    const earlier = attempt({ id: "iv-1", created_at: "2026-09-01T00:00:00Z" });
    const failedLater = attempt({ id: "iv-2", status: "failed", created_at: "2026-10-02T00:00:00Z" });
    const pendingLater = attempt({ id: "iv-3", status: "pending", created_at: "2026-10-03T00:00:00Z" });
    const r1 = await readCurrentIdentityVerification(db({ identity_verifications: [earlier, failedLater], profiles: [profile("id_verified")] }), U, HOSTED);
    assert.deepEqual(r1, { state: "not_verified", reason: "latest_attempt_not_verified" });
    const r2 = await readCurrentIdentityVerification(db({ identity_verifications: [earlier, pendingLater], profiles: [profile("id_verified")] }), U, HOSTED);
    assert.equal(r2.state, "verified", "an attempt still in progress changes nothing");
    if (r2.state === "verified") assert.equal(r2.verificationId, "iv-1");
  });

  it("no finished attempt at all", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [], profiles: [profile("id_verified")] }), U, HOSTED);
    assert.deepEqual(r, { state: "not_verified", reason: "no_verification" });
  });

  it("only finished statuses are read for the decision", async () => {
    const d = db({ identity_verifications: [attempt({})], profiles: [profile("id_verified")] });
    await readCurrentIdentityVerification(d, U, HOSTED);
    const ivCall = d.calls.find((c) => c.table === "identity_verifications");
    assert.ok(ivCall?.filters.includes("in:status"));
    assert.deepEqual([...FINISHED_ATTEMPT_STATUSES].sort(), ["canceled", "expired", "failed", "verified"]);
  });
});

describe("readCurrentIdentityVerification — a failed read is never an answer", () => {
  it("identity_verifications unreadable -> unreadable (not 'not verified', not 'verified')", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({})], profiles: [profile("id_verified")] }, { table: "identity_verifications" }), U, HOSTED);
    assert.equal(r.state, "unreadable");
  });

  it("profiles unreadable -> unreadable", async () => {
    const r = await readCurrentIdentityVerification(db({ identity_verifications: [attempt({})], profiles: [profile("id_verified")] }, { table: "profiles" }), U, HOSTED);
    assert.equal(r.state, "unreadable");
  });

  it("a client that throws -> unreadable", async () => {
    const throwing = { from() { throw new Error("socket closed"); } };
    const r = await readCurrentIdentityVerification(throwing, U, HOSTED);
    assert.equal(r.state, "unreadable");
  });
});

describe("sessionProviderMode — what a session created now is recorded as", () => {
  it("records test / live by the identity key, and nothing for a refused or absent key", () => {
    assert.equal(sessionProviderMode("stripe", { IDENTITY_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: "sk_test_x" } as any), "test");
    assert.equal(sessionProviderMode("stripe", { IDENTITY_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: "sk_live_x", PAYMENTS_ALLOW_LIVE: "true" } as any), "live");
    assert.equal(sessionProviderMode("stripe", { IDENTITY_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: "sk_live_x" } as any), null, "a refused live key records nothing");
    assert.equal(sessionProviderMode("stripe", { IDENTITY_PROVIDER: "stripe" } as any), null);
    assert.equal(sessionProviderMode("persona", { IDENTITY_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: "sk_live_x", PAYMENTS_ALLOW_LIVE: "true" } as any), null, "the key belongs to another provider");
  });

  it("the mock is local_mock in a local run and nothing on a hosted deployment", () => {
    assert.equal(sessionProviderMode("mock", LOCAL), "local_mock");
    assert.equal(sessionProviderMode("mock", HOSTED), null);
  });

  it("providerModeCounts: live always; local_mock only under node --test; test and unknown never", () => {
    assert.equal(providerModeCounts("live", HOSTED), true);
    assert.equal(providerModeCounts("local_mock", UNDER_NODE_TEST), true); assert.equal(providerModeCounts("local_mock", LOCAL), false, "NODE_ENV=test alone does not count (Step 5(d))");
    assert.equal(providerModeCounts("local_mock", HOSTED), false);
    assert.equal(providerModeCounts("test", LOCAL), false);
    assert.equal(providerModeCounts(null, LOCAL), false);
    assert.equal(providerModeCounts("LIVE", HOSTED), false);
  });
});
