/**
 * A durable "processed through" mark for schedulers whose work is selected by a
 * time window.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────
 * Several background jobs pick up work by asking "what happened in the last
 * N?" — `.gte("created_at", new Date(Date.now() - ONE_HOUR))` and friends — and
 * keep no record of where the previous tick got to. That is correct only while
 * the ticks keep pace. The API runs on Replit autoscale, which suspends a
 * container after fifteen idle minutes, and a suspended container's event loop
 * does not advance. So for a window of an hour or two the gap between ticks is
 * routinely wider than the window itself, and every row inside that gap is
 * outside the next tick's window and is examined by NO later tick, ever.
 *
 * The distinction that matters is between a window and a watermark. A window
 * asks about a span of wall-clock time and silently forgets whatever it did not
 * reach. A watermark asks about a span of WORK and cannot forget, because the
 * span's start is the end of the last span that succeeded.
 *
 * ── THE TWO RULES THAT MAKE IT SAFE ─────────────────────────────────────────
 * Both are about the same hazard from opposite sides: a watermark that advances
 * past work nobody did is worse than no watermark at all, because the window
 * shape at least re-reads recent rows on every tick.
 *
 *  1. ADVANCE ONLY AFTER THE WORK SUCCEEDED. `commitWatermark` is called after
 *     the pass, never before and never alongside it. A pass that threw, timed
 *     out, hit a read error or processed a truncated page leaves the mark where
 *     it was, so the next tick re-scans that span. Re-scanning is safe for
 *     every caller here — they all write deduped or idempotent results — while
 *     skipping is not, which is why this asymmetry is resolved this way.
 *
 *  2. AN UNREADABLE MARK IS A REFUSAL, NOT AN ABSENCE. `readWatermark`
 *     distinguishes "no row yet" (`{at: null, ok: true}`) from "the read
 *     failed" (`{at: null, ok: false}`). They look identical and mean opposite
 *     things: the first says scan from the default lookback, the second says
 *     this process cannot establish how far the work got. On `ok: false` the
 *     caller keeps its old lookback AND skips the commit, so a transient
 *     database error can neither widen a scan nor move the mark. Collapsing
 *     the two would make a blip look like a fresh install.
 *     (CONTRIBUTING.md:33-66 — a check that cannot establish its result must
 *     fail rather than assume.)
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not a liveness record. It says how far work got, never whether anything is
 * running; `job_health` and GET /healthz/schedulers are the liveness surfaces,
 * and they cover four of the fifty-eight jobs the process starts. Not a lock
 * either: it does not serialise anything, and two processes committing
 * near-simultaneously is handled by the monotonic clamp below rather than by
 * mutual exclusion.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

const TABLE = "scheduler_watermarks";

/**
 * How far behind the caller's clock a committed mark stays. ONE MINUTE.
 *
 * ── WHY A MARK AT `now` SKIPS ROWS ──────────────────────────────────────────
 * `through` is the caller's clock; `created_at` is the DATABASE's clock, set by
 * `now()` inside the inserting transaction. Two independent things make those
 * disagree, and both skip rows permanently in exactly the shape this module
 * exists to close:
 *
 *  1. SNAPSHOT VISIBILITY. A transaction that stamped `created_at = T` before
 *     our SELECT's snapshot but commits after it is invisible to the scan even
 *     though T < our `now`. Committing `now` declares T covered, and no later
 *     pass asks about T again. The width is however long that writer's
 *     transaction stays open.
 *
 *  2. CLOCK SKEW, which is the worse one because it is not a race. If this
 *     container's clock runs ahead of the database's by δ, then every pass
 *     commits a mark δ in the database's future and the next pass starts after
 *     rows that were still to be written. That loses δ of work on EVERY pass,
 *     quietly and forever — the per-tick version of the outage bug.
 *
 * ── WHY THE FIX BELONGS HERE AND NOT IN A CALLER ────────────────────────────
 * "Commit `through`" has to stay a true statement, or the next caller wired up
 * against this module will reasonably commit its own `now` and reopen the hole.
 * So the lag is applied to the value handed out, not subtracted at the commit:
 * every caller gets it by using the module as documented, and none of them has
 * to know this hazard exists.
 *
 * ── WHAT IT COSTS, AND WHY A MINUTE ─────────────────────────────────────────
 * It costs a re-scan of the last minute on the following pass. The callers all
 * read to the present with no upper bound, so that minute is scanned twice and
 * never zero times, and all of them write deduped or idempotent results — the
 * same asymmetry rule 1 above is resolved on. A minute is wide enough to cover
 * ordinary in-flight transactions and the clock skew a container and a hosted
 * database realistically carry, and small enough to be a rounding error against
 * the narrowest window any caller uses (one hour, scanned hourly).
 *
 * It is not a substitute for a watermark being committed only after success,
 * and it does not make an unsynchronised clock safe — skew wider than this is
 * still skew. It removes the systematic per-pass loss, not the possibility.
 */
export const COMMIT_LAG_MS = 60 * 1_000;

export interface ScanWindow {
  /** Scan from here (exclusive or inclusive is the caller's existing choice). */
  since: Date;
  /**
   * The value to commit if, and only if, the pass succeeds — and deliberately
   * a little behind the caller's `now`, see COMMIT_LAG_MS. Callers read to the
   * present and commit only this, so the lag is re-scanned rather than skipped.
   */
  through: Date;
  /** True when `since` was pulled forward by `maxCatchupMs` — work older than this window is NOT covered. */
  capped: boolean;
}

/**
 * Decide the span to scan. Pure: no clock, no IO, so the callers' tests can
 * drive it directly.
 *
 * `maxCatchupMs` bounds the FIRST scan after a long gap. Without it a watermark
 * from before a multi-day outage would ask one tick to scan days of rows, which
 * for the detectors using this is not merely slow: it can raise a burst of
 * flags or review rows at once. The cap is therefore a real behavioural
 * decision each caller makes and justifies, not a performance knob — and when
 * it bites, `capped` is true and the caller must say so rather than report a
 * clean pass over a span it did not cover.
 */
export function scanWindow(opts: {
  watermark: Date | null;
  now: Date;
  defaultLookbackMs: number;
  maxCatchupMs: number;
}): ScanWindow {
  const { watermark, now, defaultLookbackMs, maxCatchupMs } = opts;
  const nowMs = now.getTime();

  // No stored mark: behave exactly as the caller did before this existed, so
  // introducing a watermark cannot change a first run or a fresh database.
  let sinceMs = watermark ? watermark.getTime() : nowMs - defaultLookbackMs;

  // A mark in the future is not a span, it is a corrupt row or a clock that
  // went backwards. Treat it as the default lookback rather than scanning an
  // empty or inverted range and reporting success over it.
  if (sinceMs > nowMs) sinceMs = nowMs - defaultLookbackMs;

  let capped = false;
  if (nowMs - sinceMs > maxCatchupMs) {
    sinceMs = nowMs - maxCatchupMs;
    capped = true;
  }

  // `capped` stays measured against `now`, not against `through`: the scan does
  // read to the present, and what the cap left out is what is older than
  // `since`.
  //
  // `through` never precedes `since`. A pass running within COMMIT_LAG_MS of
  // the previous commit would otherwise be handed an inverted span; committing
  // `since` instead is a no-op the monotonic clamp below already tolerates.
  const throughMs = Math.max(nowMs - COMMIT_LAG_MS, sinceMs);

  return { since: new Date(sinceMs), through: new Date(throughMs), capped };
}

/**
 * Read a job's mark.
 *
 * `ok` is the whole point of the return shape: see rule 2 in the file header.
 * A missing row and a failed read both carry `at: null` and the caller must
 * treat them differently.
 */
export async function readWatermark(
  sc: SupabaseClient,
  job: string,
): Promise<{ at: Date | null; ok: boolean }> {
  try {
    const { data, error } = await (sc as any)
      .from(TABLE)
      .select("processed_through")
      .eq("job", job)
      .maybeSingle();
    if (error) {
      // supabase-js RESOLVES on a database error, so this branch is the one a
      // `const { data } = await …` would silently turn into "no watermark".
      logger.warn({ job, err: error.message }, "schedulerWatermark: read failed — caller must not widen its scan");
      return { at: null, ok: false };
    }
    const raw = (data as any)?.processed_through;
    if (!raw) return { at: null, ok: true }; // genuinely no mark yet
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) {
      logger.warn({ job, raw }, "schedulerWatermark: unparseable processed_through — treating as unreadable");
      return { at: null, ok: false };
    }
    return { at, ok: true };
  } catch (e: any) {
    logger.warn({ job, err: e?.message ?? String(e) }, "schedulerWatermark: read threw — caller must not widen its scan");
    return { at: null, ok: false };
  }
}

/**
 * Advance a job's mark to `through`. Call this ONLY after the pass over
 * `[since, through]` actually succeeded (rule 1 in the file header).
 *
 * Returns whether the row is now durably at or past `through`. A false return
 * is not fatal — the next tick re-scans the same span — but it must not be
 * reported as a clean pass, because the span's coverage is now unproven.
 */
export async function commitWatermark(
  sc: SupabaseClient,
  job: string,
  through: Date,
): Promise<boolean> {
  if (Number.isNaN(through.getTime())) return false;
  try {
    // Monotonic clamp. A mark moving BACKWARDS only costs a re-scan, which
    // every caller tolerates; a mark moving FORWARD past undone work is the
    // failure this module exists to prevent, and rule 1 is what prevents it.
    // The clamp is still here so that two processes committing out of order
    // cannot undo progress, and it is done against a fresh read rather than a
    // value the caller passed in, which could be stale by a whole pass.
    const current = await readWatermark(sc, job);
    if (!current.ok) {
      // Cannot establish the current mark, so cannot establish that writing is
      // an advance. Refuse rather than guess; the next tick re-scans.
      return false;
    }
    if (current.at && current.at.getTime() >= through.getTime()) return true;

    const { error } = await (sc as any)
      .from(TABLE)
      .upsert(
        { job, processed_through: through.toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "job" },
      );
    if (error) {
      logger.warn({ job, err: error.message }, "schedulerWatermark: commit failed — span will be re-scanned");
      return false;
    }
    return true;
  } catch (e: any) {
    logger.warn({ job, err: e?.message ?? String(e) }, "schedulerWatermark: commit threw — span will be re-scanned");
    return false;
  }
}
