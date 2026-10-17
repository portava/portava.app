/**
 * The crew-location wire contract — types and the fail-closed parse of
 * `GET /api/airport/sessions/:id/crew/location` (census-layover L132/L124/
 * L166/L277). Pure: no fetch, no React Native, so node:test can run it.
 * `services/layoverCrewLocation.ts` does the I/O and re-exports this.
 */
export type CrewSharePrecision = 'area' | 'venue' | 'exact';
export type CrewProximity = 'together' | 'close' | 'same_area' | 'far';

export interface GeoPoint { lat: number; lng: number }
export interface CrewShareRing { center: GeoPoint; radiusMeters: number }

export interface CrewShareView {
  userId: string;
  label: string;
  precision: CrewSharePrecision;
  sharedAt: string;
  endsAt: string;
  /** Only for an exact share. */
  position: GeoPoint | null;
  /** Only for a venue share: a cell centre and its radius, never the point sent. */
  ring: CrewShareRing | null;
  /** L277: a bucket, only when the viewer shares a point too. */
  proximity: CrewProximity | null;
}

export interface CrewmateShare extends CrewShareView {
  handle: string | null;
  name: string | null;
}

export type CrewLocationRead =
  | { ok: true; available: false }
  | { ok: true; available: true; inCrew: false }
  | {
      ok: true; available: true; inCrew: true;
      crewId: string;
      maxShareMinutes: number;
      shareEndsBy: string | null;
      /** L166: null when the server could not read it — exact is then not offered. */
      preciseControl: { enabled: boolean } | null;
      mine: CrewShareView | null;
      crewmates: CrewmateShare[];
      crewmatesWithheld: string | null;
    }
  | { ok: false; reason: 'unavailable' | 'unreachable' | 'refused'; message: string };

/** How each proximity bucket reads. Never a number of metres. */
export const PROXIMITY_TEXT: Record<CrewProximity, string> = {
  together: 'right by you',
  close: 'close by (under 1.5 km)',
  same_area: 'in the same part of town (under 5 km)',
  far: 'further away',
};

export const PRECISION_TEXT: Record<CrewSharePrecision, string> = {
  area: 'Approximate area',
  venue: 'Venue',
  exact: 'Exact',
};

const PRECISIONS: readonly CrewSharePrecision[] = ['area', 'venue', 'exact'];
const PROXIMITIES: readonly CrewProximity[] = ['together', 'close', 'same_area', 'far'];

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
export function str(r: Record<string, unknown>, k: string): string | null {
  const v = r[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function pointOf(v: unknown): GeoPoint | null {
  if (!isRecord(v)) return null;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
function ringOf(v: unknown): CrewShareRing | null {
  if (!isRecord(v)) return null;
  const center = pointOf(v.center);
  const r = v.radiusMeters;
  if (!center || typeof r !== 'number' || !Number.isFinite(r) || r <= 0) return null;
  return { center, radiusMeters: r };
}

/** One share, or null when it cannot be read. Geometry is held to its rung. */
function shareOf(v: unknown): CrewShareView | null {
  if (!isRecord(v)) return null;
  const userId = str(v, 'userId');
  const label = str(v, 'label');
  const endsAt = str(v, 'endsAt');
  const precision = v.precision as CrewSharePrecision;
  if (!userId || !label || !endsAt || !PRECISIONS.includes(precision)) return null;
  const proximity = PROXIMITIES.includes(v.proximity as CrewProximity) ? (v.proximity as CrewProximity) : null;
  return {
    userId, label, precision, endsAt,
    sharedAt: str(v, 'sharedAt') ?? endsAt,
    // A point is drawn only for an exact share and a ring only for a venue
    // share. An area share never puts anything on a map, whatever arrived.
    position: precision === 'exact' ? pointOf(v.position) : null,
    ring: precision === 'venue' ? ringOf(v.ring) : null,
    proximity,
  };
}

/** Exported for tests: the whole read, fail-closed. */
export function parseCrewLocation(status: number, json: unknown): CrewLocationRead {
  const r = isRecord(json) ? json : null;
  if (status === 404 && (!r || r.available === undefined)) return { ok: true, available: false };
  const message = (r && str(r, 'message')) ?? 'Crew locations could not be loaded.';
  if (status === 503) return { ok: false, reason: 'unavailable', message };
  if (status < 200 || status >= 300 || !r) return { ok: false, reason: 'refused', message };
  if (r.available === false) return { ok: true, available: false };
  if (r.available !== true) return { ok: false, reason: 'refused', message: 'Crew locations could not be read.' };
  if (r.inCrew === false) return { ok: true, available: true, inCrew: false };
  if (r.inCrew !== true || !Array.isArray(r.crewmates) || typeof r.crewId !== 'string') {
    return { ok: false, reason: 'refused', message: 'Crew locations could not be read.' };
  }
  const crewmates: CrewmateShare[] = [];
  for (const c of r.crewmates as unknown[]) {
    const s = shareOf(c);
    if (!s || !isRecord(c)) continue;
    crewmates.push({ ...s, handle: str(c, 'handle'), name: str(c, 'name') });
  }
  const pc = isRecord(r.preciseControl) && typeof r.preciseControl.enabled === 'boolean' ? { enabled: r.preciseControl.enabled } : null;
  return {
    ok: true, available: true, inCrew: true,
    crewId: r.crewId,
    maxShareMinutes: typeof r.maxShareMinutes === 'number' && r.maxShareMinutes > 0 ? r.maxShareMinutes : 240,
    shareEndsBy: str(r, 'shareEndsBy'),
    preciseControl: pc,
    mine: r.mine === null || r.mine === undefined ? null : shareOf(r.mine),
    crewmates,
    crewmatesWithheld: str(r, 'crewmatesWithheld'),
  };
}

/** The window a sheet choice asks for, never past the server's ceiling. */
export function shareExpiryFor(minutes: number, nowMs: number, maxShareMinutes: number): string {
  return new Date(nowMs + Math.min(minutes, maxShareMinutes) * 60_000).toISOString();
}

