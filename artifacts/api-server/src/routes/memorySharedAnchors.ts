/**
 * §5 "Remember this together" over HTTP — the shared-experience anchor's server
 * half. Census-highlights-memories H53 (B58 cluster MEM-ANCHOR-1; migration 3805,
 * unapplied; the client is cluster MEM-ANCHOR-2, travel-buddy-standalone/src/features/memories/shared/).
 *
 *   POST /memories/:id/shared-anchor/invites  { userId }   the HOST invites a person
 *                                                          holding an APPROVED tag on
 *                                                          their own live Memory :id
 *   GET  /me/memory-shared-anchors                         the caller's invitations and
 *                                                          accepted anchors
 *   GET  /memory-shared-anchors/:anchorId                  one anchor, as the caller may
 *                                                          see it
 *   POST /memory-shared-anchors/:anchorId/accept { memoryId? }  accept, optionally
 *                                                          linking the caller's OWN Memory
 *   POST /memory-shared-anchors/:anchorId/decline           (GET /memories/:id/shared-anchor/invitable, MEM-ANCHOR-2: at the end)
 *   POST /memory-shared-anchors/:anchorId/leave            at any time
 *
 * THE FLAG COMES FIRST, BEFORE AUTHENTICATION. `memory_shared_anchors_enabled`
 * (3805, seeded FALSE) OFF or absent: every route here calls `next("route")`, so
 * the request continues exactly as it would if this router were not mounted and
 * ends at the API's own "no such route" — same status, same body, and nothing
 * read past the flag or written (memorySharedAnchors.test.ts proves it against an
 * app with this router removed). Unreadable: 503, never "does not exist".
 *
 * Every rule — who may be invited, what a member sees, what acceptance shows,
 * blocks, notification, dissolution — is in services/memory/memorySharedAnchors.ts.
 * Not a member, declined, left, a hidden invitation, an anchor that does not
 * exist: one 404.
 *
 * Mounted from routes/index.ts on its last line (that file is cited by line).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import {
  acceptInvitation,
  anchorViewFor,
  declineInvitation,
  inviteToSharedAnchor, invitableFor,
  leaveSharedAnchor,
  listAnchorsFor,
  notifyInvitedInApp,
  readSharedAnchorsFlag,
  type RespondOutcome,
} from "../services/memory/memorySharedAnchors.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** OFF / absent ⇒ not here (fall through). Unreadable ⇒ 503. ON ⇒ the route runs. */
const whenEnabled = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const flag = await readSharedAnchorsFlag(sc);
  if (flag === "on") { next(); return; }
  if (flag === "unreadable") {
    (req as any).log?.error?.({ flag: "memory_shared_anchors_enabled" }, "memory shared anchors: flag unreadable — refusing rather than answering as if the feature did not exist");
    sendError(res, "degraded_unavailable", "This is not available right now. Please try again.");
    return;
  }
  next("route");
});

function unavailable(req: Request, res: Response, detail: string): void {
  (req as any).log?.error?.({ detail }, "memory shared anchors: read or write failed — refusing rather than answering from a partial read");
  sendError(res, "degraded_unavailable", "This could not be loaded right now. Please try again.");
}

function sendRespond(req: Request, res: Response, anchorId: string, status: "accepted" | "declined" | "left", out: RespondOutcome): void {
  switch (out.kind) {
    case "ok": res.json({ anchorId, status, ...(status === "accepted" ? { memoryId: out.memoryId } : {}) }); return;
    case "not_found": sendError(res, "not_found", "Not found"); return;
    case "memory_not_found": sendError(res, "not_found", "That Memory was not found among yours.", { reason: "memory_not_found" }); return;
    case "memory_already_linked": sendError(res, "conflict", "That Memory is already linked to another shared Memory.", { reason: "memory_already_linked" }); return;
    case "unreadable": case "write_failed": unavailable(req, res, out.detail); return;
  }
}

// ── POST /memories/:id/shared-anchor/invites ──────────────────────────────────

router.post("/memories/:id/shared-anchor/invites", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const memoryId = String(req.params.id ?? "");
  if (!UUID_RE.test(memoryId)) { sendError(res, "not_found", "Memory not found"); return; }
  const inviteeId = typeof req.body?.userId === "string" ? req.body.userId : "";
  if (!UUID_RE.test(inviteeId)) { sendError(res, "invalid_payload", "userId must be a user id"); return; }
  const rl = checkRateLimit("memory_shared_anchor_invite", auth.user.id, 30, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many invitations. Please wait a moment.");
    return;
  }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const out = await inviteToSharedAnchor(sc, memoryId, auth.user.id, inviteeId);
  switch (out.kind) {
    case "invited": {
      await notifyInvitedInApp(sc, out.anchorId, auth.user.id, inviteeId);
      res.status(201).json({ anchorId: out.anchorId, invitee: { userId: inviteeId, status: "invited" } });
      return;
    }
    case "not_found": sendError(res, "not_found", "Memory not found"); return;
    case "not_invitable":
      sendError(res, "forbidden", "Only someone who approved a tag on this Memory can be invited to remember it together.", { reason: "not_invitable" });
      return;
    case "already_invited": sendError(res, "conflict", "This person has already been asked.", { reason: "already_invited" }); return;
    case "not_host":
      sendError(res, "conflict", "This Memory is linked to a shared Memory someone else started; only they can invite.", { reason: "not_host" });
      return;
    case "unreadable": case "write_failed": unavailable(req, res, out.detail); return;
  }
}));

// ── GET /me/memory-shared-anchors ─────────────────────────────────────────────

router.get("/me/memory-shared-anchors", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const out = await listAnchorsFor(sc, auth.user.id);
  if (out.kind === "unreadable") { unavailable(req, res, out.detail); return; }
  res.json({ anchors: out.anchors });
}));

// ── GET /memory-shared-anchors/:anchorId ─────────────────────────────────────

router.get("/memory-shared-anchors/:anchorId", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const anchorId = String(req.params.anchorId ?? "");
  if (!UUID_RE.test(anchorId)) { sendError(res, "not_found", "Not found"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const out = await anchorViewFor(sc, anchorId, auth.user.id);
  if (out.kind === "not_found") { sendError(res, "not_found", "Not found"); return; }
  if (out.kind === "unreadable") { unavailable(req, res, out.detail); return; }
  res.json({ anchor: out.view });
}));

// ── POST /memory-shared-anchors/:anchorId/{accept,decline,leave} ─────────────

router.post("/memory-shared-anchors/:anchorId/accept", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const anchorId = String(req.params.anchorId ?? "");
  if (!UUID_RE.test(anchorId)) { sendError(res, "not_found", "Not found"); return; }
  const raw = req.body?.memoryId;
  if (raw !== undefined && raw !== null && !(typeof raw === "string" && UUID_RE.test(raw))) {
    sendError(res, "invalid_payload", "memoryId must be one of your Memory ids, or absent");
    return;
  }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  sendRespond(req, res, anchorId, "accepted", await acceptInvitation(sc, anchorId, auth.user.id, typeof raw === "string" ? raw : null));
}));

router.post("/memory-shared-anchors/:anchorId/decline", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const anchorId = String(req.params.anchorId ?? "");
  if (!UUID_RE.test(anchorId)) { sendError(res, "not_found", "Not found"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  sendRespond(req, res, anchorId, "declined", await declineInvitation(sc, anchorId, auth.user.id));
}));

router.post("/memory-shared-anchors/:anchorId/leave", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const anchorId = String(req.params.anchorId ?? "");
  if (!UUID_RE.test(anchorId)) { sendError(res, "not_found", "Not found"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  sendRespond(req, res, anchorId, "left", await leaveSharedAnchor(sc, anchorId, auth.user.id));
}));

// ── GET /memories/:id/shared-anchor/invitable (B58 cluster MEM-ANCHOR-2) ──────
// Who the OWNER of Memory :id can invite right now — the list the app renders,
// so the app never infers eligibility from tag statuses itself. Behind the same
// flag gate as every route above; a Memory that is not the caller's own and live
// is the invite's own 404; an unreadable read (blocks included) is a 503, never
// a list. The rules are `invitableFor` in services/memory/memorySharedAnchors.ts.
router.get("/memories/:id/shared-anchor/invitable", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const memoryId = String(req.params.id ?? "");
  if (!UUID_RE.test(memoryId)) { sendError(res, "not_found", "Memory not found"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const out = await invitableFor(sc, memoryId, auth.user.id);
  if (out.kind === "not_found") { sendError(res, "not_found", "Memory not found"); return; }
  if (out.kind === "unreadable") { unavailable(req, res, out.detail); return; }
  res.json({ people: out.people });
}));

export default router;
