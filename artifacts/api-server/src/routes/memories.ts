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

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

// ── Feature flag ───────────────────────────────────────────────────────────────

// FL-04: removed the dead memoriesEnabled() helper — it was never called and
// failed OPEN, contradicting the fail-closed isFlagEnabled contract. The Memories
// routes are intentionally ungated (backend is live).

// ── Visibility helpers ─────────────────────────────────────────────────────────

const VISIBILITY_VALUES = ["public", "friends_only", "trip_crew", "circle_only", "only_me", "custom"] as const;
type MemoryVisibility = (typeof VISIBILITY_VALUES)[number];

/**
 * Determines whether `viewerId` can read a memory row given raw DB data.
 * Always returns true for the owner.
 */
async function canViewMemory(
  sc: any,
  memory: any,
  viewerId: string | null,
): Promise<boolean> {
  if (viewerId === memory.owner_id) return true;
  if (memory.state !== "published") return false;

  const vis: MemoryVisibility = memory.visibility ?? "only_me";

  if (vis === "only_me") return false;

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

  const { data: memory, error } = await sc
    .from("memories")
    .insert({
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
    .select("id, owner_id, title, caption, visibility, trip_id, event_id, place_id, location_city, location_country, location_lat, location_lng, canonical_location_id, starts_at, ends_at, state, created_at")
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

  let q = sc
    .from("memories")
    .select(MEMORY_SELECT)
    .eq("state", "published")
    .eq("visibility", "public")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    (q as any) = (q as any).lt("created_at", cursor);
  }

  const { data, error } = await q;
  if (error) {
    req.log.error({ err: error }, "memories: discovery failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const rows = (data ?? []) as any[];

  // Filter blocks. Fail CLOSED: if either block lookup errors we cannot build a
  // trustworthy block set, so we must not serve a feed that could include
  // blocked owners' memories. (data ?? [] on an errored query yields an empty
  // set → nothing filtered → blocked content leaks; guard the error explicitly.)
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
    sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
  ]);
  if (blockedByMe.error || blockingMe.error) {
    req.log.error(
      { err: blockedByMe.error ?? blockingMe.error },
      "memories: block lookup failed — failing closed",
    );
    sendError(res, "db_error", "Could not resolve block state");
    return;
  }
  const blockedSet = new Set<string>([
    ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
    ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
  ]);

  const visible = rows.filter((m) => !blockedSet.has(m.owner_id as string));

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

router.get("/memories/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memory, error } = await sc
    .from("memories")
    .select(MEMORY_SELECT)
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!memory) { sendError(res, "not_found", "Memory not found"); return; }

  if (memory.owner_id !== user.id) {
    const blocked = await isBlocked(sc, user.id, memory.owner_id);
    if (blocked) { sendError(res, "not_found", "Memory not found"); return; }

    const ok = await canViewMemory(sc, memory, user.id);
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

  res.json({
    memory: {
      ...mapMemory(memory, user.id),
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
  if (d.startsAt !== undefined) patch.starts_at = d.startsAt;
  if (d.endsAt !== undefined) patch.ends_at = d.endsAt;
  if (d.state !== undefined) patch.state = d.state;
  patch.updated_at = new Date().toISOString();

  const { data, error } = await sc
    .from("memories")
    .update(patch)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select(MEMORY_SELECT)
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
    const ok = await canViewMemory(sc, memory, user.id);
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
    const ok = await canViewMemory(sc, memory, user.id);
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
    const ok = await canViewMemory(sc, memory, user.id);
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

  const { data: memory, error } = await sc
    .from("memories")
    .select(MEMORY_SELECT)
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
    const ok = await canViewMemory(sc, memory, user.id);
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

  res.json({
    memory: {
      ...mapMemory(memory, user.id),
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

  let q = sc
    .from("memories")
    .select(MEMORY_SELECT)
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
    const permChecks = await Promise.all(rows.map((m) => canViewMemory(sc, m, user.id)));
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
