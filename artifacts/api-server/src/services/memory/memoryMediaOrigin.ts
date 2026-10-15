/**
 * memoryMediaOrigin — can this Memory item's media_url be attributed to the
 * person attaching it?
 *
 * SPEC: Portava Highlights / Memories Development Architecture Spec v1 §20
 *       (media pipeline: ingest metadata → fingerprint → cheap association →
 *       thumbnail → expensive analysis) and §28's general rule that a canonical
 *       fact must not be a client's unchecked assertion.
 *
 * CENSUS: H181 — "Memory media bypasses all of it: `routes/memories.ts` inserts
 * a client-supplied `media_url` straight into `memory_items`". This file closes
 * the OWNERSHIP leg of that sentence. It does not build the staged pipeline;
 * there is no fingerprint, no thumbnail and no moderation status on
 * `memory_items`, and no migration in this lane's gift to add one, so H181
 * stays W on the pipeline.
 *
 * ── THE SHAPE OF THE DEFECT, AND WHY IT IS NOT THE STORIES ONE ─────────────
 *
 * `src/test/storyMediaOwnership.test.ts` documents the identical write on
 * `POST /stories` and the read primitive it composed with:
 * `lib/mediaAccess.ts` branch 3d resolved story media BY media_url and returned
 * `story.visibility === "public"`, so a public story pointing at a victim's key
 * served the victim's bytes.
 *
 * MEASURED HERE, NOT ASSUMED: `lib/mediaAccess.ts` has NO `memory_items`
 * branch — `grep -n "memory_items" src/lib/mediaAccess.ts` returns nothing — so
 * a Memory's visibility authorises no bytes at all, and
 * `DELETE /memories/:id/items/:itemId` already refuses to remove an object
 * outside `memories/<owner>/`. The destructive and the exfiltration primitives
 * are both already closed. What remains is ATTRIBUTION: a Memory of the
 * attacker's, with the attacker's caption, date and place, rendered with
 * another user's photograph, on every surface that shows a Memory cover.
 *
 * ── WHY ONLY `foreign_storage` IS REFUSED ─────────────────────────────────
 *
 * Refusing everything that is not provably the caller's own object would refuse
 * every `external` URL too — and this route has accepted those since it was
 * written, so a client that stores media anywhere else would break on deploy
 * with no migration path. Whether Memory media should be restricted to our own
 * storage is a product decision, not a defect, and it is left open and named
 * rather than taken here. `unattributable_storage` — our bucket, no owner
 * segment in the path — is likewise NOT refused: it is an object we host whose
 * owner this function cannot derive, and refusing on an inability to attribute
 * would turn a naming convention into an outage. Both are reported so a caller
 * can log them.
 *
 * What IS refused is the one case with no legitimate reading: a path inside our
 * storage whose owner segment is a DIFFERENT user id.
 *
 * PURE. No I/O — it decides from the string and the caller's id alone, so it
 * cannot fail open on a database outage, which is how the sibling guards on
 * this surface have historically gone wrong.
 */

/**
 * Buckets this deployment serves user objects from. A path is only attributed
 * when it sits under one of these; anything else is `external`.
 * `lib/mediaAccess.ts` decides on exactly these two.
 */
export const OUR_STORAGE_BUCKETS = ["post-media", "profile-media"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MemoryMediaVerdict =
  | { verdict: "own_storage"; bucket: string; path: string; pathOwner: string }
  | { verdict: "foreign_storage"; bucket: string; path: string; pathOwner: string }
  | { verdict: "unattributable_storage"; bucket: string; path: string }
  | { verdict: "external" };

/**
 * The owner a storage path names, by this repository's two conventions:
 *   `<uid>/<file>`                 — POST /api/media/upload's flat form
 *   `memories|stories|avatars|covers/<uid>/<file>`
 * Deliberately the same rule as `lib/mediaAccess.ts` `ownerFromPath`, restated
 * here so this module is pure and has no import cycle into the media layer.
 * A SEGMENT match, never a substring one: a victim id in a FILENAME attributes
 * nothing.
 */
export function ownerSegmentOf(path: string): string | null {
  const segs = path.split("/").filter((s) => s.length > 0);
  if (UUID_RE.test(segs[0] ?? "")) return segs[0];
  if (
    (segs[0] === "stories" || segs[0] === "memories" || segs[0] === "avatars" || segs[0] === "covers") &&
    UUID_RE.test(segs[1] ?? "")
  ) {
    return segs[1];
  }
  return null;
}

/**
 * Split a media_url into (bucket, path) when it denotes one of our objects.
 *
 * Three spellings, all of which appear in this database:
 *   absolute public: `<origin>/storage/v1/object/public/<bucket>/<path>`
 *   absolute signed: `<origin>/storage/v1/object/sign/<bucket>/<path>?token=…`
 *   bare key:        `<bucket>/<path>` — the form
 *                    `2081_canonicalize_absolute_storage_urls.sql` writes.
 */
export function storageRefOf(mediaUrl: string): { bucket: string; path: string } | null {
  const raw = String(mediaUrl ?? "");
  if (raw.length === 0) return null;

  for (const marker of ["/storage/v1/object/public/", "/storage/v1/object/sign/"]) {
    const idx = raw.indexOf(marker);
    if (idx === -1) continue;
    let rest = raw.slice(idx + marker.length);
    const q = rest.indexOf("?");
    if (q !== -1) rest = rest.slice(0, q);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const bucket = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    if (!(OUR_STORAGE_BUCKETS as readonly string[]).includes(bucket) || path.length === 0) return null;
    return { bucket, path };
  }

  // Bare key. Only when it is not some other absolute URL.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0) return null;
  const bucket = raw.slice(0, slash);
  const path = raw.slice(slash + 1);
  if (!(OUR_STORAGE_BUCKETS as readonly string[]).includes(bucket) || path.length === 0) return null;
  return { bucket, path };
}

/** Never throws. A string this cannot parse is `external`, i.e. not our object. */
export function classifyMemoryMediaUrl(mediaUrl: string, actorUserId: string): MemoryMediaVerdict {
  let ref: { bucket: string; path: string } | null = null;
  try {
    ref = storageRefOf(mediaUrl);
  } catch {
    ref = null;
  }
  if (!ref) return { verdict: "external" };
  const pathOwner = ownerSegmentOf(ref.path);
  if (pathOwner === null) return { verdict: "unattributable_storage", bucket: ref.bucket, path: ref.path };
  if (pathOwner.toLowerCase() === String(actorUserId ?? "").toLowerCase()) {
    return { verdict: "own_storage", bucket: ref.bucket, path: ref.path, pathOwner };
  }
  return { verdict: "foreign_storage", bucket: ref.bucket, path: ref.path, pathOwner };
}

/** The refusal a route shows the user. Names no other user's id. */
export const FOREIGN_MEDIA_REFUSAL =
  "That photo belongs to someone else's upload. Upload your own photo to add it to this Memory.";

// ── Lead (2026-10-08, found by lane M's verifier): a Memory item's media URL ──
// takes lane M's appMediaRef rule (verifier M3 D82-1). Appended so every line
// the census cites above holds.
/**
 * Is `mediaUrl` an absolute media URL a Memory item may carry? `https:` from
 * anywhere (the route has always accepted external URLs; whether it should is
 * still the open product question named above), and `http:` only on the
 * configured storage origin (a local Supabase). `data:`, `blob:`, `file:`,
 * `javascript:` and every other scheme are refused: `z.string().url()` parses all
 * of them. The same rule as postSchemas.acceptedAbsoluteMediaUrl on lane M's
 * branch, restated here (pure: the origin is passed in) so this lane does not
 * depend on an unmerged file; collapse into that function once both are on main.
 */
export function memoryItemMediaUrlAccepted(mediaUrl: string, storageOrigin: string | null): boolean {
  let u: URL;
  try { u = new URL(mediaUrl); } catch { return false; }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && storageOrigin !== null && u.origin === storageOrigin;
}

/** The refusal a route shows for any other URL. */
export const MEMORY_MEDIA_URL_REFUSAL = "That photo link can't be used. Upload the photo, or use an https link.";

// ── Lane MEM-MEDIA-ADD (2026-10-14, B58; found by lane MEM-SEGMENTS) ──────────
// The reference POST /api/media/upload answers is a Memory item's media too.
// Appended so every line the census cites above holds.
//
// THE DEFECT. The app adds a photo by uploading it to POST /api/media/upload
// and sending that answer's `url` verbatim to POST /memories/:id/items
// (travel-buddy-standalone/src/services/memories.ts addMemoryItem). The upload
// answers the BARE KEY `post-media/<uid>/<ms>.<ext>` (routes/posts.ts
// `mediaRelayUrl`) — the canonical reference for an object in a private
// bucket; a public URL of it loads for nobody. The items route parsed
// `mediaUrl` with `z.string().url()`, which a bare key is not, so every photo
// added from the app was answered 400 and nothing was written.
//
// THE RULE, AND WHY IT IS THIS NARROW. The route accepts the upload's own form
// and nothing wider: exactly three segments, the upload's bucket, a lowercase
// uuid (the only form `user.id` takes, so an upper-cased variant — a DIFFERENT
// object key — is refused rather than folded), and one file name of
// `[A-Za-z0-9._-]` that does not start with a dot and contains no `..`. So
// traversal, percent-encoding (an encoded slash or dot never decodes into a
// path here, because `%` is not admitted at all), queries, fragments,
// backslashes, whitespace, nested paths, other buckets and other prefixes are
// all refused by SHAPE. Whose uid it is, is NOT decided here: this names the
// owner, and the route's existing classifyMemoryMediaUrl refuses any key whose
// owner is not the caller (`foreign_storage`), exactly as it already did for
// the absolute spellings of the same object.
//
// Every reader of memory_items.media_url already resolves this form to the same
// (bucket, path) the upload stored: POST /api/media/sign (lib/mediaUrl
// appStorageUrlInfo), the app's hydration (src/services/mediaUrl.ts
// extractBucket), storageRefOf above, and account deletion
// (lib/storagePath resolveStoragePath). It is also the form the candidate
// pipeline already writes (services/memory/episodeCandidates.ts inserts
// media_assets.public_url, which the upload sets to this same key).

/** The bucket POST /api/media/upload stores into and names first in its answer (routes/posts.ts STORAGE_BUCKET). */
export const UPLOAD_KEY_BUCKET = "post-media";

/**
 * The longest file name admitted. The upload names its object `<ms>.<ext>` and
 * its derivatives `<ms>.thumb.jpg`, `<ms>.feed.jpg`, `<ms>.poster.jpg` — all far
 * shorter. A bound, not a contract: nothing legitimate is near it.
 */
export const UPLOAD_KEY_FILE_MAX = 128;

const UPLOAD_KEY_UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UPLOAD_KEY_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * The uid a bare upload key names when `ref` is EXACTLY
 * `post-media/<lowercase uid>/<file>`, and null for anything else (including
 * every absolute URL, which keeps memoryItemMediaUrlAccepted's rule). Pure;
 * never throws.
 */
export function uploadKeyOwner(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const segs = ref.split("/");
  if (segs.length !== 3) return null;
  const [bucket, uid, file] = segs as [string, string, string];
  if (bucket !== UPLOAD_KEY_BUCKET) return null;
  if (!UPLOAD_KEY_UID_RE.test(uid)) return null;
  if (file.length > UPLOAD_KEY_FILE_MAX || !UPLOAD_KEY_FILE_RE.test(file) || file.includes("..")) return null;
  return uid;
}
