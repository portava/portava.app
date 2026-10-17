import { z } from "zod";

export const MEMORY_VIDEO_SEGMENTS_RPC = "memory_video_segments_execute";
export const MEMORY_VIDEO_SEGMENTS_FLAG = "memory_video_segments_enabled";
export const MEMORY_VIDEO_SEGMENTS_LIMIT = 100;
export const VIDEO_SEGMENT_INTEGER_MAX = 2147483647;

const positiveInteger = z.number().int().min(1).max(VIDEO_SEGMENT_INTEGER_MAX);
const offset = z.number().int().min(0).max(VIDEO_SEGMENT_INTEGER_MAX);
const label = z.string().trim().min(1).max(160).nullable();

export const videoSegmentCreateSchema = z.object({
  operationId: z.string().uuid(),
  assetId: z.string().uuid(),
  assetVersion: positiveInteger,
  startMs: offset,
  endMs: positiveInteger,
  label: label.optional().default(null),
}).strict().refine((value) => value.endMs > value.startMs, "End must be after start");

export type VideoSegmentCreate = z.infer<typeof videoSegmentCreateSchema>;

export const videoSegmentSourceSchema = z.object({
  memoryId: z.string().uuid(),
  itemId: z.string().uuid(),
  ownerId: z.string().uuid(),
  assetId: z.string().uuid(),
  assetVersion: positiveInteger,
  durationMs: positiveInteger,
});

export type VideoSegmentSource = z.infer<typeof videoSegmentSourceSchema>;

export const videoSegmentSchema = videoSegmentSourceSchema.extend({
  id: z.string().uuid(),
  startMs: offset,
  endMs: positiveInteger,
  label,
  source: z.literal("owner_asserted"),
  createdAt: z.string().datetime({ offset: true }),
}).strict().refine((value) => value.startMs < value.endMs && value.endMs <= value.durationMs);

export type MemoryVideoSegment = z.infer<typeof videoSegmentSchema>;

export function segmentMatchesSource(segment: MemoryVideoSegment, source: VideoSegmentSource): boolean {
  return segment.memoryId === source.memoryId && segment.itemId === source.itemId
    && segment.ownerId === source.ownerId && segment.assetId === source.assetId
    && segment.assetVersion === source.assetVersion && segment.durationMs === source.durationMs
    && segment.startMs >= 0 && segment.startMs < segment.endMs && segment.endMs <= source.durationMs;
}

export const videoSegmentReplySchema = z.union([
  z.object({ contractVersion: z.literal(1), ok: z.literal(true), operation: z.literal("list"), segments: z.array(videoSegmentSchema).max(MEMORY_VIDEO_SEGMENTS_LIMIT) }).strict(),
  z.object({ contractVersion: z.literal(1), ok: z.literal(true), operation: z.literal("create"), segment: videoSegmentSchema, created: z.boolean() }).strict(),
  z.object({ contractVersion: z.literal(1), ok: z.literal(true), operation: z.literal("delete"), deleted: z.boolean() }).strict(),
  z.object({ contractVersion: z.literal(1), ok: z.literal(false), reason: z.enum([
    "not_found", "source_changed", "invalid_bounds", "limit_reached", "idempotency_conflict", "unavailable", "invalid_payload", "disabled",
  ]) }).strict(),
]);
