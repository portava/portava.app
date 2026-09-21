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

// ── §23 username ALTERNATIVES ─────────────────────────────────────────────────
//
// §23's row is "Username unavailable → immediate non-blocking state PLUS
// alternatives". Only the state existed: the field said "already taken" and left
// the user to invent the next guess themselves, one round trip at a time.
//
// Every candidate is derived ONLY from the text the user already typed, and each
// one is re-checked through `validateUsername` — the SAME single source of truth
// the /users/check-username endpoint and the profile write path use — so a
// RESERVED handle or one that breaks the normalization rules can never be
// proposed. That filter is not a display nicety: without it the suffix generator
// would happily hand back a handle the write path would then refuse.
//
// §47 ACCOUNT-ENUMERATION: this makes no disclosure that `GET /users/check-
// username` does not already make, about handles the caller composed themselves,
// and the read is strictly NARROWER than the availability query it sits next to —
// it selects `username` and nothing else, where the availability query selects
// `id`. No account identifier enters this path, and the candidate set is bounded
// by USERNAME_ALTERNATIVE_SUFFIXES rather than by anything the caller sends.
//
// FAIL-CLOSED, on the D11 doctrine recorded in lib/inputAssistance/socialIdentity.ts:
// an unreadable
// `profiles` read returns `null`, not `[]`. "This handle is free" is a POSITIVE
// claim about the registry and must never be made out of a read that failed —
// the same defect `searchExistingHashtags` made when it labelled an existing tag
// "New tag".

/** Deterministic, ordered. Not random: the same typed handle must always yield the same offers. */
export const USERNAME_ALTERNATIVE_SUFFIXES = ['1', '2', '3', '_', '_travels'] as const;

/**
 * Candidate handles derived from what the user typed. Pure — no I/O, no
 * availability claim. Every returned candidate has already passed
 * `validateUsername`, so nothing reserved or malformed can reach a user.
 */
export function usernameAlternativeCandidates(usernameRaw: string): string[] {
  const base = (usernameRaw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_{2,}/g, '_');
  if (base.length === 0) return [];
  const out: string[] = [];
  for (const suffix of USERNAME_ALTERNATIVE_SUFFIXES) {
    // Truncate the BASE, never the suffix, so a handle already at the 30-char
    // ceiling still produces offers instead of silently producing none.
    const candidate = `${base.slice(0, 30 - suffix.length)}${suffix}`;
    if (candidate === base) continue;
    if (!validateUsername(candidate).valid) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * The free subset of `usernameAlternativeCandidates`, in candidate order.
 *
 * Returns `null` — NOT `[]` — when the `profiles` registry could not be read, so
 * the caller cannot mistake an outage for "all of these are free". A candidate
 * that happens to be the caller's OWN current handle is reported taken and
 * dropped: offering someone the handle they already hold is useless, and
 * dropping it is the safe direction.
 */
export async function suggestUsernameAlternatives(
  sc: any,
  usernameRaw: string,
  max = 3,
): Promise<string[] | null> {
  if (max <= 0) return [];
  const candidates = usernameAlternativeCandidates(usernameRaw);
  if (candidates.length === 0) return [];
  try {
    const { data, error } = await sc
      .from('profiles')
      .select('username')
      .in('username', candidates);
    if (error) return null; // D11: unreadable registry is not an empty one.
    const taken = new Set<string>(
      ((data ?? []) as any[]).map((r) => String(r.username ?? '').toLowerCase()),
    );
    return candidates.filter((c) => !taken.has(c)).slice(0, max);
  } catch {
    return null;
  }
}
