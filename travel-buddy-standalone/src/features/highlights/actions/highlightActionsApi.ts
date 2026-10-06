/**
 * Client for §12 Highlight actions (census-highlights-memories H102):
 * GET /api/highlights/:id/actions.
 *
 * The venue actions are the Memory actions of the Memory this Highlight
 * projects; `sourceMemoryId` is present only when THIS viewer may read that
 * Memory, and every compile goes through the Memory routes, which re-check.
 * A failed read is an error, never an empty set of actions.
 */
import { freshToken } from '../../../services/apiToken.ts';
import type { CatalogCaution, CurrentPlace } from '../../memories/actions/memoryActionsApi.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type HighlightActionName = 'DO_THIS' | 'SAVE' | 'ADD_TO_TRIP' | 'VIEW_PLACE' | 'ASK' | 'MEET';

export interface HighlightActionDescriptor {
  action: HighlightActionName;
  available: boolean;
  reason: string | null;
  message: string | null;
  caution: CatalogCaution | null;
}

export interface HighlightActionMenu {
  highlightId: string;
  sourceMemoryId: string | null;
  place: CurrentPlace | null;
  actions: HighlightActionDescriptor[];
}

export type HighlightActionsResult =
  | { ok: true; menu: HighlightActionMenu }
  | { ok: false; kind: 'not_found' | 'unavailable' | 'network_unreachable'; message: string };

export async function getHighlightActions(highlightId: string): Promise<HighlightActionsResult> {
  try {
    const token = await freshToken();
    const res = await fetch(`${apiBase()}/api/highlights/${encodeURIComponent(highlightId)}/actions`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const json = (await res.json().catch(() => null)) as { menu?: Partial<HighlightActionMenu>; message?: unknown } | null;
    if (res.status === 404) return { ok: false, kind: 'not_found', message: 'This Highlight is not available.' };
    if (!res.ok) {
      const m = json?.message;
      return { ok: false, kind: 'unavailable', message: typeof m === 'string' && m ? m : 'What you can do with this Highlight could not be checked.' };
    }
    const menu = json?.menu;
    if (!menu || !Array.isArray(menu.actions) || typeof menu.highlightId !== 'string') {
      return { ok: false, kind: 'unavailable', message: 'The server answered in a shape this app does not understand.' };
    }
    return { ok: true, menu: menu as HighlightActionMenu };
  } catch (e) {
    const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const offline = m.includes('network request failed') || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed');
    return { ok: false, kind: offline ? 'network_unreachable' : 'unavailable', message: offline ? 'You appear to be offline.' : 'What you can do with this Highlight could not be checked.' };
  }
}
