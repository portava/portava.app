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
import { nameVisibilitySet, sanitizeIdentity } from "../../lib/publicIdentity.js";
import { mayDiscloseGemIdentity } from "../hiddenGems/HiddenGemPrivacyGuard.js";

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

/**
 * An event that happened ON this Trip (§14 "events").
 *
 * Read from canonical event storage — this service creates none of its own
 * (§34 "Not a duplicate database for …"). Two links reach it, and both are
 * facts the events feature already records:
 *
 *   `trip_id`   the event is ROOTED to the Trip — an FK, the strongest link.
 *   `rsvp`      the owner RSVP'd "going" and the event happened INSIDE the
 *               Trip's own date window. A "going" RSVP to something three
 *               seasons later is not part of this journey.
 *
 * `role` is the owner's real relationship to the event (they hosted it, or they
 * attended it), never an inference.
 */
export interface JourneyEvent {
  id: string;
  title: string | null;
  city: string | null;
  country: string | null;
  startsAt: string | null;
  endsAt: string | null;
  role: "host" | "attendee";
}

/**
 * Something the traveller RECOMMENDS out of this Trip (§14 "recommendations").
 *
 * The canonical Portava artifact for "a place I am recommending" is a Hidden
 * Gem the traveller submitted, so that is the producer — not a new store, and
 * not a second opinion about who may see one. Disclosure runs through
 * `mayDiscloseGemIdentity`, the shipped predicate that restates the database's
 * own `hidden_gems_public_read` policy (`status = 'active' AND
 * sensitivity_level = 'public'`, plus the submitter's bypass). Journeys
 * therefore cannot become the surface that names a gem Compass and the media
 * surfaces refuse to name.
 *
 * ATTRIBUTION IS NOT A JOIN, AND SAYS SO. `hidden_gems` carries no `trip_id`,
 * so a gem is attributed to a Trip by the two coarse facts both records hold:
 * the Trip's destination city/country, and the Trip's own date window. That is
 * a PRESENTATION rule; it decides only WHICH journey a permitted gem appears
 * under, never WHETHER the viewer may see it.
 */
export interface JourneyRecommendation {
  id: string;
  kind: "hidden_gem";
  name: string | null;
  category: string | null;
  city: string | null;
  country: string | null;
  neighborhood: string | null;
  createdAt: string | null;
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
  /** Events that happened on this Trip, at the viewer's permitted visibility (§14). */
  events: JourneyEvent[];
  /** Hidden Gems the traveller contributed out of this Trip (§14). */
  recommendations: JourneyRecommendation[];
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

/**
 * Inclusive day span of a permitted date range, or null when either end is
 * absent (including when the viewer's projection coarsened the dates away).
 * The ONE definition of "how long was this journey" — the duration label, the
 * Featured pick weight and the Yearbook's defining-journey ranking all read it,
 * so those three can never drift apart.
 */
export function durationDaysOf(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

function durationLabel(start: string | null, end: string | null): string | null {
  const days = durationDaysOf(start, end);
  if (days === null) return null;
  if (days <= 1) return "1 day";
  return `${days} days`;
}

/**
 * The shared "how rich is this journey" weight.
 *
 * Featured Journey (§14) and the Yearbook's defining journeys of a year both
 * rank the same way, so this is the single rule: memories count double, stamps
 * count once, every day adds a tenth, and a finished trip gets a small tiebreak.
 * It is a PRESENTATION ranking only — it never gates visibility, and each of its
 * four inputs is surfaced verbatim as the evidence line for the pick.
 */
export function journeyWeight(input: {
  memoryCount: number;
  stampCount: number;
  durationDays: number;
  completed: boolean;
}): number {
  return (
    input.memoryCount * 2 +
    input.stampCount +
    input.durationDays * 0.1 +
    (input.completed ? 1 : 0)
  );
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

/**
 * Everything that hangs off a Trip, already gathered per trip id.
 *
 * One bundle rather than one positional argument per element: `buildJourneys`,
 * `buildFeaturedJourney` and `pickFeatured` all pass the SAME set, so adding an
 * element must not be able to reach one of the three and miss another — which
 * is exactly how a featured card comes to disagree with the list it is drawn
 * from.
 */
interface JourneyAttachments {
  memories: Map<string, JourneyMemory[]>;
  stamps: Map<string, JourneyStamp[]>;
  people: Map<string, JourneyPerson[]>;
  events: Map<string, JourneyEvent[]>;
  recommendations: Map<string, JourneyRecommendation[]>;
}

/** Project one trip row + everything attached to it into a JourneyProjection. */
function projectTrip(
  trip: any,
  memories: JourneyMemory[],
  stamps: JourneyStamp[],
  people: JourneyPerson[],
  events: JourneyEvent[],
  recommendations: JourneyRecommendation[],
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
    events,
    recommendations,
    featured: false,
  };
}

/** Pull one trip's slice out of an attachment bundle. */
function attachmentsFor(a: JourneyAttachments, tripId: string) {
  return {
    memories: a.memories.get(tripId) ?? [],
    stamps: a.stamps.get(tripId) ?? [],
    people: a.people.get(tripId) ?? [],
    events: a.events.get(tripId) ?? [],
    recommendations: a.recommendations.get(tripId) ?? [],
  };
}

/** Project a trip with its bundled attachments — the ONE way a trip is projected. */
function projectWith(trip: any, a: JourneyAttachments, perms: JourneyPermissions): JourneyProjection {
  const at = attachmentsFor(a, trip.id);
  return projectTrip(trip, at.memories, at.stamps, at.people, at.events, at.recommendations, perms);
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
  //
  // NAME VISIBILITY (universal display-name rule, `lib/publicIdentity.ts`): the
  // "Who was there" strip is a third-party identity list — each companion's real
  // name only leaves the API when THAT companion has opted in via
  // `profile_privacy_settings.show_real_name`. Every row goes through the
  // canonical `sanitizeIdentity` choke point BEFORE any name-derived field is
  // read, so a hidden name yields null and the person still renders by handle.
  // Fail-closed: `nameVisibilitySet` returns an EMPTY set on a query error.
  const profiles = new Map<string, JourneyPerson>();
  try {
    const { data } = await sc
      .from("profiles")
      .select("id, display_name, name, username, handle, avatar_url, show_profile_picture_publicly")
      .in("id", visibleIds);
    const rows = ((data as any[]) ?? []);
    const nameAllowed = await nameVisibilitySet(sc, rows.map((r) => r.id));
    for (const raw of rows) {
      const named = sanitizeIdentity(raw, nameAllowed, viewerId);
      profiles.set(raw.id, {
        id: raw.id,
        name: named.display_name ?? named.name ?? null,
        handle: raw.handle ?? raw.username ?? null,
        avatarUrl: raw.show_profile_picture_publicly === false ? null : (raw.avatar_url ?? null),
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

// ─────────────────────────────────────────────────────────────────────────────
// §14 EVENTS — the two canonical links from an event to a Trip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event states in which an event ACTUALLY HAPPENED (or is happening).
 *
 * `event_state` is draft|open|full|waitlist|started|completed|cancelled|archived
 * (`baseline/20260819_baseline_structure.sql:173`). A journey is a record of what
 * happened, so the three that record a non-event — never planned, called off,
 * withdrawn — are on nobody's journey INCLUDING THE OWNER'S. That is stricter
 * than the ordinary event read, which hides those three from non-hosts only, and
 * deliberately so: "a cancelled boat trip" is not a thing that happened to you.
 */
const JOURNEY_EVENT_STATES = new Set(["open", "full", "waitlist", "started", "completed"]);

/** RSVP statuses that mean the owner actually went. */
const JOURNEY_ATTENDING_STATUSES = new Set(["going"]);

/**
 * May this viewer be told this event was part of the owner's journey?
 *
 * `event_visibility` is public|friends_only|invite_only
 * (`baseline/20260819_baseline_structure.sql:189`). The ladder is the SAME one
 * `tripVisibleToViewer` already applies to the trip that contains it — public to
 * anyone permitted to see the trip, the restricted tier only to a viewer with the
 * relationship, and the closed tier to the owner alone — so an event can never be
 * a wider disclosure than the journey it hangs on. An unrecognised visibility
 * falls through to the owner-only arm (fail-closed).
 */
function eventVisibleToViewer(visibility: unknown, perms: JourneyPermissions): boolean {
  if (perms.isSelf) return true;
  const v = norm(visibility);
  if (v === "public") return true;
  if (v === "friends_only") return perms.canSeeRestricted;
  return false;
}

/** Inclusive [start, end] day window of a trip, as raw date strings. */
function tripWindow(trip: any): { start: string; end: string } | null {
  const start = typeof trip.start_date === "string" ? trip.start_date : null;
  const end = typeof trip.end_date === "string" ? trip.end_date : null;
  if (!start || !end || end < start) return null;
  return { start, end };
}

/** Does an ISO timestamp fall inside a trip's inclusive day window? */
function withinTripWindow(ts: unknown, win: { start: string; end: string } | null): boolean {
  if (!win || typeof ts !== "string" || ts.length < 10) return false;
  const day = ts.slice(0, 10);
  return day >= win.start && day <= win.end;
}

/**
 * Events that happened on each visible Trip (§14).
 *
 * TWO reads, both batched, neither inventing storage:
 *   1. `events.trip_id IN (…)` — events rooted to the Trip.
 *   2. the owner's "going" `event_rsvps`, resolved against `events`, kept only
 *      when the event's start falls inside that Trip's own date window.
 *
 * The window is read from the RAW trip row, never from the viewer's coarsened
 * projection: date coarsening is about what the viewer is TOLD, and letting it
 * change which events are attributed would make the same event appear on
 * different journeys for different viewers.
 *
 * FAIL-CLOSED: an unreadable `events` or `event_rsvps` read yields NO events for
 * anyone rather than a journey that silently lost half of what happened.
 */
async function loadTripEvents(
  sc: SupabaseClient,
  ownerId: string,
  trips: any[],
  perms: JourneyPermissions,
): Promise<Map<string, JourneyEvent[]>> {
  const empty = new Map<string, JourneyEvent[]>();
  if (trips.length === 0) return empty;
  const tripIds = trips.map((t) => t.id).filter(Boolean);
  if (tripIds.length === 0) return empty;

  const COLUMNS = "id, trip_id, host_id, title, city, country, starts_at, ends_at, state, visibility";
  let rooted: any[] = [];
  let rsvped: any[] = [];
  try {
    const [rootedRes, rsvpRes] = await Promise.all([
      sc.from("events").select(COLUMNS).in("trip_id", tripIds),
      sc.from("event_rsvps").select("event_id, status, user_id").eq("user_id", ownerId),
    ]);
    if ((rootedRes as any).error || (rsvpRes as any).error) return empty;
    rooted = ((rootedRes as any).data as any[]) ?? [];
    const attendedIds = (((rsvpRes as any).data as any[]) ?? [])
      .filter((r) => JOURNEY_ATTENDING_STATUSES.has(norm(r.status)))
      .map((r) => r.event_id)
      .filter(Boolean);
    if (attendedIds.length > 0) {
      const res = await sc.from("events").select(COLUMNS).in("id", attendedIds);
      if ((res as any).error) return empty;
      rsvped = ((res as any).data as any[]) ?? [];
    }
  } catch {
    return empty;
  }

  const out = new Map<string, JourneyEvent[]>();
  const seen = new Map<string, Set<string>>(); // tripId → event ids already attached
  const attach = (tripId: string, row: any, role: JourneyEvent["role"]) => {
    if (!tripId || !row?.id) return;
    if (!JOURNEY_EVENT_STATES.has(norm(row.state))) return;
    if (!eventVisibleToViewer(row.visibility, perms)) return;
    const already = seen.get(tripId) ?? new Set<string>();
    if (already.has(row.id)) return;
    already.add(row.id);
    seen.set(tripId, already);
    const list = out.get(tripId) ?? [];
    list.push({
      id: row.id,
      title: row.title ?? null,
      city: row.city ?? null,
      country: row.country ?? null,
      startsAt: row.starts_at ?? null,
      endsAt: row.ends_at ?? null,
      role,
    });
    out.set(tripId, list);
  };

  // Rooted first, so an event the owner both hosted and RSVP'd to reads "host".
  const tripIdSet = new Set(tripIds);
  for (const row of rooted) {
    if (!tripIdSet.has(row.trip_id)) continue;
    attach(row.trip_id, row, norm(row.host_id) === norm(ownerId) ? "host" : "attendee");
  }
  for (const trip of trips) {
    const win = tripWindow(trip);
    if (!win) continue;
    for (const row of rsvped) {
      if (!withinTripWindow(row.starts_at, win)) continue;
      attach(trip.id, row, norm(row.host_id) === norm(ownerId) ? "host" : "attendee");
    }
  }

  for (const [tripId, list] of out) {
    list.sort((a, b) => String(a.startsAt ?? "").localeCompare(String(b.startsAt ?? "")));
    out.set(tripId, list.slice(0, 12));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 RECOMMENDATIONS — the traveller's own Hidden Gems, at the gem policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hidden Gems the owner contributed out of each visible Trip (§14).
 *
 * WHO MAY SEE ONE is not decided here. Every candidate goes through
 * `mayDiscloseGemIdentity` (`services/hiddenGems/HiddenGemPrivacyGuard.ts`),
 * the predicate that restates migration 0043's `hidden_gems_public_read` policy
 * for surfaces reading past RLS on the service client. Journeys get the same
 * answer Compass and the media surfaces get, from the same function, so there
 * is no fourth copy of the rule to drift.
 *
 * A merged gem is excluded on top of that: `merged_into` means the gem has been
 * folded into another and is no longer a thing to hand anyone — the same
 * exclusion `services/telegraph/shareables.ts` applies before it will share one.
 *
 * WHICH journey a permitted gem lands on is decided here, and only that: the
 * Trip's destination city (or, failing a city, its country) plus the Trip's own
 * date window. A gem the traveller filed in another country, or years either
 * side of the Trip, is somebody's recommendation but not this journey's.
 *
 * FAIL-CLOSED: an unreadable `hidden_gems` read yields no recommendations.
 */
async function loadTripRecommendations(
  sc: SupabaseClient,
  ownerId: string,
  trips: any[],
  perms: JourneyPermissions,
): Promise<Map<string, JourneyRecommendation[]>> {
  const empty = new Map<string, JourneyRecommendation[]>();
  if (trips.length === 0) return empty;

  let rows: any[] = [];
  try {
    const res = await sc
      .from("hidden_gems")
      .select(
        "id, submitted_by, name, category, city, country, neighborhood, status, sensitivity_level, merged_into, created_at",
      )
      .eq("submitted_by", ownerId);
    if ((res as any).error) return empty;
    rows = ((res as any).data as any[]) ?? [];
  } catch {
    return empty;
  }
  if (rows.length === 0) return empty;

  // The gem policy's own viewer. The owner reading their own passport is the
  // submitter, so the guard's submitter bypass applies exactly as it does
  // everywhere else; `isSelf` is never used to widen it by a second route.
  const gemViewerId = perms.isSelf ? ownerId : (perms.viewerId ?? null);
  const disclosable = rows.filter(
    (g) => !g.merged_into && mayDiscloseGemIdentity(g, gemViewerId),
  );
  if (disclosable.length === 0) return empty;

  const out = new Map<string, JourneyRecommendation[]>();
  for (const trip of trips) {
    const win = tripWindow(trip);
    if (!win) continue;
    const city = norm(trip.destination_city);
    const country = norm(trip.destination_country);
    if (!city && !country) continue;
    const list: JourneyRecommendation[] = [];
    for (const g of disclosable) {
      if (!withinTripWindow(g.created_at, win)) continue;
      const matches = city ? norm(g.city) === city : norm(g.country) === country;
      if (!matches) continue;
      list.push({
        id: g.id,
        kind: "hidden_gem",
        name: g.name ?? null,
        category: g.category ?? null,
        city: g.city ?? null,
        country: g.country ?? null,
        neighborhood: g.neighborhood ?? null,
        createdAt: g.created_at ?? null,
      });
    }
    if (list.length > 0) {
      list.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
      out.set(trip.id, list.slice(0, 12));
    }
  }
  return out;
}

/**
 * Gather every per-trip attachment ONCE, for one set of visible trips.
 *
 * `buildJourneys` and `buildFeaturedJourney` both call this, which is what keeps
 * the featured card and the list it is drawn from telling the same story.
 */
async function loadAttachments(
  sc: SupabaseClient,
  ownerId: string,
  visible: any[],
  allMemories: any[],
  stamps: Map<string, JourneyStamp[]>,
  perms: JourneyPermissions,
): Promise<JourneyAttachments> {
  const [people, events, recommendations] = await Promise.all([
    loadTripPeople(sc, ownerId, visible.map((t) => t.id), perms.viewerId ?? null),
    loadTripEvents(sc, ownerId, visible, perms),
    loadTripRecommendations(sc, ownerId, visible, perms),
  ]);
  return {
    // §29 step 9: gate EACH memory by its own visibility before it is attached to
    // a trip — a public trip must not leak its private/circle_only/trip_crew
    // memories.
    memories: memoriesByTrip(filterMemories(allMemories as any[], effectiveCallerCtx(perms)) as any[]),
    stamps,
    people,
    events,
    recommendations,
  };
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

  const attachments = await loadAttachments(sc, userId, visible, allMemories as any[], stampMap, perms);
  const journeys = visible.map((t) => projectWith(t, attachments, perms));

  // Newest first.
  journeys.sort((a, b) => {
    const ta = a.startDate ? Date.parse(a.startDate) : 0;
    const tb = b.startDate ? Date.parse(b.startDate) : 0;
    return tb - ta;
  });

  // Featured pick uses full (unfiltered-date) weight from the raw trips.
  const featured = pickFeatured(visible, attachments, perms);
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
  // Same attachment gather as buildJourneys — same per-memory visibility gate,
  // same block-filtered people, same events and recommendations — so the
  // aggregate's featured card can never disagree with the Journeys list.
  const attachments = await loadAttachments(sc, userId, visible, allMemories as any[], stampMap, perms);
  return pickFeatured(visible, attachments, perms);
}

/**
 * Featured = the trip with the strongest combined weight:
 *   memories*2 + stamps*1 + durationDays*0.1, completed trips preferred.
 */
function pickFeatured(
  trips: any[],
  attachments: JourneyAttachments,
  perms: JourneyPermissions,
): JourneyProjection | null {
  let best: { trip: any; weight: number } | null = null;
  for (const t of trips) {
    const at = attachmentsFor(attachments, t.id);
    // Deliberately UNCHANGED by §14's two new elements: the pick weight stays
    // memories/stamps/duration/completed. Events and recommendations are things
    // a journey CARRIES, not evidence about which journey was the richest, and
    // folding them in would silently re-rank every traveller's Featured Journey.
    const weight = journeyWeight({
      memoryCount: at.memories.length,
      stampCount: at.stamps.length,
      durationDays: durationDaysOf(t.start_date, t.end_date) ?? 0,
      completed: t.status === "completed",
    });
    if (weight <= 0) continue;
    if (!best || weight > best.weight) best = { trip: t, weight };
  }
  if (!best) return null;
  const j = projectWith(best.trip, attachments, perms);
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
