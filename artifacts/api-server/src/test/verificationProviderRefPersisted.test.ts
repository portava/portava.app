/**
 * THE REDACTION HANDLE IS PERSISTED FOR EVERY STATE, NOT ONLY FOR SUCCESS.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `provider_verification_ref` is the ONLY handle anyone holds on the vendor's
 * copy of a user's government ID. `services/identityVerification/providerErasure.ts`
 * reads that column and nothing else, so a row whose ref is null is reported as
 * "nothing to redact" and the document stays at Stripe or Persona forever.
 *
 * A FAILED or EXPIRED attempt uploaded exactly the same document as a verified
 * one. Both adapters know this and set the handle for every state on purpose —
 * `services/identityVerification/persona.ts:122` ("Set for every state, because
 * a DECLINED inquiry still left a government ID at Persona") and
 * `services/identityVerification/stripeIdentity.ts:182` ("Set for every state a
 * session can be in, because a FAILED session also left documents at Stripe").
 *
 * `routes/verification.ts` then threw it away for four of the five states a
 * session can reach, by building the column inside `if (status === "verified")`.
 * The adapters' comments and the route disagreed, and the route won.
 *
 * ── ABSENT IS UNKNOWN, NOT "NO REF" ─────────────────────────────────────────
 * The persist path is driven by webhooks, and a later event may legitimately
 * omit a field an earlier one carried. Writing `?? null` for a missing ref
 * would let a second event ERASE a handle the first one supplied — silently,
 * and with the same effect as never having written it. So the column is
 * written only when the adapter actually produced a handle, and left alone
 * otherwise. Test 5 is that distinction and nothing else.
 *
 * ── WHAT WOULD TURN THIS RED ────────────────────────────────────────────────
 * Moving the assignment back inside the `verified` branch (tests 1-3 and 6);
 * widening it to overwrite with null (test 5); letting it drag `verified_at`
 * out of the verified branch with it (test 4).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/verificationProviderRefPersisted.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import { persistResult } from "../routes/verification.js";
import { requestProviderDeletionForUser } from "../services/identityVerification/providerErasure.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import type {
  VerificationResult,
  NormalizedVerificationStatus,
  IdentityVerificationProvider,
} from "../services/identityVerification/types.js";

const USER = "dd000000-0000-4000-a000-000000000077";
const SESSION = "sess-failed-1";
const REF = "vs_1QabcDEADBEEF";

/**
 * `ref: null` means the adapter produced NO handle — the field is left off the
 * result entirely. It is spelled `null` rather than `undefined` on purpose:
 * passing `undefined` to an optional parameter re-triggers its default, which
 * would silently turn the omission case back into the REF case and make test 5
 * pass against code that nulls the column. (It did, on the first draft.)
 */
function resultWith(
  status: NormalizedVerificationStatus,
  ref: string | null = REF,
): VerificationResult {
  const r: VerificationResult = {
    provider: "mock",
    providerSessionId: SESSION,
    status,
  };
  if (ref !== null) r.providerVerificationRef = ref;
  if (status === "failed") r.failureReason = "document_invalid";
  if (status === "verified") r.verifiedAt = "2026-06-01T00:00:00.000Z";
  return r;
}

function spec(): FakeClientSpec {
  return {
    rows: {
      identity_verifications: [
        { id: "v1", user_id: USER, provider_session_id: SESSION, status: "processing" },
      ],
      profiles: [{ id: USER, verification_level: "none", verified_at: null }],
      trust_events: [],
      trust_profiles: [{ user_id: USER, score: 50 }],
    },
  };
}

/** The single `identity_verifications` patch persistResult actually sent. */
async function patchFor(result: VerificationResult): Promise<Record<string, any>> {
  const s = spec();
  const client = makeFailClosedClient(s);
  _setTestServiceClient(client);
  await persistResult(client as any, result, USER);
  const patches = s.updated?.["identity_verifications"] ?? [];
  assert.equal(patches.length, 1, "expected exactly one identity_verifications update to be ISSUED");
  return patches[0];
}

describe("provider_verification_ref survives every terminal state", () => {
  it("a FAILED attempt persists the redaction handle — the document is at the vendor either way", async () => {
    const patch = await patchFor(resultWith("failed"));
    assert.equal(
      patch.provider_verification_ref,
      REF,
      "a failed attempt uploaded a government ID; without this column providerErasure.ts " +
        "reports 'nothing to redact' and the vendor's copy is unreachable forever",
    );
  });

  it("an EXPIRED attempt persists the redaction handle", async () => {
    const patch = await patchFor(resultWith("expired"));
    assert.equal(patch.provider_verification_ref, REF);
  });

  it("a CANCELED attempt persists the redaction handle", async () => {
    const patch = await patchFor(resultWith("canceled"));
    assert.equal(patch.provider_verification_ref, REF);
  });

  it("REGRESSION: verified still persists the handle AND verified_at; a failure persists NEITHER a verified_at", async () => {
    const ok = await patchFor(resultWith("verified"));
    assert.equal(ok.provider_verification_ref, REF);
    assert.equal(ok.verified_at, "2026-06-01T00:00:00.000Z");

    const bad = await patchFor(resultWith("failed"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(bad, "verified_at"),
      false,
      "verified_at is the success-only half and must NOT be dragged out of the verified branch",
    );
  });

  it("ABSENT IS UNKNOWN: a result carrying no ref leaves the column alone rather than nulling it", async () => {
    const patch = await patchFor(resultWith("failed", null));
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, "provider_verification_ref"),
      false,
      "a later webhook that omits the ref must not ERASE a handle an earlier one supplied — " +
        "an overwrite with null is byte-identical to never having stored it",
    );
  });

  it("AN EMPTY STRING IS NOT A HANDLE: it is left off too, so it cannot overwrite a real ref", async () => {
    // Found by mutation M4 (dropping `.length > 0` from the guard), which
    // SURVIVED the first six tests. An empty ref is not merely useless — a
    // second webhook carrying "" would replace a handle the first one stored,
    // and providerErasure.ts drops empty strings exactly as it drops nulls, so
    // the vendor's copy becomes unreachable with the row still looking written.
    const patch = await patchFor(resultWith("failed", ""));
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, "provider_verification_ref"),
      false,
      "an empty-string ref must not be persisted — it destroys a stored handle and redacts nothing",
    );
  });

  it("END TO END: the handle a failed attempt persists is the one providerErasure asks the vendor to redact", async () => {
    // Stage 1 — what the route writes for a failed attempt.
    const patch = await patchFor(resultWith("failed"));

    // Stage 2 — a row in that state, read by the real erasure function.
    const redacted: string[] = [];
    const provider = {
      requestProviderDeletion: async (ref: string) => { redacted.push(ref); },
    } as unknown as IdentityVerificationProvider;

    const erasureSpec: FakeClientSpec = {
      rows: {
        identity_verifications: [
          { id: "v1", user_id: USER, provider_verification_ref: patch.provider_verification_ref ?? null },
        ],
      },
    };
    const out = await requestProviderDeletionForUser(
      makeFailClosedClient(erasureSpec) as any,
      USER,
      () => provider,
    );

    assert.deepEqual(
      redacted,
      [REF],
      "the erasure step must ask the vendor to redact the failed attempt's document; " +
        "an empty list here is the silent data-rights failure this file exists for",
    );
    assert.equal(out.requested, 1);
  });
});
