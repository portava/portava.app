/**
 * Memory System routes
 *
 * POST   /memories                       — create a memory
 * GET    /memories/:id                   — get a memory (privacy-gated)
 * PATCH  /memories/:id                   — update (owner only)
 * DELETE /memories/:id                   — soft-delete (owner only)
 *
 * POST   /memories/:id/items             — add item (photo/video)
 * DELETE /memories/:id/items/:itemId     — remove item
 *
 * GET    /memories/:id/tags              — list tags
 * PATCH  /memories/:id/tags/:userId      — approve / remove self-tag
 *
 * POST   /memories/:id/like              — like (idempotent)
 * DELETE /memories/:id/like              — unlike
 * POST   /memories/:id/save              — save (idempotent)
 * DELETE /memories/:id/save              — unsave
 * POST   /memories/:id/share             — log share intent
 *
 * POST   /trips/:tripId/memory           — create-from-trip (owner only)
 * POST   /events/:eventId/memory         — handled in events.ts (stub upgraded below)
 *
 * GET    /users/:userId/memories         — public memory listing for a profile
 * GET    /memories                       — discovery feed (public only)
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { sendPushWithRetry } from "../lib/pushWithRetry.js";
import { nameVisibilitySet, nameVisibleFor } from "../lib/publicIdentity.js";
import { truncateDisplayName } from "../lib/displayName.js";
import { logger } from "../lib/logger.js";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadRestrictiveGems,
  gemCeilingForItem,
  UNDETERMINED_GEM_CEILING,
  type RestrictiveGem,
  type LocationVisibilityTier,
} from "../lib/mediaLocationVisibility.js";
import {
  MEMORY_LOCATION_PRECISIONS,
  normalizeMemoryPrecision,
  normalizeMemoryPrecisionForWrite,
  publicationPrecision,
  resolveMemoryLocationCeiling,
  coarsenMemoryLocation,
} from "../lib/memoryLocationPrecision.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

// ── Hidden-Gem location protection for memory reads (Media v2 P1b) ─────────────
//
// A memory carries an exact location_lat/location_lng that reaches non-owner
// viewers (the public discovery feed, and any shared/visible single memory). If
// that coordinate sits on a protected Hidden Gem it de-anonymizes a location the
// gem guard hides. Memories link to places via canonical_location_id (not the
// gem's canonical_place_id), so the cross-check here is coordinate proximity
// (plus city, to scope the gem load). Owner sees their own memory unchanged.
// Fail-closed: a gem-lookup failure coarsens every non-owner read.

interface MemoryGemContext {
  gems: RestrictiveGem[];
  determined: boolean;
}

async function loadMemoryGemContext(
  db: SupabaseClient,
  rows: any[],
): Promise<MemoryGemContext> {
  try {
    const gems = await loadRestrictiveGems(db, {
      placeIds: [],
      cities: rows.map((r) => r?.location_city ?? null),
    });
    return { gems, determined: true };
  } catch {
    return { gems: [], determined: false };
  }
}

/**
 * Coarsen a raw memory row's location (snake_case) to the STRICTER of two
 * independent ceilings, for a non-owner viewer:
 *
 *   1. the Hidden-Gem ceiling — a property of the PLACE. "Is this coordinate
 *      sitting on a gem whose own guard hides it?" Fail-closed when the gem
 *      status could not be determined.
 *   2. the owner's §10 `location_precision` rung — a property of the OWNER'S
 *      CHOICE. "How precisely may this Memory of mine be published to anyone
 *      who is not me?" Read only when `memory_location_precision_enabled` is
 *      on, because production does not have the column (see migration 2338).
 *
 * These answer different questions and neither subsumes the other: a Memory at
 * an unremarkable address has no gem to protect it, and a Memory on a protected
 * gem is coarsened however permissive its owner's rung is.
 *
 * Owner bypass. Both ceilings absent ⇒ row returned unchanged, which with the
 * flag off is byte-for-byte the pre-2338 behaviour. Operates before mapMemory /
 * enrichMemories so the coarsened values flow through every projection.
 */
function protectMemoryRow(
  row: any,
  ctx: MemoryGemContext,
  viewerId: string,
  precisionEnabled: boolean,
): any {
  if (row?.owner_id === viewerId) return row; // owner sees their own exact
  const lat = row?.location_lat != null ? Number(row.location_lat) : null;
  const lng = row?.location_lng != null ? Number(row.location_lng) : null;
  const gemCeiling: LocationVisibilityTier | null = ctx.determined
    ? gemCeilingForItem(ctx.gems, { placeId: null, lat, lng })
    : UNDETERMINED_GEM_CEILING; // fail-closed
  // Flag off ⇒ 'exact' ⇒ contributes no constraint, so `ceiling` collapses to
  // exactly the gem ceiling and this function is a no-op wherever it was before.
  // Flag on ⇒ the row's rung; a row that does not carry the key, or carries
  // null / a value off the ladder, is clamped to 'hidden' — the read-side
  // normalization that keeps an unreadable policy from being served as 'exact'.
  const ownerPrecision = publicationPrecision(row, precisionEnabled);
  const ceiling = resolveMemoryLocationCeiling(ownerPrecision, gemCeiling);
  if (ceiling == null) return row; // no constraint from either source → unchanged
  const d = coarsenMemoryLocation(row, ceiling);
  return {
    ...row,
    location_city: d.city,
    location_country: d.country,
    location_lat: d.lat, // coarse grid-snapped — never the exact stored coord
    location_lng: d.lng,
  };
}

// ── Feature flag ───────────────────────────────────────────────────────────────

// FL-04: removed the dead memoriesEnabled() helper — it was never called and
// failed OPEN, contradicting the fail-closed isFlagEnabled contract. The Memories
// routes are intentionally ungated (backend is live).

// ── Visibility helpers ─────────────────────────────────────────────────────────

const VISIBILITY_VALUES = ["public", "friends_only", "trip_crew", "circle_only", "only_me", "custom"] as const;
type MemoryVisibility = (typeof VISIBILITY_VALUES)[number];

/**
 * The surface a read is being served on. Spec v1 §23 names the policy function
 * `canReadMemory(userId, memoryId, surface)` — the surface is part of the
 * signature because one verdict must not serve every surface.
 *
 *   "single"      GET /memories/:id — a direct, addressed read. The full
 *                 audience ladder applies: an allow-listed viewer of a `custom`
 *                 Memory, a mutual follower of a `friends_only` one and a crew
 *                 member of a `trip_crew` one may all read it here.
 *   "profile"     GET /users/:userId/memories — same ladder; the viewer asked
 *                 for one named owner.
 *   "trip"        GET /trips/:tripId/memory — same ladder, scoped to a trip.
 *   "public_feed" GET /memories — the discovery surface, and the reason this
 *                 parameter exists. It is a PUBLIC surface: nothing but
 *                 `visibility = 'public'` is admissible on it, no matter what
 *                 relationship the viewer has to the owner. A `custom` Memory
 *                 whose allow-list happens to contain the viewer must not
 *                 appear in a global feed — being permitted to see something
 *                 when you ask for it is not the same as having it pushed at
 *                 you among strangers' content. §10 states the general form:
 *                 canonical storage and public projections are separate, and
 *                 the public surface gets the narrower rule.
 */
export type MemoryReadSurface = "single" | "profile" | "trip" | "public_feed";

/**
 * Spec v1 §23 `canReadMemory(userId, memoryId, surface)`.
 *
 * Determines whether `viewerId` can read a memory row given raw DB data, ON THE
 * NAMED SURFACE. Always returns true for the owner.
 */
async function canReadMemory(
  sc: any,
  memory: any,
  viewerId: string | null,
  surface: MemoryReadSurface,
): Promise<boolean> {
  if (viewerId === memory.owner_id) return true;
  if (memory.state !== "published") return false;

  const vis: MemoryVisibility = memory.visibility ?? "only_me";

  if (vis === "only_me") return false;

  // The public surface admits exactly one visibility class, before any
  // relationship is consulted. Everything below this line is the addressed-read
  // ladder and must not run for the feed.
  if (surface === "public_feed") {
    if (vis !== "public") return false;
    const hiddenOnFeed: string[] = memory.hidden_user_ids ?? [];
    return !(viewerId != null && hiddenOnFeed.includes(viewerId));
  }

  if (!viewerId) return vis === "public";

  // A hidden viewer is denied for EVERY visibility mode. The hide list used to be
  // consulted only in the 'custom' branch, so a user the owner hid could still
  // read the memory when it was public / friends_only / trip_crew / circle_only
  // (audit MEM·M1). Owner already returned true above, so this never self-hides.
  const hidden: string[] = memory.hidden_user_ids ?? [];
  if (hidden.includes(viewerId)) return false;

  if (vis === "public") return true;

  if (vis === "custom") {
    const allowed: string[] = memory.allowed_user_ids ?? [];
    if (allowed.includes(viewerId)) return true;
    return false;
  }

  if (vis === "friends_only") {
    const { data } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", memory.owner_id)
      .eq("following_id", viewerId)
      .maybeSingle();
    if (!data) return false;
    const { data: back } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", viewerId)
      .eq("following_id", memory.owner_id)
      .maybeSingle();
    return Boolean(back);
  }

  if (vis === "trip_crew") {
    if (!memory.trip_id) return false;
    const { data } = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", memory.trip_id)
      .eq("user_id", viewerId)
      .maybeSingle();
    return Boolean(data);
  }

  if (vis === "circle_only") {
    const { data } = await sc
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", memory.owner_id)
      .eq("other_id", viewerId)
      .maybeSingle();
    return Boolean(data);
  }

  return false;
}

/** Check blocks in both directions. Returns true if blocked. */
async function isBlocked(sc: any, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const [r1, r2] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", a).eq("blocked_id", b).maybeSingle(),
    sc.from("blocks").select("blocker_id").eq("blocker_id", b).eq("blocked_id", a).maybeSingle(),
  ]);
  // Fail CLOSED: if either block lookup errors we cannot prove the two users are
  // unblocked, so treat them as blocked. supabase-js resolves (does not throw)
  // on a DB error, so an unchecked error here would silently read as "not
  // blocked" and leak the owner's memory content to a blocked viewer.
  if (r1.error || r2.error) return true;
  return Boolean(r1.data) || Boolean(r2.data);
}

/**
 * The viewer's block set, in both directions, as an explicit result.
 *
 * Fail CLOSED, and the reason it returns a discriminated result rather than a
 * Set is that a Set has no way to say "I could not establish this". supabase-js
 * RESOLVES on a DB error, so `data ?? []` on an errored blocks query yields an
 * EMPTY set — nothing filtered — which reads at the call site exactly like "this
 * viewer has blocked nobody". That is how a transient blocks-table failure
 * turns into a feed that serves blocked owners' content (audit MEM·M6, and
 * §28.11: "never swallow projection/schema failures into plausible-looking
 * empty history without structured error state").
 */
async function loadBlockedIds(
  sc: any,
  viewerId: string,
): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: unknown }> {
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", viewerId),
    sc.from("blocks").select("blocker_id").eq("blocked_id", viewerId),
  ]);
  if (blockedByMe.error || blockingMe.error) {
    return { ok: false, error: blockedByMe.error ?? blockingMe.error };
  }
  return {
    ok: true,
    ids: new Set<string>([
      ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
      ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
    ]),
  };
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const createMemorySchema = z.object({
  title: z.string().max(300).nullable().optional(),
  caption: z.string().max(2000).nullable().optional(),
  visibility: z.enum(VISIBILITY_VALUES).default("friends_only"),
  allowedUserIds: z.array(z.string().uuid()).max(200).optional().default([]),
  hiddenUserIds: z.array(z.string().uuid()).max(200).optional().default([]),
  tripId: z.string().uuid().nullable().optional(),
  eventId: z.string().uuid().nullable().optional(),
  placeId: z.string().max(200).nullable().optional(),
  locationCity: z.string().max(200).nullable().optional(),
  locationCountry: z.string().max(200).nullable().optional(),
  locationLat: z.number().min(-90).max(90).nullable().optional(),
  locationLng: z.number().min(-180).max(180).nullable().optional(),
  canonicalLocationId: z.string().uuid().nullable().optional(),
  // §10 — the owner's ceiling on how precisely this Memory may be published.
  // OPTIONAL, and left undefined the column keeps its DEFAULT 'exact', so a
  // client that has never heard of it creates exactly what it created before.
  locationPrecision: z.enum(MEMORY_LOCATION_PRECISIONS).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  state: z.enum(["draft", "published"]).default("published"),
  taggedUserIds: z.array(z.string().uuid()).max(50).optional().default([]),
});

const patchMemorySchema = z.object({
  title: z.string().max(300).nullable().optional(),
  caption: z.string().max(2000).nullable().optional(),
  visibility: z.enum(VISIBILITY_VALUES).optional(),
  allowedUserIds: z.array(z.string().uuid()).max(200).optional(),
  hiddenUserIds: z.array(z.string().uuid()).max(200).optional(),
  placeId: z.string().max(200).nullable().optional(),
  locationCity: z.string().max(200).nullable().optional(),
  locationCountry: z.string().max(200).nullable().optional(),
  locationLat: z.number().min(-90).max(90).nullable().optional(),
  locationLng: z.number().min(-180).max(180).nullable().optional(),
  canonicalLocationId: z.string().uuid().nullable().optional(),
  locationPrecision: z.enum(MEMORY_LOCATION_PRECISIONS).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  state: z.enum(["draft", "published", "archived"]).optional(),
});

const addItemSchema = z.object({
  mediaUrl: z.string().url(),
  mediaType: z.string().min(1).max(100).default("image/jpeg"),
  caption: z.string().max(500).nullable().optional(),
  position: z.number().int().min(0).default(0),
});

const patchTagSchema = z.object({
  action: z.enum(["approve", "remove"]),
});

// ── Notification helper ────────────────────────────────────────────────────────

async function notifyTagged(sc: any, memory: any, taggedUserId: string): Promise<void> {
  try {
    const { data: owner } = await sc
      .from("profiles")
      .select("name, handle, expo_push_token")
      .eq("id", memory.owner_id)
      .maybeSingle();

    const { data: tagged } = await sc
      .from("profiles")
      .select("expo_push_token")
      .eq("id", taggedUserId)
      .maybeSingle();

    if (tagged?.expo_push_token) {
      const ownerNameAllowed = await nameVisibleFor(sc, memory.owner_id);
      const ownerName = truncateDisplayName(ownerNameAllowed
        ? (owner?.name ?? (owner?.handle ? `@${owner.handle}` : "Someone"))
        : (owner?.handle ? `@${owner.handle}` : "Someone"));
      await sendPushWithRetry(sc, { userId: taggedUserId, tokens: [tagged.expo_push_token] }, {
        title: "You were tagged in a Memory",
        body: `${ownerName} tagged you in a memory. Tap to approve or remove.`,
        data: { screen: "memory", memoryId: memory.id },
      });
    }

    // supabase-js resolves rather than throws on a DB error, so the old
    // `.then(()=>{}).catch(()=>{})` discarded a failed insert silently — and this
    // notification is how the tagged user learns they can approve/remove the tag.
    // Still non-fatal, but a failure is now visible in the server log.
    const { error: notifErr } = await sc.from("notifications").insert({
      user_id: taggedUserId,
      actor_id: memory.owner_id,
      event_type: "trip.memory_tagged",
      category: "trips",
      title: "You were tagged in a Memory",
      body: "Tap to approve or remove the tag.",
      metadata: { memoryId: memory.id, memoryTitle: memory.title },
    });
    if (notifErr) {
      logger.warn({ err: notifErr, taggedUserId, memoryId: memory.id },
        "notifyTagged: notifications insert failed — tagged user not informed in-app");
    }
  } catch (err) {
    // Non-fatal, but observable.
    logger.warn({ err, taggedUserId, memoryId: memory?.id }, "notifyTagged: unexpected error");
  }
}

async function notifyLike(sc: any, memoryId: string, ownerId: string, likerId: string): Promise<void> {
  try {
    if (ownerId === likerId) return;
    const { data: liker } = await sc
      .from("profiles")
      .select("name, handle")
      .eq("id", likerId)
      .maybeSingle();
    const { data: owner } = await sc
      .from("profiles")
      .select("expo_push_token")
      .eq("id", ownerId)
      .maybeSingle();
    if (owner?.expo_push_token) {
      const likerNameAllowed = await nameVisibleFor(sc, likerId);
      const likerName = truncateDisplayName(likerNameAllowed
        ? (liker?.name ?? (liker?.handle ? `@${liker.handle}` : "Someone"))
        : (liker?.handle ? `@${liker.handle}` : "Someone"));
      await sendPushWithRetry(sc, { userId: ownerId, tokens: [owner.expo_push_token] }, {
        title: "New like on your Memory",
        body: `${likerName} liked your memory.`,
        data: { screen: "memory", memoryId },
      });
    }
  } catch {
    // Non-fatal
  }
}

// ── POST /memories ─────────────────────────────────────────────────────────────

router.post("/memories", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const parsed = createMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  // A client may not name a column this database does not have: PostgREST fails
  // the WHOLE insert on an unknown key (PGRST204), so an accepted-but-unwritable
  // field would take Memory creation to 100% failure. With the flag off, a
  // locationPrecision the client sent is dropped — the same posture
  // routes/highlights.ts documents for media_thumbnail_url.
  //
  // `undefined` rather than a conditional spread, deliberately. Measured against
  // the installed @supabase/supabase-js: an undefined property is dropped from
  // the request entirely — it appears neither in the JSON body nor in a
  // `columns=` parameter — so with the flag off this insert is byte-identical on
  // the wire to the pre-2338 one. A spread would have produced the same request
  // but a payload that `src/scripts/checkWritePathColumns.ts` cannot resolve
  // statically, which trades a real guarantee for a cosmetic one: that check is
  // the thing standing between this route and the PGRST204 outage above.
  // Write-side normalization: only an exact ladder value is ever named; anything
  // else leaves the column to its DEFAULT (whose value is the owner's pending
  // decision, not this route's).
  const precisionValue = precisionEnabled ? normalizeMemoryPrecisionForWrite(d.locationPrecision) : undefined;

  const { data: memory, error } = await sc
    .from("memories")
    .insert({
      location_precision: precisionValue,
      owner_id: user.id,
      title: d.title ?? null,
      caption: d.caption ?? null,
      visibility: d.visibility,
      allowed_user_ids: d.allowedUserIds,
      hidden_user_ids: d.hiddenUserIds,
      trip_id: d.tripId ?? null,
      event_id: d.eventId ?? null,
      place_id: d.placeId ?? null,
      location_city: d.locationCity ?? null,
      location_country: d.locationCountry ?? null,
      location_lat: d.locationLat ?? null,
      location_lng: d.locationLng ?? null,
      canonical_location_id: d.canonicalLocationId ?? null,
      starts_at: d.startsAt ?? null,
      ends_at: d.endsAt ?? null,
      state: d.state,
    })
    .select((precisionEnabled ? MEMORY_CREATE_SELECT_WITH_PRECISION : MEMORY_CREATE_SELECT) as any)
    .single();

  if (error) {
    req.log.error({ err: error }, "memories: create failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Tag users if provided
  if (d.taggedUserIds.length > 0) {
    const tagRows = d.taggedUserIds
      .filter((uid) => uid !== user.id)
      .map((uid) => ({
        memory_id: (memory as any).id,
        tagged_user_id: uid,
        status: "pending",
      }));

    if (tagRows.length > 0) {
      await sc.from("memory_tags").insert(tagRows).then(undefined, () => {});
      for (const uid of d.taggedUserIds.filter((u) => u !== user.id)) {
        notifyTagged(sc, memory, uid);
      }
    }
  }

  // Phase 14 — a memory made at a recommended event/place is the strongest
  // realized-outcome signal; link it back to the originating recommendation.
  const outcomeAnchorId = d.eventId ?? d.placeId ?? d.tripId ?? null;
  void linkOutcomeSignal(sc, user.id, outcomeAnchorId, "made_memory", "route:memory_create");

  res.status(201).json({ memory: mapMemory(memory, user.id) });
});

// ── GET /memories (discovery feed) ────────────────────────────────────────────

router.get("/memories", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  // ── Two defects lived in the shape this route used to have ─────────────────
  //
  // 1. `.limit(n)` ran in the DATABASE and the block filter ran afterwards in
  //    TypeScript, so a page silently shrank by however many blocked owners it
  //    happened to contain — request 30, receive 27. And because `nextCursor` is
  //    emitted only when `visible.length === limit`, that shrunken page also
  //    ENDED the feed: one blocked owner anywhere in the first page and the
  //    viewer's discovery feed simply stopped, with more rows behind it.
  //
  // 2. Far worse: the feed never consulted `hidden_user_ids` at all. Every
  //    OTHER read path routes through canReadMemory, whose comment states that
  //    "a hidden viewer is denied for EVERY visibility mode" (audit MEM·M1) —
  //    but the feed did not call it. A user the owner had explicitly hidden
  //    read that owner's public Memories in the global discovery feed. The fix
  //    for MEM·M1 landed inside the helper; the one path that bypassed the
  //    helper never got it.
  //
  // Both are the same architectural mistake, and the spec names it: §10 "public
  // search only queries public derivatives, never private canonical storage
  // followed by post-query filtering", restated as a prohibition in §28.6.
  // Post-query filtering is not merely inelegant — it is how a filter goes
  // missing, because nothing about the query says which predicates are owed.
  //
  // So every privacy predicate now runs INSIDE the query, and LIMIT applies to
  // the already-filtered set. Two ways to do that, and both are here:
  //
  //   • `memory_public_feed_projection_enabled` ON → the §18
  //     PublicMemoryProjection (migration 2338): one RPC, all predicates in
  //     SQL, and a return shape that does not even contain the owner's
  //     allow/hide lists.
  //   • OFF → the PostgREST path below, carrying the same predicates as query
  //     filters. It exists because production has neither the function nor the
  //     column, and the leak had to close there too.
  //
  // Both paths are exercised in src/test/memoriesPublicFeedPrivacy.test.ts, and
  // the derivative's SQL was additionally rehearsed against portava-ci with the
  // five-row fixture (public / only_me / draft / hidden-from-viewer / blocked
  // owner) that it must reduce to one.
  const blockList = await loadBlockedIds(sc, user.id);
  if (!blockList.ok) {
    req.log.error({ err: blockList.error }, "memories: block lookup failed — failing closed");
    sendError(res, "db_error", "Could not resolve block state");
    return;
  }
  const blockedSet = blockList.ids;

  const useProjection = await isFlagEnabled(sc, "memory_public_feed_projection_enabled");

  let rows: any[];
  if (useProjection) {
    const { data, error } = await (sc as any).rpc("memory_public_feed", {
      p_viewer: user.id,
      p_limit: limit,
      p_cursor: cursor,
    });
    if (error) {
      req.log.error({ err: error }, "memories: public feed projection failed");
      sendError(res, "db_error", error.message);
      return;
    }
    rows = (data ?? []) as any[];
  } else {
    let q = sc
      .from("memories")
      .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
      .eq("state", "published")
      .eq("visibility", "public")
      // MEM·M1 on the surface that was missing it: a viewer the owner hid never
      // reaches the feed's result set in the first place.
      .not("hidden_user_ids", "cs", `{${user.id}}`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (blockedSet.size > 0) {
      // Quoted list, matching the established form in this repo
      // (routes/discoverySearch.ts, routes/compassHome.ts): PostgREST accepts a
      // bare uuid, but quoting is what every other `not.in` site here does and
      // it is the form that stays correct if the values ever stop being uuids.
      (q as any) = (q as any).not("owner_id", "in", `(${[...blockedSet].map((b) => `"${b}"`).join(",")})`);
    }
    if (cursor) {
      (q as any) = (q as any).lt("created_at", cursor);
    }

    const { data, error } = await q;
    if (error) {
      req.log.error({ err: error }, "memories: discovery failed");
      sendError(res, "db_error", error.message);
      return;
    }
    rows = (data ?? []) as any[];
  }

  // Defence in depth, not the filter. Every predicate above already ran in the
  // database; this re-asserts the verdict on the public surface so that a
  // future edit to either query cannot reintroduce the leak silently. It can
  // only ever remove rows, never add them, and on a correct query it removes
  // none — which is what the mutation test in memoriesPublicFeedPrivacy asserts.
  const feedChecks = await Promise.all(
    rows.map((m) => canReadMemory(sc, m, user.id, "public_feed")),
  );
  const visibleRaw = rows.filter((m, i) => feedChecks[i] && !blockedSet.has(m.owner_id as string));

  // Location protection (fail-closed): the stricter of the Hidden-Gem ceiling
  // and the owner's §10 precision rung, applied before enrichment/serialization.
  //
  // `|| useProjection` closes a flag-COMBINATION hazard. The derivative always
  // returns `location_precision` (it cannot exist without migration 2338), so a
  // database where someone turned the projection flag on and left the precision
  // flag off would serve rows that carry an owner's narrowed rung while ignoring
  // it — a privacy regression produced by a configuration nobody intended.
  // Neither flag may widen disclosure; only narrow it.
  const clampPrecision = precisionEnabled || useProjection;
  const memoryGemCtx = await loadMemoryGemContext(sc, visibleRaw);
  const visible = visibleRaw.map((m) => protectMemoryRow(m, memoryGemCtx, user.id, clampPrecision));

  const enriched = await enrichMemories(sc, visible, user.id);

  // Batch-fetch saved state for the viewer across these memories
  const memoryIds = visible.map((m: any) => m.id as string);
  const savedMemoryIds = new Set<string>();
  try {
    const { data: userCols } = await sc
      .from("collections")
      .select("id")
      .eq("owner_id", user.id);
    const colIds = ((userCols ?? []) as any[]).map((c) => c.id as string);
    if (colIds.length > 0 && memoryIds.length > 0) {
      const { data: savedItems } = await sc
        .from("collection_items")
        .select("entity_id")
        .eq("entity_type", "memory")
        .in("collection_id", colIds)
        .in("entity_id", memoryIds);
      for (const s of (savedItems ?? []) as any[]) savedMemoryIds.add(s.entity_id as string);
    }
  } catch { /* non-fatal */ }

  res.json({
    memories: (enriched as any[]).map((m: any) => ({ ...m, isSaved: savedMemoryIds.has(m.id as string) })),
    nextCursor: visible.length === limit ? (visible[visible.length - 1]?.created_at ?? null) : null,
  });
});

// ── GET /memories/:id ─────────────────────────────────────────────────────────

const MEMORY_SELECT = "id, owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, starts_at, ends_at, state, created_at, updated_at";

/**
 * The same list plus the §10 precision rung.
 *
 * TWO SELECT CONSTANTS, NOT ONE WITH A CONDITIONAL SUFFIX BUILT AT THE CALL
 * SITE, so that both strings are greppable literals: `check:write-path-columns`
 * resolves string-literal select lists through the AST and would lose sight of
 * a list assembled from fragments, and losing sight of it is precisely how a
 * column reference outlives the migration that created it.
 *
 * Which one a route uses is decided by `memory_location_precision_enabled`, and
 * that flag is a SCHEMA-PRESENCE gate, not a product switch: production has not
 * run migration 2338, and in PostgREST one unknown column fails the WHOLE
 * statement with PGRST100 — a select naming `location_precision` there returns
 * zero rows, not an error anybody sees. Same failure class as migration 0164.
 */
/**
 * POST /memories returns a narrower row than the read paths (no allow/hide
 * lists, no updated_at). Same two-literal rule as MEMORY_SELECT.
 */
const MEMORY_CREATE_SELECT = "id, owner_id, title, caption, visibility, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, starts_at, ends_at, state, created_at";
const MEMORY_CREATE_SELECT_WITH_PRECISION = "id, owner_id, title, caption, visibility, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, location_precision, starts_at, ends_at, state, created_at";

const MEMORY_SELECT_WITH_PRECISION = "id, owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, location_precision, starts_at, ends_at, state, created_at, updated_at";

router.get("/memories/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  const { data: memoryRow, error } = await sc
    .from("memories")
    .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!memoryRow) { sendError(res, "not_found", "Memory not found"); return; }
  // The select list is chosen at runtime (see MEMORY_SELECT_WITH_PRECISION), so
  // the generated row type cannot be resolved statically here.
  const memory = memoryRow as any;

  if (memory.owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, memory.owner_id);
    if (blocked) { sendError(res, "not_found", "Memory not found"); return; }

    const ok = await canReadMemory(sc, memory, user.id, "single");
    if (!ok) { sendError(res, "not_found", "Memory not found"); return; }
  }

  const [items, tags, likeCount, likedByMe, saveCount, savedByMe] = await Promise.all([
    sc.from("memory_items").select("id, media_url, media_type, caption, position, created_at").eq("memory_id", id).order("position"),
    sc.from("memory_tags").select("tagged_user_id, status").eq("memory_id", id),
    sc.from("memory_likes").select("memory_id", { count: "exact", head: true }).eq("memory_id", id),
    sc.from("memory_likes").select("memory_id").eq("memory_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("memory_saves").select("memory_id", { count: "exact", head: true }).eq("memory_id", id),
    sc.from("memory_saves").select("memory_id").eq("memory_id", id).eq("user_id", user.id).maybeSingle(),
  ]);

  const ownerProfile = await sc
    .from("profiles")
    .select("id, name, handle, avatar_url")
    .eq("id", memory.owner_id)
    .maybeSingle();

  const ownerNameAllowed = memory.owner_id === user.id || await nameVisibleFor(sc, memory.owner_id);

  // Location protection (fail-closed) — the stricter of the Hidden-Gem ceiling
  // and the owner's §10 precision rung, for non-owner reads.
  const singleMemoryGemCtx = await loadMemoryGemContext(sc, [memory]);
  const safeMemory = protectMemoryRow(memory, singleMemoryGemCtx, user.id, precisionEnabled);

  res.json({
    memory: {
      ...mapMemory(safeMemory, user.id),
      items: (items.data ?? []).map(mapItem),
      tags: (tags.data ?? []).map((t: any) => ({ userId: t.tagged_user_id, status: t.status })),
      likeCount: likeCount.count ?? 0,
      likedByMe: Boolean(likedByMe.data),
      saveCount: saveCount.count ?? 0,
      savedByMe: Boolean(savedByMe.data),
      owner: ownerProfile.data ? {
        id: (ownerProfile.data as any).id,
        name: ownerNameAllowed ? (ownerProfile.data as any).name : null,
        handle: (ownerProfile.data as any).handle,
        avatarUrl: (ownerProfile.data as any).avatar_url ?? null,
      } : null,
    },
  });
});

// ── PATCH /memories/:id ───────────────────────────────────────────────────────

router.patch("/memories/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const parsed = patchMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  const { data: existing } = await sc
    .from("memories")
    .select("id, owner_id")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (!existing) { sendError(res, "not_found", "Memory not found"); return; }
  if ((existing as any).owner_id !== user.id) { sendError(res, "forbidden", "Not your memory"); return; }

  const patch: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.title !== undefined) patch.title = d.title;
  if (d.caption !== undefined) patch.caption = d.caption;
  if (d.visibility !== undefined) patch.visibility = d.visibility;
  if (d.allowedUserIds !== undefined) patch.allowed_user_ids = d.allowedUserIds;
  if (d.hiddenUserIds !== undefined) patch.hidden_user_ids = d.hiddenUserIds;
  if (d.placeId !== undefined) patch.place_id = d.placeId;
  if (d.locationCity !== undefined) patch.location_city = d.locationCity;
  if (d.locationCountry !== undefined) patch.location_country = d.locationCountry;
  if (d.locationLat !== undefined) patch.location_lat = d.locationLat;
  if (d.locationLng !== undefined) patch.location_lng = d.locationLng;
  if (d.canonicalLocationId !== undefined) patch.canonical_location_id = d.canonicalLocationId;
  // Same schema-presence rule as create: never name the column unless the
  // database has it. See MEMORY_SELECT_WITH_PRECISION.
  if (precisionEnabled && d.locationPrecision !== undefined) {
    const rung = normalizeMemoryPrecisionForWrite(d.locationPrecision);
    if (rung !== undefined) patch.location_precision = rung;
  }
  if (d.startsAt !== undefined) patch.starts_at = d.startsAt;
  if (d.endsAt !== undefined) patch.ends_at = d.endsAt;
  if (d.state !== undefined) patch.state = d.state;
  patch.updated_at = new Date().toISOString();

  const { data, error } = await sc
    .from("memories")
    .update(patch)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
    .single();

  if (error) { req.log.error({ err: error }, "memories: patch failed"); sendError(res, "db_error", error.message); return; }

  res.json({ memory: mapMemory(data, user.id) });
});

// ── DELETE /memories/:id ──────────────────────────────────────────────────────

router.delete("/memories/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("memories")
    .select("id, owner_id")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (!existing) { sendError(res, "not_found", "Memory not found"); return; }
  if ((existing as any).owner_id !== user.id) { sendError(res, "forbidden", "Not your memory"); return; }

  // Soft-delete by design: the memory becomes invisible everywhere (every read
  // path filters `state != 'deleted'`) but the row, its items and their media
  // are retained, e.g. so support can recover an accidental deletion. This is
  // NOT a privacy hole on account deletion: executeAccountDeletion sweeps
  // memories by owner_id with no state filter and removes the items' storage
  // objects, so soft-deleted memories are hard-erased when the account goes
  // (audit MEM·H2).
  await sc
    .from("memories")
    .update({ state: "deleted", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", user.id);

  res.status(204).send();
});

// ── POST /memories/:id/items ──────────────────────────────────────────────────

router.post("/memories/:id/items", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const parsed = addItemSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("memories")
    .select("id, owner_id")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (!existing) { sendError(res, "not_found", "Memory not found"); return; }
  if ((existing as any).owner_id !== user.id) { sendError(res, "forbidden", "Not your memory"); return; }

  const { data, error } = await sc
    .from("memory_items")
    .insert({
      memory_id: id,
      media_url: parsed.data.mediaUrl,
      media_type: parsed.data.mediaType,
      caption: parsed.data.caption ?? null,
      position: parsed.data.position,
    })
    .select("id, media_url, media_type, caption, position, created_at")
    .single();

  if (error) { req.log.error({ err: error }, "memories: add item failed"); sendError(res, "db_error", error.message); return; }

  res.status(201).json({ item: mapItem(data) });
});

// ── DELETE /memories/:id/items/:itemId ───────────────────────────────────────

router.delete("/memories/:id/items/:itemId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id, itemId } = req.params;
  if (!isUuid(id) || !isUuid(itemId)) { sendError(res, "invalid_payload", "Invalid id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("memories")
    .select("id, owner_id")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (!existing) { sendError(res, "not_found", "Memory not found"); return; }
  if ((existing as any).owner_id !== user.id) { sendError(res, "forbidden", "Not your memory"); return; }

  // Fetch the item to get its media_url before deleting
  const { data: item } = await sc
    .from("memory_items")
    .select("id, media_url")
    .eq("id", itemId)
    .eq("memory_id", id)
    .maybeSingle();

  if (!item) { sendError(res, "not_found", "Item not found"); return; }

  // Delete the DB row first so the item is immediately inaccessible
  await sc.from("memory_items").delete().eq("id", itemId).eq("memory_id", id);

  // Delete the storage object — derive path from public URL.
  // URL format: https://<host>/storage/v1/object/public/post-media/<path>
  // Storage path format: memories/{userId}/{filename}
  // Security: only delete objects that begin with the owner's path prefix.
  // media_url is a client-supplied value at insert time, so an adversary could
  // craft a URL pointing to another user's object.  Enforcing the path prefix
  // means only files uploaded by this user (path = `memories/${user.id}/...`) can ever
  // be removed via this code path.
  try {
    const mediaUrl: string = (item as any).media_url ?? "";
    const marker = "/object/public/post-media/";
    const markerIdx = mediaUrl.indexOf(marker);
    if (markerIdx !== -1) {
      const storagePath = mediaUrl.slice(markerIdx + marker.length);
      const ownerPrefix = `memories/${user.id}/`;
      if (storagePath && storagePath.startsWith(ownerPrefix)) {
        await sc.storage.from("post-media").remove([storagePath]);
      } else {
        req.log.warn({ storagePath, userId: user.id }, "memories: storage path does not match owner prefix — skipping delete");
      }
    }
  } catch (storageErr) {
    // Non-fatal: DB row is already gone; log and continue
    req.log.warn({ err: storageErr }, "memories: storage delete failed (item already removed from DB)");
  }

  res.status(204).send();
});

// ── GET /memories/:id/tags ────────────────────────────────────────────────────

router.get("/memories/:id/tags", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memory } = await sc
    .from("memories")
    .select("id, owner_id, visibility, state")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (!memory) { sendError(res, "not_found", "Memory not found"); return; }

  const isOwner = memory.owner_id === user.id;
  const isTagged = !isOwner && (await sc
    .from("memory_tags")
    .select("memory_id")
    .eq("memory_id", id)
    .eq("tagged_user_id", user.id)
    .maybeSingle()
  ).data != null;

  if (!isOwner && !isTagged) {
    const ok = await canReadMemory(sc, memory, user.id, "single");
    if (!ok) { sendError(res, "not_found", "Memory not found"); return; }
  }

  const { data, error } = await sc
    .from("memory_tags")
    .select("tagged_user_id, status, created_at")
    .eq("memory_id", id);

  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ tags: (data ?? []).map((t: any) => ({ userId: t.tagged_user_id, status: t.status, createdAt: t.created_at })) });
});

// ── PATCH /memories/:id/tags/:userId — approve or remove self-tag ────────────

router.patch("/memories/:id/tags/:userId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid id"); return; }

  if (userId !== user.id) {
    sendError(res, "forbidden", "You can only modify your own tag");
    return;
  }

  const parsed = patchTagSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: tag } = await sc
    .from("memory_tags")
    .select("memory_id, tagged_user_id, status")
    .eq("memory_id", id)
    .eq("tagged_user_id", user.id)
    .maybeSingle();

  if (!tag) { sendError(res, "not_found", "Tag not found"); return; }

  const newStatus = parsed.data.action === "approve" ? "approved" : "removed";

  const { error } = await sc
    .from("memory_tags")
    .update({ status: newStatus })
    .eq("memory_id", id)
    .eq("tagged_user_id", user.id);

  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ status: newStatus });
});

// ── POST /memories/:id/like ───────────────────────────────────────────────────

router.post("/memories/:id/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memory } = await sc
    .from("memories")
    .select("id, owner_id, visibility, allowed_user_ids, hidden_user_ids, trip_id, state")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (!memory) { sendError(res, "not_found", "Memory not found"); return; }

  if (memory.owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, memory.owner_id);
    if (blocked) { sendError(res, "not_found", "Memory not found"); return; }
    const ok = await canReadMemory(sc, memory, user.id, "single");
    if (!ok) { sendError(res, "not_found", "Memory not found"); return; }
  }

  const { error } = await sc
    .from("memory_likes")
    .upsert({ memory_id: id, user_id: user.id }, { onConflict: "memory_id,user_id" });

  if (error && (error as any).code !== "23505") {
    sendError(res, "db_error", error.message);
    return;
  }

  const { count } = await sc.from("memory_likes").select("memory_id", { count: "exact", head: true }).eq("memory_id", id);

  notifyLike(sc, id, memory.owner_id, user.id);

  // Phase 14 — link like back to the originating Compass recommendation.
  void linkOutcomeSignal(sc, user.id, id, "liked", "route:memory_like");

  res.json({ likedByMe: true, likeCount: count ?? 0 });
});

// ── DELETE /memories/:id/like ─────────────────────────────────────────────────

router.delete("/memories/:id/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  await sc.from("memory_likes").delete().eq("memory_id", id).eq("user_id", user.id);

  const { count } = await sc.from("memory_likes").select("memory_id", { count: "exact", head: true }).eq("memory_id", id);

  res.json({ likedByMe: false, likeCount: count ?? 0 });
});

// ── POST /memories/:id/save ───────────────────────────────────────────────────

router.post("/memories/:id/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memory } = await sc
    .from("memories")
    .select("id, owner_id, visibility, allowed_user_ids, hidden_user_ids, trip_id, state")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (!memory) { sendError(res, "not_found", "Memory not found"); return; }

  if (memory.owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, memory.owner_id);
    if (blocked) { sendError(res, "not_found", "Memory not found"); return; }
    const ok = await canReadMemory(sc, memory, user.id, "single");
    if (!ok) { sendError(res, "not_found", "Memory not found"); return; }
  }

  const { error } = await sc
    .from("memory_saves")
    .upsert({ memory_id: id, user_id: user.id }, { onConflict: "memory_id,user_id" });

  if (error && (error as any).code !== "23505") {
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ savedByMe: true });
});

// ── DELETE /memories/:id/save ─────────────────────────────────────────────────

router.delete("/memories/:id/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  await sc.from("memory_saves").delete().eq("memory_id", id).eq("user_id", user.id);

  res.json({ savedByMe: false });
});

// ── POST /memories/:id/share ──────────────────────────────────────────────────

router.post("/memories/:id/share", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  res.json({ ok: true });
});

// ── POST /trips/:tripId/memory — create-from-trip ─────────────────────────────

router.post("/trips/:tripId/memory", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: trip } = await sc
    .from("trips")
    .select("id, owner_id, title, destination_city, destination_country, start_date, end_date, status")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the trip owner can create a memory"); return; }

  if ((trip as any).status !== "completed") {
    sendError(res, "forbidden", "Only completed trips can be converted to a memory");
    return;
  }

  const { data: members } = await sc
    .from("trip_members")
    .select("user_id")
    .eq("trip_id", tripId)
    .in("role", ["owner", "member"]);

  const crewIds = ((members ?? []) as any[])
    .map((m) => m.user_id as string)
    .filter((uid) => uid !== user.id);

  const { data: memory, error } = await sc
    .from("memories")
    .insert({
      owner_id: user.id,
      title: (trip as any).title,
      caption: null,
      visibility: "trip_crew",
      allowed_user_ids: [],
      hidden_user_ids: [],
      trip_id: tripId,
      starts_at: (trip as any).start_date ? new Date((trip as any).start_date).toISOString() : null,
      ends_at: (trip as any).end_date ? new Date((trip as any).end_date).toISOString() : null,
      state: "draft",
    })
    .select("id, owner_id, title, caption, visibility, trip_id, starts_at, ends_at, state, created_at")
    .single();

  if (error) { req.log.error({ err: error }, "create-from-trip failed"); sendError(res, "db_error", error.message); return; }

  const memoryId = (memory as any).id;

  if (crewIds.length > 0) {
    const tagRows = crewIds.map((uid) => ({ memory_id: memoryId, tagged_user_id: uid, status: "pending" }));
    await sc.from("memory_tags").insert(tagRows).then(undefined, () => {});

    for (const uid of crewIds) {
      notifyTagged(sc, memory, uid);
    }
  }

  res.status(201).json({ memory: mapMemory(memory, user.id), taggedCount: crewIds.length });
});

// ── GET /trips/:tripId/memory — fetch memory linked to a trip ─────────────────

router.get("/trips/:tripId/memory", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Resolve the trip owner first.  The create-from-trip route (POST /trips/:tripId/memory)
  // requires caller == trip owner, so the canonical trip memory always has owner_id == trip.owner_id.
  // Scoping to that owner prevents an unrelated crew member's trip-linked memory from being surfaced.
  const { data: trip } = await sc
    .from("trips")
    .select("id, owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const tripOwnerId = (trip as any).owner_id as string;

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  const { data: memory, error } = await sc
    .from("memories")
    .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
    .eq("trip_id", tripId)
    .eq("owner_id", tripOwnerId)
    .neq("state", "deleted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) { req.log.error({ err: error }, "trip-memory: query failed"); sendError(res, "db_error", error.message); return; }
  if (!memory) { sendError(res, "not_found", "No memory for this trip"); return; }

  if ((memory as any).owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, (memory as any).owner_id);
    if (blocked) { sendError(res, "not_found", "No memory for this trip"); return; }
    const ok = await canReadMemory(sc, memory, user.id, "trip");
    if (!ok) { sendError(res, "not_found", "No memory for this trip"); return; }
  }

  const memoryId = (memory as any).id;
  const ownerId = (memory as any).owner_id;

  const [coverRow, likeCount, likedByMe, ownerProfile] = await Promise.all([
    sc.from("memory_items").select("media_url, media_type").eq("memory_id", memoryId).eq("position", 0).maybeSingle(),
    sc.from("memory_likes").select("memory_id", { count: "exact", head: true }).eq("memory_id", memoryId),
    sc.from("memory_likes").select("memory_id").eq("memory_id", memoryId).eq("user_id", user.id).maybeSingle(),
    sc.from("profiles").select("id, name, handle, avatar_url").eq("id", ownerId).maybeSingle(),
  ]);

  const ownerNameAllowed = ownerId === user.id || await nameVisibleFor(sc, ownerId);

  // Location protection (fail-closed) — the stricter of the Hidden-Gem ceiling
  // and the owner's §10 precision rung, for non-owner reads.
  const tripMemoryGemCtx = await loadMemoryGemContext(sc, [memory]);
  const safeTripMemory = protectMemoryRow(memory, tripMemoryGemCtx, user.id, precisionEnabled);

  res.json({
    memory: {
      ...mapMemory(safeTripMemory, user.id),
      likeCount: likeCount.count ?? 0,
      likedByMe: Boolean(likedByMe.data),
      cover: coverRow.data ? { mediaUrl: (coverRow.data as any).media_url, mediaType: (coverRow.data as any).media_type } : null,
      owner: ownerProfile.data ? {
        id: (ownerProfile.data as any).id,
        name: ownerNameAllowed ? (ownerProfile.data as any).name : null,
        handle: (ownerProfile.data as any).handle,
        avatarUrl: (ownerProfile.data as any).avatar_url ?? null,
      } : null,
    },
  });
});

// ── GET /users/:userId/memories ───────────────────────────────────────────────

router.get("/users/:userId/memories", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { userId } = req.params;
  if (!isUuid(userId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const isOwnProfile = user.id === userId;

  if (!isOwnProfile) {
    const blocked = await isBlocked(sc, user.id, userId);
    if (blocked) { res.json({ memories: [] }); return; }
  }

  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const precisionEnabled = await isFlagEnabled(sc, "memory_location_precision_enabled");

  let q = sc
    .from("memories")
    .select((precisionEnabled ? MEMORY_SELECT_WITH_PRECISION : MEMORY_SELECT) as any)
    .eq("owner_id", userId)
    .neq("state", "deleted")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!isOwnProfile) {
    (q as any) = (q as any).eq("state", "published");
  }

  if (cursor) {
    (q as any) = (q as any).lt("created_at", cursor);
  }

  const { data, error } = await q;
  if (error) { req.log.error({ err: error }, "user memories failed"); sendError(res, "db_error", error.message); return; }

  const rows = (data ?? []) as any[];

  let visible = rows;
  if (!isOwnProfile) {
    const permChecks = await Promise.all(rows.map((m) => canReadMemory(sc, m, user.id, "profile")));
    visible = rows.filter((_, i) => permChecks[i]);
  }

  const enriched = await enrichMemories(sc, visible, user.id);

  res.json({
    memories: enriched,
    nextCursor: visible.length === limit ? (visible[visible.length - 1]?.created_at ?? null) : null,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapMemory(r: any, viewerId?: string) {
  // The allow/hide lists are the owner's private audience choices — literally the
  // set of user ids they hid this memory FROM. They must never reach another
  // viewer (audit MEM·M2). Fail-safe: only the owner sees them; any caller that
  // does not pass a viewer gets them omitted.
  const isOwner = viewerId != null && viewerId === r.owner_id;
  return {
    id: r.id,
    ownerId: r.owner_id,
    title: r.title ?? null,
    caption: r.caption ?? null,
    visibility: r.visibility,
    ...(isOwner
      ? { allowedUserIds: r.allowed_user_ids ?? [], hiddenUserIds: r.hidden_user_ids ?? [] }
      : {}),
    // §10 location_precision is the OWNER'S publication policy, and like the
    // allow/hide lists it is a private choice about an audience rather than a
    // fact about the Memory: telling a viewer "you are being shown this at city
    // level" discloses that the owner narrowed it for them. Owner only, and
    // omitted entirely when the column was not selected (flag off) so that an
    // absent column never serializes as a fabricated 'exact'.
    ...(isOwner && r.location_precision !== undefined
      ? { locationPrecision: normalizeMemoryPrecision(r.location_precision) }
      : {}),
    tripId: r.trip_id ?? null,
    eventId: r.event_id ?? null,
    placeId: r.place_id ?? null,
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    locationLat: r.location_lat != null ? Number(r.location_lat) : null,
    locationLng: r.location_lng != null ? Number(r.location_lng) : null,
    canonicalLocationId: r.canonical_location_id ?? null,
    startsAt: r.starts_at ?? null,
    endsAt: r.ends_at ?? null,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
  };
}

function mapItem(r: any) {
  return {
    id: r.id,
    mediaUrl: r.media_url,
    mediaType: r.media_type,
    caption: r.caption ?? null,
    position: r.position,
    createdAt: r.created_at,
  };
}

async function enrichMemories(sc: any, rows: any[], viewerId: string) {
  if (rows.length === 0) return [];

  const ids = rows.map((m) => m.id as string);
  const ownerIds = [...new Set(rows.map((m) => m.owner_id as string))];

  const [likeRows, savedRows, coverRows, ownerRows, allowedNames] = await Promise.all([
    sc.from("memory_likes").select("memory_id, user_id").in("memory_id", ids),
    sc.from("memory_saves").select("memory_id").eq("user_id", viewerId).in("memory_id", ids),
    sc.from("memory_items")
      .select("memory_id, media_url, media_type")
      .in("memory_id", ids)
      .eq("position", 0),
    sc.from("profiles").select("id, name, handle, avatar_url").in("id", ownerIds),
    nameVisibilitySet(sc, ownerIds),
  ]);

  const likeCounts: Record<string, number> = {};
  const likedByMeSet = new Set<string>();
  for (const r of (likeRows.data ?? []) as any[]) {
    likeCounts[r.memory_id] = (likeCounts[r.memory_id] ?? 0) + 1;
    if (r.user_id === viewerId) likedByMeSet.add(r.memory_id);
  }

  const savedSet = new Set<string>((savedRows.data ?? []).map((r: any) => r.memory_id as string));
  const coverMap: Record<string, { mediaUrl: string; mediaType: string }> = {};
  for (const r of (coverRows.data ?? []) as any[]) {
    coverMap[r.memory_id] = { mediaUrl: r.media_url, mediaType: r.media_type };
  }

  const ownerMap: Record<string, { id: string; name: string | null; handle: string | null; avatarUrl: string | null }> = {};
  for (const r of (ownerRows.data ?? []) as any[]) {
    const nameAllowed = r.id === viewerId || allowedNames.has(r.id as string);
    ownerMap[r.id] = { id: r.id, name: nameAllowed ? r.name : null, handle: r.handle, avatarUrl: r.avatar_url ?? null };
  }

  return rows.map((m) => ({
    ...mapMemory(m, viewerId),
    likeCount: likeCounts[m.id] ?? 0,
    likedByMe: likedByMeSet.has(m.id),
    savedByMe: savedSet.has(m.id),
    cover: coverMap[m.id] ?? null,
    owner: ownerMap[m.owner_id] ?? null,
  }));
}

export default router;
