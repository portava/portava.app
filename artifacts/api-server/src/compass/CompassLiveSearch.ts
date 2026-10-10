/**
 * CompassLiveSearch — the live half of Compass's search_places / search_events
 * (lead ruling CPH-08-ADAPT, 2026-10-07; census-compass CPH-08).
 *
 * The catalog is always searched first and is always the answer's spine. A live
 * provider is consulted only when ALL of these hold, checked in this order so a
 * refusal spends nothing:
 *   1. `compass_live_search_enabled` is on (migration 3704, seeded FALSE; read
 *      fail-closed — an unreadable flag is off);
 *   2. the provider's key is configured (Foursquare for places, Ticketmaster for
 *      events) — absent means no call;
 *   3. the person has quota left today: `compass_live_search_take` takes one of
 *      COMPASS_LIVE_SEARCH_DAILY_QUOTA units atomically; an unreadable quota is
 *      no quota (fail closed on spend).
 * Any refusal, and any provider failure, falls back to the catalog with NO error
 * to the person: the tool result says why live listings are absent
 * (`liveSearch.used: false`, `reason`) for the model, and nothing more.
 *
 * THE D-67 IDENTITY RULE FOR ANYTHING LABELLED LIVE (lead ruling D-67). A
 * provider listing is never labelled "verified live" on its own. A Foursquare
 * record that matches a catalog place by D-67's rule (normalised names equal AND
 * within LIVE_IDENTITY_MAX_DISTANCE_M of the place's own coordinates —
 * `isSameVenue`) confirms THAT catalog place, which is then labelled verified
 * live; every other provider listing is offered as a provider listing labelled
 * not verified live. Ticketmaster events have no Portava identity to confirm, so
 * they are never labelled live.
 *
 * Spend: none until the owner supplies keys AND turns the flag on
 * (docs/ops/compass-live-search-setup.md). That turn-on is the owner's decision.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { searchFoursquare } from "../lib/foursquarePlaces.js";
import { getFoursquareApiKey } from "../lib/foursquareApiKey.js";
import { getEventsNearDestination, type NearbyEvent } from "../lib/eventsCache.js";
import { isSameVenue, liveVenueAnchorOf, makeConfidence, type Confidence } from "../lib/liveIntelligence.js";

export const COMPASS_LIVE_SEARCH_FLAG = "compass_live_search_enabled";
/** Live provider searches per person per UTC day (lead ruling CPH-08-ADAPT). */
export const COMPASS_LIVE_SEARCH_DAILY_QUOTA = 5;

export type LiveSearchReason =
  | "flag_off"
  | "keys_absent"
  | "no_query"
  | "quota_exhausted"
  | "quota_unreadable"
  | "provider_returned_nothing";

export interface LiveSearchStatus {
  used: boolean;
  provider: "foursquare" | "ticketmaster";
  reason?: LiveSearchReason;
}

/** Seams for tests; production uses the real clients and the process env. */
export interface LiveSearchDeps {
  searchPlaces?: (q: string, opts: { limit?: number }) => Promise<any[]>;
  searchEvents?: (destination: string, start?: string, end?: string, max?: number) => Promise<{ events: NearbyEvent[] } | null>;
  placesKey?: () => string | null | undefined;
  eventsKey?: () => string | null | undefined;
}

let _deps: LiveSearchDeps = {};
/** TEST SEAM: replace the provider clients / key readers. */
export function _setLiveSearchDeps(d: LiveSearchDeps): void { _deps = d; }

const placesKey = () => (_deps.placesKey ? _deps.placesKey() : getFoursquareApiKey());
const eventsKey = () => (_deps.eventsKey ? _deps.eventsKey() : process.env.TICKETMASTER_API_KEY);

/** Flag → key → quota. Returns null when admitted (one quota unit taken), else the reason. */
async function admit(sc: SupabaseClient, userId: string, key: string | null | undefined): Promise<LiveSearchReason | null> {
  if (!(await isFlagEnabled(sc, COMPASS_LIVE_SEARCH_FLAG))) return "flag_off";
  if (!key) return "keys_absent";
  try {
    const { data, error } = await (sc as any).rpc("compass_live_search_take", { p_user_id: userId, p_daily_limit: COMPASS_LIVE_SEARCH_DAILY_QUOTA });
    if (error) return "quota_unreadable";
    return data === true ? null : "quota_exhausted";
  } catch {
    return "quota_unreadable";
  }
}

export interface CatalogPlaceAnchor { id: string; name: string; lat: unknown; lng: unknown }

export interface LivePlacesResult {
  status: LiveSearchStatus;
  /** Catalog place ids a provider record confirmed by D-67 — label these verified live. */
  confirmedCatalogIds: Set<string>;
  /** Provider listings that matched NO catalog place — never labelled verified live. */
  listings: Array<{
    name: string; city: string | null; category: string; source: "foursquare"; attribution: string;
    confidence: Confidence;
  }>;
}

const UNMATCHED_NOTE = "A Foursquare listing fetched just now; not matched to a Portava place, so it is not verified live.";
const CONFIRMED_NOTE = "Matched to a live Foursquare record (same name, within 150 m of this place).";

/** The confidence a catalog place carries when a provider record confirmed it (D-67). */
export function confirmedLiveConfidence(): Confidence { return makeConfidence("verified_live", CONFIRMED_NOTE); }

export async function livePlaces(
  sc: SupabaseClient,
  userId: string,
  input: {
    query: string | null; city: string | null; limit: number;
    /** The catalog places' identity anchors — read only after the provider answered, and never returned. */
    loadCatalog: () => Promise<readonly CatalogPlaceAnchor[]>;
  },
): Promise<LivePlacesResult> {
  const empty = (reason: LiveSearchReason): LivePlacesResult => ({ status: { used: false, provider: "foursquare", reason }, confirmedCatalogIds: new Set(), listings: [] });
  const q = [input.query, input.city].filter((x): x is string => typeof x === "string" && x.trim().length > 0).join(" ").trim();
  // `no_query` is decided AFTER the flag and key, so a dark feature reports flag_off.
  const refused = q ? await admit(sc, userId, placesKey()) : (await isFlagEnabled(sc, COMPASS_LIVE_SEARCH_FLAG)) ? "no_query" as const : "flag_off" as const;
  if (refused) return empty(refused);
  const search = _deps.searchPlaces ?? ((query: string, o: { limit?: number }) => searchFoursquare(query, o));
  let records: any[] = [];
  try { records = await search(q, { limit: input.limit }); } catch { records = []; }
  if (!Array.isArray(records) || records.length === 0) return empty("provider_returned_nothing");

  let catalog: readonly CatalogPlaceAnchor[] = [];
  try { catalog = await input.loadCatalog(); } catch { catalog = []; } // unreadable anchors confirm nothing (no live label)
  const confirmed = new Set<string>();
  const listings: LivePlacesResult["listings"] = [];
  for (const r of records) {
    const rec = { name: r?.name, latitude: r?.lat, longitude: r?.lng };
    const match = catalog.find((c) => {
      const anchor = liveVenueAnchorOf(c.lat, c.lng);
      return anchor !== null && isSameVenue(c.name, anchor, rec);
    });
    if (match) { confirmed.add(match.id); continue; }
    if (typeof r?.name !== "string" || !r.name.trim()) continue;
    listings.push({
      name: r.name,
      city: typeof r.city === "string" ? r.city : null,
      category: typeof r.type === "string" ? r.type : "place",
      source: "foursquare",
      attribution: typeof r.attribution === "string" ? r.attribution : "Powered by Foursquare",
      confidence: makeConfidence("historical", UNMATCHED_NOTE),
    });
  }
  return { status: { used: true, provider: "foursquare" }, confirmedCatalogIds: confirmed, listings: listings.slice(0, input.limit) };
}

export interface LiveEventsResult {
  status: LiveSearchStatus;
  listings: Array<{
    title: string; city: string; startsOn: string | null; category: string; venueName: string | null; url: string | null;
    source: "ticketmaster"; confidence: Confidence;
  }>;
}

const EVENT_NOTE = "A Ticketmaster listing fetched just now; not a Portava event, so it is not verified live.";

export async function liveEvents(
  sc: SupabaseClient,
  userId: string,
  input: { city: string | null; limit: number },
): Promise<LiveEventsResult> {
  const empty = (reason: LiveSearchReason): LiveEventsResult => ({ status: { used: false, provider: "ticketmaster", reason }, listings: [] });
  const city = typeof input.city === "string" && input.city.trim() ? input.city.trim() : null;
  const refused = city ? await admit(sc, userId, eventsKey()) : (await isFlagEnabled(sc, COMPASS_LIVE_SEARCH_FLAG)) ? "no_query" as const : "flag_off" as const;
  if (refused) return empty(refused);
  const search = _deps.searchEvents ?? getEventsNearDestination;
  let ctx: { events: NearbyEvent[] } | null = null;
  try { ctx = await search(city!, undefined, undefined, input.limit); } catch { ctx = null; }
  const events = ctx?.events ?? [];
  if (events.length === 0) return empty("provider_returned_nothing");
  return {
    status: { used: true, provider: "ticketmaster" },
    listings: events.slice(0, input.limit).map((e) => ({
      title: e.name, city: city!, startsOn: e.localDate || null, category: e.category, venueName: e.venueName, url: e.url,
      source: "ticketmaster" as const, confidence: makeConfidence("historical", EVENT_NOTE),
    })),
  };
}
