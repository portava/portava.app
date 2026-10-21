/**
 * The owner's §3.6 `memory_visibility_policies` — read and set their own
 * per-audience location-precision ceiling (migration 3997, census H33).
 *
 *   GET    /me/memory-visibility-policy             every audience, null = no ceiling
 *   PUT    /me/memory-visibility-policy/:audience   { locationPrecision }
 *   DELETE /me/memory-visibility-policy/:audience   back to no ceiling
 *
 * Owner-only by construction: every route acts on the signed-in person's own
 * policy and takes no owner id from the request. Behind
 * memory_visibility_policies_enabled (seeded FALSE): off or absent answers
 * `feature_disabled`, an unreadable flag or table answers
 * `degraded_unavailable` — never an empty policy, which would read as "no
 * ceiling" (§28.11).
 *
 * The reader that ENFORCES the policy is not here: it is every non-owner Memory
 * read in routes/memories.ts (protectMemoryRow, through loadMemoryGemContext)
 * and the public search index's source read
 * (services/memoryProjections/derivativeRegistry.ts readPublicIndexSources).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import {
  clearOwnerPolicy,
  readOwnerPolicy,
  setOwnerPolicy,
  type PolicyResult,
} from "../services/memory/memoryVisibilityPolicies.js";

const router = Router();
const base = "/me/memory-visibility-policy";

function privateResponse(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Authorization");
}

function refuse(res: Response, r: Extract<PolicyResult<unknown>, { ok: false }>): void {
  if (r.reason === "disabled") { sendError(res, "feature_disabled"); return; }
  if (r.reason === "invalid") { sendError(res, "invalid_payload", "Choose an audience and a location precision from the list."); return; }
  sendError(res, "degraded_unavailable", "Your location settings could not be loaded or saved right now. Please try again.");
}

router.get(base, asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const r = await readOwnerPolicy(auth.client, auth.user.id);
  if (!r.ok) { if (r.reason !== "disabled") req.log?.error?.({ detail: r.detail }, "memory visibility policy: read failed"); refuse(res, r); return; }
  res.json({ policy: r.value });
}));

router.put(`${base}/:audience`, asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const body = z.object({ locationPrecision: z.string() }).strict().safeParse(req.body);
  if (!body.success) { sendError(res, "invalid_payload", "locationPrecision is required."); return; }
  const r = await setOwnerPolicy(auth.client, auth.user.id, req.params.audience, body.data.locationPrecision, new Date());
  if (!r.ok) { if (r.reason === "unavailable") req.log?.error?.({ detail: r.detail }, "memory visibility policy: write failed"); refuse(res, r); return; }
  res.json(r.value);
}));

router.delete(`${base}/:audience`, asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  const r = await clearOwnerPolicy(auth.client, auth.user.id, req.params.audience);
  if (!r.ok) { if (r.reason === "unavailable") req.log?.error?.({ detail: r.detail }, "memory visibility policy: clear failed"); refuse(res, r); return; }
  res.json(r.value);
}));

export default router;
