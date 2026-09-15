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
