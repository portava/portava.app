/**
 * The Memory outbox consumer — §17's missing half.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §17 "Use an outbox pattern: canonical mutation and event-outbox insert
 *        occur in one database transaction. CONSUMERS MUST BE IDEMPOTENT and
 *        may rebuild disposable projections asynchronously."
 *   §18  Projections and Derived Artifact Registry — what this feeds.
 *   §23  "Search/index workers consume privacy-filtered event payloads where
 *        possible rather than raw entire rows."
 *   §24  projection_lag; reason codes; failure class.
 *   §28.11 "Never swallow projection/schema failures into plausible-looking
 *        empty history without structured error state."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════════
 * `src/lib/memoryOutbox.ts` states the gap in its own header: "NO CONSUMER
 * EXISTS. Rows accumulate in memory_event_outbox with published_at IS NULL",
 * and migration 2710's COMMENT ON TABLE says the same to anyone reading the
 * database. The census scores it H161 NOT-BUILT: "There are no consumers.
 * memoryOutbox.ts records that published_at, attempts and last_error are
 * columns no code writes." An emitter with no consumer is not a finished
 * outbox — it is a queue that only fills.
 *
 * This is that consumer.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE DUAL-WRITE HAZARD, AND WHY THIS IS NOT ONE
 * ══════════════════════════════════════════════════════════════════════════════
 * A previous lane refused to add a TypeScript emit for the domain events, and
 * was right to: supabase-js has no transactions, so a "write the row, then
 * write the event" pair can leave a Memory changed with no event or an event
 * for a change that never landed. NOTHING IN THIS FILE EMITS. The emit stays
 * where it belongs, inside public.memory_kernel_execute (migration 2711), in
 * the same transaction as the canonical write.
 *
 * This file only READS the outbox and moves its bookkeeping forward, and even
 * that is not done with raw table writes: `published_at`, `attempts`,
 * `last_error` and the lease are moved by three SQL functions (migration 2994)
 * so that the claim is a single atomic statement under FOR UPDATE SKIP LOCKED.
 * A claim assembled from a SELECT and a later UPDATE would be a second write
 * path that can diverge — the very thing the outbox exists to prevent — and it
 * would hand the same event to two workers under concurrency.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * AT-LEAST-ONCE, AND WHAT MAKES THAT SAFE
 * ══════════════════════════════════════════════════════════════════════════════
 * Order of operations is CLAIM -> REBUILD -> ACK. A crash between rebuild and
 * ack redelivers the event. That is deliberate: acking first would drop events
 * silently on a crash, which is worse and is unrecoverable. §17's "consumers
 * must be idempotent" is the contract that makes redelivery harmless, and it
 * is satisfied structurally rather than by care:
 *
 *   - `rebuildProjection` UPSERTs on (projection_id, scope_key). Rebuilding the
 *     same scope twice writes the same registration; §25's H244 proves it
 *     replay-safe.
 *   - `memory_outbox_ack` filters on `published_at IS NULL`, so a second ack of
 *     the same id updates zero rows instead of rewriting the publish time.
 *   - Two workers cannot claim one row: the lease plus SKIP LOCKED makes the
 *     batches disjoint.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE supabase-js FACT EVERY READ HERE IS BUILT AROUND
 * ══════════════════════════════════════════════════════════════════════════════
 * The client RESOLVES on a database error. `const { data } = await sc.rpc(...)`
 * with `.error` unbound binds `data` to null for an absent function, an RLS
 * refusal and a transient outage alike — and `data ?? []` then reads exactly
 * like "there was nothing to publish". A worker built that way would report a
 * clean run forever while every projection went stale, which is §24's
 * projection_lag measured as zero because nothing was measured. Every call
 * below binds `error`, and every failure is a discriminated refusal.
 *
 * There is no try/catch around a supabase call in this file: the promise
 * resolves, it does not throw, so such a catch would be dead code. The one
 * try/catch is around `rebuildProjection`, which is our own code and can throw.
 */

import {
  MEMORY_DOMAIN_EVENT_TYPES,
  isMemoryEventType,
  type MemoryEventType,
} from "../../lib/memoryOutbox.js";
import { rebuildProjection } from "./derivativeRegistry.js";
import type { ProjectionId, ProjectionScope } from "./projectionRegistry.js";
import {
  buildProjectionLagSample,
  recordProjectionLag,
  type MetricLogger,
} from "../memory/memoryKernelMetrics.js";

/** The three SQL entry points migration 2994 provides. Named once. */
export const OUTBOX_CLAIM_FN = "memory_outbox_claim";
export const OUTBOX_ACK_FN = "memory_outbox_ack";
export const OUTBOX_FAIL_FN = "memory_outbox_fail";

/**
 * WHICH PROJECTIONS EACH EVENT INVALIDATES.
 *
 * TOTAL over the eight Memory-domain events on purpose: a `Record<K, V>` with
 * no index signature makes a missing event a COMPILE error, so a ninth event
 * added to §17's vocabulary cannot quietly arrive with no subscriber. That is
 * the failure mode migration 2710's type CHECK is guarding on the write side
 * ("a typo'd event type is a projection that silently never fires"); this is
 * the same guard on the read side.
 *
 * WHY THE SETS ARE BROAD. Every §18 projection listed here draws from
 * `memories`, so any change to a Memory can change any of them. A narrower map
 * would be a performance optimisation bought with a correctness risk — a
 * projection left stale because someone judged an event could not affect it —
 * and rebuilds are idempotent upserts, so the cost of being broad is work, not
 * wrongness. `SearchEmbedding` and `NarrativeDerivative` are deliberately
 * absent: both are NOT_CONFIGURED in the registry and rebuilding them refuses
 * by design.
 */
const OWNER_SURFACES: readonly ProjectionId[] = [
  "MemoryTimelineProjection",
  "PassportMemoryProjection",
  "ProfileHighlightProjection",
  "PlaceMemoryProjection",
  "PeopleMemoryProjection",
  "CompassMemoryProjection",
  "PublicMemoryProjection",
];
const TRIP_SURFACES: readonly ProjectionId[] = ["TripMemoryProjection", "MapTrailDerivative"];
const ALL_SURFACES: readonly ProjectionId[] = [...OWNER_SURFACES, ...TRIP_SURFACES];

export const EVENT_PROJECTIONS: Readonly<
  Record<Extract<MemoryEventType, `memory.${string}`>, readonly ProjectionId[]>
> = Object.freeze({
  "memory.created": ALL_SURFACES,
  "memory.confirmed": ALL_SURFACES,
  "memory.corrected": ALL_SURFACES,
  "memory.merged": ALL_SURFACES,
  "memory.split": ALL_SURFACES,
  "memory.archived": ALL_SURFACES,
  "memory.deleted": ALL_SURFACES,
  // A visibility change cannot alter a Memory's content, but it changes which
  // audience each surface may show it to, which is every surface.
  "memory.visibility_changed": ALL_SURFACES,
});

export interface ClaimedOutboxRow {
  id: number;
  event_id: string;
  memory_id: string;
  type: string;
  created_at: string;
  attempts: number;
  locked_until: string | null;
}

export type OutboxClaimResult =
  | { ok: true; rows: ClaimedOutboxRow[] }
  | { ok: false; reason: "claim_unavailable"; detail: string };

/**
 * Claim a batch under a lease.
 *
 * A non-array body is `claim_unavailable`, NOT an empty batch, for
 * readUnpublishedOutbox's reason: guessing is how a schema surprise becomes a
 * plausible-looking empty history (§28.11).
 */
export async function claimOutboxBatch(
  sc: any,
  opts: { limit?: number; leaseSeconds?: number; maxAttempts?: number } = {},
): Promise<OutboxClaimResult> {
  const { data, error } = await sc.rpc(OUTBOX_CLAIM_FN, {
    p_limit: opts.limit ?? 100,
    p_lease_seconds: opts.leaseSeconds ?? 300,
    p_max_attempts: opts.maxAttempts ?? 5,
  });
  if (error) {
    return { ok: false, reason: "claim_unavailable", detail: error.message ?? String(error) };
  }
  if (!Array.isArray(data)) {
    return {
      ok: false,
      reason: "claim_unavailable",
      detail: "claim returned a non-array body",
    };
  }
  return { ok: true, rows: data as ClaimedOutboxRow[] };
}

export type OutboxAckResult =
  | { ok: true; acked: number }
  | { ok: false; reason: "ack_unavailable"; detail: string };

/**
 * Ack the ids whose rebuilds all succeeded.
 *
 * THE RETURNED COUNT IS CHECKED, and this is not defensive noise. An UPDATE
 * matching zero rows raises nothing in PostgreSQL and resolves cleanly in
 * supabase-js, so a consumer that ignored the count could loop forever:
 * claiming the same rows, rebuilding the same projections, acking nothing, and
 * reporting a clean drain every pass. The function returns the number ACTUALLY
 * acked precisely so that cannot happen quietly, and an ack short of the batch
 * is surfaced rather than averaged away.
 */
export async function ackOutboxRows(sc: any, ids: readonly number[]): Promise<OutboxAckResult> {
  if (ids.length === 0) return { ok: true, acked: 0 };
  const { data, error } = await sc.rpc(OUTBOX_ACK_FN, { p_ids: [...ids] });
  if (error) {
    return { ok: false, reason: "ack_unavailable", detail: error.message ?? String(error) };
  }
  if (typeof data !== "number") {
    return {
      ok: false,
      reason: "ack_unavailable",
      detail: `ack returned ${typeof data}, not a count`,
    };
  }
  return { ok: true, acked: data };
}

/** Record a failure CLASS against one row and release its lease. */
export async function failOutboxRow(
  sc: any,
  id: number,
  failureClass: string,
): Promise<{ ok: boolean; detail?: string }> {
  const { error } = await sc.rpc(OUTBOX_FAIL_FN, { p_id: id, p_class: failureClass });
  if (error) return { ok: false, detail: error.message ?? String(error) };
  return { ok: true };
}

/**
 * The scope a Memory's projections are rebuilt at.
 *
 * READ UNDER THE CONSUMER'S OWN AUTHORIZATION, which is §23's rule stated
 * exactly: the event payload is privacy-filtered and carries ids only, so a
 * consumer that needs the row reads it itself rather than learning it by
 * subscribing. What comes back here is the scope KEYS — owner, trip, place —
 * and never the Memory's title, caption, coordinates or media.
 */
export type ScopeResult =
  | { ok: true; scope: ProjectionScope }
  | { ok: false; reason: "memory_unavailable" | "memory_absent"; detail: string };

export async function readProjectionScope(sc: any, memoryId: string): Promise<ScopeResult> {
  const { data, error } = await sc
    .from("memories")
    .select("id, owner_id, trip_id, place_id")
    .eq("id", memoryId)
    .maybeSingle();

  if (error) {
    return { ok: false, reason: "memory_unavailable", detail: error.message ?? String(error) };
  }
  if (!data || typeof data.owner_id !== "string") {
    // A HARD-DELETED Memory is a real, expected case and is NOT an outage: the
    // event outlives the row, because memory_event_outbox.memory_id is
    // deliberately not a foreign key. Distinguished from `memory_unavailable`
    // so the caller can ack the event rather than retry it forever.
    return { ok: false, reason: "memory_absent", detail: `no memories row for ${memoryId}` };
  }
  return {
    ok: true,
    scope: {
      owner_id: data.owner_id,
      viewer_id: data.owner_id,
      trip_id: typeof data.trip_id === "string" ? data.trip_id : null,
      place_id: typeof data.place_id === "string" ? data.place_id : null,
    },
  };
}

export interface EventOutcome {
  id: number;
  eventId: string;
  eventType: string;
  memoryId: string;
  rebuilt: number;
  skipped: number;
  failed: number;
  /** Set when the event could not be completed. A class, never a message body. */
  failureClass: string | null;
}

export interface DrainResult {
  /** False only when the outbox itself could not be read or acked. */
  ok: boolean;
  claimed: number;
  acked: number;
  failed: number;
  /** A class when the PASS failed, as distinct from an individual event. */
  failureClass: string | null;
  detail: string | null;
  outcomes: EventOutcome[];
}

/**
 * Rebuild every projection one event invalidates.
 *
 * `projection_not_configured` IS NOT A FAILURE. SearchEmbedding and
 * NarrativeDerivative refuse by design, and counting a designed refusal as an
 * error would burn the row's attempts until it was poisoned and stopped being
 * delivered — a correct event discarded because part of the system is honestly
 * unbuilt. It is counted as SKIPPED, which is a number the caller can see.
 */
async function rebuildForEvent(
  sc: any,
  row: ClaimedOutboxRow,
  scope: ProjectionScope,
  now: Date,
): Promise<{ rebuilt: number; skipped: number; failed: number; failureClass: string | null }> {
  const projections = isMemoryEventType(row.type)
    ? (EVENT_PROJECTIONS as Record<string, readonly ProjectionId[]>)[row.type]
    : undefined;

  if (!projections) {
    // An event type nobody subscribes to. Not retryable — the next attempt
    // would reach the same conclusion — so it is reported as a named class and
    // the caller acks it rather than looping.
    return { rebuilt: 0, skipped: 0, failed: 0, failureClass: "unsubscribed_event_type" };
  }

  let rebuilt = 0;
  let skipped = 0;
  let failed = 0;
  let failureClass: string | null = null;

  for (const projectionId of projections) {
    // Scope-dependent projections build nothing without their key, and asking
    // for a trip recap with no trip is not an error — it is a projection that
    // does not apply to this Memory.
    if (
      (projectionId === "TripMemoryProjection" || projectionId === "MapTrailDerivative") &&
      !scope.trip_id
    ) {
      skipped += 1;
      continue;
    }

    let result: Awaited<ReturnType<typeof rebuildProjection>>;
    try {
      result = await rebuildProjection(sc, projectionId, scope, now);
    } catch (err) {
      // Our own code threw. Distinct from a refusal, and retryable.
      failed += 1;
      failureClass = failureClass ?? "rebuild_threw";
      continue;
    }

    if (result.ok) {
      rebuilt += 1;
      continue;
    }
    if (result.reason === "projection_not_configured" || result.reason === "unknown_projection") {
      skipped += 1;
      continue;
    }
    failed += 1;
    failureClass = failureClass ?? result.reason;
  }

  return { rebuilt, skipped, failed, failureClass };
}

/**
 * Drain one batch: claim, rebuild, ack the clean ones, mark the rest failed.
 *
 * ACKS ARE BATCHED, FAILURES ARE NOT. Every event that completed is acked in
 * one call; every event that did not gets its own `memory_outbox_fail` so its
 * class is recorded against the right row. An event whose Memory is GONE is
 * ACKED rather than failed — there is nothing left to project and retrying
 * cannot change that, so leaving it unpublished would make it a permanent
 * resident of the backlog.
 */
export async function drainMemoryOutbox(
  sc: any,
  opts: {
    limit?: number;
    leaseSeconds?: number;
    maxAttempts?: number;
    now?: Date;
    logger?: MetricLogger;
  } = {},
): Promise<DrainResult> {
  const empty: DrainResult = {
    ok: true, claimed: 0, acked: 0, failed: 0,
    failureClass: null, detail: null, outcomes: [],
  };

  const claim = await claimOutboxBatch(sc, opts);
  if (!claim.ok) {
    // An unreadable outbox is NEVER an empty one (§28.11).
    return { ...empty, ok: false, failureClass: claim.reason, detail: claim.detail };
  }
  if (claim.rows.length === 0) return empty;

  const now = opts.now ?? new Date();
  const ackable: number[] = [];
  const outcomes: EventOutcome[] = [];
  let failed = 0;

  for (const row of claim.rows) {
    const startedAtMs = Date.now();
    const scopeResult = await readProjectionScope(sc, row.memory_id);

    let outcome: EventOutcome;
    if (!scopeResult.ok && scopeResult.reason === "memory_absent") {
      // Nothing to project and nothing a retry would fix.
      outcome = {
        id: row.id, eventId: row.event_id, eventType: row.type, memoryId: row.memory_id,
        rebuilt: 0, skipped: 0, failed: 0, failureClass: "memory_absent",
      };
      ackable.push(row.id);
    } else if (!scopeResult.ok) {
      outcome = {
        id: row.id, eventId: row.event_id, eventType: row.type, memoryId: row.memory_id,
        rebuilt: 0, skipped: 0, failed: 1, failureClass: scopeResult.reason,
      };
      failed += 1;
      await failOutboxRow(sc, row.id, scopeResult.reason);
    } else {
      const r = await rebuildForEvent(sc, row, scopeResult.scope, now);
      outcome = {
        id: row.id, eventId: row.event_id, eventType: row.type, memoryId: row.memory_id,
        rebuilt: r.rebuilt, skipped: r.skipped, failed: r.failed, failureClass: r.failureClass,
      };
      if (r.failed > 0) {
        failed += 1;
        await failOutboxRow(sc, row.id, r.failureClass ?? "rebuild_failed");
      } else {
        // Includes `unsubscribed_event_type`: a retry reaches the same answer,
        // so the row is acked with its class recorded in the outcome.
        ackable.push(row.id);
      }
    }

    outcomes.push(outcome);

    const finishedAtMs = Date.now();
    recordProjectionLag(
      opts.logger,
      buildProjectionLagSample({
        eventId: row.event_id,
        eventType: row.type,
        memoryId: row.memory_id,
        enqueuedAtMs: Date.parse(row.created_at),
        startedAtMs,
        finishedAtMs,
        projectionsRebuilt: outcome.rebuilt,
        projectionsSkipped: outcome.skipped,
        projectionsFailed: outcome.failed,
        failureClass: outcome.failureClass,
      }),
    );
  }

  const ack = await ackOutboxRows(sc, ackable);
  if (!ack.ok) {
    return {
      ok: false, claimed: claim.rows.length, acked: 0, failed,
      failureClass: ack.reason, detail: ack.detail, outcomes,
    };
  }
  if (ack.acked !== ackable.length) {
    // Reported, not averaged away: the rows we believed we finished are not the
    // rows the database marked published, and a consumer that shrugged at this
    // would re-do the difference on every pass forever.
    return {
      ok: false, claimed: claim.rows.length, acked: ack.acked, failed,
      failureClass: "ack_incomplete",
      detail: `acked ${ack.acked} of ${ackable.length} completed events`,
      outcomes,
    };
  }

  return {
    ok: true, claimed: claim.rows.length, acked: ack.acked, failed,
    failureClass: null, detail: null, outcomes,
  };
}

/** Exported for the test that asserts the map is total over §17's memory.* set. */
export const SUBSCRIBED_EVENT_TYPES: readonly string[] = MEMORY_DOMAIN_EVENT_TYPES;
