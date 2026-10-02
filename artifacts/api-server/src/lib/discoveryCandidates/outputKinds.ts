/**
 * `01` §4's ten output kinds, and the three PDE did not rank — census-discovery
 * §85 (lane W10-R3), DC-01. Behind `discovery_output_kinds_enabled` (3483,
 * seeded FALSE).
 *
 * "PDE should rank or recommend: postcards/posts, places, events, Trails,
 * trips, Shared Moments, travelers, circles, itineraries, emerging
 * discoveries." Before §85 seven were present (the census row's own list) and
 * three were not:
 *
 *   Trails                listed newest-first by `listTrails`, ranked by
 *                         nothing (§69, Q4). `rankTrailsForViewer` ranks the
 *                         same Trails through `rankForViewer`.
 *   Shared Moments        absent from every Discovery file.
 *                         `rankSharedMomentsForViewer` ranks the moments the
 *                         viewer is an ACCEPTED member of — the consent
 *                         boundary GET /shared-moments and the Wall already
 *                         enforce (`loadSharedMomentCandidates`, reused, not
 *                         re-decided), behind the Shared Moments capability
 *                         flag as well as this one.
 *   emerging discoveries  trend states existed and were not an output kind.
 *                         `rankEmergingForViewer` retrieves the latest run's
 *                         `emerging` / `rediscovered` places, materialises them
 *                         under the route's eligibility, and ranks them.
 *
 * ONE PIPELINE. Every kind is ranked by `rankForViewer` — portavaRank, then
 * DRS — mapped onto its `PdePlace` shape; no parallel ranker is introduced
 * (docs/discovery/ranker-hold-designs.md's shared rule). portavaRank has no
 * `trail` or `shared_moment` CandidateKind and this lane may not add one
 * (lib/portavaRank.ts is lane W10-R2's), so both rank as kind `place`, whose
 * kind prior is 0 — a neutral prior, recorded rather than disguised.
 *
 * WRITES NOTHING. Each ranker calls `rankForViewer` with `served: false`, so
 * DRS's assembly analytics cannot write rank_events rows under ids the serve
 * log does not know; the caller that SERVES a kind logs it, as every serve
 * path does today. The §85 per-request stages are off for these runs
 * (`pipelineFlags: PIPELINE_FLAGS_OFF`): generation adds places, which a Trail
 * or a moment list must never gain.
 *
 * NOT YET SERVED. No route calls these: routes/discovery.ts and the Trails
 * routes belong to other lanes (§85 records the one-line hooks).
 */
import { rankForViewer, type PdePlace, type PdeViewer } from "../discoveryPde.js";
import { inertModifiers } from "../discoveryModifiers.js";
import { listTrails, type TrailRow } from "../../services/trails/TrailService.js";
import { loadSharedMomentCandidates } from "../../services/wall/WallCandidateLoaders.js";
import { fetchBlockedSet } from "../blocks.js";
import { loadPipelineFlags, PIPELINE_FLAGS_OFF } from "./pipelineFlags.js";
import { cityPrefixOf, momentumPlaceIds, IN_LIST_CAP, type RetrievalContext } from "./retrievals.js";
import { materialiseCandidates, type MaterialisedPlace } from "./materialize.js";

/** `01` §4, in its own order, with where each kind is ranked at this tree. */
export const DISCOVERY_OUTPUT_KINDS = [
  { kind: "postcards_posts",      rankedBy: "portavaRank kinds post / postcard" },
  { kind: "places",               rankedBy: "rankForViewer (routes/discovery.ts serve paths)" },
  { kind: "events",               rankedBy: "portavaRank kind event" },
  { kind: "trails",               rankedBy: "rankTrailsForViewer (§85, 3483)" },
  { kind: "trips",                rankedBy: "portavaRank kind trip" },
  { kind: "shared_moments",       rankedBy: "rankSharedMomentsForViewer (§85, 3483)" },
  { kind: "travelers",            rankedBy: "portavaRank kinds traveler / buddy" },
  { kind: "circles",              rankedBy: "search candidates (lib/inputAssistance/searchCandidates.ts)" },
  { kind: "itineraries",          rankedBy: "portavaRank kind plan" },
  { kind: "emerging_discoveries", rankedBy: "rankEmergingForViewer (§85, 3483)" },
] as const;

export type OutputKindStatus = "flag_off" | "ranked" | "empty" | "unavailable";

export interface RankedKind<T> {
  kind: "trails" | "shared_moments" | "emerging_discoveries";
  status: OutputKindStatus;
  rankedBy: "pde" | "none";
  items: T[];
  /** Why the list is short or empty, when a read failed. */
  unavailable?: string;
}

async function flagOn(sc: any, nowMs: number, injected?: boolean): Promise<boolean> {
  if (typeof injected === "boolean") return injected;
  return (await loadPipelineFlags(sc, nowMs)).outputKinds;
}

async function rankMapped<T>(sc: any, viewer: PdeViewer, rows: Array<{ place: PdePlace; item: T }>, nowMs: number): Promise<T[]> {
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [r.place.id, r.item]));
  const outcome = await rankForViewer(rows.map((r) => r.place), viewer, {
    sc, served: false, nowMs, modifiers: inertModifiers("flag_off"), pipelineFlags: { ...PIPELINE_FLAGS_OFF },
  });
  return outcome.ranked.map((p) => byId.get(p.id)).filter((x): x is T => x !== undefined);
}

// ── Trails ───────────────────────────────────────────────────────────────────

/** A Trail as the ranker reads it: its signals as tags, its followers as social proof. */
export function trailAsPdePlace(t: TrailRow, signals: readonly string[], followers: number): PdePlace {
  return { id: `trail/${t.id}`, category: null, tags: [...new Set(signals.map((s) => s.toLowerCase()))].sort(), savedCount: followers };
}

export async function rankTrailsForViewer(
  sc: any, viewer: PdeViewer, opts: { destination?: string | null; nowMs?: number; enabled?: boolean } = {},
): Promise<RankedKind<TrailRow>> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!(await flagOn(sc, nowMs, opts.enabled))) return { kind: "trails", status: "flag_off", rankedBy: "none", items: [] };
  const listed = await listTrails(sc, { destination: opts.destination ?? null, limit: 50 });
  if (listed.refusal) return { kind: "trails", status: "unavailable", rankedBy: "none", items: [], unavailable: String(listed.refusal) };
  if (listed.trails.length === 0) return { kind: "trails", status: "empty", rankedBy: "pde", items: [] };
  const ids = listed.trails.map((t) => t.id).slice(0, IN_LIST_CAP);
  const [sig, fol] = await Promise.all([
    sc.from("content_trails").select("trail_id, signal").in("trail_id", ids).eq("relationship", "signal").order("trail_id", { ascending: true }).limit(IN_LIST_CAP * 5),
    sc.from("trail_follows").select("trail_id").in("trail_id", ids).order("trail_id", { ascending: true }).limit(5_000),
  ]);
  if (sig.error || fol.error) return { kind: "trails", status: "unavailable", rankedBy: "none", items: [], unavailable: sig.error ? "content_trails" : "trail_follows" };
  const signals = new Map<string, string[]>(); const followers = new Map<string, number>();
  for (const r of (sig.data ?? []) as any[]) if (typeof r.signal === "string") signals.set(r.trail_id, [...(signals.get(r.trail_id) ?? []), r.signal]);
  for (const r of (fol.data ?? []) as any[]) followers.set(r.trail_id, (followers.get(r.trail_id) ?? 0) + 1);
  const items = await rankMapped(sc, viewer, listed.trails.map((t) => ({ place: trailAsPdePlace(t, signals.get(t.id) ?? [], followers.get(t.id) ?? 0), item: t })), nowMs);
  return { kind: "trails", status: "ranked", rankedBy: "pde", items };
}

// ── Shared Moments ───────────────────────────────────────────────────────────

export interface RankableMoment { id: string; ownerId: string; title: string | null; city: string | null; publishedAt: string }

export async function rankSharedMomentsForViewer(
  sc: any, viewer: PdeViewer, opts: { nowMs?: number; enabled?: boolean } = {},
): Promise<RankedKind<RankableMoment>> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!(await flagOn(sc, nowMs, opts.enabled))) return { kind: "shared_moments", status: "flag_off", rankedBy: "none", items: [] };
  const loaded = await loadSharedMomentCandidates(sc, viewer.userId);
  if (loaded.failed) return { kind: "shared_moments", status: "unavailable", rankedBy: "none", items: [], unavailable: "shared_moment_memberships" };
  // The Wall gate's two rules for a moment, applied here too: an owner not in
  // good standing drops it, and a block in either direction drops it. An
  // unreadable block set drops every moment (fail closed, Wall spec §23).
  const blocked = loaded.candidates.length > 0 ? await fetchBlockedSet(sc, viewer.userId) : new Set<string>();
  if (blocked === null) return { kind: "shared_moments", status: "unavailable", rankedBy: "none", items: [], unavailable: "blocks" };
  const rows = loaded.candidates
    .filter((c) => c.objectType === "shared_moment" && (c.authorAccountStatus ?? "active") === "active" && !c.isDeleted && !blocked.has(c.authorId))
    .map((c) => {
      const city = loaded.signals.get(c.canonicalObjectId)?.city ?? null;
      const item: RankableMoment = { id: c.canonicalObjectId, ownerId: c.authorId, title: c.text ?? null, city, publishedAt: c.publishedAt };
      const place: PdePlace = { id: `moment/${c.canonicalObjectId}`, category: null, tags: [], savedCount: 0 };
      return { place, item };
    });
  if (rows.length === 0) return { kind: "shared_moments", status: "empty", rankedBy: "pde", items: [] };
  return { kind: "shared_moments", status: "ranked", rankedBy: "pde", items: await rankMapped(sc, viewer, rows, nowMs) };
}

// ── emerging discoveries ─────────────────────────────────────────────────────

export interface EmergingPlace { place: MaterialisedPlace; trendState: string }

export async function rankEmergingForViewer(
  sc: any, viewer: PdeViewer, opts: { nowMs?: number; enabled?: boolean; category?: string | null } = {},
): Promise<RankedKind<EmergingPlace>> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!(await flagOn(sc, nowMs, opts.enabled))) return { kind: "emerging_discoveries", status: "flag_off", rankedBy: "none", items: [] };
  const cityPrefix = cityPrefixOf(viewer.city);
  if (!cityPrefix) return { kind: "emerging_discoveries", status: "empty", rankedBy: "none", items: [] };
  const ctx: RetrievalContext = { sc, userId: viewer.userId, cityPrefix, followedIds: viewer.followedIds, viewedPlaceIds: [], nowMs, memo: new Map() };
  let found: Array<{ id: string; state: string }>;
  try { found = await momentumPlaceIds(ctx, ["emerging", "rediscovered"], IN_LIST_CAP, "place_momentum.emerging"); }
  catch { return { kind: "emerging_discoveries", status: "unavailable", rankedBy: "none", items: [], unavailable: "place_momentum" }; }
  if (found.length === 0) return { kind: "emerging_discoveries", status: "empty", rankedBy: "pde", items: [] };
  const admitted = opts.category && opts.category !== "for_you" ? new Set([opts.category]) : null;
  const mat = await materialiseCandidates(sc, found.map((f) => f.id), { viewerId: viewer.userId, cityPrefix, admitted });
  if (mat.failedReads.includes("discovery_places")) return { kind: "emerging_discoveries", status: "unavailable", rankedBy: "none", items: [], unavailable: "discovery_places" };
  const state = new Map(found.map((f) => [f.id, f.state]));
  const rows = [...mat.rows.values()].map((p) => ({ place: p as PdePlace, item: { place: p, trendState: state.get(p.id) ?? "emerging" } }));
  if (rows.length === 0) return { kind: "emerging_discoveries", status: "empty", rankedBy: "pde", items: [] };
  return { kind: "emerging_discoveries", status: "ranked", rankedBy: "pde", items: await rankMapped(sc, viewer, rows, nowMs) };
}
