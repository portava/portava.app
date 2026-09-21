/**
 * Telegraph §21 — `GET /api/telegraph/search` and
 * `GET /api/threads/:threadId/search`, plus `GET /api/threads/:threadId/ask`.
 *
 * census-telegraph T272: "There is no conversation search of any kind.
 * routes/messaging.ts (2,731 lines, 30 endpoints) contains no search route, and
 * neither does routes/groupChat.ts. The inbox filter filters loaded threads
 * client-side." These are the routes.
 *
 * THE THREAD-SCOPED ROUTE DOES NOT AUTHORIZE SEPARATELY
 * ====================================================
 * `/threads/:threadId/search` passes the thread id into the SAME scope resolver
 * the global search uses, as a narrowing filter on the caller's own membership
 * query — it does not first check membership and then search. That is
 * deliberate: two authorization paths for one question is how they drift, and a
 * thread the caller is not a member of simply produces an empty authorized
 * scope and therefore an empty result, with no separate 403 to distinguish
 * "empty" from "not yours".
 *
 * The absence of that 403 is the point. A 403 here would make the endpoint a
 * thread-existence oracle, exactly as it would on the capability route.
 */

import { Router } from "express";

import { requireUser, sendError } from "../../lib/http.js";
import { getServiceClient } from "../../lib/supabase.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { TELEGRAPH_SEARCH_BUCKETS, type TelegraphSearchBucket } from "../../domain/telegraph/contracts/conversationSearch.js";
import { askConversation, searchConversations } from "../../services/telegraphSearch.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_LEN = 120;

function parseBuckets(raw: unknown): TelegraphSearchBucket[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const allowed = new Set<string>(TELEGRAPH_SEARCH_BUCKETS);
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => allowed.has(s)) as TelegraphSearchBucket[];
}

router.get(
  "/telegraph/search",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;

    const q = String(req.query["q"] ?? "").slice(0, MAX_QUERY_LEN);
    if (q.trim().length < 2) {
      sendError(res, "invalid_payload", "Search needs at least two characters");
      return;
    }

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    const result = await searchConversations(sc, auth.user.id, q, {
      buckets: parseBuckets(req.query["types"]),
      limit: Number(req.query["limit"] ?? 40),
    });
    res.status(200).json(result);
  }),
);

router.get(
  "/threads/:threadId/search",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;

    const threadId = String(req.params["threadId"] ?? "");
    if (!UUID_RE.test(threadId)) { sendError(res, "invalid_payload", "Invalid thread id"); return; }

    const q = String(req.query["q"] ?? "").slice(0, MAX_QUERY_LEN);
    if (q.trim().length < 2) {
      sendError(res, "invalid_payload", "Search needs at least two characters");
      return;
    }

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    const result = await searchConversations(sc, auth.user.id, q, {
      conversationId: threadId,
      buckets: parseBuckets(req.query["types"]),
      limit: Number(req.query["limit"] ?? 40),
    });
    res.status(200).json(result);
  }),
);

router.get(
  "/threads/:threadId/ask",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;

    const threadId = String(req.params["threadId"] ?? "");
    if (!UUID_RE.test(threadId)) { sendError(res, "invalid_payload", "Invalid thread id"); return; }

    const q = String(req.query["q"] ?? "").slice(0, MAX_QUERY_LEN);
    if (q.trim().length < 2) {
      sendError(res, "invalid_payload", "Ask needs at least two characters");
      return;
    }

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    const { structured, prose, result } = await askConversation(sc, auth.user.id, threadId, q);
    res.status(200).json({
      query: result.query,
      // §21: structured plans/decisions/actions are PREFERRED over inferred
      // prose, so they are a separate field a caller answers from first — not
      // merely sorted higher in one list where a client would have to know to
      // look at the top.
      structured,
      prose,
      counts: result.counts,
      degraded: result.degraded,
    });
  }),
);

export default router;
