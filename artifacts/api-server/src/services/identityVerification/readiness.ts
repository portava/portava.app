/**
 * Identity-verification readiness
 *
 * `getIdentityProvider()` in providers.ts THROWS when the configured provider
 * cannot be used (mock in production, or an unimplemented real adapter). That
 * is the right behaviour at the point of use, but callers that merely need to
 * ask "is KYC actually working right now?" cannot use a throwing factory —
 * hence this non-throwing probe.
 *
 * Why this exists (audit P1 item 8): production has no working KYC. The mock
 * provider is refused in production, so no user can complete verification,
 * `profiles.verification_level` can never legitimately advance, and
 * `rent_buddy_profiles.id_verified` can never become true through a real check.
 * Rent-a-Buddy pairs strangers in person, so booking creation must be tied to
 * this fact directly rather than relying on someone remembering to keep a
 * launch-control checkbox ticked.
 *
 * ── WHAT CHANGED, AND WHY THE GATE DID NOT ──────────────────────────────────
 * This header, the set below and the message it produces all used to say the
 * Stripe and Persona adapters "are stubs whose every method throws". That
 * stopped being true (census-trust §14, TV-6b): both are implemented, and their
 * webhook signature verification is proven by
 * `src/test/verificationWebhookSignature.test.ts`.
 *
 * The gate is unchanged anyway, and the distinction matters more than it looks.
 * "Implemented" is not "certified": the PAYLOAD mapping in each adapter is read
 * off the vendor's published shapes and has never been run against the vendor,
 * so the first sandbox transcript is as likely to correct it as to confirm it.
 * A probe that reported operational on code alone would re-open a gate that
 * pairs strangers in person on the strength of a document someone read.
 *
 * So the SET is the switch and the EVIDENCE is a sandbox run — and the reason
 * string says so, because the reason string is what an operator reads when they
 * ask why KYC is off. Telling them to go implement an adapter that already
 * exists would send them to the wrong work.
 */

/**
 * Providers whose adapter in providers.ts is actually implemented.
 *
 * ── ADD YOUR PROVIDER HERE WHEN A SANDBOX RUN HAS CERTIFIED IT ──────────────
 * This set is the switch that tells the rest of the server KYC works. Adding a
 * name makes that provider's verification flow usable (bookings ALSO need a live
 * key, below) — and either way the bar is NOT "the adapter is written".
 *
 * The bar is a sandbox transcript: session created -> hosted flow completed ->
 * signed webhook received and verified -> the `identity_verifications` row
 * reaches `verified` -> `profiles.verification_level` is set. That run is what
 * proves the payload mapping, which is the half of each adapter no test in this
 * repository can reach. All three adapters are implemented and none has been
 * run against its vendor, so all three stay out.
 *
 * ── THE ONE LINE THAT ACTIVATES SUMSUB ──────────────────────────────────────
 * `sumsub` is now the owner's PRIMARY provider; its adapter is written and tested
 * but NOT operational: until it is in this set the verification routes send it
 * no request (routes/verification.ts, lead ruling P-5). The change that opens it:
 *
 *     const IMPLEMENTED_PROVIDERS = new Set<string>(["mock", "sumsub"]);
 *
 * Nothing else in code. With it, IDENTITY_PROVIDER=sumsub and a SANDBOX (`sbx:`) token
 * make `identityProviderStatus()` operational ON BETA ONLY (P-5b, foot: never in production)
 * — the verification flow runs — but bookings stay CLOSED: never booking-grade (owner: "No tester
 * bypass or sandbox verification key"; rentBuddyKycGate.ts verificationIsBookingGrade).
 * Bookings need a live (`prd:`) token PAYMENTS_ALLOW_LIVE=true permits, then the
 * MARKET gate. Under P-5/P-5b the transcript is taken on a BETA build listing it, sbx: only.
 */
const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);

/** Env var that must be present for each real provider to be considered live. */
const REQUIRED_ENV: Record<string, string> = {
  stripe: "STRIPE_IDENTITY_SECRET_KEY",
  persona: "PERSONA_API_KEY",
  sumsub: "SUMSUB_APP_TOKEN",
};

export interface IdentityProviderStatus {
  /** True only when a real verification can actually be completed today. */
  operational: boolean;
  /** Configured provider name, lowercased. */
  provider: string;
  /** Human-readable explanation, safe for server logs (never returned to users verbatim). */
  reason: string;
}

/**
 * Probe the configured identity provider. Never throws.
 *
 * The mock provider counts as operational under the TEST RUNNER only (mockIdentityPermitted) — a
 * dev host (`pnpm dev`, NODE_ENV=development) reports it unavailable like production does (N-2).
 */
function identityProviderStatusBeforeKeyMode(
  env: NodeJS.ProcessEnv = process.env,
): IdentityProviderStatus {
  const provider = (env["IDENTITY_PROVIDER"] ?? "mock").toLowerCase();
  const isProduction = !mockIdentityPermitted(env); // production, a Replit deployment, or no local-run signal

  if (!providerIsCertified(provider, env)) { // IMPLEMENTED_PROVIDERS, or the test-runner seam at the foot
    // A provider the factory CAN return but IMPLEMENTED_PROVIDERS excludes is
    // "known": the operator must be told what is missing (a sandbox transcript),
    // not sent looking for a typo in IDENTITY_PROVIDER. Keep this in step with
    // the factory's branches in providers.ts.
    const known = provider === "stripe" || provider === "persona" || provider === "sumsub";
    return {
      operational: false,
      provider,
      reason: known
        ? `IDENTITY_PROVIDER=${provider} but that adapter has not been certified against the vendor. ` +
          `It IS implemented in services/identityVerification/ (signature verification proven by ` +
          `src/test/verificationWebhookSignature.test.ts); what is missing is a sandbox end-to-end run ` +
          `proving the payload mapping. Run one, then add "${provider}" to IMPLEMENTED_PROVIDERS.`
        : `Unknown IDENTITY_PROVIDER=${provider}.`,
    };
  }

  if (provider === "mock") {
    return isProduction
      ? {
          operational: false,
          provider,
          reason:
            "IDENTITY_PROVIDER=mock is refused outside the test runner (production, hosted deployments and dev hosts) by getIdentityProvider(); no real verification can complete.",
        }
      : { operational: true, provider, reason: "mock provider (test runner only)" };
  }

  const requiredEnv = REQUIRED_ENV[provider];
  if (requiredEnv && !env[requiredEnv]) {
    return {
      operational: false,
      provider,
      reason: `IDENTITY_PROVIDER=${provider} but ${requiredEnv} is not set.`,
    };
  }

  return sandboxKeyStatus(provider, env) ?? { operational: true, provider, reason: `${provider} adapter configured` }; // P-5b (foot): a sandbox key is never operational in production
}

// ── Sandbox-only key guard (appended at the foot so every cited line keeps its number) ──
//
// The key-MODE check runs before the certification check above, so an
// operator whose key is refused is told that first: a live or unrecognised
// key is a configuration fault that stops every provider call (lib/paymentsMode.ts),
// whatever IMPLEMENTED_PROVIDERS says. The reason names the refusal and never
// the key. POST /api/verification/session and the status refresh consult the
// same `identityKeyRefusal`, then (P-5) `identityProviderStatus` below itself.
import {
  describeRefusal,
  identityKeyDecision,
  mockIdentityPermitted,
  type ProviderKeyDecision,
} from "../../lib/paymentsMode.js";

/** The configured provider's key decision when it is REFUSED (live/unknown), else null. */
export function identityKeyRefusal(env: NodeJS.ProcessEnv = process.env): ProviderKeyDecision | null {
  const d = identityKeyDecision(env);
  if (!d || d.allowed || d.refusal === "key_absent") return null;
  return d;
}

/**
 * Probe the configured identity provider. Never throws.
 *
 * A refused key reports `not operational: live key not allowed` (or
 * `unrecognised key`) before anything else; otherwise the certification probe
 * above decides.
 */
export function identityProviderStatus(
  env: NodeJS.ProcessEnv = process.env,
): IdentityProviderStatus {
  const refused = identityKeyRefusal(env);
  if (refused) {
    const what = refused.refusal === "live_key_not_allowed" ? "live key not allowed" : "unrecognised key";
    return {
      operational: false,
      provider: refused.provider,
      reason: `not operational: ${what} — ${describeRefusal(refused.refusal ?? "unknown_key_prefix")}; every provider call is refused before it is sent.`,
    };
  }
  return identityProviderStatusBeforeKeyMode(env);
}

// ── Test-runner-only certification seam (appended at the foot so every cited line keeps its number) ──
//
// The booking gate's two halves — "operational" and "booking-grade" — can only
// disagree for a CERTIFIED keyed provider running on a sandbox key, and no keyed
// provider is certified yet, so without this the conjunct in
// lib/rentBuddyKycGate.ts could not be observed at a booking door (lane B's
// surviving mutant N-1b). Tests may certify a provider for their own process;
// the override is honoured ONLY where the unsigned mock may run (the test
// runner), and setting it anywhere else throws, so a hosted process can never
// widen IMPLEMENTED_PROVIDERS.
let certifiedForTest: ReadonlySet<string> | null = null;

export function _certifyIdentityProvidersForTest(names: readonly string[] | null): void {
  if (names !== null && !mockIdentityPermitted(process.env)) {
    throw new Error("_certifyIdentityProvidersForTest: only under the test runner (node --test)");
  }
  certifiedForTest = names === null ? null : new Set(names);
}

function providerIsCertified(provider: string, env: NodeJS.ProcessEnv): boolean {
  if (IMPLEMENTED_PROVIDERS.has(provider)) return true;
  return certifiedForTest !== null && mockIdentityPermitted(env) && certifiedForTest.has(provider);
}

// ── P-5b (lead ruling 2026-10-08), appended at the foot so every cited line keeps its number ──
//
// In a PRODUCTION deployment a keyed provider on a SANDBOX / TEST key is never
// operational, even after certification: the verification routes refuse the
// session and make no outbound call (routes/verification.ts, P-5), and the booking
// gate stays shut. On BETA a certified provider on a sandbox key may be
// operational for the verification FLOW only; bookings still need a live key
// (lib/rentBuddyKycGate.ts verificationIsBookingGrade, N-1b).
//
// "Production" is decided FAIL-CLOSED, because production is UNLABELLED today
// (PORTAVA_DEPLOYMENT_ENV=production is the owner's pending action, BETA-7), so a
// label-only rule would not protect it. A sandbox key is permitted only where the
// process positively shows it is NOT production:
//   - a production signal refuses first: PORTAVA_DEPLOYMENT_ENV=production, or
//     REPLIT_DOMAINS naming the production host (lib/deploymentEnvironment.ts'
//     PRODUCTION_API_HOST — the production-host rule);
//   - then a deployment labelled PORTAVA_DEPLOYMENT_ENV=beta is permitted. The
//     label is trusted because lib/deploymentEnvironmentGuard.ts (imported by
//     src/index.ts before ./app) refuses to START a beta-labelled process whose
//     project is not portava-beta, so a running beta-labelled server is beta;
//   - then the test runner (mockIdentityPermitted) is permitted;
//   - anything else (an unlabelled host, a dev host, an unlabelled deployment)
//     is treated as production and refused.
// The reason names the signal, never a key or a value.
import { DEPLOYMENT_ENV_VAR, PRODUCTION_API_HOST } from "../../lib/deploymentEnvironment.js";

/** The first production signal this environment carries, or null. Names the signal, never a value. */
export function productionDeploymentSignal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[DEPLOYMENT_ENV_VAR] === "production") return `${DEPLOYMENT_ENV_VAR}=production`;
  const domains = (env["REPLIT_DOMAINS"] ?? "").toLowerCase().split(",").map((d) => d.trim());
  if (domains.includes(PRODUCTION_API_HOST)) return `REPLIT_DOMAINS names ${PRODUCTION_API_HOST}`;
  return null;
}

/** null when a sandbox/test identity key may make a certified keyed provider operational here; else why not. */
export function sandboxIdentityKeyRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const production = productionDeploymentSignal(env);
  if (production !== null) return `a sandbox key is never used in a production deployment (${production})`;
  if (env[DEPLOYMENT_ENV_VAR] === "beta") return null;
  if (mockIdentityPermitted(env)) return null;
  return (
    `a sandbox key opens the verification flow only on a deployment labelled ${DEPLOYMENT_ENV_VAR}=beta ` +
    "(or under the test runner); this process shows neither, so it is treated as production"
  );
}

function sandboxKeyStatus(provider: string, env: NodeJS.ProcessEnv): IdentityProviderStatus | null {
  const decision = identityKeyDecision(env);
  if (decision === null || decision.mode !== "test") return null;
  const why = sandboxIdentityKeyRefusal(env);
  return why === null ? null : { operational: false, provider, reason: `not operational: ${why} (P-5b).` };
}
