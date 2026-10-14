/**
 * memorySegments — §20 "Video scenes as logical segments without duplicating
 * originals" (census-highlights-memories H184; migration 3809, written and
 * unapplied; B58 cluster MEM-SEGMENTS).
 *
 * A segment is a WINDOW [startMs, endMs) over one video item's OWN stored
 * object, plus an optional owner label. It is stored as two integers on
 * `memory_media_segments` — no path, no URL, no bucket (3809's postcondition
 * holds the column list) — and served with the item's own `media_url`, read
 * from `memory_items` at serve time. Nothing in this module, or in the route
 * that uses it, writes, uploads, copies, moves or transcodes a storage object:
 * it never touches `sc.storage` at all.
 *
 * ── THE MEASURED DURATION ───────────────────────────────────────────────────
 * A window is accepted only inside the video's MEASURED length:
 * `media_assets.duration_ms`, which routes/posts.ts `/media/upload` writes from
 * the container's own header (lib/videoProbe.ts → recordMeasuredDuration), never
 * from a client's claim. The item's `media_url` is resolved to its object by
 * `storageRefOf` (the three spellings memory_items holds) and matched on
 * media_assets' UNIQUE (storage_bucket, storage_path). Every way that can fail
 * to produce a trustworthy length is `unknown`, and unknown is REFUSED (422) —
 * never "assume it is long enough":
 *   - the item points outside our storage (an external https URL);
 *   - no media_assets row (the canonical writer is behind
 *     `media_canonical_enabled`, which production reads FALSE — census-media
 *     §23.2 — so in production today every recent upload is unmeasured);
 *   - the row is another person's asset (the owner of the Memory may not probe
 *     the length of an object they do not own, one 422 at a time);
 *   - `duration_ms` is null, not a positive integer.
 * A row that says the object is an image is `not_a_video`. A read that FAILS is
 * not unknown — it is unreadable, and the route answers 503.
 *
 * ── WHO MAY READ A SEGMENT ──────────────────────────────────────────────────
 * Exactly who may read its ITEM — decided by the route with the Memory's own
 * ladder (block check, §23 canReadMemory on the "single" surface, 3672's item
 * audience). A segment adds no read grant, and its label travels only with an
 * item the viewer is served, i.e. to the item caption's audience.
 */
import { isTableAbsentError } from "../../lib/tableAbsence.js";
import { storageRefOf } from "./memoryMediaOrigin.js";

export const SEGMENTS_TABLE = "memory_media_segments";
/** 3809's CHECK memory_media_segments_label_check. */
export const SEGMENT_LABEL_MAX = 120;
/**
 * How many segments one video item may carry (owner question Q-H184-2, the
 * fail-closed default). A resource bound, not a product feature: without one an
 * owner's client could write rows without limit.
 */
export const SEGMENTS_PER_ITEM_MAX = 50;
/** PostgREST's max-rows on Supabase: a read that returns this many may be truncated. */
export const SEGMENT_PAGE = 1000;

/** The columns a segment read selects (a module-level literal for check:write-path-columns). */
export const SEGMENT_COLUMNS = "id, item_id, start_ms, end_ms, label";

export interface MemorySegmentRow {
  id: string;
  itemId: string;
  startMs: number;
  endMs: number;
  label: string | null;
}

export type SegmentsRead =
  | { state: "absent" }
  | { state: "unreadable"; detail: string }
  | { state: "ok"; rows: MemorySegmentRow[] };

export type MeasuredDuration =
  | { state: "measured"; durationMs: number }
  | { state: "unknown"; why: "external_media" | "no_asset" | "not_owners_asset" | "no_duration" }
  | { state: "not_a_video" }
  | { state: "unreadable"; detail: string };

const isWholeMs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/**
 * One stored row as the API serves it, or null for a row that cannot be a
 * segment (a window the CHECK forbids, a label past its bound). Such a row is
 * DROPPED, never served "as best we can": a broken window could seek a player
 * outside the owner's choice.
 */
export function toSegmentRow(r: unknown): MemorySegmentRow | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : null;
  const itemId = typeof o.item_id === "string" ? o.item_id : null;
  const start = o.start_ms;
  const end = o.end_ms;
  if (!id || !itemId || !isWholeMs(start) || !isWholeMs(end) || start < 0 || start >= end) return null;
  let label: string | null = null;
  if (o.label !== null && o.label !== undefined) {
    if (typeof o.label !== "string" || o.label.length === 0 || o.label.length > SEGMENT_LABEL_MAX) return null;
    label = o.label;
  }
  return { id, itemId, startMs: start, endMs: end, label };
}

/** Every segment on one Memory, ordered by start then end; absent ≠ empty ≠ unreadable. */
export async function readSegmentsForMemory(sc: any, memoryId: string): Promise<SegmentsRead> {
  try {
    const { data, error } = await sc
      .from("memory_media_segments")
      .select(SEGMENT_COLUMNS)
      .eq("memory_id", memoryId)
      .order("start_ms", { ascending: true })
      .order("end_ms", { ascending: true })
      .limit(SEGMENT_PAGE);
    if (error) {
      if (isTableAbsentError(error)) return { state: "absent" };
      return { state: "unreadable", detail: String((error as { message?: unknown }).message ?? "memory_media_segments unreadable") };
    }
    if (!Array.isArray(data)) return { state: "unreadable", detail: "memory_media_segments returned no row array" };
    // A FULL page may be truncated: an owner's segments past it would silently
    // vanish. Refuse rather than serve a partial list as the whole.
    if (data.length >= SEGMENT_PAGE) return { state: "unreadable", detail: `memory_media_segments page full (${data.length} rows)` };
    const rows: MemorySegmentRow[] = [];
    for (const r of data) {
      const row = toSegmentRow(r);
      if (row) rows.push(row);
    }
    return { state: "ok", rows };
  } catch (err) {
    return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

/** Is this item's stored media type a video? (`video`, `video/mp4`, `video/quicktime`, …) */
export function isVideoMediaType(mediaType: unknown): boolean {
  return typeof mediaType === "string" && /^video(\/|$)/i.test(mediaType.trim());
}

/**
 * The measured length of the video an item's `media_url` names, owned by
 * `ownerId`. See the header for every `unknown` and why each is refused.
 */
export async function measuredDurationFor(sc: any, ownerId: string, mediaUrl: unknown): Promise<MeasuredDuration> {
  let ref: { bucket: string; path: string } | null = null;
  try {
    ref = storageRefOf(String(mediaUrl ?? ""));
  } catch {
    ref = null;
  }
  if (!ref) return { state: "unknown", why: "external_media" };
  try {
    const { data, error } = await sc
      .from("media_assets")
      .select("owner_user_id, media_type, duration_ms")
      .eq("storage_bucket", ref.bucket)
      .eq("storage_path", ref.path)
      .maybeSingle();
    if (error) return { state: "unreadable", detail: String((error as { message?: unknown }).message ?? "media_assets unreadable") };
    if (!data) return { state: "unknown", why: "no_asset" };
    const row = data as { owner_user_id?: unknown; media_type?: unknown; duration_ms?: unknown };
    if (String(row.owner_user_id ?? "").toLowerCase() !== String(ownerId ?? "").toLowerCase()) return { state: "unknown", why: "not_owners_asset" };
    if (row.media_type !== "video") return { state: "not_a_video" };
    if (!isWholeMs(row.duration_ms) || row.duration_ms <= 0) return { state: "unknown", why: "no_duration" };
    return { state: "measured", durationMs: row.duration_ms };
  } catch (err) {
    return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

export type WindowVerdict =
  | { ok: true }
  | { ok: false; code: "segment_out_of_range"; message: string };

/** Is [startMs, endMs) inside a video `durationMs` long? The shape (0 ≤ start < end) is the body schema's. */
export function windowWithin(startMs: number, endMs: number, durationMs: number): WindowVerdict {
  if (endMs > durationMs) {
    return { ok: false, code: "segment_out_of_range", message: "That part runs past the end of the video." };
  }
  if (startMs < 0 || startMs >= endMs) {
    return { ok: false, code: "segment_out_of_range", message: "A part must start before it ends." };
  }
  return { ok: true };
}

/** How many segments the item already carries; absent ≠ unreadable. */
export async function countItemSegments(sc: any, itemId: string): Promise<{ state: "absent" } | { state: "unreadable"; detail: string } | { state: "ok"; count: number }> {
  try {
    const { count, error } = await sc
      .from("memory_media_segments")
      .select("id", { count: "exact", head: true })
      .eq("item_id", itemId);
    if (error) {
      if (isTableAbsentError(error)) return { state: "absent" };
      return { state: "unreadable", detail: String((error as { message?: unknown }).message ?? "memory_media_segments unreadable") };
    }
    if (typeof count !== "number") return { state: "unreadable", detail: "memory_media_segments returned no count" };
    return { state: "ok", count };
  } catch (err) {
    return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

export type SegmentInsert =
  | { ok: true; row: MemorySegmentRow }
  | { ok: false; reason: "not_deployed" | "duplicate" | "unavailable"; detail: string };

/** Mark one segment. Ownership, the item and the window are the caller's to have checked. */
export async function insertSegment(
  sc: any,
  input: { memoryId: string; itemId: string; ownerId: string; startMs: number; endMs: number; label: string | null },
): Promise<SegmentInsert> {
  try {
    const { data, error } = await sc
      .from("memory_media_segments")
      .insert({
        memory_id: input.memoryId,
        item_id: input.itemId,
        owner_id: input.ownerId,
        start_ms: input.startMs,
        end_ms: input.endMs,
        label: input.label,
      })
      .select(SEGMENT_COLUMNS)
      .single();
    if (error) {
      if (isTableAbsentError(error)) return { ok: false, reason: "not_deployed", detail: String(error.message ?? "") };
      if (String((error as { code?: unknown }).code ?? "") === "23505") return { ok: false, reason: "duplicate", detail: String(error.message ?? "") };
      return { ok: false, reason: "unavailable", detail: String(error.message ?? "") };
    }
    const row = toSegmentRow(data);
    if (!row) return { ok: false, reason: "unavailable", detail: "the insert returned no segment row" };
    return { ok: true, row };
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

export type SegmentDelete =
  | { ok: true }
  | { ok: false; reason: "not_deployed" | "not_found" | "unavailable"; detail: string };

/** Remove one segment of one Memory of one owner. Deletes no storage object: a segment never had one. */
export async function deleteSegment(sc: any, input: { memoryId: string; segmentId: string; ownerId: string }): Promise<SegmentDelete> {
  try {
    const { data, error } = await sc
      .from("memory_media_segments")
      .delete()
      .eq("id", input.segmentId)
      .eq("memory_id", input.memoryId)
      .eq("owner_id", input.ownerId)
      .select("id");
    if (error) {
      if (isTableAbsentError(error)) return { ok: false, reason: "not_deployed", detail: String(error.message ?? "") };
      return { ok: false, reason: "unavailable", detail: String(error.message ?? "") };
    }
    if (!Array.isArray(data)) return { ok: false, reason: "unavailable", detail: "the delete returned no row array" };
    if (data.length !== 1) return { ok: false, reason: "not_found", detail: "no such segment on this Memory" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}
