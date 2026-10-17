import { z } from "zod";
import { signalFromMedia } from "./episodeCandidates.js";
import { stableStringify } from "../memoryProjections/evidence.js";
import {
  buildMemorySnapshot, parseMemorySnapshot, replayMemorySnapshot,
  type MemorySnapshot, type MemorySnapshotResult,
} from "./MemorySnapshot.js";

export interface MemorySnapshotClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }>;
}

export interface MemorySnapshotScope { ownerId: string; memoryId: string }
export interface MemorySnapshotRecord { id: string; revision: string; snapshot: MemorySnapshot }

const scopeSchema = z.object({ ownerId: z.string().uuid(), memoryId: z.string().uuid() });
const receiptSchema = z.object({ id: z.string().uuid(), revision: z.string().regex(/^[1-9]\d*$/), snapshot: z.unknown() }).strict();
const captureSchema = z.object({
  id: z.string().uuid(), owner_user_id: z.string().uuid(), media_type: z.string(),
  captured_at: z.string(), provenance: z.record(z.unknown()).nullable(),
}).strict();

async function exchange(client: MemorySnapshotClient, name: string, parameters: Record<string, unknown>): Promise<MemorySnapshotResult<unknown>> {
  try {
    const response = await client.rpc(name, parameters);
    if (response.error) {
      return { ok: false, reason: response.error.code === "PGRST202" || response.error.code === "42883" ? "not_deployed" : "unavailable" };
    }
    if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) return { ok: false, reason: "unavailable" };
    const result = response.data as Record<string, unknown>;
    if (result.ok === false && ["not_found", "conflict", "unavailable", "feature_disabled"].includes(String(result.reason))) {
      return { ok: false, reason: result.reason as "not_found" | "conflict" | "unavailable" | "feature_disabled" };
    }
    if (result.ok !== true || !("value" in result)) return { ok: false, reason: "unavailable" };
    return { ok: true, value: result.value };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

function receipt(input: unknown, scope: MemorySnapshotScope, expectedId?: string): MemorySnapshotResult<MemorySnapshotRecord> {
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "unavailable" };
  const snapshot = parseMemorySnapshot(parsed.data.snapshot);
  if (!snapshot.ok) return snapshot;
  if (snapshot.value.source.owner_id !== scope.ownerId || snapshot.value.source.memory_id !== scope.memoryId
    || (expectedId !== undefined && parsed.data.id !== expectedId)) return { ok: false, reason: "unavailable" };
  return { ok: true, value: { ...parsed.data, snapshot: snapshot.value } };
}

function parameters(scope: MemorySnapshotScope) { return { p_owner_id: scope.ownerId, p_memory_id: scope.memoryId }; }

export async function captureMemorySnapshot(client: MemorySnapshotClient, scope: MemorySnapshotScope): Promise<MemorySnapshotResult<MemorySnapshotRecord>> {
  if (!scopeSchema.safeParse(scope).success) return { ok: false, reason: "not_found" };
  const prepared = await exchange(client, "memory_snapshot_prepare_v1", parameters(scope));
  if (!prepared.ok) return prepared;
  const source = prepared.value as Record<string, unknown> | null;
  if (!source || source.owner_id !== scope.ownerId || source.memory_id !== scope.memoryId) return { ok: false, reason: "unavailable" };
  const captures = z.array(captureSchema).max(500).safeParse(source.captures);
  const trip = z.string().uuid().nullable().safeParse(source.trip_id);
  if (!captures.success || !trip.success || captures.data.some((capture) => capture.owner_user_id !== scope.ownerId)) {
    return { ok: false, reason: "unavailable" };
  }
  const { captures: ignoredCaptures, trip_id: ignoredTrip, ...facts } = source;
  const signals = captures.data.map((capture) => {
    const signal = signalFromMedia({ ...capture, mime_type: null, public_url: null,
      source_type: "user", moderation_status: "active", processing_status: "ready", deleted_at: null }, trip.data ?? "");
    return { ...signal, assertion_json: { ...signal.assertion_json, trip_id: trip.data } };
  });
  const built = buildMemorySnapshot({ ...facts, signals });
  if (!built.ok) return built;
  const stored = await exchange(client, "memory_snapshot_append_v1", { ...parameters(scope), p_snapshot: built.value });
  if (!stored.ok) return stored;
  const result = receipt(stored.value, scope);
  if (!result.ok) return result;
  const { captured_at: storedAt, ...storedSource } = result.value.snapshot.source;
  const { captured_at: preparedAt, ...preparedSource } = built.value.source;
  if (stableStringify(storedSource) !== stableStringify(preparedSource)) return { ok: false, reason: "unavailable" };
  return result;
}

export async function readMemorySnapshot(client: MemorySnapshotClient, scope: MemorySnapshotScope, snapshotId: string): Promise<MemorySnapshotResult<MemorySnapshotRecord>> {
  if (!scopeSchema.safeParse(scope).success || !z.string().uuid().safeParse(snapshotId).success) return { ok: false, reason: "not_found" };
  const loaded = await exchange(client, "memory_snapshot_read_v1", { ...parameters(scope), p_snapshot_id: snapshotId });
  return loaded.ok ? receipt(loaded.value, scope, snapshotId) : loaded;
}

export async function replayStoredMemorySnapshot(client: MemorySnapshotClient, scope: MemorySnapshotScope, snapshotId: string) {
  const loaded = await readMemorySnapshot(client, scope, snapshotId);
  if (!loaded.ok) return loaded;
  const replay = replayMemorySnapshot(loaded.value.snapshot);
  if (!replay.ok) return replay;
  return { ok: true as const, value: { id: loaded.value.id, revision: loaded.value.revision, ...replay.value } };
}

export async function eraseMemorySnapshots(client: MemorySnapshotClient, scope: MemorySnapshotScope): Promise<MemorySnapshotResult<{ purged: number }>> {
  if (!scopeSchema.safeParse(scope).success) return { ok: false, reason: "not_found" };
  const result = await exchange(client, "memory_snapshot_purge_v1", parameters(scope));
  if (!result.ok) return result;
  const parsed = z.object({ purged: z.number().int().nonnegative() }).strict().safeParse(result.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "unavailable" };
}
