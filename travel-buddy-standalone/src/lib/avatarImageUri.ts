/**
 * avatarImageUri — a person's avatar is drawn from Portava's own storage, or it
 * is not drawn at all (lane PRIV-FIX-3; census-telegraph §97).
 *
 * WHY THIS EXISTS. Every viewer of a person draws their avatar — a thread's
 * header and reader chips, an inbox row, a comment, a follower list, a map pin.
 * The hydration layer (`services/mediaUrl.ts`) returns "non-private-bucket URLs
 * and non-storage URLs … unchanged", and every image primitive then hands that
 * string to the native image loader. `profiles.avatar_url` was writable by its
 * owner with ANY https URL (PostgREST and PATCH /api/me/profile), so a person
 * could point their avatar at a host they control and learn every viewer's
 * address and the moment they looked. The server now refuses such a value
 * (migration 3827, api-server lib/avatarStorageRef.ts), but rows written before
 * stay as they are — and seed or legacy rows hold outside hosts too — so the app
 * must refuse to fetch them as well.
 *
 * THE RULE — the same storage-or-nothing rule as the server's
 * `artifacts/api-server/src/services/telegraph/messageTreeImages.ts#storageImageOrNull`
 * (TM-1) and the message tree's `telegraphMediaUri` (TM-2, PR #740). Kept only:
 *   - a URL that begins with the CONFIGURED storage origin
 *     (`EXPO_PUBLIC_SUPABASE_URL`'s scheme and host) followed by `/storage/v1/`
 *     — a legacy public URL or a signed URL of Portava's own storage;
 *   - a bare storage reference `<bucket>/<path>` (what the upload answers), which
 *     the hydration layer can only ever resolve against Portava's storage.
 * Everything else — another host, a scheme-relative URL, `data:`, `file:`,
 * `javascript:`, a URL with a backslash, whitespace or a control character, an
 * unconfigured storage origin — is null, and every caller draws its designed
 * no-photo state (initials, a glyph). Narrowing only: nothing kept is changed.
 *
 * PARSER-INDEPENDENT ON PURPOSE (TM-2's reasoning): React Native's `URL` is a
 * regex polyfill and each native loader parses again, so the storage case is
 * decided by PREFIX — exactly `<scheme>://<host>[:port]/storage/v1/` — which
 * fixes the authority whatever a later parser does with the rest.
 *
 * NOT for a picture the person has just picked on THIS device (a `file://` or
 * `blob:` preview before upload): that is never a network fetch, so callers
 * apply this to the stored value only.
 *
 * The guard `src/lib/__tests__/avatarImageBoundary.test.ts` fails when an image
 * sink binds an avatar-named source without this function (or a reviewed pin).
 */

const BARE_STORAGE_REF = /^[a-z0-9][a-z0-9_-]*\/[^\s\\]+$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\s\\\u0000-\u001f\u007f]/;
const ORIGIN_OF = /^(https?):\/\/([a-z0-9.-]+)(:\d{1,5})?(?:[/?#].*)?$/i;

/**
 * `EXPO_PUBLIC_SUPABASE_URL`'s origin (`https://<host>[:port]`, host lowercased),
 * or null when it is unset or not an http(s) URL. Read literally from
 * `process.env.EXPO_PUBLIC_SUPABASE_URL` because Expo inlines only that exact
 * member expression into a release bundle.
 */
export function avatarStorageOrigin(): string | null {
  const raw = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
  const m = ORIGIN_OF.exec(raw);
  if (!m) return null;
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3] ?? ''}`;
}

/**
 * An avatar's one door to an image loader: the value itself when it is Portava
 * storage, otherwise null. `origin` defaults to the configured storage origin; a
 * test passes its own.
 */
export function avatarImageUri(
  raw: unknown,
  origin: string | null = avatarStorageOrigin(),
): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || UNSAFE_CHARS.test(v)) return null;
  if (v.startsWith('//') || v.includes('://')) {
    if (!origin) return null;
    return v.startsWith(`${origin}/storage/v1/`) ? v : null;
  }
  if (!BARE_STORAGE_REF.test(v) || v.includes('..')) return null;
  return v;
}
