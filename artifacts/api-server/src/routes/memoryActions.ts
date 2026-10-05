/**
 * Executable Memories — the routes over services/memory/memoryActionService.ts.
 *
 *   GET /memories/:id/actions           — §14's eight actions (+ §12 VIEW_PLACE),
 *                                         each offered or refused with a reason,
 *                                         judged against the world NOW
 *   GET /memories/:id/actions/:action   — compile one: DO_AGAIN, TAKE_ME_BACK,
 *                                         ADD_TO_TRIP, BRING_FORWARD_SAVED
 *                                         (`?tripId=` for DO_AGAIN)
 *
 * Census H16 / H107 / H108 / H259. Read-only: a compile writes nothing. Add to
 * Trip hands the client the CURRENT place in the shape the trip's own write
 * path takes (`POST /trips/:tripId/saved-places`), which is where the write
 * happens and is authorized.
 *
 * A separate router rather than more of routes/memories.ts because that file's
 * tail is another lane's (Layover → Memory, census-layover L275), and because
 * nothing here touches a canonical Memory: every route reads the Memory only to
 * learn which place it was and when, under the same §23 ladder GET /memories/:id
 * uses (`canReadMemory(..., "single")` plus the bidirectional block check), and
 * answers a Memory this viewer may not read with the same 404 as a missing one.
 */
import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { canReadMemory, isBlocked } from "../services/memory/memoryReadPolicy.js";
import {
  ACTION_UNAVAILABLE_MESSAGE,
  DECLARED_UNBUILT,
  MEMORY_ACTION_COLUMNS,
  MEMORY_ACTION_COLUMNS_WITH_PRECISION,
  buildActionMenu,
  compileAddToTrip,
  compileBringForward,
  compileDoAgain,
  compileTakeMeBack,
  isCompilableAction,
  isMemoryAction,
  readCurrentTrips,
  resolveCurrentPlace,
  viewerPlaceFor,
  type ActionUnavailableReason,
  type MemoryForAction,
} from "../services/memory/memoryActionService.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRECISION_FLAG = "memory_location_precision_enabled";

type Loaded =
  | { ok: true; memory: MemoryForAction; precisionGateOn: boolean }
  | { ok: false };

/**
 * Read the Memory and decide whether this viewer may act on it. Answers the
 * response itself on every refusal, so a caller only continues on `ok`.
 */
async function loadReadableMemory(req: Request, res: Response, sc: SupabaseClient, memoryId: string, viewerId: string): Promise<Loaded> {
  const precisionGateOn = await isFlagEnabled(sc, PRECISION_FLAG);
  const { data, error } = await sc
    .from("memories")
    .select(precisionGateOn ? MEMORY_ACTION_COLUMNS_WITH_PRECISION : MEMORY_ACTION_COLUMNS)
    .eq("id", memoryId)
    .neq("state", "deleted")
    .maybeSingle();
  if (error) {
    req.log.error({ err: error, memoryId }, "memory actions: memory read failed — refusing rather than answering not_found");
    sendError(res, "degraded_unavailable", "Could not read this Memory. Please try again.");
    return { ok: false };
  }
  const memory = data as MemoryForAction | null;
  if (!memory) { sendError(res, "not_found", "Memory not found"); return { ok: false }; }
  if (memory.owner_id !== viewerId) {
    // Fail closed in both limbs: an unreadable blocks table is "blocked", and
    // an unreadable audience gate is "may not read" (memoryReadPolicy).
    if (await isBlocked(sc, viewerId, memory.owner_id)) { sendError(res, "not_found", "Memory not found"); return { ok: false }; }
    if (!(await canReadMemory(sc, memory, viewerId, "single"))) { sendError(res, "not_found", "Memory not found"); return { ok: false }; }
  }
  return { ok: true, memory, precisionGateOn };
}

function refuse(res: Response, reason: ActionUnavailableReason | "trip_not_eligible") {
  if (reason === "trip_not_eligible") {
    sendError(res, "conflict", "That trip is not one of your current trips.", { exposeDetail: true, reason });
    return;
  }
  if (reason === "PLACE_UNREADABLE") {
    sendError(res, "degraded_unavailable", ACTION_UNAVAILABLE_MESSAGE[reason], { reason });
    return;
  }
  if (reason === "OWNER_ONLY") {
    sendError(res, "forbidden", ACTION_UNAVAILABLE_MESSAGE[reason], { reason });
    return;
  }
  sendError(res, "conflict", ACTION_UNAVAILABLE_MESSAGE[reason], { exposeDetail: true, reason });
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ── GET /memories/:id/actions ────────────────────────────────────────────────
router.get("/memories/:id/actions", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const loaded = await loadReadableMemory(req, res, sc, id, user.id);
  if (!loaded.ok) return;
  const { memory, precisionGateOn } = loaded;

  const resolution = await resolveCurrentPlace(sc, memory);
  const viewerPlace = await viewerPlaceFor(sc, memory, user.id, precisionGateOn, resolution);

  let savedByMe: boolean | null = null;
  if (memory.owner_id !== user.id) {
    const { data: save, error: saveErr } = await sc
      .from("memory_saves")
      .select("memory_id")
      .eq("memory_id", memory.id)
      .eq("user_id", user.id)
      .maybeSingle();
    // Unknown is not "not saved": the descriptor stays offered, with no state.
    if (saveErr) req.log.error({ err: saveErr, memoryId: memory.id }, "memory actions: memory_saves read failed — save state unknown");
    else savedByMe = Boolean(save);
  }

  res.json({ menu: buildActionMenu({ memory, viewerId: user.id, viewerPlace, savedByMe }) });
}));

// ── GET /memories/:id/actions/:action ────────────────────────────────────────
router.get("/memories/:id/actions/:action", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const id = String(req.params.id ?? "");
  const action = String(req.params.action ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }
  if (!isMemoryAction(action)) { sendError(res, "invalid_payload", "Unknown action"); return; }
  const tripParam = typeof req.query.tripId === "string" ? req.query.tripId : null;
  if (tripParam !== null && !UUID_RE.test(tripParam)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const loaded = await loadReadableMemory(req, res, sc, id, user.id);
  if (!loaded.ok) return;
  const { memory, precisionGateOn } = loaded;

  if (!isCompilableAction(action)) {
    // Declared by §14, refused by name — the same reason the menu gives.
    const declared = DECLARED_UNBUILT[action];
    if (declared) { refuse(res, declared); return; }
    // SAVE_EXPERIENCE and VIEW_PLACE are carried out by existing routes and
    // screens (POST /memories/:id/save, /place/:id); there is nothing to compile.
    sendError(res, "invalid_payload", "This action has no compile step: use the menu.");
    return;
  }

  if (action === "BRING_FORWARD_SAVED") {
    if (memory.owner_id !== user.id) { refuse(res, "OWNER_ONLY"); return; }
    if (!memory.trip_id) { refuse(res, "NO_PRIOR_TRIP"); return; }
    const out = await compileBringForward(sc, memory, user.id);
    if (!out.ok) {
      sendError(res, "degraded_unavailable", "Your saved places from that trip could not be read. Please try again.");
      return;
    }
    res.json({ compiled: { action, fromTripId: out.fromTripId, items: out.items, leftBehind: out.leftBehind } });
    return;
  }

  const resolution = await resolveCurrentPlace(sc, memory);
  const viewerPlace = await viewerPlaceFor(sc, memory, user.id, precisionGateOn, resolution);

  if (action === "TAKE_ME_BACK") {
    const out = compileTakeMeBack(memory, user.id, viewerPlace);
    if ("refused" in out) { refuse(res, out.refused); return; }
    res.json({ compiled: out });
    return;
  }

  if (viewerPlace.state !== "ok") { refuse(res, viewerPlace.reason); return; }

  if (action === "ADD_TO_TRIP") {
    res.json({ compiled: compileAddToTrip(viewerPlace.place, viewerPlace.caution) });
    return;
  }

  // DO_AGAIN
  const now = new Date();
  const trips = await readCurrentTrips(sc, user.id, todayUtc(now));
  const plan = await compileDoAgain(sc, {
    memory,
    viewerId: user.id,
    place: viewerPlace.place,
    caution: viewerPlace.caution,
    followedMerges: viewerPlace.followedMerges,
    trips,
    requestedTripId: tripParam,
    now,
  });
  if ("refused" in plan) {
    if (plan.refused === "trips_unreadable") {
      sendError(res, "degraded_unavailable", "Your trips could not be read. Please try again.");
      return;
    }
    refuse(res, plan.refused);
    return;
  }
  res.json({ compiled: plan });
}));

export default router;
