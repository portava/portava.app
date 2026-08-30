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
import { logger } from "../lib/logger";

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
      sendError(res, "db_error", "Failed to fetch search history", { exposeDetail: true });
      return;
    }

    res.status(200).json({ history: data ?? [] });
  } catch {
    sendError(res, "db_error", "Failed to fetch search history", { exposeDetail: true });
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
    const { data: upserted, error: upsertErr } = await sc
      .from("search_history")
      .upsert(
        {
          user_id:     user.id,
          query:       trimmedQuery,
          search_type: searchType,
          searched_at: new Date().toISOString(),
        },
        { onConflict: "user_id,query,search_type" },
      )
      .select("id")
      .single();

    if (upsertErr) {
      sendError(res, "db_error", "Failed to save search history", { exposeDetail: true });
      return;
    }

    // Non-blocking prune: ignore errors
    void pruneOldest(sc, user.id);

    // Return the persisted row id so the UI can replace its optimistic
    // synthetic id with the real server id before allowing per-item delete.
    res.status(200).json({ ok: true, id: (upserted as { id: string } | null)?.id ?? null });
  } catch {
    sendError(res, "db_error", "Failed to save search history", { exposeDetail: true });
  }
});

// ── DELETE /api/me/search-history ─────────────────────────────────────────────

router.delete("/me/search-history", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const specificId    = req.query.id ? String(req.query.id).trim() : null;
  const specificQuery = req.query.q  ? String(req.query.q).trim()  : null;

  try {
    let del = sc.from("search_history").delete().eq("user_id", user.id);
    if (specificId)    del = del.eq("id",    specificId);
    else if (specificQuery) del = del.eq("query", specificQuery);

    const { error } = await del;
    if (error) {
      sendError(res, "db_error", "Failed to clear search history", { exposeDetail: true });
      return;
    }

    res.status(200).json({ ok: true });
  } catch {
    sendError(res, "db_error", "Failed to clear search history", { exposeDetail: true });
  }
});

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Delete the oldest entries beyond MAX_HISTORY.
 * Called non-blocking after each POST so the history cap is enforced eventually.
 */
async function pruneOldest(sc: any, userId: string): Promise<void> {
  try {
    // supabase-js resolves rather than throws on a DB error — unchecked, a
    // failing prune silently disabled the history cap, so search history grew
    // without bound (a retention promise the API stops keeping). Still
    // non-fatal, but failures are now visible in the server log.
    const { data, error: selErr } = await sc
      .from("search_history")
      .select("id")
      .eq("user_id", userId)
      .order("searched_at", { ascending: false })
      .range(MAX_HISTORY, MAX_HISTORY + 99);
    if (selErr) {
      logger.warn({ err: selErr, userId }, "pruneOldest: search_history select failed — cap not enforced this round");
      return;
    }

    if (data && (data as any[]).length > 0) {
      const ids = (data as any[]).map((r: any) => r.id as string);
      const { error: delErr } = await sc.from("search_history").delete().in("id", ids);
      if (delErr) {
        logger.warn({ err: delErr, userId, count: ids.length },
          "pruneOldest: search_history delete failed — cap not enforced this round");
      }
    }
  } catch (err) {
    // non-fatal, but observable
    logger.warn({ err, userId }, "pruneOldest: unexpected error");
  }
}

export default router;
