/**
 * Admin console (testing-mode WP-21) — the calls behind the admin screens that
 * make the in-app test loops closable without an API client:
 *
 *   hidden-gem review      /api/admin/hidden-gems/*            (PLAT-F39)
 *   local-guide approval   /api/admin/hidden-gems/guide-applications,
 *                          /api/admin/local-guides/:userId/status  (PLAT-F38)
 *   live-scope promotion   /api/admin/intel/live-scopes/*      (SEN-F06)
 *   user stamps            /api/admin/stamps/*                 (PASS-F23)
 *   airport profiles       /api/admin/airport/*                (LAY-F16)
 *
 * Every route here is admin-only on the SERVER (requireAdmin / isAdmin); the
 * screens' useRequireAdmin only keeps a non-admin from landing on them.
 *
 * Every call returns AdminApiResult: a failed read is `{ ok: false }` and the
 * screens show it as an error with a retry — never as an empty queue.
 */
import { adminGet, adminPost, type AdminApiResult } from './adminApi.ts';

export type { AdminApiResult };

// ── Hidden gems ───────────────────────────────────────────────────────────────

export interface PendingGem {
  id: string;
  name: string;
  category: string | null;
  city: string | null;
  country: string | null;
  sensitivity_level: string | null;
  submitted_by: string | null;
  created_at: string;
}

export interface ReportedGem {
  id: string;
  name: string;
  category: string | null;
  city: string | null;
  country: string | null;
  report_count: number;
  status: string;
  updated_at: string;
}

export type GemVerifyResult = 'approved' | 'rejected';

export async function listPendingGems(): Promise<AdminApiResult<PendingGem[]>> {
  const r = await adminGet<{ queue?: PendingGem[] }>('/api/admin/hidden-gems/pending');
  if (!r.ok) return r;
  if (!Array.isArray(r.data?.queue)) return { ok: false, error: 'The pending-gem queue came back in a shape this build does not understand.' };
  return { ok: true, data: r.data.queue };
}

export async function listReportedGems(): Promise<AdminApiResult<ReportedGem[]>> {
  const r = await adminGet<{ gems?: ReportedGem[] }>('/api/admin/hidden-gems/reported');
  if (!r.ok) return r;
  if (!Array.isArray(r.data?.gems)) return { ok: false, error: 'The reported-gem queue came back in a shape this build does not understand.' };
  return { ok: true, data: r.data.gems };
}

/** Approve (→ active) or reject (→ hidden) a pending gem. */
export function verifyGem(gemId: string, result: GemVerifyResult, notes?: string): Promise<AdminApiResult<{ ok: boolean }>> {
  const body: Record<string, unknown> = { result };
  if (notes && notes.trim()) body.notes = notes.trim().slice(0, 500);
  return adminPost(`/api/admin/hidden-gems/${encodeURIComponent(gemId)}/verify`, body);
}

/** Uphold (gem hidden, author charged) or dismiss (gem restored) the reports on a gem. */
export function resolveGemReports(gemId: string, outcome: 'upheld' | 'dismissed', note?: string): Promise<AdminApiResult<{ ok: boolean }>> {
  const body: Record<string, unknown> = { outcome };
  if (note && note.trim()) body.note = note.trim();
  return adminPost(`/api/admin/hidden-gems/${encodeURIComponent(gemId)}/resolve-report`, body);
}

// ── Local guides ──────────────────────────────────────────────────────────────

export interface GuideApplication {
  user_id: string;
  guide_level: number;
  city_expertise: string[] | null;
  contribution_count: number;
  status: string;
  created_at: string;
}

export type GuideStatus = 'active' | 'suspended' | 'demoted';

export async function listGuideApplications(): Promise<AdminApiResult<GuideApplication[]>> {
  const r = await adminGet<{ applications?: GuideApplication[] }>('/api/admin/hidden-gems/guide-applications');
  if (!r.ok) return r;
  if (!Array.isArray(r.data?.applications)) return { ok: false, error: 'The guide applications came back in a shape this build does not understand.' };
  return { ok: true, data: r.data.applications };
}

export function setGuideStatus(userId: string, status: GuideStatus): Promise<AdminApiResult<{ ok: boolean }>> {
  return adminPost(`/api/admin/local-guides/${encodeURIComponent(userId)}/status`, { status });
}

// ── Live scopes (SEN-F06) ─────────────────────────────────────────────────────

export interface LiveScope {
  scope_key: string;
  zone_id: string | null;
  claim_type: string;
  promoted_at: string;
  expires_at: string | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  note: string | null;
  state: string;
}

export async function listLiveScopes(includeInactive: boolean): Promise<AdminApiResult<LiveScope[]>> {
  const r = await adminGet<{ scopes?: LiveScope[] }>(`/api/admin/intel/live-scopes${includeInactive ? '?all=1' : ''}`);
  if (!r.ok) return r;
  if (!Array.isArray(r.data?.scopes)) return { ok: false, error: 'The live-scope list came back in a shape this build does not understand.' };
  return { ok: true, data: r.data.scopes };
}

export interface PromoteScopeInput {
  /** Empty string means the zone-less scope; the server needs it SAID as null. */
  zoneId: string;
  claimType: string;
  /** Review horizon in whole days from now. */
  horizonDays: number;
  reasoning: string;
  /** The density-gate assessment the promoter looked at, as JSON text. */
  assessmentJson: string;
  note?: string;
}

export type PromoteBody = {
  zoneId: string | null;
  claimType: string;
  expiresAt: string;
  evidence: { assessment: Record<string, unknown>; reasoning: string };
  note?: string;
};

/**
 * Build the promote body, or say what is wrong with the form. Pure, so the
 * rules the server enforces (a future horizon, provenance) are checked before
 * a request is made and are testable without a network.
 */
export function buildPromoteBody(input: PromoteScopeInput, now: Date = new Date()): { ok: true; body: PromoteBody } | { ok: false; error: string } {
  const claimType = input.claimType.trim();
  if (!claimType) return { ok: false, error: 'Claim type is required.' };
  const reasoning = input.reasoning.trim();
  if (!reasoning) return { ok: false, error: 'Say why you are promoting this scope.' };
  if (!Number.isFinite(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > 90) {
    return { ok: false, error: 'The review horizon must be 1 to 90 days.' };
  }
  let assessment: unknown;
  try { assessment = JSON.parse(input.assessmentJson.trim() || '{}'); } catch { return { ok: false, error: 'The assessment is not valid JSON.' }; }
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) {
    return { ok: false, error: 'The assessment must be a JSON object.' };
  }
  const zone = input.zoneId.trim();
  const body: PromoteBody = {
    zoneId: zone === '' ? null : zone,
    claimType,
    expiresAt: new Date(now.getTime() + Math.round(input.horizonDays) * 86_400_000).toISOString(),
    evidence: { assessment: assessment as Record<string, unknown>, reasoning },
  };
  if (input.note && input.note.trim()) body.note = input.note.trim();
  return { ok: true, body };
}

export function promoteLiveScope(body: PromoteBody): Promise<AdminApiResult<{ scopeKey: string; action: string; expiresAt: string }>> {
  return adminPost('/api/admin/intel/live-scopes/promote', body);
}

export function withdrawLiveScope(zoneId: string | null, claimType: string, reason: string): Promise<AdminApiResult<{ scopeKey: string; action: string }>> {
  return adminPost('/api/admin/intel/live-scopes/withdraw', { zoneId, claimType, reason });
}

// ── User stamps (PASS-F23) ────────────────────────────────────────────────────

export interface AdminUserStamp {
  id: string;
  user_id: string;
  stamp_definition_id: string;
  earned_at: string;
  city: string | null;
  country: string | null;
  source_type: string | null;
  is_revoked: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
  stamp_definitions: { slug: string; name: string; stamp_type: string } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean { return UUID_RE.test(s.trim()); }

export async function listUserStamps(userId: string): Promise<AdminApiResult<{ stamps: AdminUserStamp[]; total: number }>> {
  const r = await adminGet<{ stamps?: AdminUserStamp[]; total?: number }>(`/api/admin/stamps/users/${encodeURIComponent(userId)}/stamps`);
  if (!r.ok) return r;
  if (!Array.isArray(r.data?.stamps)) return { ok: false, error: 'The stamp list came back in a shape this build does not understand.' };
  return { ok: true, data: { stamps: r.data.stamps, total: typeof r.data.total === 'number' ? r.data.total : r.data.stamps.length } };
}

export interface AwardResult { awarded: boolean; reason: string; userStampId?: string }

export function awardStamp(userId: string, definitionSlug: string, reason: string): Promise<AdminApiResult<AwardResult>> {
  return adminPost('/api/admin/stamps/award', { userId, definitionSlug: definitionSlug.trim(), reason: reason.trim() });
}

export function revokeUserStamp(userStampId: string, reason: string): Promise<AdminApiResult<{ revoked: boolean; reason: string }>> {
  return adminPost(`/api/admin/stamps/${encodeURIComponent(userStampId)}/revoke`, { reason: reason.trim() });
}

export function restoreUserStamp(userStampId: string, reason: string): Promise<AdminApiResult<{ restored: boolean; reason: string }>> {
  return adminPost(`/api/admin/stamps/${encodeURIComponent(userStampId)}/restore`, { reason: reason.trim() });
}

// ── Airport profiles and caution zones (LAY-F16) ──────────────────────────────

export interface AirportProfile {
  id: string;
  iata_code: string;
  name: string;
  city: string | null;
  country: string | null;
  country_code: string | null;
  timezone: string | null;
  lat: number | null;
  lng: number | null;
  verified: boolean | null;
}

export interface CautionZone {
  id: string;
  name: string;
  zone_type: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  city: string | null;
  metadata: { iata_code?: string; note?: string | null } | null;
}

export async function listAirportProfiles(): Promise<AdminApiResult<AirportProfile[]>> {
  const r = await adminGet<{ profiles?: AirportProfile[] }>('/api/admin/airport/profiles');
  if (!r.ok) return r;
  if (!Array.isArray(r.data?.profiles)) return { ok: false, error: 'The airport list came back in a shape this build does not understand.' };
  return { ok: true, data: r.data.profiles };
}

export async function listCautionZones(iata: string): Promise<AdminApiResult<CautionZone[]>> {
  const r = await adminGet<{ zones?: CautionZone[] }>(`/api/admin/airport/caution-zones?iata=${encodeURIComponent(iata.trim().toUpperCase())}`);
  if (!r.ok) return r;
  if (!Array.isArray(r.data?.zones)) return { ok: false, error: 'The caution zones came back in a shape this build does not understand.' };
  return { ok: true, data: r.data.zones };
}

export interface AirportProfileForm {
  iataCode: string; name: string; city: string; country: string; countryCode: string;
  timezone: string; lat: string; lng: string; verified: boolean;
}

export type AirportProfileBody = {
  iataCode: string; name: string; city: string; country: string; countryCode: string;
  timezone?: string; lat: number; lng: number; verified: boolean;
};

function num(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Validate the airport form against the server's schema (routes/airport.ts adminProfileSchema). Pure. */
export function buildAirportProfileBody(f: AirportProfileForm): { ok: true; body: AirportProfileBody } | { ok: false; error: string } {
  const iata = f.iataCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(iata)) return { ok: false, error: 'IATA code must be 2 to 4 letters or digits.' };
  if (!f.name.trim() || !f.city.trim() || !f.country.trim()) return { ok: false, error: 'Name, city and country are required.' };
  const cc = f.countryCode.trim().toUpperCase();
  if (!cc || cc.length > 3) return { ok: false, error: 'Country code is required (2–3 letters).' };
  const lat = num(f.lat); const lng = num(f.lng);
  if (lat === null || lat < -90 || lat > 90) return { ok: false, error: 'Latitude must be a number from -90 to 90.' };
  if (lng === null || lng < -180 || lng > 180) return { ok: false, error: 'Longitude must be a number from -180 to 180.' };
  const body: AirportProfileBody = { iataCode: iata, name: f.name.trim(), city: f.city.trim(), country: f.country.trim(), countryCode: cc, lat, lng, verified: f.verified };
  if (f.timezone.trim()) body.timezone = f.timezone.trim();
  return { ok: true, body };
}

export function upsertAirportProfile(body: AirportProfileBody): Promise<AdminApiResult<{ ok: boolean; id: string }>> {
  return adminPost('/api/admin/airport/profiles', body);
}

export interface CautionZoneForm {
  iataCode: string; name: string; zoneType: 'safety_zone' | 'no_go_zone' | 'caution_zone';
  centerLat: string; centerLng: string; radiusMeters: string; note: string;
}

export type CautionZoneBody = {
  iataCode: string; name: string; zoneType: CautionZoneForm['zoneType'];
  centerLat: number; centerLng: number; radiusMeters: number; note?: string;
};

/** Validate the caution-zone form against routes/airport.ts cautionZoneSchema. Pure. */
export function buildCautionZoneBody(f: CautionZoneForm): { ok: true; body: CautionZoneBody } | { ok: false; error: string } {
  const iata = f.iataCode.trim().toUpperCase();
  if (iata.length < 3 || iata.length > 4) return { ok: false, error: 'Pick an airport first.' };
  if (!f.name.trim()) return { ok: false, error: 'Zone name is required.' };
  const lat = num(f.centerLat); const lng = num(f.centerLng);
  if (lat === null || lat < -90 || lat > 90) return { ok: false, error: 'Latitude must be a number from -90 to 90.' };
  if (lng === null || lng < -180 || lng > 180) return { ok: false, error: 'Longitude must be a number from -180 to 180.' };
  const radius = f.radiusMeters.trim() === '' ? 1000 : num(f.radiusMeters);
  if (radius === null || !Number.isInteger(radius) || radius < 50 || radius > 50000) return { ok: false, error: 'Radius must be a whole number of metres from 50 to 50000.' };
  const body: CautionZoneBody = { iataCode: iata, name: f.name.trim(), zoneType: f.zoneType, centerLat: lat, centerLng: lng, radiusMeters: radius };
  if (f.note.trim()) body.note = f.note.trim();
  return { ok: true, body };
}

export function createCautionZone(body: CautionZoneBody): Promise<AdminApiResult<{ ok: boolean; id: string }>> {
  return adminPost('/api/admin/airport/caution-zones', body);
}
