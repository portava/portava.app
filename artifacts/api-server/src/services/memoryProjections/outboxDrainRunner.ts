/**
 * The driver for the §17 outbox consumer: one pass, and the timer that repeats it.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §17 the outbox pattern and its consumers.
 *   §24 projection_lag — the metric this cadence is measured in.
 *   §28.11 never swallow a projection failure into a plausible-looking empty run.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE AND NOT PART OF memoryProjectionScheduler.ts
 * ══════════════════════════════════════════════════════════════════════════════
 * Two reasons, and the second one was measured rather than anticipated.
 *
 * 1. THE CADENCES ARE NOT THE SAME KIND OF THING. `runMemoryProjectionPass`
 *    runs every SIX HOURS, which is right for an idempotent full re-projection
 *    and wrong by three orders of magnitude for an event queue: an outbox
 *    drained twice a day is a projection half a day stale, and §24 measures
 *    exactly that as `projection_lag`. They also cannot share one timer:
 *    src/test/memoryProjectionSchedulerTiming.test.ts asserts that pass's RPC
 *    sequence EXACTLY — `deepEqual(names, ["project_all_memory",
 *    "memory_sweep_expired"])` — and separately that every call in it carries
 *    `p_enforce_flag: true`. Adding a claim to that pass turns both green tests
 *    red, and both assertions are correct: "projects first, then sweeps" is a
 *    real invariant, because sweeping first would delete rows the projection is
 *    about to refresh.
 *
 * 2. PUTTING IT IN THAT FILE BROKE A CENSUS CITATION, MEASURED.
 *    `docs/architecture/census-highlights-memories.md:213` cites
 *    `artifacts/api-server/src/lib/memoryProjectionScheduler.ts:51` by LINE,
 *    with no `#anchor`. An earlier draft of this lane added an import to that
 *    file; the seven lines it cost moved the cited statement to line 58, and
 *    `check:citation-targets` went from 182 dead citations to 183 — over its
 *    ceiling of 182. The census is owned by another lane and may not be
 *    repointed from here, so the fix is not to touch the cited file at all.
 *    A line-numbered citation makes an unrelated file's line count part of
 *    another lane's contract; that is a real cost and this file is what avoids
 *    paying it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * NOT FLAG-GATED, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════════════
 * Every sibling scheduler here is fail-closed behind a feature flag. This one is
 * not, because the thing a flag would gate is already structural: an outbox row
 * can ONLY exist if `public.memory_kernel_execute` wrote it, and that function
 * runs only when `memory_kernel_enabled` is true. With the flag off the drain
 * claims zero rows and does nothing — the flag gates the PRODUCER. Gating the
 * consumer as well would add a second switch whose only distinctive behaviour is
 * the bad one: events already written, then stranded unacked because someone
 * turned the reader off separately.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WIRING — DONE, AND WHAT IT DOES AND DOES NOT COVER
 * ══════════════════════════════════════════════════════════════════════════════
 * This paragraph used to say the consumer had no production caller and was
 * waiting on one line in src/index.ts. That is NO LONGER TRUE and the line is
 * there: src/index.ts imports `startMemoryOutboxScheduler` and calls it during
 * boot, beside the other schedulers. The consumer runs in production.
 *
 * WHAT IT DRAINS, STATED PRECISELY so this does not become the next stale
 * claim. `drainMemoryOutbox` claims through `public.memory_outbox_claim`,
 * which migration 2994 creates and which is UNAPPLIED on every database at the
 * time of writing — so today every pass answers `claim_unavailable` and the
 * loop reports that rather than a clean empty run. Once 2994 is applied, the
 * pass rebuilds the §18 projections each `memory.*` event invalidates.
 * `highlight.*` events (migration 2993) have no §18 projection keyed on a
 * Highlight, so they are claimed, acked and counted as
 * `unsubscribed_event_type`: the rows move and none is stranded, and nothing
 * is rebuilt from them. A projection worker for the Highlight half does not
 * exist.
 */
import { getServiceClient } from "../../lib/supabase.js";
import { logger } from "../../lib/logger.js";
import { drainMemoryOutbox } from "./outboxConsumer.js";

const OUTBOX_STARTUP_DELAY_MS = 2 * 60 * 1000;  // after boot settles; the drain is cheap and safe to start early
const OUTBOX_INTERVAL_MS = 60 * 1000;           // a minute: `projection_lag` is measured in this unit, not in hours
const OUTBOX_BATCH_LIMIT = 100;

let _outboxTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * STOP MUST ACTUALLY STOP, AND A NULL-CHECK ALONE DOES NOT ACHIEVE THAT.
 *
 * The reschedule lives in `.finally`, which is right — a transient blip must not
 * end draining for the life of the process. But it means a pass that is ALREADY
 * IN FLIGHT when `stop()` runs will re-install the timer afterwards, from inside
 * its own continuation, and `clearTimeout` has already happened by then. The
 * scheduler comes back from the dead.
 *
 * Found by this lane's own test rather than reasoned about in advance: three
 * timer tests failed and the runner HUNG, holding a live 60-second timer that
 * nothing could cancel.
 *
 * A generation counter closes it. `stop()` bumps the generation; a tick only
 * reschedules if the generation it was born under is still current.
 */
let _outboxGeneration = 0;

export interface MemoryOutboxDrainResult {
  skipped: boolean;
  reason: "no_client" | "error" | null;
  claimed: number;
  acked: number;
  failed: number;
}

/**
 * One drain pass. Exported so a test can run it without a timer, and so an
 * operator-facing script can drain on demand.
 *
 * A FAILED PASS IS REPORTED, NOT SWALLOWED. `drainMemoryOutbox` returns a
 * discriminated result precisely so "the outbox could not be read" never renders
 * as "there was nothing to publish" (§28.11); this wrapper keeps that
 * distinction in `reason` instead of collapsing both to zeros. `no_client` is
 * kept separate from `error` because they need different operator responses: one
 * is a misconfigured process, the other is a database problem.
 *
 * NEVER REJECTS. Every failure path returns a result, which is what makes the
 * `.catch(...).finally(...)` below safe; src/test/memoryProjectionSchedulerOutbox.test.ts
 * pins that invariant explicitly.
 */
export async function runMemoryOutboxDrainPass(
  opts: { client?: any } = {},
): Promise<MemoryOutboxDrainResult> {
  // Explicit null means "no client"; undefined means "use the service client"
  // (the house pattern — see intelCoverageScheduler).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const empty: MemoryOutboxDrainResult = { skipped: true, reason: null, claimed: 0, acked: 0, failed: 0 };
  if (!db) return { ...empty, reason: "no_client" };

  try {
    const result = await drainMemoryOutbox(db, { limit: OUTBOX_BATCH_LIMIT, logger });

    if (!result.ok) {
      logger.warn(
        { failureClass: result.failureClass, detail: result.detail, claimed: result.claimed },
        "memory outbox drain: pass failed",
      );
      return { skipped: false, reason: "error", claimed: result.claimed, acked: result.acked, failed: result.failed };
    }
    if (result.claimed > 0) {
      logger.info(
        { claimed: result.claimed, acked: result.acked, failed: result.failed },
        "memory outbox drain complete",
      );
    }
    return { skipped: false, reason: null, claimed: result.claimed, acked: result.acked, failed: result.failed };
  } catch (err) {
    logger.warn({ err }, "memory outbox drain pass threw");
    return { ...empty, skipped: false, reason: "error" };
  }
}

export function startMemoryOutboxScheduler(): void {
  if (_outboxTimer !== null) return;
  logger.info(
    { startupDelayMs: OUTBOX_STARTUP_DELAY_MS, intervalMs: OUTBOX_INTERVAL_MS, batchLimit: OUTBOX_BATCH_LIMIT },
    "MemoryOutboxScheduler scheduled (drains zero rows until memory_kernel_enabled is on)",
  );
  const generation = ++_outboxGeneration;
  _outboxTimer = setTimeout(function tick() {
    void runMemoryOutboxDrainPass()
      .catch((err) => logger.warn({ err }, "memory outbox drain failed"))
      // In `.finally` for the reason the projection scheduler's timing suite
      // pins on its own pass: rescheduling only on success means one transient
      // blip ends draining for the life of the process, and every other test
      // would still pass. Generation-guarded so a stop() during this pass is
      // not undone here.
      .finally(() => {
        if (generation !== _outboxGeneration) return;
        _outboxTimer = setTimeout(tick, OUTBOX_INTERVAL_MS);
      });
  }, OUTBOX_STARTUP_DELAY_MS);
}

export function stopMemoryOutboxScheduler(): void {
  // Bumped FIRST and unconditionally: an in-flight pass must see the change even
  // when there is no timer handle left to clear.
  _outboxGeneration += 1;
  if (_outboxTimer !== null) { clearTimeout(_outboxTimer); _outboxTimer = null; }
}
