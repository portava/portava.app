/**
 * Identity verification — provider-agnostic types.
 *
 * Drop at: travel-buddy-standalone/server/services/identityVerification/types.ts
 *
 * Every provider (mock, Stripe Identity, Persona, future) implements
 * IdentityVerificationProvider and normalizes its own statuses into
 * NormalizedVerificationStatus. Nothing outside this folder should ever
 * see a provider-specific payload.
 *
 * PRIVACY: adapters must never return or persist raw document images,
 * document numbers, or dates of birth. Derived booleans and opaque
 * provider references only. This is an architectural invariant, not a
 * style preference.
 */

export type VerificationProviderName = 'mock' | 'stripe' | 'persona' | 'sumsub';

/** Mirrors identity_verifications.status in the DB. */
export type NormalizedVerificationStatus =
  | 'created'
  | 'pending'
  | 'processing'
  | 'verified'
  | 'failed'
  | 'expired'
  | 'canceled';

/**
 * ── `coverage_unsupported` IS NOT A FAILURE, AND THAT IS WHY IT IS HERE ──────
 * Every other member of this union is something that happened to one person's
 * one attempt: their document could not be read, their selfie did not match,
 * they are under 18, they walked away, the vendor broke. `coverage_unsupported`
 * is a statement about a MARKET — the provider does not verify anyone there —
 * and it says nothing at all about the person.
 *
 * It was added because the two were being flattened together and the flattening
 * is a real defect, not an untidiness. Stripe Identity returns
 * `country_not_supported` and `mapStripeFailureCode` maps it to `other`
 * (stripeIdentity.ts), so a person in an uncovered market was told "the check
 * didn't go through, please try again" and invited to burn their 3-a-day
 * session budget on a check that can never pass, while the operator's logs
 * showed a generic failure and gave no signal that a whole market was dark.
 * Three different consumers need the distinction:
 *
 *   the person    — "we can't verify documents from your country yet" is an
 *                   answer; "try again" is a lie.
 *   the operator  — one of these is a vendor-coverage fact to act on
 *                   commercially, the other is an ordinary failed check.
 *   the booking    — `lib/rentBuddyKycGate.ts` keeps bookings UNAVAILABLE in a
 *     gate            market without coverage, per the owner's decision. It
 *                   cannot do that from a reason that says `other`.
 *
 * `identity_verifications.failure_reason` is an unconstrained `text` column
 * (db/migrations/0161_identity_verification.sql, and the live structure dump
 * agrees — no CHECK), so this member needs no migration to be persistable.
 *
 * This change maps it for SUMSUB only. The Stripe path is reported, not fixed:
 * see `mapStripeFailureCode`.
 */
export type NormalizedFailureReason =
  | 'document_invalid'
  | 'selfie_mismatch'
  | 'underage'
  | 'abandoned'
  | 'provider_error'
  /** The provider does not cover this market — about the place, not the person. */
  | 'coverage_unsupported'
  | 'other';

/** What we ask the provider to check. */
export interface VerificationRequest {
  userId: string;
  /** id-only or id + selfie liveness match */
  level: 'id' | 'id_selfie';
  /** Where the provider should send the user after their hosted flow. */
  returnUrl: string;
  /** Optional test hint consumed by the mock provider only. */
  testHint?: 'approve' | 'fail_document' | 'fail_selfie' | 'fail_underage';
}

/** Returned when a session is created; client uses redirectUrl. */
export interface VerificationSession {
  provider: VerificationProviderName;
  providerSessionId: string;
  /** Hosted-flow URL (or app deep link for the mock). */
  redirectUrl: string;
  expiresAt: string; // ISO
}

/** Normalized result — the ONLY shape the rest of the app consumes. */
export interface VerificationResult {
  provider: VerificationProviderName;
  providerSessionId: string;
  providerVerificationRef?: string;
  status: NormalizedVerificationStatus;
  failureReason?: NormalizedFailureReason;
  /** Derived-only fields. Never DOB, never document numbers. */
  isOver18?: boolean;
  selfieMatch?: boolean;
  documentCountry?: string; // ISO 3166-1 alpha-2
  verifiedAt?: string; // ISO
}

/**
 * Raw webhook input before normalization. Adapters verify the signature
 * themselves (each provider signs differently) and return a
 * VerificationResult, or null if the event is irrelevant.
 */
export interface WebhookEvent {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface IdentityVerificationProvider {
  readonly name: VerificationProviderName;

  /** Create a hosted verification session for the user. */
  createSession(req: VerificationRequest): Promise<VerificationSession>;

  /**
   * Verify + normalize an incoming webhook. Returns null for events we
   * don't care about. MUST throw on signature failure — never silently
   * accept an unverified webhook.
   */
  handleWebhook(event: WebhookEvent): Promise<VerificationResult | null>;

  /** Poll a session's current state (fallback when webhooks lag). */
  getSessionStatus(providerSessionId: string): Promise<VerificationResult>;

  /**
   * GDPR support: ask the provider to delete their copy of the user's
   * verification data. Providers that cannot honor this must document it.
   */
  requestProviderDeletion(providerVerificationRef: string): Promise<void>;
}

/** Maps verification results to the profile's public field. */
export function toVerificationLevel(
  result: Pick<VerificationResult, 'status' | 'selfieMatch'>,
): 'none' | 'id_verified' | 'id_selfie_verified' {
  if (result.status !== 'verified') return 'none';
  return result.selfieMatch ? 'id_selfie_verified' : 'id_verified';
}
