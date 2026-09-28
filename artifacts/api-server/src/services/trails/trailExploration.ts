/**
 * trailExploration — `02` §7's in-Trail content lifecycle and §9's fair
 * exposure, as MACHINERY that drives what a Trail serves (census-discovery §86,
 * lane W10-T: DC-04, DV-21, DV-22).
 *
 * EVERYTHING HERE IS BEHIND `discovery_trail_exploration_enabled` (3485, seeded
 * FALSE). The owner lifted the 2026-08-15 ranker hold for designs built behind
 * new FALSE flags; this is one. With the flag off, `getTrailModules` never
 * calls into this file and serves byte for byte what it served before
 * (discoveryTrailExploration.test.ts G0).
 *
 * WHAT MOVES A MEMBER BETWEEN §7'S SIX STATES (register D-W10T-3)
 * =============================================================
 * §9's own steps, evaluated on the MEASURED response — `rank_events` on the
 * Discovery surface, the rows whose outcomes are recorded (step 3, "evaluate
 * normalized response"):
 *
 *   verdict   `evaluating` below TRAIL_EXPOSURE_MIN_EVIDENCE impressions;
 *             otherwise `expand` at a positive rate ≥ TRAIL_EXPOSURE_EXPAND_RATE,
 *             else `taper` (lib/discoveryTrailHealth — the thresholds §9 already
 *             uses, not new ones); `unmeasured` when the read failed or was cut.
 *
 *   just_arrived, rediscovered  taper → archived_from_active_rotation (step 4)
 *                               expand at the exploration ceiling → growing
 *                               past the 7-day horizon → growing (§8's horizon;
 *                               the neutral graduation — never a demotion)
 *   growing                     taper → archived_from_active_rotation
 *                               expand, sustained a further 7 days → featured
 *   featured                    taper → growing (one step down, not out)
 *                               expand, 30 days a member and 7 in this state → evergreen
 *   evergreen                   taper → archived_from_active_rotation
 *   archived_from_active_rotation  expand after a 7-day rest → rediscovered (step 5)
 *
 * Every move is in 3381's relation (lib/discoveryTrailObject CONTENT_TRANSITIONS),
 * and the database refuses any other. A move that depends on how long a member
 * has been in its state needs 3486's `content_state_changed_at`; where that is
 * unread the move is not made (a guessed duration could promote early).
 *
 * WHERE THE TRAIL'S OWN SERVES GO (register D-W10T-6, §51.10 Q2)
 * ============================================================
 * `trail_member_exposures` (3487): per Trail, member and UTC day, a count, with
 * no viewer id. They count toward §9 steps 1-2's "has this item had its bounded
 * opportunity" (the qualification ceiling and the rotation order) and NOT toward
 * step 3's rate: a Trail page records no outcome, so adding its impressions to
 * the denominator would drag every rate toward taper for being shown.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger as rootLogger } from "../../lib/logger.js";
import { MOMENTUM_BASELINE_WINDOW_MS } from "../../lib/discoveryLocalMomentum.js";
import {
  TRAIL_EXPOSURE_MIN_EVIDENCE, TRAIL_EXPOSURE_EXPAND_RATE, TRAIL_EXPLORATION_IMPRESSION_CEILING, TRAIL_EXPLORATION_SLOT_PCT,
} from "../../lib/discoveryTrailHealth.js";
import { isTrailContentTransitionAllowed, isTrailContentState, type TrailContentState } from "../../lib/discoveryTrailObject.js";

const logger = rootLogger.child({ mod: "trailExploration" });

/** 3485. DV-22 / DV-21 / DC-04's machinery. */
export const TRAIL_EXPLORATION_FLAG = "discovery_trail_exploration_enabled";
/** 3485. DC-05's health order. */
export const TRAIL_HEALTH_ORDER_FLAG = "discovery_trail_health_order_enabled";

export interface TrailRankingFlags { exploration: boolean; healthOrder: boolean }

/** Both flags, read fail-closed (absent, FALSE and unreadable are all OFF). */
export async function readTrailRankingFlags(sc: any): Promise<TrailRankingFlags> {
  const [exploration, healthOrder] = await Promise.all([
    isFlagEnabled(sc, TRAIL_EXPLORATION_FLAG), isFlagEnabled(sc, TRAIL_HEALTH_ORDER_FLAG),
  ]);
  return { exploration, healthOrder };
}

const DAY = 86_400_000;
/** `02` §8: Just Arrived's own time horizon — the one the module always published and never applied (§51.6). */
export const JUST_ARRIVED_HORIZON_MS = 7 * DAY;
/** growing → featured, featured → evergreen: the response must hold for a further horizon of the same length. */
export const TRAIL_SUSTAIN_MS = 7 * DAY;
/** featured → evergreen: a member at least as old as the whole exposure window (`03` §3 "persistent usefulness"). */
export const TRAIL_EVERGREEN_MIN_AGE_MS = MOMENTUM_BASELINE_WINDOW_MS;
/** §9 step 5 "periodically retest": a cooled member rests this long before a retest slot. */
export const TRAIL_RETEST_INTERVAL_MS = 7 * DAY;

export interface MeasuredExposure { impressions: number; positives: number }
export type ExposureVerdict = "expand" | "taper" | "evaluating" | "unmeasured";

/** §9 step 3, on measured rows only. */
export function exposureVerdict(e: MeasuredExposure | null): ExposureVerdict {
  if (!e) return "unmeasured";
  const impressions = Math.max(0, Number(e.impressions) || 0);
  if (impressions < TRAIL_EXPOSURE_MIN_EVIDENCE) return "evaluating";
  return Math.max(0, Number(e.positives) || 0) / impressions >= TRAIL_EXPOSURE_EXPAND_RATE ? "expand" : "taper";
}

export interface ContentLifecycleInput {
  state: string;
  createdAtMs: number;
  /** 3486's stamp; `null` = the member never changed state; `undefined` = the stamp could not be read. */
  stateChangedAtMs: number | null | undefined;
  measured: MeasuredExposure | null;
  nowMs: number;
}

/** When the member entered its current state, or `null` when that cannot be known. */
export function stateSinceMs(i: Pick<ContentLifecycleInput, "state" | "createdAtMs" | "stateChangedAtMs">): number | null {
  if (i.state === "just_arrived") return Number.isFinite(i.createdAtMs) ? i.createdAtMs : null; // nothing moves a member INTO just_arrived
  if (i.stateChangedAtMs === undefined) return null;
  if (i.stateChangedAtMs === null) return Number.isFinite(i.createdAtMs) ? i.createdAtMs : null; // inserted in this state
  return i.stateChangedAtMs;
}

/** The §7 move this member is owed now, or `null`. Pure; every result is in 3381's relation. */
export function decideContentTransition(i: ContentLifecycleInput): TrailContentState | null {
  if (!isTrailContentState(i.state)) return null;
  const v = exposureVerdict(i.measured);
  const since = stateSinceMs(i);
  const inState = since === null ? null : i.nowMs - since;
  const age = Number.isFinite(i.createdAtMs) ? i.nowMs - i.createdAtMs : null;
  let to: TrailContentState | null = null;
  switch (i.state) {
    case "just_arrived":
    case "rediscovered":
      if (v === "taper") to = "archived_from_active_rotation";
      else if (v === "expand" && (i.measured?.impressions ?? 0) >= TRAIL_EXPLORATION_IMPRESSION_CEILING) to = "growing";
      else if (inState !== null && inState >= JUST_ARRIVED_HORIZON_MS) to = "growing";
      break;
    case "growing":
      if (v === "taper") to = "archived_from_active_rotation";
      else if (v === "expand" && inState !== null && inState >= TRAIL_SUSTAIN_MS) to = "featured";
      break;
    case "featured":
      if (v === "taper") to = "growing";
      else if (v === "expand" && inState !== null && inState >= TRAIL_SUSTAIN_MS && age !== null && age >= TRAIL_EVERGREEN_MIN_AGE_MS) to = "evergreen";
      break;
    case "evergreen":
      if (v === "taper") to = "archived_from_active_rotation";
      break;
    case "archived_from_active_rotation":
      if (v === "expand" && inState !== null && inState >= TRAIL_RETEST_INTERVAL_MS) to = "rediscovered";
      break;
  }
  return to !== null && isTrailContentTransitionAllowed(i.state, to) ? to : null;
}

/** Just Arrived holds a member while it is inside the horizon — or while how long it has been there cannot be known. */
export function insideJustArrivedHorizon(i: Pick<ContentLifecycleInput, "state" | "createdAtMs" | "stateChangedAtMs" | "nowMs">): boolean {
  const since = stateSinceMs(i);
  return since === null || i.nowMs - since < JUST_ARRIVED_HORIZON_MS;
}

export interface RotationCandidate {
  id: string;
  state: string;
  /** When it entered the backlog (arrival, or rediscovery). */
  queuedAtMs: number;
  /** The Trail's OWN serves of it over the window (3487). */
  trailImpressions: number;
  measured: MeasuredExposure | null;
  /** archived_from_active_rotation and rested TRAIL_RETEST_INTERVAL_MS. */
  retestDue: boolean;
}

/**
 * §9 steps 1, 2 and 5 over the WHOLE backlog, not the newest page (§51.6 (1)).
 * A new item qualifies while its total exposure — measured plus the Trail's own
 * — is under the ceiling and it has not tapered. The page's reserved slots
 * (TRAIL_EXPLORATION_SLOT_PCT, the budget §9 already used) go to the
 * LEAST-exposed qualified items first, oldest first on a tie, so each served
 * page raises the counts it served and the next page reaches further down the
 * backlog: rotation by denominator, deterministic, with no randomness. A cooled
 * item due a retest takes a slot only when no new item is waiting.
 */
export function rotateExplorationSlots(cands: readonly RotationCandidate[], pageSize: number): string[] {
  const total = (c: RotationCandidate) => Math.max(0, c.trailImpressions) + Math.max(0, c.measured?.impressions ?? 0);
  const fresh = cands.filter((c) => (c.state === "just_arrived" || c.state === "rediscovered")
    && exposureVerdict(c.measured) !== "taper" && total(c) < TRAIL_EXPLORATION_IMPRESSION_CEILING);
  const retest = cands.filter((c) => c.state === "archived_from_active_rotation" && c.retestDue);
  const order = (a: RotationCandidate, b: RotationCandidate) =>
    total(a) - total(b) || a.queuedAtMs - b.queuedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const queue = fresh.length > 0 ? [...fresh].sort(order) : [...retest].sort(order).slice(0, 1);
  if (queue.length === 0) return [];
  const budget = Math.floor((Math.max(0, pageSize) * TRAIL_EXPLORATION_SLOT_PCT) / 100);
  return queue.slice(0, Math.max(1, Math.min(budget, queue.length))).map((c) => c.id);
}

// ── I/O: each read fails soft to "unknown", never to a fabricated zero ─────────

/** The Trail's own serves per member over the window, keyed `source_type:source_id`; `null` when unread. */
export async function readTrailOwnExposures(sc: any, trailId: string, nowMs: number): Promise<Record<string, number> | null> {
  const since = new Date(nowMs - MOMENTUM_BASELINE_WINDOW_MS).toISOString().slice(0, 10);
  try {
    const { data, error } = await sc.from("trail_member_exposures").select("source_type, source_id, impressions")
      .eq("trail_id", trailId).gte("served_on", since);
    if (error || !Array.isArray(data)) {
      logger.warn({ trailId, code: error?.code }, "trail own exposures unread — exploration slots withheld");
      return null;
    }
    const out: Record<string, number> = {};
    for (const r of data as any[]) {
      const k = `${r.source_type}:${r.source_id}`;
      out[k] = (out[k] ?? 0) + Math.max(0, Number(r.impressions) || 0);
    }
    return out;
  } catch {
    return null;
  }
}

/** 3486's stamp per membership row; `null` when the column or the read is unavailable. */
export async function readStateChangedAt(sc: any, rowIds: readonly string[]): Promise<Map<string, number | null> | null> {
  if (rowIds.length === 0) return new Map();
  try {
    const { data, error } = await sc.from("content_trails").select("id, content_state_changed_at").in("id", [...rowIds]);
    if (error || !Array.isArray(data)) return null;
    const out = new Map<string, number | null>();
    for (const r of data as any[]) {
      const at = typeof r.content_state_changed_at === "string" ? Date.parse(r.content_state_changed_at) : NaN;
      out.set(String(r.id), Number.isFinite(at) ? at : null);
    }
    return out;
  } catch {
    return null;
  }
}

export interface ContentTransition { rowId: string; from: TrailContentState; to: TrailContentState }

/**
 * Persist decided moves, each a compare-and-set on the state it was decided
 * from, under 3381's trigger. A lost race (0 rows) or a refusal is logged and
 * skipped: the next read decides again from what the row now holds.
 */
export async function persistContentTransitions(sc: any, moves: readonly ContentTransition[]): Promise<number> {
  let written = 0;
  for (const m of moves) {
    try {
      const { data, error } = await sc.from("content_trails").update({ content_state: m.to })
        .eq("id", m.rowId).eq("content_state", m.from).select("id");
      if (error) { logger.warn({ rowId: m.rowId, code: error?.code }, "content transition not written"); continue; }
      if (Array.isArray(data) && data.length > 0) written += 1;
    } catch (err) {
      logger.warn({ rowId: m.rowId, err: (err as Error)?.message }, "content transition not written");
    }
  }
  return written;
}

/** Count one page's served members, once each (3487). */
export async function recordTrailModuleExposures(
  sc: any, trailId: string, items: ReadonlyArray<{ sourceType: string; sourceId: string }>, nowMs: number,
): Promise<"written" | "skipped" | "failed"> {
  const seen = new Set<string>();
  const payload = items.filter((i) => {
    const k = `${i.sourceType}:${i.sourceId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((i) => ({ source_type: i.sourceType, source_id: i.sourceId }));
  if (payload.length === 0) return "skipped";
  try {
    const { error } = await sc.rpc("trail_record_member_exposures", {
      p_trail_id: trailId, p_items: payload, p_at: new Date(nowMs).toISOString(),
    });
    if (error) { logger.warn({ trailId, code: error?.code }, "trail module exposures not counted"); return "failed"; }
    return "written";
  } catch {
    return "failed";
  }
}
