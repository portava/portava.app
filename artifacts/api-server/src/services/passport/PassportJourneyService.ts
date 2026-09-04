/**
 * PassportJourneyService — §14 "Journeys and Featured Journey".
 *
 * A pure PROJECTION over canonical Trip / travel records (trips, passport
 * memories, user_stamps). It creates NO trip storage of its own (§34 non-goal:
 * "Not a duplicate database for Trips …") — every field is read from the
 * canonical tables and grouped for presentation:
 *
 *   WORLD → year → country/city → Trip → places → memories / stamps   (TABLE 26)
 *
 * Visibility: a viewer only sees trips they are permitted to see. Trip-level
 * visibility is honoured via `trips.visibility` + `show_on_profile`, and dates
 * are coarsened when `show_exact_dates` is false. Owners see everything.
 *
 * A single Featured Journey (e.g. "30 Days in Vietnam") is derived from the same
 * data — the "richest" completed trip by combined memory + stamp + duration
 * weight — never a separately stored highlight.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMemories } from "./PassportMemoryService.js";
import { filterMemories, type CallerContext } from "./PassportPrivacyGuard.js";
import { fetchBlockedSet } from "../../lib/blocks.js";

export interface JourneyMemory {
  id: string;
  title: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  photoUrl: string | null;
  earnedAt: string | null;
}

export interface JourneyStamp {
  name: string | null;
  city: string | null;
  country: string | null;
  earnedAt: string | null;
}

/**
 * A person who shared this Trip (§14 "people context"). Coarse identity only —
 * id, name, handle, avatar — never location, dates or contact detail. Mirrors
 * the client's forward-compatible JourneyPerson so "Who was there" renders.
 */
export interface JourneyPerson {
  id: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

/** One Trip projected into the Journeys view. */
export interface JourneyProjection {
  tripId: string;
  title: string;
  year: number | null;
  country: string | null;
  city: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Coarse duration label ("30 days") when dates permitted, else null. */
  durationLabel: string | null;
  status: string;
  memoryCount: number;
  stampCount: number;
  memories: JourneyMemory[];
  stamps: JourneyStamp[];
  /** Coarse, block-filtered companions on this Trip (§14). */
  people: JourneyPerson[];
  featured: boolean;
}

/** Grouped chronological projection (TABLE 26). */
export interface JourneysProjection {
  userId: string;
  years: Array<{
    year: number | null;
    countries: Array<{
      country: string | null;
      cities: Array<{
        city: string | null;
        journeys: JourneyProjection[];
      }>;
    }>;
  }>;
  featured: JourneyProjection | null;
  totalJourneys: number;
}

/** Minimal viewer-permission surface. */
export interface JourneyPermissions {
  isSelf: boolean;
  canSeeTrips: boolean;
  /** Viewer may see friends-only trips (friend/crew-level relationship). */
  canSeeRestricted: boolean;
  /**
   * Per-item visibility context for the memories attached to a trip (§29 step 9).
   * A viewer permitted to see a public TRIP must still NOT receive the trip's
   * private/circle_only/trip_crew MEMORIES — journey memories run the exact same
   * per-memory gate (filterMemories/guardMemory) the standalone memories array
   * does. When omitted, a conservative fallback is derived from isSelf /
   * canSeeRestricted so the journey path can never over-expose.
   */
  callerCtx?: CallerContext;
  /**
   * The viewer's user id (null for an unauthenticated/public viewer). Used to
   * block-filter journey people in BOTH directions relative to the viewer — a
   * companion the viewer blocked, or who blocked the viewer, is never shown.
   */
  viewerId?: string | null;
}

/**
 * Effective per-memory caller context for the journey path. Prefers the exact
 * CallerContext threaded from the route/aggregate; otherwise falls back to the
 * least-privileged context the coarse trip permissions still justify (owner sees
 * all, a restricted viewer maps to the "circle" friend proxy, everyone else is
 * treated as public) — never more than the caller is entitled to.
 */
function effectiveCallerCtx(perms: JourneyPermissions): CallerContext {
  if (perms.callerCtx) return perms.callerCtx;
  if (perms.isSelf) return "owner";
  return perms.canSeeRestricted ? "circle" : "public";
}

function yearOf(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCFullYear();
}

function durationLabel(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const days = Math.round((b - a) / 86_400_000) + 1;
  if (days <= 1) return "1 day";
  return `${days} days`;
}

/** Is a trip visible to this viewer? Owners see all; others honour visibility. */
function tripVisibleToViewer(trip: any, perms: JourneyPermissions): boolean {
  if (perms.isSelf) return true;
  if (trip.show_on_profile === false) return false;
  const v = String(trip.visibility ?? "private");
  if (v === "public") return true;
  if ((v === "buddies" || v === "invite") && perms.canSeeRestricted) return true;
  return false; // private, or restricted without relationship
}

/** Load the canonical trips a user belongs to (owner OR accepted member). */
async function loadUserTrips(sc: SupabaseClient, userId: string): Promise<any[]> {
  const tripIds = new Set<string>();
  try {
    const [members, owned] = await Promise.all([
      sc.from("trip_members").select("trip_id").eq("user_id", userId).neq("role", "invited"),
      sc.from("trips").select("id").eq("owner_id", userId),
    ]);
    for (const r of ((members as any).data ?? []) as any[]) if (r.trip_id) tripIds.add(r.trip_id);
    for (const r of ((owned as any).data ?? []) as any[]) if (r.id) tripIds.add(r.id);
  } catch {
    return [];
  }
  if (tripIds.size === 0) return [];
  try {
    const { data } = await sc
      .from("trips")
      .select(
        "id, owner_id, title, destination_city, destination_country, start_date, end_date, status, visibility, show_on_profile, show_exact_dates, travel_style, trip_type",
      )
      .in("id", Array.from(tripIds))
      .not("status", "is", null);
    return ((data as any[]) ?? []).filter((t) => t.status !== "draft" && t.status !== "cancelled");
  } catch {
    return [];
  }
}

/** Group memories by trip_id. Memories with no trip_id are ignored for journeys. */
function memoriesByTrip(memories: any[]): Map<string, JourneyMemory[]> {
  const map = new Map<string, JourneyMemory[]>();
  for (const m of memories) {
    if (!m.trip_id) continue;
    const arr = map.get(m.trip_id) ?? [];
    arr.push({
      id: m.id,
      title: m.title ?? null,
      city: m.city ?? null,
      country: m.country ?? null,
      category: m.category ?? null,
      photoUrl: m.photo_url ?? null,
      earnedAt: m.earned_at ?? null,
    });
    map.set(m.trip_id, arr);
  }
  return map;
}

/** Group stamps by trip via source_id (source_type='trips'). */
async function stampsByTrip(sc: SupabaseClient, userId: string): Promise<Map<string, JourneyStamp[]>> {
  const map = new Map<string, JourneyStamp[]>();
  try {
    const { data } = await sc
      .from("user_stamps")
      .select("source_type, source_id, city, country, earned_at, is_revoked, stamp_definitions(name)")
      .eq("user_id", userId)
      .eq("is_revoked", false);
    for (const r of ((data as any[]) ?? [])) {
      if (norm(r.source_type) !== "trips" || !r.source_id) continue;
      const arr = map.get(r.source_id) ?? [];
      arr.push({
        name: r.stamp_definitions?.name ?? null,
        city: r.city ?? null,
        country: r.country ?? null,
        earnedAt: r.earned_at ?? null,
      });
      map.set(r.source_id, arr);
    }
  } catch {
    /* tolerate */
  }
  return map;
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/** Project one trip row + its memories/stamps/people into a JourneyProjection. */
function projectTrip(
  trip: any,
  memories: JourneyMemory[],
  stamps: JourneyStamp[],
  people: JourneyPerson[],
  perms: JourneyPermissions,
): JourneyProjection {
  const showDates = perms.isSelf || trip.show_exact_dates !== false;
  const start = showDates ? (trip.start_date ?? null) : null;
  const end = showDates ? (trip.end_date ?? null) : null;
  return {
    tripId: trip.id,
    title: trip.title ?? "Trip",
    year: yearOf(trip.start_date ?? trip.end_date),
    country: trip.destination_country ?? null,
    city: trip.destination_city ?? null,
    startDate: start,
    endDate: end,
    durationLabel: showDates ? durationLabel(trip.start_date, trip.end_date) : null,
    status: String(trip.status),
    memoryCount: memories.length,
    stampCount: stamps.length,
    memories,
    stamps,
    people,
    featured: false,
  };
}

/**
 * Build the coarse, block-filtered people-context for a set of trips (§14).
 *
 * People are the OTHER accepted members of each Trip (trip_members) plus accepted
 * members of Shared Moments rooted to the Trip (shared_moment_memberships →
 * shared_moments.trip_id). The passport owner and the viewer themselves are never
 * listed as companions.
 *
 * Blocking propagates in BOTH directions (§24): a companion blocked-either-way
 * with the viewer OR with the owner is dropped. Block reads are fail-closed — if
 * either block set is unreadable, NO people are returned rather than risk leaking
 * a blocked relationship. Only coarse identity (id, name, handle, avatar) is
 * projected; a companion who hides their photo has avatarUrl nulled.
 */
async function loadTripPeople(
  sc: SupabaseClient,
  ownerId: string,
  tripIds: string[],
  viewerId: string | null | undefined,
): Promise<Map<string, JourneyPerson[]>> {
  const empty = new Map<string, JourneyPerson[]>();
  if (tripIds.length === 0) return empty;

  // tripId → set of candidate companion user ids.
  const perTrip = new Map<string, Set<string>>();
  const addCandidate = (tripId: string, uid: string) => {
    if (!tripId || !uid || uid === ownerId) return;
    const set = perTrip.get(tripId) ?? new Set<string>();
    set.add(uid);
    perTrip.set(tripId, set);
  };

  try {
    // Co-members of the trips.
    const { data: members } = await sc
      .from("trip_members")
      .select("trip_id, user_id, status")
      .in("trip_id", tripIds)
      .eq("status", "accepted");
    for (const r of ((members as any[]) ?? [])) addCandidate(r.trip_id, r.user_id);

    // Shared Moments rooted to these trips + their accepted members.
    const { data: moments } = await sc
      .from("shared_moments")
      .select("id, trip_id")
      .in("trip_id", tripIds);
    const momentToTrip = new Map<string, string>();
    for (const m of ((moments as any[]) ?? [])) if (m.id && m.trip_id) momentToTrip.set(m.id, m.trip_id);
    if (momentToTrip.size > 0) {
      const { data: sm } = await sc
        .from("shared_moment_memberships")
        .select("moment_id, user_id, status")
        .in("moment_id", [...momentToTrip.keys()])
        .eq("status", "accepted");
      for (const r of ((sm as any[]) ?? [])) {
        const tripId = momentToTrip.get(r.moment_id);
        if (tripId) addCandidate(tripId, r.user_id);
      }
    }
  } catch {
    return empty;
  }

  const allIds = new Set<string>();
  for (const set of perTrip.values()) for (const id of set) allIds.add(id);
  if (allIds.size === 0) return empty;

  // §24 block propagation — fail-closed. Uncertain block state ⇒ show nobody.
  const [viewerBlocks, ownerBlocks] = await Promise.all([
    viewerId ? fetchBlockedSet(sc, viewerId) : Promise.resolve(new Set<string>()),
    fetchBlockedSet(sc, ownerId),
  ]);
  if (viewerBlocks === null || ownerBlocks === null) return empty;

  const excluded = (uid: string): boolean =>
    uid === viewerId || viewerBlocks.has(uid) || ownerBlocks.has(uid);

  const visibleIds = [...allIds].filter((id) => !excluded(id));
  if (visibleIds.length === 0) return empty;

  // Coarse profile fetch for the survivors.
  const profiles = new Map<string, JourneyPerson>();
  try {
    const { data } = await sc
      .from("profiles")
      .select("id, display_name, name, username, handle, avatar_url, show_profile_picture_publicly")
      .in("id", visibleIds);
    for (const p of ((data as any[]) ?? [])) {
      profiles.set(p.id, {
        id: p.id,
        name: p.display_name ?? p.name ?? null,
        handle: p.handle ?? p.username ?? null,
        avatarUrl: p.show_profile_picture_publicly === false ? null : (p.avatar_url ?? null),
      });
    }
  } catch {
    return empty;
  }

  const out = new Map<string, JourneyPerson[]>();
  for (const [tripId, ids] of perTrip) {
    const list: JourneyPerson[] = [];
    for (const id of ids) {
      if (excluded(id)) continue;
      const person = profiles.get(id);
      if (person) list.push(person);
    }
    if (list.length > 0) {
      // Coarse: stable by handle/name, capped.
      list.sort((a, b) => (a.name ?? a.handle ?? "").localeCompare(b.name ?? b.handle ?? ""));
      out.set(tripId, list.slice(0, 12));
    }
  }
  return out;
}

/**
 * Build the full grouped Journeys projection for `userId` as seen by a viewer.
 */
export async function buildJourneys(
  sc: SupabaseClient,
  userId: string,
  perms: JourneyPermissions,
): Promise<JourneysProjection> {
  const empty: JourneysProjection = { userId, years: [], featured: null, totalJourneys: 0 };
  if (!perms.isSelf && !perms.canSeeTrips) return empty;

  const [trips, allMemories, stampMap] = await Promise.all([
    loadUserTrips(sc, userId),
    loadMemories(sc, userId).catch(() => [] as any[]),
    stampsByTrip(sc, userId),
  ]);

  const visible = trips.filter((t) => tripVisibleToViewer(t, perms));
  if (visible.length === 0) return empty;

  // §29 step 9: gate EACH memory by its own visibility before it is attached to a
  // trip — a public trip must not leak its private/circle_only/trip_crew memories.
  const memMap = memoriesByTrip(filterMemories(allMemories as any[], effectiveCallerCtx(perms)) as any[]);
  // §14 people context — coarse, block-filtered companions on the visible trips.
  const peopleMap = await loadTripPeople(sc, userId, visible.map((t) => t.id), perms.viewerId ?? null);
  const journeys = visible.map((t) => projectTrip(t, memMap.get(t.id) ?? [], stampMap.get(t.id) ?? [], peopleMap.get(t.id) ?? [], perms));

  // Newest first.
  journeys.sort((a, b) => {
    const ta = a.startDate ? Date.parse(a.startDate) : 0;
    const tb = b.startDate ? Date.parse(b.startDate) : 0;
    return tb - ta;
  });

  // Featured pick uses full (unfiltered-date) weight from the raw trips.
  const featured = pickFeatured(visible, memMap, stampMap, peopleMap, perms);
  if (featured) {
    const match = journeys.find((j) => j.tripId === featured.tripId);
    if (match) match.featured = true;
  }

  // Group year → country → city.
  const years = groupJourneys(journeys);

  return { userId, years, featured, totalJourneys: journeys.length };
}

/** Build ONLY the single Featured Journey (used by the passport aggregate). */
export async function buildFeaturedJourney(
  sc: SupabaseClient,
  userId: string,
  perms: JourneyPermissions,
): Promise<JourneyProjection | null> {
  if (!perms.isSelf && !perms.canSeeTrips) return null;
  const [trips, allMemories, stampMap] = await Promise.all([
    loadUserTrips(sc, userId),
    loadMemories(sc, userId).catch(() => [] as any[]),
    stampsByTrip(sc, userId),
  ]);
  const visible = trips.filter((t) => tripVisibleToViewer(t, perms));
  if (visible.length === 0) return null;
  // Same per-memory visibility gate as buildJourneys — the featured trip's private
  // memories must not reach a non-owner viewer either.
  const memMap = memoriesByTrip(filterMemories(allMemories as any[], effectiveCallerCtx(perms)) as any[]);
  const peopleMap = await loadTripPeople(sc, userId, visible.map((t) => t.id), perms.viewerId ?? null);
  return pickFeatured(visible, memMap, stampMap, peopleMap, perms);
}

/**
 * Featured = the trip with the strongest combined weight:
 *   memories*2 + stamps*1 + durationDays*0.1, completed trips preferred.
 */
function pickFeatured(
  trips: any[],
  memMap: Map<string, JourneyMemory[]>,
  stampMap: Map<string, JourneyStamp[]>,
  peopleMap: Map<string, JourneyPerson[]>,
  perms: JourneyPermissions,
): JourneyProjection | null {
  let best: { trip: any; weight: number } | null = null;
  for (const t of trips) {
    const mems = memMap.get(t.id) ?? [];
    const stamps = stampMap.get(t.id) ?? [];
    let days = 0;
    if (t.start_date && t.end_date) {
      const d = Date.parse(t.end_date) - Date.parse(t.start_date);
      if (Number.isFinite(d) && d >= 0) days = d / 86_400_000;
    }
    let weight = mems.length * 2 + stamps.length + days * 0.1;
    if (t.status === "completed") weight += 1; // small tiebreak toward finished journeys
    if (weight <= 0) continue;
    if (!best || weight > best.weight) best = { trip: t, weight };
  }
  if (!best) return null;
  const j = projectTrip(best.trip, memMap.get(best.trip.id) ?? [], stampMap.get(best.trip.id) ?? [], peopleMap.get(best.trip.id) ?? [], perms);
  j.featured = true;
  return j;
}

/** Group an ordered journey list into year → country → city buckets. */
function groupJourneys(journeys: JourneyProjection[]): JourneysProjection["years"] {
  const years: JourneysProjection["years"] = [];
  const yearIdx = new Map<string, number>();

  for (const j of journeys) {
    const yKey = String(j.year ?? "unknown");
    let yi = yearIdx.get(yKey);
    if (yi === undefined) {
      yi = years.length;
      years.push({ year: j.year, countries: [] });
      yearIdx.set(yKey, yi);
    }
    const yearBucket = years[yi];

    const cKey = j.country ?? "unknown";
    let country = yearBucket.countries.find((c) => (c.country ?? "unknown") === cKey);
    if (!country) {
      country = { country: j.country, cities: [] };
      yearBucket.countries.push(country);
    }

    const ciKey = j.city ?? "unknown";
    let city = country.cities.find((c) => (c.city ?? "unknown") === ciKey);
    if (!city) {
      city = { city: j.city, journeys: [] };
      country.cities.push(city);
    }
    city.journeys.push(j);
  }

  // Sort years descending (newest first; unknown last).
  years.sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
  return years;
}
