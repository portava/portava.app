/**
 * census-telegraph T446 (§30A.20) on the CLIENT: an image or poster the
 * message tree draws for a recipient is a reference into Portava's own
 * storage, or it is nothing.
 *
 *   "External previews cannot cause recipient-side network disclosure to
 *    arbitrary sender-controlled domains." (TG:653)
 *
 * WHY THIS EXISTS. The hydration layer (`services/mediaUrl.ts`) returns
 * "non-private-bucket URLs and non-storage URLs … unchanged", and every image
 * primitive (`DisplayMediaImage`, `Avatar`, `VideoThumbnail`, `CachedImage`)
 * then hands that string to the native image loader. So any URL a SENDER can
 * put in a message field the tree draws — a GIF or album envelope's `url`
 * (the kinds route stores any string up to 2048 characters), a legacy shared
 * card's `imageUrl` / `thumbnail` / `authorAvatar` (the JSON the sender
 * serialised), a legacy `media_url` row — made every recipient's DEVICE contact
 * that host the moment the bubble drew: the host learns each recipient's
 * address and when they looked, whatever their read-receipt setting says.
 *
 * THE RULE — the same rule as the server's
 * `artifacts/api-server/src/services/telegraph/messageTreeImages.ts#storageImageOrNull`
 * (TM-1, owner question Q-LP9, fail-closed default: withheld). Kept only:
 *   - a URL that begins with the CONFIGURED storage origin
 *     (`EXPO_PUBLIC_SUPABASE_URL`'s scheme and host) followed by `/storage/v1/`
 *     — any bucket, public or signed; it is Portava's host;
 *   - a bare storage reference `<bucket>/<path>`, which the hydration layer can
 *     only ever resolve against Portava's storage (a private bucket is signed by
 *     our API; any other bare string is not a loadable network URL at all).
 * Everything else — another host, a scheme-relative URL, `data:`, `file:`,
 * `javascript:`, a URL with a backslash, an unconfigured storage origin — is
 * null, and every caller draws its designed "no image" state. Narrowing only:
 * nothing this rule keeps is changed.
 *
 * PARSER-INDEPENDENT ON PURPOSE. React Native's `URL` is a regex polyfill
 * (`react-native/Libraries/Blob/URL.js`) that accepts strings a WHATWG parser
 * would reject and reads authorities differently, and the native loaders on
 * iOS and Android each parse again. So the storage case is decided by PREFIX:
 * the string must start with exactly `<scheme>://<host>[:port]/storage/v1/`,
 * which fixes the authority whatever any later parser does with the rest, and
 * it may contain no whitespace, control character or backslash anywhere.
 *
 * The message-tree guard (`../__tests__/messageTreeNetworkBoundary.test.ts`)
 * fails when an image sink in the message tree binds a source that does not go
 * through this function (or a reviewed, non-message pin).
 */

const BARE_STORAGE_REF = /^[a-z0-9][a-z0-9_-]*\/[^\s\\]+$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\s\\\u0000-\u001f\u007f]/;
const ORIGIN_OF = /^(https?):\/\/([a-z0-9.-]+)(:\d{1,5})?(?:[/?#].*)?$/i;

/**
 * `EXPO_PUBLIC_SUPABASE_URL`'s origin (`https://<host>[:port]`, host
 * lowercased), or null when it is unset or not an http(s) URL. Read literally
 * from `process.env.EXPO_PUBLIC_SUPABASE_URL` because Expo inlines only that
 * exact member expression into a release bundle.
 */
export function configuredStorageOrigin(): string | null {
  const raw = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
  const m = ORIGIN_OF.exec(raw);
  if (!m) return null;
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3] ?? ''}`;
}

/**
 * The message tree's one door for a media URI: the value itself when it is
 * Portava storage, otherwise null. `origin` defaults to the configured storage
 * origin; a test passes its own.
 */
export function telegraphMediaUri(
  raw: unknown,
  origin: string | null = configuredStorageOrigin(),
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
