/**
 * Discovery Trails on the client (`docs/specs/discovery-v1/02_Trails.md`;
 * routes/trails.ts under /v1/discovery/trails).
 *
 * The owner's decision of 2026-10-04: "Trails and Trending: Yes, they're in
 * scope as user-facing features as well as APIs. Build the screens and flows;
 * keep any feature that depends on unresolved decisions or migrations gated."
 * Until this file there was no client of these routes at all.
 *
 * Every read is three-valued — ok, off (the deployment answers
 * feature_disabled), or unavailable with the server's words — and a Trail list
 * that could not be read is never shown as "no Trails". Every write reports what
 * the SERVER said, never what was asked.
 */
import { readDiscoveryJson, sendDiscoveryWrite, type ApiRead, type ApiWrite } from '../shared/discoveryApi.ts';
import { isConfigured, apiBase, bearerToken } from '../../trips/shared/auth.ts';

export interface Trail {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  destination: string | null;
  parentTrailId: string | null;
  lifecycle: string;
  createdAt: string;
  /**
   * Lead ruling D-66: a new Trail is reviewed before anyone else can see it.
   * The server sends "pending" or "rejected" only to the Trail's creator; a
   * rejection carries its reason. Absent on an older server.
   */
  review?: TrailReview;
}

export interface TrailReview { state: 'pending' | 'approved' | 'rejected' | string; reason: string | null }

export interface TrailDetail {
  trail: Trail;
  /** §12's word for the Trail, over what THIS viewer may be served. Never a number. */
  status: string | null;
  memberCount: number;
}

export const TRAIL_SOURCE_TYPES = ['post', 'place', 'event', 'itinerary', 'route'] as const;
export type TrailSourceType = (typeof TRAIL_SOURCE_TYPES)[number];

export interface TrailModuleItem { id: string; sourceType: string; sourceId: string; contentState?: string }
export interface TrailModule {
  key: string;
  objective: string;
  horizonMs: number | null;
  items: TrailModuleItem[];
  moreFromThisPlace: Record<string, number>;
  /** null = the exposure denominators could not be read; [] = evaluated, none qualified. */
  explorationSlots: string[] | null;
}

export interface RelatedTrail { trail: Trail; edgeType: string; direction: string }

export const TRAIL_REPORT_REASONS = ['unrelated_content', 'duplicate_trail', 'wrong_place_link', 'stale', 'abuse'] as const;
export type TrailReportReason = (typeof TRAIL_REPORT_REASONS)[number];

const isStr = (v: unknown): v is string => typeof v === 'string';
/** A JSON object's fields, or an empty record — never `any`. */
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const isTrail = (v: unknown): v is Trail => {
  const t = rec(v);
  return isStr(t.id) && isStr(t.title) && isStr(t.lifecycle) && isStr(t.createdAt);
};
const enc = encodeURIComponent;

export async function listTrails(opts: { q?: string | null; destination?: string | null; limit?: number } = {}): Promise<ApiRead<Trail[]>> {
  const p = new URLSearchParams();
  if (opts.q?.trim()) p.set('q', opts.q.trim());
  if (opts.destination?.trim()) p.set('destination', opts.destination.trim());
  if (opts.limit) p.set('limit', String(opts.limit));
  const qs = p.toString();
  const r = await readDiscoveryJson<{ trails: Trail[] }>(
    `/api/v1/discovery/trails${qs ? `?${qs}` : ''}`,
    (b) => Array.isArray(b?.trails) && b.trails.every(isTrail),
  );
  return r.state === 'ok' ? { state: 'ok', data: r.data.trails } : r;
}

/** The signed-in person's own Trails, each with its review state (D-66). The only list a Trail under review is in. */
export async function listMyTrails(): Promise<ApiRead<Trail[]>> {
  const r = await readDiscoveryJson<{ trails: Trail[] }>(
    '/api/v1/discovery/me/trails',
    (b) => Array.isArray(b?.trails) && b.trails.every(isTrail),
  );
  return r.state === 'ok' ? { state: 'ok', data: r.data.trails } : r;
}

export function getTrail(id: string): Promise<ApiRead<TrailDetail>> {
  return readDiscoveryJson<TrailDetail>(
    `/api/v1/discovery/trails/${enc(id)}`,
    (b) => isTrail(b?.trail) && typeof b?.memberCount === 'number' && (b.status === null || isStr(b.status)),
  );
}

export async function getTrailModules(id: string): Promise<ApiRead<TrailModule[]>> {
  const r = await readDiscoveryJson<{ modules: TrailModule[] }>(
    `/api/v1/discovery/trails/${enc(id)}/modules`,
    (b) => Array.isArray(b?.modules) && (b.modules as unknown[]).every((m) => isStr(rec(m).key) && Array.isArray(rec(m).items)),
  );
  return r.state === 'ok' ? { state: 'ok', data: r.data.modules } : r;
}

export async function getRelatedTrails(id: string): Promise<ApiRead<RelatedTrail[]>> {
  const r = await readDiscoveryJson<{ related: RelatedTrail[] }>(
    `/api/v1/discovery/trails/${enc(id)}/related`,
    (b) => Array.isArray(b?.related) && (b.related as unknown[]).every((x) => isTrail(rec(x).trail) && isStr(rec(x).edgeType)),
  );
  return r.state === 'ok' ? { state: 'ok', data: r.data.related } : r;
}

export async function getTrailFollow(id: string): Promise<ApiRead<boolean>> {
  const r = await readDiscoveryJson<{ following: boolean }>(
    `/api/v1/discovery/trails/${enc(id)}/follow`,
    (b) => typeof b?.following === 'boolean',
  );
  return r.state === 'ok' ? { state: 'ok', data: r.data.following } : r;
}

/** The follow state AFTER the write, as the server answered — null when it did not say. */
export function followAfter(w: ApiWrite<unknown>): boolean | null {
  const d = w.state === 'done' ? (w.data as { following?: unknown } | null) : null;
  return d && typeof d.following === 'boolean' ? d.following : null;
}

export function setTrailFollow(id: string, following: boolean): Promise<ApiWrite<unknown>> {
  return sendDiscoveryWrite(following ? 'PUT' : 'DELETE', `/api/v1/discovery/trails/${enc(id)}/follow`);
}

export function reportTrail(id: string, reason: TrailReportReason): Promise<ApiWrite<unknown>> {
  return sendDiscoveryWrite('POST', `/api/v1/discovery/trails/${enc(id)}/reports`, { reason });
}

export type ProposeResult =
  | { state: 'created'; trail: Trail }
  | { state: 'canonicalization_refused'; checks: Array<{ check: string; conflictsWith: string | null }>; suggestedParentTrailId: string | null }
  | { state: 'refused'; detail: string }
  | { state: 'unavailable'; detail: string };

export async function proposeTrail(input: {
  title: string; destination?: string | null; description?: string | null; parentTrailId?: string | null;
}): Promise<ProposeResult> {
  if (!isConfigured() || !apiBase()) return { state: 'unavailable', detail: 'not configured' };
  const token = await bearerToken();
  if (!token) return { state: 'unavailable', detail: 'not signed in' };
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/v1/discovery/trails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title.trim(),
        destination: input.destination?.trim() || null,
        description: input.description?.trim() || null,
        parentTrailId: input.parentTrailId ?? null,
      }),
    });
  } catch (e: unknown) {
    return { state: 'unavailable', detail: e instanceof Error ? e.message : 'network error' };
  }
  const parsed: unknown = await res.json().catch(() => null);
  const body = parsed === null ? null : rec(parsed);
  if (res.status === 201) {
    return isTrail(body?.trail) ? { state: 'created', trail: body.trail } : { state: 'unavailable', detail: 'unreadable response' };
  }
  if (res.status === 409 && body?.error === 'canonicalization_refused') {
    // §5's four checks refused a well-formed proposal; §6 makes the suggested
    // parent an instruction the person can act on, so it is carried through.
    const checks = Array.isArray(body.refusals)
      ? (body.refusals as unknown[]).map(rec).filter((x) => isStr(x.check)).map((x) => ({ check: String(x.check), conflictsWith: isStr(x.conflictsWith) ? x.conflictsWith : null }))
      : [];
    return { state: 'canonicalization_refused', checks, suggestedParentTrailId: isStr(body.suggestedParentTrailId) ? body.suggestedParentTrailId : null };
  }
  if (res.status >= 500 || !body) return { state: 'unavailable', detail: isStr(body?.message) ? body.message : `HTTP ${res.status}` };
  return { state: 'refused', detail: String(body.message ?? body.error ?? `HTTP ${res.status}`) };
}
