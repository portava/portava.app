/**
 * §3 `memory_visibility_policies` — the owner's view of a Memory's visibility
 * policy, and the one dimension of it that had no storage. Census H33;
 * migration 3810 (written, unapplied).
 *
 *   GET /memories/:id/visibility-policy
 *     The Memory's effective policy, read from the security_invoker view
 *     `memory_visibility_policy_effective` (§12's fourth control, "visibility"):
 *     the audience (visibility + allow/hide lists, from `memories`), the location
 *     precision rung (from `memories`, with whether this server enforces it), and
 *     the owner's person-visibility ceiling (from 3810's table).
 *   PUT /memories/:id/visibility-policy   { "personVisibilityCeiling": <rung> | null }
 *     Sets the ceiling on how the people on this Memory are disclosed to anyone
 *     but the owner and the person themself; null clears it. The audience and the
 *     precision rung are NOT written here: they stay single-sourced on `memories`
 *     and keep their own writer (PATCH /memories/:id).
 *
 * OWNER ONLY. Another person's Memory, a deleted one and one that does not exist
 * all answer the same 404 not_found "Memory not found" — the API's existing
 * convention (routes/memoryResurfacingControls.ts), so the status code is never
 * an existence oracle.
 * 3810 not applied ⇒ 404 feature_disabled; an unreadable read or a failed write
 * ⇒ 503 degraded_unavailable, never a default.
 *
 * NO FLAG. Everything GET returns, the owner already receives on GET
 * /memories/:id (mapMemory serves allowedUserIds, hiddenUserIds and
 * locationPrecision to the owner only) plus the ceiling they set themself; and a
 * ceiling can only narrow what anyone else sees (memoryVisibilityPolicy.ts
 * `applyPersonCeiling`). Nothing new is exposed to anybody.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { normalizeMemoryPrecision } from "../lib/memoryLocationPrecision.js";
import { readMemoryPrecisionGate } from "../lib/memoryPrecisionGate.js";
import { isPersonVisibility, type PersonVisibilityRung } from "../services/highlights/highlightProjectionPolicy.js";
import {
  PERSON_VISIBILITY_CEILINGS,
  effectiveCeilingOf,
  readEffectivePolicy,
  writePersonCeiling,
} from "../services/memory/memoryVisibilityPolicy.js";
import { reprojectDerivativesAfterNarrowing } from "../services/memoryProjections/narrowingReprojection.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_DEPLOYED = "Memory visibility settings are not available yet.";

/** Re-derivation reason recorded on the §18 registry when a ceiling changes. */
export const PERSON_CEILING_REPROJECTION_REASON = "memory_person_ceiling_changed";

const putBody = z
  .object({
    personVisibilityCeiling: z.union([
      z.enum(PERSON_VISIBILITY_CEILINGS as unknown as [PersonVisibilityRung, ...PersonVisibilityRung[]]),
      z.null(),
    ]),
  })
  .strict();

/** The caller's own, live Memory — or the refusal already sent. */
async function ownMemory(req: Request, res: Response, sc: any, ownerId: string): Promise<{ id: string } | null> {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return null; }
  const { data, error } = await sc.from("memories").select("id, owner_id, state").eq("id", id).maybeSingle();
  if (error) { sendError(res, "degraded_unavailable", "Your Memory could not be read. Please try again."); return null; }
  const row = data as { id: string; owner_id: string; state: string | null } | null;
  if (!row || row.owner_id !== ownerId || row.state === "deleted") { sendError(res, "not_found", "Memory not found"); return null; }
  return { id: row.id };
}

router.get("/memories/:id/visibility-policy", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, auth.user.id);
  if (!mem) return;

  const read = await readEffectivePolicy(sc, auth.user.id, mem.id);
  if (read.state === "absent") { sendError(res, "feature_disabled", NOT_DEPLOYED); return; }
  if (read.state === "unreadable") {
    req.log.error({ memoryId: mem.id, detail: read.detail }, "memory visibility policy: effective policy unreadable");
    sendError(res, "degraded_unavailable", "Your visibility settings could not be read. Please try again.");
    return;
  }
  if (!read.row) { sendError(res, "not_found", "Memory not found"); return; }

  // Whether THIS server applies the precision rung to other people's reads
  // (lib/memoryPrecisionGate.ts): on — at most `chosen`; off — stored, not
  // applied; unreadable — other people get no location on that request.
  const gate = await readMemoryPrecisionGate(sc);
  const stored = read.row.storedCeiling;
  res.json({
    memoryId: mem.id,
    audience: {
      visibility: read.row.visibility,
      allowedUserIds: read.row.allowedUserIds,
      hiddenUserIds: read.row.hiddenUserIds,
    },
    locationPrecision: {
      chosen: normalizeMemoryPrecision(read.row.locationPrecision ?? null),
      enforcement: gate,
    },
    personVisibility: {
      // What everyone the ceiling binds actually gets: an unrecognised stored
      // value is HIDDEN, exactly as the participant ladder reads it.
      ceiling: effectiveCeilingOf(stored),
      recognised: stored === null || stored === undefined || isPersonVisibility(stored),
      updatedAt: read.row.ceilingUpdatedAt,
      appliesTo: "everyone except you and the person themself",
    },
  });
}));

router.put("/memories/:id/visibility-policy", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = putBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", `personVisibilityCeiling must be one of ${PERSON_VISIBILITY_CEILINGS.join(", ")}, or null to clear it`);
    return;
  }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, auth.user.id);
  if (!mem) return;

  const ceiling = parsed.data.personVisibilityCeiling;
  const written = await writePersonCeiling(sc, { memoryId: mem.id, ownerId: auth.user.id, ceiling, now: new Date() });
  if (!written.ok) {
    if (written.reason === "not_deployed") { sendError(res, "feature_disabled", NOT_DEPLOYED); return; }
    req.log.error({ memoryId: mem.id, detail: written.detail }, "memory visibility policy: ceiling write failed");
    sendError(res, "degraded_unavailable", "That could not be saved. Please try again.");
    return;
  }

  // Lead ruling H-4: a privacy change REBUILDS every §18 derivative that carries
  // the Memory (the crew search's shared TripMemoryProjection names its people),
  // read after the write committed. Never throws; the decision has committed, so
  // a failure is logged and the derivative's digest — which folds the ceiling in
  // — still makes it STALE, so the next search rebuilds it before serving.
  const re = await reprojectDerivativesAfterNarrowing(sc as any, { memoryId: mem.id, now: new Date(), reason: PERSON_CEILING_REPROJECTION_REASON });
  if (!re.ok || re.revokedInstead > 0) {
    req.log.error({ memoryId: mem.id, report: re }, "memory visibility policy: derivatives not all re-derived after a ceiling change");
  }
  res.json({ memoryId: mem.id, personVisibilityCeiling: ceiling });
}));

export default router;
