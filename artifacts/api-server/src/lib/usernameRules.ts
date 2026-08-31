/**
 * Username validity + reserved-name rules (single source of truth).
 *
 * Extracted verbatim from routes/profile.ts so BOTH the /users/check-username
 * availability endpoint AND the Input Intelligence gateway's §23 username
 * validation assistance reuse exactly the same normalization/uniqueness rules —
 * there is one definition of "is this a valid, non-reserved username", not two
 * that can drift. profile.ts re-exports these so its behavior is unchanged.
 *
 * Zero imports on purpose: this module must stay a leaf so any caller (route or
 * gateway lib) can depend on it without a cycle.
 */

export const RESERVED_USERNAMES = new Set([
  "admin", "support", "travelbuddy", "official", "root", "system",
  "null", "undefined", "help", "security", "moderator", "owner",
  "passport", "api", "settings", "login", "signup", "me", "user",
  "users", "about", "terms", "privacy",
  // @Portava official publisher account — permanently reserved; cannot be
  // claimed via normal registration. Only the service-role seed script may
  // create this handle.
  "portava", "portava_official",
]);

/** No periods: keeps usernames clean; max 30 chars (was 24). */
export const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

export function validateUsername(u: string): { valid: boolean; reason?: string } {
  if (!USERNAME_RE.test(u)) {
    return { valid: false, reason: "Username must be 3-30 chars, lowercase letters, numbers, and underscores only" };
  }
  if (RESERVED_USERNAMES.has(u)) {
    return { valid: false, reason: "That username is reserved" };
  }
  return { valid: true };
}
