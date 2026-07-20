/**
 * Age eligibility helper library.
 *
 * Exports:
 *   calculateUserAge      — age in full years from a date-of-birth string
 *   isUserAgeEligible     — boolean eligibility check
 *   getAgeEligibilityReason — rich result with public message + host status
 *   formatAgeLimitLabel   — display label e.g. "Ages 21+", "Under 35", "Ages 18–30"
 *
 * PRIVACY: this module NEVER returns raw DOB to callers — only derived age
 * values and neutral human-readable messages.
 */

export type AgeEligibilityReason =
  | "no_limit"
  | "dob_missing"
  | "below_min_age"
  | "above_max_age"
  | "within_range";

export type HostStatus =
  | "no_limit"
  | "eligible"
  | "not_eligible"
  | "dob_missing"
  | "needs_review";

export interface AgeEligibilityResult {
  eligible: boolean;
  reason: AgeEligibilityReason;
  /** Shown to the user — intentionally neutral, never exposes exact ages. */
  publicMessage: string;
  /** Shown to the host/admin — no raw DOB, just eligibility category. */
  hostStatus: HostStatus;
}

/** Platform minimum age — rejects setups with min_age below this. */
export const PLATFORM_MIN_AGE = 18;
/** Platform maximum age cap. */
export const PLATFORM_MAX_AGE = 100;

/**
 * Calculate full years between a DOB string (YYYY-MM-DD) and today.
 * Returns null when the string is missing or unparseable.
 */
export function calculateUserAge(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const mDiff = now.getMonth() - birth.getMonth();
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

/**
 * Boolean eligibility check — shorthand when you don't need the full reason object.
 */
export function isUserAgeEligible(
  dob: string | null | undefined,
  ageLimitEnabled: boolean,
  minAge: number | null | undefined,
  maxAge: number | null | undefined,
): boolean {
  return getAgeEligibilityReason(dob, ageLimitEnabled, minAge, maxAge).eligible;
}

/**
 * Full eligibility check returning reason, public message, and host status.
 */
export function getAgeEligibilityReason(
  dob: string | null | undefined,
  ageLimitEnabled: boolean,
  minAge: number | null | undefined,
  maxAge: number | null | undefined,
): AgeEligibilityResult {
  if (!ageLimitEnabled) {
    return {
      eligible: true,
      reason: "no_limit",
      publicMessage: "No age limit set.",
      hostStatus: "no_limit",
    };
  }

  const age = calculateUserAge(dob);

  if (age === null) {
    return {
      eligible: false,
      reason: "dob_missing",
      publicMessage: "Your profile needs a date of birth to join age-restricted events.",
      hostStatus: "dob_missing",
    };
  }

  const effectiveMin = minAge ?? null;
  const effectiveMax = maxAge ?? null;

  if (effectiveMin !== null && age < effectiveMin) {
    return {
      eligible: false,
      reason: "below_min_age",
      publicMessage: "You don't meet the age requirement for this event.",
      hostStatus: "not_eligible",
    };
  }

  if (effectiveMax !== null && age > effectiveMax) {
    return {
      eligible: false,
      reason: "above_max_age",
      publicMessage: "You don't meet the age requirement for this event.",
      hostStatus: "not_eligible",
    };
  }

  return {
    eligible: true,
    reason: "within_range",
    publicMessage: "You meet the age requirement.",
    hostStatus: "eligible",
  };
}

/**
 * Format a human-readable age badge label.
 * Examples: "Ages 21+", "Ages 18–30", "Under 35", "18–30"
 */
export function formatAgeLimitLabel(
  ageLimitEnabled: boolean,
  minAge: number | null | undefined,
  maxAge: number | null | undefined,
): string | null {
  if (!ageLimitEnabled) return null;

  const min = minAge ?? null;
  const max = maxAge ?? null;

  if (min !== null && max !== null) return `Ages ${min}–${max}`;
  if (min !== null) return `Ages ${min}+`;
  if (max !== null) return `Under ${max + 1}`;
  return null;
}

/**
 * Validate min/max age range inputs.
 * Returns null on success; returns an error message string on failure.
 */
export function validateAgeRange(
  minAge: number | null | undefined,
  maxAge: number | null | undefined,
): string | null {
  const min = minAge ?? null;
  const max = maxAge ?? null;

  if (min !== null) {
    if (!Number.isInteger(min) || min < PLATFORM_MIN_AGE) {
      return `Minimum age must be at least ${PLATFORM_MIN_AGE}`;
    }
    if (min > PLATFORM_MAX_AGE) {
      return `Minimum age must be at most ${PLATFORM_MAX_AGE}`;
    }
  }

  if (max !== null) {
    if (!Number.isInteger(max) || max < PLATFORM_MIN_AGE) {
      return `Maximum age must be at least ${PLATFORM_MIN_AGE}`;
    }
    if (max > PLATFORM_MAX_AGE) {
      return `Maximum age must be at most ${PLATFORM_MAX_AGE}`;
    }
  }

  if (min !== null && max !== null && max < min) {
    return "Maximum age must be greater than or equal to minimum age";
  }

  return null;
}
