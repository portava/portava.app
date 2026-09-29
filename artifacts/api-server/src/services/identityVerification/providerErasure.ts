/**
 * Asking the identity provider to delete ITS copy, before we delete ours.
 *
 * ── WHY THIS IS A SEPARATE FILE AND NOT THREE LINES IN THE CASCADE ──────────
 * verified-foundation-plan.md V-7 reads: "Account-deletion flow calls
 * `provider.requestProviderDeletion()` **then** deletes the user's
 * `identity_verifications` rows."
 *
 * The word "then" is the whole requirement. `provider_verification_ref` is the
 * only handle anyone has on the provider's copy of the government-ID check; the
 * moment the row is deleted that handle is gone and the images at Stripe or
 * Persona become unredactable — by us, and by the user, permanently. So the
 * read, the request and the delete are ordered, and the ordering has to be
 * assertable from outside. It is, in
 * `src/test/verificationProviderErasure.test.ts`.
 *
 * `requestProviderDeletion` was declared at types.ts:101, implemented as a
 * no-op by the mock, mapped for both real vendors in providers.ts comments —
 * and called from nowhere in this repository. Erasure removed our opaque
 * reference and left the document with the vendor. That is the one part of a
 * user's data they cannot reach themselves.
 *
 * ── THE TWO FAILURE DIRECTIONS, AND WHY THEY ARE NOT SYMMETRIC ──────────────
 * This function THROWS on anything it cannot complete, so the caller's `step()`
 * records a named failure instead of a silent success. It does not, and must
 * not, decide what the caller does with that:
 *
 *   * A provider that is down must NOT block the erasure. A user's right to
 *     have Portava's copy deleted does not depend on a vendor being up, and
 *     refusing would keep their data here indefinitely for a reason that is not
 *     theirs. The cascade therefore records the failed step, raises a warning
 *     naming the refs, and proceeds.
 *   * An UNREADABLE `identity_verifications` is different in kind and is the
 *     reason `error` is bound below. supabase-js RESOLVES on a database error,
 *     so an unbound read makes a table that could not be read look exactly like
 *     a user who never verified — `data: null`, no rows, nothing to redact —
 *     and the rows would then be deleted having never been offered to the
 *     provider, with the step reporting ok.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdentityVerificationProvider } from "./types.js";
import { getIdentityProvider } from "./providers.js";

export interface ProviderErasureResult {
  /** Opaque provider references found for this user, in read order. */
  refs: string[];
  /** How many the provider confirmed it would redact. */
  requested: number;
}

/**
 * Ask the configured provider to redact every verification reference this user
 * has. Returns the refs so the caller can name them if a later step fails.
 *
 * @param providerFactory injected only by tests; production always uses the
 *   env-driven factory, which refuses the mock in production (invariant 4).
 */
export async function requestProviderDeletionForUser(
  db: SupabaseClient,
  userId: string,
  providerFactory: () => IdentityVerificationProvider = getIdentityProvider,
): Promise<ProviderErasureResult> {
  const { data, error } = await db
    .from("identity_verifications")
    .select("id, provider_verification_ref")
    .eq("user_id", userId)
    .not("provider_verification_ref", "is", null);

  if (error) {
    throw new Error(
      `read identity_verifications for provider erasure: ${error.message} — ` +
        `REFUSING to report 'nothing to redact' about a table that could not be read`,
    );
  }

  const refs = ((data ?? []) as Array<{ provider_verification_ref?: string | null }>)
    .map((r) => r.provider_verification_ref)
    .filter((r): r is string => typeof r === "string" && r.length > 0);

  // Nothing to redact: do not build the provider. In production the factory
  // THROWS for the default IDENTITY_PROVIDER=mock (invariant 4), so consulting
  // it here would turn "this user never completed a verification" — which is
  // almost every user — into a failed erasure step on every deletion.
  if (refs.length === 0) return { refs: [], requested: 0 };

  const provider = providerFactory();

  const failures: string[] = []; let refusedByGuard = 0; // sandbox-guard refusals (lib/paymentsMode.ts), counted apart
  for (const ref of refs) {
    try {
      await provider.requestProviderDeletion(ref);
    } catch (err: any) {
      if (isPaymentsLiveModeRefusal(err)) refusedByGuard++; failures.push(`${ref}: ${err?.message ?? String(err)}`);
    }
  }

  if (failures.length > 0) {
    // The refs are in the message on purpose: the rows that hold them are about
    // to be deleted, so this string may be the only surviving record of what
    // still needs redacting at the vendor.
    throw new ProviderErasureFailure(
      `provider erasure failed for ${failures.length} of ${refs.length} reference(s) — ` +
        `${refusedByGuard > 0 ? `${GUARD_REFUSED_TEXT} ` : ""}redact by hand at the provider: ${failures.join("; ")}`, refusedByGuard > 0,
    );
  }

  return { refs, requested: refs.length };
}

// ── Sandbox-only guard (appended at the foot so every cited line keeps its number) ──
//
// DECISION. Redacting a LIVE session is still possible when a live key is
// explicitly allowed (PAYMENTS_ALLOW_LIVE === "true"): the adapters' key guard
// lets it through and the redact call is made. With live refused, the guard
// throws before any fetch, and this function records that as a named,
// RETRIABLE failure carrying every ref — never a silent success. Whether the
// cascade should then KEEP the identity_verifications rows so a later run can
// retry automatically is a data-retention decision the caller owns
// (AccountDeletionService); today it records the step failure, surfaces the
// refs in a warning and proceeds.
import { isPaymentsLiveModeRefusal } from "../../lib/paymentsMode.js";

const GUARD_REFUSED_TEXT =
  "RETRIABLE: the sandbox guard refused the provider call before anything was sent (a live key without " +
  "PAYMENTS_ALLOW_LIVE=\"true\", or an unrecognised key). If these are live sessions and live use is approved, " +
  "set PAYMENTS_ALLOW_LIVE=true and retry; otherwise";

/** The erasure failure. `retriable` is true when the sandbox guard refused (nothing was sent). */
export class ProviderErasureFailure extends Error {
  readonly code = "provider_erasure_failed" as const;
  constructor(message: string, readonly retriable: boolean) {
    super(message);
    this.name = "ProviderErasureFailure";
  }
}
