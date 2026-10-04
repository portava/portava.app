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
 * This set is the single switch that tells the rest of the server KYC works.
 * Adding a name here re-opens Rent-a-Buddy booking creation on its own, with no
 * other code change — which is why the bar is NOT "the adapter is written".
 *
 * The bar is a sandbox transcript: session created -> hosted flow completed ->
 * signed webhook received and verified -> the `identity_verifications` row
 * reaches `verified` -> `profiles.verification_level` is set. That run is what
 * proves the payload mapping, which is the half of each adapter no test in this
 * repository can reach. All three adapters are implemented and none has been
 * run against its vendor, so all three stay out.
 *
 * ── THE ONE LINE THAT ACTIVATES SUMSUB ──────────────────────────────────────
 * `sumsub` is now the owner's PRIMARY provider and its adapter is written,
 * tested and unreachable. The single change that makes it reachable is this
 * set:
 *
 *     const IMPLEMENTED_PROVIDERS = new Set<string>(["mock", "sumsub"]);
 *
 * Nothing else. With that one edit (plus IDENTITY_PROVIDER=sumsub and the
 * sandbox credentials in the environment) `identityProviderStatus()` reports
 * operational and the Rent-a-Buddy booking gate re-opens — subject to the
 * MARKET gate, which is a second, independent refusal: see
 * `marketCoverage.ts`. Activation was explicitly out of scope for the change
 * that wrote the adapter, and it still needs the sandbox transcript above.
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
 * The mock provider counts as operational in a LOCAL run only (mockIdentityPermitted) — it is what
 * the test suite and local development run against.
 */
function identityProviderStatusBeforeKeyMode(
  env: NodeJS.ProcessEnv = process.env,
): IdentityProviderStatus {
  const provider = (env["IDENTITY_PROVIDER"] ?? "mock").toLowerCase();
  const isProduction = !mockIdentityPermitted(env); // production, a Replit deployment, or no local-run signal

  if (!IMPLEMENTED_PROVIDERS.has(provider)) {
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
            "IDENTITY_PROVIDER=mock is refused in production and hosted deployments by getIdentityProvider(); no real verification can complete.",
        }
      : { operational: true, provider, reason: "mock provider (non-production)" };
  }

  const requiredEnv = REQUIRED_ENV[provider];
  if (requiredEnv && !env[requiredEnv]) {
    return {
      operational: false,
      provider,
      reason: `IDENTITY_PROVIDER=${provider} but ${requiredEnv} is not set.`,
    };
  }

  return { operational: true, provider, reason: `${provider} adapter configured` };
}

// ── Sandbox-only key guard (appended at the foot so every cited line keeps its number) ──
//
// The key-MODE check runs before the certification check above, so an
// operator whose key is refused is told that first: a live or unrecognised
// key is a configuration fault that stops every provider call (lib/paymentsMode.ts),
// whatever IMPLEMENTED_PROVIDERS says. The reason names the refusal and never
// the key. POST /api/verification/session and the status refresh consult the
// same `identityKeyRefusal`, so readiness and the routes cannot disagree.
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
