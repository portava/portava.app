/**
 * trustVerificationWrite — census-trust §31 (TV-U8): the identity-verification
 * write and the trust tables' access rules, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/trustVerificationWrite.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * TV-U8 asks for "actual consuming routes and real database constraints/RLS"
 * (docs/specs/upgrades-v2/03-TRUST-v2.md, Verification and release). The
 * routes half was held by suites on injected fakes, and a fake accepts any
 * string at all: that is how `id_verified` round-tripped through
 * verification.test.ts while production's CHECK rejected it (audit H5). Here
 * the route's OWN persist function — routes/verification.ts `persistResult`,
 * and through it `applyVerifiedProfile` — runs through the real supabase-js
 * client over trailPostgrestBridge, so every write it makes is answered by the
 * database: its CHECKs, its unique index, its row-level security, its grants.
 *
 * WHAT THE HARNESS MODELS, AND WHAT IT DOES NOT
 *   It applies the repository's migration chain, 2870 and 2370 included, with
 *   the three PostgREST roles and auth.uid() reading `request.jwt.claim.sub`
 *   (scripts/local-db/shim.sql). Production, read-only on 2026-10-03, has
 *   2370's effect (anon/authenticated hold no privilege on any trust_* table)
 *   but NOT 2870 (profiles_verification_level_check is still the five-value
 *   list) — so the verified-profile write U8-1 proves storable HERE is still
 *   rejected THERE until 2870 is applied (TV-1c, D-2870-APPLY). This suite
 *   certifies the migration chain and the code against it, not a deployment.
 *
 * PROPERTIES
 *   U8-0  the preconditions hold, or every refusal below is vacuous: 2870's
 *         widened CHECK, 2370's revocations, RLS on identity_verifications.
 *   U8-1  persistResult stores a VERIFIED result end to end — the row's status,
 *         derived booleans, verified_at and redaction handle — and the profile
 *         carries exactly the level toVerificationLevel returns, for both of
 *         the values it can return.
 *   U8-2  a FAILED `underage` result is stored as such (is_over_18 = false, the
 *         row the verified-minor gate reads) and does NOT raise the level.
 *   U8-3  the constraints refuse what the code must never write: an unknown
 *         status, an unknown level, a second ACTIVE session for one user.
 *   U8-4  RLS: a user reads their own verification rows and no one else's, and
 *         cannot insert, update or delete one (every write is server-only);
 *         anon reads nothing.
 *   U8-5  2370: anon and authenticated are refused every trust table outright
 *         (42501, not an empty result); the service role reads them.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";
import { makeTrailBridge, type BridgeHandle } from "./trailPostgrestBridge.js";
import { _setTestServiceClient } from "../../lib/supabase.js";
import { persistResult } from "../../routes/verification.js";
import { toVerificationLevel, type VerificationResult } from "../../services/identityVerification/types.js";

const SKIP = !HAVE_DB;

const TRUST_TABLES = [
  "trust_admin_actions", "trust_caps", "trust_events", "trust_profiles",
  "trust_restrictions", "trust_reviews", "trust_settings",
] as const;

let A = ""; // the person verifying
let B = ""; // someone else, with a verification row of their own
let bridge: BridgeHandle;

/** A session the server created at POST /verification/session: a pending row. */
function seedSession(userId: string, status = "pending"): string {
  const sid = `u8_${randomUUID()}`;
  exec(
    `INSERT INTO public.identity_verifications (user_id, provider, provider_session_id, status) ` +
    `VALUES ('${userId}', 'mock', '${sid}', '${status}');`,
  );
  return sid;
}

/** Close every ACTIVE session a user holds, so the next seed is not refused by the one-active index. */
function closeActive(userId: string): void {
  exec(
    `UPDATE public.identity_verifications SET status = 'canceled' ` +
    `WHERE user_id = '${userId}' AND status IN ('created','pending','processing');`,
  );
}

/** Run one statement as a client role through RLS; returns psql's result. */
function asRole(role: "anon" | "authenticated", userId: string | null, sql: string) {
  const claims = userId
    ? `SELECT set_config('request.jwt.claim.sub', '${userId}', true);\nSELECT set_config('request.jwt.claim.role', 'authenticated', true);\n`
    : "";
  return psql(`${claims}SET LOCAL ROLE ${role};\n${sql}`, { single: true });
}

/** stdout lines after the set_config echoes. */
function outLines(stdout: string, userId: string | null): string[] {
  return stdout.split("\n").filter((l) => l.length > 0).slice(userId ? 2 : 0);
}

function level(userId: string): string | null {
  return scalar(`SELECT verification_level FROM public.profiles WHERE id = '${userId}';`);
}

describe("census-trust §31 — TV-U8: the verification write and the trust tables, on real PostgreSQL", { skip: SKIP }, () => {
  before(() => {
    A = seedUser("u8_a");
    B = seedUser("u8_b");
    bridge = makeTrailBridge();
    // applyVerifiedProfile reaches the database through getServiceClient(); the
    // same bridge answers it, as the one service client does in production.
    _setTestServiceClient(bridge.client);
  });

  after(() => {
    _setTestServiceClient(null);
    for (const id of [A, B]) {
      if (!id) continue;
      exec(
        `DELETE FROM public.trust_events WHERE user_id = '${id}';\n` +
        `DELETE FROM public.trust_profiles WHERE user_id = '${id}';\n` +
        `DELETE FROM public.identity_verifications WHERE user_id = '${id}';`,
      );
      deleteUser(id);
    }
  });

  it("U8-0 — the preconditions: 2870's widened CHECK, 2370's revocations, RLS on identity_verifications", () => {
    const def = scalar(
      `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'profiles_verification_level_check';`,
    ) ?? "";
    for (const v of ["id_verified", "id_selfie_verified"]) {
      assert.ok(def.includes(`'${v}'`), `2870 is not in force here — ${v} missing from ${def}`);
    }
    const leaks = scalar(
      `SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public' ` +
      `AND table_name LIKE 'trust\\_%' AND grantee IN ('anon','authenticated','PUBLIC');`,
    );
    assert.equal(leaks, "0", "2370 is not in force here: a client role holds a privilege on a trust table");
    assert.equal(
      scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.identity_verifications'::regclass;`),
      "t",
      "RLS is off on identity_verifications — U8-4 would prove nothing",
    );
  });

  it("U8-1 — a VERIFIED result is stored end to end, with the level toVerificationLevel returns (both values)", async () => {
    for (const selfieMatch of [true, false]) {
      closeActive(A);
      exec(`UPDATE public.profiles SET verification_level = 'none', verified_at = NULL WHERE id = '${A}';`);
      const sid = seedSession(A);
      const result: VerificationResult = {
        provider: "mock",
        providerSessionId: sid,
        providerVerificationRef: `ref_${sid}`,
        status: "verified",
        isOver18: true,
        selfieMatch,
        documentCountry: "GB",
        verifiedAt: "2026-10-03T12:00:00.000Z",
      };
      await persistResult(bridge.client, result);

      const [row] = rows<Record<string, unknown>>(
        `SELECT status, failure_reason, is_over_18, selfie_match, document_country, provider_verification_ref, ` +
        `verified_at IS NOT NULL AS has_verified_at FROM public.identity_verifications WHERE provider_session_id = '${sid}'`,
      );
      assert.deepEqual(row, {
        status: "verified", failure_reason: null, is_over_18: true, selfie_match: selfieMatch,
        document_country: "GB", provider_verification_ref: `ref_${sid}`, has_verified_at: true,
      });
      const want = toVerificationLevel(result);
      assert.equal(want, selfieMatch ? "id_selfie_verified" : "id_verified");
      assert.equal(level(A), want, `profiles.verification_level must be what the code wrote (${want})`);
    }
  });

  it("U8-2 — a FAILED `underage` result is stored as the verified-minor evidence and does not raise the level", async () => {
    closeActive(A);
    exec(`UPDATE public.profiles SET verification_level = 'none', verified_at = NULL WHERE id = '${A}';`);
    const sid = seedSession(A);
    await persistResult(bridge.client, {
      provider: "mock",
      providerSessionId: sid,
      providerVerificationRef: `ref_${sid}`,
      status: "failed",
      failureReason: "underage",
      isOver18: false,
    });
    const [row] = rows<Record<string, unknown>>(
      `SELECT status, failure_reason, is_over_18, verified_at, provider_verification_ref ` +
      `FROM public.identity_verifications WHERE provider_session_id = '${sid}'`,
    );
    assert.deepEqual(row, {
      status: "failed", failure_reason: "underage", is_over_18: false, verified_at: null,
      provider_verification_ref: `ref_${sid}`,
    });
    assert.equal(level(A), "none", "a failed check raised the verification level");
  });

  it("U8-3 — the constraints refuse an unknown status, an unknown level and a second ACTIVE session", () => {
    closeActive(A);
    const sid = seedSession(A);

    const badStatus = psql(`UPDATE public.identity_verifications SET status = 'approved' WHERE provider_session_id = '${sid}';`);
    assert.notEqual(badStatus.status, 0, "an unknown status was stored");
    assert.match(badStatus.stderr, /identity_verifications_status_check/);

    const badLevel = psql(`UPDATE public.profiles SET verification_level = 'gov_id_ok' WHERE id = '${A}';`);
    assert.notEqual(badLevel.status, 0, "an unknown verification_level was stored");
    assert.match(badLevel.stderr, /profiles_verification_level_check/);

    const second = psql(
      `INSERT INTO public.identity_verifications (user_id, provider, provider_session_id, status) ` +
      `VALUES ('${A}', 'mock', 'u8_second_${randomUUID()}', 'pending');`,
    );
    assert.notEqual(second.status, 0, "a second active session was opened for one user");
    assert.match(second.stderr, /uq_identity_verifications_active/);
    closeActive(A);
  });

  it("U8-4 — RLS: own rows only, no client-side write of any kind, nothing for anon", () => {
    closeActive(A);
    closeActive(B);
    const mine = seedSession(A);
    const theirs = seedSession(B);

    const readA = asRole("authenticated", A, `SELECT provider_session_id FROM public.identity_verifications WHERE provider_session_id IN ('${mine}', '${theirs}');`);
    assert.equal(readA.status, 0, readA.stderr);
    assert.deepEqual(outLines(readA.stdout, A), [mine], "a user must read their own row and not another user's");

    const insert = asRole(
      "authenticated", A,
      `INSERT INTO public.identity_verifications (user_id, provider, provider_session_id, status, is_over_18) ` +
      `VALUES ('${A}', 'mock', 'u8_forged_${randomUUID()}', 'verified', true);`,
    );
    assert.notEqual(insert.status, 0, "a client role inserted a verification row");
    assert.match(insert.stderr, /row-level security|permission denied/);

    const update = asRole("authenticated", A, `UPDATE public.identity_verifications SET is_over_18 = true, status = 'verified' WHERE provider_session_id = '${mine}' RETURNING id;`);
    assert.equal(update.status, 0, update.stderr);
    assert.deepEqual(outLines(update.stdout, A), [], "a client role updated its own verification row");
    assert.equal(scalar(`SELECT status FROM public.identity_verifications WHERE provider_session_id = '${mine}';`), "pending");

    const del = asRole("authenticated", A, `DELETE FROM public.identity_verifications WHERE provider_session_id = '${mine}' RETURNING id;`);
    assert.equal(del.status, 0, del.stderr);
    assert.deepEqual(outLines(del.stdout, A), [], "a client role deleted its own verification row");
    assert.equal(scalar(`SELECT count(*) FROM public.identity_verifications WHERE provider_session_id = '${mine}';`), "1");

    const anon = asRole("anon", null, `SELECT count(*) FROM public.identity_verifications WHERE provider_session_id IN ('${mine}', '${theirs}');`);
    assert.equal(anon.status, 0, anon.stderr);
    assert.deepEqual(outLines(anon.stdout, null), ["0"], "anon read a verification row");
    closeActive(A);
    closeActive(B);
  });

  it("U8-5 — 2370: anon and authenticated are REFUSED every trust table (42501); the service role reads them", () => {
    for (const t of TRUST_TABLES) {
      for (const [role, uid] of [["anon", null], ["authenticated", A]] as const) {
        const r = asRole(role, uid, `SELECT count(*) FROM public.${t};`);
        assert.notEqual(r.status, 0, `${role} read public.${t}`);
        assert.match(r.stderr, /permission denied/, `${role} on ${t}: ${r.stderr}`);
      }
      const svc = psql(`SET LOCAL ROLE service_role;\nSELECT count(*) FROM public.${t};`, { single: true });
      assert.equal(svc.status, 0, `service_role could not read public.${t}: ${svc.stderr}`);
    }
  });
});
