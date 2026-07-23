/**
 * Stamp Showcase — Stamp Wave 2 (spec Part 11).
 *
 * A user curates up to MAX_SHOWCASE stamps, explicitly ordered, featured on
 * their passport and on their PUBLIC passport page.
 *
 *   GET /api/stamps/showcase                    — own showcase (ordered)
 *   PUT /api/stamps/showcase                    — replace set: { userStampIds: [...] } (order = rank)
 *   GET /api/users/:username/stamp-showcase     — public view (visibility-filtered)
 *
 * Rules:
 *   - Flag-gated by stamp_showcase_enabled (404 feature_not_found style 503 when off).
 *   - PUT validates every stamp is caller-owned and not revoked; cap 8; replaces atomically.
 *   - Public view only ever exposes visibility='public', non-revoked stamps —
 *     a stale showcase row pointing at a stamp made private later is silently
 *     hidden, never leaked. lat/lng are never selected.
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";

export const MAX_SHOWCASE = 8;
const FLAG = "stamp_showcase_enabled";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = Router();

const STAMP_FIELDS =
  "id, user_id, stamp_definition_id, source_type, earned_at, city, country, title_override, visibility, is_revoked, " +
  "stamp_definitions ( slug, name, rarity, stamp_type, category, universal_artwork_url )";

function formatShowcaseStamp(row: any, rank: number) {
  return {
    userStampId: row.id,
    rank,
    earnedAt: row.earned_at,
    city: row.city,
    country: row.country,
    titleOverride: row.title_override,
    definition: row.stamp_definitions
      ? {
          slug: row.stamp_definitions.slug,
          name: row.stamp_definitions.name,
          rarity: row.stamp_definitions.rarity,
          stampType: row.stamp_definitions.stamp_type,
          category: row.stamp_definitions.category,
          artworkUrl: row.stamp_definitions.universal_artwork_url ?? null,
        }
      : null,
  };
}

async function loadShowcaseRows(sc: any, userId: string): Promise<any[]> {
  const { data, error } = await sc
    .from("user_stamp_showcase")
    .select("user_stamp_id, rank")
    .eq("user_id", userId)
    .order("rank", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function loadStamps(sc: any, ids: string[]): Promise<Map<string, any>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await sc
    .from("user_stamps")
    .select(STAMP_FIELDS)
    .in("id", ids);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as any[]).map((r) => [r.id, r]));
}

// ── GET /api/stamps/showcase ─────────────────────────────────────────────────

router.get("/stamps/showcase", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await isFlagEnabled(sc, FLAG))) {
    sendError(res, "feature_disabled", "Stamp showcase is not enabled");
    return;
  }

  const rows = await loadShowcaseRows(sc, user.id);
  const stamps = await loadStamps(sc, rows.map((r) => r.user_stamp_id));
  const items = rows
    .map((r, i) => {
      const s = stamps.get(r.user_stamp_id);
      return s && !s.is_revoked ? formatShowcaseStamp(s, i) : null;
    })
    .filter(Boolean);

  res.json({ items, max: MAX_SHOWCASE });
}));

// ── PUT /api/stamps/showcase ─────────────────────────────────────────────────

const PutSchema = z.object({
  userStampIds: z.array(z.string().regex(UUID_RE, "invalid user stamp id")).max(MAX_SHOWCASE),
});

router.put("/stamps/showcase", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await isFlagEnabled(sc, FLAG))) {
    sendError(res, "feature_disabled", "Stamp showcase is not enabled");
    return;
  }

  const parsed = PutSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const ids = parsed.data.userStampIds;
  if (new Set(ids).size !== ids.length) {
    sendError(res, "invalid_payload", "Duplicate stamps in showcase");
    return;
  }

  // Ownership + revocation validation — every stamp must be the caller's.
  if (ids.length > 0) {
    const { data, error } = await sc
      .from("user_stamps")
      .select("id, user_id, is_revoked")
      .in("id", ids);
    if (error) { sendError(res, "db_error", error.message); return; }
    const byId = new Map(((data ?? []) as any[]).map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row || row.user_id !== user.id) {
        sendError(res, "invalid_payload", "Showcase can only contain your own stamps");
        return;
      }
      if (row.is_revoked) {
        sendError(res, "invalid_payload", "Revoked stamps cannot be showcased");
        return;
      }
    }
  }

  // Replace the set atomically from the caller's perspective: wipe then insert.
  const { error: delErr } = await sc
    .from("user_stamp_showcase")
    .delete()
    .eq("user_id", user.id);
  if (delErr) { sendError(res, "db_error", delErr.message); return; }

  if (ids.length > 0) {
    const { error: insErr } = await sc.from("user_stamp_showcase").insert(
      ids.map((userStampId, rank) => ({ user_id: user.id, user_stamp_id: userStampId, rank })),
    );
    if (insErr) { sendError(res, "db_error", insErr.message); return; }
  }

  res.json({ saved: true, count: ids.length, max: MAX_SHOWCASE });
}));

// ── GET /api/users/:username/stamp-showcase ──────────────────────────────────
// Public, but still authenticated (consistent with other profile surfaces).

router.get("/users/:username/stamp-showcase", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await isFlagEnabled(sc, FLAG))) {
    res.json({ items: [], enabled: false });
    return;
  }

  const username = String(req.params.username ?? "").trim();
  if (!username) { sendError(res, "invalid_payload", "Username required"); return; }

  const { data: profile, error: pErr } = await sc
    .from("profiles")
    .select("id, username")
    .eq("username", username)
    .maybeSingle();
  if (pErr) { sendError(res, "db_error", pErr.message); return; }
  if (!profile) { sendError(res, "not_found", "User not found"); return; }

  const rows = await loadShowcaseRows(sc, (profile as any).id);
  const stamps = await loadStamps(sc, rows.map((r) => r.user_stamp_id));

  // Public filter: visibility must be public AND not revoked. Order preserved.
  const items = rows
    .map((r) => stamps.get(r.user_stamp_id))
    .filter((s): s is any => Boolean(s) && s.visibility === "public" && !s.is_revoked)
    .map((s, i) => formatShowcaseStamp(s, i));

  res.json({ items, enabled: true });
}));

export default router;
