/**
 * §17.3 rescue — the client for POST /trips/:tripId/rescue. census-trips
 * TR318 (the SAFETY_EVENT priority applied by a surface), TR320–TR328's
 * screen half.
 *
 * The problem vocabulary and the plan are the server's. The plan names the
 * steps, who does each (the traveller, Compass, the crew), where to escalate
 * and when, and what Compass may and must not do; the client renders it and
 * adds nothing. Whether a disruption was DECLARED is the server's word too
 * (`declared.ok`) — with the kernel off it says so, and the card says so.
 */
import { isConfigured, apiBase, bearerToken } from '../shared/auth.ts';

export const RESCUE_PROBLEMS = ['missed_transport', 'hotel_issue', 'lost_crew', 'no_ride', 'travel_document', 'stranded', 'emergency'] as const;
export type RescueProblem = (typeof RESCUE_PROBLEMS)[number];

export const PROBLEM_LABEL: Record<RescueProblem, string> = {
  missed_transport: 'Missed my transport', hotel_issue: 'Problem with where I am staying', lost_crew: 'Lost the crew',
  no_ride: 'No way to get there', travel_document: 'Travel document problem', stranded: 'Stranded', emergency: 'Emergency',
};

export interface RescueStep { order: number; action: string; who: 'traveller' | 'compass' | 'crew'; detail: string }
export interface RescueEscalation { to: string; why: string; when: 'now' | 'if_unresolved' | 'if_unsafe' }
export interface RescuePlan {
  problem: RescueProblem | string;
  severity: 'minor' | 'major' | 'critical' | string;
  declare: { kind: string; severity: string; note: string };
  steps: RescueStep[];
  escalation: RescueEscalation[];
  compass: { may: string[]; mustNot: string[] };
  safeReturn: 'attach' | 'offer' | 'not_applicable' | string;
  explanation: string[];
}
export interface RescueResponse {
  tripId: string;
  plan: RescuePlan;
  declared: { ok: boolean; disruptionId: string | null; duplicate: boolean; reason: string | null; skipped: string | null };
}

export type RescueResult =
  | { state: 'ok'; response: RescueResponse }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string; reason?: string };

function looksLikeRescue(b: unknown): b is RescueResponse {
  const r = b as Partial<RescueResponse> | null;
  return !!r && typeof r === 'object' && typeof r.tripId === 'string' && !!r.plan && Array.isArray(r.plan.steps) && Array.isArray(r.plan.escalation)
    && !!r.declared && typeof r.declared.ok === 'boolean';
}

export async function requestRescue(tripId: string, problem: RescueProblem): Promise<RescueResult> {
  if (!isConfigured() || !apiBase()) return { state: 'off' };
  const token = await bearerToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/rescue`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ problem }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; reason?: string; message?: string } | null;
      if (res.status === 404 && (body?.error === 'feature_disabled' || body?.reason === 'FEATURE_DISABLED')) return { state: 'off' };
      return { state: 'unavailable', detail: body?.message ?? `HTTP ${res.status}`, reason: body?.reason };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!looksLikeRescue(body)) return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', response: body };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/** One line on whether the disruption was declared, in the server's words — never "declared" on the client's own authority. */
export function declaredLine(r: RescueResponse): string {
  if (r.declared.ok) return r.declared.duplicate ? 'Disruption already declared — the crew is on the same page' : 'Disruption declared — the trip is now under attention';
  if (r.declared.skipped) return `Disruption not declared: ${r.declared.skipped}`;
  return `Disruption not declared: ${r.declared.reason ?? 'refused'}`;
}
