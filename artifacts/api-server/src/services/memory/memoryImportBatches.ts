import { z } from "zod";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { COMMAND_CAPABILITY, COMMAND_EVENT, COMMAND_KERNEL_FN, COMMAND_SUBJECT, MEMORY_COMMAND_TYPES } from "../../lib/memoryCommandBus.js";

export const MEMORY_IMPORT_BATCHES_FLAG = "memory_import_batches_enabled";
export const MEMORY_IMPORT_BATCH_MAX = 200;
export const MEMORY_IMPORT_STEP_MAX = 25;

export interface MemoryImportClient {
  from(table: string): any;
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

const batchSchema = z.object({
  id: z.string().uuid(),
  source: z.literal("existing_legacy_memories"),
  status: z.enum(["queued", "running", "completed", "aborted"]),
  total: z.number().int().min(1).max(MEMORY_IMPORT_BATCH_MAX),
  checkpoint: z.number().int().min(0),
  completed: z.number().int().min(0),
  revoked: z.number().int().min(0),
  attempts: z.number().int().min(0),
  lastErrorCode: z.literal("MEMORY_IMPORT_STEP_FAILED").nullable(),
}).refine((batch) => batch.checkpoint <= batch.total && batch.completed + batch.revoked <= batch.total);

const failureReason = z.enum([
  "not_found", "invalid_payload", "idempotency_conflict", "checkpoint_conflict",
  "feature_disabled", "schema_unavailable", "step_failed", "unavailable",
]);

export type MemoryImportBatch = z.infer<typeof batchSchema>;
export type MemoryImportFailure = z.infer<typeof failureReason>;
export type MemoryImportResult =
  | { ok: true; batch: MemoryImportBatch; duplicate: boolean }
  | { ok: false; reason: MemoryImportFailure };

export const memoryImportCreateSchema = z.object({
  source: z.literal("existing_legacy_memories"),
  memoryIds: z.array(z.string().uuid().transform((id) => id.toLowerCase())).min(1).max(MEMORY_IMPORT_BATCH_MAX),
}).strict().refine((body) => new Set(body.memoryIds).size === body.memoryIds.length, { message: "Memory IDs must be distinct" });

export const memoryImportStepSchema = z.object({
  checkpoint: z.number().int().min(0).max(MEMORY_IMPORT_BATCH_MAX),
  limit: z.number().int().min(1).max(MEMORY_IMPORT_STEP_MAX).default(MEMORY_IMPORT_STEP_MAX),
}).strict();

export function isMemoryImportCommandRegistered(): boolean {
  const command = MEMORY_COMMAND_TYPES.find((type) => String(type) === "BACKFILL_LEGACY_MEMORY");
  return command !== undefined && COMMAND_SUBJECT[command] === "memory"
    && COMMAND_CAPABILITY[command] === "owner" && COMMAND_EVENT[command] === "memory.corrected"
    && COMMAND_KERNEL_FN[command] === "memory_import_legacy_execute";
}

export async function memoryImportAvailability(client: MemoryImportClient, write: boolean): Promise<MemoryImportFailure | null> {
  try {
    if (write && (!(await isFlagEnabled(client, MEMORY_IMPORT_BATCHES_FLAG))
      || !(await isFlagEnabled(client, "memory_kernel_enabled")))) return "feature_disabled";
    if (write && !isMemoryImportCommandRegistered()) return "schema_unavailable";
    const { data, error } = await client.rpc("memory_import_batches_contract", {});
    return error || data !== 1 ? "schema_unavailable" : null;
  } catch {
    return "schema_unavailable";
  }
}

async function call(client: MemoryImportClient, name: string, args: Record<string, unknown>): Promise<MemoryImportResult> {
  try {
    const { data, error } = await client.rpc(name, args);
    if (error || !data || typeof data !== "object") return { ok: false, reason: "unavailable" };
    const response = data as Record<string, unknown>;
    if (response.ok !== true) {
      const reason = failureReason.safeParse(response.reason);
      return { ok: false, reason: reason.success ? reason.data : "unavailable" };
    }
    const batch = batchSchema.safeParse(response.batch);
    if (!batch.success || (response.duplicate !== undefined && typeof response.duplicate !== "boolean")) {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, batch: batch.data, duplicate: response.duplicate === true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export function createMemoryImportBatch(client: MemoryImportClient, ownerId: string, key: string, memoryIds: string[]) {
  return call(client, "memory_import_batches_create", { p_owner_id: ownerId, p_key: key, p_memory_ids: memoryIds });
}

export function getMemoryImportBatch(client: MemoryImportClient, ownerId: string, batchId: string) {
  return call(client, "memory_import_batches_get", { p_owner_id: ownerId, p_batch_id: batchId });
}

export function stepMemoryImportBatch(client: MemoryImportClient, ownerId: string, batchId: string, checkpoint: number, limit: number) {
  return call(client, "memory_import_batches_step", {
    p_owner_id: ownerId, p_batch_id: batchId, p_checkpoint: checkpoint, p_limit: limit,
  });
}

export function abortMemoryImportBatch(client: MemoryImportClient, ownerId: string, batchId: string) {
  return call(client, "memory_import_batches_abort", { p_owner_id: ownerId, p_batch_id: batchId });
}
