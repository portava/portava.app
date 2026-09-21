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
 * repository can reach. Both adapters are implemented and neither has been run
 * against its vendor, so both stay out.
 */
const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);

/** Env var that must be present for each real provider to be considered live. */
const REQUIRED_ENV: Record<string, string> = {
  stripe: "STRIPE_IDENTITY_SECRET_KEY",
  persona: "PERSONA_API_KEY",
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
 * The mock provider counts as operational OUTSIDE production only — it is what
 * the test suite and local development run against.
 */
export function identityProviderStatus(
  env: NodeJS.ProcessEnv = process.env,
): IdentityProviderStatus {
  const provider = (env["IDENTITY_PROVIDER"] ?? "mock").toLowerCase();
  const isProduction = env["NODE_ENV"] === "production";

  if (!IMPLEMENTED_PROVIDERS.has(provider)) {
    const known = provider === "stripe" || provider === "persona";
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
            "IDENTITY_PROVIDER=mock is refused in production by getIdentityProvider(); no real verification can complete.",
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
