/**
 * Search history endpoints
 *
 * GET    /api/me/search-history          — recent searches for the current user
 * POST   /api/me/search-history          — upsert a query term
 * DELETE /api/me/search-history          — clear all terms
 * DELETE /api/me/search-history?q=<term> — clear one specific term
 *
 * Row ownership enforced by service-role writes + RLS on search_history.
 * Rate limited: 30 req/min per user.
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { checkRateLimit } from "../lib/rateLimit";

const router = Router();

const MAX_HISTORY = 50;
const GET_LIMIT   = 20;

// ── GET /api/me/search-history ─────────────────────────────────────────────────

router.get("/me/search-history", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const rawLimit = parseInt(String(req.query.limit ?? GET_LIMIT), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : GET_LIMIT;

  try {
    const { data, error } = await sc
      .from("search_history")
      .select("id, query, search_type, searched_at")
      .eq("user_id", user.id)
      .order("searched_at", { ascending: false })
      .limit(limit);

    if (error) {
      sendError(res, "db_error", "Failed to fetch search history");
      return;
    }

    res.status(200).json({ history: data ?? [] });
  } catch {
    sendError(res, "db_error", "Failed to fetch search history");
  }
});

// ── POST /api/me/search-history ────────────────────────────────────────────────

router.post("/me/search-history", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const rl = checkRateLimit("search_history_write", user.id, 30, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many requests. Please wait.");
    return;
  }

  const body = req.body as Record<string, unknown>;
  const rawQuery = body.query;
  if (typeof rawQuery !== "string" || rawQuery.trim().length < 1) {
    sendError(res, "invalid_payload", "query is required");
    return;
  }
  const trimmedQuery = rawQuery.trim().slice(0, 200);
  const searchType =
    typeof body.search_type === "string" ? body.search_type.slice(0, 50) : "all";

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  try {
    const { error: upsertErr } = await sc
      .from("search_history")
      .upsert(
        {
          user_id:     user.id,
          query:       trimmedQuery,
          search_type: searchType,
          searched_at: new Date().toISOString(),
        },
        { onConflict: "user_id,query,search_type" },
      );

    if (upsertErr) {
      sendError(res, "db_error", "Failed to save search history");
      return;
    }

    // Non-blocking prune: ignore errors
    void pruneOldest(sc, user.id);

    res.status(200).json({ ok: true });
  } catch {
    sendError(res, "db_error", "Failed to save search history");
  }
});

// ── DELETE /api/me/search-history ─────────────────────────────────────────────

router.delete("/me/search-history", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const specificQuery = req.query.q ? String(req.query.q).trim() : null;

  try {
    let del = sc.from("search_history").delete().eq("user_id", user.id);
    if (specificQuery) del = del.eq("query", specificQuery);

    const { error } = await del;
    if (error) {
      sendError(res, "db_error", "Failed to clear search history");
      return;
    }

    res.status(200).json({ ok: true });
  } catch {
    sendError(res, "db_error", "Failed to clear search history");
  }
});

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Delete the oldest entries beyond MAX_HISTORY.
 * Called non-blocking after each POST so the history cap is enforced eventually.
 */
async function pruneOldest(sc: any, userId: string): Promise<void> {
  try {
    const { data } = await sc
      .from("search_history")
      .select("id")
      .eq("user_id", userId)
      .order("searched_at", { ascending: false })
      .range(MAX_HISTORY, MAX_HISTORY + 99);

    if (data && (data as any[]).length > 0) {
      const ids = (data as any[]).map((r: any) => r.id as string);
      await sc.from("search_history").delete().in("id", ids);
    }
  } catch {
    // non-fatal
  }
}

export default router;
