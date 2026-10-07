/**
 * §3 `memory_corrections` (migration 3673, written and unapplied): the owner's
 * corrections to their Memory's place. Census H28, H48, H49, H73, H242.
 *
 *   GET  /memories/:id/corrections   the owner's current word: the asserted
 *                                    place reference and every rejected value
 *   POST /memories/:id/corrections   reject a place: {field:"place",
 *                                    kind:"reject", placeId | canonicalLocationId}
 *
 * An ASSERTION is made by changing the Memory's place (PATCH /memories/:id),
 * which writes the Memory and records the correction together. This route
 * records only a rejection, which is a negative constraint and changes no
 * Memory field. That keeps one writer for the place a Memory shows.
 *
 * OWNER ONLY. Another person's Memory is a 404, the same answer as a Memory
 * that does not exist (no oracle). A deleted Memory is a 404 too.
 * 3673 not applied ⇒ 404 feature_disabled; unreadable ⇒ 503, never "no corrections".
 */
import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { readPlaceCorrections, recordPlaceCorrections } from "../services/memory/memoryCorrections.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_DEPLOYED = "Place corrections are not available yet.";

const rejectSchema = z.object({
  field: z.literal("place"),
  kind: z.literal("reject"),
  placeId: z.string().min(1).max(200).optional(),
  canonicalLocationId: z.string().uuid().optional(),
}).strict().refine((b) => (b.placeId === undefined) !== (b.canonicalLocationId === undefined), {
  message: "Name exactly one of placeId or canonicalLocationId",
});

/** The caller's own, live Memory — or the refusal already sent. */
async function ownMemory(req: Request, res: Response, sc: SupabaseClient, ownerId: string): Promise<{ id: string; owner_id: string } | null> {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return null; }
  const { data, error } = await sc.from("memories").select("id, owner_id, state").eq("id", id).maybeSingle();
  if (error) { sendError(res, "degraded_unavailable", "Your Memory could not be read. Please try again."); return null; }
  const row = data as { id: string; owner_id: string; state: string | null } | null;
  if (!row || row.owner_id !== ownerId || row.state === "deleted") { sendError(res, "not_found", "Memory not found"); return null; }
  return { id: row.id, owner_id: row.owner_id };
}

router.get("/memories/:id/corrections", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, auth.user.id);
  if (!mem) return;
  const read = await readPlaceCorrections(sc, mem);
  if (read.state === "unreadable") {
    req.log.error({ memoryId: mem.id, detail: read.detail }, "memory corrections: read failed");
    sendError(res, "degraded_unavailable", "Your corrections could not be read. Please try again.");
    return;
  }
  if (read.absent) { sendError(res, "feature_disabled", NOT_DEPLOYED); return; }
  const c = read.corrections;
  res.json({
    memoryId: mem.id,
    place: {
      asserted: c.asserted ? { placeId: c.asserted.place_id, canonicalLocationId: c.asserted.canonical_location_id } : null,
      rejectedPlaceIds: [...c.rejectedPlaceIds].sort(),
      rejectedCanonicalLocationIds: [...c.rejectedCanonicalIds].sort(),
    },
  });
}));

router.post("/memories/:id/corrections", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, auth.user.id);
  if (!mem) return;
  const out = await recordPlaceCorrections(sc, {
    memoryId: mem.id,
    ownerId: auth.user.id,
    source: "correction_route",
    rows: [{ kind: "reject", place_id: parsed.data.placeId ?? null, canonical_location_id: parsed.data.canonicalLocationId ?? null }],
  });
  if (out.ok) { res.status(204).send(); return; }
  if (out.reason === "not_deployed") { sendError(res, "feature_disabled", NOT_DEPLOYED); return; }
  req.log.error({ memoryId: mem.id, detail: out.detail }, "memory corrections: write failed");
  sendError(res, "degraded_unavailable", "That could not be saved. Please try again.");
}));

export default router;
