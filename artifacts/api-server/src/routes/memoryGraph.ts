/**
 * MERGE_MEMORY and SPLIT_MEMORY (Highlights/Memories spec §17, §5 MERGED, §22
 * stable IDs, §25 "Merge two Memories then split differently").
 *
 *   POST /memories/merge        { survivorId, absorbedIds[] }   -> 200
 *   POST /memories/:id/split    { itemIds[], title? }           -> 201
 *
 * Census H134, H135, H150, H151, H194, H213, H214.
 * Decision: docs/architecture/memories-graph-model-decision.md §3.2 to §3.5.
 *
 * GATED by memory_merge_split_enabled (migration 3674, seeded FALSE; the read is
 * fail-closed): off, both routes answer feature_disabled and touch nothing.
 *
 * THROUGH THE COMMAND BUS, ALWAYS. There is no legacy direct write to fall back
 * to: the command executes in public.memory_graph_kernel_execute (3676), which
 * writes the change, memory.merged / memory.split, the outbox row, the receipt
 * and the audit row in one transaction. Kernel absent => 503, never a partial
 * merge done from here. §19: the Idempotency-Key header makes a retry return the
 * original answer.
 *
 * AUTHORIZATION RUNS HERE FIRST and again in the function (the bus's rule). Here
 * every Memory named must be the caller's and not deleted; any that is not is
 * one uniform 404, so a merge request cannot be used to learn whether someone
 * else's Memory id exists. The audience rule (§23: a merge never moves content to
 * a wider audience) is the function's, under its row locks, and comes back as
 * 409 MEMORY_MERGE_AUDIENCE_MISMATCH.
 *
 * AFTER A MERGE, each absorbed Memory goes through §21's deletion lifecycle,
 * reused rather than copied: its derivatives are rebuilt without it (H-5), the
 * Compass caches that held it are evicted, its place corrections are purged
 * (H-13), and a failure is dead-lettered (3670). Its content now lives in the
 * survivor, whose projections the outbox consumer rebuilds from memory.merged.
 * AFTER A SPLIT, the source's derivatives are re-derived (narrowing
 * reprojection), because items left it.
 */
import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { isTableAbsentError } from "../lib/tableAbsence.js";
import {
  executeMemoryCommand,
  readMemoryCommandEnvelope,
  sendMemoryCommandRejection,
} from "../lib/memoryCommandBus.js";
import { runMemoryDeletionLifecycle } from "../services/memory/memoryDeletionLifecycle.js";
import { mergedAudience } from "../services/memory/memoryAudienceRevocation.js";
import { reprojectDerivativesAfterNarrowing } from "../services/memoryProjections/narrowingReprojection.js";
import { countAcceptedCommand, countCandidateGraphCommand } from "../services/memory/memoryKernelMetrics.js";

export const MEMORY_MERGE_SPLIT_FLAG = "memory_merge_split_enabled";
export const MERGE_MAX_ABSORBED = 20;
export const SPLIT_MAX_ITEMS = 200;
export const SPLIT_REPROJECTION_REASON = "memory_split";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_AVAILABLE = "Merging and splitting memories is not available yet.";

const mergeSchema = z.object({
  survivorId: z.string().uuid(),
  absorbedIds: z.array(z.string().uuid()).min(1).max(MERGE_MAX_ABSORBED),
}).strict().refine((b) => new Set(b.absorbedIds).size === b.absorbedIds.length && !b.absorbedIds.includes(b.survivorId), {
  message: "absorbedIds must be distinct and must not include survivorId",
});

const splitSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(SPLIT_MAX_ITEMS),
  title: z.string().max(200).nullable().optional(),
}).strict().refine((b) => new Set(b.itemIds).size === b.itemIds.length, { message: "itemIds must be distinct" });

interface OwnedRow {
  id: string;
  owner_id: string;
  state: string | null;
  visibility: string | null;
  allowed_user_ids: string[] | null;
  hidden_user_ids: string[] | null;
  trip_id: string | null;
}

/**
 * Read every named Memory. `null` = already answered (404 / 503). A failed read
 * is a 503 and nothing is attempted after it.
 */
async function ownedMemories(sc: SupabaseClient, res: Response, ids: readonly string[], ownerId: string): Promise<OwnedRow[] | null> {
  const { data, error } = await sc
    .from("memories")
    .select("id, owner_id, state, visibility, allowed_user_ids, hidden_user_ids, trip_id")
    .in("id", [...ids]);
  if (error || !Array.isArray(data)) {
    sendError(res, "degraded_unavailable", "Your memories could not be read. Please try again.");
    return null;
  }
  const rows = data as OwnedRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.owner_id !== ownerId || r.state === "deleted") {
      sendError(res, "not_found", "Memory not found");
      return null;
    }
  }
  return ids.map((id) => byId.get(id)!);
}

/**
 * Whether any of these Memories was kept from a §7 candidate: an evidence link
 * row (2320) naming it. Absent store = no candidate can exist = false (true).
 * A failed read = null (unattributed), never a guess.
 */
async function keptFromCandidate(sc: SupabaseClient, ownerId: string, ids: readonly string[]): Promise<boolean | null> {
  try {
    const { data, error } = await sc
      .from("memory_evidence")
      .select("source_id")
      .eq("user_id", ownerId)
      .eq("source_table", "memories")
      .in("source_id", [...ids])
      .limit(1);
    if (error) return isTableAbsentError(error) ? false : null;
    return Array.isArray(data) ? data.length > 0 : null;
  } catch {
    return null;
  }
}

async function gate(req: Request, res: Response): Promise<{ sc: SupabaseClient; userId: string; key: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return null; }
  if (!(await isFlagEnabled(sc, MEMORY_MERGE_SPLIT_FLAG))) { sendError(res, "feature_disabled", NOT_AVAILABLE); return null; }
  const env = readMemoryCommandEnvelope(req);
  if (!env.ok) { sendError(res, "invalid_payload", env.message); return null; }
  return { sc, userId: auth.user.id, key: env.idempotencyKey };
}

router.post("/memories/merge", asyncHandler(async (req: Request, res: Response) => {
  const g = await gate(req, res);
  if (!g) return;
  const parsed = mergeSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }
  const { survivorId, absorbedIds } = parsed.data;

  const rows = await ownedMemories(g.sc, res, [survivorId, ...absorbedIds], g.userId);
  if (!rows) return;
  const fromCandidate = await keptFromCandidate(g.sc, g.userId, [survivorId, ...absorbedIds]);

  const r = await executeMemoryCommand(g.sc, {
    commandId: randomUUID(),
    memoryId: survivorId,
    actorUserId: g.userId,
    idempotencyKey: g.key,
    type: "MERGE_MEMORY",
    payload: { absorbed_memory_ids: absorbedIds },
  });
  if (!r.ok) { sendMemoryCommandRejection(res, r, req.log); return; }

  if (!r.duplicate) {
    countAcceptedCommand("MERGE_MEMORY", false);
    countCandidateGraphCommand("MERGE_MEMORY", fromCandidate);
    // §21 for each absorbed Memory (H-5 / H-13), with the audience it had.
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of absorbedIds) {
      const report = await runMemoryDeletionLifecycle(g.sc, {
        memoryId: id,
        ownerId: g.userId,
        actorUserId: g.userId,
        previous: mergedAudience(byId.get(id) as any, {}),
        log: req.log,
        requestedAt: Date.now(),
      });
      req.log.info({ report, reason: "memory_merged" }, "memories: §21 lifecycle for a merged-away Memory");
    }
  }

  const result = (r.result ?? {}) as { survivor_id?: string; absorbed_memory_ids?: string[]; moved?: Record<string, number> };
  res.status(200).json({
    survivorId: result.survivor_id ?? survivorId,
    absorbedIds: result.absorbed_memory_ids ?? absorbedIds,
    moved: result.moved ?? null,
    duplicate: r.duplicate,
  });
}));

router.post("/memories/:id/split", asyncHandler(async (req: Request, res: Response) => {
  const g = await gate(req, res);
  if (!g) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }
  const parsed = splitSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }

  const rows = await ownedMemories(g.sc, res, [id], g.userId);
  if (!rows) return;
  const fromCandidate = await keptFromCandidate(g.sc, g.userId, [id]);

  const payload: Record<string, unknown> = { item_ids: parsed.data.itemIds };
  if (parsed.data.title !== undefined) payload.title = parsed.data.title;
  const r = await executeMemoryCommand(g.sc, {
    commandId: randomUUID(),
    memoryId: id,
    actorUserId: g.userId,
    idempotencyKey: g.key,
    type: "SPLIT_MEMORY",
    payload,
  });
  if (!r.ok) { sendMemoryCommandRejection(res, r, req.log); return; }

  if (!r.duplicate) {
    countAcceptedCommand("SPLIT_MEMORY", false);
    countCandidateGraphCommand("SPLIT_MEMORY", fromCandidate);
    const re = await reprojectDerivativesAfterNarrowing(g.sc as any, { memoryId: id, now: new Date(), reason: SPLIT_REPROJECTION_REASON });
    if (!re.ok) req.log.error({ unresolved: re.unresolved.length }, "memories: derivatives of a split Memory could not all be re-derived");
  }

  const result = (r.result ?? {}) as { source_memory_id?: string; new_memory_id?: string; moved_item_ids?: string[] };
  res.status(r.duplicate ? 200 : 201).json({
    sourceId: result.source_memory_id ?? id,
    newMemoryId: result.new_memory_id ?? null,
    movedItemIds: result.moved_item_ids ?? parsed.data.itemIds,
    duplicate: r.duplicate,
  });
}));

export default router;
