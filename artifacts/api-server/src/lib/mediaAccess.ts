/**
 * mediaAccess — SERVER-side authorization for media BYTES (bucket privacy).
 *
 * The audit's #1 finding: every media bucket is public-read, so row-level
 * visibility/block gating controls who gets a URL while the bytes stay
 * world-readable. This module is the object-layer fix: given a viewer and a
 * (bucket, path), decide whether that viewer may fetch the file — by resolving
 * what entity references it and reusing the SAME rules the rows enforce
 * (owner, blocks fail-closed, visibility, membership).
 *
 * DENY BY DEFAULT: an object nothing references (orphan/unknown) is denied.
 * The matrix is deliberately conservative — where an entity's sharing model is
 * richer than what's implemented here (circle/custom story lists, memory
 * sharing), non-owners are denied rather than guessed at.
 *
 * Used by GET /api/media/file/* which serves a 302 to a short-lived
 * signed URL (both buckets are PRIVATE).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchBlockedSet } from "./blocks.js";
import { resolveProfileVisibility } from "./profileVisibility.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Branches 3a–3g decide access by looking the object up in a table: a row means
 * "this entity publishes the object, apply its rules", no row means "nothing
 * here references it, try the next branch". A REJECTED query — a renamed column,
 * a table not yet migrated, a malformed `or()` filter — returns
 * `{ data: null, error }` rather than throwing, so it reads as the second case
 * exactly, the branch falls through, and §4 denies with no trace.
 *
 * The deny is the safe outcome and is deliberately left alone. What is not safe
 * is that it is indistinguishable from a policy deny: the incident recorded in
 * the urlForms comment below — three live public posts whose media loaded for
 * their owner and for nobody else — is this failure seen from the outside, and
 * nothing in the logs said so. Binding the error costs nothing and makes the
 * next occurrence diagnosable.
 */
function noteLookupFailure(
  branch: string,
  error: unknown,
  ctx: Record<string, unknown>,
): void {
  if (!error) return;
  console.warn(
    `mediaAccess: ${branch} lookup failed — this branch cannot decide and access falls through to deny`,
    { ...ctx, code: (error as any)?.code, message: (error as any)?.message },
  );
}

/** Per-(viewer,object) allow-cache — media loads burst per screen. */
const ALLOW_TTL_MS = 60_000;
const allowCache = new Map<string, number>();
export function _clearMediaAccessCache(): void { allowCache.clear(); }

export function publicUrlFor(bucket: string, path: string): string | null {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  return `${new URL(base).origin}/storage/v1/object/public/${bucket}/${path}`;
}

/** Owner uid implied by our path conventions, or null. */
export function ownerFromPath(path: string): string | null {
  const segs = path.split("/");
  if (UUID_RE.test(segs[0] ?? "")) return segs[0];
  if (
    (segs[0] === "stories" ||
      segs[0] === "memories" ||
      segs[0] === "avatars" ||
      segs[0] === "covers") &&
    UUID_RE.test(segs[1] ?? "")
  )
    return segs[1];
  return null;
}

async function isCloseFriend(
  sc: SupabaseClient,
  ownerId: string,
  viewerId: string,
): Promise<boolean> {
  try {
    // `close_friends` is keyed (owner_id, friend_user_id). There is no
    // `user_id` and no `friend_id` column, so this read raised 42703 and the
    // catch below turned it into `false` — EVERY close-friends story denied its
    // own close friends, and the failure was a media AUTHORIZATION outcome, not
    // an empty list. Columns copied verbatim from routes/stories.ts:46-50,
    // which has always spelled them correctly.
    const { data } = await sc
      .from("close_friends")
      .select("friend_user_id")
      .eq("owner_id", ownerId)
      .eq("friend_user_id", viewerId)
      .maybeSingle();
    return Boolean(data);
  } catch { return false; }
}

async function isTripMember(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
): Promise<boolean> {
  try {
    const [{ data: t }, { data: m }] = await Promise.all([
      sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
      sc
        .from("trip_members")
        .select("user_id")
        .eq("trip_id", tripId)
        .eq("user_id", viewerId)
        .in("role", ["owner", "member"])
        .maybeSingle(),
    ]);
    return (t as any)?.owner_id === viewerId || Boolean(m);
  } catch { return false; }
}

function postVisible(post: any, viewerId: string): "allow" | "deny" | "trip" {
  if (post.status && post.status !== "active") return "deny";
  // Delayed-publish gate (audit 1e): unpublished post media is owner-only.
  if (post.post_status && post.post_status !== "published") return "deny";
  if (post.author_id === viewerId) return "allow";
  if (post.visibility === "public") return "allow";
  if (post.visibility === "trip_only" && post.trip_id) return "trip";
  return "deny"; // private + anything richer → conservative deny
}

/**
 * May `viewerId` fetch the bytes at (bucket, path)? Fail-closed everywhere:
 * unknown object, unreadable block list, or unmodeled sharing → deny.
 */
export async function authorizeMediaAccess(
  sc: SupabaseClient,
  viewerId: string,
  bucket: string,
  path: string,
): Promise<boolean> {
  const cacheKey = `${viewerId}:${bucket}/${path}`;
  const hit = allowCache.get(cacheKey);
  if (hit && Date.now() - hit < ALLOW_TTL_MS) return true;

  const allow = await decide(sc, viewerId, bucket, path);
  if (allow) allowCache.set(cacheKey, Date.now());
  if (allowCache.size > 5000) {
    const oldest = allowCache.keys().next().value as string | undefined;
    if (oldest) allowCache.delete(oldest);
  }
  return allow;
}

async function decide(
  sc: SupabaseClient,
  viewerId: string,
  bucket: string,
  path: string,
): Promise<boolean> {
  // ── profile-media: avatars and cover photos ────────────────────────────────
  // Previously universally visible; now gated by the profile's own visibility
  // settings (private profile → followers/friends only; blocked → deny).
  if (bucket === "profile-media") {
    const owner = ownerFromPath(path);
    if (!owner) return false; // can't determine owner → deny
    if (owner === viewerId) return true; // own media always allowed

    // Block check — fail-closed (null = DB error → deny).
    const blocked = await fetchBlockedSet(sc, viewerId);
    if (blocked === null) return false;
    if (blocked.has(owner)) return false;

    // Profile visibility — fail-closed on missing profile.
    try {
      const { data: profile } = await sc
        .from("profiles")
        .select("is_private, passport_visibility, account_status, show_profile_picture_publicly")
        .eq("id", owner)
        .maybeSingle();
      if (!profile) return false;
      const { visibility } = await resolveProfileVisibility(
        sc,
        viewerId,
        owner,
        profile as any,
      );
      // "full" and "followers_only" both grant access to media bytes by default.
      if (!(visibility === "full" || visibility === "followers_only")) return false;

      // Additional gate for avatar paths when the owner has opted out of public
      // photo display. Only public-profile strangers are blocked — viewers who
      // reached this point via an authorized private-profile relationship (follower
      // or friend) are always allowed.
      if (
        path.startsWith("avatars/") &&
        (profile as any).show_profile_picture_publicly === false
      ) {
        // Private-profile viewers: resolveProfileVisibility already proved a direct
        // follow/friend relationship → allow the avatar.
        if ((profile as any).is_private) return true;

        // Public-profile viewers: "full" visibility can be granted to strangers;
        // check for an explicit follow or friendship instead.
        const [followRes, friendResA, friendResB] = await Promise.all([
          // `user_follows` is (follower_id, following_id, created_at) — it has
          // no `id` column, so selecting one raised 42703 and this arm always
          // resolved to `{ data: null }`: a plain follower was wrongly denied
          // the owner's avatar unless a user_friendships row happened to exist.
          // `follower_id` is the column lib/profileVisibility.ts:156 selects
          // for the identical existence check.
          sc.from("user_follows").select("follower_id")
            .eq("follower_id", viewerId).eq("following_id", owner)
            .maybeSingle().then(undefined, () => ({ data: null })),
          sc.from("user_friendships").select("user_a")
            .eq("user_a", viewerId).eq("user_b", owner)
            .maybeSingle().then(undefined, () => ({ data: null })),
          sc.from("user_friendships").select("user_a")
            .eq("user_a", owner).eq("user_b", viewerId)
            .maybeSingle().then(undefined, () => ({ data: null })),
        ]);
        return followRes.data !== null || friendResA.data !== null || friendResB.data !== null;
      }

      return true;
    } catch {
      return false; // fail-closed
    }
  }

  if (bucket !== "post-media") return false;

  // 1. Owner always sees their own bytes.
  const pathOwner = ownerFromPath(path);
  if (pathOwner === viewerId) return true;

  let owner = pathOwner;
  try {
    const { data: asset, error: assetErr } = await sc
      .from("media_assets")
      .select("owner_user_id")
      .eq("storage_bucket", bucket)
      .eq("storage_path", path)
      .maybeSingle();
    // A rejected read leaves `owner` as the PATH owner — a weaker attribution
    // that makes branches 3d/3e deny outright ("cannot attribute the object").
    noteLookupFailure("media_assets owner", assetErr, { bucket, path });
    if ((asset as any)?.owner_user_id) {
      owner = (asset as any).owner_user_id;
      if (owner === viewerId) return true;
    }
  } catch { /* canonical layer may be dark — path owner still applies */ }

  // 2. Blocks, both directions, fail-closed.
  if (owner) {
    const blocked = await fetchBlockedSet(sc, viewerId);
    if (blocked === null) return false;
    if (blocked.has(owner)) return false;
  }

  const publicUrl = publicUrlFor(bucket, path);
  if (!publicUrl) return false;

  /**
   * EVERY SPELLING OF THIS ONE OBJECT.
   *
   * Branches 3b–3f below decide access by finding the object's URL in a column.
   * They used to match `publicUrl` alone — the absolute
   * `<origin>/storage/v1/object/public/<bucket>/<path>` form — because that is
   * what upload paths used to store.
   *
   * The durable columns have since been canonicalized to the BARE KEY
   * (`<bucket>/<path>`) by 2081_canonicalize_absolute_storage_urls.sql, and the
   * upload endpoints already returned that form after the bucket-privacy
   * cutover. A lookup that knows only the absolute form stops matching those
   * rows, every branch falls through, and §4 denies. That is not a theoretical
   * risk: rewriting posts.media_urls made exactly that happen to three live
   * public posts, whose media then loaded for their owner (branch 1, path-owner
   * shortcut) and for nobody else.
   *
   * THIS DOES NOT WIDEN AUTHORIZATION. Both spellings denote the same
   * (bucket, path) pair — the pair this function was called with and has
   * already block-checked. Matching more spellings of the caller's own argument
   * cannot authorize a different object; it can only stop failing to recognise
   * this one. The set of objects reachable is unchanged; the set of column
   * encodings recognised is what grows.
   *
   * Both forms are kept rather than the new one alone: a database where 2081
   * has not been applied still holds absolute URLs, and this file must be
   * correct on both.
   */
  const bareKey = `${bucket}/${path}`;
  const urlForms = [publicUrl, bareKey];
  /** PostgREST `in.(…)` list — values are quoted and commas escaped. */
  const inList = `(${urlForms.map((u) => `"${u.replace(/"/g, '\\"')}"`).join(",")})`;

  // 3a. Postcard media (post_media.storage_path → parent post rules).
  try {
    const { data: pm, error: pmErr } = await sc
      .from("post_media")
      .select("post_id, moderation_status, processing_status")
      .eq("storage_path", path)
      .maybeSingle();
    noteLookupFailure("3a post_media", pmErr, { bucket, path });
    if (pm) {
      if (
        (pm as any).moderation_status === "rejected" ||
        (pm as any).moderation_status === "flagged"
      )
        return false;
      const { data: post, error: postErr } = await sc
        .from("posts")
        .select("author_id, visibility, status, post_status, trip_id")
        .eq("id", (pm as any).post_id)
        .maybeSingle();
      // Here the deny is returned, not fallen through: a rejected read denies
      // the object as firmly as a deleted parent post does.
      noteLookupFailure("3a parent post", postErr, { bucket, path, postId: (pm as any).post_id });
      if (!post) return false;
      // Only a post that OWNS the object may authorize it via post rules. If this
      // post_media row points at an object owned by someone else (or ownership
      // can't be attributed), the post has no authority to publish it — fall
      // through to the other branches (it may be legitimately reachable as e.g. a
      // generated_visual, and if not, §4 denies). This is the trap branches 3d/3e
      // already guard against.
      if (owner && owner === (post as any).author_id) {
        const v = postVisible(post, viewerId);
        if (v === "allow") return true;
        if (v === "trip") return isTripMember(sc, (post as any).trip_id, viewerId);
        return false;
      }
    }
  } catch { /* fall through */ }

  // 3b. Regular post media (posts.media_urls array contains the public URL).
  try {
    const { data: posts, error: postsErr } = await sc
      .from("posts")
      .select("author_id, visibility, status, post_status, trip_id")
      .overlaps("media_urls", urlForms)
      .limit(1);
    noteLookupFailure("3b posts.media_urls", postsErr, { bucket, path });
    const post = (posts as any[])?.[0];
    // Found BY media_urls, so the post claiming the object is also the row
    // publishing it. Only decide here when the post's author OWNS the object, or
    // any user could put a victim's private storage key in their own public
    // post's media_urls and read the victim's bytes (mirrors the 3d/3e story /
    // highlight hardening). On a mismatch (or unknown owner) fall through — the
    // object may be legitimately reachable via a later branch, else §4 denies.
    if (post && owner && owner === post.author_id) {
      const v = postVisible(post, viewerId);
      if (v === "allow") return true;
      if (v === "trip") return isTripMember(sc, post.trip_id, viewerId);
      return false;
    }
  } catch { /* fall through */ }

  // 3c. Message media → thread membership.
  try {
    const { data: msgs, error: msgsErr } = await sc
      .from("messages")
      .select("thread_id")
      .or(`media_url.in.${inList},media_thumbnail_url.in.${inList}`)
      .limit(1);
    noteLookupFailure("3c messages", msgsErr, { bucket, path });
    const msg = (msgs as any[])?.[0];
    if (msg) {
      const { data: member, error: memberErr } = await sc
        .from("message_thread_members")
        .select("user_id")
        .eq("thread_id", msg.thread_id)
        .eq("user_id", viewerId)
        .is("left_at", null)
        .maybeSingle();
      // Returned directly: an unreadable membership table denies a member's own
      // thread media exactly as it denies a non-member's.
      noteLookupFailure("3c thread membership", memberErr, { bucket, path, threadId: msg.thread_id });
      return Boolean(member);
    }
  } catch { /* fall through */ }

  // 3d. Story media — active + public, or close-friends when viewer qualifies.
  //     Richer lists (friends_only/circle/trip_crew/custom) → conservative deny.
  try {
    const { data: stories, error: storiesErr } = await sc
      .from("stories")
      .select("owner_id, state, visibility, close_friends_only, expires_at")
      .in("media_url", urlForms)
      .limit(1);
    noteLookupFailure("3d stories", storiesErr, { bucket, path });
    const story = (stories as any[])?.[0];
    if (story) {
      // The story is found BY media_url, so the row claiming "this is my media"
      // is the same row deciding whether to publish it. Require the OBJECT's
      // owner to be the STORY's owner, or a public story pointing at another
      // user's key republishes their bytes on its own authority. `owner` here is
      // the canonical media_assets owner when that layer is lit, falling back to
      // the path owner (§1 above). Null → cannot attribute the object → deny,
      // matching this file's posture everywhere else.
      //
      // POST /stories now rejects such a row at write time. This covers rows
      // written before that guard existed, and any future writer that skips it.
      if (!owner || owner !== story.owner_id) return false;
      const live =
        (story.state === "active" || story.state === "saved") &&
        (!story.expires_at ||
          new Date(story.expires_at).getTime() > Date.now() ||
          story.state === "saved");
      if (!live) return false;
      const needsClose =
        story.close_friends_only === true ||
        story.visibility === "close_friends";
      if (needsClose)
        return isCloseFriend(sc, story.owner_id, viewerId);
      return story.visibility === "public";
    }
  } catch { /* fall through */ }

  // 3e. Highlight media — public + unexpired.
  try {
    const { data: hs, error: hsErr } = await sc
      .from("highlights")
      .select("owner_id, visibility, expires_at")
      .in("media_url", urlForms)
      .limit(1);
    noteLookupFailure("3e highlights", hsErr, { bucket, path });
    const h = (hs as any[])?.[0];
    if (h) {
      // Same trap as the story branch (3d): the highlight is found BY media_url,
      // so the row claiming the media is also the row publishing it. Require the
      // OBJECT's owner to be the HIGHLIGHT's owner, or a public highlight pointing
      // at another user's key republishes their private bytes on its own
      // authority. Null owner → cannot attribute → deny.
      if (!owner || owner !== h.owner_id) return false;
      if (h.expires_at && new Date(h.expires_at).getTime() <= Date.now())
        return false;
      return h.visibility === "public";
    }
  } catch { /* fall through */ }

  // 3f. Trip cover (user-uploaded) — trip member (owner handled above).
  try {
    const { data: trips, error: tripsErr } = await sc
      .from("trips")
      .select("id")
      .in("cover_url", urlForms)
      .limit(1);
    noteLookupFailure("3f trips.cover_url", tripsErr, { bucket, path });
    const trip = (trips as any[])?.[0];
    if (trip) return isTripMember(sc, trip.id, viewerId);
  } catch { /* fall through */ }

  // 3g. AI-generated visual (hero/card/thumbnail/share) stored as a storage
  //     path (not a public URL) — path is matched against generated_visuals
  //     path columns.  Entity-level visibility rules apply.
  try {
    const { data: gvs } = await sc
      .from("generated_visuals")
      .select("entity_type, entity_id, owner_user_id, status")
      .or(
        [
          `hero_path.eq.${path}`,
          `card_path.eq.${path}`,
          `thumbnail_path.eq.${path}`,
          `share_path.eq.${path}`,
          `storage_path.eq.${path}`,
        ].join(","),
      )
      .eq("status", "ready")
      .limit(1);
    const gv = (gvs as any[])?.[0];
    if (gv) {
      if (gv.owner_user_id === viewerId) return true;
      if (gv.entity_type === "place") {
        // Discovery places are publicly viewable.
        return true;
      }
      if (gv.entity_type === "event") {
        const { data: ev } = await sc
          .from("events")
          .select("host_id, visibility, state")
          .eq("id", gv.entity_id)
          .maybeSingle();
        if (!ev) return false;
        const hostId = (ev as any).host_id as string;
        if (hostId === viewerId) return true;
        // Block check against host — fail-closed.
        // ownerFromPath() returns null for generated-visual paths, so the global
        // block gate above was skipped; we must enforce it here explicitly.
        const evBlocked = await fetchBlockedSet(sc, viewerId);
        if (evBlocked === null) return false;
        if (evBlocked.has(hostId)) return false;
        if (
          (ev as any).visibility === "public" &&
          !["draft", "cancelled", "archived"].includes((ev as any).state)
        )
          return true;
        // Non-public event: allow only eligible RSVP statuses and non-banned roles.
        const [rsvp, role] = await Promise.all([
          sc
            .from("event_rsvps")
            .select("status")
            .eq("event_id", gv.entity_id)
            .eq("user_id", viewerId)
            .in("status", ["going", "maybe"])
            .maybeSingle(),
          sc
            .from("event_roles")
            .select("role")
            .eq("event_id", gv.entity_id)
            .eq("user_id", viewerId)
            .in("role", ["host", "co_host", "moderator"])
            .maybeSingle(),
        ]);
        return !!(rsvp as any).data || !!(role as any).data;
      }
      if (gv.entity_type === "trip") {
        // Fetch owner for block check — ownerFromPath() returns null for
        // generated-visual paths so the global gate above was skipped.
        const { data: tr } = await sc
          .from("trips")
          .select("owner_id")
          .eq("id", gv.entity_id)
          .maybeSingle();
        if (!tr) return false;
        const tripOwnerId = (tr as any).owner_id as string;
        if (tripOwnerId === viewerId) return true;
        const trBlocked = await fetchBlockedSet(sc, viewerId);
        if (trBlocked === null) return false;
        if (trBlocked.has(tripOwnerId)) return false;
        return isTripMember(sc, gv.entity_id, viewerId);
      }
      return false;
    }
  } catch { /* fall through */ }

  // 4. Nothing references it → orphan/unknown → DENY (fail-closed).
  return false;
}
