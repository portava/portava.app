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

export type VerificationProviderName = 'mock' | 'stripe' | 'persona';

/** Mirrors identity_verifications.status in the DB. */
export type NormalizedVerificationStatus =
  | 'created'
  | 'pending'
  | 'processing'
  | 'verified'
  | 'failed'
  | 'expired'
  | 'canceled';

export type NormalizedFailureReason =
  | 'document_invalid'
  | 'selfie_mismatch'
  | 'underage'
  | 'abandoned'
  | 'provider_error'
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
