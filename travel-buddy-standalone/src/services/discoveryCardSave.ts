/**
 * discoveryCardSave — the Save on a shared Discovery card, as a Telegraph
 * COMMAND (census-discovery §95, lane W11-X3; §81.4 routed hunk R1; register
 * D-W11X3-4; A21).
 *
 * The tap becomes `POST /api/telegraph/commands/discovery-card`, which proposes
 * one `discovery_save_place` action only when the server's authorize says the
 * person may save this place; the person's tap IS the confirmation, so the
 * client then confirms that one action through the ordinary
 * `POST /api/telegraph/commands/:commandId/confirm-action`, where Discovery's
 * own save performs the write. Nothing here writes a save itself.
 *
 * GATE: the server's `telegraph_discovery_actions_enabled` (3467, seeded
 * FALSE). While it is off the command answers 404 `feature_disabled`, and this
 * returns `{ kind: 'fallback' }`: the card then runs today's `toggleSave`,
 * unchanged. So with the flag off the person sees exactly what they saw before.
 *
 * Outcomes:
 *   saved     — the canonical write landed (confirm-action answered confirmed)
 *   fallback  — the server has the Telegraph path off; use toggleSave
 *   refused   — the server's authorize said no (the place is gone, blocked, …);
 *               its reason is shown, and nothing is saved by any other path
 *   failed    — anything else (network, 5xx, a compensated write); nothing is
 *               claimed, and the person may try again
 */
import { freshToken } from './apiToken.ts';

export interface DiscoveryCardSaveInput {
  sourceId: string;
  sourceType?: string | null;
  title: string;
  category: string;
  city?: string | null;
}

export type DiscoveryCardSaveOutcome =
  | { kind: 'saved'; message: string }
  | { kind: 'fallback' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string };

const FAILED = 'That could not be saved right now. Please try again.';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any } | null> {
  let token: string | null = null;
  try { token = await freshToken(); } catch { token = null; }
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch {
    return null;
  }
}

/** The command body: exactly the fields the server's DiscoveryCardSchema reads, and only those present. */
export function discoveryCardCommandBody(p: DiscoveryCardSaveInput): Record<string, string> {
  const body: Record<string, string> = { placeId: p.sourceId };
  if (p.title) body.title = p.title;
  if (p.category) body.category = p.category;
  if (p.sourceType) body.type = p.sourceType;
  if (p.city) body.city = p.city;
  return body;
}

export async function saveDiscoveryCardViaTelegraph(p: DiscoveryCardSaveInput): Promise<DiscoveryCardSaveOutcome> {
  if (!p.sourceId) return { kind: 'fallback' };
  const cmd = await post('/api/telegraph/commands/discovery-card', discoveryCardCommandBody(p));
  if (!cmd) return { kind: 'failed', message: FAILED };
  if (cmd.status === 404 && cmd.json?.error === 'feature_disabled') return { kind: 'fallback' };
  if (cmd.status === 403 && typeof cmd.json?.message === 'string') return { kind: 'refused', message: cmd.json.message };
  const commandId: unknown = cmd.json?.commandId;
  const action = Array.isArray(cmd.json?.proposedActions)
    ? cmd.json.proposedActions.find((a: any) => a?.kind === 'discovery_save_place')
    : null;
  if (cmd.status !== 201 || typeof commandId !== 'string' || typeof action?.id !== 'string') {
    return { kind: 'failed', message: FAILED };
  }
  const done = await post(`/api/telegraph/commands/${encodeURIComponent(commandId)}/confirm-action`, { actionId: action.id });
  if (!done) return { kind: 'failed', message: FAILED };
  if (done.status === 200 && done.json?.confirmed === true) {
    return { kind: 'saved', message: `"${p.title}" was added to your saved places.` };
  }
  if (done.status === 403 && typeof done.json?.message === 'string') return { kind: 'refused', message: done.json.message };
  return { kind: 'failed', message: typeof done.json?.message === 'string' && done.status === 409 ? done.json.message : FAILED };
}
