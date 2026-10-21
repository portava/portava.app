/**
 * census-telegraph T446 (§30A.20), the CLIENT half: a URL the message tree
 * fetches is Portava storage, or nothing.
 *
 *   "External previews cannot cause recipient-side network disclosure to
 *    arbitrary sender-controlled domains." (TG:653)
 *
 * WHY THE CLIENT NEEDS ITS OWN. The server already withholds a share
 * projection's image unless it is storage (api-server
 * `services/telegraph/messageTreeImages.ts#storageImageOrNull`), and its media
 * door refuses a non-storage `mediaUrl`. But the device draws more than the
 * server vetted: a legacy card's sender-serialised JSON (`payload.imageUrl`,
 * `payload.thumbnail`, `payload.authorAvatar`), a typed GIF or album payload, a
 * voice note's url, and media rows written before the door was closed. The
 * hydration layer passes a non-storage URL through unchanged
 * (`services/mediaUrl.ts`), so any of those naming another host made every
 * recipient's device contact that host when the bubble rendered — the host
 * learns each recipient's address and the moment they looked.
 *
 * THE RULE — the server's, character for character (a cross-tree test pins the
 * two to the same verdict on the same inputs). Kept only:
 *   - a URL on the CONFIGURED storage origin (`EXPO_PUBLIC_SUPABASE_URL`'s
 *     origin) under `/storage/v1/` — any bucket, public or signed;
 *   - a bare storage reference `<bucket>/<path>`, which the client can only
 *     ever resolve against Portava's storage.
 * Everything else — another host, `http:` to the storage host, a
 * scheme-relative URL, `data:`, `javascript:`, a `file:` URI, userinfo, a `..`
 * segment, an unconfigured storage origin — is null: the surface's designed
 * "no image" state. Narrowing only: a URL the rule keeps is returned unchanged.
 *
 * Every image, poster, video, audio or open-in-browser sink in the message tree
 * passes through this function or is named, with its reason, in the structural
 * test that holds the tree to it (`__tests__/messageTreeMedia.component.test.ts`).
 *
 * Pure module — no React, no network — safe under node:test.
 */

const BARE_STORAGE_REF = /^[a-z0-9][a-z0-9_-]*\/[^\s\\]+$/i;

/** The origin of this build's storage (its Supabase project), or null when unset. */
export function configuredStorageOrigin(raw: string | undefined = process.env.EXPO_PUBLIC_SUPABASE_URL): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * The URL, when the message tree may fetch it; otherwise null.
 * `origin` defaults to this build's configured storage origin.
 */
export function messageTreeMediaOrNull(raw: unknown, origin: string | null = configuredStorageOrigin()): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith('//') || v.includes('://')) {
    if (!origin) return null;
    try {
      // Inside the try: a runtime whose URL cannot answer one of these is a "no".
      const u = new URL(v);
      if (u.origin !== origin || u.username || u.password || !u.pathname.startsWith('/storage/v1/')) return null;
    } catch {
      return null;
    }
    return v;
  }
  if (!BARE_STORAGE_REF.test(v) || v.includes('..')) return null;
  return v;
}
