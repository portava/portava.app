/**
 * Foursquare API key selection — dev/prod quota isolation.
 *
 * Problem: a single FOURSQUARE_API_KEY shared between the dev workspace and
 * production means every test query run from this workspace (venue search,
 * place photos, live open-now checks) spends the SAME quota production
 * traffic depends on. A burst of manual dev testing can exhaust production's
 * Foursquare credits with no production traffic involved at all.
 *
 * Convention: this repo already keys environment-specific behaviour off
 * NODE_ENV (see lib/logger.ts, routes/verification.ts) — production sets it
 * via artifact.toml's [services.production.*.env], dev sets it via the
 * package.json "dev" script. We follow that same convention here rather than
 * introducing a second environment signal.
 *
 * Precedence per environment:
 *   production  → FSQ_API_KEY_PROD, falling back to FOURSQUARE_API_KEY
 *   development → FSQ_API_KEY_DEV,  falling back to FOURSQUARE_API_KEY
 *
 * The FOURSQUARE_API_KEY fallback is deliberate backward compatibility: until
 * FSQ_API_KEY_DEV / FSQ_API_KEY_PROD are actually provisioned as Replit
 * Secrets, every call site keeps working exactly as it does today (shared
 * key, shared quota). Once both are set, dev and prod stop competing for the
 * same credits with no code change required beyond adding the secrets.
 */

export type FoursquareKeySource = "env-specific" | "legacy-shared" | "absent";

interface FoursquareKeyResolution {
  key: string | undefined;
  /** Which variable actually supplied the key — for logging, never the value itself. */
  source: FoursquareKeySource;
  /** The env-specific variable name this environment prefers, for diagnostics. */
  preferredVar: "FSQ_API_KEY_PROD" | "FSQ_API_KEY_DEV";
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Resolve the Foursquare API key for the current environment, plus metadata
 * about where it came from. Never logs or exposes the key value.
 *
 * Presence is checked with `!== undefined`, not truthiness: an env-specific
 * var that is SET-BUT-EMPTY is a real (if broken) configuration choice and
 * must be reported as such by callers using apiKeyState.ts's classifyApiKey
 * — collapsing it into "fall back to legacy" would silently paper over a
 * misconfigured secret instead of surfacing it. Only a var that was never
 * set at all (`undefined`) falls through to the next source.
 */
export function resolveFoursquareApiKey(): FoursquareKeyResolution {
  const preferredVar = isProductionEnv() ? "FSQ_API_KEY_PROD" : "FSQ_API_KEY_DEV";
  const preferred = process.env[preferredVar];
  if (preferred !== undefined) {
    return { key: preferred, source: "env-specific", preferredVar };
  }

  const legacy = process.env.FOURSQUARE_API_KEY;
  if (legacy !== undefined) {
    return { key: legacy, source: "legacy-shared", preferredVar };
  }

  return { key: undefined, source: "absent", preferredVar };
}

/** Convenience accessor for call sites that only need the key value. */
export function getFoursquareApiKey(): string | undefined {
  return resolveFoursquareApiKey().key;
}
