import { assertMemoryOwnerRequest, memoryOwnerHeaders, type MemoryOwnerRequest } from './memoryOwnerRequest.ts';
import { newMemoryOperationId } from './memories.ts';

export interface MemoryResurfacingRequest extends MemoryOwnerRequest { sessionId: string }
export interface PendingResurfacingIntent { on: boolean; acknowledged: boolean }
export type MemoryResurfacingFailure = 'unavailable' | 'feature_disabled' | 'not_found' | 'unauthenticated' | 'conflict' | 'cancelled' | 'pending';
export type MemoryResurfacingResult =
  | { ok: true; on: boolean; pending: PendingResurfacingIntent | null; intentMatched?: boolean }
  | { ok: false; kind: MemoryResurfacingFailure; pending: PendingResurfacingIntent | null };

interface PendingIntent extends PendingResurfacingIntent { operationId: string; inFlight: boolean }
interface ActiveRequest extends MemoryResurfacingRequest { base: string }
const pendingIntents = new Map<string, PendingIntent>();
const MAX_PENDING = 200;
const TIMEOUT_MS = 15000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ControlFailure extends Error {
  constructor(readonly kind: MemoryResurfacingFailure) { super(kind); }
}

function capture(request: MemoryResurfacingRequest): ActiveRequest {
  const { memoryId, ownerId, sessionId, signal, isCurrent, acceptsSession, invalidateSession } = request;
  return { memoryId, ownerId, sessionId, signal, isCurrent, invalidateSession,
    acceptsSession: next => next === sessionId && acceptsSession(next),
    base: (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '') };
}

function assertCurrent(request: MemoryResurfacingRequest): void {
  if (!UUID.test(request.memoryId) || !UUID.test(request.ownerId) || !request.sessionId) throw new ControlFailure('unavailable');
  if (request.signal.aborted || !request.isCurrent()) throw new ControlFailure('cancelled');
  assertMemoryOwnerRequest(request.memoryId, request);
}

function selector(request: MemoryResurfacingRequest): string {
  return JSON.stringify([request.ownerId.toLowerCase(), request.memoryId.toLowerCase()]);
}

function pendingView(key: string): PendingResurfacingIntent | null {
  const pending = pendingIntents.get(key);
  return pending ? { on: pending.on, acknowledged: pending.acknowledged } : null;
}

function failed(error: unknown, request: MemoryResurfacingRequest, key: string): MemoryResurfacingResult {
  const kind = request.signal.aborted || !request.isCurrent() ? 'cancelled'
    : error instanceof ControlFailure ? error.kind : 'unavailable';
  return { ok: false, kind, pending: pendingView(key) };
}

async function bounded<Value>(request: ActiveRequest, work: (active: ActiveRequest) => Promise<Value>): Promise<Value> {
  assertCurrent(request);
  if (!request.base) throw new ControlFailure('unavailable');
  const controller = new AbortController();
  const active: ActiveRequest = { ...request, signal: controller.signal,
    isCurrent: () => !controller.signal.aborted && !request.signal.aborted && request.isCurrent() };
  let interrupt!: (error: ControlFailure) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  const cancel = () => { controller.abort(); interrupt(new ControlFailure('cancelled')); };
  request.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { controller.abort(); interrupt(new ControlFailure('unavailable')); }, TIMEOUT_MS);
  try {
    return await Promise.race([interrupted, Promise.resolve().then(() => { assertCurrent(active); return work(active); })]);
  } finally {
    clearTimeout(timer); request.signal.removeEventListener('abort', cancel); controller.abort();
  }
}

function endpoint(request: ActiveRequest): string {
  return `${request.base}/api/memories/${encodeURIComponent(request.memoryId.toLowerCase())}/resurfacing-controls`;
}

async function send(request: ActiveRequest, headers: Record<string, string>, method: 'GET' | 'PUT' | 'DELETE'): Promise<Response> {
  assertCurrent(request);
  const response = await fetch(`${endpoint(request)}${method === 'GET' ? '' : '/DO_NOT_RESURFACE'}`, {
    method, headers, signal: request.signal, cache: 'no-store',
  });
  assertCurrent(request);
  if (response.status === (method === 'GET' ? 200 : 204)) return response;
  let body: unknown;
  try { body = await response.json(); } catch { throw new ControlFailure('unavailable'); }
  assertCurrent(request);
  const code = body && typeof body === 'object' && !Array.isArray(body) && 'error' in body ? body.error : null;
  if (response.status === 404 && code === 'feature_disabled') throw new ControlFailure('feature_disabled');
  if (response.status === 404 && code === 'not_found') throw new ControlFailure('not_found');
  if (response.status === 401 && code === 'unauthenticated') throw new ControlFailure('unauthenticated');
  if (response.status === 403 && code === 'forbidden') throw new ControlFailure('not_found');
  if (response.status === 409 && code === 'conflict') throw new ControlFailure('conflict');
  throw new ControlFailure('unavailable');
}

async function readValue(request: ActiveRequest, headers: Record<string, string>): Promise<boolean> {
  const response = await send(request, headers, 'GET');
  const value: unknown = await response.json();
  assertCurrent(request);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('memoryId' in value)
    || typeof value.memoryId !== 'string' || value.memoryId.toLowerCase() !== request.memoryId.toLowerCase()
    || !('controls' in value) || !Array.isArray(value.controls)) throw new ControlFailure('unavailable');
  const names = new Set<string>();
  let on: boolean | undefined;
  for (const row of value.controls) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.control !== 'string'
      || !row.control.trim() || typeof row.on !== 'boolean' || names.has(row.control)) throw new ControlFailure('unavailable');
    names.add(row.control);
    if (row.control === 'DO_NOT_RESURFACE') on = row.on;
  }
  if (on === undefined) throw new ControlFailure('unavailable');
  return on;
}

export async function readMemoryDoNotResurface(request: MemoryResurfacingRequest): Promise<MemoryResurfacingResult> {
  const captured = capture(request);
  const key = selector(captured);
  try {
    const on = await bounded(captured, async active => readValue(active, await memoryOwnerHeaders(active.memoryId, active)));
    assertCurrent(captured);
    const pending = pendingIntents.get(key);
    if (pending?.acknowledged && !pending.inFlight) {
      pendingIntents.delete(key);
      return { ok: true, on, pending: null, intentMatched: pending.on === on };
    }
    return { ok: true, on, pending: pendingView(key) };
  } catch (error) { return failed(error, captured, key); }
}

export async function writeMemoryDoNotResurface(request: MemoryResurfacingRequest, on: boolean): Promise<MemoryResurfacingResult> {
  const captured = capture(request);
  const key = selector(captured);
  try { assertCurrent(captured); } catch (error) { return failed(error, captured, key); }
  if (typeof on !== 'boolean') return { ok: false, kind: 'unavailable', pending: pendingView(key) };
  const previous = pendingIntents.get(key);
  if (previous && (previous.on !== on || previous.inFlight)) return { ok: false, kind: 'pending', pending: pendingView(key) };
  if (!previous && pendingIntents.size >= MAX_PENDING) return { ok: false, kind: 'unavailable', pending: null };
  const intent = previous ?? { on, operationId: newMemoryOperationId('memory-resurfacing'), acknowledged: false, inFlight: false };
  pendingIntents.set(key, intent);
  intent.inFlight = true;
  let sent = false;
  try {
    return await bounded(captured, async active => {
      const headers = await memoryOwnerHeaders(active.memoryId, active);
      assertCurrent(active);
      if (!intent.acknowledged) {
        sent = true;
        await send(active, { ...headers, 'Idempotency-Key': intent.operationId }, on ? 'PUT' : 'DELETE');
        assertCurrent(active);
        intent.acknowledged = true;
      }
      const currentOn = await readValue(active, headers);
      assertCurrent(active);
      pendingIntents.delete(key);
      return { ok: true, on: currentOn, pending: null, intentMatched: currentOn === on };
    });
  } catch (error) {
    if (!previous && !sent) pendingIntents.delete(key);
    return failed(error, captured, key);
  } finally { intent.inFlight = false; }
}
