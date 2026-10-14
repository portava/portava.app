/**
 * census-telegraph T446 (§30A.20), path (a) of the B58 plan: an image the server
 * puts in front of a RECIPIENT inside a conversation is a reference into
 * Portava's own storage, or it is nothing.
 *
 *   "External previews cannot cause recipient-side network disclosure to
 *    arbitrary sender-controlled domains." (TG:653)
 *
 * WHY. A share projection's `imageUrl` (services/telegraph/shareables.ts#proj)
 * is drawn by every recipient's device, and the client's hydration layer passes
 * a non-storage URL through unchanged (travel-buddy-standalone
 * src/services/mediaUrl.ts: "Non-private-bucket URLs and non-storage URLs are
 * returned unchanged"). So an image URL naming any other host — a profile's
 * `avatar_url`, a trip's or an event's `cover_url`, a stamp definition's art —
 * made every recipient's device contact that host when the card rendered: the
 * host learns each recipient's address and the moment they looked.
 *
 * THE RULE (owner question Q-LP9, fail-closed default: withheld). Kept only:
 *   - a URL on the CONFIGURED storage origin (`SUPABASE_URL`'s origin) under
 *     `/storage/v1/` — any bucket, public or signed; it is Portava's host;
 *   - a bare storage reference `<bucket>/<path>`, which the client can only
 *     ever resolve against Portava's storage.
 * Everything else — another host, a scheme-relative URL, `data:`, `javascript:`,
 * a URL with userinfo, an unconfigured storage origin — is null, the projection's
 * designed "no image" state. Narrowing only: no image the rule keeps is changed.
 *
 * NOT `lib/mediaUrl.ts#appStorageUrlInfo`, which the plan named: that accepts
 * only the two PRIVATE buckets (`post-media`, `profile-media`), and stamp art is
 * served from the public `stamp-artwork` bucket on the same origin — using it
 * would blank every stamp card's art for a reason T446 does not give.
 */
import { configuredStorageOrigin } from "../../lib/mediaUrl.js";

const BARE_STORAGE_REF = /^[a-z0-9][a-z0-9_-]*\/[^\s\\]+$/i;

export function storageImageOrNull(raw: unknown, origin: string | null = configuredStorageOrigin()): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith("//") || v.includes("://")) {
    if (!origin) return null;
    let u: URL;
    try { u = new URL(v); } catch { return null; }
    if (u.origin !== origin || u.username || u.password || !u.pathname.startsWith("/storage/v1/")) return null;
    return v;
  }
  if (!BARE_STORAGE_REF.test(v) || v.includes("..")) return null;
  return v;
}
