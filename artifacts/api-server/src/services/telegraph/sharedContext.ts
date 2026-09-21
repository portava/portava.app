/**
 * Telegraph §3 — the Shared Context Rail projection.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §3    "At the top of each conversation, show mutually relevant events,
 *          plans, Trips and related Portava objects created or joined by both
 *          sides."
 *   §3.1  the four eligibility clauses, plus "Past shared objects remain
 *          available in the historical view only when still authorized."
 *   §3.2  "A place that one person merely sent in a message is shared content,
 *          not a mutual plan. Promotion into the Shared Context Rail requires
 *          canonical mutual state, explicit pinning, or a shared-object rule."
 *   §3.3  HAPPENING NOW / STARTING SOON / TODAY / UPCOMING / ACTIVE TRIP /
 *          UNRESOLVED - WANT TO DO / PAST
 *   §3.4  `TelegraphSharedContextProjection` and `SharedContextItem`
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is not `services/passport/SharedContextService.ts`. That module answers a
 * different question for a different spec (Passport §17/§18: explainable facts
 * about a PROFILE PAIR, consumed by `routes/passport.ts`). This one answers
 * §3.4's question about a CONVERSATION, and its output is the four dated
 * arrays §3.4 names. Neither imports the other.
 *
 * ── HOW §3.2 IS ENFORCED, NOT MERELY UNVIOLATED ─────────────────────────────
 * The census rule for a prohibition is that it counts as built only when a
 * concrete artifact makes the violation unrepresentable or refuses it. Two
 * artifacts do that here:
 *
 *  1. `CANONICAL_MUTUALITY_SOURCES` is a closed list of five canonical tables.
 *     `messages` is not one of them, and `admitCandidate` REFUSES a candidate
 *     whose source is outside the list — a real refusal branch with a reason
 *     code, not an absence. TypeScript refuses the same value at compile time.
 *  2. This module performs no read of `messages` and imports nothing that
 *     does. `src/test/telegraphSharedContext.test.ts` pins that by reading
 *     this file's own source and failing if the string `"messages"` ever
 *     appears in a `.from(...)` position.
 *
 * A place someone merely posted in the thread therefore cannot enter the rail:
 * there is no code path that would carry it, and the one function that admits
 * items rejects it by name.
 *
 * ── AUTHORIZATION ───────────────────────────────────────────────────────────
 * Every resolver reads only rows where the VIEWER's own canonical membership
 * is currently active, and every candidate carries `viewerStillAuthorized`
 * that `admitCandidate` re-checks. That is §3.1's last bullet: a past trip the
 * viewer was removed from does not survive in the historical view.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type SharedRelationship,
  type TelegraphAction,
  type TelegraphObjectType,
} from "./vocabulary.js";

// ── §3.4 contract ────────────────────────────────────────────────────────────

/** §3.4 `SharedContextItem`, plus the ordering band §3.3 requires. */
export interface SharedContextItem {
  objectType: TelegraphObjectType;
  objectId: string;
  /** §3.4 `currentVersion?` — the source object's own version/updated marker. */
  currentVersion?: string;
  title: string;
  startsAt?: string;
  endsAt?: string;
  relationship: SharedRelationship;
  status: string;
  availableActions: TelegraphAction[];
  /** §3.3's band. Carried so the client can order without re-deriving time. */
  orderBand: SharedContextBand;
}

/** §3.4 `TelegraphSharedContextProjection`. */
export interface TelegraphSharedContextProjection {
  conversationId: string;
  generatedAt: string;
  now: SharedContextItem[];
  upcoming: SharedContextItem[];
  unresolved: SharedContextItem[];
  past: SharedContextItem[];
}

// ── §3.3 ordering ────────────────────────────────────────────────────────────

export type SharedContextBand =
  | "HAPPENING_NOW"
  | "STARTING_SOON"
  | "TODAY"
  | "UPCOMING"
  | "ACTIVE_TRIP"
  | "UNRESOLVED"
  | "PAST";

/** §3.3 verbatim, in order. Index in this array IS the sort rank. */
export const SHARED_CONTEXT_ORDER: readonly SharedContextBand[] = [
  "HAPPENING_NOW",
  "STARTING_SOON",
  "TODAY",
  "UPCOMING",
  "ACTIVE_TRIP",
  "UNRESOLVED",
  "PAST",
] as const;

export function bandRank(band: SharedContextBand): number {
  const i = SHARED_CONTEXT_ORDER.indexOf(band);
  return i === -1 ? SHARED_CONTEXT_ORDER.length : i;
}

/** "Starting soon" window: a plan inside this many minutes of its start. */
export const STARTING_SOON_MINUTES = 90;

function ms(v: string | null | undefined): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function sameUtcDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}

/**
 * §3.3's band for one object.
 *
 * A TRIP that spans `now` is ACTIVE_TRIP, not HAPPENING_NOW: §3.3 gives the
 * active trip its own band BELOW UPCOMING, so a plan starting in ten minutes
 * outranks the two-week trip it happens inside. An object with no dates at all
 * is UNRESOLVED — that is what "UNRESOLVED / WANT TO DO" means.
 */
export function classifyBand(
  input: {
    objectType: TelegraphObjectType;
    startsAt?: string | null;
    endsAt?: string | null;
  },
  nowMs: number,
): SharedContextBand {
  const start = ms(input.startsAt);
  const end = ms(input.endsAt);

  if (start === null && end === null) return "UNRESOLVED";

  const spansNow =
    (start === null || start <= nowMs) && (end === null ? start !== null && start <= nowMs : end >= nowMs);

  if (input.objectType === "TRIP" || input.objectType === "TRIP_STAGE") {
    if (spansNow) return "ACTIVE_TRIP";
    if (end !== null && end < nowMs) return "PAST";
    return "UPCOMING";
  }

  if (end !== null && end < nowMs) return "PAST";
  if (start !== null && end === null && start < nowMs - 6 * 3600_000) return "PAST";
  if (spansNow) return "HAPPENING_NOW";
  if (start === null) return "UNRESOLVED";
  if (start - nowMs <= STARTING_SOON_MINUTES * 60_000) return "STARTING_SOON";
  if (sameUtcDay(start, nowMs)) return "TODAY";
  return "UPCOMING";
}

/** Which of §3.4's four arrays a band lands in. */
export function arrayForBand(band: SharedContextBand): "now" | "upcoming" | "unresolved" | "past" {
  switch (band) {
    case "HAPPENING_NOW":
      return "now";
    case "UNRESOLVED":
      return "unresolved";
    case "PAST":
      return "past";
    default:
      return "upcoming";
  }
}

/** §3.3 ordering: band rank first, then the sooner start, then a stable id. */
export function compareItems(a: SharedContextItem, b: SharedContextItem): number {
  const r = bandRank(a.orderBand) - bandRank(b.orderBand);
  if (r !== 0) return r;
  const sa = ms(a.startsAt) ?? Number.MAX_SAFE_INTEGER;
  const sb = ms(b.startsAt) ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0;
}

// ── §3.2 admission ───────────────────────────────────────────────────────────

/**
 * The ONLY tables a mutuality claim may come from. `messages` is deliberately
 * absent and `admitCandidate` refuses anything not on this list.
 */
export const CANONICAL_MUTUALITY_SOURCES = [
  "trip_members",
  "meetup_invites",
  "event_attendees",
  "rent_buddy_bookings",
  "collection_items",
] as const;

export type CanonicalMutualitySource = (typeof CANONICAL_MUTUALITY_SOURCES)[number];

export interface SharedContextCandidate {
  objectType: TelegraphObjectType;
  objectId: string;
  title: string;
  status: string;
  currentVersion?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  relationship: SharedRelationship;
  /** Which canonical table proved mutuality. Not free text — see the list. */
  source: CanonicalMutualitySource;
  /** Thread participants other than the viewer who are also on the object. */
  counterpartIds: string[];
  /** The viewer's own canonical membership is active right now (§3.1 last bullet). */
  viewerStillAuthorized: boolean;
}

export type AdmissionRefusal =
  /** §3.2 — the claim came from something other than canonical mutual state. */
  | "non_canonical_source"
  /** §3 — "created or joined by BOTH sides"; nobody else in the thread is on it. */
  | "no_counterpart"
  /** §3.1 — the viewer is no longer authorized, so it may not appear even in PAST. */
  | "viewer_unauthorized"
  /** A row with no usable identity. */
  | "malformed";

export type Admission =
  | { admitted: true; item: SharedContextItem }
  | { admitted: false; refusal: AdmissionRefusal; objectId: string };

/**
 * The one gate every rail item passes through.
 *
 * This is where §3.2 is refused rather than merely not done: a candidate whose
 * `source` is not one of the five canonical tables is rejected with
 * `non_canonical_source`, whatever else is true about it.
 */
export function admitCandidate(c: SharedContextCandidate, nowMs: number): Admission {
  const objectId = typeof c?.objectId === "string" ? c.objectId : "";
  if (!objectId || typeof c.title !== "string" || c.title.length === 0) {
    return { admitted: false, refusal: "malformed", objectId };
  }
  if (!(CANONICAL_MUTUALITY_SOURCES as readonly string[]).includes(c.source)) {
    return { admitted: false, refusal: "non_canonical_source", objectId };
  }
  if (!Array.isArray(c.counterpartIds) || c.counterpartIds.length === 0) {
    return { admitted: false, refusal: "no_counterpart", objectId };
  }
  if (c.viewerStillAuthorized !== true) {
    return { admitted: false, refusal: "viewer_unauthorized", objectId };
  }

  const orderBand = classifyBand(
    { objectType: c.objectType, startsAt: c.startsAt, endsAt: c.endsAt },
    nowMs,
  );
  const item: SharedContextItem = {
    objectType: c.objectType,
    objectId,
    title: c.title,
    relationship: c.relationship,
    status: c.status,
    availableActions: availableActionsFor(c.objectType, orderBand),
    orderBand,
  };
  if (c.currentVersion) item.currentVersion = c.currentVersion;
  if (c.startsAt) item.startsAt = c.startsAt;
  if (c.endsAt) item.endsAt = c.endsAt;
  return { admitted: true, item };
}

/**
 * §3.4 `availableActions`, drawn from §8.1's fourteen native actions.
 *
 * A PAST object offers none: the rail is a historical view of it, not a
 * control surface, and offering JOIN_PLAN on last week's dinner is the kind of
 * thing §3.1's "only when still authorized" is guarding against.
 */
export function availableActionsFor(
  objectType: TelegraphObjectType,
  band: SharedContextBand,
): TelegraphAction[] {
  if (band === "PAST") return [];
  switch (objectType) {
    case "TRIP":
    case "TRIP_STAGE":
      return ["ADD_TO_TRIP", "CREATE_PLAN"];
    case "MEETUP":
    case "PLAN":
      return band === "HAPPENING_NOW"
        ? ["MEET_HERE", "SHARE_LOCATION", "CHECK_IN_SAFE", "RETURN_TO_GROUP"]
        : ["JOIN_PLAN", "LEAVE_PLAN", "VOTE", "MEET_HERE"];
    case "EVENT":
      return band === "HAPPENING_NOW"
        ? ["MEET_HERE", "CHECK_IN_SAFE", "RETURN_TO_GROUP"]
        : ["JOIN_PLAN", "LEAVE_PLAN", "MEET_HERE"];
    case "BOOKING":
      return band === "HAPPENING_NOW"
        ? ["CHECK_IN_SAFE", "SHARE_LOCATION", "MEET_HERE"]
        : ["MEET_HERE", "SHARE_LOCATION"];
    case "WANT_TO_DO":
    case "PLACE":
    case "HIDDEN_GEM":
      return ["CREATE_PLAN", "ADD_TO_TRIP", "SHARE_PLACE", "DO_THIS_NOW"];
    default:
      return [];
  }
}

// ── resolvers ────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

/** A read that failed is reported, never silently treated as "no shared context". */
export interface ResolverProblem {
  resolver: string;
  message: string;
}

interface ResolveResult {
  candidates: SharedContextCandidate[];
  problems: ResolverProblem[];
}

function relationshipFor(
  creatorId: string | null | undefined,
  viewerId: string,
  counterpartIds: string[],
): SharedRelationship {
  if (creatorId && creatorId === viewerId) return "CREATED_BY_ME_JOINED_BY_THEM";
  if (creatorId && counterpartIds.includes(creatorId)) return "CREATED_BY_THEM_JOINED_BY_ME";
  return "BOTH_PARTICIPANTS";
}

/** §3.1 clause 3 — both members of the same Trip. */
export async function resolveSharedTrips(
  client: SupabaseClient,
  viewerId: string,
  participantIds: string[],
): Promise<ResolveResult> {
  const problems: ResolverProblem[] = [];
  const { data, error } = await client
    .from("trip_members")
    .select("trip_id, user_id, status")
    .in("user_id", participantIds)
    .eq("status", "accepted");
  if (error) {
    problems.push({ resolver: "trips", message: error.message ?? "trip_members read failed" });
    return { candidates: [], problems };
  }
  const byTrip = new Map<string, Set<string>>();
  for (const r of (data ?? []) as Row[]) {
    const tid = r.trip_id as string;
    if (!tid) continue;
    if (!byTrip.has(tid)) byTrip.set(tid, new Set());
    byTrip.get(tid)!.add(r.user_id as string);
  }
  const tripIds = [...byTrip.keys()].filter((t) => byTrip.get(t)!.has(viewerId) && byTrip.get(t)!.size > 1);
  if (tripIds.length === 0) return { candidates: [], problems };

  const { data: trips, error: tripErr } = await client
    .from("trips")
    .select("id, owner_id, title, start_date, end_date, status, updated_at")
    .in("id", tripIds);
  if (tripErr) {
    problems.push({ resolver: "trips", message: tripErr.message ?? "trips read failed" });
    return { candidates: [], problems };
  }
  const candidates: SharedContextCandidate[] = [];
  for (const t of (trips ?? []) as Row[]) {
    const members = byTrip.get(t.id as string) ?? new Set<string>();
    const counterpartIds = [...members].filter((m) => m !== viewerId);
    candidates.push({
      objectType: "TRIP",
      objectId: t.id as string,
      title: (t.title as string) ?? "Trip",
      status: (t.status as string) ?? "planning",
      currentVersion: (t.updated_at as string) ?? undefined,
      startsAt: dateOnlyToInstant(t.start_date as string | null, "start"),
      endsAt: dateOnlyToInstant(t.end_date as string | null, "end"),
      relationship: relationshipFor(t.owner_id as string, viewerId, counterpartIds),
      source: "trip_members",
      counterpartIds,
      viewerStillAuthorized: members.has(viewerId),
    });
  }
  return { candidates, problems };
}

/** A `date` column is a whole day; give it an instant at that day's edge. */
function dateOnlyToInstant(d: string | null | undefined, edge: "start" | "end"): string | null {
  if (typeof d !== "string" || d.length < 10) return null;
  return edge === "start" ? `${d.slice(0, 10)}T00:00:00.000Z` : `${d.slice(0, 10)}T23:59:59.999Z`;
}

/** §3.1 clauses 1-3 — a meetup created or joined by both. */
export async function resolveSharedMeetups(
  client: SupabaseClient,
  viewerId: string,
  participantIds: string[],
): Promise<ResolveResult> {
  const problems: ResolverProblem[] = [];
  const { data, error } = await client
    .from("meetup_invites")
    .select("meetup_id, user_id, status")
    .in("user_id", participantIds)
    .in("status", ["going", "maybe", "pending"]);
  if (error) {
    problems.push({ resolver: "meetups", message: error.message ?? "meetup_invites read failed" });
    return { candidates: [], problems };
  }
  const byMeetup = new Map<string, Set<string>>();
  const viewerStatus = new Map<string, string>();
  for (const r of (data ?? []) as Row[]) {
    const mid = r.meetup_id as string;
    if (!mid) continue;
    if (!byMeetup.has(mid)) byMeetup.set(mid, new Set());
    byMeetup.get(mid)!.add(r.user_id as string);
    if (r.user_id === viewerId) viewerStatus.set(mid, (r.status as string) ?? "pending");
  }
  const ids = [...byMeetup.keys()];
  if (ids.length === 0) return { candidates: [], problems };

  const { data: meetups, error: mErr } = await client
    .from("meetups")
    .select("id, creator_id, title, starts_at, ends_at, status, updated_at")
    .in("id", ids);
  if (mErr) {
    problems.push({ resolver: "meetups", message: mErr.message ?? "meetups read failed" });
    return { candidates: [], problems };
  }
  const candidates: SharedContextCandidate[] = [];
  for (const m of (meetups ?? []) as Row[]) {
    const attending = new Set(byMeetup.get(m.id as string) ?? []);
    // The creator is a participant even without an invite row of their own.
    if (typeof m.creator_id === "string" && participantIds.includes(m.creator_id)) {
      attending.add(m.creator_id);
    }
    const counterpartIds = [...attending].filter((u) => u !== viewerId);
    const viewerOnIt = attending.has(viewerId);
    candidates.push({
      objectType: "MEETUP",
      objectId: m.id as string,
      title: (m.title as string) ?? "Meetup",
      status: viewerOnIt ? (viewerStatus.get(m.id as string) ?? (m.status as string) ?? "active") : ((m.status as string) ?? "active"),
      currentVersion: (m.updated_at as string) ?? undefined,
      startsAt: (m.starts_at as string) ?? null,
      endsAt: (m.ends_at as string) ?? null,
      relationship: relationshipFor(m.creator_id as string, viewerId, counterpartIds),
      source: "meetup_invites",
      counterpartIds,
      viewerStillAuthorized: viewerOnIt,
    });
  }
  return { candidates, problems };
}

/** §3.1 clause 3 — an Event both are attending. */
export async function resolveSharedEvents(
  client: SupabaseClient,
  viewerId: string,
  participantIds: string[],
): Promise<ResolveResult> {
  const problems: ResolverProblem[] = [];
  const { data, error } = await client
    .from("event_attendees")
    .select("event_id, user_id")
    .in("user_id", participantIds);
  if (error) {
    problems.push({ resolver: "events", message: error.message ?? "event_attendees read failed" });
    return { candidates: [], problems };
  }
  const byEvent = new Map<string, Set<string>>();
  for (const r of (data ?? []) as Row[]) {
    const eid = r.event_id as string;
    if (!eid) continue;
    if (!byEvent.has(eid)) byEvent.set(eid, new Set());
    byEvent.get(eid)!.add(r.user_id as string);
  }
  const ids = [...byEvent.keys()].filter((e) => byEvent.get(e)!.has(viewerId) && byEvent.get(e)!.size > 1);
  if (ids.length === 0) return { candidates: [], problems };

  const { data: events, error: eErr } = await client
    .from("events")
    .select("id, host_id, title, starts_at, ends_at, state, updated_at")
    .in("id", ids);
  if (eErr) {
    problems.push({ resolver: "events", message: eErr.message ?? "events read failed" });
    return { candidates: [], problems };
  }
  const candidates: SharedContextCandidate[] = [];
  for (const e of (events ?? []) as Row[]) {
    const attending = byEvent.get(e.id as string) ?? new Set<string>();
    const counterpartIds = [...attending].filter((u) => u !== viewerId);
    candidates.push({
      objectType: "EVENT",
      objectId: e.id as string,
      title: (e.title as string) ?? "Event",
      status: (e.state as string) ?? "published",
      currentVersion: (e.updated_at as string) ?? undefined,
      startsAt: (e.starts_at as string) ?? null,
      endsAt: (e.ends_at as string) ?? null,
      relationship: relationshipFor(e.host_id as string, viewerId, counterpartIds),
      source: "event_attendees",
      counterpartIds,
      viewerStillAuthorized: attending.has(viewerId),
    });
  }
  return { candidates, problems };
}

/** §3.1 clause 3 — "the same ... booking". */
export async function resolveSharedBookings(
  client: SupabaseClient,
  viewerId: string,
  participantIds: string[],
): Promise<ResolveResult> {
  const problems: ResolverProblem[] = [];
  const { data, error } = await client
    .from("rent_buddy_bookings")
    .select("id, buddy_id, traveler_id, booking_date, city, category, status, updated_at")
    .in("traveler_id", participantIds);
  if (error) {
    problems.push({ resolver: "bookings", message: error.message ?? "rent_buddy_bookings read failed" });
    return { candidates: [], problems };
  }
  const candidates: SharedContextCandidate[] = [];
  for (const b of (data ?? []) as Row[]) {
    const pair = [b.buddy_id as string, b.traveler_id as string].filter(Boolean);
    if (!pair.includes(viewerId)) continue;
    const counterpartIds = pair.filter((u) => u !== viewerId && participantIds.includes(u));
    candidates.push({
      objectType: "BOOKING",
      objectId: b.id as string,
      title: `${(b.category as string) ?? "Buddy"} in ${(b.city as string) ?? "town"}`,
      status: (b.status as string) ?? "pending",
      currentVersion: (b.updated_at as string) ?? undefined,
      startsAt: dateOnlyToInstant(b.booking_date as string | null, "start"),
      endsAt: dateOnlyToInstant(b.booking_date as string | null, "end"),
      relationship: "BOTH_PARTICIPANTS",
      source: "rent_buddy_bookings",
      counterpartIds,
      viewerStillAuthorized: pair.includes(viewerId),
    });
  }
  return { candidates, problems };
}

/**
 * §3.1 clause 4 — "Both deliberately promoted an item into a shared wishlist
 * or Want-to-Do state."
 *
 * The canonical promotion primitive in this tree is `collection_items`: a row
 * exists only because a user pressed Save on that object. Two independent
 * saves of the same object by two people in the conversation is exactly the
 * "both deliberately promoted" clause, and it is canonical state — nothing
 * here reads a message.
 */
export async function resolveSharedWantToDo(
  client: SupabaseClient,
  viewerId: string,
  participantIds: string[],
): Promise<ResolveResult> {
  const problems: ResolverProblem[] = [];
  const { data: cols, error: cErr } = await client
    .from("collections")
    .select("id, owner_id")
    .in("owner_id", participantIds);
  if (cErr) {
    problems.push({ resolver: "want_to_do", message: cErr.message ?? "collections read failed" });
    return { candidates: [], problems };
  }
  const ownerOf = new Map<string, string>();
  for (const c of (cols ?? []) as Row[]) ownerOf.set(c.id as string, c.owner_id as string);
  const collectionIds = [...ownerOf.keys()];
  if (collectionIds.length === 0) return { candidates: [], problems };

  const { data: items, error: iErr } = await client
    .from("collection_items")
    .select("collection_id, entity_type, entity_id, saved_at")
    .in("collection_id", collectionIds);
  if (iErr) {
    problems.push({ resolver: "want_to_do", message: iErr.message ?? "collection_items read failed" });
    return { candidates: [], problems };
  }
  const byEntity = new Map<string, { type: string; id: string; savers: Set<string>; latest: string | null }>();
  for (const it of (items ?? []) as Row[]) {
    const owner = ownerOf.get(it.collection_id as string);
    if (!owner) continue;
    const key = `${it.entity_type}:${it.entity_id}`;
    if (!byEntity.has(key)) {
      byEntity.set(key, {
        type: (it.entity_type as string) ?? "place",
        id: it.entity_id as string,
        savers: new Set(),
        latest: (it.saved_at as string) ?? null,
      });
    }
    const e = byEntity.get(key)!;
    e.savers.add(owner);
    if (typeof it.saved_at === "string" && (!e.latest || it.saved_at > e.latest)) e.latest = it.saved_at;
  }
  const candidates: SharedContextCandidate[] = [];
  for (const e of byEntity.values()) {
    if (!e.savers.has(viewerId) || e.savers.size < 2) continue;
    candidates.push({
      objectType: "WANT_TO_DO",
      objectId: e.id,
      title: `Saved by both — ${e.type}`,
      status: "want_to_do",
      currentVersion: e.latest ?? undefined,
      startsAt: null,
      endsAt: null,
      relationship: "BOTH_PROMOTED",
      source: "collection_items",
      counterpartIds: [...e.savers].filter((u) => u !== viewerId),
      viewerStillAuthorized: true,
    });
  }
  return { candidates, problems };
}

// ── the projection ───────────────────────────────────────────────────────────

export interface SharedContextResult {
  projection: TelegraphSharedContextProjection;
  /** Every candidate the §3.2 gate turned away, with the reason. */
  refusals: Array<{ objectId: string; refusal: AdmissionRefusal }>;
  /** Reads that failed. A non-empty list means the rail is INCOMPLETE, not empty. */
  problems: ResolverProblem[];
}

/**
 * Build §3.4's projection for one conversation.
 *
 * `participantIds` must be the thread's currently-active members, viewer
 * included; the caller (the route) is the only thing that knows how to read
 * membership, and passing it in keeps this module free of any thread read.
 */
export async function buildSharedContextProjection(
  client: SupabaseClient,
  opts: {
    conversationId: string;
    viewerId: string;
    participantIds: string[];
    now?: Date;
  },
): Promise<SharedContextResult> {
  const nowDate = opts.now ?? new Date();
  const nowMs = nowDate.getTime();
  const participantIds = [...new Set(opts.participantIds)].filter((p) => typeof p === "string" && p.length > 0);

  const results = await Promise.all([
    resolveSharedTrips(client, opts.viewerId, participantIds),
    resolveSharedMeetups(client, opts.viewerId, participantIds),
    resolveSharedEvents(client, opts.viewerId, participantIds),
    resolveSharedBookings(client, opts.viewerId, participantIds),
    resolveSharedWantToDo(client, opts.viewerId, participantIds),
  ]);

  const problems = results.flatMap((r) => r.problems);
  const refusals: Array<{ objectId: string; refusal: AdmissionRefusal }> = [];
  const buckets: Record<"now" | "upcoming" | "unresolved" | "past", SharedContextItem[]> = {
    now: [],
    upcoming: [],
    unresolved: [],
    past: [],
  };

  for (const r of results) {
    for (const c of r.candidates) {
      const admission = admitCandidate(c, nowMs);
      if (!admission.admitted) {
        refusals.push({ objectId: admission.objectId, refusal: admission.refusal });
        continue;
      }
      buckets[arrayForBand(admission.item.orderBand)].push(admission.item);
    }
  }

  for (const k of Object.keys(buckets) as Array<keyof typeof buckets>) {
    buckets[k].sort(compareItems);
  }

  return {
    projection: {
      conversationId: opts.conversationId,
      generatedAt: nowDate.toISOString(),
      now: buckets.now,
      upcoming: buckets.upcoming,
      unresolved: buckets.unresolved,
      past: buckets.past,
    },
    refusals,
    problems,
  };
}

/**
 * §11.2's condition table, decided on the server so the rail cannot disagree
 * with the projection it is rendering.
 *
 *   Active plan       -> expanded "NOW" card at top
 *   Upcoming only     -> compact horizontal cards
 *   No active/upcoming-> collapsed summary ("3 shared plans - 1 past trip")
 */
export type RailMode = "EXPANDED_NOW" | "COMPACT_UPCOMING" | "COLLAPSED_SUMMARY" | "EMPTY";

export function railModeFor(p: TelegraphSharedContextProjection): RailMode {
  if (p.now.length > 0) return "EXPANDED_NOW";
  if (p.upcoming.length > 0) return "COMPACT_UPCOMING";
  if (p.unresolved.length > 0 || p.past.length > 0) return "COLLAPSED_SUMMARY";
  return "EMPTY";
}

/** §11.2's collapsed summary text, e.g. "3 shared plans · 1 past trip". */
export function collapsedSummary(p: TelegraphSharedContextProjection): string {
  const plans = p.unresolved.length + p.upcoming.length + p.now.length;
  const pastTrips = p.past.filter((i) => i.objectType === "TRIP").length;
  const pastOther = p.past.length - pastTrips;
  const parts: string[] = [];
  if (plans > 0) parts.push(`${plans} shared plan${plans === 1 ? "" : "s"}`);
  if (pastTrips > 0) parts.push(`${pastTrips} past trip${pastTrips === 1 ? "" : "s"}`);
  if (pastOther > 0) parts.push(`${pastOther} past item${pastOther === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
