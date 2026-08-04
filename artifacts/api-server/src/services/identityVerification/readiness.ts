/**
 * Identity-verification readiness
 *
 * `getIdentityProvider()` in providers.ts THROWS when the configured provider
 * cannot be used (mock in production, or an unimplemented real adapter). That
 * is the right behaviour at the point of use, but callers that merely need to
 * ask "is KYC actually working right now?" cannot use a throwing factory —
 * hence this non-throwing probe.
 *
 * Why this exists (audit P1 item 8): production has no working KYC. Both the
 * Stripe and Persona adapters in providers.ts are stubs whose every method
 * throws, and the mock provider is refused in production. So no user can
 * complete verification, `profiles.verification_level` can never legitimately
 * advance, and `rent_buddy_profiles.id_verified` can never become true through
 * a real check. Rent-a-Buddy pairs strangers in person, so booking creation
 * must be tied to this fact directly rather than relying on someone remembering
 * to keep a launch-control checkbox ticked.
 */

/**
 * Providers whose adapter in providers.ts is actually implemented.
 *
 * ── ADD YOUR PROVIDER HERE WHEN YOU IMPLEMENT IT ────────────────────────────
 * This set is the single switch that tells the rest of the server KYC works.
 * When the Stripe or Persona adapter stops throwing, add its name here and set
 * the matching env var; booking creation then re-opens on its own, with no
 * other code change. Leaving a stub out of this set is what keeps the
 * Rent-a-Buddy booking gate closed.
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
        ? `IDENTITY_PROVIDER=${provider} but that adapter in services/identityVerification/providers.ts is still a stub (every method throws). Implement it and add it to IMPLEMENTED_PROVIDERS.`
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
