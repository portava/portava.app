import { fetchOwnedApi, type OwnedApiContext } from '../../../services/ownedApiRequest.ts';

export type Audience = 'crew_only' | 'mutual_follow_and_crew' | 'public';
export type Proximity = 'HIDDEN' | 'NEARBY' | 'DISTANCE_BUCKET' | 'ETA_IF_MUTUAL';
export type Geography = 'neighborhood' | 'city' | 'region' | null;
export interface WindowSignal { id: string; audiencePolicyId: string | null; proximityVisibility: Proximity; geographyScope: Geography }
export interface AudiencePolicy { id: string; audience: Audience }
export interface SharingWindow { id: string; startAt: string; endAt: string; intents: string[] }
export interface EtaGrant { userId: string; expiresAt: string; mutual: boolean }
export interface NearbyPerson {
  personId: string;
  availability: { state: string; intents: string[]; publishedUntil: string | null };
  proximity: { bucket: string; freshness: string };
  privacy: { availabilityPublished: boolean; proximityPublished: boolean };
}
export interface ReachablePeople { enabled: boolean; people: NearbyPerson[]; generatedAt: string | null }
export class NearbyUnavailable extends Error { constructor() { super('Nearby sharing is not available yet.'); } }

function validRead(path: string, data: any): boolean {
  const id = (value: unknown) => typeof value === 'string' && value.length > 0;
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (path === '/me/nearby-consent') return typeof data?.optedIn === 'boolean';
  if (path === '/me/availability-windows') return typeof data?.enabled === 'boolean' && Array.isArray(data.windows) && data.windows.every((w: any) => id(w?.id) && date(w.startAt) && date(w.endAt) && Array.isArray(w.intents) && w.intents.every((i: unknown) => typeof i === 'string'));
  if (path === '/me/eta-grants') return Array.isArray(data?.grants) && data.grants.every((g: any) => id(g?.userId) && date(g.expiresAt) && typeof g.mutual === 'boolean');
  if (path === '/me/availability-audience-policies') return Array.isArray(data?.policies) && data.policies.every((p: any) => id(p?.id) && ['crew_only', 'mutual_follow_and_crew', 'public'].includes(p.audience));
  if (path === '/nearby/reachable') return typeof data?.enabled === 'boolean' && Array.isArray(data.people) && (!data.enabled || date(data.generatedAt)) && data.people.every((p: any) => id(p?.personId) && typeof p.availability?.state === 'string' && (p.availability.publishedUntil === null || date(p.availability.publishedUntil)) && typeof p.proximity?.bucket === 'string' && typeof p.proximity.freshness === 'string' && typeof p.privacy?.availabilityPublished === 'boolean' && typeof p.privacy.proximityPublished === 'boolean');
  if (/^\/me\/availability-windows\/[^/]+\/signal$/.test(path)) return id(data?.id) && (data.audiencePolicyId === null || id(data.audiencePolicyId)) && ['HIDDEN', 'NEARBY', 'DISTANCE_BUCKET', 'ETA_IF_MUTUAL'].includes(data.proximityVisibility) && [null, 'neighborhood', 'city', 'region'].includes(data.geographyScope);
  return true;
}

export async function nearbyRequest<T>(path: string, context: OwnedApiContext, method = 'GET', body?: object): Promise<T> {
  const response = await fetchOwnedApi(`/api${path}`, { ...context, method, body });
  const data = await response.json();
  if (!response.ok) {
    if (data?.error === 'feature_disabled') throw new NearbyUnavailable();
    throw new Error(typeof data?.message === 'string' ? data.message : 'Could not load or save Nearby. Try again.');
  }
  if (method === 'GET' && !validRead(path, data)) throw new Error('Nearby returned incomplete information. Try again.');
  return data as T;
}

/** Read both before exposing choices; an unreadable policy never becomes the default. */
export async function loadWindowSignal(windowId: string, context: OwnedApiContext) {
  const [signal, policies] = await Promise.all([
    nearbyRequest<WindowSignal>(`/me/availability-windows/${encodeURIComponent(windowId)}/signal`, context),
    nearbyRequest<{ policies: AudiencePolicy[] }>('/me/availability-audience-policies', context),
  ]);
  const audience = signal.audiencePolicyId === null ? 'mutual_follow_and_crew' : policies.policies.find(p => p.id === signal.audiencePolicyId)?.audience;
  if (!audience || !['HIDDEN', 'NEARBY', 'DISTANCE_BUCKET', 'ETA_IF_MUTUAL'].includes(signal.proximityVisibility)) throw new Error('Your current sharing rules could not be read. Try again.');
  return { signal, audience: audience as Audience };
}

/** Reuse an existing owned policy. A failed patch cannot silently widen a window. */
export async function saveWindowSignal(windowId: string, audience: Audience, proximityVisibility: Proximity, geographyScope: Geography, context: OwnedApiContext) {
  let audiencePolicyId: string | null = null;
  if (audience !== 'mutual_follow_and_crew') {
    const { policies } = await nearbyRequest<{ policies: AudiencePolicy[] }>('/me/availability-audience-policies', context);
    const policy = policies.find(p => p.audience === audience) ?? await nearbyRequest<AudiencePolicy>('/me/availability-audience-policies', context, 'POST', { audience });
    if (!policy.id || policy.audience !== audience) throw new Error('The audience could not be saved. Try again.');
    audiencePolicyId = policy.id;
  }
  return nearbyRequest<WindowSignal>(`/me/availability-windows/${encodeURIComponent(windowId)}/signal`, context, 'PATCH', { audiencePolicyId, proximityVisibility, geographyScope });
}

/** Identity is resolved through the existing privacy-filtered profile route. */
export async function nearbyIdentity(userId: string, context: OwnedApiContext): Promise<string> {
  const profile = await nearbyRequest<{ id: string; name?: string | null; handle?: string | null }>(`/users/${encodeURIComponent(userId)}`, context);
  if (profile.id !== userId) throw new Error('This traveler is unavailable.');
  return profile.handle ? `@${profile.handle.replace(/^@/, '')}` : profile.name || 'Traveler';
}
