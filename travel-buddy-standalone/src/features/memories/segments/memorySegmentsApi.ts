/**
 * memorySegmentsApi — the app's half of census-highlights-memories H184 (§20
 * "Video scenes as logical segments without duplicating originals"; server:
 * routes/memorySegments.ts, migration 3809; B58 cluster MEM-SEGMENTS).
 *
 *   GET    /api/memories/:id/segments                   the parts of its videos this viewer may see
 *   POST   /api/memories/:id/items/:itemId/segments     { startMs, endMs, label? }   owner only
 *   DELETE /api/memories/:id/segments/:segmentId        owner only
 *
 * A segment is a window [startMs, endMs) over a video the Memory already holds.
 * It is played from that video's own reference (`mediaUrl`, the value the
 * Memory detail already carries), so marking one uploads nothing.
 *
 * Every read answers one of four states, never a bare list: `ok` (with
 * `available: false` while 3809 is not applied — nothing to show or mark);
 * `not_found` (no such Memory, or not one this viewer may read — the server
 * answers both alike); `error` (anything else — never read as "no parts").
 */
import { freshToken } from '../../../services/apiToken.ts';

export interface VideoSegment {
  readonly id: string;
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly label: string | null;
  readonly mediaUrl: string;
  readonly mediaType: string;
}

export type SegmentsRead =
  | { state: 'ok'; available: boolean; segments: readonly VideoSegment[] }
  | { state: 'not_found' }
  | { state: 'error'; message: string };

export type SegmentWriteFailure =
  | 'unavailable' | 'duration_unknown' | 'out_of_range' | 'not_a_video' | 'conflict' | 'invalid' | 'not_found' | 'error';

export type SegmentWrite<T> = { ok: true; value: T } | { ok: false; reason: SegmentWriteFailure; message: string };

/** The server's label bound (3809's CHECK). */
export const SEGMENT_LABEL_MAX = 120;

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call(path: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const token = await freshToken();
  const res = await fetch(`${apiBase()}/api${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

const isWholeMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** One served segment, or null when it is not one (never repaired, never guessed). */
export function toVideoSegment(raw: unknown): VideoSegment | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.itemId !== 'string' || typeof o.mediaUrl !== 'string' || o.mediaUrl.length === 0) return null;
  if (!isWholeMs(o.startMs) || !isWholeMs(o.endMs) || o.startMs >= o.endMs) return null;
  if (o.label !== null && (typeof o.label !== 'string' || o.label.length === 0 || o.label.length > SEGMENT_LABEL_MAX)) return null;
  return {
    id: o.id, itemId: o.itemId, startMs: o.startMs, endMs: o.endMs,
    label: o.label as string | null, mediaUrl: o.mediaUrl, mediaType: typeof o.mediaType === 'string' ? o.mediaType : 'video',
  };
}

const errorMessage = (json: Record<string, unknown> | null, fallback: string) =>
  typeof json?.message === 'string' && json.message.length > 0 ? json.message : fallback;

/** Every segment of a Memory's videos that this viewer may see. */
export async function fetchMemorySegments(memoryId: string): Promise<SegmentsRead> {
  try {
    const { status, json } = await call(`/memories/${encodeURIComponent(memoryId)}/segments`, { method: 'GET' });
    if (status === 404) return { state: 'not_found' };
    if (status !== 200 || !json) return { state: 'error', message: errorMessage(json, 'The marked parts could not be loaded.') };
    if (typeof json.available !== 'boolean' || !Array.isArray(json.segments)) return { state: 'error', message: 'The marked parts could not be read.' };
    const segments: VideoSegment[] = [];
    for (const s of json.segments) {
      const seg = toVideoSegment(s);
      if (!seg) return { state: 'error', message: 'The marked parts could not be read.' };
      segments.push(seg);
    }
    return { state: 'ok', available: json.available, segments };
  } catch {
    return { state: 'error', message: 'The marked parts could not be loaded.' };
  }
}

/**
 * One GET per Memory however many of its videos ask at once: every caller that
 * arrives while a read is in flight shares it. Nothing is cached past the read.
 */
const inflight = new Map<string, Promise<SegmentsRead>>();
export function loadMemorySegments(memoryId: string): Promise<SegmentsRead> {
  const running = inflight.get(memoryId);
  if (running) return running;
  const p = fetchMemorySegments(memoryId).finally(() => { inflight.delete(memoryId); });
  inflight.set(memoryId, p);
  return p;
}

function writeFailure(status: number, json: Record<string, unknown> | null): { ok: false; reason: SegmentWriteFailure; message: string } {
  const code = typeof json?.error === 'string' ? json.error : '';
  if (status === 404 && code === 'feature_disabled') return { ok: false, reason: 'unavailable', message: errorMessage(json, 'Marking parts of a video is not available yet.') };
  if (status === 404) return { ok: false, reason: 'not_found', message: errorMessage(json, 'That could not be found.') };
  if (status === 422 && code === 'duration_unknown') return { ok: false, reason: 'duration_unknown', message: errorMessage(json, "This video's length hasn't been measured yet.") };
  if (status === 422 && code === 'segment_out_of_range') return { ok: false, reason: 'out_of_range', message: errorMessage(json, 'That part runs past the end of the video.') };
  if (status === 422 && code === 'not_a_video') return { ok: false, reason: 'not_a_video', message: errorMessage(json, 'Only a video can be split into parts.') };
  if (status === 409) return { ok: false, reason: 'conflict', message: errorMessage(json, 'That part is already marked.') };
  if (status === 400) return { ok: false, reason: 'invalid', message: errorMessage(json, 'Check the start and end times.') };
  return { ok: false, reason: 'error', message: 'That could not be saved. Please try again.' };
}

/** Mark [startMs, endMs) of one of the owner's videos. Only a 201 carrying the segment is success. */
export async function markVideoSegment(
  memoryId: string,
  itemId: string,
  input: { startMs: number; endMs: number; label: string | null },
): Promise<SegmentWrite<VideoSegment>> {
  try {
    const { status, json } = await call(`/memories/${encodeURIComponent(memoryId)}/items/${encodeURIComponent(itemId)}/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startMs: input.startMs, endMs: input.endMs, label: input.label }),
    });
    if (status === 201) {
      const seg = toVideoSegment(json?.segment);
      return seg ? { ok: true, value: seg } : { ok: false, reason: 'error', message: 'That could not be saved. Please try again.' };
    }
    return writeFailure(status, json);
  } catch {
    return { ok: false, reason: 'error', message: 'That could not be saved. Please try again.' };
  }
}

/** Remove one marked part. Only a 204 is success. The video itself is untouched. */
export async function removeVideoSegment(memoryId: string, segmentId: string): Promise<SegmentWrite<null>> {
  try {
    const { status, json } = await call(`/memories/${encodeURIComponent(memoryId)}/segments/${encodeURIComponent(segmentId)}`, { method: 'DELETE' });
    if (status === 204) return { ok: true, value: null };
    return writeFailure(status, json);
  } catch {
    return { ok: false, reason: 'error', message: 'That could not be removed. Please try again.' };
  }
}

// ── The editor's clock ─────────────────────────────────────────────────────────

/**
 * "1:05", "1:05.5", "65", "0:00.25" → milliseconds; anything else → null. Minutes
 * and seconds only (a Memory clip is short); seconds under 60 when minutes are given.
 */
export function parseClock(text: string): number | null {
  const t = text.trim();
  const m = /^(?:(\d{1,3}):)?(\d{1,4})(?:\.(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const minutes = m[1] === undefined ? 0 : Number(m[1]);
  const seconds = Number(m[2]);
  if (m[1] !== undefined && seconds >= 60) return null;
  const frac = m[3] === undefined ? 0 : Math.round(Number(`0.${m[3]}`) * 1000);
  const ms = (minutes * 60 + seconds) * 1000 + frac;
  return Number.isSafeInteger(ms) ? ms : null;
}

/** Milliseconds → "m:ss" (with tenths when the window is not on a whole second). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  const base = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return total % 1000 === 0 ? base : `${base}.${tenths}`;
}

/** What a chip says: the owner's label, or the window itself. */
export function segmentTitle(seg: Pick<VideoSegment, 'label' | 'startMs' | 'endMs'>): string {
  return seg.label ?? `${formatClock(seg.startMs)}–${formatClock(seg.endMs)}`;
}

/** Is this item a video by its stored type? (`video`, `video/mp4`, …) */
export function isVideoItemType(mediaType: unknown): boolean {
  return typeof mediaType === 'string' && /^video(\/|$)/i.test(mediaType.trim());
}
