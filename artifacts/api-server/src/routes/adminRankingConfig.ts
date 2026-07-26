/**
 * Admin Ranking Config & Ops routes
 *
 * All routes require admin role (same requireAdmin guard as adminRankingMetrics).
 *
 * Config CRUD:
 *   GET  /api/admin/ranking/config              — all ranking_config rows with descriptions
 *   PUT  /api/admin/ranking/config              — update a single key's value (validated)
 *
 * Feature flag management:
 *   GET  /api/admin/ranking/flags               — all ranking-related feature_flags rows
 *   PUT  /api/admin/ranking/flags/:key          — toggle a ranking feature flag (audit-logged)
 *
 * Observability:
 *   GET  /api/admin/ranking/suspicious          — top-50 creators with high spam/repetition penalties
 *   GET  /api/admin/ranking/debug-samples       — recent ranking_debug_samples (max 200 rows)
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { invalidateRankingConfigCache } from "../services/ranking/rankingConfig.js";

const router = Router();

// ── Admin guard ───────────────────────────────────────────────────────────────

async function requireAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

// ── Config key metadata ───────────────────────────────────────────────────────
// Describes every known ranking_config key: its human description and the
// valid numeric range for server-side validation.

interface ConfigKeyMeta {
  description: string;
  min: number;
  max: number;
}

const CONFIG_KEY_META: Record<string, ConfigKeyMeta> = {
  // Weights (0–100; all weights together should sum to ≤100)
  "ranking.weights.relevance":    { description: "Relevance score weight (%)",           min: 0, max: 100 },
  "ranking.weights.freshness":    { description: "Freshness score weight (%)",           min: 0, max: 100 },
  "ranking.weights.quality":      { description: "Quality score weight (%)",             min: 0, max: 100 },
  "ranking.weights.activity":     { description: "Creator activity score weight (%)",    min: 0, max: 100 },
  "ranking.weights.engagement":   { description: "Engagement score weight (%)",          min: 0, max: 100 },
  "ranking.weights.exploration":  { description: "Exploration slot score weight (%)",    min: 0, max: 100 },
  "ranking.weights.underexposure":{ description: "Underexposure boost score weight (%)", min: 0, max: 100 },

  // Penalties (0–25)
  "ranking.penalties.repetition":       { description: "Repetition penalty deduction",        min: 0, max: 25 },
  "ranking.penalties.fatigue":          { description: "Viewer fatigue penalty deduction",     min: 0, max: 25 },
  "ranking.penalties.negativeFeedback": { description: "Negative feedback penalty deduction",  min: 0, max: 25 },

  // Feed shares (0–100; all shares together should sum to ≤100)
  "ranking.shares.relevance":     { description: "Feed share for relevance pool (%)",      min: 0, max: 100 },
  "ranking.shares.activeCreator": { description: "Feed share for active-creator pool (%)", min: 0, max: 100 },
  "ranking.shares.underexposed":  { description: "Feed share for underexposed pool (%)",   min: 0, max: 100 },
  "ranking.shares.newUser":       { description: "Feed share for new-user pool (%)",       min: 0, max: 100 },
  "ranking.shares.exploration":   { description: "Feed share for exploration pool (%)",    min: 0, max: 100 },

  // Activity params
  "ranking.activity.maxBoost":          { description: "Maximum activity boost added to score",   min: 0, max: 50  },
  "ranking.activity.decayHalfLifeDays": { description: "Activity score decay half-life (days)",   min: 1, max: 365 },
  "ranking.activity.capScore":          { description: "Maximum activity score (cap)",             min: 1, max: 200 },

  // Creator caps
  "ranking.caps.maxPerPage":           { description: "Max items from one creator per feed page",       min: 1, max: 20  },
  "ranking.caps.maxConsecutive":       { description: "Max consecutive items from one creator",          min: 1, max: 10  },
  "ranking.caps.fatigueHalfLifeHours": { description: "Fatigue score decay half-life (hours)",          min: 1, max: 720 },
  "ranking.caps.fatigueThreshold":     { description: "Impression count that triggers fatigue window",  min: 1, max: 100 },
};

/**
 * Validate that a proposed value for the given ranking_config key is within
 * the safe range defined in CONFIG_KEY_META.
 *
 * Returns an error string if invalid, or null if valid.
 */
export function validateConfigValue(key: string, value: number): string | null {
  const meta = CONFIG_KEY_META[key];
  if (!meta) {
    return `Unknown config key: ${key}. Only known ranking.* keys may be updated.`;
  }
  if (!Number.isFinite(value)) {
    return `Value must be a finite number, got: ${value}`;
  }
  if (value < meta.min || value > meta.max) {
    return `Value ${value} is out of range [${meta.min}, ${meta.max}] for key ${key}`;
  }
  return null;
}

// ── GET /admin/ranking/config ─────────────────────────────────────────────────

router.get("/admin/ranking/config", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("ranking_config")
    .select("key, value")
    .like("key", "ranking.%")
    .order("key");

  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  const rows: any[] = (data as any[]) ?? [];

  // Merge DB rows with metadata descriptions; include known keys even if
  // not yet written to the DB (so the admin sees the full config surface).
  const configMap: Record<string, { value: number | null; description: string; min: number; max: number }> = {};

  // Seed with all known keys (default value null until set in DB)
  for (const [k, meta] of Object.entries(CONFIG_KEY_META)) {
    configMap[k] = { value: null, ...meta };
  }

  // Overwrite with DB values
  for (const row of rows) {
    const key = row.key as string;
    const meta = CONFIG_KEY_META[key];
    configMap[key] = {
      value: Number(row.value),
      description: meta?.description ?? key,
      min: meta?.min ?? 0,
      max: meta?.max ?? Number.MAX_SAFE_INTEGER,
    };
  }

  res.json({ config: configMap });
}));

// ── PUT /admin/ranking/config ─────────────────────────────────────────────────

router.put("/admin/ranking/config", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const { key, value } = req.body ?? {};

  if (typeof key !== "string" || key.trim() === "") {
    res.status(400).json({ error: "validation_error", message: "key is required" });
    return;
  }
  if (typeof value !== "number") {
    res.status(400).json({ error: "validation_error", message: "value must be a number" });
    return;
  }

  const validationError = validateConfigValue(key, value);
  if (validationError) {
    res.status(400).json({ error: "validation_error", message: validationError });
    return;
  }

  // Read current value for audit log
  const { data: existing } = await sc
    .from("ranking_config")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  const oldValue = existing ? Number((existing as any).value) : null;

  // Upsert the new value
  const { error: upsertErr } = await sc
    .from("ranking_config")
    .upsert({ key, value }, { onConflict: "key" });

  if (upsertErr) {
    sendError(res, "db_error", upsertErr.message);
    return;
  }

  // Invalidate the in-memory cache so the next read picks up the new value
  invalidateRankingConfigCache();

  // Write audit log (best-effort — never blocks the config update)
  try {
    await sc.from("ranking_config_audit_log").insert({
      config_key:         key,
      changed_by_user_id: userId,
      old_value:          oldValue,
      new_value:          value,
      changed_at:         new Date().toISOString(),
    });
  } catch {
    // Audit table may not exist yet — non-fatal
  }

  res.json({ ok: true, key, value, old_value: oldValue });
}));

// ── GET /admin/ranking/flags ──────────────────────────────────────────────────

router.get("/admin/ranking/flags", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("feature_flags")
    .select("flag, enabled, description, updated_at")
    .like("flag", "RANKING_%")
    .order("flag");

  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ flags: (data as any[]) ?? [] });
}));

// ── PUT /admin/ranking/flags/:key ─────────────────────────────────────────────

router.put("/admin/ranking/flags/:key", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const flagKey = req.params["key"];
  if (!flagKey || !flagKey.startsWith("RANKING_")) {
    res.status(400).json({
      error:   "validation_error",
      message: "Flag key must start with RANKING_",
    });
    return;
  }

  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    res.status(400).json({
      error:   "validation_error",
      message: "enabled (boolean) is required in the request body",
    });
    return;
  }

  // Read current value for audit log
  const { data: existing, error: readErr } = await sc
    .from("feature_flags")
    .select("flag, enabled")
    .eq("flag", flagKey)
    .maybeSingle();

  if (readErr) {
    sendError(res, "db_error", readErr.message);
    return;
  }
  if (!existing) {
    res.status(404).json({ error: "not_found", message: `Flag ${flagKey} not found` });
    return;
  }

  const oldEnabled: boolean = Boolean((existing as any).enabled);

  // Update the flag
  const { error: updateErr } = await sc
    .from("feature_flags")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("flag", flagKey);

  if (updateErr) {
    sendError(res, "db_error", updateErr.message);
    return;
  }

  // Write audit log (pattern mirrors feature_flag_audit_log from migration 0118)
  try {
    await sc.from("feature_flag_audit_log").insert({
      flag:               flagKey,
      changed_by_user_id: userId,
      old_enabled:        oldEnabled,
      new_enabled:        enabled,
      changed_at:         new Date().toISOString(),
    });
  } catch {
    // Best-effort — never blocks the flag update
  }

  res.json({ ok: true, flag: flagKey, old_enabled: oldEnabled, new_enabled: enabled });
}));

// ── GET /admin/ranking/suspicious ────────────────────────────────────────────

router.get("/admin/ranking/suspicious", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  // Fetch top-50 creators ordered by total penalty score descending.
  // We need the raw scores plus user handle (display-name privacy rule applies:
  // show handle (username) always; show real name only if opted in).
  const { data, error } = await sc
    .from("creator_activity_scores")
    .select(
      "user_id, score, spam_penalty, repetition_penalty, updated_at",
    )
    .order("spam_penalty", { ascending: false })
    .limit(50);

  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  const rows: any[] = (data as any[]) ?? [];
  if (rows.length === 0) {
    res.json({ suspicious: [] });
    return;
  }

  // Resolve handles — display-name privacy rule: @handle is always shown;
  // real name only when show_real_name = true in profile_privacy_settings.
  const userIds: string[] = rows.map((r) => r.user_id);

  const [profilesResult, privacyResult] = await Promise.allSettled([
    sc
      .from("profiles")
      .select("id, username, display_name")
      .in("id", userIds),
    sc
      .from("profile_privacy_settings")
      .select("user_id, show_real_name")
      .in("user_id", userIds),
  ]);

  const profiles: Record<string, { username: string; display_name: string | null }> = {};
  if (profilesResult.status === "fulfilled") {
    for (const p of (profilesResult.value.data as any[]) ?? []) {
      profiles[p.id] = { username: p.username ?? "", display_name: p.display_name ?? null };
    }
  }

  const showRealName: Record<string, boolean> = {};
  if (privacyResult.status === "fulfilled") {
    for (const p of (privacyResult.value.data as any[]) ?? []) {
      showRealName[p.user_id] = Boolean(p.show_real_name);
    }
  }

  const suspicious = rows.map((r) => {
    const profile = profiles[r.user_id];
    const realNameAllowed = showRealName[r.user_id] ?? false;
    return {
      user_id:            r.user_id,
      handle:             profile?.username ?? null,
      display_name:       realNameAllowed ? (profile?.display_name ?? null) : null,
      score:              r.score,
      spam_penalty:       r.spam_penalty,
      repetition_penalty: r.repetition_penalty,
      updated_at:         r.updated_at,
    };
  });

  res.json({ suspicious });
}));

// ── GET /admin/ranking/debug-samples ─────────────────────────────────────────

const DEBUG_SAMPLES_MAX = 200;

router.get("/admin/ranking/debug-samples", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const surface       = req.query["surface"]          as string | undefined;
  const content_type  = req.query["content_type"]     as string | undefined;
  const ranking_version = req.query["ranking_version"] as string | undefined;
  const rawLimit      = parseInt((req.query["limit"] as string) ?? "50");
  const limit         = Math.min(DEBUG_SAMPLES_MAX, Math.max(1, isNaN(rawLimit) ? 50 : rawLimit));

  let query = sc
    .from("ranking_debug_samples")
    .select("*")
    .order("sampled_at", { ascending: false })
    .limit(limit);

  if (surface)         query = query.eq("surface",         surface);
  if (content_type)    query = query.eq("content_type",    content_type);
  if (ranking_version) query = query.eq("ranking_version", ranking_version);

  const { data, error } = await query;

  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ samples: (data as any[]) ?? [], limit });
}));

export default router;
