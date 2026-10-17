/**
 * "Remember this together" — §5's shared-experience anchor and participant
 * consent (migration 3997, census H53). The service and its rules are in
 * services/memory/memorySharedExperiences.ts.
 *
 *   GET    /memories/:id/shared-experience                          the experience this Memory is in, as the viewer may see it
 *   POST   /memories/:id/shared-experience/invitations              host: { userId } — invite someone with an approved tag
 *   DELETE /memories/:id/shared-experience/invitations/:userId      host: withdraw a pending invitation
 *   DELETE /memories/:id/shared-experience                          host: end it for everyone
 *   GET    /me/shared-experience-invitations                         my pending invitations
 *   POST   /shared-experience-invitations/:invitationId/accept      { memoryId? } — consent, optionally linking my own Memory
 *   POST   /shared-experience-invitations/:invitationId/decline
 *   POST   /shared-experiences/:experienceId/leave
 *
 * Every route acts as the signed-in person; no route takes an owner, host or
 * invitee id for the actor from the request. Behind memory_shared_experiences_enabled
 * (seeded FALSE; off answers `feature_disabled`) EXCEPT the ways out — decline,
 * withdraw, leave, end — which are NEVER gated (H53). Unreadable: `degraded_unavailable`.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import {
  endSharedExperience,
  inviteToSharedExperience,
  leaveSharedExperience,
  listMyInvitations,
  readSharedExperienceForMemory,
  respondToInvitation,
  withdrawInvitation,
  type SharedResult,
} from "../services/memory/memorySharedExperiences.js";

const router = Router();

function privateResponse(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Authorization");
}

const MESSAGE: Record<string, string> = {
  invalid: "That request is not valid.",
  not_found: "That shared memory or invitation is not available.",
  not_invitable: "That person cannot be invited to remember this together.",
  conflict: "That Memory cannot be linked. Choose one of your own Memories that is not already shared.",
  unavailable: "Shared memories are unavailable right now. Please try again.",
};

function refuse(req: Request, res: Response, r: Extract<SharedResult<unknown>, { ok: false }>): void {
  switch (r.reason) {
    case "disabled": sendError(res, "feature_disabled"); return;
    case "invalid": sendError(res, "invalid_payload", MESSAGE.invalid); return;
    case "not_found": sendError(res, "not_found", MESSAGE.not_found); return;
    case "not_invitable": sendError(res, "forbidden", MESSAGE.not_invitable); return;
    case "conflict": sendError(res, "conflict", MESSAGE.conflict); return;
    default:
      req.log?.error?.({ detail: r.detail }, "shared experiences: refused as unavailable");
      sendError(res, "degraded_unavailable", MESSAGE.unavailable);
  }
}

router.get("/memories/:id/shared-experience", asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const r = await readSharedExperienceForMemory(auth.client, { viewerId: auth.user.id, memoryId: String(req.params.id) });
  if (!r.ok) { refuse(req, res, r); return; }
  res.json({ sharedExperience: r.value });
}));

router.post("/memories/:id/shared-experience/invitations", asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const body = z.object({ userId: z.string() }).strict().safeParse(req.body);
  if (!body.success) { sendError(res, "invalid_payload", "userId is required."); return; }
  const r = await inviteToSharedExperience(auth.client, { hostId: auth.user.id, memoryId: String(req.params.id), inviteeId: body.data.userId });
  if (!r.ok) { refuse(req, res, r); return; }
  res.status(r.value.outcome === "invited" ? 201 : 200).json(r.value);
}));

router.delete("/memories/:id/shared-experience/invitations/:userId", asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const r = await withdrawInvitation(auth.client, { hostId: auth.user.id, memoryId: String(req.params.id), inviteeId: String(req.params.userId) });
  if (!r.ok) { refuse(req, res, r); return; }
  res.json(r.value);
}));

router.delete("/memories/:id/shared-experience", asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const r = await endSharedExperience(auth.client, { hostId: auth.user.id, memoryId: String(req.params.id) });
  if (!r.ok) { refuse(req, res, r); return; }
  res.json(r.value);
}));

router.get("/me/shared-experience-invitations", asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const r = await listMyInvitations(auth.client, auth.user.id);
  if (!r.ok) { refuse(req, res, r); return; }
  res.json({ invitations: r.value });
}));

router.post("/shared-experience-invitations/:invitationId/accept", asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const body = z.object({ memoryId: z.string().nullable().optional() }).strict().safeParse(req.body ?? {});
  if (!body.success) { sendError(res, "invalid_payload", "memoryId must be one of your Memories, or omitted."); return; }
  const r = await respondToInvitation(auth.client, {
    invitationId: String(req.params.invitationId), inviteeId: auth.user.id, accept: true,
    participantMemoryId: body.data.memoryId ?? null,
  });
  if (!r.ok) { refuse(req, res, r); return; }
  res.json(r.value);
}));

router.post("/shared-experience-invitations/:invitationId/decline", asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const r = await respondToInvitation(auth.client, {
    invitationId: String(req.params.invitationId), inviteeId: auth.user.id, accept: false, participantMemoryId: null,
  });
  if (!r.ok) { refuse(req, res, r); return; }
  res.json(r.value);
}));

router.post("/shared-experiences/:experienceId/leave", asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const r = await leaveSharedExperience(auth.client, { experienceId: String(req.params.experienceId), userId: auth.user.id });
  if (!r.ok) { refuse(req, res, r); return; }
  res.json(r.value);
}));

export default router;
