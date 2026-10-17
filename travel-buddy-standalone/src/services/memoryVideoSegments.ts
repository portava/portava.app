import { z } from 'zod';
import { supabase } from '../lib/supabase.ts';
import { freshToken, isCurrentSessionToken } from './apiToken.ts';

const integer = z.number().int().min(1).max(2147483647);
const offset = z.number().int().min(0).max(2147483647);
const scopeSchema = z.object({ ownerId: z.string().uuid(), memoryId: z.string().uuid(), itemId: z.string().uuid() }).strict();
const assetSchema = z.object({ assetId: z.string().uuid(), assetVersion: integer, durationMs: integer }).strict();
const sourceSchema = assetSchema.extend({ mediaRef: z.string().startsWith('post-media/').refine(value => originalPath(value) !== null) }).strict();
const labelSchema = z.string().trim().min(1).max(160).nullable();
const segmentSchema = scopeSchema.merge(assetSchema).extend({
  id: z.string().uuid(), startMs: offset, endMs: integer, label: labelSchema,
  source: z.literal('owner_asserted'), createdAt: z.string().datetime({ offset: true }),
}).strict().refine(segment => segment.startMs < segment.endMs && segment.endMs <= segment.durationMs);
const createSchema = z.object({
  operationId: z.string().uuid(), assetId: z.string().uuid(), assetVersion: integer,
  startMs: offset, endMs: integer, label: labelSchema.optional().default(null),
}).strict().refine(segment => segment.startMs < segment.endMs);
const listSchema = z.object({ source: sourceSchema, segments: z.array(segmentSchema).max(100) }).strict();
const createdSchema = z.object({ segment: segmentSchema, created: z.boolean() }).strict();

export type VideoSegmentScope = z.infer<typeof scopeSchema>;
export type VideoSegmentSource = z.infer<typeof sourceSchema>;
export type MemoryVideoSegment = z.infer<typeof segmentSchema>;
export type VideoSegmentCreate = z.input<typeof createSchema>;
export type VideoSegmentList = z.infer<typeof listSchema>;
export type VideoSegmentFailureKind = 'feature_disabled' | 'degraded_unavailable' | 'not_found' | 'unauthenticated'
  | 'forbidden' | 'conflict' | 'invalid_payload' | 'network_unreachable' | 'cancelled';
export type VideoSegmentFailure = { ok: false; kind: VideoSegmentFailureKind };
export type VideoSegmentResult<Payload> = ({ ok: true } & Payload) | VideoSegmentFailure;

const fail = (kind: VideoSegmentFailureKind): VideoSegmentFailure => ({ ok: false, kind });

export function sameVideoSegmentSource(left: z.infer<typeof assetSchema>, right: z.infer<typeof assetSchema>): boolean {
  return left.assetId === right.assetId && left.assetVersion === right.assetVersion && left.durationMs === right.durationMs;
}

function belongsTo(segment: MemoryVideoSegment, scope: VideoSegmentScope, source: VideoSegmentSource): boolean {
  return segment.ownerId === scope.ownerId && segment.memoryId === scope.memoryId && segment.itemId === scope.itemId
    && sameVideoSegmentSource(segment, source);
}

function endpoint(scope: VideoSegmentScope): string {
  return `/api/memories/${encodeURIComponent(scope.memoryId)}/items/${encodeURIComponent(scope.itemId)}/video-segments`;
}

async function request(
  scope: VideoSegmentScope, path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal,
): Promise<VideoSegmentResult<{ body: unknown; status: number }>> {
  if (signal?.aborted) return fail('cancelled');
  if (!scopeSchema.safeParse(scope).success) return fail('invalid_payload');
  const controller = new AbortController();
  let timedOut = false;
  const interrupted = () => fail(timedOut ? 'network_unreachable' : 'cancelled');
  let settleInterruption!: (result: VideoSegmentFailure) => void;
  const interruption = new Promise<VideoSegmentFailure>(resolve => { settleInterruption = resolve; });
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    settleInterruption(interrupted());
  };
  const timeout = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; abort(); } }, 15000);
  signal?.addEventListener('abort', abort);
  let subscription: { unsubscribe: () => void } | undefined;
  const perform = async (): Promise<VideoSegmentResult<{ body: unknown; status: number }>> => {
    if (controller.signal.aborted) return interrupted();
    const token = await freshToken();
    if (controller.signal.aborted) return interrupted();
    const ownerBound = token ? await isCurrentSessionToken(scope.ownerId, token) : false;
    if (controller.signal.aborted) return interrupted();
    if (!token || !ownerBound) return fail('unauthenticated');
    const response = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store',
    });
    if (controller.signal.aborted) return interrupted();
    const value: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (controller.signal.aborted) return interrupted();
    const { data: { session: latest } } = await supabase.auth.getSession();
    if (controller.signal.aborted) return interrupted();
    if (latest?.user.id !== scope.ownerId) return fail('unauthenticated');
    if (!response.ok) {
      const code = value && typeof value === 'object' && 'error' in value ? value.error : null;
      if (code === 'feature_disabled' && response.status === 404) return fail('feature_disabled');
      if (response.status === 404) return fail('not_found');
      if (response.status === 401) return fail('unauthenticated');
      if (response.status === 403) return fail('forbidden');
      if (response.status === 409) return fail('conflict');
      if (response.status === 400) return fail('invalid_payload');
      return fail('degraded_unavailable');
    }
    return { ok: true, body: value, status: response.status };
  };
  try {
    subscription = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || session?.user.id !== scope.ownerId) abort();
    }).data.subscription;
    if (signal?.aborted) abort();
    return await Promise.race([perform(), interruption]);
  } catch {
    return controller.signal.aborted ? interrupted() : fail('network_unreachable');
  } finally {
    clearTimeout(timeout);
    subscription?.unsubscribe();
    signal?.removeEventListener('abort', abort);
  }
}

export async function listMemoryVideoSegments(scope: VideoSegmentScope, signal?: AbortSignal): Promise<VideoSegmentResult<VideoSegmentList>> {
  const result = await request(scope, endpoint(scope), 'GET', undefined, signal);
  if (!result.ok) return result;
  const parsed = listSchema.safeParse(result.body);
  if (result.status !== 200 || !parsed.success) return fail('degraded_unavailable');
  const { source, segments } = parsed.data;
  if (new Set(segments.map(segment => segment.id)).size !== segments.length
    || segments.some(segment => !belongsTo(segment, scope, source))) return fail('degraded_unavailable');
  return { ok: true, source, segments };
}

export async function createMemoryVideoSegment(
  scope: VideoSegmentScope, source: VideoSegmentSource, input: VideoSegmentCreate, signal?: AbortSignal,
): Promise<VideoSegmentResult<z.infer<typeof createdSchema>>> {
  const parsed = createSchema.safeParse(input);
  if (!sourceSchema.safeParse(source).success || !parsed.success || parsed.data.assetId !== source.assetId
    || parsed.data.assetVersion !== source.assetVersion || parsed.data.endMs > source.durationMs) return fail('invalid_payload');
  const result = await request(scope, endpoint(scope), 'POST', parsed.data, signal);
  if (!result.ok) return result;
  const reply = createdSchema.safeParse(result.body);
  if ((result.status !== 200 && result.status !== 201) || !reply.success
    || !belongsTo(reply.data.segment, scope, source) || reply.data.segment.id !== parsed.data.operationId
    || reply.data.segment.startMs !== parsed.data.startMs
    || reply.data.segment.endMs !== parsed.data.endMs || reply.data.segment.label !== parsed.data.label
    || reply.data.created !== (result.status === 201)) return fail('degraded_unavailable');
  return { ok: true, ...reply.data };
}

export async function deleteMemoryVideoSegment(scope: VideoSegmentScope, id: string, signal?: AbortSignal): Promise<VideoSegmentResult<object>> {
  if (!z.string().uuid().safeParse(id).success) return fail('invalid_payload');
  const result = await request(scope, `${endpoint(scope)}/${encodeURIComponent(id)}`, 'DELETE', undefined, signal);
  return !result.ok ? result : result.status === 204 ? { ok: true } : fail('degraded_unavailable');
}

function originalPath(uri: string): string | null {
  try {
    const storage = new URL(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '');
    let path = uri;
    if (!uri.startsWith('post-media/')) {
      const url = new URL(uri);
      if (url.origin !== storage.origin || url.search || url.hash || url.username || url.password
        || !url.pathname.startsWith('/storage/v1/object/public/post-media/')) return null;
      path = url.pathname.slice('/storage/v1/object/public/'.length);
    }
    const decoded = decodeURIComponent(path);
    if (!decoded.startsWith('post-media/') || /[\\?#\s]/.test(decoded)
      || decoded.split('/').some(part => !part || part === '.' || part === '..')) return null;
    return decoded;
  } catch { return null; }
}

export async function resolveMemoryVideoOriginal(
  scope: VideoSegmentScope, uri: string, signal?: AbortSignal,
): Promise<VideoSegmentResult<{ uri: string }>> {
  const path = originalPath(uri);
  if (!path) return fail('not_found');
  const result = await request(scope, '/api/media/sign', 'POST', { urls: [uri] }, signal);
  if (!result.ok) return result;
  const parsed = z.object({ signed: z.record(z.string().nullable()) }).safeParse(result.body);
  const signed = parsed.success ? parsed.data.signed[uri] : null;
  try {
    if (!signed) return fail('not_found');
    const url = new URL(signed);
    const storage = new URL(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '');
    if (url.origin !== storage.origin || url.username || url.password || url.hash || !url.searchParams.get('token')
      || decodeURIComponent(url.pathname) !== `/storage/v1/object/sign/${path}`) return fail('not_found');
    return { ok: true, uri: signed };
  } catch { return fail('not_found'); }
}

export function newVideoSegmentOperationId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 3) | 8).toString(16);
  });
}
