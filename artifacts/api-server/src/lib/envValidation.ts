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
