/**
 * Compass memory for input assistance — the IMPURE half (real fetch + token).
 * Decisions live in memoryContext.ts (pure) and on the server
 * (lib/inputAssistance/memoryContext.ts). Must NOT be imported by node:test.
 *
 *   GET /api/input-assistance/memory-context            — state + inspect view
 *   PUT /api/input-assistance/memory-context-consent    — grant / revoke
 */
import { freshToken as freshApiToken } from '../../../services/apiToken.ts';
import { MEMORY_CONTEXT_DISCLOSURE_VERSION, parseMemoryContextView, type MemoryContextView } from './memoryContext.ts';

async function authed(path: string, init: RequestInit = {}): Promise<Response | null> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!base) return null;
  let token: string | null = null;
  try {
    token = await freshApiToken();
  } catch {
    token = null;
  }
  if (!token) return null;
  return fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

export type MemoryContextRead = { status: 'ok'; view: MemoryContextView } | { status: 'unreadable' };

export async function readMemoryContext(): Promise<MemoryContextRead> {
  try {
    const res = await authed('/api/input-assistance/memory-context');
    if (!res || !res.ok) return { status: 'unreadable' };
    const view = parseMemoryContextView(await res.json());
    return view ? { status: 'ok', view } : { status: 'unreadable' };
  } catch {
    return { status: 'unreadable' };
  }
}

export type MemoryContextWrite =
  | { status: 'ok' }
  | { status: 'unavailable' }
  | { status: 'stale_disclosure' }
  | { status: 'failed' };

export async function writeMemoryContextConsent(enabled: boolean): Promise<MemoryContextWrite> {
  try {
    const res = await authed('/api/input-assistance/memory-context-consent', {
      method: 'PUT',
      body: JSON.stringify(enabled ? { enabled: true, disclosureVersion: MEMORY_CONTEXT_DISCLOSURE_VERSION } : { enabled: false }),
    });
    if (!res) return { status: 'failed' };
    if (res.status === 404) return { status: 'unavailable' };
    if (res.status === 409) return { status: 'stale_disclosure' };
    return res.ok ? { status: 'ok' } : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
