/**
 * MediaRankingSignalLoader — reads the §24 signals the World-shell ranker
 * (services/media/MediaRankingService) scores, once per ranked page.
 *
 * ── WHAT IT READS, AND WHOSE IT IS ───────────────────────────────────────────
 * Two kinds of read, and nothing else:
 *
 *   • The VIEWER'S OWN data — their "I Want This" signals, their trips, their
 *     declared interests, who they follow, the places they saved, the trip
 *     crew and Shared Moments they belong to. Every one is keyed by the
 *     viewer's own id.
 *   • Facts about the CANDIDATE PAGE — rows the eligibility gate has ALREADY
 *     admitted for this viewer, so no read here can become an existence oracle
 *     for anything the page withheld: the gated live state of their places,
 *     §45 outcome counts, a linked PUBLIC event's timing, whether the post is a
 *     PUBLIC active Postcard, whether its capture location was verified.
 *
 * It reads no engagement count (likes, stamps, views, watch time) and no
 * contributor's intel history. Nothing it returns is projected to a client —
 * signals are ranking inputs only, consumed and dropped.
 *
 * ── FAIL-SOFT, AND WHY THAT IS SAFE HERE ─────────────────────────────────────
 * Every read is independent and settles to `null` on any error (supabase-js
 * RESOLVES a failed query, so `error` is read on every result). A `null`
 * signal scores identically for every row (lib/mediaRankingSignals rule 1), so
 * a failed read reorders nothing and the ranked set is the same set either
 * way. This is a ranking input, never an authorization one: it can change the
 * sequence of a page, never its membership.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaCandidateRow } from "../../lib/media/mediaProjection.js";
import { loadViewerTripIds } from "../../lib/mediaEligibility.js";
import { readLiveClaims, type LiveClaim } from "../../lib/liveClaimRead.js";
import { MEDIA_NORTH_STAR_EVENT_TYPES } from "../../lib/mediaAnalytics.js";
import {
  EMPTY_MEDIA_RANKING_SIGNALS,
  type LinkedEvent,
  type MediaOutcomeCounts,
  type MediaRankingSignals,
  type PlaceLiveState,
  type ViewerTripWindow,
} from "../../lib/mediaRankingSignals.js";
import { logger } from "../../lib/logger.js";

export interface RankingSignalViewer {
  viewerId: string;
  viewerCountry: string | null;
  followedCreatorIds: Set<string>;
  viewerTripIds: Set<string>;
}

export interface LoadMediaRankingSignalsOptions {
  /** Injectable for tests; defaults to the gated, fail-closed live-claim read. */
  readLiveClaims?: (sc: any, subjectId: string, opts: { now: Date }) => Promise<LiveClaim[]>;
  /** Injectable for tests; defaults to MediaProjectionService.loadPeopleAffinities. */
  loadPeopleAffinities?: (sc: any, viewerId: string) => Promise<{ tripCrewIds: Set<string>; sharedMomentIds: Set<string> }>;
}

/** How many distinct places on a page get a live-state read. Bounded on purpose. */
export const MAX_LIVE_PLACES_PER_PAGE = 12;
/** How far back §45 outcome events count toward Expected Real-World Utility. */
export const OUTCOME_WINDOW_MS = 30 * 86_400_000;

/**
 * The §45 transitions that are a real-world ACTION taken from the media, plus
 * the legacy §44 names for the same acts. Contribution and correction are §45
 * outcomes too, but they are the viewer giving back, not the media being
 * useful to them, so they do not count as utility.
 */
export const UTILITY_OUTCOME_EVENTS: readonly string[] = [
  ...MEDIA_NORTH_STAR_EVENT_TYPES.filter((e) => e !== "media_contribution" && e !== "media_correction"),
  "place_open",
  "add_to_trip",
  "directions_tap",
];

type Settled<T> = T | null;

async function settle<T>(label: string, fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return await fn();
  } catch (err) {
    logger.debug({ err, signal: label }, "MediaRankingSignalLoader: signal unread — neutral for this page");
    return null;
  }
}

/** Throw on a PostgREST error envelope so `settle` sees it as unread, not empty. */
function rows(res: { data: unknown; error: unknown }): any[] {
  if (res.error) throw res.error;
  return Array.isArray(res.data) ? (res.data as any[]) : [];
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function dayStartMs(d: unknown): number | null {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(t) ? t : null;
}

function dayEndMs(d: unknown): number | null {
  const s = dayStartMs(d);
  return s === null ? null : s + 86_400_000 - 1;
}

function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export async function loadMediaRankingSignals(
  sc: SupabaseClient,
  viewer: RankingSignalViewer,
  candidates: readonly MediaCandidateRow[],
  nowMs: number,
  opts: LoadMediaRankingSignalsOptions = {},
): Promise<MediaRankingSignals> {
  const db = sc as any;
  const viewerId = viewer.viewerId;
  const pageIds = [...new Set(candidates.map((r) => String(r.id)).filter(Boolean))];
  const placeIds = [...new Set(
    candidates
      .map((r) => (typeof r.canonical_place_id === "string" ? r.canonical_place_id : null))
      .filter((x): x is string => Boolean(x)),
  )];

  const [intent, trips, interests, followed, savedPlaceIds, affinity, livePlaces, outcomes, events, postcards, verifiedCapture] =
    await Promise.all([
      // ── viewer: §15.1 wants, generalised to places and categories ──────────
      settle("intent", async () => {
        const wants = rows(
          await db
            .from("media_intent_signals")
            .select("media_id, entity_type, entity_id")
            .eq("user_id", viewerId)
            .order("updated_at", { ascending: false })
            .limit(100),
        );
        const mediaIds = new Set<string>();
        const wantedPlaces = new Set<string>();
        for (const w of wants) {
          if (typeof w.media_id === "string") mediaIds.add(w.media_id);
          if (w.entity_type === "place" && typeof w.entity_id === "string") wantedPlaces.add(w.entity_id);
        }
        const categories = new Set<string>();
        if (mediaIds.size > 0) {
          const posts = rows(await db.from("posts").select("id, category").in("id", [...mediaIds]));
          for (const p of posts) if (norm(p.category)) categories.add(norm(p.category));
        }
        return { mediaIds, placeIds: wantedPlaces, categories };
      }),

      // ── viewer: trips (owned or accepted member), coarse windows ──────────
      settle("trips", async () => {
        const ids = viewer.viewerTripIds.size > 0 ? viewer.viewerTripIds : await loadViewerTripIds(sc, viewerId);
        if (ids.size === 0) return [] as ViewerTripWindow[];
        const trips = rows(
          await db
            .from("trips")
            .select("id, destination_city, destination_country, start_date, end_date")
            .in("id", [...ids].slice(0, 50)),
        );
        return trips.map((t): ViewerTripWindow => ({
          id: String(t.id),
          city: typeof t.destination_city === "string" ? t.destination_city : null,
          country: typeof t.destination_country === "string" ? t.destination_country : null,
          startMs: dayStartMs(t.start_date),
          endMs: dayEndMs(t.end_date),
        }));
      }),

      // ── viewer: declared travel interests ─────────────────────────────────
      settle("interests", async () => {
        const res = await db.from("compass_user_preferences").select("interests").eq("user_id", viewerId).maybeSingle();
        if (res.error) throw res.error;
        const list = Array.isArray(res.data?.interests) ? (res.data.interests as unknown[]) : [];
        return new Set(list.map(norm).filter(Boolean));
      }),

      // ── viewer: follow graph ─────────────────────────────────────────────
      settle("followed", async () => {
        if (viewer.followedCreatorIds.size > 0) return new Set(viewer.followedCreatorIds);
        const f = rows(await db.from("user_follows").select("following_id").eq("follower_id", viewerId).limit(2000));
        return new Set(f.map((r) => String(r.following_id)).filter(Boolean));
      }),

      // ── viewer: discovery behaviour (their saved places) ─────────────────
      settle("savedPlaces", async () => {
        const saved = rows(await db.from("saved_places").select("place_id").eq("user_id", viewerId).limit(500));
        return new Set(saved.map((r) => String(r.place_id)).filter(Boolean));
      }),

      // ── viewer: the people they actually coordinate with ─────────────────
      settle("affinity", async () => {
        const load = opts.loadPeopleAffinities
          ?? (await import("../media/MediaProjectionService.js")).loadPeopleAffinities;
        const a = await load(sc, viewerId);
        return { tripCrew: a.tripCrewIds, sharedMoment: a.sharedMomentIds };
      }),

      // ── page: gated live state per place (bounded) ────────────────────────
      settle("live", async () => {
        const read = opts.readLiveClaims ?? ((c: any, id: string, o: { now: Date }) => readLiveClaims(c, id, o));
        const out = new Map<string, PlaceLiveState>();
        const now = new Date(nowMs);
        await Promise.all(
          placeIds.slice(0, MAX_LIVE_PLACES_PER_PAGE).map(async (pid) => {
            const claims = await read(sc, pid, { now }).catch(() => [] as LiveClaim[]);
            if (!claims || claims.length === 0) return;
            const liveQualified = claims.some(
              (c) => (c.band === "live" || c.band === "strong") && c.conflictState !== "material",
            );
            const conflicted = claims.some((c) => c.conflictState === "material");
            out.set(pid, { live: liveQualified, lowConfidence: !liveQualified || conflicted });
          }),
        );
        return out;
      }),

      // ── page: §45 real-world outcomes vs impressions ──────────────────────
      settle("outcomes", async () => {
        if (pageIds.length === 0) return new Map<string, MediaOutcomeCounts>();
        const events = rows(
          await db
            .from("media_events")
            .select("event_type, payload")
            .in("event_type", [...UTILITY_OUTCOME_EVENTS, "impression"])
            .gte("occurred_at", new Date(nowMs - OUTCOME_WINDOW_MS).toISOString())
            .in("payload->>media_id", pageIds)
            .limit(5000),
        );
        const out = new Map<string, MediaOutcomeCounts>();
        const outcomeSet = new Set(UTILITY_OUTCOME_EVENTS);
        for (const e of events) {
          const id = typeof e.payload?.media_id === "string" ? e.payload.media_id : null;
          if (!id) continue;
          const c = out.get(id) ?? { outcomes: 0, impressions: 0 };
          if (e.event_type === "impression") c.impressions += 1;
          else if (outcomeSet.has(e.event_type)) c.outcomes += 1;
          out.set(id, c);
        }
        return out;
      }),

      // ── page: the PUBLIC event each post is linked to ─────────────────────
      settle("events", async () => {
        if (pageIds.length === 0) return new Map<string, LinkedEvent>();
        const links = rows(await db.from("post_event_links").select("post_id, event_id").in("post_id", pageIds).limit(500));
        const eventIds = [...new Set(links.map((l) => String(l.event_id)).filter(Boolean))];
        if (eventIds.length === 0) return new Map<string, LinkedEvent>();
        const evs = rows(
          await db
            .from("events")
            .select("id, starts_at, ends_at, city, state, visibility")
            .in("id", eventIds)
            .eq("visibility", "public"),
        );
        const byId = new Map<string, LinkedEvent>();
        for (const ev of evs) {
          if (ev.visibility !== "public") continue;
          byId.set(String(ev.id), {
            startMs: isoMs(ev.starts_at),
            endMs: isoMs(ev.ends_at),
            city: typeof ev.city === "string" ? ev.city : null,
            closed: ev.state === "cancelled" || ev.state === "archived" || ev.state === "completed",
          });
        }
        const out = new Map<string, LinkedEvent>();
        for (const l of links) {
          const ev = byId.get(String(l.event_id));
          if (ev && !out.has(String(l.post_id))) out.set(String(l.post_id), ev);
        }
        return out;
      }),

      // ── page: which posts are a PUBLIC, active Postcard ───────────────────
      settle("postcards", async () => {
        if (pageIds.length === 0) return new Set<string>();
        const pcs = rows(
          await db
            .from("passport_postcards")
            .select("post_id, status, visibility, deleted_at")
            .in("post_id", pageIds)
            .eq("status", "active")
            .eq("visibility", "public"),
        );
        return new Set(
          pcs
            .filter((p) => p.status === "active" && p.visibility === "public" && !p.deleted_at)
            .map((p) => String(p.post_id)),
        );
      }),

      // ── page: capture location verified at the place ──────────────────────
      settle("verifiedCapture", async () => {
        if (pageIds.length === 0) return new Set<string>();
        const ps = rows(await db.from("posts").select("id, location_verified, geotag_verified").in("id", pageIds));
        return new Set(ps.filter((p) => p.location_verified === true || p.geotag_verified === true).map((p) => String(p.id)));
      }),
    ]);

  return {
    ...EMPTY_MEDIA_RANKING_SIGNALS,
    intent,
    trips,
    homeCountry: viewer.viewerCountry ?? null,
    interests,
    followed,
    savedPlaceIds,
    affinity,
    livePlaces,
    outcomes,
    events,
    postcards,
    verifiedCapture,
  };
}
