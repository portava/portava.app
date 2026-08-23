/**
 * Phone verification tests.
 *
 * The properties under test are mostly SECURITY properties, because that is
 * where this feature's risk lives: a 6-digit code is only safe if it cannot be
 * brute-forced, replayed, read out of the database, or used to bomb a stranger's
 * handset with SMS.
 *
 * Run: node --import tsx/esm --test src/test/phoneVerification.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  startPhoneVerification,
  confirmPhoneVerification,
  isPhoneVerified,
  normalisePhone,
  MAX_ATTEMPTS,
} from "../services/phoneVerification/PhoneVerificationService.js";
import {
  smsProviderStatus,
  _mockSentMessages,
  _resetMockOutbox,
} from "../services/phoneVerification/smsProvider.js";

// ── Fake DB ───────────────────────────────────────────────────────────────────

interface Tables {
  profiles: any[];
  phone_verification_challenges: any[];
}

function makeDb(tables: Tables): any {
  function from(table: keyof Tables) {
    const store = tables[table] as any[];
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let limitN: number | null = null;

    const b: any = {
      select() { return b; },
      insert(row: any) {
        const r = { created_at: new Date().toISOString(), ...row };
        store.push(r); pendingInsert = r; return b;
      },
      update(p: any) { pendingUpdate = p; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      is(c: string, v: any) { filters.push((r) => v === null ? r[c] == null : r[c] === v); return b; },
      not(c: string, _op: string, v: any) {
        filters.push((r) => (v === null ? r[c] != null : r[c] !== v)); return b;
      },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { return resolve(); },
      then(f: any, r: any) { return resolveList().then(f, r); },
    };
    function matched() {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      // Newest-first, matching the service's .order("created_at", desc)
      rows = [...rows].sort((a, z) => String(z.created_at).localeCompare(String(a.created_at)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function resolve() {
      if (pendingInsert && !pendingUpdate) return { data: pendingInsert, error: null };
      if (pendingUpdate) { const rows = matched(); rows.forEach((r) => Object.assign(r, pendingUpdate)); return { data: rows[0] ?? null, error: null }; }
      return { data: matched()[0] ?? null, error: null };
    }
    async function resolveList() {
      if (pendingInsert && !pendingUpdate) return { data: [pendingInsert], error: null };
      if (pendingUpdate) { const rows = matched(); rows.forEach((r) => Object.assign(r, pendingUpdate)); return { data: rows, error: null }; }
      return { data: matched(), error: null };
    }
    return b;
  }
  return { from };
}

let seq = 0;
/**
 * Unique user AND phone per test. The rate limiter keeps module-global state
 * keyed on both, so sharing either across tests makes them order-dependent —
 * the send-limit test would otherwise exhaust the per-phone bucket for the
 * whole run and starve every test after it.
 */
function freshUser(): string { return `phone-user-${++seq}`; }
function freshPhone(): string { return `+1555${String(1000000 + seq).slice(-7)}`; }

function makeTables(userId: string): Tables {
  return {
    profiles: [{ id: userId, phone_e164: null, phone_verified_at: null }],
    phone_verification_challenges: [],
  };
}

/** Pull the code out of the mock SMS body — the ONLY way to learn it. */
function codeFromOutbox(): string {
  const msgs = _mockSentMessages();
  const m = msgs[msgs.length - 1]?.body.match(/\b(\d{6})\b/);
  assert.ok(m, "no code found in the sent message");
  return m![1]!;
}

beforeEach(() => { _resetMockOutbox(); });

// ── Provider policy ───────────────────────────────────────────────────────────

describe("SMS provider readiness", () => {
  it("mock counts as operational outside production", () => {
    const s = smsProviderStatus({ NODE_ENV: "test" } as any);
    assert.equal(s.operational, true);
  });

  it("mock is REFUSED in production — a fake verification is worse than none", () => {
    const s = smsProviderStatus({ NODE_ENV: "production" } as any);
    assert.equal(s.operational, false);
    assert.match(s.reason, /refused in production/);
  });

  it("a real provider without its credential is not operational", () => {
    const s = smsProviderStatus({ NODE_ENV: "production", SMS_PROVIDER: "twilio" } as any);
    assert.equal(s.operational, false);
  });

  it("an unimplemented adapter is reported as a stub, not as working", () => {
    const s = smsProviderStatus({ NODE_ENV: "test", SMS_PROVIDER: "messagebird", MESSAGEBIRD_API_KEY: "x" } as any);
    assert.equal(s.operational, false);
    assert.match(s.reason, /stub/);
  });
});

// ── Input handling ────────────────────────────────────────────────────────────

describe("phone normalisation", () => {
  it("accepts E.164 and strips punctuation", () => {
    assert.equal(normalisePhone("+1 (555) 010-0001"), "+15550100001");
    assert.equal(normalisePhone("+447700900000"), "+447700900000");
  });

  it("rejects anything that is not unambiguously E.164", () => {
    // No country code is ever inferred — an ambiguous local number is rejected
    // rather than guessed, because guessing wrong sends a stranger an SMS.
    for (const bad of ["5550100001", "+0123456", "", "not a phone", "+1", null, 12345]) {
      assert.equal(normalisePhone(bad as any), null, `should reject ${String(bad)}`);
    }
  });
});

// ── Issue ─────────────────────────────────────────────────────────────────────

describe("issuing a challenge", () => {
  it("sends a code and stores it ONLY as a hash", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    const r = await startPhoneVerification(makeDb(t), u, PHONE);

    assert.equal(r.ok, true);
    assert.equal(t.phone_verification_challenges.length, 1);
    assert.equal(_mockSentMessages().length, 1);

    const code = codeFromOutbox();
    const row = t.phone_verification_challenges[0];
    assert.ok(row.code_hash && row.code_hash.length === 64, "expected a sha256 hex hash");
    assert.ok(!JSON.stringify(row).includes(code), "the plaintext code must never be persisted");
  });

  it("rejects a malformed number before generating anything", async () => {
    const u = freshUser();
    const t = makeTables(u);
    const r = await startPhoneVerification(makeDb(t), u, "555-0100");
    assert.equal(r.failure, "invalid_phone");
    assert.equal(t.phone_verification_challenges.length, 0);
    assert.equal(_mockSentMessages().length, 0);
  });

  it("retires a previous challenge so an abandoned code cannot be redeemed later", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    const db = makeDb(t);

    await startPhoneVerification(db, u, PHONE);
    const firstCode = codeFromOutbox();
    await startPhoneVerification(db, u, PHONE);

    const live = t.phone_verification_challenges.filter((c) => !c.consumed_at);
    assert.equal(live.length, 1, "only the newest challenge may remain live");

    const r = await confirmPhoneVerification(db, u, firstCode);
    assert.equal(r.ok, false, "the superseded code must no longer work");
  });

  it("refuses a number already verified on another account", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    t.profiles.push({ id: "someone-else", phone_e164: PHONE, phone_verified_at: "2026-01-01T00:00:00Z" });

    const r = await startPhoneVerification(makeDb(t), u, PHONE);
    assert.equal(r.failure, "phone_in_use");
    assert.equal(_mockSentMessages().length, 0);
  });

  it("rate-limits sends per user, so the endpoint cannot be used as an SMS cannon", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    const db = makeDb(t);

    let limited = false;
    for (let i = 0; i < 12; i++) {
      const r = await startPhoneVerification(db, u, PHONE);
      if (r.failure === "rate_limited") { limited = true; break; }
    }
    assert.ok(limited, "expected a per-user send limit to engage");
  });
});

// ── Redeem ────────────────────────────────────────────────────────────────────

describe("confirming a challenge", () => {
  it("the correct code verifies the phone", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    const db = makeDb(t);

    await startPhoneVerification(db, u, PHONE);
    const r = await confirmPhoneVerification(db, u, codeFromOutbox());

    assert.equal(r.ok, true);
    assert.ok(r.phoneVerifiedAt);
    assert.equal(t.profiles[0].phone_e164, PHONE);
    assert.ok(t.profiles[0].phone_verified_at);
    assert.equal(await isPhoneVerified(db, u), true);
  });

  it("a wrong code does not verify, and burns an attempt", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    const db = makeDb(t);

    await startPhoneVerification(db, u, PHONE);
    const r = await confirmPhoneVerification(db, u, "000000");

    assert.equal(r.ok, false);
    assert.equal(t.profiles[0].phone_verified_at, null);
    assert.equal(t.phone_verification_challenges[0].attempts, 1);
    assert.equal(r.attemptsRemaining, MAX_ATTEMPTS - 1);
  });

  it("caps guessing — a 6-digit code is not a million tries", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    const db = makeDb(t);

    await startPhoneVerification(db, u, PHONE);
    const real = codeFromOutbox();

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await confirmPhoneVerification(db, u, real === "000000" ? "111111" : "000000");
    }

    // Even the CORRECT code is refused once the budget is spent.
    const r = await confirmPhoneVerification(db, u, real);
    assert.equal(r.ok, false);
    assert.equal(r.failure, "too_many_attempts");
    assert.equal(t.profiles[0].phone_verified_at, null);
  });

  it("an expired challenge cannot be redeemed", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    const db = makeDb(t);

    await startPhoneVerification(db, u, PHONE);
    const code = codeFromOutbox();
    t.phone_verification_challenges[0].expires_at = new Date(Date.now() - 1000).toISOString();

    const r = await confirmPhoneVerification(db, u, code);
    assert.equal(r.failure, "expired");
    assert.equal(t.profiles[0].phone_verified_at, null);
  });

  it("confirming with no outstanding challenge is refused", async () => {
    const u = freshUser();
    const t = makeTables(u);
    const r = await confirmPhoneVerification(makeDb(t), u, "123456");
    assert.equal(r.failure, "no_challenge");
  });

  it("a consumed code cannot be replayed", async () => {
    const u = freshUser();
    const PHONE = freshPhone();
    const t = makeTables(u);
    const db = makeDb(t);

    await startPhoneVerification(db, u, PHONE);
    const code = codeFromOutbox();
    assert.equal((await confirmPhoneVerification(db, u, code)).ok, true);

    const again = await confirmPhoneVerification(db, u, code);
    assert.equal(again.ok, false, "a redeemed code must not work twice");
  });
});
