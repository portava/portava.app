/**
 * Collections & Saves routes
 *
 * Collections (private, owner-only):
 *   GET    /api/users/me/collections              — list user's collections
 *   POST   /api/users/me/collections              — create collection
 *   PATCH  /api/users/me/collections/:id          — rename / reorder / set cover
 *   DELETE /api/users/me/collections/:id          — delete collection (cascade items)
 *   GET    /api/users/me/collections/:id/items    — paginated items in a collection
 *
 * Unified saves:
 *   POST   /api/saves                             — save item to default or chosen collection
 *   DELETE /api/saves                             — unsave item (from all collections)
 *   GET    /api/users/me/saves                    — check saved state for a specific item
 *   GET    /api/users/me/saved-hashtags           — list saved hashtags
 *
 * Privacy: saves are fully private — content owners are NEVER notified.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isUuid } from "../lib/followDecisions.js";

const router = Router();

const VALID_ENTITY_TYPES = [
  "post", "event", "trip", "memory", "highlight",
  "place", "profile", "hashtag",
] as const;
type EntityType = typeof VALID_ENTITY_TYPES[number];

function isValidEntityType(v: unknown): v is EntityType {
  return typeof v === "string" && (VALID_ENTITY_TYPES as readonly string[]).includes(v);
}

function isValidUuid(v: unknown): v is string {
  return typeof v === "string" && isUuid(v);
}

type EnsureDefaultResult =
  | { id: string }
  | { code: "collection_create_failed"; detail: string };

/** Ensure a default "Saved" collection exists and return its id. */
async function ensureDefaultCollection(sc: any, userId: string): Promise<EnsureDefaultResult> {
  const { data: existing } = await sc
    .from("collections")
    .select("id")
    .eq("owner_id", userId)
    .eq("is_default", true)
    .maybeSingle();

  if (existing) return { id: (existing as any).id as string };

  const { data: created, error } = await sc
    .from("collections")
    .insert({ owner_id: userId, name: "Saved", is_default: true, position: 0 })
    .select("id")
    .single();

  if (error || !created) {
    return {
      code: "collection_create_failed",
      detail: error?.message ?? "Default collection insert returned no data",
    };
  }
  return { id: (created as any).id as string };
}

// =============================================================================
// GET /users/me/collections
// =============================================================================
router.get("/users/me/collections", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("collections")
    .select("id, name, cover_url, position, is_default, created_at, updated_at")
    .eq("owner_id", user.id)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    req.log.error({ err: error }, "collections list failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Attach item count per collection
  const ids = (data ?? []).map((c: any) => c.id as string);
  let countMap: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: counts } = await sc
      .from("collection_items")
      .select("collection_id")
      .in("collection_id", ids);
    for (const row of (counts ?? []) as any[]) {
      countMap[row.collection_id] = (countMap[row.collection_id] ?? 0) + 1;
    }
  }

  res.json({
    collections: (data ?? []).map((c: any) => ({
      id:        c.id as string,
      name:      c.name as string,
      coverUrl:  (c.cover_url as string | null) ?? null,
      position:  c.position as number,
      isDefault: c.is_default as boolean,
      itemCount: countMap[c.id as string] ?? 0,
      createdAt: c.created_at as string,
      updatedAt: c.updated_at as string,
    })),
  });
});

// =============================================================================
// POST /users/me/collections
// =============================================================================
router.post("/users/me/collections", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { name, coverUrl } = (req.body ?? {}) as { name?: unknown; coverUrl?: unknown };
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 120) {
    sendError(res, "invalid_payload", "name is required (max 120 chars)");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Compute next position
  const { data: existing } = await sc
    .from("collections")
    .select("position")
    .eq("owner_id", user.id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextPos = existing ? (existing as any).position + 1 : 1;

  const { data, error } = await sc
    .from("collections")
    .insert({
      owner_id:  user.id,
      name:      name.trim(),
      cover_url: typeof coverUrl === "string" ? coverUrl : null,
      position:  nextPos,
      is_default: false,
    })
    .select("id, name, cover_url, position, is_default, created_at, updated_at")
    .single();

  if (error || !data) {
    req.log.error({ err: error }, "collection create failed");
    sendError(res, "db_error", error?.message ?? "Failed to create collection");
    return;
  }

  const c = data as any;
  res.status(201).json({
    collection: {
      id:        c.id as string,
      name:      c.name as string,
      coverUrl:  (c.cover_url as string | null) ?? null,
      position:  c.position as number,
      isDefault: c.is_default as boolean,
      itemCount: 0,
      createdAt: c.created_at as string,
      updatedAt: c.updated_at as string,
    },
  });
});

// =============================================================================
// PATCH /users/me/collections/:id
// =============================================================================
router.patch("/users/me/collections/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const colId = req.params.id;
  if (!isUuid(colId)) { sendError(res, "invalid_payload", "Invalid collection id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify ownership
  const { data: col } = await sc
    .from("collections")
    .select("id, is_default")
    .eq("id", colId)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (!col) { sendError(res, "not_found", "Collection not found"); return; }

  const { name, coverUrl, position } = (req.body ?? {}) as {
    name?: unknown; coverUrl?: unknown; position?: unknown;
  };

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };

  if (typeof name === "string") {
    if (name.trim().length === 0 || name.trim().length > 120) {
      sendError(res, "invalid_payload", "name must be 1–120 chars");
      return;
    }
    patch.name = name.trim();
  }

  if (coverUrl !== undefined) {
    patch.cover_url = typeof coverUrl === "string" && coverUrl ? coverUrl : null;
  }

  if (position !== undefined) {
    const pos = Number(position);
    if (!isNaN(pos) && pos >= 0) patch.position = pos;
  }

  const { data, error } = await sc
    .from("collections")
    .update(patch)
    .eq("id", colId)
    .eq("owner_id", user.id)
    .select("id, name, cover_url, position, is_default, created_at, updated_at")
    .single();

  if (error || !data) {
    req.log.error({ err: error }, "collection update failed");
    sendError(res, "db_error", error?.message ?? "Failed to update collection");
    return;
  }

  const c = data as any;
  res.json({
    collection: {
      id:        c.id as string,
      name:      c.name as string,
      coverUrl:  (c.cover_url as string | null) ?? null,
      position:  c.position as number,
      isDefault: c.is_default as boolean,
      updatedAt: c.updated_at as string,
    },
  });
});

// =============================================================================
// DELETE /users/me/collections/:id
// =============================================================================
router.delete("/users/me/collections/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const colId = req.params.id;
  if (!isUuid(colId)) { sendError(res, "invalid_payload", "Invalid collection id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify ownership and prevent deletion of default collection
  const { data: col } = await sc
    .from("collections")
    .select("id, is_default")
    .eq("id", colId)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (!col) { sendError(res, "not_found", "Collection not found"); return; }
  if ((col as any).is_default) {
    sendError(res, "forbidden", "Cannot delete the default Saved collection");
    return;
  }

  const { error } = await sc
    .from("collections")
    .delete()
    .eq("id", colId)
    .eq("owner_id", user.id);

  if (error) {
    req.log.error({ err: error }, "collection delete failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ ok: true });
});

// =============================================================================
// GET /users/me/collections/:id/items
// =============================================================================
router.get("/users/me/collections/:id/items", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const colId = req.params.id;
  if (!isUuid(colId)) { sendError(res, "invalid_payload", "Invalid collection id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify ownership
  const { data: col } = await sc
    .from("collections")
    .select("id")
    .eq("id", colId)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (!col) { sendError(res, "not_found", "Collection not found"); return; }

  const limit = Math.min(Number(req.query.limit ?? 40), 100);
  const before = typeof req.query.before === "string" ? req.query.before : null;

  let q = sc
    .from("collection_items")
    .select("id, entity_type, entity_id, saved_at")
    .eq("collection_id", colId)
    .order("saved_at", { ascending: false })
    .limit(limit + 1);

  if (before) q = q.lt("saved_at", before);

  const { data: items, error } = await q;

  if (error) {
    req.log.error({ err: error }, "collection items fetch failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const rows = (items ?? []) as any[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Group entity ids by type for batch resolution
  const byType: Record<string, string[]> = {};
  for (const row of page) {
    if (!byType[row.entity_type]) byType[row.entity_type] = [];
    byType[row.entity_type].push(row.entity_id as string);
  }

  const previewMap: Record<string, { title: string; coverUrl: string | null }> = {};

  // Resolve each type
  await Promise.all(
    Object.entries(byType).map(async ([type, ids]) => {
      try {
        if (type === "profile") {
          const { data } = await sc
            .from("profiles")
            .select("id, name, avatar_url")
            .in("id", ids);
          for (const r of (data ?? []) as any[]) {
            previewMap[r.id] = { title: r.name ?? r.id, coverUrl: r.avatar_url ?? null };
          }
        } else if (type === "post") {
          const { data } = await sc
            .from("posts")
            .select("id, title, caption")
            .in("id", ids);
          for (const r of (data ?? []) as any[]) {
            previewMap[r.id] = { title: r.title ?? r.caption ?? "Post", coverUrl: null };
          }
        } else if (type === "trip") {
          const { data } = await sc
            .from("trips")
            .select("id, destination, cover_url")
            .in("id", ids);
          for (const r of (data ?? []) as any[]) {
            previewMap[r.id] = { title: r.destination ?? "Trip", coverUrl: r.cover_url ?? null };
          }
        } else if (type === "event") {
          const { data } = await sc
            .from("events")
            .select("id, title, cover_url")
            .in("id", ids);
          for (const r of (data ?? []) as any[]) {
            previewMap[r.id] = { title: r.title ?? "Event", coverUrl: r.cover_url ?? null };
          }
        } else if (type === "memory") {
          const { data } = await sc
            .from("memories")
            .select("id, title")
            .in("id", ids);
          for (const r of (data ?? []) as any[]) {
            previewMap[r.id] = { title: r.title ?? "Memory", coverUrl: null };
          }
        } else if (type === "hashtag") {
          const { data } = await sc
            .from("hashtags")
            .select("id, name, slug")
            .in("id", ids);
          for (const r of (data ?? []) as any[]) {
            previewMap[r.id] = { title: `#${r.slug ?? r.name}`, coverUrl: null };
          }
        } else if (type === "place") {
          const { data } = await sc
            .from("discovery_places")
            .select("id, name, image_url")
            .in("id", ids);
          for (const r of (data ?? []) as any[]) {
            previewMap[r.id] = { title: r.name ?? "Place", coverUrl: r.image_url ?? null };
          }
        } else if (type === "highlight") {
          const { data } = await sc
            .from("highlights")
            .select("id, caption, media_thumbnail_url, media_url")
            .in("id", ids);
          for (const r of (data ?? []) as any[]) {
            previewMap[r.id] = {
              title: (r.caption as string | null) ?? "Highlight",
              coverUrl: (r.media_thumbnail_url as string | null) ?? (r.media_url as string | null) ?? null,
            };
          }
        }
      } catch {
        // partial failure: leave previews absent; entity rows still returned
      }
    }),
  );

  res.json({
    items: page.map((row: any) => ({
      id:         row.id as string,
      entityType: row.entity_type as string,
      entityId:   row.entity_id as string,
      savedAt:    row.saved_at as string,
      title:      previewMap[row.entity_id as string]?.title ?? null,
      coverUrl:   previewMap[row.entity_id as string]?.coverUrl ?? null,
    })),
    hasMore,
    nextCursor: hasMore ? (page[page.length - 1] as any).saved_at as string : null,
  });
});

// =============================================================================
// POST /saves  — save item
// =============================================================================
router.post("/saves", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { entity_type, entity_id, collection_id } = (req.body ?? {}) as {
    entity_type?: unknown; entity_id?: unknown; collection_id?: unknown;
  };

  if (!isValidEntityType(entity_type)) {
    sendError(res, "invalid_payload", `entity_type must be one of: ${VALID_ENTITY_TYPES.join(", ")}`);
    return;
  }
  if (!isValidUuid(entity_id)) {
    sendError(res, "invalid_payload", "entity_id must be a valid UUID");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  let colId: string | null = null;

  if (typeof collection_id === "string" && isUuid(collection_id)) {
    // Verify the specified collection belongs to this user
    const { data: col } = await sc
      .from("collections")
      .select("id")
      .eq("id", collection_id)
      .eq("owner_id", user.id)
      .maybeSingle();

    if (!col) { sendError(res, "not_found", "Collection not found"); return; }
    colId = (col as any).id as string;
  } else {
    // Auto-create or find default collection
    const defaultResult = await ensureDefaultCollection(sc, user.id);
    if ("code" in defaultResult) {
      req.log.error({ code: defaultResult.code, detail: defaultResult.detail }, "default collection creation failed");
      sendError(res, defaultResult.code, defaultResult.detail);
      return;
    }
    colId = defaultResult.id;
  }

  const { error } = await sc
    .from("collection_items")
    .upsert(
      { collection_id: colId, entity_type, entity_id, saved_at: new Date().toISOString() },
      { onConflict: "collection_id,entity_type,entity_id", ignoreDuplicates: true },
    );

  if (error) {
    req.log.error({ err: error }, "save item failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ saved: true, entityType: entity_type, entityId: entity_id, collectionId: colId });
});

// =============================================================================
// DELETE /saves  — unsave item (removes from all user's collections)
// =============================================================================
router.delete("/saves", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { entity_type, entity_id } = (req.body ?? {}) as {
    entity_type?: unknown; entity_id?: unknown;
  };

  if (!isValidEntityType(entity_type)) {
    sendError(res, "invalid_payload", `entity_type must be one of: ${VALID_ENTITY_TYPES.join(", ")}`);
    return;
  }
  if (!isValidUuid(entity_id)) {
    sendError(res, "invalid_payload", "entity_id must be a valid UUID");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Find all user's collection ids
  const { data: cols } = await sc
    .from("collections")
    .select("id")
    .eq("owner_id", user.id);

  const colIds = (cols ?? []).map((c: any) => c.id as string);

  if (colIds.length > 0) {
    const { error } = await sc
      .from("collection_items")
      .delete()
      .in("collection_id", colIds)
      .eq("entity_type", entity_type)
      .eq("entity_id", entity_id);

    if (error) {
      req.log.error({ err: error }, "unsave item failed");
      sendError(res, "db_error", error.message);
      return;
    }
  }

  res.json({ saved: false, entityType: entity_type, entityId: entity_id });
});

// =============================================================================
// GET /users/me/saves  — check saved state for a specific item
// =============================================================================
router.get("/users/me/saves", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const entity_type = req.query.entity_type as unknown;
  const entity_id   = req.query.entity_id   as unknown;

  if (!isValidEntityType(entity_type)) {
    sendError(res, "invalid_payload", `entity_type must be one of: ${VALID_ENTITY_TYPES.join(", ")}`);
    return;
  }
  if (!isValidUuid(entity_id)) {
    sendError(res, "invalid_payload", "entity_id must be a valid UUID");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Find user's collection ids
  const { data: cols } = await sc
    .from("collections")
    .select("id")
    .eq("owner_id", user.id);

  const colIds = (cols ?? []).map((c: any) => c.id as string);

  if (colIds.length === 0) {
    res.json({ saved: false, collectionIds: [] });
    return;
  }

  const { data, error } = await sc
    .from("collection_items")
    .select("collection_id")
    .in("collection_id", colIds)
    .eq("entity_type", entity_type)
    .eq("entity_id", entity_id);

  if (error) {
    req.log.error({ err: error }, "save status check failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const foundCollectionIds = (data ?? []).map((r: any) => r.collection_id as string);
  res.json({
    saved: foundCollectionIds.length > 0,
    collectionIds: foundCollectionIds,
  });
});

// =============================================================================
// GET /users/me/saved-hashtags
// =============================================================================
router.get("/users/me/saved-hashtags", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Find all saved hashtag entity_ids across user's collections
  const { data: cols } = await sc
    .from("collections")
    .select("id")
    .eq("owner_id", user.id);

  const colIds = (cols ?? []).map((c: any) => c.id as string);

  if (colIds.length === 0) {
    res.json({ hashtags: [] });
    return;
  }

  const { data: items, error } = await sc
    .from("collection_items")
    .select("entity_id, saved_at")
    .in("collection_id", colIds)
    .eq("entity_type", "hashtag")
    .order("saved_at", { ascending: false });

  if (error) {
    req.log.error({ err: error }, "saved-hashtags fetch failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const htIds = [...new Set((items ?? []).map((r: any) => r.entity_id as string))];

  if (htIds.length === 0) {
    res.json({ hashtags: [] });
    return;
  }

  const { data: hashtags } = await sc
    .from("hashtags")
    .select("id, slug, name, usage_count")
    .in("id", htIds)
    .eq("is_blocked", false);

  const savedAtMap: Record<string, string> = {};
  for (const r of (items ?? []) as any[]) {
    if (!savedAtMap[r.entity_id]) savedAtMap[r.entity_id] = r.saved_at;
  }

  res.json({
    hashtags: (hashtags ?? []).map((h: any) => ({
      id:         h.id as string,
      slug:       h.slug as string,
      name:       h.name as string,
      usageCount: h.usage_count as number,
      savedAt:    savedAtMap[h.id as string] ?? null,
    })),
  });
});

export default router;
