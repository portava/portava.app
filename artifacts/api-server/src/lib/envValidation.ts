/**
 * Startup environment validation.
 *
 * Checks that required server-only secrets are present before the server
 * starts, and warns about optional ones that unlock features. Never prints
 * secret values — only key names and presence.
 */

const REQUIRED_KEYS = [
  "PORT",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SESSION_SECRET",
] as const;

/** Optional keys: missing values disable a feature but should not crash. */
const OPTIONAL_KEYS = [
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "INTERNAL_API_SECRET",
  "MAPBOX_TOKEN",
  // SENSING_CONTRIBUTOR_PEPPER — the server pepper for the anonymous sensing
  // store's rotating contributor tokens (lib/sensingAnonStore, migration 2315).
  //
  // WHY OPTIONAL AND NOT REQUIRED, since a wrong answer here is a privacy
  // failure. REQUIRED_KEYS is enforced by process.exit(1) below. Nothing has
  // ever provisioned this variable, and 2315 is not applied to production at
  // all, so promoting it to required would take the production API server down
  // at its next boot over a secret for a store that does not exist there. That
  // is a self-inflicted outage, and it breaks the standing rule that every stage
  // lands behaviour-preserving (docs/discovery/ROADMAP.md:487-488).
  //
  // Optional is not lenient here, because the requirement is enforced where it
  // actually bites rather than at boot:
  //   * lib/sensingAnonStore.sensingPepper() THROWS when no pepper of any kind
  //     is set — there is deliberately no constant fallback, since a guessable
  //     pepper would make a contributor token forgeable;
  //   * lib/sensingAnonService refuses to write or revoke unless THIS variable
  //     specifically is set and at least 32 characters, so a contribution can
  //     never be written under the SESSION_SECRET fallback — whose rotation is a
  //     routine security action that would make every prior row unrevokable.
  // The effect of listing it here is a named boot warning naming exactly the key
  // an operator has to provision, instead of a silent fallback nobody sees.
  "SENSING_CONTRIBUTOR_PEPPER",
] as const;

export interface EnvValidationResult {
  missingRequired: string[];
  missingOptional: string[];
}

export function validateEnv(): EnvValidationResult {
  const missingRequired = REQUIRED_KEYS.filter(
    (key) => !process.env[key]?.trim(),
  );
  const missingOptional = OPTIONAL_KEYS.filter(
    (key) => !process.env[key]?.trim(),
  );
  return { missingRequired, missingOptional };
}

/**
 * Validate the environment and exit the process if required keys are absent.
 * Logs key names only — never values.
 */
export function assertRequiredEnv(
  log: {
    error: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  } = {
    error: (obj, msg) => console.error(msg, obj),
    warn: (obj, msg) => console.warn(msg, obj),
  },
): void {
  const { missingRequired, missingOptional } = validateEnv();

  if (missingOptional.length > 0) {
    log.warn(
      { keys: missingOptional },
      "env: optional variables not set — related features are disabled",
    );
  }

  if (missingRequired.length > 0) {
    log.error(
      { keys: missingRequired },
      "env: required variables missing — set them in Replit Secrets and restart",
    );
    process.exit(1);
  }
}
