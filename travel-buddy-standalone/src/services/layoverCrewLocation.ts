/**
 * Layover crew location — §14 L4 "temporary location — explicit, scoped,
 * auto-expiring" (census-layover L132, L158, L166, L203, L124, L277).
 *
 *   GET    /api/airport/sessions/:id/crew/location
 *   POST   /api/airport/sessions/:id/crew/location
 *   DELETE /api/airport/sessions/:id/crew/location
 *   PUT    /api/airport/sessions/:id/crew/location/precise-control
 *
 * Its own file rather than `services/layover.ts`, whose lines are cited by the
 * census. Every call RESOLVES: a failed read is `{ ok: false }`, never "nobody
 * is sharing" — the two would draw the same empty list.
 *
 * Nothing here reads the device's position. A coordinate reaches a share only
 * because the traveller picked a place that already has one (a plan stop); the
 * layover client imports no location API (census L164).
 */
import { freshToken } from './apiToken.ts';
import {
  isRecord, str, parseCrewLocation,
  type CrewSharePrecision, type GeoPoint, type CrewLocationRead,
} from './layoverCrewLocationContract.ts';
export * from './layoverCrewLocationContract.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

function crewLocationUrl(sessionId: string, suffix = ''): string {
  return `${apiBase()}/api/airport/sessions/${encodeURIComponent(sessionId)}/crew/location${suffix}`;
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

export async function getCrewLocation(sessionId: string): Promise<CrewLocationRead> {
  let res: Response;
  try {
    res = await authedFetch(crewLocationUrl(sessionId));
  } catch {
    return { ok: false, reason: 'unreachable', message: 'Could not reach Portava to load crew locations.' };
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { json = null; }
  return parseCrewLocation(res.status, json);
}

export type CrewLocationWrite = { ok: true } | { ok: false; reason: string; message: string };

async function write(url: string, init: RequestInit): Promise<CrewLocationWrite> {
  let res: Response;
  try {
    res = await authedFetch(url, init);
  } catch {
    return { ok: false, reason: 'unreachable', message: 'Could not reach Portava. Nothing was changed — try again.' };
  }
  let json: Record<string, unknown> | null = null;
  try { const j = await res.json(); json = isRecord(j) ? j : null; } catch { json = null; }
  if (res.ok && json?.ok === true) return { ok: true };
  return {
    ok: false,
    reason: (json && (str(json, 'reason') ?? str(json, 'error'))) ?? 'refused',
    message: (json && str(json, 'message')) ?? 'That did not save. Please try again.',
  };
}

export interface CrewShareInput {
  label: string;
  precision: CrewSharePrecision;
  expiresAt: string;
  /** Only from a picked place, and never sent at area precision. */
  point?: GeoPoint | null;
}

export function shareCrewLocation(sessionId: string, input: CrewShareInput): Promise<CrewLocationWrite> {
  const body: Record<string, unknown> = { label: input.label, precision: input.precision, expiresAt: input.expiresAt };
  if (input.precision !== 'area' && input.point) { body.lat = input.point.lat; body.lng = input.point.lng; }
  return write(crewLocationUrl(sessionId), { method: 'POST', body: JSON.stringify(body) });
}

export function stopCrewLocation(sessionId: string): Promise<CrewLocationWrite> {
  return write(crewLocationUrl(sessionId), { method: 'DELETE' });
}

export function setCrewPreciseControl(sessionId: string, enabled: boolean): Promise<CrewLocationWrite> {
  return write(crewLocationUrl(sessionId, '/precise-control'), { method: 'PUT', body: JSON.stringify({ enabled }) });
}
