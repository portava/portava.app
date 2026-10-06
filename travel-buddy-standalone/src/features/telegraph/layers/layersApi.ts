/**
 * Telegraph §2.3 — `GET /api/threads/:id/layers`, the server's TALK / PLAN /
 * NOW partition for one viewer (services/telegraph/layers.ts). NOW is bounded
 * in time on the server (NOW_LAYER_WINDOW_MINUTES), so drawing it can never
 * hide an old message from the stream.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export type PlanOpenReason = 'decision_open' | 'commitment_open' | 'acknowledgement_pending' | 'action_unanswered';
export type NowReason = 'declared_status' | 'rendezvous' | 'location_scope' | 'safety';

export interface LayerItemView {
  messageId: string;
  senderId: string;
  createdAt: string;
  layer: 'PLAN' | 'NOW';
  kind: string;
  title: string | null;
  openReason: PlanOpenReason | null;
  nowReason: NowReason | null;
}

export interface LayersResponse {
  threadId: string;
  plan: LayerItemView[];
  now: LayerItemView[];
  talk: string[];
  partitioned: true;
}

export type LayersResult = { ok: true; data: LayersResponse } | { ok: false; error: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export async function fetchLayers(threadId: string): Promise<LayersResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/layers`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, error: String(res.status) };
    const body = (await res.json()) as LayersResponse;
    // A response that does not say it is a partition is not one this client may draw from.
    if (body?.partitioned !== true || !Array.isArray(body.plan) || !Array.isArray(body.now)) return { ok: false, error: 'malformed' };
    return { ok: true, data: body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }
}

/** The coordination kinds the coordination panel draws with its vote chips; the strip draws one only when the panel says it is not (R1). */
export const PANEL_DRAWN_KINDS: readonly string[] = ['DECISION', 'COMMITMENT'];

/**
 * Which message ids leave the conversation stream: every layer item whose
 * message is loaded on this screen (so it is drawn above, by the strip or the
 * panel). An item whose message is not loaded hides nothing — there is nothing
 * in the stream to hide — and a failed layers read hides NOTHING.
 */
export function layeredStreamIds(layers: LayersResponse | null, loadedIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (!layers) return out;
  for (const item of [...layers.plan, ...layers.now]) {
    if (loadedIds.has(item.messageId)) out.add(item.messageId);
  }
  return out;
}
