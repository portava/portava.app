/**
 * Identity verification — provider factory + real-provider adapters.
 *
 * Drop at: travel-buddy-standalone/server/services/identityVerification/providers.ts
 *
 * The factory selects the adapter by IDENTITY_PROVIDER env var
 * ('mock' | 'stripe' | 'persona', default 'mock') and refuses to run the
 * mock in production (privacy invariant 4).
 *
 * ── WHAT CHANGED, AND WHAT DELIBERATELY DID NOT ──────────────────────────────
 * The Stripe and Persona adapters were STUBS whose every method threw "not
 * configured". They are now implemented, in `stripeIdentity.ts` and
 * `persona.ts`, and this file is the thin binding: header name, secret, parse,
 * normalize.
 *
 * `handleWebhook` VERIFIES THE SIGNATURE BEFORE IT PARSES ANYTHING. That order
 * is the requirement, not a preference: `JSON.parse` on an unauthenticated
 * 512 KB body is work an anonymous caller gets to make this server do, and any
 * field read before verification is a field an attacker chose. The raw string
 * goes to the verifier; only after it returns does the body become an object.
 *
 * WHAT IS NOT CLAIMED. `readiness.IMPLEMENTED_PROVIDERS` is NOT extended here.
 * That set is the single switch that tells the rest of the server KYC works and
 * re-opens the Rent-a-Buddy booking gate; flipping it on an adapter that has
 * never exchanged a byte with the vendor would be exactly the "mocked provider
 * counted as complete" census-trust exists to catch. The signature half is
 * proven (`test/verificationWebhookSignature.test.ts`); the payload half needs
 * a sandbox transcript, which needs an account, which is TV-6a / D-PROVIDER.
 */

import type {
  IdentityVerificationProvider,
  VerificationRequest,
  VerificationResult,
  VerificationSession,
  WebhookEvent,
} from './types';
import { mockProvider } from './mockProvider.js';
import { verifyTimestampedHmacSignature } from './webhookSignature.js';
import {
  normalizeStripeWebhook,
  stripeCreateSession,
  stripeGetSessionStatus,
  stripeRequestDeletion,
} from './stripeIdentity.js';
import {
  normalizePersonaWebhook,
  personaCreateSession,
  personaGetSessionStatus,
  personaRequestDeletion,
} from './persona.js';

/**
 * The endpoint signing secret, one variable for both vendors, exactly as
 * `verified-foundation-plan.md` V-6 and census-trust TV-6a name it.
 *
 * Read at CALL time, not at module load. A module-level constant is captured
 * before `--env-file` / Replit Secrets are applied in some start paths, and the
 * failure mode of reading it too early is `secret_not_configured` on every
 * delivery in an environment that is, in fact, configured.
 */
function webhookSecret(): string | undefined {
  return process.env['IDENTITY_WEBHOOK_SECRET'];
}

/**
 * Parse a body that has ALREADY been signature-verified.
 *
 * A parse failure after a valid signature means the provider sent us something
 * we cannot read, which is not a signature problem — it is returned as `null`
 * (irrelevant event, 200) rather than thrown, because retrying an unparseable
 * body forever helps nobody.
 */
function parseVerified(rawBody: string): unknown | null {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Stripe Identity
// ─────────────────────────────────────────────────────────────
// Env: STRIPE_IDENTITY_SECRET_KEY, IDENTITY_WEBHOOK_SECRET
// Docs: https://docs.stripe.com/identity
const stripeProvider: IdentityVerificationProvider = {
  name: 'stripe',
  async createSession(req: VerificationRequest): Promise<VerificationSession> {
    return stripeCreateSession(req);
  },
  async handleWebhook(event: WebhookEvent): Promise<VerificationResult | null> {
    // THROWS WebhookSignatureError on every failure path, including "no secret
    // configured". Never a boolean, never a silent pass — invariant 5.
    verifyTimestampedHmacSignature({
      headers: event.headers,
      headerName: 'stripe-signature',
      rawBody: event.rawBody,
      secret: webhookSecret(),
      provider: 'stripe',
    });
    const parsed = parseVerified(event.rawBody);
    if (parsed === null) return null;
    return normalizeStripeWebhook(parsed);
  },
  async getSessionStatus(id: string): Promise<VerificationResult> {
    return stripeGetSessionStatus(id);
  },
  async requestProviderDeletion(ref: string): Promise<void> {
    return stripeRequestDeletion(ref);
  },
};

// ─────────────────────────────────────────────────────────────
// Persona
// ─────────────────────────────────────────────────────────────
// Env: PERSONA_API_KEY, PERSONA_TEMPLATE_ID, IDENTITY_WEBHOOK_SECRET
// Docs: https://docs.withpersona.com/
const personaProvider: IdentityVerificationProvider = {
  name: 'persona',
  async createSession(req: VerificationRequest): Promise<VerificationSession> {
    return personaCreateSession(req);
  },
  async handleWebhook(event: WebhookEvent): Promise<VerificationResult | null> {
    verifyTimestampedHmacSignature({
      headers: event.headers,
      headerName: 'persona-signature',
      rawBody: event.rawBody,
      secret: webhookSecret(),
      provider: 'persona',
    });
    const parsed = parseVerified(event.rawBody);
    if (parsed === null) return null;
    return normalizePersonaWebhook(parsed);
  },
  async getSessionStatus(id: string): Promise<VerificationResult> {
    return personaGetSessionStatus(id);
  },
  async requestProviderDeletion(ref: string): Promise<void> {
    return personaRequestDeletion(ref);
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
