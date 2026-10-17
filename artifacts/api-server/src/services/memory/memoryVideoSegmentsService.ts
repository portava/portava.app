import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizeMediaAccess } from "../../lib/mediaAccess.js";
import { appStorageUrlInfo } from "../../lib/mediaUrl.js";
import { isMemoryKernelEnabled } from "../../lib/memoryCommandBus.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import {
  MEMORY_VIDEO_SEGMENTS_RPC, segmentMatchesSource, videoSegmentCreateSchema,
  videoSegmentReplySchema, videoSegmentSourceSchema,
} from "./memoryVideoSegments.js";

const scopeSchema = z.object({ ownerId: z.string().uuid(), memoryId: z.string().uuid(), itemId: z.string().uuid() }).strict();
export type MemoryVideoSegmentScope = z.infer<typeof scopeSchema>;
type FailureReason = "not_found" | "source_changed" | "invalid_bounds" | "limit_reached" | "idempotency_conflict" | "unavailable" | "invalid_payload" | "disabled";

export class MemoryVideoSegmentsError extends Error {
  constructor(readonly reason: FailureReason) { super(reason); }
}

function refuse(reason: FailureReason): never { throw new MemoryVideoSegmentsError(reason); }

async function readItem(client: SupabaseClient, scope: MemoryVideoSegmentScope) {
  if (!scopeSchema.safeParse(scope).success) refuse("invalid_payload");
  if (!(await isMemoryKernelEnabled(client)) || !(await isFlagEnabled(client, "memory_video_segments_enabled"))) refuse("disabled");
  const memory = await client.from("memories").select("id, owner_id, state")
    .eq("id", scope.memoryId).eq("owner_id", scope.ownerId).maybeSingle();
  if (memory.error) refuse("unavailable");
  if (!memory.data || memory.data.id !== scope.memoryId || memory.data.owner_id !== scope.ownerId
    || !["draft", "published", "archived"].includes(memory.data.state)) refuse("not_found");
  const item = await client.from("memory_items").select("id, memory_id, media_url")
    .eq("id", scope.itemId).eq("memory_id", scope.memoryId).maybeSingle();
  if (item.error) refuse("unavailable");
  if (!item.data || item.data.id !== scope.itemId || item.data.memory_id !== scope.memoryId) refuse("not_found");
  return item.data;
}

async function readSource(client: SupabaseClient, scope: MemoryVideoSegmentScope) {
  const item = await readItem(client, scope);
  const ref = typeof item.media_url === "string" ? appStorageUrlInfo(item.media_url) : null;
  if (!ref || ref.bucket !== "post-media") refuse("not_found");
  const asset = await client.from("media_assets")
    .select("id, owner_user_id, storage_bucket, storage_path, media_type, version, duration_ms, processing_status, moderation_status, deleted_at")
    .eq("storage_bucket", ref.bucket).eq("storage_path", ref.path).eq("owner_user_id", scope.ownerId).maybeSingle();
  if (asset.error) refuse("unavailable");
  const row = asset.data;
  if (!row || row.owner_user_id !== scope.ownerId || row.storage_bucket !== ref.bucket || row.storage_path !== ref.path
    || row.media_type !== "video" || row.deleted_at !== null || row.processing_status !== "ready"
    || !["active", "approved"].includes(row.moderation_status)) refuse("not_found");
  const parsed = videoSegmentSourceSchema.safeParse({ ...scope, assetId: row.id, assetVersion: row.version, durationMs: row.duration_ms });
  if (!parsed.success) refuse("unavailable");
  if (!(await authorizeMediaAccess(client, scope.ownerId, ref.bucket, ref.path))) refuse("not_found");
  return { ...parsed.data, storageBucket: ref.bucket, storagePath: ref.path, itemMediaUrl: item.media_url as string };
}

async function execute(client: SupabaseClient, command: Record<string, unknown>) {
  const response = await client.rpc(MEMORY_VIDEO_SEGMENTS_RPC, { p_command: { contractVersion: 1, ...command } });
  if (response.error) refuse("unavailable");
  const parsed = videoSegmentReplySchema.safeParse(response.data);
  if (!parsed.success) refuse("unavailable");
  if (!parsed.data.ok) refuse(parsed.data.reason);
  if (parsed.data.operation !== command.operation) refuse("unavailable");
  return parsed.data;
}

async function protect<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof MemoryVideoSegmentsError) throw error;
    refuse("unavailable");
  }
}

async function recheck(client: SupabaseClient, scope: MemoryVideoSegmentScope, source: Awaited<ReturnType<typeof readSource>>) {
  const current = await readSource(client, scope);
  if (JSON.stringify(current) !== JSON.stringify(source)) refuse("source_changed");
}

function publicSource(source: Awaited<ReturnType<typeof readSource>>) {
  return { assetId: source.assetId, assetVersion: source.assetVersion, durationMs: source.durationMs,
    mediaRef: `${source.storageBucket}/${source.storagePath}` };
}

export async function listMemoryVideoSegments(client: SupabaseClient, scope: MemoryVideoSegmentScope) {
  return protect(async () => {
    const source = await readSource(client, scope);
    const result = await execute(client, { operation: "list", ...scope, source });
    if (result.operation !== "list") refuse("unavailable");
    if (new Set(result.segments.map((segment) => segment.id)).size !== result.segments.length
      || result.segments.some((segment) => !segmentMatchesSource(segment, source))) refuse("unavailable");
    await recheck(client, scope, source);
    return { source: publicSource(source), segments: result.segments };
  });
}

export async function createMemoryVideoSegment(client: SupabaseClient, scope: MemoryVideoSegmentScope, input: unknown) {
  return protect(async () => {
    const parsed = videoSegmentCreateSchema.safeParse(input);
    if (!parsed.success) refuse("invalid_payload");
    const source = await readSource(client, scope);
    const request = parsed.data;
    if (request.assetId !== source.assetId || request.assetVersion !== source.assetVersion) refuse("source_changed");
    if (request.endMs > source.durationMs) refuse("invalid_bounds");
    const result = await execute(client, { operation: "create", ...scope, source, segment: request });
    if (result.operation !== "create") refuse("unavailable");
    const segment = result.segment;
    if (!segmentMatchesSource(segment, source) || segment.id !== request.operationId
      || segment.startMs !== request.startMs || segment.endMs !== request.endMs || segment.label !== request.label) refuse("unavailable");
    await recheck(client, scope, source);
    return { segment, created: result.created };
  });
}

export async function deleteMemoryVideoSegment(client: SupabaseClient, scope: MemoryVideoSegmentScope, segmentId: unknown) {
  return protect(async () => {
    if (!z.string().uuid().safeParse(segmentId).success) refuse("invalid_payload");
    await readItem(client, scope);
    const result = await execute(client, { operation: "delete", ...scope, segmentId });
    if (result.operation !== "delete") refuse("unavailable");
    return { deleted: result.deleted };
  });
}
