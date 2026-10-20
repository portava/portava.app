import { freshToken } from './apiToken.ts';
import { viewerKeyForToken } from './discoveryViewerScope.ts';

export interface MemoryOwnerRequest {
  memoryId: string;
  ownerId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  acceptsSession: (sessionId: string | null) => boolean;
  invalidateSession: () => void;
}

export function memoryOwnerSessionId(token: string | null | undefined): string | null {
  try {
    const part = token?.split('.')[1];
    if (!part) return null;
    const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(globalThis.atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)));
    if (!payload || typeof payload !== 'object' || !('session_id' in payload)) return null;
    return typeof payload.session_id === 'string' && payload.session_id.length > 0 ? payload.session_id : null;
  } catch { return null; }
}

export function assertMemoryOwnerRequest(memoryId: string, request: MemoryOwnerRequest): void {
  if (request.memoryId !== memoryId || request.signal.aborted || !request.isCurrent()) {
    throw new Error('This editing session changed. Reopen the Memory.');
  }
}

export async function memoryOwnerHeaders(memoryId: string, request: MemoryOwnerRequest): Promise<Record<string, string>> {
  assertMemoryOwnerRequest(memoryId, request);
  const token = await freshToken();
  assertMemoryOwnerRequest(memoryId, request);
  if (!token || viewerKeyForToken(token) !== `u:${request.ownerId}` || !request.acceptsSession(memoryOwnerSessionId(token))) {
    request.invalidateSession();
    throw new Error('This editing session changed. Reopen the Memory.');
  }
  return { Authorization: `Bearer ${token}` };
}

export function assertMemoryOwnerResponse(value: unknown, request: MemoryOwnerRequest): void {
  if (!value || typeof value !== 'object' || !('id' in value) || value.id !== request.memoryId
    || !('ownerId' in value) || value.ownerId !== request.ownerId) {
    throw new Error('This Memory is not available to edit.');
  }
}
