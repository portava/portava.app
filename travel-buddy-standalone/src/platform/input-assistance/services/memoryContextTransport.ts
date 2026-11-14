/**
 * Compass memory for input assistance — the IMPURE half (real fetch + token).
 * Decisions live in memoryContext.ts (pure) and on the server
 * (lib/inputAssistance/memoryContext.ts). Must NOT be imported by node:test.
 *
 *   GET /api/input-assistance/memory-context            — state + inspect view
 *   PUT /api/input-assistance/memory-context-consent    — grant / revoke
 */
import { withInputApiResponse } from './inputApiRequest.ts';
import { MEMORY_CONTEXT_DISCLOSURE_VERSION, parseMemoryContextView, type MemoryContextView } from './memoryContext.ts';

export type MemoryContextRead = { status: 'ok'; view: MemoryContextView } | { status: 'unreadable' };

export async function readMemoryContext(): Promise<MemoryContextRead> {
  try {
    return await withInputApiResponse<MemoryContextRead>('/api/input-assistance/memory-context', {}, async res => {
      if (!res.ok) return { status: 'unreadable' };
      const view = parseMemoryContextView(await res.json());
      return view ? { status: 'ok', view } : { status: 'unreadable' };
    });
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
    return await withInputApiResponse<MemoryContextWrite>('/api/input-assistance/memory-context-consent', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enabled ? { enabled: true, disclosureVersion: MEMORY_CONTEXT_DISCLOSURE_VERSION } : { enabled: false }),
    }, async res => {
      if (res.status === 404) return { status: 'unavailable' };
      if (res.status === 409) return { status: 'stale_disclosure' };
      return res.ok ? { status: 'ok' } : { status: 'failed' };
    });
  } catch {
    return { status: 'failed' };
  }
}
