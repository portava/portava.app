/**
 * §14 zero-character PLACE sources — census-input-intelligence G86 (place
 * picker: nearby, recent and Trip places), G89 (global search: around you now,
 * current Trip) and G90 (Hidden Gem location: nearby canonical places).
 * Lane R wave 2, 2026-10-07.
 *
 * WHAT WAS MISSING
 * ----------------
 * The zero-character list for a place field had one place-level source, the
 * viewer's SAVED places (`savedEntities.ts`). §14 names three more for the
 * place picker — nearby, recent and Trip places — and two for global search —
 * around you now and the current Trip. None was read: the geo branch served the
 * viewer's current CITY and Trip destination CITIES, and nothing at the level
 * of a place.
 *
 * THE RULES EVERY SOURCE HERE KEEPS
 * ---------------------------------
 *   - Gated on the field's own policy: `entityTypes` must list the entity the
 *     row would be, and `allowedSuggestionTypes` the row's type. A field that
 *     may not show a place never gets one from here.
 *   - Personal sources (recent places, Trip places, the current Trip) are also
 *     gated on `allowPersonalization`, the gate the selection-memory read uses,
 *     so the Hidden Gem fields — which do not allow it — get only the
 *     NON-personal "nearby" list.
 *   - Only `status = 'active'` canonical `discovery_places` rows are surfaced,
 *     through the §7/§47 block funnel every reader of that table joins
 *     (`submitterIsVisible`; an unreadable block list serves NOTHING).
 *   - Nothing is fabricated from a stored snapshot or a plan item: an id that
 *     does not resolve to a live canonical place is dropped.
 *   - No position goes on the wire. A nearby row carries no coordinate and no
 *     distance (a distance from the viewer would let a protected place be
 *     triangulated, which §24 forbids search to do).
 *   - Trip rows come only from trips the viewer is an ACCEPTED member or the
 *     owner of — never from a client-supplied trip id — and a plan item another
 *     member marked private is never shown (OD-TRIP-3, `planItemAccess.ts`).
 *   - Every read is bounded and fail-soft: a failure yields [] and the caller
 *     behaves as it did before the source existed.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchBlockedSet, submitterIsVisible } from '../blocks.js'; import { applySearchProtection, searchProtectionEnabled } from '../discoverySearchProtection.js'; import { loadActiveProtectedZones } from '../protectedZoneStore.js'; // §24 on nearby rows (wave-2 verification F3)
import { canSeePlanItemLocation, planItemAccessFor, PLAN_ITEM_PRIVACY_COLUMNS } from './planItemAccess';
import type { InputContext, InputFieldPolicy, InputSuggestion } from './types';

/** Below `SAVED_PLACE_CONFIDENCE` (0.7): an explicit save outranks each of these. */
export const RECENT_PLACE_CONFIDENCE = 0.69;
export const TRIP_PLACE_CONFIDENCE = 0.68;
export const CURRENT_TRIP_CONFIDENCE = 0.68;
export const NEARBY_PLACE_CONFIDENCE = 0.66;

/** "Nearby" is within this many kilometres of the viewer's reported position. */
export const NEARBY_RADIUS_KM = 1.5;
/** Rows read before filtering — a bounded fan-out, as in savedEntities. */
export const ZERO_STATE_READ_MULTIPLIER = 4;
/** How many of the viewer's Trips are looked at for Trip places. */
export const TRIP_PLACE_MAX_TRIPS = 5;

const LIVE_TRIP_STATUSES = ['active', 'upcoming', 'planning'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PlaceRow {
  id: string;
  name: string | null;
  city: string | null;
  primary_category: string | null;
  category: string | null;
  submitted_by: string | null;
  lat?: number | null;
  lng?: number | null;
}

interface Common {
  userId: string;
  context: InputContext;
  policy: InputFieldPolicy;
  policyVersion: string;
  max: number;
  existingEntityIds?: ReadonlySet<string>;
}

function allows(policy: InputFieldPolicy, entity: 'place' | 'trip', type: 'entity' | 'recent'): boolean {
  return (policy.entityTypes ?? []).includes(entity) && policy.allowedSuggestionTypes.includes(type);
}

/**
 * Resolve ids to live canonical places the viewer may be shown, in the order
 * given. `null` when the block list could not be read (serve nothing).
 */
async function visiblePlaces(db: SupabaseClient, userId: string, ids: readonly string[]): Promise<Map<string, PlaceRow> | null> {
  const out = new Map<string, PlaceRow>();
  if (ids.length === 0) return out;
  const blocked = await fetchBlockedSet(db, userId);
  if (blocked === null) return null;
  const { data, error } = await db
    .from('discovery_places')
    .select('id, name, city, primary_category, category, submitted_by')
    .in('id', [...ids])
    .eq('status', 'active');
  if (error) return null;
  for (const p of ((data ?? []) as PlaceRow[])) {
    if (typeof p.id !== 'string') continue;
    if (!submitterIsVisible(p.submitted_by, blocked)) continue;
    out.set(p.id, p);
  }
  return out;
}

function projectPlace(
  row: PlaceRow,
  opts: { context: InputContext; policyVersion: string; kind: 'recent' | 'trip' | 'nearby' },
): InputSuggestion | null {
  const label = (row.name ?? '').trim();
  if (!label) return null;
  const subtitle = [row.city, row.primary_category ?? row.category].filter(Boolean).join(' · ') || null;
  const byKind = {
    recent: { type: 'recent' as const, confidence: RECENT_PLACE_CONFIDENCE, source: 'memory' as const, reason: 'Recent' },
    trip: { type: 'entity' as const, confidence: TRIP_PLACE_CONFIDENCE, source: 'memory' as const, reason: 'On your Trip' },
    nearby: { type: 'entity' as const, confidence: NEARBY_PLACE_CONFIDENCE, source: 'canonical' as const, reason: 'Nearby' },
  }[opts.kind];
  const s: InputSuggestion = {
    id: `${opts.context}:${opts.kind}:place:${row.id}`,
    type: byKind.type,
    context: opts.context,
    label,
    entityType: 'place',
    entityId: row.id,
    action: { type: 'open_entity', entityType: 'place', entityId: row.id },
    confidence: byKind.confidence,
    source: byKind.source,
    reason: byKind.reason,
    destination: { route: `/place/${row.id}`, entityType: 'place', entityId: row.id },
    canonicalUri: `portava:/place/${row.id}`,
    policyVersion: opts.policyVersion,
  };
  if (subtitle) s.subtitle = subtitle;
  return s;
}

/**
 * NEARBY canonical places (G86, G89 "around you now", G90). Not personal: it
 * uses the position the request carries and reads only public places, so it
 * needs no `allowPersonalization` — which is what lets the Hidden Gem location
 * field have it. Nearest first; no distance is projected.
 */
export async function buildNearbyPlaceSuggestions(
  db: SupabaseClient,
  opts: Common & { lat: number | null | undefined; lng: number | null | undefined },
): Promise<InputSuggestion[]> {
  if (!opts.userId) return [];
  if (!allows(opts.policy, 'place', 'entity')) return [];
  const lat = opts.lat;
  const lng = opts.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
  const max = Math.max(0, opts.max);
  if (max === 0) return [];
  const existing = opts.existingEntityIds ?? new Set<string>();
  try {
    const dLat = NEARBY_RADIUS_KM / 111;
    const dLng = NEARBY_RADIUS_KM / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
    const blocked = await fetchBlockedSet(db, opts.userId);
    if (blocked === null) return [];
    const { data, error } = await db
      .from('discovery_places')
      .select('id, name, city, primary_category, category, submitted_by, lat, lng')
      .eq('status', 'active')
      .gte('lat', lat - dLat)
      .lte('lat', lat + dLat)
      .gte('lng', lng - dLng)
      .lte('lng', lng + dLng)
      .limit(max * ZERO_STATE_READ_MULTIPLIER);
    if (error) return [];
    const ranked = ((data ?? []) as PlaceRow[])
      .filter((p) => typeof p.id === 'string' && !existing.has(p.id))
      .filter((p) => submitterIsVisible(p.submitted_by, blocked))
      .filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number')
      .map((p) => ({ p, km: haversineKm(lat, lng, p.lat as number, p.lng as number) }))
      .filter((x) => x.km <= NEARBY_RADIUS_KM)
      .sort((a, b) => a.km - b.km || a.p.id.localeCompare(b.p.id));
    const protectedRanked = await nearbyAfterProtection(db, ranked);
    const out: InputSuggestion[] = [];
    for (const { p } of protectedRanked) {
      if (out.length >= max) break;
      const s = projectPlace(p, { context: opts.context, policyVersion: opts.policyVersion, kind: 'nearby' });
      if (s) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * §24 protected zones on the "nearby" rows (wave-2 verification F3), the same
 * pass `GET /discovery/search` runs (lib/discoverySearchProtection.ts): a place
 * inside a `suppress` zone is not offered. Flag off, absent or unreadable:
 * nothing is read and the rows pass, exactly as search.
 *
 * TWO DELIBERATE DIFFERENCES, one argument. A "nearby" row's whole claim IS
 * its position — it is offered because it is close, and it is ranked by how
 * close. So:
 *   - flag on and the zone policy UNREADABLE: search keeps the row and
 *     withholds its position; withholding cannot help here, so the row is
 *     dropped;
 *   - a COARSEN zone (wave-2 second verification F4): search snaps the row to
 *     the zone's anchor and marks it `approximate`. Offering it here would
 *     still decide inclusion inside the radius and its rank from the TRUE
 *     point, which a viewer who moves and re-asks can trilaterate — the very
 *     point the Map and search only ever show at the anchor. So it is dropped
 *     too.
 * Only a row the pass returned UNTOUCHED (allowed, or carrying no position) is
 * offered.
 */
async function nearbyAfterProtection<R extends { p: PlaceRow }>(db: SupabaseClient, ranked: R[]): Promise<R[]> {
  if (ranked.length === 0 || !(await searchProtectionEnabled(db))) return ranked;
  let zones: Awaited<ReturnType<typeof loadActiveProtectedZones>>;
  try { zones = await loadActiveProtectedZones(db); } catch { zones = null; }
  const probes = ranked.map((r) => ({ id: r.p.id, type: 'places', title: String(r.p.name ?? r.p.id), metadata: { lat: r.p.lat, lng: r.p.lng } as Record<string, unknown> }));
  const { results } = applySearchProtection(probes, zones);
  const served = new Set(results.filter((x) => x.metadata?.coordsPrecision !== 'hidden' && x.metadata?.coordsPrecision !== 'approximate').map((x) => x.id));
  return ranked.filter((r) => served.has(r.p.id));
}

/**
 * RECENT places (G86): the viewer's own `user_recent_places`, newest first,
 * resolved to live canonical places. The stored `place_snapshot` is the
 * client's copy; only its id is used, and an id that is not a live canonical
 * place is dropped rather than rendered from the snapshot.
 */
export async function buildRecentPlaceSuggestions(db: SupabaseClient, opts: Common): Promise<InputSuggestion[]> {
  if (!opts.userId) return [];
  if (opts.policy.allowPersonalization !== true) return [];
  if (!allows(opts.policy, 'place', 'recent')) return [];
  const max = Math.max(0, opts.max);
  if (max === 0) return [];
  const existing = opts.existingEntityIds ?? new Set<string>();
  try {
    const { data, error } = await db
      .from('user_recent_places')
      .select('place_snapshot, used_at')
      .eq('user_id', opts.userId)
      .order('used_at', { ascending: false })
      .limit(max * ZERO_STATE_READ_MULTIPLIER);
    if (error) return [];
    const rows = ((data ?? []) as Array<{ place_snapshot: unknown; used_at: string | null }>)
      .sort((a, b) => String(b.used_at ?? '').localeCompare(String(a.used_at ?? '')));
    const ids: string[] = [];
    for (const r of rows) {
      const snap = r.place_snapshot as { id?: unknown } | null;
      const id = snap && typeof snap.id === 'string' ? snap.id : null;
      if (!id || !UUID.test(id) || existing.has(id) || ids.includes(id)) continue;
      ids.push(id);
    }
    const places = await visiblePlaces(db, opts.userId, ids);
    if (places === null) return [];
    const out: InputSuggestion[] = [];
    for (const id of ids) {
      if (out.length >= max) break;
      const p = places.get(id);
      if (!p) continue;
      const s = projectPlace(p, { context: opts.context, policyVersion: opts.policyVersion, kind: 'recent' });
      if (s) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

interface ViewerTrip {
  id: string;
  title: string | null;
  destination_city: string | null;
  status: string | null;
  start_date: string | null;
}

/**
 * The viewer's live Trips — ones they OWN or are an ACCEPTED member of —
 * active first, then by start date. `null` when a read failed.
 */
async function viewerLiveTrips(db: SupabaseClient, userId: string): Promise<ViewerTrip[] | null> {
  const [members, owned] = await Promise.all([
    db.from('trip_members').select('trip_id, status').eq('user_id', userId).eq('status', 'accepted'),
    db.from('trips').select('id').eq('owner_id', userId),
  ]);
  if (members.error || owned.error) return null;
  const ids = new Set<string>();
  for (const m of ((members.data ?? []) as Array<{ trip_id: string | null }>)) if (typeof m.trip_id === 'string') ids.add(m.trip_id);
  for (const t of ((owned.data ?? []) as Array<{ id: string | null }>)) if (typeof t.id === 'string') ids.add(t.id);
  if (ids.size === 0) return [];
  const { data, error } = await db
    .from('trips')
    .select('id, title, destination_city, status, start_date')
    .in('id', [...ids])
    .in('status', [...LIVE_TRIP_STATUSES])
    .order('start_date', { ascending: true })
    .limit(20);
  if (error) return null;
  return ((data ?? []) as ViewerTrip[])
    .filter((t) => typeof t.id === 'string')
    .sort((a, b) =>
      (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)
      || String(a.start_date ?? '').localeCompare(String(b.start_date ?? ''))
      || a.id.localeCompare(b.id));
}

/**
 * TRIP places (G86): canonical places on the viewer's live Trips' plans, the
 * active Trip's first. A plan item another member marked private is not shown,
 * and one whose place is not a live canonical place is dropped.
 */
export async function buildTripPlaceSuggestions(db: SupabaseClient, opts: Common): Promise<InputSuggestion[]> {
  if (!opts.userId) return [];
  if (opts.policy.allowPersonalization !== true) return [];
  if (!allows(opts.policy, 'place', 'entity')) return [];
  const max = Math.max(0, opts.max);
  if (max === 0) return [];
  const existing = opts.existingEntityIds ?? new Set<string>();
  try {
    const trips = await viewerLiveTrips(db, opts.userId);
    if (trips === null || trips.length === 0) return [];
    const tripIds = trips.slice(0, TRIP_PLACE_MAX_TRIPS).map((t) => t.id);
    const { data, error } = await db
      .from('trip_plan_items')
      .select(`id, trip_id, source_type, source_id, sort_order, removed_at, ${PLAN_ITEM_PRIVACY_COLUMNS}`)
      .in('trip_id', tripIds)
      .eq('source_type', 'place')
      .is('removed_at', null)
      .limit(max * ZERO_STATE_READ_MULTIPLIER * TRIP_PLACE_MAX_TRIPS);
    if (error) return [];
    const items = (data ?? []) as Array<Record<string, unknown> & { trip_id?: unknown; source_id?: unknown; sort_order?: unknown }>;
    const accessByTrip = new Map<string, Awaited<ReturnType<typeof planItemAccessFor>>>();
    for (const t of tripIds) accessByTrip.set(t, await planItemAccessFor(db, t, opts.userId));
    const tripRank = new Map(tripIds.map((t, i) => [t, i]));
    const ids: string[] = [];
    for (const it of items
      .filter((i) => typeof i.trip_id === 'string' && typeof i.source_id === 'string')
      .sort((a, b) =>
        (tripRank.get(a.trip_id as string) ?? 99) - (tripRank.get(b.trip_id as string) ?? 99)
        || Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))) {
      const access = accessByTrip.get(it.trip_id as string);
      if (!access || !canSeePlanItemLocation(access, it)) continue;
      const id = it.source_id as string;
      if (!UUID.test(id) || existing.has(id) || ids.includes(id)) continue;
      ids.push(id);
    }
    const places = await visiblePlaces(db, opts.userId, ids);
    if (places === null) return [];
    const out: InputSuggestion[] = [];
    for (const id of ids) {
      if (out.length >= max) break;
      const p = places.get(id);
      if (!p) continue;
      const s = projectPlace(p, { context: opts.context, policyVersion: opts.policyVersion, kind: 'trip' });
      if (s) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The CURRENT Trip as an entity (G89): the viewer's `active` Trip, if they
 * have one, for a field whose policy may show a trip. One row, never a guess
 * between several upcoming ones.
 */
export async function buildCurrentTripSuggestion(db: SupabaseClient, opts: Common): Promise<InputSuggestion[]> {
  if (!opts.userId) return [];
  if (opts.policy.allowPersonalization !== true) return [];
  if (!allows(opts.policy, 'trip', 'entity')) return [];
  if (Math.max(0, opts.max) === 0) return [];
  try {
    const trips = await viewerLiveTrips(db, opts.userId);
    if (trips === null) return [];
    const current = trips.find((t) => t.status === 'active');
    if (!current || (opts.existingEntityIds ?? new Set<string>()).has(current.id)) return [];
    const label = (current.title ?? '').trim() || (current.destination_city ?? '').trim();
    if (!label) return [];
    const s: InputSuggestion = {
      id: `${opts.context}:current:trip:${current.id}`,
      type: 'entity',
      context: opts.context,
      label,
      entityType: 'trip',
      entityId: current.id,
      action: { type: 'open_entity', entityType: 'trip', entityId: current.id },
      confidence: CURRENT_TRIP_CONFIDENCE,
      source: 'memory',
      reason: 'Current Trip',
      destination: { route: `/trip/${current.id}`, entityType: 'trip', entityId: current.id },
      canonicalUri: `portava:/trip/${current.id}`,
      policyVersion: opts.policyVersion,
    };
    if (current.destination_city && current.destination_city.trim() && current.destination_city.trim() !== label) {
      s.subtitle = current.destination_city.trim();
    }
    return [s];
  } catch {
    return [];
  }
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}
