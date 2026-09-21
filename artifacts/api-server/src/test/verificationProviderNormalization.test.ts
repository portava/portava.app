/**
 * TV-6b (adapter normalization) and the privacy invariants it must not break.
 *
 * The Stripe and Persona adapters were stubs whose every method threw. They now
 * normalize real vendor payload shapes. This file measures the two things about
 * that normalization which do NOT need a vendor account to be true:
 *
 *   1. PRIVACY. Invariants 1 and 2 of `docs/trust/verified-foundation-plan.md`:
 *      no raw ID, document number, selfie or date of birth enters Portava. Both
 *      vendors hand us a date of birth on the success path — Stripe as
 *      `verified_outputs.dob`, Persona as `attributes.birthdate` — and the
 *      adapters are the ONLY place that value is ever in scope. These tests
 *      scan the whole serialized result for the DOB rather than checking named
 *      fields, because a named-field test is exactly the one that passed while
 *      a serializer leaked (census-trust §4).
 *
 *   2. THE DANGEROUS DEFAULT. Every status mapping has one direction that is
 *      catastrophic and one that is merely annoying. An unknown status read as
 *      `verified` hands a stranger a government-ID badge; read as `pending` it
 *      costs a poll. The mappings default to the safe direction and these tests
 *      pin that, including for statuses the vendors have not invented yet.
 *
 * WHAT THIS FILE DOES NOT CERTIFY. That Stripe and Persona actually send these
 * shapes. Nothing here has spoken to either vendor. census-trust TV-6b stays
 * BUILT-BUT-WRONG until a sandbox transcript exists; this file is the reason
 * the row moved off NOT-BUILT, not a reason to move it to C.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationProviderNormalization.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveIsOver18,
  deriveIsOver18FromIso,
  mapStripeFailureCode,
  normalizeStripeSession,
  normalizeStripeWebhook,
} from "../services/identityVerification/stripeIdentity.js";
import {
  mapPersonaCheckName,
  mapPersonaStatus,
  normalizePersonaInquiry,
  normalizePersonaWebhook,
} from "../services/identityVerification/persona.js";
import { toVerificationLevel } from "../services/identityVerification/types.js";
import type { VerificationResult } from "../services/identityVerification/types.js";

/** 2026-09-14T00:00:00Z — fixed so "is this person 18" is not a moving target. */
const NOW = Date.UTC(2026, 8, 14);

/** Serialize the whole result and look for anything that could be a DOB. */
function assertNoDateOfBirth(result: VerificationResult | null, dobParts: string[]): void {
  assert.ok(result, "expected a result to scan");
  const blob = JSON.stringify(result);
  for (const part of dobParts) {
    assert.equal(
      blob.includes(part),
      false,
      `date-of-birth component ${part} leaked into the normalized result: ${blob}`,
    );
  }
  // And the key itself, under any spelling the vendors use.
  for (const key of ["dob", "birthdate", "birth_date", "dateOfBirth"]) {
    assert.equal(blob.toLowerCase().includes(key.toLowerCase()), false, `${key} key present in ${blob}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("deriveIsOver18 — the only permitted reduction of a date of birth", () => {
  it("is false the day BEFORE the 18th birthday and true ON it", () => {
    // Born 2008-09-14 → 18th birthday is 2026-09-14, which is NOW.
    assert.equal(deriveIsOver18({ year: 2008, month: 9, day: 14 }, NOW), true);
    // Born 2008-09-15 → turns 18 tomorrow.
    assert.equal(deriveIsOver18({ year: 2008, month: 9, day: 15 }, NOW), false);
  });

  it("is exact across a leap day rather than dividing by 365.25", () => {
    // Born 2008-02-29 (a leap day). 18th birthday is 2026-03-01 by Date.UTC
    // normalization, i.e. already past on 2026-09-14.
    assert.equal(deriveIsOver18({ year: 2008, month: 2, day: 29 }, NOW), true);
    // The near-boundary case a 365.25-day division gets wrong: born
    // 2008-09-13, checked on 2026-09-13.
    assert.equal(deriveIsOver18({ year: 2008, month: 9, day: 13 }, Date.UTC(2026, 8, 13)), true);
    assert.equal(deriveIsOver18({ year: 2008, month: 9, day: 13 }, Date.UTC(2026, 8, 12)), false);
  });

  it("returns undefined — NOT false — when the provider gave no usable DOB", () => {
    // `is_over_18` is a nullable column. null means "unknown" and false means
    // "we checked and they are a minor". Collapsing unknown into false would
    // write a finding Portava never made.
    assert.equal(deriveIsOver18(null), undefined);
    assert.equal(deriveIsOver18(undefined), undefined);
    assert.equal(deriveIsOver18({}), undefined);
    assert.equal(deriveIsOver18({ year: "nineteen", month: 1, day: 1 }), undefined);
    assert.equal(deriveIsOver18({ year: 1990, month: 13, day: 1 }), undefined);
    assert.equal(deriveIsOver18FromIso(undefined), undefined);
    assert.equal(deriveIsOver18FromIso("not-a-date"), undefined);
  });

  it("returns a boolean and nothing else — there is no variant that yields an age", () => {
    const v = deriveIsOver18({ year: 1990, month: 7, day: 4 }, NOW);
    assert.equal(typeof v, "boolean");
    assert.equal(deriveIsOver18FromIso("1990-07-04", NOW), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Stripe normalization", () => {
  const verifiedSession = {
    id: "vs_abc",
    status: "verified",
    last_verification_report: "vr_abc",
    options: { document: { require_matching_selfie: true } },
    verified_outputs: { dob: { day: 4, month: 7, year: 1990 }, address: { country: "ph" } },
  };

  it("maps a verified session to the fields the row actually stores", () => {
    const r = normalizeStripeSession(verifiedSession, NOW);
    assert.ok(r);
    assert.equal(r.provider, "stripe");
    assert.equal(r.providerSessionId, "vs_abc");
    assert.equal(r.status, "verified");
    assert.equal(r.isOver18, true);
    assert.equal(r.selfieMatch, true);
    assert.equal(r.documentCountry, "PH");
    assert.equal(toVerificationLevel(r), "id_selfie_verified");
  });

  it("stores the SESSION id as the redaction handle, not the report id", () => {
    // requestProviderDeletionForUser redacts by provider_verification_ref, and
    // Stripe's redact endpoint takes the session. A `vr_…` there would be an
    // unredactable pointer at the document images themselves.
    const r = normalizeStripeSession(verifiedSession, NOW);
    assert.equal(r?.providerVerificationRef, "vs_abc");
    assert.notEqual(r?.providerVerificationRef, "vr_abc");
  });

  it("sets the redaction handle even on a FAILED session", () => {
    // A failed attempt still left a government ID at Stripe. If the handle is
    // only written on success, erasure can never reach it.
    const r = normalizeStripeSession(
      { id: "vs_fail", status: "requires_input", last_error: { code: "document_expired" } },
      NOW,
    );
    assert.equal(r?.providerVerificationRef, "vs_fail");
  });

  it("NEVER puts the date of birth in the result", () => {
    assertNoDateOfBirth(normalizeStripeSession(verifiedSession, NOW), ["1990", "-07-", "07/04"]);
  });

  it("does not claim a selfie match when no selfie was requested", () => {
    // undefined, not false: false means "asked and did not match", which would
    // be a finding Stripe never made.
    const r = normalizeStripeSession(
      { ...verifiedSession, options: { document: { require_matching_selfie: false } } },
      NOW,
    );
    assert.equal(r?.selfieMatch, undefined);
    assert.equal(toVerificationLevel(r!), "id_verified");
  });

  it("distinguishes requires_input-with-an-error (failed) from requires_input-alone (pending)", () => {
    // The user who has not finished yet and the user whose document was
    // rejected arrive under the SAME Stripe status. Reading both as `failed`
    // shows a rejection screen to someone mid-flow.
    const stillWorking = normalizeStripeSession({ id: "vs_1", status: "requires_input" }, NOW);
    assert.equal(stillWorking?.status, "pending");
    assert.equal(stillWorking?.failureReason, undefined);

    const rejected = normalizeStripeSession(
      { id: "vs_2", status: "requires_input", last_error: { code: "document_unverified_other" } },
      NOW,
    );
    assert.equal(rejected?.status, "failed");
    assert.equal(rejected?.failureReason, "document_invalid");
  });

  it("maps every documented last_error family to its normalized reason", () => {
    assert.equal(mapStripeFailureCode("under_supported_age"), "underage");
    assert.equal(mapStripeFailureCode("document_expired"), "document_invalid");
    assert.equal(mapStripeFailureCode("document_type_not_supported"), "document_invalid");
    assert.equal(mapStripeFailureCode("selfie_face_mismatch"), "selfie_mismatch");
    assert.equal(mapStripeFailureCode("selfie_manipulated"), "selfie_mismatch");
    // Reads "selfie" first even though the name also contains "document".
    assert.equal(mapStripeFailureCode("selfie_document_missing_photo"), "selfie_mismatch");
    assert.equal(mapStripeFailureCode("abandoned"), "abandoned");
    assert.equal(mapStripeFailureCode("consent_declined"), "abandoned");
    // A code Stripe has not invented yet must not land on a wrong specific
    // reason; `other` is what the client renders as a generic retry.
    assert.equal(mapStripeFailureCode("some_future_code"), "other");
    assert.equal(mapStripeFailureCode(undefined), "other");
  });

  it("records isOver18=false on an underage failure", () => {
    const r = normalizeStripeSession(
      { id: "vs_u", status: "requires_input", last_error: { code: "under_supported_age" } },
      NOW,
    );
    assert.equal(r?.failureReason, "underage");
    assert.equal(r?.isOver18, false);
  });

  it("ignores webhook events that are not verification-session events", () => {
    assert.equal(normalizeStripeWebhook({ type: "charge.succeeded", data: { object: { id: "ch_1" } } }), null);
    assert.equal(normalizeStripeWebhook({ type: "identity.verification_session.verified" }), null);
    assert.equal(normalizeStripeWebhook(null), null);
    assert.equal(normalizeStripeWebhook("not an object"), null);
  });

  it("refuses a session object with no id rather than inventing one", () => {
    assert.equal(normalizeStripeSession({ status: "verified" }, NOW), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Persona normalization", () => {
  const completed = {
    id: "inq_abc",
    attributes: {
      status: "completed",
      birthdate: "1990-07-04",
      "country-code": "ph",
      "selfie-status": "passed",
    },
  };

  it("maps a completed inquiry to verified with the derived fields only", () => {
    const r = normalizePersonaInquiry(completed, [], NOW);
    assert.ok(r);
    assert.equal(r.provider, "persona");
    assert.equal(r.providerSessionId, "inq_abc");
    assert.equal(r.providerVerificationRef, "inq_abc");
    assert.equal(r.status, "verified");
    assert.equal(r.isOver18, true);
    assert.equal(r.selfieMatch, true);
    assert.equal(r.documentCountry, "PH");
  });

  it("NEVER puts the birthdate in the result", () => {
    assertNoDateOfBirth(normalizePersonaInquiry(completed, [], NOW), ["1990", "1990-07-04", "07-04"]);
  });

  it("does NOT treat an inquiry awaiting human review as verified", () => {
    // needs_review is not terminal. Reading it as a pass grants the badge the
    // moment a case is filed into a moderator's queue.
    assert.equal(mapPersonaStatus("needs_review"), "processing");
    assert.equal(mapPersonaStatus("marked-for-review"), "processing");
    const r = normalizePersonaInquiry({ ...completed, attributes: { ...completed.attributes, status: "needs_review" } }, [], NOW);
    assert.equal(r?.status, "processing");
    assert.equal(r?.isOver18, undefined, "no age finding from a non-terminal inquiry");
  });

  it("defaults an UNKNOWN status to pending, never to verified", () => {
    // The mapping must fail towards "no standing granted" for any status
    // Persona adds after this was written.
    for (const unknown of ["some_new_status", "", "VERIFIEDISH", null, 7]) {
      assert.equal(mapPersonaStatus(unknown as unknown), "pending", `status ${String(unknown)}`);
    }
  });

  it("maps failed check names to normalized reasons", () => {
    assert.equal(mapPersonaCheckName("id_selfie_comparison"), "selfie_mismatch");
    assert.equal(mapPersonaCheckName("liveness_detection"), "selfie_mismatch");
    assert.equal(mapPersonaCheckName("id_age_comparison"), "underage");
    assert.equal(mapPersonaCheckName("id_expired_detection"), "document_invalid");
    assert.equal(mapPersonaCheckName("something_else"), "other");
  });

  it("reads the failing check out of the webhook's included[] array", () => {
    const body = {
      data: {
        attributes: {
          name: "inquiry.failed",
          payload: {
            data: { id: "inq_f", attributes: { status: "failed" } },
            included: [
              { type: "verification/government-id", attributes: { status: "passed", checks: [] } },
              {
                type: "verification/selfie",
                attributes: { status: "failed", checks: [{ name: "selfie_face_comparison", status: "failed" }] },
              },
            ],
          },
        },
      },
    };
    const r = normalizePersonaWebhook(body, NOW);
    assert.equal(r?.status, "failed");
    assert.equal(r?.failureReason, "selfie_mismatch");
  });

  it("lets the EVENT NAME override an ambiguous inquiry status", () => {
    // inquiry.failed carrying attributes.status 'completed' must not verify.
    const body = {
      data: {
        attributes: {
          name: "inquiry.failed",
          payload: { data: { id: "inq_x", attributes: { status: "completed", birthdate: "1990-07-04" } } },
        },
      },
    };
    const r = normalizePersonaWebhook(body, NOW);
    assert.equal(r?.status, "failed");
    assert.equal(r?.verifiedAt, undefined);
    assertNoDateOfBirth(r, ["1990"]);
  });

  it("ignores lifecycle events that carry no verdict", () => {
    for (const name of ["inquiry.created", "inquiry.started", "inquiry.transitioned"]) {
      const body = { data: { attributes: { name, payload: { data: { id: "inq_y", attributes: { status: "created" } } } } } };
      assert.equal(normalizePersonaWebhook(body, NOW), null, name);
    }
    assert.equal(normalizePersonaWebhook({ data: { attributes: { name: "account.created" } } }, NOW), null);
    assert.equal(normalizePersonaWebhook(null, NOW), null);
  });

  it("refuses an inquiry with no id", () => {
    assert.equal(normalizePersonaInquiry({ attributes: { status: "completed" } }, [], NOW), null);
  });
});
