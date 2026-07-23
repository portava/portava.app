/**
 * Identity verification — provider factory + real-provider stubs.
 *
 * Drop at: travel-buddy-standalone/server/services/identityVerification/providers.ts
 *
 * The factory selects the adapter by IDENTITY_PROVIDER env var
 * ('mock' | 'stripe' | 'persona', default 'mock') and refuses to run the
 * mock in production.
 *
 * The Stripe and Persona adapters are STUBS with the integration mapped
 * out in comments. Filling them in requires the corresponding provider
 * account + API keys (owner dashboard work), after which each is roughly
 * a day of implementation + webhook testing.
 */

import type {
  IdentityVerificationProvider,
  VerificationRequest,
  VerificationResult,
  VerificationSession,
  WebhookEvent,
} from './types';
import { mockProvider } from './mockProvider';

// ─────────────────────────────────────────────────────────────
// Stripe Identity stub
// ─────────────────────────────────────────────────────────────
// Env needed later: STRIPE_IDENTITY_SECRET_KEY, IDENTITY_WEBHOOK_SECRET
// Docs: https://docs.stripe.com/identity
// Mapping:
//   createSession      -> stripe.identity.verificationSessions.create
//                         ({ type: 'document', options: { document:
//                           { require_matching_selfie: level === 'id_selfie' } },
//                           return_url })
//   handleWebhook      -> stripe.webhooks.constructEvent (SIGNATURE CHECK),
//                         events: identity.verification_session.verified /
//                         .requires_input / .canceled
//   getSessionStatus   -> verificationSessions.retrieve
//   requestProviderDeletion -> verificationSessions.redact
// Normalization notes:
//   * status 'verified' -> verified; 'requires_input' with last_error ->
//     failed + map error codes to NormalizedFailureReason.
//   * Age: request the 'dob' check but read only the derived over-18
//     comparison; DO NOT persist the DOB itself.
const stripeProvider: IdentityVerificationProvider = {
  name: 'stripe',
  async createSession(_req: VerificationRequest): Promise<VerificationSession> {
    throw new Error(
      'Stripe Identity adapter not configured. Set STRIPE_IDENTITY_SECRET_KEY and implement providers.ts (see comments).',
    );
  },
  async handleWebhook(_event: WebhookEvent): Promise<VerificationResult | null> {
    throw new Error('Stripe Identity adapter not configured.');
  },
  async getSessionStatus(_id: string): Promise<VerificationResult> {
    throw new Error('Stripe Identity adapter not configured.');
  },
  async requestProviderDeletion(_ref: string): Promise<void> {
    throw new Error('Stripe Identity adapter not configured.');
  },
};

// ─────────────────────────────────────────────────────────────
// Persona stub
// ─────────────────────────────────────────────────────────────
// Env needed later: PERSONA_API_KEY, PERSONA_TEMPLATE_ID, IDENTITY_WEBHOOK_SECRET
// Docs: https://docs.withpersona.com/
// Mapping:
//   createSession      -> POST /api/v1/inquiries (template with gov-id +
//                         optional selfie check), hosted flow link from
//                         the inquiry's one-time link.
//   handleWebhook      -> verify Persona-Signature header (HMAC),
//                         events: inquiry.completed / inquiry.failed /
//                         inquiry.expired
//   getSessionStatus   -> GET /api/v1/inquiries/:id
//   requestProviderDeletion -> POST /api/v1/inquiries/:id/redact
// Normalization notes:
//   * Persona verdicts map: 'passed' -> verified; 'failed' -> failed with
//     the failed check name mapped to NormalizedFailureReason.
const personaProvider: IdentityVerificationProvider = {
  name: 'persona',
  async createSession(_req: VerificationRequest): Promise<VerificationSession> {
    throw new Error(
      'Persona adapter not configured. Set PERSONA_API_KEY / PERSONA_TEMPLATE_ID and implement providers.ts (see comments).',
    );
  },
  async handleWebhook(_event: WebhookEvent): Promise<VerificationResult | null> {
    throw new Error('Persona adapter not configured.');
  },
  async getSessionStatus(_id: string): Promise<VerificationResult> {
    throw new Error('Persona adapter not configured.');
  },
  async requestProviderDeletion(_ref: string): Promise<void> {
    throw new Error('Persona adapter not configured.');
  },
};

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

export function getIdentityProvider(): IdentityVerificationProvider {
  const name = (process.env.IDENTITY_PROVIDER ?? 'mock').toLowerCase();

  if (name === 'mock') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'IDENTITY_PROVIDER=mock is not allowed in production. Configure stripe or persona.',
      );
    }
    return mockProvider;
  }
  if (name === 'stripe') return stripeProvider;
  if (name === 'persona') return personaProvider;

  throw new Error(`Unknown IDENTITY_PROVIDER: ${name}`);
}
