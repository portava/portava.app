import { z } from 'zod';
import { freshToken } from './apiToken.ts';

const instant = z.string().refine(v => Number.isFinite(Date.parse(v)));
export const experiencePlanSchema = z.object({
  id: z.string().uuid(), version: z.number().int().positive(), phase: z.enum(['selected', 'executing']),
  stopIds: z.array(z.string().uuid()).min(1).max(6), createdAt: instant,
  contract: z.object({
    state: z.literal('READY'), snapshotId: z.string().min(1), candidateIds: z.array(z.string()).min(1), insideAirport: z.boolean(),
    expiresAt: instant, departBy: instant, estimatedArrival: instant, leaveActivityBy: instant,
    expectedAirportReturn: instant, hardReturnBy: instant, riskBand: z.enum(['LOW', 'MODERATE', 'HIGH']), confidence: z.string(),
    minExperienceMinutes: z.number().positive(), idealExperienceMinutes: z.number().positive(), returnBufferMinutes: z.number().nonnegative(),
    fallbackPlan: z.object({ beforeDeparture: z.string(), duringExperience: z.string(), returnBy: instant, returnRoute: z.unknown() }).passthrough(),
    abortThreshold: z.object({ leaveBy: instant, returnDeadline: instant, conditions: z.array(z.string()) }),
    failureModes: z.array(z.string()).length(0), reasonCodes: z.array(z.string()),
    itinerary: z.array(z.object({ kind: z.enum(['outbound', 'experience', 'return']), startsAt: instant, endsAt: instant, mode: z.string().nullable(), candidateId: z.string().optional() })).min(1),
  }).passthrough(),
});
export type ExperiencePlan = z.infer<typeof experiencePlanSchema>;
export type ExperiencePlanRead = { ok: true; plan: ExperiencePlan | null; usable: boolean; reason: string | null } | { ok: false; reason: string };
export type ExperiencePlanMutation = { ok: true; plan: ExperiencePlan } | { ok: false; reason: string; uncertain: boolean };
const base = (sessionId: string) => `${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api/airport/sessions/${encodeURIComponent(sessionId)}/experiences/plan`;
async function headers() { const token = await freshToken(); return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }
export async function getExperiencePlan(sessionId: string): Promise<ExperiencePlanRead> {
  try {
    const res = await fetch(base(sessionId), { headers: await headers() }), body = await res.json();
    if (!res.ok || body?.ok !== true) return { ok: false, reason: body?.reason ?? body?.error ?? 'plan_unreadable' };
    if (body.plan === null) return { ok: true, plan: null, usable: false, reason: null };
    const parsed = experiencePlanSchema.safeParse(body.plan);
    return parsed.success && typeof body.usable === 'boolean' ? { ok: true, plan: parsed.data, usable: body.usable, reason: typeof body.reason === 'string' ? body.reason : null } : { ok: false, reason: 'plan_unreadable' };
  } catch { return { ok: false, reason: 'plan_unreadable' }; }
}
export async function changeExperiencePlan(sessionId: string, operation: 'select' | 'start', input: { requestId: string; expectedStopIds: string[]; selectedPlanId?: string }): Promise<ExperiencePlanMutation> {
  try {
    const res = await fetch(`${base(sessionId)}/${operation}`, { method: 'POST', headers: await headers(), body: JSON.stringify({ ...input, ...(operation === 'start' ? { confirmed: true } : {}) }) });
    const body = await res.json();
    const parsed = experiencePlanSchema.safeParse(body?.plan);
    if (res.ok && body?.ok === true && parsed.success) return { ok: true, plan: parsed.data };
    return { ok: false, reason: body?.reason ?? body?.error ?? 'plan_result_unknown', uncertain: res.status >= 500 && !body?.actionId };
  } catch { return { ok: false, reason: 'plan_result_unknown', uncertain: true }; }
}
/** Deduplication token only; authorization always comes from the signed-in owner. */
export function experienceRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}
export function experienceRefusalMessage(reason: string): string {
  const messages: Record<string, string> = {
    recommendation_choices_required: 'Use recommendation cards for every stop before creating a timed experience.',
    saved_plan_terms_changed: 'A saved stop differs from its checked recommendation. Add the current recommendation again.',
    plan_stops_changed: 'Your stops changed. Review a new timed experience before starting.',
    snapshot_changed: 'Your layover conditions changed. Check your recommendations and review a new experience.',
    plan_terms_changed: 'The travel or return terms changed. Review a new experience before starting.',
    candidate_unavailable: 'A selected recommendation is unavailable. Review your current recommendations.',
    plan_expired: 'This plan check expired. Review a new timed experience.',
    feature_disabled: 'Timed experiences are unavailable right now.',
    session_not_active: 'This layover is no longer available for starting an experience.',
    already_executing: 'An experience is already in progress. Keep your return deadline in view.',
    plan_result_unknown: 'Could not confirm the result. Retry the same action to check it safely.',
  };
  return messages[reason] ?? 'This experience could not be checked. Review your current recommendations and try again.';
}
