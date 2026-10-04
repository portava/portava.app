/**
 * Identity verification — provider factory + real-provider adapters.
 *
 * Drop at: travel-buddy-standalone/server/services/identityVerification/providers.ts
 *
 * The factory selects the adapter by IDENTITY_PROVIDER env var
 * ('mock' | 'stripe' | 'persona' | 'sumsub', default 'mock') and refuses to run
 * the mock in production (privacy invariant 4).
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
import {
  verifyPayloadDigestSignature,
  verifyTimestampedHmacSignature,
} from './webhookSignature.js';
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
import {
  SUMSUB_DIGEST_ALG_HEADER,
  SUMSUB_DIGEST_HEADER,
  SUMSUB_LEVEL_ENV,
  normalizeSumsubWebhook,
  sumsubCreateSession,
  sumsubGetSessionStatus,
  sumsubRequestDeletion,
} from './sumsub.js';

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
// Sumsub — the owner's PRIMARY identity provider
// ─────────────────────────────────────────────────────────────
// Env: SUMSUB_APP_TOKEN, SUMSUB_SECRET_KEY, SUMSUB_LEVEL_NAME_ID,
//      SUMSUB_LEVEL_NAME_ID_SELFIE, IDENTITY_WEBHOOK_SECRET
// Docs: https://docs.sumsub.com/
//
// The binding is the same four lines as the two adapters above — that is the
// point of the interface. Two things differ and both are properties of the
// VENDOR, not of this adapter's shape:
//
//   1. THE SIGNATURE SCHEME. Sumsub sends a bare keyed digest of the body with
//      the algorithm named in a second header, not Stripe's `t=…,v1=…`. So this
//      binding calls `verifyPayloadDigestSignature` instead of
//      `verifyTimestampedHmacSignature`. The ORDER is identical and is the
//      requirement, not a preference: verify the raw bytes, and only then parse.
//
//   2. THE SELFIE VERDICT needs the configured level name, which lives in env.
//      It is read here and passed IN, so `normalizeSumsubWebhook` stays a pure
//      function of its arguments and the tests need no environment.
//
// MARKET COVERAGE is NOT consulted in `createSession`, deliberately.
// `VerificationRequest` carries no market and widening the shared interface to
// give one vendor a country field was out of scope; the enforcement point the
// owner's decision names is the BOOKING, and that is where it lives
// (lib/rentBuddyKycGate.ts via services/identityVerification/marketCoverage.ts).
// What this adapter does is preserve the vendor's own coverage refusal on the
// way back, as `coverage_unsupported` rather than a generic failure.
const sumsubProvider: IdentityVerificationProvider = {
  name: 'sumsub',
  async createSession(req: VerificationRequest): Promise<VerificationSession> {
    return sumsubCreateSession(req);
  },
  async handleWebhook(event: WebhookEvent): Promise<VerificationResult | null> {
    // THROWS WebhookSignatureError on every failure path, including "no secret
    // configured" and "the delivery named an algorithm we do not accept".
    // Never a boolean, never a silent pass — invariant 5.
    verifyPayloadDigestSignature({
      headers: event.headers,
      digestHeaderName: SUMSUB_DIGEST_HEADER,
      algorithmHeaderName: SUMSUB_DIGEST_ALG_HEADER,
      rawBody: event.rawBody,
      secret: webhookSecret(),
      provider: 'sumsub',
    });
    const parsed = parseVerified(event.rawBody);
    if (parsed === null) return null;
    const selfieLevelName = process.env[SUMSUB_LEVEL_ENV.id_selfie];
    return normalizeSumsubWebhook(parsed, {
      selfieLevelName: typeof selfieLevelName === 'string' ? selfieLevelName : undefined,
    });
  },
  async getSessionStatus(id: string): Promise<VerificationResult> {
    return sumsubGetSessionStatus(id);
  },
  async requestProviderDeletion(ref: string): Promise<void> {
    return sumsubRequestDeletion(ref);
  },
};

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

export function getIdentityProvider(): IdentityVerificationProvider {
  const name = (process.env.IDENTITY_PROVIDER ?? 'mock').toLowerCase();

  if (name === 'mock') {
    if (!mockIdentityPermitted(process.env)) { // production, a Replit deployment, or no local-run signal
      throw new Error(
        'IDENTITY_PROVIDER=mock is not allowed in production or a hosted deployment (a local run needs NODE_ENV=development|test). Configure stripe or persona.',
      );
    }
    return mockProvider;
  }
  if (name === 'stripe') return stripeProvider;
  if (name === 'persona') return personaProvider;
  if (name === 'sumsub') return sumsubProvider;

  throw new Error(`Unknown IDENTITY_PROVIDER: ${name}`);
}

// Sandbox/deployment guard (appended at the foot so every line the censuses cite
// keeps its number). ES imports are hoisted, so this binds before any code above runs.
import { mockIdentityPermitted } from '../../lib/paymentsMode.js';
