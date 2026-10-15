/**
 * avatarStorageRef — what `profiles.avatar_url` may hold when a person sets it.
 *
 * ── THE DEFECT (lane PRIV-FIX-3; found by B58 lane TM-2, "Adjacent findings") ──
 * A profile avatar is drawn by EVERY viewer of the person: a thread's header and
 * its reader chips, an inbox row, a comment, a follower list, a map pin. Until
 * this change a person could set their own avatar to any https URL:
 *   - PATCH /api/me/profile parsed `avatarUrl` with `appMediaRef`
 *     (lib/postSchemas.ts), which admits "https anywhere" (the migration-era
 *     absolute form); and
 *   - PostgREST: the baseline grants `UPDATE (avatar_url)` to anon and
 *     authenticated, 3740 re-grants the baseline's column list, and
 *     `profiles_update` admits the owner's row (2078 took back `role` only).
 * The client's hydration passes a non-storage URL through unchanged, so every
 * viewer's DEVICE fetched the host the person picked the moment the avatar drew:
 * the host learns each viewer's address and when they looked — a presence
 * beacon the viewer cannot see or refuse.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A person may set their avatar to EXACTLY the reference POST /me/avatar/upload
 * answers for them — `profile-media/avatars/<their own uid>/<file>` — or clear
 * it (null). Nothing wider:
 *   - four segments, the `profile-media` bucket, the `avatars` prefix;
 *   - the uid is lowercase and must be the CALLER's (`user.id` is lowercase; an
 *     upper-cased spelling names a different object key and is refused, not
 *     folded);
 *   - one file name of `[A-Za-z0-9._-]`, not starting with a dot, no `..`, at
 *     most 128 characters (the upload names it `<uuid>.<ext>`).
 * So another person's avatar, a cover (`covers/…`), a post's media, an absolute
 * URL of ANY host (Portava's own storage origin included — the upload never
 * answers that form), a relay path, a query, a fragment, percent-encoding,
 * whitespace, a backslash and every traversal are refused by SHAPE.
 *
 * The database states the same rule for every client role (migration 3827's
 * trigger, `profile_avatar_ref_ok`), so this module and the trigger must move
 * together: src/test/profileAvatarUrlStorageOnly.test.ts runs both over the same
 * table of references.
 *
 * Existing values are not rewritten: a row whose avatar is already an outside
 * URL keeps it until its owner changes it, and the app draws it as nothing
 * (travel-buddy-standalone src/lib/avatarImageUri.ts).
 */

/** The bucket and prefix POST /me/avatar/upload stores into (routes/profile.ts AVATAR_BUCKET, `avatars/${user.id}/…`). */
export const AVATAR_REF_BUCKET = "profile-media";
export const AVATAR_REF_PREFIX = "avatars";

/** The longest file name admitted. The upload's own is `<36-char uuid>.<ext>`; a bound, not a contract. */
export const AVATAR_REF_FILE_MAX = 128;

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * The uid an avatar reference names when `ref` is EXACTLY
 * `profile-media/avatars/<lowercase uid>/<file>`, and null for anything else.
 * Pure; never throws.
 */
export function avatarRefOwner(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const segs = ref.split("/");
  if (segs.length !== 4) return null;
  const [bucket, prefix, uid, file] = segs as [string, string, string, string];
  if (bucket !== AVATAR_REF_BUCKET || prefix !== AVATAR_REF_PREFIX) return null;
  if (!UID_RE.test(uid)) return null;
  if (file.length > AVATAR_REF_FILE_MAX || !FILE_RE.test(file) || file.includes("..")) return null;
  return uid;
}

/** Whether `userId` may set `ref` as their own avatar: null (clear it) or their own upload's reference. */
export function avatarRefAcceptedFor(ref: string | null | undefined, userId: string): boolean {
  if (ref === null || ref === undefined) return true;
  return avatarRefOwner(ref) === userId;
}

/** The refusal PATCH /me/profile answers for any other avatar value. */
export const AVATAR_REF_REFUSAL = "Your profile photo must be one you uploaded to Portava. Upload the photo, then save.";
