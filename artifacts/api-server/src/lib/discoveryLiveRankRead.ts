/**
 * discoveryLiveRankRead — the gated read half of Sensing §8's live ranking.
 *
 * lib/discoveryLiveRank is pure. This module is the only thing that touches a
 * database for it: it reads the flag, asks the ONE live read path
 * (lib/liveClaimRead) whether it is allowed to look at all, fetches the
 * envelopes for the head window's canonical subjects, and hands both to the
 * engine.
 *
 * INERT UNTIL SEEDED ON — the same contract lib/discoveryCandidate states and
 * for the same reason: Discovery is a live surface. With
 * `discovery_live_rank_enabled` absent / false / unreadable,
 * `withDiscoveryLiveRank` returns THE SAME ARRAY REFERENCE it was given —
 * nothing copied, nothing re-ordered, no claim read, no flag-independent work
 * done — so the served JSON is byte-identical to today's. Migration 2850 seeds
 * the flag FALSE and refuses to commit it ON.
 *
 * FAIL-SAFE, NOT FAIL-QUIET. Two different failures are kept apart, because
 * §20 says they are different facts:
 *   • the live gates are CLOSED (pilot off, scope unpromoted, kill switch) —
 *     every row is graded `readable: false` and labelled `unreadable`; nothing
 *     moves, and the response says the read was refused;
 *   • the gates are open and a place simply has no current claim — the row is
 *     labelled `none`; nothing moves either, but for the opposite reason.
 * An exception anywhere in here is caught and the incoming order is served
 * unchanged. A ranking layer must never be able to empty a feed.
 *
 * NEVER PERSISTED. The grades are properties of THIS serve (freshness, ETA,
 * the mode the caller asked for), so they are attached to the outgoing slice
 * and never written into Cache A / L2, exactly as lib/discoveryCandidate's
 * projection is not.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { liveLabelsServable, readLiveClaimEnvelopes, type LiveClaimEnvelope } from "./liveClaimRead.js";
import {
  DISCOVERY_INTENT_MODES,
  LIVE_RANK_WINDOW,
  rankDiscoveryLive,
  type DiscoveryIntentMode,
  type DiscoveryLiveRank,
  type LiveRankRow,
} from "./discoveryLiveRank.js";

/** Literal name so check-flag-polarity resolves the read. `*_enabled` ⇒ capability, fail-closed. */
export const DISCOVERY_LIVE_RANK_FLAG = "discovery_live_rank_enabled";

/** Concurrent live reads. Mirrors CompassLiveConstraints' LIVE_INTEL_CONCURRENCY. */
export const LIVE_READ_CONCURRENCY = 8;

/** The claim families the ranker consumes. Nothing else is read, so nothing else can leak. */
export const RANK_CLAIM_TYPES = [
  "crowd.level", "crowd.trajectory", "vibe.state", "queue.wait", "access.walk_in",
] as const;

/** The subset of a served row this module needs. Structural — the Map could pass its own. */
export interface LiveRankSourceRow {
  id: string;
  canonicalPlaceId?: string | null;
  distanceKm?: number | null;
}

/** Parse a caller-supplied mode — the shared parser (lib/intentModes), re-exported under Discovery's name. */
export { parseIntentMode } from "./intentModes.js";

// ── Flag (cached 30 s, mirrors discoveryCandidate) ────────────────────────────

const FLAG_TTL_MS = 30_000;
let _flagCache: { value: boolean; at: number } | null = null;

/** Invalidate the flag cache. Exported for tests. */
export function invalidateLiveRankFlagCache(): void {
  _flagCache = null;
}

export async function liveRankEnabled(sc: any): Promise<boolean> {
  if (_flagCache && Date.now() - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  let value = false;
  try { value = await isFlagEnabled(sc, DISCOVERY_LIVE_RANK_FLAG); } catch { value = false; }
  _flagCache = { value, at: Date.now() };
  return value;
}

/** Bounded-concurrency map. Order-preserving. */
async function mapLimit<A, B>(items: readonly A[], limit: number, fn: (item: A) => Promise<B>): Promise<B[]> {
  const out = new Array<B>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface LiveRankServeOptions {
  mode?: DiscoveryIntentMode | null;
  nowMs?: number;
  queueToleranceMinutes?: number | null;
  /** Injectable for tests; defaults to the gated live read. */
  readEnvelopes?: (subjectId: string) => Promise<LiveClaimEnvelope[]>;
  /** Injectable for tests; defaults to lib/liveClaimRead.liveLabelsServable. */
  gatesOpen?: () => Promise<boolean>;
}

export interface LiveRankServeOutcome<T> {
  places: T[];
  /** True only when the flag was on AND the engine actually ran. */
  applied: boolean;
  /** False ⇒ the live gates refused; every row is `unreadable`, nothing moved. */
  readable: boolean;
  mode: DiscoveryIntentMode | null;
  byId: Map<string, DiscoveryLiveRank>;
  windowSize: number;
  demoted: number;
}

/**
 * The one call a serve point makes. Flag OFF ⇒ `{ places, applied: false }`
 * with `places` the SAME reference. Flag ON ⇒ a re-ordered array whose window
 * rows carry nothing new by themselves — the grades are returned separately so
 * the caller decides whether they reach the wire.
 */
export async function withDiscoveryLiveRank<T extends LiveRankSourceRow>(
  sc: any,
  places: T[],
  opts: LiveRankServeOptions = {},
): Promise<LiveRankServeOutcome<T>> {
  const empty: LiveRankServeOutcome<T> = {
    places, applied: false, readable: false, mode: opts.mode ?? null,
    byId: new Map(), windowSize: 0, demoted: 0,
  };
  if (!Array.isArray(places) || places.length === 0) return empty;
  let on = false;
  try { on = await liveRankEnabled(sc); } catch { on = false; }
  if (!on) return empty;

  const mode: DiscoveryIntentMode = opts.mode ?? "explore";
  const nowMs = opts.nowMs ?? Date.now();
  const now = new Date(nowMs);
  try {
    const gatesOpen = opts.gatesOpen ?? (() => liveLabelsServable(sc));
    let readable = false;
    try { readable = await gatesOpen(); } catch { readable = false; }

    const head = places.slice(0, LIVE_RANK_WINDOW);
    const read = opts.readEnvelopes
      ?? ((subjectId: string) => readLiveClaimEnvelopes(sc, subjectId, { claimTypes: RANK_CLAIM_TYPES, now }));

    const rows: Array<LiveRankRow & { source: T }> = await mapLimit(head, LIVE_READ_CONCURRENCY, async (p) => {
      const subjectId = typeof p.canonicalPlaceId === "string" && p.canonicalPlaceId ? p.canonicalPlaceId : null;
      let envelopes: LiveClaimEnvelope[] = [];
      let rowReadable = readable && subjectId !== null;
      if (rowReadable && subjectId) {
        try { envelopes = await read(subjectId); } catch { envelopes = []; rowReadable = false; }
      }
      return {
        id: p.id,
        subjectId,
        envelopes,
        // A row with no canonical subject was never LOOKED at: that is
        // "could not look", not "looked and saw nothing". Grading it `none`
        // would say an OSM row with no canonical bridge is quiet.
        readable: rowReadable,
        distanceKm: typeof p.distanceKm === "number" ? p.distanceKm : null,
        source: p,
      };
    });

    const outcome = rankDiscoveryLive(rows, {
      mode, nowMs, queueToleranceMinutes: opts.queueToleranceMinutes ?? null,
    });
    const reordered = [...outcome.ranked.map((r) => r.source), ...places.slice(LIVE_RANK_WINDOW)];
    return {
      places: reordered, applied: true, readable, mode,
      byId: outcome.byId, windowSize: outcome.windowSize, demoted: outcome.demoted,
    };
  } catch {
    // A ranking layer may never empty or truncate a feed.
    return { ...empty, mode };
  }
}
