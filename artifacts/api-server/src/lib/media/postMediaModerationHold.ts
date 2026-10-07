/**
 * census-media MD269 (a) — when the moderation stage holds a general post's
 * media, what happens to the POST? Lead ruling D-82
 * (docs/ops/lead-rulings-20261007-media.md, proposed by lane M under the owner's
 * 2026-10-06 delegation): REFUSE TO CREATE THE POST while any of its media is
 * held — census-media §37.8.5 option 3.
 *
 * WHY THIS IS THE GATE. A general post's media travel as `posts.media_urls`, and
 * the legacy readers (Pulse, Wall, the profile grid, GET /posts/:id) consult no
 * per-media moderation state. So a held file that reaches a post is DISTRIBUTED
 * by every one of them. Refusing the create keeps it out of all of them at once,
 * and leaves the delayed-publish state machine (post_status) exactly as it is.
 *
 * THE DECISION, per file, read from the canonical store the §36 stage writes:
 *   - stage off (`media_moderation_classifier_enabled`, seeded FALSE) ⇒ CLEAR:
 *     nothing changes for anyone while the stage is off;
 *   - a canonical row whose `moderation_status` is not `active` (born `limited`
 *     while the stage is on, `processing` before the decider ran, or `rejected`
 *     / `removed` / `owner_deleted`) ⇒ HELD — the post is refused;
 *   - a failed read ⇒ UNKNOWN — refused with "try again", never as "rejected";
 *   - no canonical row ⇒ CLEAR. The stage holds only what it recorded: a file
 *     written while `media_canonical_enabled` was off (or on a pre-2250 schema)
 *     has no row to hold, which census-media §37.8.4 states as the stage's limit.
 *     A reference that names no app storage object at all (the migration-era
 *     absolute URL `appMediaRef` still accepts) can have no row either.
 *
 * Every form `appMediaRef` accepts that names an app storage object is resolved:
 * a bare `<bucket>/<path>`, a public storage URL on the configured origin
 * (both via appStorageUrlInfo), and the relay path `/api/media/file/<bucket>/<path>`,
 * relative or absolute — so the relay form is not a way around the hold.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { appStorageUrlInfo } from "../mediaUrl.js";
import { isMediaModerationStageEnabled } from "./vendors/mediaVendorStages.js";

export type PostMediaHold =
  | { state: "clear" }
  | { state: "held"; heldCount: number }
  | { state: "unknown"; reason: "unreadable" };

const RELAY_PREFIX = "/api/media/file/";
const RELAY_BUCKETS = new Set(["post-media", "profile-media"]);

/** The storage object a post's media reference names, or null when it names none. */
export function postMediaStorageRef(ref: string): { bucket: string; path: string } | null {
  const direct = appStorageUrlInfo(ref);
  if (direct) return direct;
  let pathname: string | null = null;
  if (ref.startsWith(RELAY_PREFIX)) pathname = ref;
  else {
    try { pathname = new URL(ref).pathname; } catch { pathname = null; }
  }
  if (!pathname || !pathname.startsWith(RELAY_PREFIX)) return null;
  const rest = pathname.slice(RELAY_PREFIX.length).split(/[?#]/)[0]!;
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let bucket: string; let path: string;
  try { bucket = decodeURIComponent(rest.slice(0, slash)); path = decodeURIComponent(rest.slice(slash + 1)); } catch { return null; }
  if (!RELAY_BUCKETS.has(bucket) || !path || path.includes("..")) return null;
  return { bucket, path };
}

/** The only canonical moderation state a post may carry its file in. */
export const POST_MEDIA_DISTRIBUTABLE_STATUS = "active";

export const POST_MEDIA_HELD_MESSAGE =
  "A photo or video in this post is still being reviewed, or can't be shared. Try again once it has cleared.";
export const POST_MEDIA_UNREADABLE_MESSAGE =
  "We couldn't check your photos and videos just now. Please try again.";

export async function postMediaModerationHold(
  sc: SupabaseClient | null | undefined,
  mediaUrls: readonly string[] | null | undefined,
): Promise<PostMediaHold> {
  const urls = (mediaUrls ?? []).filter((u) => typeof u === "string" && u.trim().length > 0);
  if (urls.length === 0) return { state: "clear" };
  if (!(await isMediaModerationStageEnabled(sc))) return { state: "clear" };
  if (!sc) return { state: "unknown", reason: "unreadable" };

  let held = 0;
  for (const url of urls) {
    const ref = postMediaStorageRef(url);
    if (!ref) continue; // names no app storage object, so no canonical row can hold it
    let row: { moderation_status?: unknown } | null;
    try {
      const { data, error } = await sc
        .from("media_assets")
        .select("moderation_status")
        .eq("storage_bucket", ref.bucket)
        .eq("storage_path", ref.path)
        .maybeSingle();
      // supabase-js RESOLVES a failed read; an unread state is not "no hold".
      if (error) return { state: "unknown", reason: "unreadable" };
      row = (data as { moderation_status?: unknown } | null) ?? null;
    } catch {
      return { state: "unknown", reason: "unreadable" };
    }
    if (row && row.moderation_status !== POST_MEDIA_DISTRIBUTABLE_STATUS) held++;
  }
  return held > 0 ? { state: "held", heldCount: held } : { state: "clear" };
}
