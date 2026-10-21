import AsyncStorage from '@react-native-async-storage/async-storage';

export interface OfflineExperiencePlan {
  id: string; version: number; phase: 'selected' | 'executing'; stopIds: string[]; createdAt: string;
  contract: {
    state: 'READY'; snapshotId: string; candidateIds: string[]; insideAirport: boolean;
    departBy: string; leaveActivityBy: string; expectedAirportReturn: string; hardReturnBy: string; expiresAt: string;
    fallbackPlan: { duringExperience: 'remain_airside' | 'return_to_airport'; returnBy: string;
      returnRoute: { mode: string; departAt: string; minutes: number; conservativeMinutes: number; forecast: boolean; transferCount: number } | null };
    abortThreshold: { leaveBy: string; returnDeadline: string; conditions: string[] };
    itinerary: Array<{ kind: 'outbound' | 'experience' | 'return'; startsAt: string; endsAt: string; mode: string | null; candidateId?: string }>;
  };
}
export const experienceCacheKey = (sessionId: string) => `layover.experience.v1:${sessionId}`;
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 500;
const instant = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));
const minutes = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 30 && v.every(text);

/** Store only the public execution terms. Coordinates and unrelated extensions never enter this cache. */
export function parseOfflineExperience(value: unknown): OfflineExperiencePlan | null {
  const p = object(value), c = object(p?.contract), f = object(c?.fallbackPlan), a = object(c?.abortThreshold);
  if (!p || !c || !f || !a || !text(p.id) || !Number.isInteger(p.version) || Number(p.version) < 1 ||
    !['selected', 'executing'].includes(String(p.phase)) || !strings(p.stopIds) || p.stopIds.length === 0 || !instant(p.createdAt) ||
    c.state !== 'READY' || c.riskBand === 'UNSAFE' || !text(c.snapshotId) || !strings(c.candidateIds) || c.candidateIds.length !== p.stopIds.length ||
    typeof c.insideAirport !== 'boolean' || !instant(c.departBy) || !instant(c.leaveActivityBy) || !instant(c.expectedAirportReturn) ||
    !instant(c.hardReturnBy) || !instant(c.expiresAt) || !instant(f.returnBy) || f.returnBy !== c.hardReturnBy ||
    !instant(a.leaveBy) || !instant(a.returnDeadline) || a.returnDeadline !== c.hardReturnBy || !strings(a.conditions) ||
    !Array.isArray(c.itinerary) || c.itinerary.length === 0 || c.itinerary.length > 90) return null;
  let returnRoute: OfflineExperiencePlan['contract']['fallbackPlan']['returnRoute'] = null;
  if (!c.insideAirport) {
    const r = object(f.returnRoute);
    if (f.duringExperience !== 'return_to_airport' || !r || !text(r.mode) || !instant(r.departAt) ||
      !minutes(r.minutes) || !minutes(r.conservativeMinutes) || r.conservativeMinutes < r.minutes || r.forecast !== true ||
      !Number.isInteger(r.transferCount) || Number(r.transferCount) < 0) return null;
    returnRoute = { mode: r.mode, departAt: r.departAt, minutes: r.minutes, conservativeMinutes: r.conservativeMinutes, forecast: true, transferCount: Number(r.transferCount) };
  } else if (f.duringExperience !== 'remain_airside') return null;
  const itinerary: OfflineExperiencePlan['contract']['itinerary'] = [];
  let priorEnd = -Infinity;
  for (const raw of c.itinerary) {
    const h = object(raw);
    if (!h || !['outbound', 'experience', 'return'].includes(String(h.kind)) || !instant(h.startsAt) || !instant(h.endsAt) ||
      Date.parse(h.startsAt) < priorEnd || Date.parse(h.endsAt) < Date.parse(h.startsAt) || !(h.mode === null || text(h.mode))) return null;
    priorEnd = Date.parse(h.endsAt);
    itinerary.push({ kind: h.kind as 'outbound' | 'experience' | 'return', startsAt: h.startsAt, endsAt: h.endsAt, mode: h.mode,
      ...(text(h.candidateId) ? { candidateId: h.candidateId } : {}) });
  }
  if (itinerary.filter(h => h.kind === 'experience').length !== p.stopIds.length ||
    Date.parse(c.expectedAirportReturn) > Date.parse(c.hardReturnBy) || Date.parse(c.leaveActivityBy) > Date.parse(c.hardReturnBy)) return null;
  if (returnRoute && !itinerary.some(h => h.kind === 'return' && h.startsAt === returnRoute!.departAt && h.endsAt === c.expectedAirportReturn)) return null;
  return { id: p.id, version: Number(p.version), phase: p.phase as OfflineExperiencePlan['phase'], stopIds: [...p.stopIds], createdAt: p.createdAt,
    contract: { state: 'READY', snapshotId: c.snapshotId, candidateIds: [...c.candidateIds], insideAirport: c.insideAirport,
      departBy: c.departBy, leaveActivityBy: c.leaveActivityBy, expectedAirportReturn: c.expectedAirportReturn, hardReturnBy: c.hardReturnBy, expiresAt: c.expiresAt,
      fallbackPlan: { duringExperience: c.insideAirport ? 'remain_airside' : 'return_to_airport', returnBy: f.returnBy, returnRoute },
      abortThreshold: { leaveBy: a.leaveBy, returnDeadline: a.returnDeadline, conditions: [...a.conditions] }, itinerary } };
}
export async function readCachedExperience(sessionId: string): Promise<OfflineExperiencePlan | null> {
  try { const raw = await AsyncStorage.getItem(experienceCacheKey(sessionId)); return raw ? parseOfflineExperience(JSON.parse(raw)) : null; }
  catch { return null; }
}
/** Before starting: prove the exact reviewed contract survives a storage round trip. Never extend server expiry. */
export async function prepareExperienceOffline(sessionId: string, value: unknown, nowMs = Date.now()): Promise<{ ok: boolean; reason?: string; navigation: 'not_saved' }> {
  const plan = parseOfflineExperience(value);
  if (!sessionId || !plan) return { ok: false, reason: 'Return details are incomplete. Refresh this plan before starting.', navigation: 'not_saved' };
  if (!Number.isFinite(nowMs) || Math.min(Date.parse(plan.contract.expiresAt), Date.parse(plan.contract.departBy), Date.parse(plan.contract.hardReturnBy)) <= nowMs)
    return { ok: false, reason: 'This plan needs a fresh timing check before you start.', navigation: 'not_saved' };
  try {
    const encoded = JSON.stringify(plan);
    await AsyncStorage.setItem(experienceCacheKey(sessionId), encoded);
    const saved = await readCachedExperience(sessionId);
    if (!saved || JSON.stringify(saved) !== encoded) return { ok: false, reason: 'Return details could not be saved on this device. Try again before starting.', navigation: 'not_saved' };
    return { ok: true, reason: 'Timetable and return deadline saved. Street navigation is not saved.', navigation: 'not_saved' };
  } catch { return { ok: false, reason: 'Return details could not be saved on this device. Try again before starting.', navigation: 'not_saved' }; }
}
