/**
 * Layover crew split plans — §14.1 (census-layover L134, L135).
 *
 *   GET    /api/airport/sessions/:id/crew/plan     the crew's live plan, certified against every member branch NOW
 *   POST   /api/airport/sessions/:id/crew/plan     propose a split (refused with the reasons when it does not certify)
 *   DELETE /api/airport/sessions/:id/crew/plan     withdraw it
 *
 * Its own file rather than `services/layover.ts`, whose lines are cited by the census. Every call RESOLVES: a failed
 * read is `{ ok: false }`, never "no plan" — a traveller told there is no split would follow the crew's shared deadline
 * while a crewmate follows another.
 */
import { freshToken } from './apiToken.ts';
import {
  parseCrewPlanPropose, parseCrewPlanRead,
  type CrewPlanProposal, type CrewPlanProposeOutcome, type CrewPlanRead,
} from './layoverCrewPlanContract.ts';
export * from './layoverCrewPlanContract.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const planUrl = (sessionId: string) => `${apiBase()}/api/airport/sessions/${encodeURIComponent(sessionId)}/crew/plan`;

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown } | null> {
  try {
    const token = await freshToken();
    const res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  } catch {
    return null;
  }
}

export async function getCrewPlan(sessionId: string): Promise<CrewPlanRead> {
  const r = await call(planUrl(sessionId));
  if (!r) return { ok: false, message: 'Could not reach Portava to load your crew plan.' };
  return parseCrewPlanRead(r.status, r.json);
}

export async function proposeCrewPlan(sessionId: string, proposal: CrewPlanProposal): Promise<CrewPlanProposeOutcome> {
  const r = await call(planUrl(sessionId), { method: 'POST', body: JSON.stringify(proposal) });
  if (!r) return { ok: false, notCertified: null, message: 'Could not reach Portava. Nothing was saved — try again.' };
  return parseCrewPlanPropose(r.status, r.json);
}

export async function withdrawCrewPlan(sessionId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await call(planUrl(sessionId), { method: 'DELETE' });
  if (!r) return { ok: false, message: 'Could not reach Portava. Nothing was changed — try again.' };
  const j = r.json as { ok?: unknown; message?: unknown } | null;
  if (r.status >= 200 && r.status < 300 && j?.ok === true) return { ok: true };
  return { ok: false, message: typeof j?.message === 'string' ? j.message : 'The plan could not be withdrawn. Please try again.' };
}
