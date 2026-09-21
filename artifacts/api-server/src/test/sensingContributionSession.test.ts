/**
 * sensingContributionSession + migrations 2480 / 2481 (UNAPPLIED).
 *
 * The issued half of §4.2: a short-lived, budgeted, opaque credential whose
 * hash is the only thing stored; no identity on the session (2480), no session
 * on the contribution (2315), the join living nowhere at rest.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENSING_SESSION_DEFAULT_BUDGET,
  SENSING_SESSION_DEFAULT_LIFETIME_SECONDS,
  SENSING_SESSION_MAX_LIFETIME_SECONDS,
  admitWithSensingSession,
  buildSensingSessionRow,
  consumeSensingSessionBudget,
  consumeSensingSessionRpc,
  generateSensingCredential,
  revokeSensingSessionRpc,
  validateSensingSession,
  type SensingContributionSessionRow,
} from "../lib/sensingContributionSession.js";
import {
  SENSING_MAX_TTL_SECONDS,
  deriveEpochSecret,
  deriveSensingCredentialHash,
  revocationCommitment,
  rotationEpochFor,
} from "../lib/sensingAnonStore.js";
import { SENSING_ANON_GRANTED_SCOPES } from "../lib/sensingContributionPolicy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const REPO = resolve(SRC, "..", "..", "..");
const M2480 = readFileSync(join(SRC, "migrations", "2480_sensing_contribution_sessions.sql"), "utf8");
const M2481 = readFileSync(join(SRC, "migrations", "2481_sensing_sessions_option_a_issuer.sql"), "utf8");
const C2480 = M2480.replace(/--[^\n]*/g, "");
const C2481 = M2481.replace(/--[^\n]*/g, "");
const MODULE_TS = readFileSync(join(SRC, "lib", "sensingContributionSession.ts"), "utf8");

process.env.SENSING_CONTRIBUTOR_PEPPER ??= "p".repeat(40);

const NOW = Date.UTC(2026, 8, 7, 22, 0, 0);
const DEVICE_SECRET = "device-secret-that-never-leaves-the-device";

function session(over: Partial<SensingContributionSessionRow> = {}, credential = generateSensingCredential()) {
  const built = buildSensingSessionRow({ credential, issuanceClass: "attested_device", nowMs: NOW });
  assert.ok(built.ok, JSON.stringify(built));
  return { credential, row: { ...built.row, ...over } };
}

function contribution(over: Record<string, unknown> = {}) {
  const observedAtMs = (over.observedAtMs as number | undefined) ?? NOW - 60_000;
  const epoch = rotationEpochFor(observedAtMs);
  return {
    commitment: revocationCommitment(deriveEpochSecret(DEVICE_SECRET, epoch)),
    rotationEpoch: epoch,
    zoneId: "zone-alpha",
    observedAtMs,
    signalBucket: 2,
    ...over,
  } as any;
}

describe("issuance", () => {
  it("stores only the credential's HMAC, the policy, the class and a budget — no identity field exists on the row", () => {
    const { credential, row } = session();
    assert.equal(row.credential_hash, deriveSensingCredentialHash(credential));
    assert.ok(!JSON.stringify(row).includes(credential), "the bearer must never be stored");
    for (const k of Object.keys(row)) assert.doesNotMatch(k, /user|actor|profile|account|device_id|installation|session_id|commitment|token/i);
    assert.deepEqual(row.purpose_scopes, [...SENSING_ANON_GRANTED_SCOPES]);
    assert.equal(row.budget_cohorts_remaining, SENSING_SESSION_DEFAULT_BUDGET.attested_device);
    assert.equal(row.revoked_at, null);
  });
  it("a fresh credential is random, long, and never derived", () => {
    const a = generateSensingCredential();
    const b = generateSensingCredential();
    assert.notEqual(a, b);
    assert.ok(a.length >= 40);
    assert.match(MODULE_TS, /randomBytes\(32\)/);
  });
  it("lifetime cannot exceed a contribution's TTL ceiling; defaults are a day", () => {
    assert.equal(SENSING_SESSION_MAX_LIFETIME_SECONDS, SENSING_MAX_TTL_SECONDS);
    assert.equal(SENSING_SESSION_DEFAULT_LIFETIME_SECONDS, 24 * 3600);
    const r = buildSensingSessionRow({ credential: generateSensingCredential(), issuanceClass: "attested_device", nowMs: NOW, lifetimeSeconds: SENSING_MAX_TTL_SECONDS + 1 });
    assert.deepEqual(r, { ok: false, error: "lifetime_exceeds_maximum" });
  });
  it("refuses a short credential, a bad class, a bad budget", () => {
    assert.deepEqual(buildSensingSessionRow({ credential: "short", issuanceClass: "attested_device", nowMs: NOW }), { ok: false, error: "credential_too_short" });
    assert.deepEqual(buildSensingSessionRow({ credential: generateSensingCredential(), issuanceClass: "root" as never, nowMs: NOW }), { ok: false, error: "issuance_class_invalid" });
    assert.deepEqual(buildSensingSessionRow({ credential: generateSensingCredential(), issuanceClass: "attested_device", nowMs: NOW, budget: 0 }), { ok: false, error: "budget_invalid" });
  });
  it("the unattested budget is the tightest", () => {
    assert.ok(SENSING_SESSION_DEFAULT_BUDGET.unattested_device < SENSING_SESSION_DEFAULT_BUDGET.attested_device);
    assert.ok(SENSING_SESSION_DEFAULT_BUDGET.unattested_device < SENSING_SESSION_DEFAULT_BUDGET.authenticated_profile);
  });
});

describe("validation — the same order as the SQL function", () => {
  it("unknown, mismatch, revoked, not started, expired, exhausted, then ok", () => {
    const { credential, row } = session();
    assert.deepEqual(validateSensingSession(null, credential, NOW), { ok: false, reason: "unknown" });
    assert.deepEqual(validateSensingSession(row, "wrong-credential-wrong-credential-wrong", NOW), { ok: false, reason: "credential_mismatch" });
    assert.deepEqual(validateSensingSession({ ...row, revoked_at: new Date(NOW).toISOString() }, credential, NOW), { ok: false, reason: "revoked" });
    assert.deepEqual(validateSensingSession(row, credential, NOW - 1), { ok: false, reason: "not_started" });
    assert.deepEqual(validateSensingSession(row, credential, Date.parse(row.expires_at)), { ok: false, reason: "expired" });
    assert.deepEqual(validateSensingSession({ ...row, budget_cohorts_remaining: 0 }, credential, NOW), { ok: false, reason: "budget_exhausted" });
    assert.deepEqual(validateSensingSession(row, credential, NOW + 1000), { ok: true });
  });
  it("an unparseable window is expired (fail-closed)", () => {
    const { credential, row } = session({ expires_at: "never" });
    assert.deepEqual(validateSensingSession(row, credential, NOW + 1000), { ok: false, reason: "expired" });
  });
});

describe("the budget", () => {
  it("decrements by exactly one per cohort and refuses at zero", () => {
    const { credential, row } = session({ budget_cohorts_remaining: 2 });
    const one = consumeSensingSessionBudget(row, credential, NOW + 1000);
    assert.ok(one.ok && one.row.budget_cohorts_remaining === 1);
    const two = consumeSensingSessionBudget(one.row, credential, NOW + 1000);
    assert.ok(two.ok && two.row.budget_cohorts_remaining === 0);
    assert.deepEqual(consumeSensingSessionBudget(two.row, credential, NOW + 1000), { ok: false, reason: "budget_exhausted" });
  });
  it("admission through a session uses the SESSION's scopes, not the caller's claim, and consumes nothing", () => {
    const { credential, row } = session();
    const ok = admitWithSensingSession(row, credential, contribution(), NOW + 1000);
    assert.equal(ok.admitted, true, JSON.stringify(ok));
    const infer = admitWithSensingSession(row, credential, contribution({ purposeScopes: ["collect", "infer"] }), NOW + 1000);
    assert.deepEqual(infer, { admitted: false, reason: "scope_not_granted", scope: "infer" });
    const dead = admitWithSensingSession({ ...row, revoked_at: new Date(NOW).toISOString() }, credential, contribution(), NOW + 1000);
    assert.deepEqual(dead, { admitted: false, reason: "session_revoked" });
    assert.equal(row.budget_cohorts_remaining, SENSING_SESSION_DEFAULT_BUDGET.attested_device, "admission is pure");
  });
  it("a session issued NARROWER than the policy binds: a policy-granted verb the session lacks is refused by the session", () => {
    const { credential, row } = session({ purpose_scopes: ["collect"] });
    // `aggregate` is granted by the policy (SENSING_ANON_GRANTED_SCOPES) but not by this session.
    const r = admitWithSensingSession(row, credential, contribution({ purposeScopes: ["collect", "aggregate"] }), NOW + 1000);
    assert.deepEqual(r, { admitted: false, reason: "scope_not_granted", scope: "aggregate" });
    // And with no explicit request, the session's own (narrow) scopes are what is admitted.
    const ok = admitWithSensingSession(row, credential, contribution(), NOW + 1000);
    assert.equal(ok.admitted, true, JSON.stringify(ok));
  });
});

describe("RPC bindings report failure as failure", () => {
  const db = (result: { data: any; error: any }) => {
    const client: any = { last: null };
    client.rpc = async (name: string, args: any) => { client.last = { name, args }; return result; };
    return client;
  };
  it("consume returns the SQL function's named reason and never the credential", async () => {
    const client = db({ data: "budget_exhausted", error: null });
    const r = await consumeSensingSessionRpc(client, "cred-cred-cred-cred-cred-cred-cred-cred", "2026-09-07T22:00:00.000Z");
    assert.deepEqual(r, { ok: true, value: "budget_exhausted" });
    assert.equal(client.last.name, "sensing_session_consume");
    assert.ok(!JSON.stringify(client.last.args).includes("cred-cred"), "the bearer must not cross the wire; only its hash");
  });
  it("revoke coerces bigint and surfaces errors", async () => {
    assert.deepEqual(await revokeSensingSessionRpc(db({ data: "1", error: null }), "c".repeat(40), "2026-09-07T22:00:00.000Z"), { ok: true, value: 1 });
    assert.deepEqual(await revokeSensingSessionRpc(db({ data: null, error: { message: "boom" } }), "c".repeat(40), "2026-09-07T22:00:00.000Z"), { ok: false, error: "boom" });
  });
});

describe("2480 — the session table (UNAPPLIED)", () => {
  it("declares no identity column, no FK (except 2481's named one), a 72 h lifetime CHECK, a scope vocabulary CHECK and a class CHECK", () => {
    const ddl = C2480.match(/CREATE TABLE IF NOT EXISTS public\.sensing_contribution_sessions \(([\s\S]*?)\n\);/);
    assert.ok(ddl);
    assert.doesNotMatch(ddl[1], /user_id|actor_id|profile_id|device_id|session_id|REFERENCES/);
    assert.match(ddl[1], /expires_at <= starts_at \+ interval '72 hours'/);
    assert.match(ddl[1], /purpose_scopes <@ ARRAY\['collect','retain','aggregate','infer','personalize','surface','share'\]/);
    assert.match(ddl[1], /issuance_class IN \('attested_device', 'unattested_device', 'authenticated_profile'\)/);
    assert.match(ddl[1], /UNIQUE \(credential_hash\)/);
    assert.match(C2480, /conname <> 'sensing_contribution_sessions_issuer_fk'/);
  });
  it("UPDATE is not granted; budget and revocation go through SECURITY DEFINER functions; service_role only", () => {
    const revoke = C2480.indexOf("REVOKE ALL ON public.sensing_contribution_sessions FROM service_role;");
    const grant = C2480.indexOf("GRANT SELECT, INSERT, DELETE ON public.sensing_contribution_sessions TO service_role;");
    assert.ok(revoke > 0 && grant > revoke);
    assert.doesNotMatch(C2480, /GRANT[^;]*UPDATE[^;]*ON public\.sensing_contribution_sessions/);
    assert.match(C2480, /has_table_privilege\('service_role', 'public\.sensing_contribution_sessions', 'UPDATE'\)[\s\S]{0,200}RAISE EXCEPTION/);
    for (const fn of ["sensing_session_consume", "revoke_sensing_session", "purge_expired_sensing_sessions"]) {
      assert.match(C2480, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]{0,200}SECURITY DEFINER`));
      assert.match(C2480, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`));
    }
  });
  it("the consume function checks in the module's order and decrements atomically", () => {
    const body = C2480.match(/FUNCTION public\.sensing_session_consume[\s\S]*?\$\$;/)![0];
    const order = ["'unknown'", "'revoked'", "'not_started'", "'expired'", "'budget_exhausted'", "budget_cohorts_remaining - 1", "'ok'"];
    let last = -1;
    for (const o of order) { const i = body.indexOf(o); assert.ok(i > last, `${o} out of order`); last = i; }
    assert.match(body, /FOR UPDATE/);
  });
  it("re-asserts that the contribution store gained no FK and no session column — the join lives nowhere at rest", () => {
    assert.match(C2480, /column_name IN \('session_id','credential_hash'\)[\s\S]{0,200}RAISE EXCEPTION/);
  });
  it("one transaction, additive, writes no row, creates no flag, has a refusing rollback", () => {
    assert.equal((C2480.match(/\bBEGIN;/g) ?? []).length, 1);
    assert.equal((C2480.match(/\bCOMMIT;/g) ?? []).length, 1);
    assert.doesNotMatch(C2480, /INSERT INTO|feature_flags|schema_migration_ledger|DROP TABLE/i);
    const rb = join(REPO, "db", "rollback", "2026-09-07-2480-sensing-contribution-sessions-rollback.sql");
    assert.ok(existsSync(rb));
    const text = readFileSync(rb, "utf8").replace(/--[^\n]*/g, "");
    assert.match(text, /RAISE EXCEPTION[\s\S]{0,80}live session/);
    assert.match(text, /DROP TABLE IF EXISTS public\.sensing_contribution_sessions;/);
  });
});

describe("2481 — Option A issuer ledger (UNAPPLIED, Option A only)", () => {
  it("adds ONE nullable FK to profiles on the SESSION row, with the posture made structural by a CHECK", () => {
    assert.match(C2481, /ADD COLUMN IF NOT EXISTS issued_to_profile_id uuid;/);
    assert.match(C2481, /sensing_contribution_sessions_issuer_fk[\s\S]{0,200}REFERENCES public\.profiles\(id\) ON DELETE CASCADE/);
    assert.match(C2481, /\(issuance_class = 'authenticated_profile'\) = \(issued_to_profile_id IS NOT NULL\)/);
    assert.match(C2481, /is_nullable[\s\S]{0,300}RAISE EXCEPTION 'POSTCONDITION FAILED: issued_to_profile_id must exist and be NULLABLE/);
  });
  it("never touches the contribution store, and re-asserts it acquired no identity", () => {
    assert.doesNotMatch(C2481, /ALTER TABLE public\.sensing_anon_contributions/);
    assert.match(C2481, /column_name IN \('session_id','credential_hash','issued_to_profile_id','profile_id','actor_id','user_id'\)[\s\S]{0,200}RAISE EXCEPTION/);
  });
  it("account-level revocation exists and UPDATE stays ungranted; rollback exists, refuses over live rows, runs before 2480's", () => {
    assert.match(C2481, /CREATE OR REPLACE FUNCTION public\.revoke_sensing_sessions_for_profile\(p_profile_id uuid, p_now timestamptz\)/);
    assert.match(C2481, /has_table_privilege\('service_role', 'public\.sensing_contribution_sessions', 'UPDATE'\)[\s\S]{0,200}RAISE EXCEPTION/);
    const rb = join(REPO, "db", "rollback", "2026-09-07-2481-sensing-sessions-option-a-issuer-rollback.sql");
    assert.ok(existsSync(rb));
    const text = readFileSync(rb, "utf8").replace(/--[^\n]*/g, "");
    assert.match(text, /DROP COLUMN IF EXISTS issued_to_profile_id/);
    assert.match(text, /RAISE EXCEPTION[\s\S]{0,80}live profile-issued/);
    const rb2480 = readFileSync(join(REPO, "db", "rollback", "2026-09-07-2480-sensing-contribution-sessions-rollback.sql"), "utf8").replace(/--[^\n]*/g, "");
    assert.match(rb2480, /issuer_fk[\s\S]{0,200}Run the 2481 rollback first/);
  });
});
