/**
 * VERIFICATION WRITES ARE ISSUED, NOT MERELY CONSTRUCTED.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * `PostgrestBuilder` is a THENABLE, not a promise. Nothing is sent until
 * something calls `.then` on it — an `await`, a `.then(...)`, a `.catch(...)`.
 * So
 *
 *     void sc.from("identity_verifications").insert({ … });
 *
 * builds a request object and drops it. No row is written, no error is
 * returned, and every test that asserts on the returned VALUE passes, because
 * there is no value to be wrong. Twenty writes of that shape shipped in this
 * repository (src/scripts/checkUnissuedSupabaseWrites.ts records the class).
 *
 * The near-miss that is NOT this bug: `void someAsyncFunction()` DOES run —
 * calling an async function executes its body. Only a bare BUILDER is inert.
 *
 * ── WHAT THIS FILE MEASURES ─────────────────────────────────────────────────
 * ID verification gates real things elsewhere: routes/rentABuddyRollout.ts
 * refuses a booking under MVP mode when the travelling party is not
 * ID-verified, reading the same `profiles.verification_level` that
 * `persistResult` writes. A verification write that is never issued is a gate
 * that never closes for a user who did the work, and a gate that never OPENS
 * for one who did — silently, on a 200.
 *
 * So this counts REQUESTS, at runtime, rather than reading the source. The
 * counter is proven first: test 1 shows a bare builder registers ZERO requests
 * through the same instrument, so a later count of 1 cannot be the double
 * recording construction.
 *
 * The double is src/test/helpers/failClosedSupabase.ts, whose header records
 * thenable execution as MODELLED EXACTLY and measured against the real client
 * ("a builder with no `.then`/`await` performs NOTHING, one with either
 * performs it once") — checked every CI run by src/test/supabaseContract.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationWritesIssued.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import { persistResult } from "../routes/verification.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import type { VerificationResult } from "../services/identityVerification/types.js";

const USER = "dd000000-0000-4000-a000-000000000044";
const SESSION = "sess-abc";
const VERIFIED_AT = "2026-06-01T00:00:00.000Z";

const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

function verifiedResult(): VerificationResult {
  return {
    provider: "mock",
    providerSessionId: SESSION,
    status: "verified",
    isOver18: true,
    selfieMatch: true,
    documentCountry: "US",
    verifiedAt: VERIFIED_AT,
    providerVerificationRef: "ref-1",
    failureReason: null,
  } as unknown as VerificationResult;
}

function spec(): FakeClientSpec {
  return {
    rows: {
      identity_verifications: [
        { id: "v1", user_id: USER, provider_session_id: SESSION, status: "pending" },
      ],
      profiles: [{ id: USER, verification_level: "none", verified_at: null }],
      trust_events: [],
      trust_profiles: [{ user_id: USER, score: 50 }],
    },
  };
}

/** Every write the double actually SETTLED, flattened for counting. */
function writeCount(s: FakeClientSpec, table: string): number {
  return (s.updated?.[table]?.length ?? 0) + (s.inserted?.[table]?.length ?? 0);
}

describe("verification writes are issued", () => {
  it("INSTRUMENT PROOF: a bare, unawaited builder registers ZERO requests", async () => {
    const s = spec();
    const client = makeFailClosedClient(s);

    // Exactly the dead shape. No await, no .then, no .catch.
    void client.from("identity_verifications").insert({ user_id: USER, status: "pending" });
    void client.from("profiles").update({ verification_level: "id_selfie" }).eq("id", USER);

    // Let any microtask that a real promise would have scheduled drain.
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      writeCount(s, "identity_verifications"),
      0,
      "a bare PostgrestBuilder must send NOTHING — if this is 1 the counter measures construction, not issue",
    );
    assert.equal(writeCount(s, "profiles"), 0);
  });

  it("INSTRUMENT PROOF: `void someAsyncFunction()` DOES run — the near-miss is not the bug", async () => {
    const s = spec();
    const client = makeFailClosedClient(s);

    async function write() {
      await client.from("profiles").update({ verification_level: "id_selfie" }).eq("id", USER);
    }
    void write();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      writeCount(s, "profiles"),
      1,
      "calling an async function executes its body; only a bare builder is inert",
    );
  });

  it("persistResult ISSUES the identity_verifications update exactly once", async () => {
    const s = spec();
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    await persistResult(client as any, verifiedResult(), USER);

    assert.equal(
      writeCount(s, "identity_verifications"),
      1,
      "the verification row write must be SENT, not merely built",
    );
    const patch = s.updated!["identity_verifications"][0];
    assert.equal(patch.status, "verified");
    assert.equal(patch.verified_at, VERIFIED_AT);
    assert.equal(patch.is_over_18, true);
    assert.equal(patch.selfie_match, true);
  });

  it("persistResult ISSUES the profiles.verification_level write — the column the booking gate reads", async () => {
    const s = spec();
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    await persistResult(client as any, verifiedResult(), USER);

    assert.equal(
      writeCount(s, "profiles"),
      1,
      "routes/rentABuddyRollout.ts gates bookings on profiles.verification_level; an unissued write leaves it 'none'",
    );
    const patch = s.updated!["profiles"][0];
    assert.notEqual(patch.verification_level, "none", "a verified session must raise the level off 'none'");
    assert.equal(patch.verified_at, VERIFIED_AT);
  });

  it("a FAILED identity_verifications write propagates instead of reporting a clean persist", async () => {
    const s: FakeClientSpec = {
      ...spec(),
      failWritesOn: (t) => (t === "identity_verifications" ? { message: "deadlock detected", code: "40P01" } : null),
    };
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    await assert.rejects(
      () => persistResult(client as any, verifiedResult(), USER),
      /persist identity_verifications/,
      "supabase-js RESOLVES on a write error; an unthrown one tells the provider 200 and stops its retries",
    );

    // And the downstream profile write must NOT have happened on that path.
    assert.equal(writeCount(s, "profiles"), 0, "no verification_level may be granted off a failed persist");
  });

  it("a non-verified result does NOT touch profiles.verification_level", async () => {
    const s = spec();
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    const failed = { ...verifiedResult(), status: "failed", failureReason: "document_unreadable" };
    await persistResult(client as any, failed as unknown as VerificationResult, USER);

    assert.equal(writeCount(s, "identity_verifications"), 1, "the outcome is still recorded");
    assert.equal(
      writeCount(s, "profiles"),
      0,
      "a failed check must not raise the level the booking gate trusts",
    );
  });
  it("a FAILED session lookup does NOT resolve as 'unknown session' — the H5 silent drop's second door", async () => {
    const s: FakeClientSpec = {
      rows: {
        // The session EXISTS. Only the read of it fails, so "this deployment
        // never created that session" is not an available reading of the null.
        identity_verifications: [
          { id: "v1", user_id: USER, provider_session_id: SESSION, status: "pending" },
        ],
        profiles: [{ id: USER, verification_level: "none", verified_at: null }],
      },
      failOn: (ctx) => (ctx.table === "identity_verifications" ? READ_ERROR : null),
    };
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    await assert.rejects(
      // No userId argument, so persistResult must resolve it from the session.
      () => persistResult(client as any, verifiedResult()),
      /lookup identity_verifications by session/,
      "resolving here makes webhookHandler answer 200, the provider stop retrying, and the KYC result vanish",
    );

    assert.equal(writeCount(s, "identity_verifications"), 0, "nothing may be written off an unread lookup");
    assert.equal(writeCount(s, "profiles"), 0);
  });

  it("HEALTHY: a genuinely unknown session is still dropped quietly, without writing anything", async () => {
    const s: FakeClientSpec = {
      rows: { identity_verifications: [], profiles: [] },
    };
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    // A successful read that found nothing: an event for a session this
    // deployment never created. Ignoring it is correct and must stay correct.
    await persistResult(client as any, verifiedResult());

    assert.equal(writeCount(s, "identity_verifications"), 0);
    assert.equal(writeCount(s, "profiles"), 0);
  });
});
