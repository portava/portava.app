/**
 * memoryAudienceRevocation — §21 / §28.8 on the Memory surface.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Spec v1
 *       §21 "Privacy changes must revoke derived artifacts and cached
 *            projections, not merely stop producing new ones."
 *       §28.8 "A narrowed or deleted Memory must not survive inside a
 *            derivative."
 *
 * CENSUS: H189 / H190. Section D.4 recorded both as W with the remaining half
 * named in one sentence: "`compass_feed_cache` is still never invalidated on a
 * memory visibility change". That was measured, not guessed — at `7d1f2d498`,
 *
 *     grep -n "CompassCacheEngine\|invalidate" src/routes/memories.ts
 *
 * returned NOTHING, while `routes/highlights.ts:977` has called
 * `invalidateCompassCache(sc, user.id, "highlight_deleted")` since the archive
 * work landed. The sibling surface revokes; this one never has.
 *
 * ── WHY THIS IS NOT ONE LINE IN THE ROUTE ──────────────────────────────────
 *
 * `invalidate(db, userId, reason)` is keyed by ONE user, and the user whose
 * cache holds a Memory is almost never the user who narrowed it. Copying the
 * highlights one-liner would invalidate the OWNER's feed — the one reader whose
 * access did not change — and leave the Memory sitting in the caches of every
 * person who just lost it. That is the failure this file exists to avoid, so
 * the targets are RESOLVED rather than assumed.
 *
 * ── THREE DECISIONS, EACH BECAUSE OF A SPECIFIC WAY THIS GOES WRONG ────────
 *
 * 1. ANY AUDIENCE-AFFECTING CHANGE REVOKES. `audienceChanged` does not try to
 *    prove a change was a NARROWING. `public -> friends_only` obviously is;
 *    `custom -> custom` with one id swapped is too, and so is a `trip_id` move
 *    between two crews. A rank ladder over six visibility classes is not a
 *    total order (crew and circle are incomparable), so any ladder would be
 *    wrong for some pair, and being wrong here means a revoked Memory stays
 *    readable out of a cache. Over-invalidating costs a cache miss. Under-
 *    invalidating is the defect. So the predicate is "did the audience inputs
 *    change at all".
 *
 * 2. `public` IS NOT ENUMERABLE, AND THIS FILE SAYS SO OUT LOUD. When the
 *    previous audience was `public` the set of people who lost access is
 *    "everyone", and no query returns it. The report carries
 *    `unboundedAudience: "public"` and the bounded proxy below is invalidated
 *    instead: the people who LIKED, SAVED or were TAGGED on that Memory — the
 *    readers most likely to be holding it. That is a mitigation, not a
 *    complete revocation, and calling it complete is exactly the kind of
 *    decorated green this census exists to catch. H189 stays W on this half.
 *
 * 3. A FAILED LOOKUP IS RECORDED, NEVER SILENTLY DROPPED. supabase-js RESOLVES
 *    on a database error, so `(data ?? [])` on an unreadable `trip_members`
 *    yields an empty crew and a revocation that quietly skips every crew
 *    member. Every read here binds `.error`, and a failure appends to
 *    `degraded[]` so the report distinguishes "nobody to revoke" from "we could
 *    not find out who to revoke".
 *
 * PURE RESOLUTION, INJECTED EFFECT. `resolveRevocationTargets` does the reads
 * and no invalidation; `revokeMemoryAudienceCaches` performs the effect through
 * an injected invalidator so a test can observe it without a Compass stack.
 */

import { invalidate as compassInvalidate } from "../../compass/CompassCacheEngine.js";
import { acceptedCrewOfTrip } from "./memoryReadPolicy.js";

export const AUDIENCE_REVOCATION_VERSION = "memory-audience-revocation@1";

/**
 * The upper bound on how many caches one Memory edit may evict, and the width
 * of the pool that evicts them.
 *
 * THIS IS A LATENCY BUDGET, STATED AS ONE. `CompassCacheEngine.invalidate`
 * issues THREE queries per user (read the keys, delete the rows, write the
 * audit row) and this revocation runs INSIDE a user-facing PATCH. Run
 * sequentially, an account with 500 mutual followers would turn one visibility
 * change into 1,500 serial round trips — several seconds of a write the user is
 * waiting on, which is a production incident, not a privacy win. Run unbounded
 * in parallel, the same edit opens 500 concurrent connections.
 *
 * So: a cap, and a fixed-width pool. 200 targets at width 10 is 20 rounds of
 * three queries — a few hundred milliseconds — and the cap is REPORTED when it
 * bites (`truncated: true`) rather than a cut-short set being presented as a
 * complete revocation.
 */
export const MAX_REVOCATION_TARGETS = 200;
export const REVOCATION_CONCURRENCY = 10;

/** The audience-bearing fields of a Memory row, snake_case as stored. */
export interface MemoryAudienceState {
  visibility?: string | null;
  allowed_user_ids?: string[] | null;
  hidden_user_ids?: string[] | null;
  trip_id?: string | null;
  state?: string | null;
}

export type RevocationReason =
  | "memory_visibility_changed"
  | "memory_deleted"
  | "memory_archived";

export interface DegradedLookup {
  table: string;
  error: unknown;
}

export interface RevocationReport {
  memory_id: string;
  reason: RevocationReason;
  /** Every user whose Compass cache this revocation evicted, sorted. */
  targets: string[];
  invalidated: number;
  /** Targets whose invalidation threw. `invalidate` swallows DB errors itself. */
  failed: string[];
  /**
   * Set when the PREVIOUS audience had no enumerable membership — today that is
   * exactly `public`. The bounded proxy was used instead; this is the half of
   * H189 that does not close here.
   */
  unbounded_audience: "public" | null;
  truncated: boolean;
  degraded: DegradedLookup[];
  /** The widest the eviction pool actually got. Never above REVOCATION_CONCURRENCY. */
  peak_in_flight: number;
  version: string;
}

function asIdList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function sameIdSet(a: unknown, b: unknown): boolean {
  const x = [...new Set(asIdList(a))].sort();
  const y = [...new Set(asIdList(b))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Did anything that decides WHO MAY READ this Memory change?
 *
 * `state` is in the list because `canReadMemory` refuses every non-owner read
 * of a row whose state is not `published` — so publishing, archiving and
 * deleting are all audience changes even when `visibility` is untouched.
 */
export function audienceChanged(prev: MemoryAudienceState, next: MemoryAudienceState): boolean {
  if ((prev.visibility ?? null) !== (next.visibility ?? null)) return true;
  if ((prev.trip_id ?? null) !== (next.trip_id ?? null)) return true;
  if ((prev.state ?? null) !== (next.state ?? null)) return true;
  if (!sameIdSet(prev.allowed_user_ids, next.allowed_user_ids)) return true;
  if (!sameIdSet(prev.hidden_user_ids, next.hidden_user_ids)) return true;
  return false;
}

/** Merge a patch over the row as it was, in the snake_case the row uses. */
export function mergedAudience(
  existing: MemoryAudienceState,
  patch: Record<string, unknown>,
): MemoryAudienceState {
  const pick = <K extends keyof MemoryAudienceState>(k: K): MemoryAudienceState[K] =>
    (Object.prototype.hasOwnProperty.call(patch, k) ? (patch as any)[k] : existing[k]);
  return {
    visibility: pick("visibility") as string | null | undefined,
    allowed_user_ids: pick("allowed_user_ids") as string[] | null | undefined,
    hidden_user_ids: pick("hidden_user_ids") as string[] | null | undefined,
    trip_id: pick("trip_id") as string | null | undefined,
    state: pick("state") as string | null | undefined,
  };
}

interface ResolveInput {
  memoryId: string;
  ownerId: string;
  previous: MemoryAudienceState;
  next: MemoryAudienceState;
}

export interface ResolvedTargets {
  targets: string[];
  unbounded_audience: "public" | null;
  truncated: boolean;
  degraded: DegradedLookup[];
}

/**
 * Who might be holding this Memory in a Compass cache?
 *
 * The union of BOTH sides of the change, not just the losing side: a viewer
 * moved from the allow-list to the hidden list and a viewer moved the other way
 * both need a fresh feed, and computing the difference correctly for six
 * visibility classes is more ways to be wrong than the extra evictions cost.
 */
export async function resolveRevocationTargets(
  sc: any,
  input: ResolveInput,
): Promise<ResolvedTargets> {
  const degraded: DegradedLookup[] = [];
  const targets = new Set<string>();
  // The owner's own feed carries their own Memories, so it is always stale.
  targets.add(input.ownerId);

  const sides = [input.previous, input.next];
  for (const side of sides) {
    for (const id of asIdList(side.allowed_user_ids)) targets.add(id);
    for (const id of asIdList(side.hidden_user_ids)) targets.add(id);
  }

  const tripIds = [...new Set(
    sides
      .filter((s) => s.visibility === "trip_crew")
      .map((s) => s.trip_id)
      .filter((t): t is string => typeof t === "string" && t.length > 0),
  )];
  for (const tripId of tripIds) {
    const crew = await acceptedCrewOfTrip(sc, tripId);
    if (!crew.ok) degraded.push({ table: "trip_members", error: crew.error });
    else for (const id of crew.ids) targets.add(id);
  }

  if (sides.some((s) => s.visibility === "circle_only")) {
    const { data, error } = await sc
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", input.ownerId);
    if (error) degraded.push({ table: "circle_memberships", error });
    else for (const r of (data ?? []) as any[]) if (r?.other_id) targets.add(r.other_id as string);
  }

  if (sides.some((s) => s.visibility === "friends_only")) {
    // `friends_only` on this surface is MUTUAL follow (memoryReadPolicy.ts),
    // so the followers of the owner are a superset of the audience — a superset
    // is the safe side for a cache eviction.
    const { data, error } = await sc
      .from("user_follows")
      .select("follower_id")
      .eq("following_id", input.ownerId);
    if (error) degraded.push({ table: "user_follows", error });
    else for (const r of (data ?? []) as any[]) if (r?.follower_id) targets.add(r.follower_id as string);
  }

  // The bounded proxy for an unbounded audience — and it runs whichever side is
  // public, because a Memory that was public a moment ago is the one at risk.
  const unbounded = input.previous.visibility === "public" && input.next.visibility !== "public"
    ? "public" as const
    : null;

  if (sides.some((s) => s.visibility === "public")) {
    const [likes, saves, tags] = await Promise.all([
      sc.from("memory_likes").select("user_id").eq("memory_id", input.memoryId),
      sc.from("memory_saves").select("user_id").eq("memory_id", input.memoryId),
      sc.from("memory_tags").select("tagged_user_id").eq("memory_id", input.memoryId),
    ]);
    if (likes.error) degraded.push({ table: "memory_likes", error: likes.error });
    else for (const r of (likes.data ?? []) as any[]) if (r?.user_id) targets.add(r.user_id as string);
    if (saves.error) degraded.push({ table: "memory_saves", error: saves.error });
    else for (const r of (saves.data ?? []) as any[]) if (r?.user_id) targets.add(r.user_id as string);
    if (tags.error) degraded.push({ table: "memory_tags", error: tags.error });
    else for (const r of (tags.data ?? []) as any[]) if (r?.tagged_user_id) targets.add(r.tagged_user_id as string);
  }

  const sorted = [...targets].sort();
  const truncated = sorted.length > MAX_REVOCATION_TARGETS;
  return {
    // The owner is first whatever the cap does, because dropping the one
    // guaranteed-stale cache to fit a follower under a limit would be absurd.
    targets: truncated
      ? [input.ownerId, ...sorted.filter((id) => id !== input.ownerId).slice(0, MAX_REVOCATION_TARGETS - 1)]
      : sorted,
    unbounded_audience: unbounded,
    truncated,
    degraded,
  };
}

export interface RevokeOptions {
  memoryId: string;
  ownerId: string;
  previous: MemoryAudienceState;
  next: MemoryAudienceState;
  reason: RevocationReason;
  log?: { error: (obj: unknown, msg: string) => void; warn?: (obj: unknown, msg: string) => void } | undefined;
  /** Injected for tests; defaults to the real Compass cache invalidator. */
  invalidate?: (db: any, userId: string, reason: string) => Promise<void>;
}

/**
 * §21 revocation for one Memory audience change. Never throws: a cache that
 * could not be evicted must not fail the write that has already happened.
 */
export async function revokeMemoryAudienceCaches(
  sc: any,
  opts: RevokeOptions,
): Promise<RevocationReport> {
  const invalidateFn = opts.invalidate ?? compassInvalidate;
  const resolved = await resolveRevocationTargets(sc, {
    memoryId: opts.memoryId,
    ownerId: opts.ownerId,
    previous: opts.previous,
    next: opts.next,
  });

  const failed: string[] = [];
  let invalidated = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const queue = [...resolved.targets];
  const worker = async () => {
    for (;;) {
      const userId = queue.shift();
      if (userId === undefined) return;
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      try {
        await invalidateFn(sc, userId, opts.reason);
        invalidated++;
      } catch (err) {
        failed.push(userId);
        opts.log?.error({ err, userId, memoryId: opts.memoryId }, "memories: compass cache revocation failed for a viewer");
      } finally {
        inFlight--;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(REVOCATION_CONCURRENCY, queue.length) }, () => worker()),
  );

  const report: RevocationReport = {
    memory_id: opts.memoryId,
    reason: opts.reason,
    targets: resolved.targets,
    invalidated,
    failed,
    unbounded_audience: resolved.unbounded_audience,
    truncated: resolved.truncated,
    degraded: resolved.degraded,
    peak_in_flight: peakInFlight,
    version: AUDIENCE_REVOCATION_VERSION,
  };

  if (resolved.unbounded_audience) {
    opts.log?.error(
      { memoryId: opts.memoryId, reason: opts.reason, invalidated },
      "memories: a PUBLIC Memory was narrowed — the losing audience is not enumerable, so only the bounded proxy (likes/saves/tags) was revoked",
    );
  }
  if (resolved.degraded.length > 0) {
    opts.log?.error(
      { memoryId: opts.memoryId, degraded: resolved.degraded.map((d) => d.table) },
      "memories: audience lookup failed during cache revocation — some viewers may still hold a stale Memory",
    );
  }
  if (resolved.truncated) {
    opts.log?.error(
      { memoryId: opts.memoryId, cap: MAX_REVOCATION_TARGETS },
      "memories: cache revocation hit the target cap — not every viewer's cache was evicted",
    );
  }
  return report;
}
