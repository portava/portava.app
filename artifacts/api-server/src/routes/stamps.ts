/**
 * Passport Stamps v2 — Public & Owner Routes
 *
 * Mounted at /api (full paths: /api/stamps/...)
 *
 * GET  /stamps/definitions                 — all active stamp definitions
 * GET  /stamps/me                          — caller's own stamps
 * GET  /stamps/me/progress                 — caller's stamp progress
 * GET  /stamps/me/collections              — caller's earned stamps per collection
 * GET  /stamps/user/:userId                — another user's stamps (visibility-gated)
 * GET  /stamps/profile/:username           — stamps by username (privacy-gated, uses PassportPrivacyGuard CallerContext)
 * GET  /stamps/recent                      — recently earned public stamps
 * GET  /stamps/city/:city                  — public stamps for a city
 * GET  /stamps/country/:country            — public stamps for a country
 * GET  /stamps/:stampId                    — single user_stamp (visibility-gated)
 * PATCH /stamps/:userStampId/visibility    — update stamp visibility (owner only)
 * PATCH /stamps/:userStampId/display       — toggle display_on_passport (owner only)
 * POST /stamps/check-eligibility           — dry-run eligibility check
 * POST /stamps/recalculate/me              — safe idempotent recalculate for caller
 * POST /stamps/recalculate/:userId         — admin-only recalculate for any user
 *
 * NOTE: stamp award is service-role internal only (awardStamp() called directly from
 * trigger/service code). Admin HTTP award goes through /api/admin/stamps/award.
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, safeSecretEquals } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import type { CallerContext } from "../services/passport/PassportPrivacyGuard.js";
import { filterStampsV2 } from "../services/passport/PassportPrivacyGuard.js";
import {
  awardStamp,
  checkEligibility,
  recalculateForUser,
} from "../services/passport/StampAwardEngine.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter as NotifRouter } from "../services/notifications/NotificationRouter.js";

const router = Router();

// ── Guard: Stamp System v2 tables (stamp_definitions, user_stamps, etc.) are
// created by migration 0081 which may not yet be applied to production.
// Fail-closed: if the feature_flags row for stamp_system_v2_enabled is absent
// OR disabled, return 503 so callers get a clear error instead of a 500 from
// "relation stamp_definitions does not exist".
router.use(async (req, res, next) => {
  // SCOPE FIX (2026-07-23): this router is mounted path-less in routes/index.ts,
  // so without this guard the gate below intercepted EVERY request that reached
  // it — 503ing ~15 unrelated routers registered after it (emergency contacts,
  // crash reports, discovery search, calls, …) whenever the flag was off.
  // Gate ONLY stamp routes; let everything else fall through.
  if (!req.path.startsWith("/stamps")) return next();
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  try {
    const { data } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "stamp_system_v2_enabled")
      .maybeSingle();
    if (data?.enabled !== true) {
      res.status(503).json({ error: "feature_not_available", message: "Stamp System v2 is not yet enabled." });
      return;
    }
  } catch {
    res.status(503).json({ error: "feature_not_available", message: "Stamp System v2 is not yet enabled." });
    return;
  }
  next();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

const VISIBILITY = z.enum(["public", "friends_only", "private"]);

// ── Column sets (lat/lng and metadata intentionally excluded from public reads) ──
// OWNER_STAMP_COLS  — used when the caller is the stamp owner (includes metadata)
// PUBLIC_STAMP_COLS — used for all non-owner reads (metadata excluded)
const OWNER_STAMP_COLS =
  "id, user_id, stamp_definition_id, source_type, earned_at, city, country, " +
  "title_override, metadata, visibility, display_on_passport, is_revoked, created_at, catalog_id";
const PUBLIC_STAMP_COLS =
  "id, user_id, stamp_definition_id, source_type, earned_at, city, country, " +
  "title_override, visibility, display_on_passport, is_revoked, created_at, catalog_id";

// ── Friendship helper ─────────────────────────────────────────────────────────
// Returns true if caller and target have an accepted friendship.

async function areFriends(
  sc: ReturnType<typeof getServiceClient>,
  callerId: string,
  targetId: string,
): Promise<boolean> {
  if (!sc) return false;
  const { data } = await sc
    .from("user_friendships")
    .select("user_a")
    .or(`and(user_a.eq.${callerId},user_b.eq.${targetId}),and(user_a.eq.${targetId},user_b.eq.${callerId})`)
    .maybeSingle();
  return data != null;
}

// ── Block check helper ────────────────────────────────────────────────────────

async function isBlocked(
  sc: ReturnType<typeof getServiceClient>,
  callerId: string,
  targetId: string,
): Promise<boolean> {
  if (!sc) return false;
  const { data } = await sc
    .from("blocks")
    .select("id")
    .or(
      `and(blocker_id.eq.${callerId},blocked_id.eq.${targetId}),and(blocker_id.eq.${targetId},blocked_id.eq.${callerId})`,
    )
    .maybeSingle();
  return data != null;
}

/**
 * Filter an aggregate stamp feed (recent / city / country) so it never exposes a
 * stamp whose owner has a PRIVATE passport, nor one owned by someone in a block
 * relationship with the caller. Per-stamp `visibility` defaults to 'public', so
 * a user who set passport_visibility='private' (which the /profile/:username
 * route honors) would otherwise leak their user_id + city + earned_at through
 * these feeds. The caller's own stamps are always kept. Fails CLOSED: if owner
 * privacy or the block set cannot be read, nothing is exposed.
 */
async function filterFeedByOwnerPrivacy(
  sc: ReturnType<typeof getServiceClient>,
  callerId: string,
  rows: any[],
): Promise<any[]> {
  if (!sc || rows.length === 0) return rows;
  const ownerIds = [...new Set(rows.map((r) => r.user_id as string).filter(Boolean))];
  if (ownerIds.length === 0) return rows;

  const { data: profs, error: profErr } = await sc
    .from("profiles")
    .select("id, passport_visibility")
    .in("id", ownerIds);
  if (profErr) return []; // fail closed — cannot confirm privacy → expose nothing
  const privateSet = new Set(
    ((profs ?? []) as any[]).filter((p) => p.passport_visibility === "private").map((p) => p.id),
  );

  const [{ data: outBlocks, error: e1 }, { data: inBlocks, error: e2 }] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", callerId).in("blocked_id", ownerIds),
    sc.from("blocks").select("blocker_id").eq("blocked_id", callerId).in("blocker_id", ownerIds),
  ]);
  if (e1 || e2) return []; // fail closed — an unreadable blocks table denies
  const blockedSet = new Set<string>();
  for (const b of (outBlocks ?? []) as any[]) blockedSet.add(b.blocked_id);
  for (const b of (inBlocks ?? []) as any[]) blockedSet.add(b.blocker_id);

  return rows.filter(
    (r) => r.user_id === callerId || (!privateSet.has(r.user_id) && !blockedSet.has(r.user_id)),
  );
}

// ── Internal award gate ───────────────────────────────────────────────────────
// POST /stamps/award is service-role internal only. Caller must supply
// X-Internal-Secret matching INTERNAL_API_SECRET env var (same pattern as
// notifications.ts internal routes). No user auth is involved.

function requireInternalSecret(req: any, res: any): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    res.status(503).json({
      error: "misconfigured",
      message: "INTERNAL_API_SECRET is not set; internal stamp award is disabled",
    });
    return false;
  }
  const provided = req.headers["x-internal-secret"];
  if (!safeSecretEquals(provided, secret)) {
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid internal secret" });
    return false;
  }
  return true;
}

// ── Universal artwork column probe ────────────────────────────────────────────
// `stamp_definitions.universal_artwork_url` is added by migration 0124. Until
// that migration is applied, selecting the column would 42703 every stamp
// endpoint, so probe once and only include it when it exists. A negative
// result is re-probed after 60s so applying the migration doesn't require a
// server restart.

let _hasArtworkCol: boolean | null = null;
let _artProbeAt = 0;

async function artCol(sc: any): Promise<string> {
  const now = Date.now();
  if (_hasArtworkCol === null || (_hasArtworkCol === false && now - _artProbeAt > 60_000)) {
    const { error } = await sc.from("stamp_definitions").select("universal_artwork_url").limit(1);
    _hasArtworkCol = !error;
    _artProbeAt = now;
  }
  return _hasArtworkCol ? ", universal_artwork_url" : "";
}

// ── GET /stamps/definitions ───────────────────────────────────────────────────

router.get("/stamps/definitions", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const category = req.query.category as string | undefined;
  const stampType = req.query.type as string | undefined;

  let query = sc
    .from("stamp_definitions")
    .select(
      "id, slug, name, description, stamp_type, category, icon_url" + (await artCol(sc)) + ", rarity, " +
      "is_repeatable, max_awards_per_user, visibility_default, city, country, starts_at, ends_at",
    )
    .eq("is_active", true)
    .order("category")
    .order("rarity");

  if (category) query = (query as any).eq("category", category);
  if (stampType) query = (query as any).eq("stamp_type", stampType);

  const { data, error } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ definitions: data ?? [] });
});

// ── GET /stamps/me ────────────────────────────────────────────────────────────

router.get("/stamps/me", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const city    = req.query.city as string | undefined;
  const country = req.query.country as string | undefined;

  // Pagination: limit defaults to 100 (max 200), offset defaults to 0.
  // Response: { stamps, total } — total is the sentinel for client infinite scroll.
  const limitVal  = Math.min(200, Math.max(1, parseInt(String(req.query.limit  ?? "100"), 10) || 100));
  const offsetVal = Math.max(0,              parseInt(String(req.query.offset ?? "0"),   10) || 0);

  // Total count (before pagination) — same DB-level filters as the page query.
  // If the count fails, the sentinel is repaired from the page data below so
  // the response never claims total < rows returned (that would strand
  // infinite-scroll clients on the first page).
  let total = 0;
  let countFailed = false;
  try {
    let cq = sc
      .from("user_stamps")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    if (city)    cq = (cq as any).eq("city", city);
    if (country) cq = (cq as any).eq("country", country);
    const { count, error: countError } = await cq;
    if (countError || typeof count !== "number") countFailed = true;
    else total = count;
  } catch { countFailed = true; }

  // Owner sees all stamps including revoked and hidden — use full column set with metadata
  let query = sc
    .from("user_stamps")
    .select(OWNER_STAMP_COLS + ", stamp_definitions(slug, name, icon_url" + (await artCol(sc)) + ", rarity, stamp_type, category)")
    .eq("user_id", user.id)
    .order("earned_at", { ascending: false })
    .range(offsetVal, offsetVal + limitVal - 1);

  if (city)    query = (query as any).eq("city", city);
  if (country) query = (query as any).eq("country", country);

  const { data, error } = await query;
  if (error) {
    // PGRST205/PGRST200 = relation does not exist (migration not yet applied)
    if ((error as any).code === "PGRST205" || (error as any).code === "PGRST200") {
      res.json({ stamps: [], total: 0 });
      return;
    }
    sendError(res, "db_error", error.message);
    return;
  }

  const rows = data ?? [];
  // Contract repair: total must never be smaller than the rows we're serving
  // (offset + page length). When the count failed (or drifted low) and the
  // page came back full, advertise at least one more row so clients keep
  // paging — they clamp on the first short/empty page.
  if (countFailed || total < offsetVal + rows.length) {
    total = offsetVal + rows.length + (rows.length === limitVal ? 1 : 0);
  }

  res.json({ stamps: await formatStamps(sc, rows), total });
});

// ── GET /stamps/me/unified ────────────────────────────────────────────────────
// Legacy unification (read-layer): merges v1 GPS passport_stamps + v2
// user_stamps into one deduplicated collection so the passport can show a
// single coherent count/list. Read-only; no writes, no migration. Works
// regardless of the flag (the flag only governs whether other surfaces adopt
// the unified count); returns the flag state so clients can decide.
router.get("/stamps/me/unified", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { buildUnifiedStamps, unifiedViewEnabled } = await import("../services/passport/UnifiedStampService.js");
  const [result, enabled] = await Promise.all([
    buildUnifiedStamps(sc, user.id),
    unifiedViewEnabled(sc),
  ]);
  res.json({ ...result, enabled });
});

// ── GET /stamps/me/progress ───────────────────────────────────────────────────

router.get("/stamps/me/progress", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data, error } = await sc
    .from("stamp_progress")
    .select("stamp_definition_id, progress_count, progress_target, updated_at, stamp_definitions(slug, name, icon_url" + (await artCol(sc)) + ")")
    .eq("user_id", user.id);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ progress: data ?? [] });
});

// ── GET /stamps/me/collections ────────────────────────────────────────────────

router.get("/stamps/me/collections", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const [collectionsRes, earnedRes] = await Promise.all([
    sc.from("stamp_collections")
      .select("id, slug, name, description, icon_url, stamp_collection_items(stamp_definition_id)")
      .eq("is_active", true),
    sc.from("user_stamps")
      .select("stamp_definition_id")
      .eq("user_id", user.id)
      .eq("is_revoked", false),
  ]);

  if (collectionsRes.error) { sendError(res, "db_error", collectionsRes.error.message); return; }

  const earnedDefIds = new Set(
    ((earnedRes.data ?? []) as any[]).map((s: any) => s.stamp_definition_id),
  );

  const collections = ((collectionsRes.data ?? []) as any[]).map((col: any) => {
    const items: any[] = col.stamp_collection_items ?? [];
    const total = items.length;
    const earned = items.filter((i: any) => earnedDefIds.has(i.stamp_definition_id)).length;
    return {
      id:          col.id,
      slug:        col.slug,
      name:        col.name,
      description: col.description,
      iconUrl:     col.icon_url,
      total,
      earned,
      complete:    total > 0 && earned === total,
    };
  });

  res.json({ collections });
});

// ── GET /stamps/user/:userId ──────────────────────────────────────────────────
// Static routes (me, recent, city, country) MUST come before :stampId and :userId
// to avoid Express matching them as dynamic params.

router.get("/stamps/user/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) { sendError(res, "invalid_payload", "Invalid userId"); return; }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const callerId = auth.user.id;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const isSelf = callerId === userId;

  // Block check — both directions
  if (!isSelf) {
    const blocked = await isBlocked(sc, callerId, userId);
    if (blocked) { sendError(res, "forbidden", "User not available"); return; }

    // Respect passport_visibility — the /stamps/profile/:username route hides a
    // private passport, and this userId route must too, or it is a bypass.
    const { data: prof } = await sc
      .from("profiles").select("passport_visibility").eq("id", userId).maybeSingle();
    if ((prof as any)?.passport_visibility === "private") { res.json({ stamps: [] }); return; }
  }

  if (isSelf) {
    // Owner path: sees all stamps including revoked and hidden, with metadata
    const { data, error } = await sc
      .from("user_stamps")
      .select(OWNER_STAMP_COLS + ", stamp_definitions(slug, name, icon_url" + (await artCol(sc)) + ", rarity, stamp_type, category)")
      .eq("user_id", userId)
      .order("earned_at", { ascending: false })
      .limit(200);
    if (error) { sendError(res, "db_error", error.message); return; }
    res.json({ stamps: await formatStamps(sc, data ?? []) });
    return;
  }

  // Non-owner: check friendship to determine if friends_only stamps are visible
  const friend = await areFriends(sc, callerId, userId);

  let query = sc
    .from("user_stamps")
    .select(PUBLIC_STAMP_COLS + ", stamp_definitions(slug, name, icon_url" + (await artCol(sc)) + ", rarity, stamp_type, category)")
    .eq("user_id", userId)
    .eq("is_revoked", false)
    .eq("display_on_passport", true)
    .order("earned_at", { ascending: false })
    .limit(100);

  if (friend) {
    // Friends see public + friends_only (no private)
    query = (query as any).in("visibility", ["public", "friends_only"]);
  } else {
    // Public sees only public stamps
    query = (query as any).eq("visibility", "public");
  }

  const { data, error } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ stamps: await formatStamps(sc, data ?? []) });
});

// ── GET /stamps/profile/:username ─────────────────────────────────────────────
// Uses PassportPrivacyGuard CallerContext to respect passport_visibility setting
// and map friendship to "circle" context for friends_only stamps.

router.get("/stamps/profile/:username", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { username } = req.params;

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id, passport_visibility")
    .eq("username", username)
    .maybeSingle();

  if (profileErr || !profile) { sendError(res, "not_found", "User not found"); return; }

  const targetUserId = (profile as any).id;

  // If the passport is set to private, return empty without leaking existence
  if ((profile as any).passport_visibility === "private") {
    res.json({ stamps: [] });
    return;
  }

  // Derive CallerContext following the same pattern as passportStamps.ts
  let callerCtx: CallerContext = "public";
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  let callerId: string | null = null;

  if (token) {
    const { data: authData } = await sc.auth.getUser(token);
    callerId = authData?.user?.id ?? null;

    if (callerId === targetUserId) {
      callerCtx = "owner";
    } else if (callerId) {
      // Block check — blocked users see nothing
      const blocked = await isBlocked(sc, callerId, targetUserId);
      if (blocked) { res.json({ stamps: [] }); return; }

      // Friendship → "circle" context (grants access to friends_only stamps)
      const { data: friendRow } = await sc
        .from("user_friendships")
        .select("user_a")
        .or(`and(user_a.eq.${callerId},user_b.eq.${targetUserId}),and(user_a.eq.${targetUserId},user_b.eq.${callerId})`)
        .maybeSingle();

      if (friendRow) callerCtx = "circle";
    }
  }

  // Load stamps — use OWNER_STAMP_COLS for owner (includes metadata), PUBLIC for others
  const colSet = callerCtx === "owner" ? OWNER_STAMP_COLS : PUBLIC_STAMP_COLS;

  let stampQuery = sc
    .from("user_stamps")
    .select(colSet + ", stamp_definitions(slug, name, icon_url" + (await artCol(sc)) + ", rarity, stamp_type, category)")
    .eq("user_id", targetUserId)
    .order("earned_at", { ascending: false })
    .limit(100);

  // Non-owners should only see non-revoked, display-on-passport stamps
  if (callerCtx !== "owner") {
    stampQuery = (stampQuery as any).eq("is_revoked", false).eq("display_on_passport", true);
  }

  const { data: rows, error } = await stampQuery;
  if (error) { sendError(res, "db_error", error.message); return; }

  // Apply PassportPrivacyGuard filterStampsV2 — uses CallerContext-based visibility
  const filtered = filterStampsV2(
    (rows ?? []) as unknown as Array<{ visibility: string }>,
    callerCtx,
  ) as any[];

  const stamps = await formatStamps(sc, filtered);
  res.json({ stamps });
});

// ── GET /stamps/recent ────────────────────────────────────────────────────────

router.get("/stamps/recent", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const limit = Math.min(50, Number(req.query.limit) || 20);

  const { data, error } = await sc
    .from("user_stamps")
    .select(PUBLIC_STAMP_COLS + ", stamp_definitions(slug, name, icon_url" + (await artCol(sc)) + ", rarity, stamp_type)")
    .eq("is_revoked", false)
    .eq("visibility", "public")
    .eq("display_on_passport", true)
    .order("earned_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  const visible = await filterFeedByOwnerPrivacy(sc, auth.user.id, (data ?? []) as any[]);
  res.json({ stamps: await formatStamps(sc, visible) });
});

// ── GET /stamps/city/:city ────────────────────────────────────────────────────

router.get("/stamps/city/:city", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error } = await sc
    .from("user_stamps")
    .select(PUBLIC_STAMP_COLS + ", stamp_definitions(slug, name, icon_url" + (await artCol(sc)) + ", rarity, stamp_type)")
    .eq("city", req.params.city)
    .eq("is_revoked", false)
    .eq("visibility", "public")
    .order("earned_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  const visible = await filterFeedByOwnerPrivacy(sc, auth.user.id, (data ?? []) as any[]);
  res.json({ stamps: await formatStamps(sc, visible) });
});

// ── GET /stamps/country/:country ──────────────────────────────────────────────

router.get("/stamps/country/:country", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error } = await sc
    .from("user_stamps")
    .select(PUBLIC_STAMP_COLS + ", stamp_definitions(slug, name, icon_url" + (await artCol(sc)) + ", rarity, stamp_type)")
    .eq("country", req.params.country)
    .eq("is_revoked", false)
    .eq("visibility", "public")
    .order("earned_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  const visible = await filterFeedByOwnerPrivacy(sc, auth.user.id, (data ?? []) as any[]);
  res.json({ stamps: await formatStamps(sc, visible) });
});

// ── GET /stamps/:stampId ──────────────────────────────────────────────────────
// Must be after all static /stamps/... routes to avoid shadowing them.

router.get("/stamps/:stampId", async (req, res) => {
  const { stampId } = req.params;
  if (!isUuid(stampId)) { sendError(res, "invalid_payload", "Invalid stampId"); return; }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const callerId = auth.user.id;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  // Fetch with owner columns first — we'll check ownership after
  const { data, error } = await sc
    .from("user_stamps")
    .select(OWNER_STAMP_COLS + ", stamp_definitions(slug, name, description, icon_url" + (await artCol(sc)) + ", rarity, stamp_type, category)")
    .eq("id", stampId)
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Stamp not found"); return; }

  const stamp = data as any;
  const isOwner = stamp.user_id === callerId;

  if (isOwner) {
    // Owner gets full metadata-included response
    const [formatted] = await formatStamps(sc, [stamp]);
    res.json({ stamp: formatted });
    return;
  }

  // Revoked stamps are never visible to non-owners
  if (stamp.is_revoked) { sendError(res, "not_found", "Stamp not found"); return; }

  // Private stamps — non-owners cannot see
  if (stamp.visibility === "private") { sendError(res, "not_found", "Stamp not found"); return; }

  // Block check
  const blocked = await isBlocked(sc, callerId, stamp.user_id);
  if (blocked) { sendError(res, "not_found", "Stamp not found"); return; }

  // friends_only — require friendship
  if (stamp.visibility === "friends_only") {
    const friend = await areFriends(sc, callerId, stamp.user_id);
    if (!friend) { sendError(res, "not_found", "Stamp not found"); return; }
  }

  // Non-owner: strip metadata from response (same as PUBLIC_STAMP_COLS exclusion)
  const { metadata: _stripped, ...publicStamp } = stamp;
  const [formattedPublic] = await formatStamps(sc, [publicStamp]);
  res.json({ stamp: formattedPublic });
});

// ── PATCH /stamps/:userStampId/visibility ─────────────────────────────────────

const patchVisibilitySchema = z.object({
  visibility: VISIBILITY,
});

router.patch("/stamps/:userStampId/visibility", async (req, res) => {
  const { userStampId } = req.params;
  if (!isUuid(userStampId)) { sendError(res, "invalid_payload", "Invalid userStampId"); return; }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const parsed = patchVisibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const { data, error } = await sc
    .from("user_stamps")
    .update({ visibility: parsed.data.visibility })
    .eq("id", userStampId)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Stamp not found or not yours"); return; }

  res.json({ id: userStampId, visibility: parsed.data.visibility });
});

// ── PATCH /stamps/:userStampId/display ────────────────────────────────────────

const patchDisplaySchema = z.object({
  displayOnPassport: z.boolean(),
});

router.patch("/stamps/:userStampId/display", async (req, res) => {
  const { userStampId } = req.params;
  if (!isUuid(userStampId)) { sendError(res, "invalid_payload", "Invalid userStampId"); return; }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const parsed = patchDisplaySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const { data, error } = await sc
    .from("user_stamps")
    .update({ display_on_passport: parsed.data.displayOnPassport })
    .eq("id", userStampId)
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Stamp not found or not yours"); return; }

  res.json({ id: userStampId, displayOnPassport: parsed.data.displayOnPassport });
});

// ── POST /stamps/award (service-role internal only) ──────────────────────────
// Called ONLY by server-side trigger/service code via X-Internal-Secret header.
// No user auth involved. Requires INTERNAL_API_SECRET env var to be set.
// All user-facing award flows go through StampAwardEngine.awardStamp() directly.
// Admin HTTP award (manual grants) goes through /api/admin/stamps/award.

const internalAwardSchema = z.object({
  userId:         z.string().uuid(),
  definitionSlug: z.string().min(1),
  sourceType:     z.string().optional(),
  sourceId:       z.string().optional(),
  city:           z.string().optional(),
  country:        z.string().optional(),
  lat:            z.number().optional(),
  lng:            z.number().optional(),
  metadata:       z.record(z.unknown()).optional(),
  awardReason:    z.string().optional(),
});

router.post("/stamps/award", async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const parsed = internalAwardSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const result = await awardStamp(sc, parsed.data, req.log);

  if (result.awarded) {
    (async () => {
      try {
        const notifSvc    = new NotificationService(sc);
        const notifRouter = new NotifRouter(sc);
        const row = await notifSvc.create({
          userId:     parsed.data.userId,
          eventType:  "passport.stamp_earned",
          sourceType: "passport",
          sourceId:   result.userStampId,
          params:     {
            location: parsed.data.city ?? parsed.data.country ?? parsed.data.definitionSlug,
            stampId:  result.userStampId ?? '',
          },
        });
        if (row) await notifRouter.route(row);
      } catch {}
    })();
  }

  res.status(result.awarded ? 201 : 200).json(result);
});

// ── POST /stamps/check-eligibility ───────────────────────────────────────────

const eligibilitySchema = z.object({
  userId:         z.string().uuid(),
  definitionSlug: z.string().min(1),
  sourceType:     z.string().optional(),
  sourceId:       z.string().optional(),
});

router.post("/stamps/check-eligibility", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const parsed = eligibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const result = await checkEligibility(
    sc,
    parsed.data.userId,
    parsed.data.definitionSlug,
    parsed.data.sourceType,
    parsed.data.sourceId,
  );

  res.json(result);
});

// ── POST /stamps/recalculate/me ───────────────────────────────────────────────

router.post("/stamps/recalculate/me", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const result = await recalculateForUser(sc, user.id);
  res.json(result);
});

// ── POST /stamps/recalculate/:userId (admin only) ────────────────────────────

router.post("/stamps/recalculate/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) { sendError(res, "invalid_payload", "Invalid userId"); return; }

  // Inline admin check — requireAdmin is in adminStamps.ts; stamp award is service-role-only
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data: profileData } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profileData || (profileData as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return;
  }

  const sc = getServiceClient() ?? client;
  const result = await recalculateForUser(sc, userId);
  res.json(result);
});

// ── Catalog artwork batch enrichment ──────────────────────────────────────────
// Resolves active_artwork_url for every stamp that has a catalog_id, using a
// single batch query against universal_stamp_catalog + stamp_artwork_versions.
// Falls back gracefully when the tables do not yet exist.

interface CatalogArtwork {
  /** Full composited stamp (≈1024px). */
  full: string | null;
  /** Thumbnail (≈256px) for grid tiles / icons — Wave 1 premium pipeline. */
  thumb: string | null;
}

const STAMP_ARTWORK_BUCKET = "stamp-artwork";
// Short-lived signed URLs so private-bucket artwork renders in expo-image without
// requiring a public bucket.  1-hour expiry is fine given the mobile HTTP cache.
const SIGNED_URL_EXPIRY_SECS = 3600;

/** True for a raw Supabase storage path that must be signed before serving. */
function isStoragePath(u: string | null | undefined): u is string {
  return Boolean(
    u &&
      !u.startsWith("https://") &&
      !u.startsWith("http://") &&
      !u.startsWith("data:"),
  );
}

async function buildCatalogArtworkMap(
  sc: ReturnType<typeof getServiceClient>,
  rows: any[],
): Promise<Map<string, CatalogArtwork>> {
  const artworkMap = new Map<string, CatalogArtwork>();
  if (!sc) return artworkMap;

  const catalogIds = [...new Set(
    rows.map((r) => r.catalog_id).filter((id): id is string => typeof id === "string"),
  )];
  if (catalogIds.length === 0) return artworkMap;

  // FIX: use the FK constraint name fk_catalog_active_version rather than the
  // column name active_version_id — PostgREST resolves the relationship
  // unambiguously only when the constraint name is supplied.  The column-name
  // hint was silently returning null for every catalog row because PostgREST
  // could not find a unique FK to stamp_artwork_versions via that hint.
  //
  // thumbnail_url is added by migration 0177; older DBs lack the column, so on
  // a 42703 (undefined_column) we retry selecting only public_url.
  const runQuery = (withThumb: boolean) =>
    sc
      .from("universal_stamp_catalog")
      .select(
        withThumb
          ? "id, stamp_artwork_versions!fk_catalog_active_version(public_url, thumbnail_url)"
          : "id, stamp_artwork_versions!fk_catalog_active_version(public_url)",
      )
      .in("id", catalogIds)
      .eq("status", "approved");

  try {
    let { data, error } = await runQuery(true);
    if (error && (error as any).code === "42703") {
      ({ data, error } = await runQuery(false));
    }
    if (error) return artworkMap; // tables may not exist yet — degrade silently

    // Collect raw paths before signing so full + thumb can be batched.
    const rawEntries: Array<{ catalogId: string; full: string | null; thumb: string | null }> = [];
    for (const row of (data ?? []) as any[]) {
      const v = row.stamp_artwork_versions ?? null;
      rawEntries.push({
        catalogId: row.id,
        full: v?.public_url ?? null,
        thumb: v?.thumbnail_url ?? null,
      });
    }

    // stamp-artwork bucket is private; generate short-lived signed URLs so the
    // client can render artwork without exposing bucket credentials.
    // Paths already starting with https:// (CDN or previously signed) or
    // data: (dev PlaceholderProvider SVGs) pass through unchanged.
    const toSign = [
      ...new Set(
        rawEntries
          .flatMap((e) => [e.full, e.thumb])
          .filter(isStoragePath),
      ),
    ] as string[];

    const signedMap = new Map<string, string>();
    if (toSign.length > 0) {
      try {
        const { data: signedUrls } = await sc.storage
          .from(STAMP_ARTWORK_BUCKET)
          .createSignedUrls(toSign, SIGNED_URL_EXPIRY_SECS);
        for (const s of (signedUrls ?? []) as any[]) {
          if (s.signedUrl && s.path) signedMap.set(s.path, s.signedUrl);
        }
      } catch {
        // Signing failed (bucket not configured or network error) — storage
        // paths are returned as-is; expo-image calls onError and falls back
        // to the procedural placeholder icon.
      }
    }

    const resolve = (p: string | null): string | null => {
      if (!p) return null;
      return signedMap.get(p) ?? p;
    };

    for (const e of rawEntries) {
      artworkMap.set(e.catalogId, {
        full: resolve(e.full),
        thumb: resolve(e.thumb),
      });
    }
  } catch {
    // Never surface artwork lookup failures to the caller
  }

  return artworkMap;
}

// ── Formatter ─────────────────────────────────────────────────────────────────
// lat/lng are intentionally omitted from all responses.

function formatStamp(row: any, artworkMap?: Map<string, CatalogArtwork>) {
  const catalogId: string | null = row.catalog_id ?? null;
  const art = catalogId && artworkMap ? artworkMap.get(catalogId) : undefined;
  const activeArtworkUrl: string | null = art?.full ?? null;
  const thumbnailUrl: string | null = art?.thumb ?? null;

  return {
    id:                row.id,
    userId:            row.user_id,
    stampDefinitionId: row.stamp_definition_id,
    definition:        row.stamp_definitions ?? undefined,
    sourceType:        row.source_type,
    earnedAt:          row.earned_at,
    city:              row.city,
    country:           row.country,
    titleOverride:     row.title_override,
    metadata:          row.metadata,
    visibility:        row.visibility,
    displayOnPassport: row.display_on_passport,
    isRevoked:         row.is_revoked,
    createdAt:         row.created_at,
    catalogId,
    activeArtworkUrl,
    // Thumbnail for small render targets (grid tiles/icons). Null when the
    // stamp has no premium composited version yet — client falls back to
    // activeArtworkUrl, then legacy art.
    thumbnailUrl,
  };
}

/** Enriches a stamp array with catalog artwork in one batch query, then formats. */
async function formatStamps(
  sc: ReturnType<typeof getServiceClient>,
  rows: any[],
): Promise<ReturnType<typeof formatStamp>[]> {
  const artworkMap = await buildCatalogArtworkMap(sc, rows);
  return rows.map((r) => formatStamp(r, artworkMap));
}

export default router;
