/**
 * census-media MD269 (a) — when the moderation stage holds a general post's
 * media, what happens to the POST? Lead ruling D-82
 * (docs/ops/lead-rulings-20261007-media.md, adopted by the lead 2026-10-07 under
 * the owner's 2026-10-06 delegation): REFUSE TO CREATE THE POST while any of its
 * media is held — census-media §37.8.5 option 3. "If the media's moderation state
 * cannot be read, the post is also refused, with 'try again'."
 *
 * WHY THIS IS THE GATE. A general post's media travel as `posts.media_urls`, and
 * the legacy readers (Pulse, Wall, the profile grid, GET /posts/:id) consult no
 * per-media moderation state. So a held file that reaches a post is DISTRIBUTED
 * by every one of them. Refusing the write keeps it out of all of them at once,
 * and leaves the delayed-publish state machine (post_status) exactly as it is.
 *
 * THE DECISION:
 *   - the stage flag (`media_moderation_classifier_enabled`, seeded FALSE) is
 *     read HERE, with a failed read told apart from FALSE (verifier F2: the
 *     shared isFlagEnabled reads an error as false, which would let held media
 *     through during a blip). off/absent ⇒ CLEAR, nothing else is read;
 *     unreadable ⇒ UNKNOWN (refused, "try again");
 *   - each reference is canonicalised the way the media relay resolves it
 *     (verifier F3) — leading slashes stripped, query and fragment cut,
 *     percent-encoding decoded — so another spelling of the same object cannot
 *     miss its row. A reference that names one of our buckets but does not
 *     canonicalise to a clean path is HELD;
 *   - a canonical row whose moderation state, in the §36 vocabulary
 *     (toCanonicalModerationStatus — legacy `approved` is `active`, verifier F4),
 *     is anything but `active` ⇒ HELD (`processing`, `limited`, `rejected`,
 *     `removed`, `owner_deleted`, unknown);
 *   - NO canonical row for an app-storage object ⇒ HELD while the stage is on
 *     (verifier F3): every upload writes a row while the canonical store runs, so
 *     a missing one is a file the stage never cleared;
 *   - a failed read ⇒ UNKNOWN, refused with "try again", never "rejected";
 *   - a reference to no app storage object at all (the migration-era absolute
 *     URL on a foreign origin `appMediaRef` still accepts) has nothing to hold.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { appStorageUrlInfo } from "../mediaUrl.js";
import { toCanonicalModerationStatus } from "./mediaAssetContract.js";

export type PostMediaHold =
  | { state: "clear" }
  | { state: "held"; heldCount: number }
  | { state: "unknown"; reason: "unreadable" };

const APP_BUCKETS = new Set(["post-media", "profile-media"]);
const RELAY_PREFIX = "/api/media/file/";

/** One storage object, as the relay would resolve it, or null when the spelling is not a clean object path. */
function canonicalObject(bucket: string, rawPath: string): { bucket: string; path: string } | null {
  let path = rawPath.split(/[?#]/)[0]!.replace(/^\/+/, "");
  try { path = decodeURIComponent(path); } catch { return null; }
  path = path.replace(/^\/+/, "");
  if (!APP_BUCKETS.has(bucket) || path === "" || path.endsWith("/")) return null;
  if (path.includes("//") || path.includes("\\") || path.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return { bucket, path };
}

/**
 * What a post's media reference points at:
 *   { kind: "object", bucket, path } — one of our storage objects, canonicalised;
 *   { kind: "unclean" } — it names one of our buckets but not a clean object path;
 *   { kind: "foreign" } — it names no app storage at all.
 */
export function postMediaStorageRef(ref: string):
  | { kind: "object"; bucket: string; path: string }
  | { kind: "unclean" }
  | { kind: "foreign" } {
  const s = typeof ref === "string" ? ref.trim() : ""; const api = storageApiRef(s); if (api) return api; // verifier N3: a signed / authenticated / render URL to our storage is ours
  // The relay path, relative or absolute: /api/media/file/<bucket>/<path>.
  let pathname: string | null = null;
  if (s.toLowerCase().startsWith(RELAY_PREFIX)) pathname = s; // verifier N4: Express routes case-insensitively
  else if (/^[a-z]+:\/\//i.test(s)) { try { pathname = new URL(s).pathname; } catch { pathname = null; } }
  if (pathname && pathname.toLowerCase().startsWith(RELAY_PREFIX)) {
    const rest = pathname.slice(RELAY_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return { kind: "unclean" };
    const o = canonicalObject(rest.slice(0, slash), rest.slice(slash + 1));
    return o ? { kind: "object", ...o } : { kind: "unclean" };
  }
  // A bare "<bucket>/<path>" in one of our buckets.
  const bare = /^([a-z-]+)\/(.*)$/.exec(s);
  if (bare && !s.includes("://") && APP_BUCKETS.has(bare[1]!)) {
    const o = canonicalObject(bare[1]!, bare[2]!);
    return o ? { kind: "object", ...o } : { kind: "unclean" };
  }
  // A public storage URL on the configured origin.
  const direct = appStorageUrlInfo(s);
  if (direct) {
    const o = canonicalObject(direct.bucket, direct.path);
    return o ? { kind: "object", ...o } : { kind: "unclean" };
  }
  // Our origin's storage prefix in any other spelling is still ours.
  if (/\/storage\/v1\/(?:object|render\/image)\/public\/(post-media|profile-media)\//.test(s)) return { kind: "unclean" };
  return { kind: "foreign" };
}

/** The only canonical moderation state a post may carry its file in. */
export const POST_MEDIA_DISTRIBUTABLE_STATUS = "active";

export const POST_MEDIA_HELD_MESSAGE =
  "A photo or video in this post is still being reviewed, or can't be shared. Try again once it has cleared.";
export const POST_MEDIA_UNREADABLE_MESSAGE =
  "We couldn't check your photos and videos just now. Please try again.";

/** The stage flag, with a failed read told apart from FALSE. */
async function readStage(sc: SupabaseClient | null | undefined): Promise<"on" | "off" | "unknown"> {
  if (!sc || typeof (sc as any).from !== "function") return "unknown";
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "media_moderation_classifier_enabled") // = vendors/mediaVendorStages MEDIA_MODERATION_STAGE_FLAG, spelled as a literal so check:flag-polarity can resolve it (DIRECT_READS); the tests key the stage row by that constant, so a drift turns them red
      .maybeSingle();
    if (error) return "unknown";
    return (data as { enabled?: unknown } | null)?.enabled === true ? "on" : "off";
  } catch {
    return "unknown";
  }
}

export async function postMediaModerationHold(
  sc: SupabaseClient | null | undefined,
  mediaUrls: readonly string[] | null | undefined,
): Promise<PostMediaHold> {
  const urls = (mediaUrls ?? []).filter((u) => typeof u === "string" && u.trim().length > 0);
  if (urls.length === 0) return { state: "clear" };
  const stage = await readStage(sc);
  if (stage === "unknown") return { state: "unknown", reason: "unreadable" };
  if (stage === "off") return { state: "clear" };

  let held = 0;
  for (const url of urls) {
    const ref = postMediaStorageRef(url);
    if (ref.kind === "foreign") continue; // names no app storage object, so no canonical row can hold it
    if (ref.kind === "unclean") { held++; continue; }
    let row: { moderation_status?: unknown } | null;
    try {
      const { data, error } = await sc!
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
    if (!row || toCanonicalModerationStatus(row.moderation_status) !== POST_MEDIA_DISTRIBUTABLE_STATUS) held++;
  }
  return held > 0 ? { state: "held", heldCount: held } : { state: "clear" };
}

/**
 * The refusal a route sends for a hold, or null when the post may be written.
 * held ⇒ 409 `conflict` (the media is in review or cannot be shared);
 * unknown ⇒ 503 `degraded_unavailable` (retry; never told it was rejected).
 */
export function postMediaHoldRefusal(hold: PostMediaHold): { code: "conflict" | "degraded_unavailable"; message: string } | null {
  if (hold.state === "clear") return null;
  return hold.state === "held"
    ? { code: "conflict", message: POST_MEDIA_HELD_MESSAGE }
    : { code: "degraded_unavailable", message: POST_MEDIA_UNREADABLE_MESSAGE };
}

// ── Every Storage API form of our objects (verifier N3, 2026-10-07) ──────────
// Appended at the tail so no cited line above moves; function declarations hoist.
//
// appStorageUrlInfo knows only the PUBLIC form (/storage/v1/object/public/...).
// The uploader can also mint a signed URL to their own object (/object/sign/...,
// valid an hour, renewable) or use the authenticated or image-render forms. Each
// names the same object, so each must meet the same hold: a held file must not
// reach a post because it was spelled as a self-authenticating link.
//
// A URL is a Storage API reference when its path contains /storage/v1/ anywhere
// — on our project's origin or behind any other host (a proxy serving our
// project is still our storage). Then:
//   /storage/v1/(object|render/image)/(public|sign|authenticated)/<bucket>/<path>
//   in one of our buckets ⇒ that object, canonicalised like every other form;
//   any other path that still names one of our buckets ⇒ unclean (held);
//   anything else ⇒ not decided here (null), and the rules above run.

const STORAGE_API_OBJECT = /^\/storage\/v1\/(?:object|render\/image)\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/i;

function storageApiRef(s: string): { kind: "object"; bucket: string; path: string } | { kind: "unclean" } | null {
  if (!/^[a-z]+:\/\//i.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  let decoded: string;
  try { decoded = decodeURIComponent(u.pathname); } catch { decoded = u.pathname; }
  const storagePath = u.pathname.toLowerCase().includes("/storage/v1/") || decoded.toLowerCase().includes("/storage/v1/");
  if (!storagePath) return null;
  const m = STORAGE_API_OBJECT.exec(u.pathname);
  if (m) {
    let bucket: string;
    try { bucket = decodeURIComponent(m[1]!); } catch { return { kind: "unclean" }; }
    if (APP_BUCKETS.has(bucket)) {
      const o = canonicalObject(bucket, m[2]!);
      return o ? { kind: "object", ...o } : { kind: "unclean" };
    }
  }
  const lower = decoded.toLowerCase();
  for (const b of APP_BUCKETS) if (lower.includes(`/${b}/`)) return { kind: "unclean" };
  return null;
}

