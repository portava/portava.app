/**
 * Layover L2 mutual discovery — §14 "L2 mutual discovery — profiles visible under policy" (census-layover L130), as a
 * PER-PAIR consent (migration 3875; owner decision 2026-10-18 §7: both parties explicitly opt in).
 *
 *   GET    /api/airport/sessions/:id/discovery                    requests waiting for my answer, and who I see (mutual)
 *   POST   /api/airport/sessions/:id/discovery/requests           ask to see ONE traveller, by handle
 *   POST   /api/airport/sessions/:id/discovery/:consentId/accept  my explicit opt-in to a request made to me
 *   POST   /api/airport/sessions/:id/discovery/:consentId/decline
 *   DELETE /api/airport/sessions/:id/discovery/:consentId         revoke (either side), at once
 *   POST   /api/airport/sessions/:id/discovery/withdraw           take back whatever I asked of a handle
 *
 * There is NO list of outgoing requests on purpose: a stored request proves the other person is here and sharing,
 * so the server never shows one, and the request route answers the same words whatever happened. Every call RESOLVES;
 * a failed read is `{ ok: false }`, never "nobody".
 */
import { freshToken } from './apiToken.ts';

export interface DiscoveryPerson { id: string; handle: string | null; name: string | null; avatarUrl: string | null }
export interface IncomingDiscoveryRequest { consentId: string; requestedAt: string; expiresAt: string; from: DiscoveryPerson }
export interface MutualDiscoveryPerson extends DiscoveryPerson { consentId: string | null; expiresAt: string | null }

export type DiscoveryRead =
  | { ok: true; available: false }
  | { ok: true; available: true; sharing: false; reason: string }
  | { ok: true; available: true; sharing: true; incoming: IncomingDiscoveryRequest[]; mutual: MutualDiscoveryPerson[]; degraded: boolean }
  | { ok: false; message: string };

export type DiscoveryAction = { ok: true; message: string | null } | { ok: false; message: string };

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const url = (sessionId: string, suffix = '') => `${apiBase()}/api/airport/sessions/${encodeURIComponent(sessionId)}/discovery${suffix}`;

function isRecord(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }

function personOf(v: unknown): DiscoveryPerson | null {
  if (!isRecord(v) || !str(v.id)) return null;
  return { id: v.id as string, handle: str(v.handle), name: str(v.name), avatarUrl: str(v.avatarUrl) };
}

/** Exported for tests: the whole read, fail-closed (an unreadable person is dropped and the answer says degraded). */
export function parseDiscoveryRead(status: number, json: unknown): DiscoveryRead {
  const r = isRecord(json) ? json : null;
  // A 404 that is not the feature answering (an older server without the route) is "not available", never a failure.
  if (status === 404 && (!r || r.available === undefined)) return { ok: true, available: false };
  if (status < 200 || status >= 300 || !r || r.ok !== true) return { ok: false, message: (r && str(r.message)) ?? 'Travellers you agreed to see could not be loaded.' };
  if (r.available === false) return { ok: true, available: false };
  if (r.available !== true) return { ok: false, message: 'Travellers you agreed to see could not be read.' };
  if (r.sharing !== true) return { ok: true, available: true, sharing: false, reason: str(r.reason) ?? 'sharing_off' };
  let dropped = false;
  const incoming: IncomingDiscoveryRequest[] = [];
  for (const x of Array.isArray(r.incoming) ? r.incoming : []) {
    const from = isRecord(x) ? personOf(x.from) : null;
    if (!from || !isRecord(x) || !str(x.consentId)) { dropped = true; continue; }
    incoming.push({ consentId: x.consentId as string, requestedAt: str(x.requestedAt) ?? '', expiresAt: str(x.expiresAt) ?? '', from });
  }
  const mutual: MutualDiscoveryPerson[] = [];
  for (const x of Array.isArray(r.mutual) ? r.mutual : []) {
    const p = personOf(x);
    if (!p || !isRecord(x)) { dropped = true; continue; }
    mutual.push({ ...p, consentId: str(x.consentId), expiresAt: str(x.expiresAt) });
  }
  return { ok: true, available: true, sharing: true, incoming, mutual, degraded: r.degraded === true || dropped };
}

async function call(u: string, init: RequestInit = {}): Promise<{ status: number; json: unknown } | null> {
  try {
    const token = await freshToken();
    const res = await fetch(u, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  } catch {
    return null;
  }
}

function action(r: { status: number; json: unknown } | null, fallback: string): DiscoveryAction {
  if (!r) return { ok: false, message: 'Could not reach Portava. Nothing was changed — try again.' };
  const j = isRecord(r.json) ? r.json : null;
  if (r.status >= 200 && r.status < 300 && j?.ok === true) return { ok: true, message: j ? str(j.message) : null };
  return { ok: false, message: (j && str(j.message)) ?? fallback };
}

export async function getDiscovery(sessionId: string): Promise<DiscoveryRead> {
  const r = await call(url(sessionId));
  if (!r) return { ok: false, message: 'Could not reach Portava to load travellers you agreed to see.' };
  return parseDiscoveryRead(r.status, r.json);
}

export async function requestDiscovery(sessionId: string, handle: string): Promise<DiscoveryAction> {
  return action(await call(url(sessionId, '/requests'), { method: 'POST', body: JSON.stringify({ handle }) }), 'Your request could not be sent. Please try again.');
}

export async function answerDiscovery(sessionId: string, consentId: string, accept: boolean): Promise<DiscoveryAction> {
  return action(await call(url(sessionId, `/${encodeURIComponent(consentId)}/${accept ? 'accept' : 'decline'}`), { method: 'POST' }), 'Your answer was not saved. Please try again.');
}

export async function endDiscovery(sessionId: string, consentId: string): Promise<DiscoveryAction> {
  return action(await call(url(sessionId, `/${encodeURIComponent(consentId)}`), { method: 'DELETE' }), 'That could not be ended. Please try again.');
}

export async function withdrawDiscovery(sessionId: string, handle: string): Promise<DiscoveryAction> {
  return action(await call(url(sessionId, '/withdraw'), { method: 'POST', body: JSON.stringify({ handle }) }), 'That could not be withdrawn. Please try again.');
}
