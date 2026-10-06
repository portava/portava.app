/**
 * MemoryActionService — §14 "Executable Memories", the service §2 names and
 * §27 gives three methods: `compileDoAgain(memoryId, currentContext)`,
 * `addToTrip(memoryId, tripId)` and `buildNavigationTarget(memoryId)`.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §2   "MemoryActionService — Compile 'Do Again', 'Add to Trip', 'Take Me
 *         Back', and related actions into current plans."
 *   §14  "Historical Memory + current world intelligence + current user context
 *         + Temporal Freedom Engine -> executable current plan", the eight
 *         actions, and the invariant: "'You visited X in 2026' is a historical
 *         claim. 'X is open tonight' requires fresh world data. Never derive the
 *         latter from the former."
 *   §28.9 "Never treat historical operational state as current intelligence."
 *   Appendix A step 13: "'Do this again' calls current place/transport/
 *         availability systems before creating a new plan."
 *
 * CENSUS: H16 (MemoryActionService), H107 (Do Again through current-world /
 *         Temporal-Freedom engines), H108 (the eight actions) and H259 (Phase 5)
 *         were all NOT-BUILT: "a repository-wide grep for doAgain, takeMeBack …
 *         returns nothing". `services/memory/historicalTruth.ts` built §14's
 *         invariant (H109) and said, in its own header, that the executable
 *         half did not exist. This module is that half.
 *
 * ── THE ONE RULE, MECHANICALLY ───────────────────────────────────────────────
 * Nothing in a compiled action comes from the Memory row except WHICH place it
 * was and WHEN. Every operational fact an action carries — the place's identity
 * NOW (a merged place is followed to its successor), whether it is still open
 * for business (`places.status`), whether it is open right now (a live source,
 * or an honest "unknown"), the traveller's current trips, and the free time on
 * them (the Trips Temporal Freedom Engine) — is read at compile time from the
 * system that owns it. The Memory's own coordinate is used for exactly one
 * thing, Take Me Back for the OWNER when the catalog knows no place, and the
 * target then says it is historical.
 *
 * ── WHAT IS NOT BUILT, SAID BEFORE THE CODE ──────────────────────────────────
 * Three of §14's eight are declared and refused by name rather than faked:
 *   BOOK_AGAIN          no booking provider is integrated for places, so no
 *                       provider is "currently eligible" — `NO_ELIGIBLE_PROVIDER`.
 *   NEW_TRIP_WITH_CREW  trip creation (app/trip/new.tsx, POST /trips — the Trips
 *                       lane) takes no invitees, so there is nothing to hand
 *                       a prior crew to — `CONSUMER_UNAVAILABLE`.
 *   USE_AS_INSPIRATION  needs a Discovery seed that preserves novelty
 *                       preferences (the Discovery lane) — `CONSUMER_UNAVAILABLE`.
 *
 * ── WRITES ───────────────────────────────────────────────────────────────────
 * NONE. Every function here is a compile: it reads and decides. Add to Trip
 * compiles the CURRENT place into the payload the trip's own write path takes
 * (`POST /trips/:tripId/saved-places`, census-trips TR350's architecture write
 * path for `trip_saved_places`), and the client sends it there. A second
 * direct writer of a Trips table from the Memory domain would be the coupling
 * §2 warns about and a new entry in check:trip-write-path-inventory.
 *
 * ── FAILED READS ─────────────────────────────────────────────────────────────
 * supabase-js RESOLVES `{ data, error }`. Every read below binds `.error`, and
 * an unreadable table is its own state (`unreadable`) — never "no place", "no
 * trips" or "no saves". The menu reports it per action; a compile refuses.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { getLiveVenueStatus, type LiveVenueStatus } from "../../lib/liveIntelligence.js";
import {
  gemCeilingForItem,
  loadRestrictiveGems,
  type LocationVisibilityTier,
} from "../../lib/mediaLocationVisibility.js";
import { publicationPrecision } from "../../lib/memoryLocationPrecision.js";
import {
  asHistoricalFact,
  currentWorldReading,
  currentWorldUnknown,
  fuseHistoricalWithCurrent,
  type CurrentWorldReading,
  type FusedAnswer,
} from "./historicalTruth.js";
import { readTripWindows, type TripWindowsRead } from "../../domain/trips/services/TripFreedomConsumers.js";
import { readMemoryPrecisionGate, precisionColumnSelectable, type MemoryPrecisionGate } from "../../lib/memoryPrecisionGate.js";
import { resolveMemoryPlaceRef } from "../../lib/placeIdBridge.js";
import { canReadMemory, isBlocked } from "./memoryReadPolicy.js";

const log = rootLogger.child({ mod: "memoryActionService" });

export const MEMORY_ACTION_ENGINE_VERSION = "memory-actions@1";

/** §14's eight, in the spec's order, plus §12's VIEW_PLACE. */
export const MEMORY_ACTIONS = [
  "DO_AGAIN",
  "TAKE_ME_BACK",
  "ADD_TO_TRIP",
  "SAVE_EXPERIENCE",
  "BOOK_AGAIN",
  "NEW_TRIP_WITH_CREW",
  "BRING_FORWARD_SAVED",
  "USE_AS_INSPIRATION",
  "VIEW_PLACE",
] as const;
export type MemoryAction = (typeof MEMORY_ACTIONS)[number];

export function isMemoryAction(v: unknown): v is MemoryAction {
  return typeof v === "string" && (MEMORY_ACTIONS as readonly string[]).includes(v);
}

/** The actions a compile endpoint can run. The rest are menu-only. */
export const COMPILABLE_ACTIONS = ["DO_AGAIN", "TAKE_ME_BACK", "ADD_TO_TRIP", "BRING_FORWARD_SAVED"] as const;
export type CompilableAction = (typeof COMPILABLE_ACTIONS)[number];
export function isCompilableAction(v: unknown): v is CompilableAction {
  return typeof v === "string" && (COMPILABLE_ACTIONS as readonly string[]).includes(v);
}

/** Why an action is not offered. A closed set, so a client can say each one. */
export const ACTION_UNAVAILABLE_REASONS = [
  "NO_PLACE_REFERENCE",
  "PLACE_NOT_IN_CATALOG",
  "PLACE_CLOSED",
  "PLACE_UNREADABLE",
  "PLACE_AMBIGUOUS",
  "PLACE_WITHHELD_BY_OWNER",
  "PLACE_PROTECTED",
  "PRIVACY_UNREADABLE",
  "NO_COORDINATES",
  "OWNER_ONLY",
  "OWN_MEMORY",
  "NO_PRIOR_TRIP",
  "NO_ELIGIBLE_PROVIDER",
  "CONSUMER_UNAVAILABLE",
] as const;
export type ActionUnavailableReason = (typeof ACTION_UNAVAILABLE_REASONS)[number];

export const ACTION_UNAVAILABLE_MESSAGE: Readonly<Record<ActionUnavailableReason, string>> = Object.freeze({
  NO_PLACE_REFERENCE: "This Memory does not name a place.",
  PLACE_NOT_IN_CATALOG: "This Memory's place is not in Portava's place catalog, so its current state cannot be checked.",
  PLACE_CLOSED: "This place has closed.",
  PLACE_UNREADABLE: "This place's current state could not be checked right now. Please try again.",
  PLACE_AMBIGUOUS: "More than one place in Portava's catalog matches this Memory's location, so Portava cannot say which one it was.",
  // Three different facts, three sentences (verifier finding 5). The first is a
  // statement about the OWNER and is only ever said when it is the owner's rung.
  PLACE_WITHHELD_BY_OWNER: "The owner shares this Memory's location at a coarser level than the place itself.",
  PLACE_PROTECTED: "This place is protected, so Portava does not name it here.",
  // Not a refusal: nobody decided anything. The client shows it as could-not-check with Try again.
  PRIVACY_UNREADABLE: "Whether this place can be shown could not be checked right now. Please try again.",
  NO_COORDINATES: "There is no location to navigate to.",
  OWNER_ONLY: "Only the person who made this Memory can do this.",
  OWN_MEMORY: "This is your own Memory.",
  NO_PRIOR_TRIP: "This Memory is not part of a trip.",
  NO_ELIGIBLE_PROVIDER: "No booking provider is currently available for this place.",
  CONSUMER_UNAVAILABLE: "This is not available in the app yet.",
});

/**
 * The three of §14's eight that are declared and refused by name — see the
 * header. One map, read by the menu AND the compile route, so the two cannot
 * give different reasons for the same action.
 */
export const DECLARED_UNBUILT: Readonly<Partial<Record<MemoryAction, ActionUnavailableReason>>> = Object.freeze({
  BOOK_AGAIN: "NO_ELIGIBLE_PROVIDER",
  NEW_TRIP_WITH_CREW: "CONSUMER_UNAVAILABLE",
  USE_AS_INSPIRATION: "CONSUMER_UNAVAILABLE",
});

/* ============================================================================
 * Inputs
 * ==========================================================================*/

/** The Memory columns an action reads. `location_precision` only when the gate is on. */
export const MEMORY_ACTION_COLUMNS =
  "id, owner_id, title, visibility, allowed_user_ids, hidden_user_ids, trip_id, place_id, canonical_location_id, location_city, location_country, location_lat, location_lng, starts_at, ends_at, state, created_at";
export const MEMORY_ACTION_COLUMNS_WITH_PRECISION = `${MEMORY_ACTION_COLUMNS}, location_precision`;

export interface MemoryForAction {
  id: string;
  owner_id: string;
  title: string | null;
  trip_id: string | null;
  place_id: string | null;
  canonical_location_id: string | null;
  location_city: string | null;
  location_country: string | null;
  location_lat: number | string | null;
  location_lng: number | string | null;
  starts_at: string | null;
  ends_at: string | null;
  state: string;
  created_at: string;
  location_precision?: unknown;
}

/**
 * Read a Memory and decide whether THIS viewer may act on it — the same §23
 * ladder GET /memories/:id uses (`canReadMemory(..., "single")`) plus the
 * bidirectional block check, both fail-closed. Three answers, never two: a
 * Memory that could not be READ is `unreadable`, not `not_found`.
 */
export type ViewerMemory =
  | { state: "ok"; memory: MemoryForAction; precisionGate: MemoryPrecisionGate }
  | { state: "not_found" }
  /** Only ever returned to the Memory's OWNER: theirs, and deleted. Anyone else gets `not_found`. */
  | { state: "deleted_own" }
  | { state: "unreadable" };

export async function loadMemoryForViewer(sc: SupabaseClient, memoryId: string, viewerId: string): Promise<ViewerMemory> {
  // §10 gate, three states: an unreadable gate selects no rung and CLAMPS
  // (lib/memoryPrecisionGate.ts) — it never reads as "off" (verifier finding 7).
  const precisionGate = await readMemoryPrecisionGate(sc);
  const { data, error } = await sc
    .from("memories")
    .select(precisionColumnSelectable(precisionGate) ? MEMORY_ACTION_COLUMNS_WITH_PRECISION : MEMORY_ACTION_COLUMNS)
    .eq("id", memoryId)
    .maybeSingle();
  if (error) {
    log.error({ err: error, memoryId }, "memory actions: memory read failed — unreadable, not absent");
    return { state: "unreadable" };
  }
  const read = data as MemoryForAction | null;
  // A deleted Memory is gone for everyone; only its owner is TOLD it was deleted.
  if (read && read.state === "deleted") return read.owner_id === viewerId ? { state: "deleted_own" } : { state: "not_found" };
  const memory = read;
  if (!memory) return { state: "not_found" };
  if (memory.owner_id !== viewerId) {
    if (await isBlocked(sc, viewerId, memory.owner_id)) return { state: "not_found" };
    if (!(await canReadMemory(sc, memory, viewerId, "single"))) return { state: "not_found" };
  }
  return { state: "ok", memory, precisionGate };
}

/** `places` as an action reads it. Every field is a CURRENT catalog fact. */
export const PLACE_ACTION_COLUMNS =
  "id, name, primary_category, latitude, longitude, address, city, country_code, status, merged_into_place_id";

interface PlaceRow {
  id: string;
  name: string;
  primary_category: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  city: string | null;
  country_code: string | null;
  status: string;
  merged_into_place_id: string | null;
}

/** The current place, as a client may be shown it. */
export interface CurrentPlace {
  id: string;
  name: string;
  category: string;
  address: string | null;
  city: string | null;
  countryCode: string | null;
  lat: number | null;
  lng: number | null;
  /** `places.status` at compile time. */
  status: string;
}

export type CatalogCaution = "TEMPORARILY_CLOSED" | "MOVED" | "UNVERIFIED";

export type PlaceResolution =
  | {
      state: "resolved";
      place: CurrentPlace;
      /** Ids followed through `merged_into_place_id`, oldest first. Empty when none. */
      followedMerges: string[];
      caution: CatalogCaution | null;
    }
  | { state: "closed"; place: CurrentPlace; followedMerges: string[] }
  | { state: "unresolved"; reason: "NO_PLACE_REFERENCE" | "PLACE_NOT_IN_CATALOG" | "PLACE_AMBIGUOUS" | "PLACE_UNREADABLE" }
  | { state: "unreadable"; table: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MERGE_HOPS = 3;

function toCurrentPlace(r: PlaceRow): CurrentPlace {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    category: String(r.primary_category ?? "other"),
    address: r.address ?? null,
    city: r.city ?? null,
    countryCode: r.country_code ?? null,
    lat: num(r.latitude),
    lng: num(r.longitude),
    status: String(r.status ?? "unverified"),
  };
}

/* ============================================================================
 * Seams. Production uses the real live source and the real Temporal Freedom
 * Engine; a test replaces them so the compile is deterministic.
 * ==========================================================================*/

export interface MemoryActionDeps {
  liveStatus(name: string, city: string | null): Promise<LiveVenueStatus | null>;
  tripWindows(sc: SupabaseClient, tripId: string, viewerId: string, now: Date): Promise<TripWindowsRead>;
  restrictiveGemCeiling(sc: SupabaseClient, place: CurrentPlace): Promise<{ determined: true; ceiling: LocationVisibilityTier | null } | { determined: false }>;
}

const REAL_DEPS: MemoryActionDeps = {
  liveStatus: (name, city) => getLiveVenueStatus(name, city),
  tripWindows: (sc, tripId, viewerId, now) => readTripWindows(sc, tripId, viewerId, { now }),
  restrictiveGemCeiling: async (sc, place) => {
    try {
      const gems = await loadRestrictiveGems(sc, { placeIds: [place.id], cities: [place.city] });
      return { determined: true, ceiling: gemCeilingForItem(gems, { placeId: place.id, lat: place.lat, lng: place.lng }) };
    } catch (err) {
      log.error({ err, placeId: place.id }, "memory actions: hidden-gem read failed — the venue is withheld from non-owners");
      return { determined: false };
    }
  },
};

let deps: MemoryActionDeps = REAL_DEPS;
/** TEST ONLY. `null` restores the real live source, freedom engine and gem read. */
export function _setMemoryActionDeps(d: Partial<MemoryActionDeps> | null): void {
  deps = d ? { ...REAL_DEPS, ...d } : REAL_DEPS;
}

/* ============================================================================
 * The current place
 * ==========================================================================*/

/**
 * Follow `merged_into_place_id` to the row that exists now — bounded and
 * cycle-safe. ONE implementation, used by Do Again's resolver AND by Bring
 * Forward (which ignored merges until verifier finding 8). A successor that
 * cannot be read is unknown, not "no successor".
 */
export async function followMergeChain(sc: SupabaseClient, start: PlaceRow): Promise<{ ok: true; row: PlaceRow; followed: string[] } | { ok: false }> {
  let row = start;
  const followed: string[] = [];
  const seen = new Set<string>([String(row.id)]);
  while (row.merged_into_place_id && followed.length < MAX_MERGE_HOPS) {
    const next = String(row.merged_into_place_id);
    if (seen.has(next)) break;
    const { data, error } = await sc.from("places").select(PLACE_ACTION_COLUMNS).eq("id", next).maybeSingle();
    if (error) {
      log.error({ err: error, from: row.id, to: next }, "memory actions: merged-place successor read failed");
      return { ok: false };
    }
    if (!data) break;
    followed.push(String(row.id));
    seen.add(next);
    row = data as PlaceRow;
  }
  return { ok: true, row, followed };
}

/**
 * Resolve a Memory's place against the catalog AS IT IS NOW.
 *
 * `place_id` is the reference the client chose at capture; when it is a catalog
 * uuid it is read directly. Otherwise `canonical_location_id` is matched to the
 * catalog row that resolved to the same canonical location. A merged place is
 * followed to its successor (bounded, cycle-safe): the Memory remembers the old
 * row, the action is about the place that exists now.
 */
export async function resolveCurrentPlace(
  sc: SupabaseClient,
  ref: { place_id: string | null; canonical_location_id: string | null },
): Promise<PlaceResolution> {
  // The id-space crossing is the sanctioned bridge's, not this module's
  // (lib/placeIdBridge.ts resolveMemoryPlaceRef): the Memory's own catalog
  // row when it named one, else the ONE row sharing its canonical location —
  // and, when several do, a stated refusal instead of a guess (finding 6).
  const ref1 = await resolveMemoryPlaceRef<PlaceRow>(sc, ref);
  if (ref1.state === "unreadable") {
    log.error({ placeId: ref.place_id, canonicalLocationId: ref.canonical_location_id }, "memory actions: places read failed — the current place is unknown, not absent");
    return { state: "unreadable", table: "places" };
  }
  if (ref1.state === "ambiguous") return { state: "unresolved", reason: "PLACE_AMBIGUOUS" };
  if (ref1.state === "none") return { state: "unresolved", reason: ref1.named ? "PLACE_NOT_IN_CATALOG" : "NO_PLACE_REFERENCE" };
  let row: PlaceRow = ref1.row;
  const chain = await followMergeChain(sc, row);
  if (!chain.ok) return { state: "unresolved", reason: "PLACE_UNREADABLE" };
  row = chain.row;
  const followed = chain.followed;
  const place = toCurrentPlace(row);
  if (place.status === "closed") return { state: "closed", place, followedMerges: followed };
  // A duplicate the catalog never pointed at a successor is not a place to go.
  if (place.status === "duplicate") return { state: "unresolved", reason: "PLACE_NOT_IN_CATALOG" };
  const caution: CatalogCaution | null =
    place.status === "temporarily_closed" ? "TEMPORARILY_CLOSED"
      : place.status === "moved" ? "MOVED"
        : place.status === "unverified" ? "UNVERIFIED"
          : null;
  return { state: "resolved", place, followedMerges: followed, caution };
}

/* ============================================================================
 * Who may see the venue
 * ==========================================================================*/

/**
 * May THIS viewer be handed the venue a Memory points at?
 *
 * The owner always may: it is their own history. Anybody else may only when
 * the owner's §10 precision lets the venue through ('exact' or 'venue') AND no
 * protected Hidden Gem constrains that place below place level. A gem read that
 * fails withholds — the same fail-closed rule `resolveMediaLocationWithGemProtection`
 * applies — because naming a protected venue is the disclosure the gem exists
 * to prevent, and an action button is a disclosure.
 */
export type VenueDisclosure =
  | { ok: true }
  | { ok: false; reason: "PLACE_WITHHELD_BY_OWNER" | "PLACE_PROTECTED" | "PRIVACY_UNREADABLE" };

export async function mayDiscloseVenue(
  sc: SupabaseClient,
  memory: MemoryForAction,
  viewerId: string,
  place: CurrentPlace,
  precisionGate: MemoryPrecisionGate,
): Promise<VenueDisclosure> {
  if (viewerId === memory.owner_id) return { ok: true };
  // An unreadable gate is not "the owner chose a coarse rung": nobody knows.
  // It is a could-not-check, never presented as a refusal (finding 5).
  if (precisionGate === "unreadable") return { ok: false, reason: "PRIVACY_UNREADABLE" };
  const rung = publicationPrecision(memory, precisionGate === "on");
  if (rung !== "exact" && rung !== "venue") return { ok: false, reason: "PLACE_WITHHELD_BY_OWNER" };
  const gem = await deps.restrictiveGemCeiling(sc, place);
  if (!gem.determined) return { ok: false, reason: "PRIVACY_UNREADABLE" };
  const venueLevel = gem.ceiling == null || gem.ceiling === "place" || gem.ceiling === "precise_private";
  return venueLevel ? { ok: true } : { ok: false, reason: "PLACE_PROTECTED" };
}

/* ============================================================================
 * §14's fusion, on the action
 * ==========================================================================*/

function historicalOf(memory: MemoryForAction, subject: string, nowMs: number) {
  const asOf = memory.starts_at ?? memory.created_at ?? null;
  const day = asOf ? asOf.slice(0, 10) : null;
  return asHistoricalFact({
    subject,
    claim: day ? `This Memory records being at ${subject} on ${day}.` : `This Memory records being at ${subject}.`,
    asOf,
    nowMs,
    note: "from the Memory — a record of the past, not of now",
  });
}

/** The current half: a live source, or an honest unknown. Never the Memory row. */
export async function readCurrentWorld(place: CurrentPlace, nowIso: string): Promise<CurrentWorldReading> {
  let live: LiveVenueStatus | null = null;
  try {
    live = await deps.liveStatus(place.name, place.city);
  } catch (err) {
    log.warn({ err, placeId: place.id }, "memory actions: live status threw — reporting unknown");
    live = null;
  }
  if (!live) {
    return currentWorldUnknown("No live source answered for this place, so nothing may be said about whether it is open now.", nowIso);
  }
  if (live.openNow === null) {
    return currentWorldUnknown(`${live.venueName}: a live source answered but published no opening hours.`, nowIso);
  }
  return currentWorldReading(
    `${live.venueName} is ${live.openNow ? "open" : "closed"} right now.`,
    "verified_live",
    `checked ${live.checkedAt} via ${live.source}`,
  );
}

/* ============================================================================
 * Current user context: the traveller's trips that are still ahead of them
 * ==========================================================================*/

export interface TripRef {
  id: string;
  title: string;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
}

export type TripContext =
  | { state: "ok"; trips: TripRef[] }
  | { state: "unreadable"; table: string };

const ACCEPTED_ROLES = new Set(["owner", "co_host", "member", "viewer"]);
/** A trip that is behind the traveller is not a current plan. */
const CURRENT_TRIP_STATUSES = new Set(["draft", "planning", "upcoming", "active"]);
const TRIP_COLUMNS = "id, owner_id, title, destination_city, destination_country, start_date, end_date, status";
interface TripRow {
  id: string; owner_id: string; title: string | null; destination_city: string | null; destination_country: string | null;
  start_date: string | null; end_date: string | null; status: string;
}
const MAX_TRIPS = 20;

/** The viewer's trips that are not over: accepted membership or ownership, status ahead, end date not past. */
export async function readCurrentTrips(sc: SupabaseClient, viewerId: string, today: string): Promise<TripContext> {
  const [memberships, owned] = await Promise.all([
    sc.from("trip_members").select("trip_id, role, status").eq("user_id", viewerId),
    sc.from("trips").select(TRIP_COLUMNS).eq("owner_id", viewerId),
  ]);
  if (memberships.error) {
    log.error({ err: memberships.error, viewerId }, "memory actions: trip_members read failed — trips are unknown, not none");
    return { state: "unreadable", table: "trip_members" };
  }
  if (owned.error) {
    log.error({ err: owned.error, viewerId }, "memory actions: owned trips read failed — trips are unknown, not none");
    return { state: "unreadable", table: "trips" };
  }
  const memberTripIds = new Set<string>();
  for (const m of ((memberships.data as Array<{ trip_id: string; role: string | null; status: string | null }> | null) ?? [])) {
    if (!m.role || !ACCEPTED_ROLES.has(m.role)) continue;
    if (m.status != null && m.status !== "accepted") continue;
    memberTripIds.add(String(m.trip_id));
  }
  const ownedRows = ((owned.data as TripRow[] | null) ?? []);
  for (const t of ownedRows) memberTripIds.delete(String(t.id));
  let memberRows: TripRow[] = [];
  if (memberTripIds.size > 0) {
    const { data, error } = await sc.from("trips").select(TRIP_COLUMNS).in("id", [...memberTripIds]);
    if (error) {
      log.error({ err: error, viewerId }, "memory actions: member trips read failed — trips are unknown, not none");
      return { state: "unreadable", table: "trips" };
    }
    memberRows = ((data as TripRow[] | null) ?? []);
  }
  const trips: TripRef[] = [...ownedRows, ...memberRows]
    .filter((t) => CURRENT_TRIP_STATUSES.has(String(t.status)))
    .filter((t) => !t.end_date || String(t.end_date) >= today)
    .map((t) => ({
      id: String(t.id),
      title: String(t.title ?? ""),
      destinationCity: t.destination_city ?? null,
      destinationCountry: t.destination_country ?? null,
      startDate: t.start_date ?? null,
      endDate: t.end_date ?? null,
      status: String(t.status),
    }))
    .sort((a, b) =>
      (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1)
      || String(a.startDate ?? "9999").localeCompare(String(b.startDate ?? "9999"))
      || a.id.localeCompare(b.id))
    ;
  // ALL current trips are kept for deciding (a requested or matching trip past
  // the 20th is still the viewer's — finding 8); only the list a person picks
  // from is bounded, in compileDoAgain.
  return { state: "ok", trips };
}

function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ============================================================================
 * Payloads the client hands to systems that own the write
 * ==========================================================================*/

/**
 * The shape `TripWishlistPicker` (and through it `POST /trips/:tripId/saved-places`)
 * takes. It is the CURRENT place: the successor of a merged place, the catalog's
 * name and coordinates today — never the Memory's own coordinate.
 */
export interface AddToTripPayload {
  id: string;
  name: string;
  category: string;
  type: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

function addToTripPayload(place: CurrentPlace): AddToTripPayload {
  return {
    id: place.id,
    name: place.name,
    category: place.category,
    type: null,
    address: [place.address, place.city].filter(Boolean).join(", ") || null,
    lat: place.lat,
    lng: place.lng,
  };
}

export type NavigationTarget =
  | { kind: "catalog_place"; placeId: string; label: string; address: string | null; lat: number | null; lng: number | null; historical: false }
  | { kind: "memory_location"; placeId: null; label: string; address: null; lat: number; lng: number; historical: true };

function catalogTarget(place: CurrentPlace): NavigationTarget {
  return { kind: "catalog_place", placeId: place.id, label: place.name, address: place.address, lat: place.lat, lng: place.lng, historical: false };
}

function memoryCoordinate(memory: MemoryForAction): { lat: number; lng: number } | null {
  const lat = memory.location_lat == null ? Number.NaN : Number(memory.location_lat);
  const lng = memory.location_lng == null ? Number.NaN : Number(memory.location_lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/* ============================================================================
 * The menu
 * ==========================================================================*/

export interface ActionDescriptor {
  action: MemoryAction;
  available: boolean;
  reason: ActionUnavailableReason | null;
  message: string | null;
  /** A non-blocking current-world caveat the client must show beside the action. */
  caution: CatalogCaution | null;
}

function offered(action: MemoryAction, caution: CatalogCaution | null = null): ActionDescriptor {
  return { action, available: true, reason: null, message: null, caution };
}
function refused(action: MemoryAction, reason: ActionUnavailableReason): ActionDescriptor {
  return { action, available: false, reason, message: ACTION_UNAVAILABLE_MESSAGE[reason], caution: null };
}

/** The venue as THIS viewer may act on it, or why not. */
export type ViewerPlace =
  | { state: "ok"; place: CurrentPlace; caution: CatalogCaution | null; followedMerges: string[] }
  | { state: "refused"; reason: ActionUnavailableReason };

export async function viewerPlaceFor(
  sc: SupabaseClient,
  memory: MemoryForAction,
  viewerId: string,
  precisionGate: MemoryPrecisionGate,
  resolution: PlaceResolution,
): Promise<ViewerPlace> {
  if (resolution.state === "unreadable") return { state: "refused", reason: "PLACE_UNREADABLE" };
  if (resolution.state === "unresolved") return { state: "refused", reason: resolution.reason };
  // A closed place is still the place this Memory was at; whether it may be
  // NAMED to this viewer is decided before whether it may be ACTED on, so a
  // non-owner never learns "closed" about a venue they may not be told.
  const disclosure = await mayDiscloseVenue(sc, memory, viewerId, resolution.place, precisionGate);
  if (!disclosure.ok) return { state: "refused", reason: disclosure.reason };
  if (resolution.state === "closed") return { state: "refused", reason: "PLACE_CLOSED" };
  return { state: "ok", place: resolution.place, caution: resolution.caution, followedMerges: resolution.followedMerges };
}

export interface ActionMenu {
  engineVersion: string;
  memoryId: string;
  isOwner: boolean;
  place: CurrentPlace | null;
  actions: ActionDescriptor[];
}

export function buildActionMenu(input: {
  memory: MemoryForAction;
  viewerId: string;
  viewerPlace: ViewerPlace;
  savedByMe: boolean | null;
}): ActionMenu {
  const { memory, viewerId, viewerPlace } = input;
  const isOwner = viewerId === memory.owner_id;
  const placeOk = viewerPlace.state === "ok";
  const caution = placeOk ? viewerPlace.caution : null;
  const placeRefusal = viewerPlace.state === "refused" ? viewerPlace.reason : null;
  const venue = (a: MemoryAction) => (placeOk ? offered(a, caution) : refused(a, placeRefusal ?? "NO_PLACE_REFERENCE"));

  const takeMeBack = (): ActionDescriptor => {
    if (placeOk) return offered("TAKE_ME_BACK", caution);
    // The owner may be taken back to where THEY recorded it when the catalog
    // knows no place there. A closed place, an unreadable catalog and a
    // withheld venue are not "no place": those refusals stand.
    if (isOwner && placeRefusal !== null && (placeRefusal === "NO_PLACE_REFERENCE" || placeRefusal === "PLACE_NOT_IN_CATALOG")) {
      return memoryCoordinate(memory) ? offered("TAKE_ME_BACK") : refused("TAKE_ME_BACK", "NO_COORDINATES");
    }
    return refused("TAKE_ME_BACK", placeRefusal ?? "NO_COORDINATES");
  };

  const actions: ActionDescriptor[] = [
    venue("DO_AGAIN"),
    takeMeBack(),
    venue("ADD_TO_TRIP"),
    isOwner ? refused("SAVE_EXPERIENCE", "OWN_MEMORY") : offered("SAVE_EXPERIENCE"),
    refused("BOOK_AGAIN", DECLARED_UNBUILT.BOOK_AGAIN!),
    refused("NEW_TRIP_WITH_CREW", DECLARED_UNBUILT.NEW_TRIP_WITH_CREW!),
    !isOwner ? refused("BRING_FORWARD_SAVED", "OWNER_ONLY")
      : !memory.trip_id ? refused("BRING_FORWARD_SAVED", "NO_PRIOR_TRIP")
        : offered("BRING_FORWARD_SAVED"),
    refused("USE_AS_INSPIRATION", DECLARED_UNBUILT.USE_AS_INSPIRATION!),
    venue("VIEW_PLACE"),
  ];
  return {
    engineVersion: MEMORY_ACTION_ENGINE_VERSION,
    memoryId: memory.id,
    isOwner,
    place: placeOk ? viewerPlace.place : null,
    actions: actions.map((a) => (a.action === "SAVE_EXPERIENCE" && a.available && input.savedByMe === true
      ? { ...a, message: "Saved" }
      : a)),
  };
}

/* ============================================================================
 * Compiles
 * ==========================================================================*/

export interface FreedomWindowView {
  id: string;
  beginsAt: string;
  endsAt: string;
  durationMinutes: number;
  confidence: string;
  certified: boolean;
}

export type FreedomLeg =
  | { consulted: true; tripId: string; decisionId: string; windows: FreedomWindowView[]; reading: string }
  | { consulted: false; tripId: string | null; info: string };

export type TripChoice =
  | { state: "chosen"; trip: TripRef; candidates: TripRef[] }
  | { state: "none_matching"; candidates: TripRef[] }
  | { state: "no_trips"; candidates: [] }
  | { state: "unreadable"; candidates: [] };

export interface DoAgainPlan {
  action: "DO_AGAIN";
  engineVersion: string;
  place: CurrentPlace;
  caution: CatalogCaution | null;
  followedMerges: string[];
  fusion: FusedAnswer;
  tripChoice: TripChoice;
  freedom: FreedomLeg;
  addToTrip: AddToTripPayload;
  navigation: NavigationTarget;
}

/** Windows worth offering: still ahead, at least this long. */
const MIN_WINDOW_MINUTES = 60;
const MAX_WINDOWS = 3;

/**
 * §27 `compileDoAgain(memoryId, currentContext)`.
 *
 * "Do this again" does not replay the Memory. It asks, NOW: is the place still
 * there (and which row is it today), is it open (a live source, or unknown),
 * which of the traveller's trips is going there, and where on that trip is
 * there free time (the Temporal Freedom Engine's windows — never a second
 * free-time calculation here). Then it hands back what to do: the payload for
 * the trip's own write path and a navigation target.
 *
 * `requestedTripId` must be one of the viewer's current trips; anything else is
 * refused by the caller as `trip_not_eligible`.
 */
export async function compileDoAgain(
  sc: SupabaseClient,
  input: {
    memory: MemoryForAction;
    viewerId: string;
    place: CurrentPlace;
    caution: CatalogCaution | null;
    followedMerges: string[];
    trips: TripContext;
    requestedTripId: string | null;
    now: Date;
  },
): Promise<DoAgainPlan | { refused: "trip_not_eligible" | "trips_unreadable" }> {
  const { memory, viewerId, place, now } = input;
  // A trip the traveller ASKED for, on a membership list that could not be
  // read, is not "not yours": it is undecidable, and the caller answers 503.
  if (input.requestedTripId && input.trips.state === "unreadable") return { refused: "trips_unreadable" };
  const nowIso = now.toISOString();
  const current = await readCurrentWorld(place, nowIso);
  const fusion = fuseHistoricalWithCurrent(historicalOf(memory, place.name, now.getTime()), current);

  let tripChoice: TripChoice;
  if (input.trips.state === "unreadable") {
    tripChoice = { state: "unreadable", candidates: [] };
  } else if (input.trips.trips.length === 0) {
    tripChoice = { state: "no_trips", candidates: [] };
  } else if (input.requestedTripId) {
    const t = input.trips.trips.find((x) => x.id === input.requestedTripId);
    if (!t) return { refused: "trip_not_eligible" };
    tripChoice = { state: "chosen", trip: t, candidates: input.trips.trips.slice(0, MAX_TRIPS) };
  } else {
    // Only a trip that is going THERE is chosen for the traveller. A trip to
    // somewhere else is a candidate they can pick, never a silent default.
    const match = input.trips.trips.find((x) => sameCity(x.destinationCity, place.city));
    tripChoice = match
      ? { state: "chosen", trip: match, candidates: input.trips.trips.slice(0, MAX_TRIPS) }
      : { state: "none_matching", candidates: input.trips.trips.slice(0, MAX_TRIPS) };
  }

  let freedom: FreedomLeg;
  if (tripChoice.state !== "chosen") {
    freedom = { consulted: false, tripId: null, info: tripChoice.state === "unreadable"
      ? "Your trips could not be read, so free time was not checked."
      : "No trip was chosen, so free time was not checked." };
  } else {
    let read: TripWindowsRead;
    try {
      read = await deps.tripWindows(sc, tripChoice.trip.id, viewerId, now);
    } catch (err) {
      read = { ok: false, info: `the Temporal Freedom Engine threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!read.ok) {
      freedom = { consulted: false, tripId: tripChoice.trip.id, info: read.info };
    } else {
      const nowMs = now.getTime();
      const windows = read.projection.windows
        .filter((w) => Date.parse(w.endsAt) > nowMs && w.durationMinutes >= MIN_WINDOW_MINUTES)
        .sort((a, b) => Date.parse(a.beginsAt) - Date.parse(b.beginsAt))
        .slice(0, MAX_WINDOWS)
        .map((w) => ({
          id: w.id, beginsAt: w.beginsAt, endsAt: w.endsAt, durationMinutes: w.durationMinutes,
          confidence: String(w.confidence), certified: w.certified,
        }));
      freedom = { consulted: true, tripId: tripChoice.trip.id, decisionId: read.projection.decisionId, windows, reading: read.projection.reading };
    }
  }

  return {
    action: "DO_AGAIN",
    engineVersion: MEMORY_ACTION_ENGINE_VERSION,
    place,
    caution: input.caution,
    followedMerges: input.followedMerges,
    fusion,
    tripChoice,
    freedom,
    addToTrip: addToTripPayload(place),
    navigation: catalogTarget(place),
  };
}

/** §27 `addToTrip(memoryId, tripId)`: the current place, compiled for the trip's own write path. */
export function compileAddToTrip(place: CurrentPlace, caution: CatalogCaution | null) {
  return {
    action: "ADD_TO_TRIP" as const,
    engineVersion: MEMORY_ACTION_ENGINE_VERSION,
    place,
    caution,
    addToTrip: addToTripPayload(place),
  };
}

/**
 * §27 `buildNavigationTarget(memoryId)`.
 *
 * A catalog place is navigated to the catalog's current row for it (a merged
 * place's successor, with the coordinates that row carries). Nothing in the tree
 * records a new location for a place marked `moved`, so none is claimed. Only the owner, and only
 * when the catalog knows no place, is taken to the coordinate THEY recorded —
 * and the target says it is historical.
 */
export function compileTakeMeBack(
  memory: MemoryForAction,
  viewerId: string,
  viewerPlace: ViewerPlace,
): { action: "TAKE_ME_BACK"; engineVersion: string; navigation: NavigationTarget; caution: CatalogCaution | null } | { refused: ActionUnavailableReason } {
  if (viewerPlace.state === "ok") {
    return { action: "TAKE_ME_BACK", engineVersion: MEMORY_ACTION_ENGINE_VERSION, navigation: catalogTarget(viewerPlace.place), caution: viewerPlace.caution };
  }
  const own = viewerId === memory.owner_id;
  if (own && (viewerPlace.reason === "NO_PLACE_REFERENCE" || viewerPlace.reason === "PLACE_NOT_IN_CATALOG")) {
    const c = memoryCoordinate(memory);
    if (!c) return { refused: "NO_COORDINATES" };
    const label = [memory.location_city, memory.location_country].filter(Boolean).join(", ") || (memory.title ?? "Where this Memory happened");
    return {
      action: "TAKE_ME_BACK",
      engineVersion: MEMORY_ACTION_ENGINE_VERSION,
      navigation: { kind: "memory_location", placeId: null, label, address: null, lat: c.lat, lng: c.lng, historical: true },
      caution: null,
    };
  }
  return { refused: viewerPlace.reason };
}

/* ============================================================================
 * Bring forward saved experiences from a previous destination
 * ==========================================================================*/

export interface BroughtForward {
  savedAt: string | null;
  caution: CatalogCaution | null;
  addToTrip: AddToTripPayload;
}
export interface LeftBehind {
  placeName: string;
  reason: "PLACE_CLOSED" | "PLACE_NOT_IN_CATALOG" | "ALREADY_EXPERIENCED";
}

/**
 * The owner's own saves on the Memory's trip that they never got to, compiled
 * against the catalog NOW. A save whose place has closed is left behind and
 * said to be; a save at a place the owner already has a Memory of was done,
 * not missed. Only the owner's OWN saves: a crewmate's save on the old trip is
 * theirs to bring forward, not this person's.
 */
export async function compileBringForward(
  sc: SupabaseClient,
  memory: MemoryForAction,
  viewerId: string,
): Promise<{ ok: true; items: BroughtForward[]; leftBehind: LeftBehind[]; fromTripId: string } | { ok: false; table: string }> {
  const tripId = String(memory.trip_id);
  const { data: saves, error: savesErr } = await sc
    .from("trip_saved_places")
    .select("place_id, place_name, saved_at")
    .eq("trip_id", tripId)
    .eq("user_id", viewerId)
    .order("saved_at", { ascending: true })
    .limit(100);
  if (savesErr) {
    log.error({ err: savesErr, tripId }, "memory actions: trip_saved_places read failed — saves are unknown, not none");
    return { ok: false, table: "trip_saved_places" };
  }
  const rows = ((saves as Array<{ place_id: string | null; place_name: string; saved_at: string | null }> | null) ?? []);
  const catalogIds = [...new Set(rows.map((r) => r.place_id).filter((v): v is string => typeof v === "string" && UUID_RE.test(v)))];

  const places = new Map<string, PlaceRow>();
  const experienced = new Set<string>();
  if (catalogIds.length > 0) {
    const [placeRead, memRead] = await Promise.all([
      sc.from("places").select(PLACE_ACTION_COLUMNS).in("id", catalogIds),
      sc.from("memories").select("place_id").eq("owner_id", viewerId).neq("state", "deleted").in("place_id", catalogIds),
    ]);
    if (placeRead.error) {
      log.error({ err: placeRead.error, tripId }, "memory actions: places read failed while bringing saves forward");
      return { ok: false, table: "places" };
    }
    if (memRead.error) {
      log.error({ err: memRead.error, tripId }, "memory actions: memories read failed while bringing saves forward");
      return { ok: false, table: "memories" };
    }
    for (const p of ((placeRead.data as PlaceRow[] | null) ?? [])) places.set(String(p.id), p);
    for (const m of ((memRead.data as Array<{ place_id: string | null }> | null) ?? [])) if (m.place_id) experienced.add(String(m.place_id));
  }

  const items: BroughtForward[] = [];
  const leftBehind: LeftBehind[] = [];
  for (const r of rows) {
    const id = r.place_id && UUID_RE.test(r.place_id) ? r.place_id : null;
    const saved = id ? places.get(id) : undefined;
    if (!id || !saved) {
      leftBehind.push({ placeName: r.place_name, reason: "PLACE_NOT_IN_CATALOG" });
      continue;
    }
    if (experienced.has(id)) { leftBehind.push({ placeName: r.place_name, reason: "ALREADY_EXPERIENCED" }); continue; }
    // The SAME merge rule Do Again uses (finding 8): a saved row the catalog
    // merged away is brought forward as its successor, judged as the successor.
    const chain = await followMergeChain(sc, saved);
    if (!chain.ok) return { ok: false, table: "places" };
    const row = chain.row;
    if (experienced.has(String(row.id))) { leftBehind.push({ placeName: r.place_name, reason: "ALREADY_EXPERIENCED" }); continue; }
    if (row.status === "duplicate") { leftBehind.push({ placeName: r.place_name, reason: "PLACE_NOT_IN_CATALOG" }); continue; }
    if (row.status === "closed") { leftBehind.push({ placeName: r.place_name, reason: "PLACE_CLOSED" }); continue; }
    const place = toCurrentPlace(row);
    const caution: CatalogCaution | null = place.status === "temporarily_closed" ? "TEMPORARILY_CLOSED"
      : place.status === "moved" ? "MOVED" : place.status === "unverified" ? "UNVERIFIED" : null;
    items.push({ savedAt: r.saved_at ?? null, caution, addToTrip: addToTripPayload(place) });
  }
  return { ok: true, items, leftBehind, fromTripId: tripId };
}
