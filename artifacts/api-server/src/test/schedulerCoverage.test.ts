/**
 * check:scheduler-coverage, and the registry it keeps true.
 *
 * WHY THIS EXISTS. `lib/schedulerCoverage.ts` is the denominator
 * `GET /healthz/schedulers` reports its own scope from: 58 schedulers started,
 * 11 reported, 5 writing a durable `job_health` row, 45 leaving no trace at
 * all. A denominator nobody checks drifts, and a drifted denominator is worse
 * than none — it is what makes an aggregate over 11 jobs read as an aggregate
 * over all of them.
 *
 * So the tests here are about the GUARD being able to fail, not about the
 * numbers being pretty. Each one states the drift it would catch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STARTED_SCHEDULERS,
  schedulerCoverage,
  type SchedulerRow,
} from "../lib/schedulerCoverage.js";
import {
  startedIn,
  reportedIn,
  writesJobHealth,
} from "../scripts/checkSchedulerCoverage.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("what index.ts starts", () => {
  it("finds a call statement and ignores the import of the same name", () => {
    const text = [
      'import { startFooScheduler } from "./lib/foo.js";',
      "  startFooScheduler();",
      "  void startBarWorker();",
      "  startBazWorker(); startQuuxWorker(); // two on one line, as index.ts really does",
    ].join("\n");
    assert.deepEqual(
      [...startedIn(text)].sort(),
      ["startBarWorker", "startBazWorker", "startFooScheduler", "startQuuxWorker"],
    );
  });

  /**
   * THE DRIFT THAT MATTERS. A scheduler added to index.ts with no row would
   * join the 45 unobservable jobs silently, and the coverage count would still
   * read as though someone had looked at it.
   */
  it("the registry is EXACTLY what index.ts starts, in both directions", () => {
    const started = startedIn(readFileSync(join(SRC, "index.ts"), "utf8"));
    const declared = new Set((STARTED_SCHEDULERS as readonly SchedulerRow[]).map((r) => r.start));
    const missing = [...started].filter((s) => !declared.has(s));
    const stale = [...declared].filter((s) => !started.has(s));
    assert.deepEqual(missing, [], "index.ts starts these with no row in schedulerCoverage.ts");
    assert.deepEqual(stale, [], "schedulerCoverage.ts lists these but index.ts no longer starts them");
  });

  it("every reported job name is one routes/health.ts really reports", () => {
    const reported = reportedIn(readFileSync(join(SRC, "routes", "health.ts"), "utf8"));
    const claimed = (STARTED_SCHEDULERS as readonly SchedulerRow[]).flatMap((r) => [...(r.reportedAs ?? [])]);
    assert.deepEqual(
      claimed.filter((n) => !reported.has(n)),
      [],
      "claimed as reported by /healthz/schedulers, but no such job in routes/health.ts",
    );
    // And the other way: an endpoint job nobody claims understates the count.
    assert.deepEqual(
      [...reported].filter((n) => !claimed.includes(n)),
      [],
      "reported by /healthz/schedulers but claimed by no row",
    );
  });
});

describe("telling a job_health writer from a reader", () => {
  /**
   * `routes/adminRankingMetrics.ts` READS `job_health` for two keys nothing in
   * this tree writes. Counting a reader as a writer would have the guard
   * certify durable health reporting that does not exist, so the operation is
   * read off the chain rather than from the file containing the table name.
   */
  it("a select on job_health is not a write, even in a file that updates other tables", () => {
    const reader = [
      'await sc.from("other_table").update({ x: 1 }).eq("id", id);',
      'await sc.from("job_health").select("last_run_at").eq("job", "creator_activity_score").maybeSingle();',
    ].join("\n");
    assert.equal(writesJobHealth(reader), false);
  });

  it("an upsert, an update and an insert on job_health all count as writes", () => {
    assert.equal(writesJobHealth('sc.from("job_health").upsert(row, { onConflict: "job" })'), true);
    assert.equal(writesJobHealth('sc.from("job_health").update({ last_run_at: now }).eq("job", k)'), true);
    assert.equal(writesJobHealth('sc.from("job_health").insert(row)'), true);
  });

  it("recognises the write even when the chain is broken across lines", () => {
    assert.equal(writesJobHealth('await client\n  .from("job_health")\n  .upsert({ job, last_run_at })'), true);
  });
});

describe("what the coverage count says", () => {
  it("a row with neither a reported job nor a job_health key is unobservable", () => {
    const cov = schedulerCoverage([
      { start: "startA", reportedAs: ["a"] },
      { start: "startB", persists: ["b"] },
      { start: "startC", reportedAs: ["c"], persists: ["c"] },
      { start: "startD" },
      // An empty array is not reporting. It would be easy to write `?? []`
      // somewhere and have these count as covered.
      { start: "startE", reportedAs: [], persists: [] },
    ]);
    assert.equal(cov.started, 5);
    assert.equal(cov.reported, 2, "A and C report; E's empty array is not reporting");
    assert.equal(cov.persisted, 2, "B and C persist");
    assert.deepEqual(cov.unobservable, ["startD", "startE"]);
  });

  /**
   * The real numbers, pinned so a change to them has to be deliberate. If this
   * fails because a scheduler gained health reporting, that is good news and
   * the number moves DOWN; update it and say so.
   */
  it("pins today's real coverage: 63 started, 16 reported, 8 durable, 45 invisible", () => {
    const cov = schedulerCoverage();
    // 59 -> 60 and 12 -> 13 on 2026-10-07 (lane R, census-layover L163):
    // startLayoverAuditRetentionScheduler deletes pseudonymised layover_events
    // at retain_until (OD-MAP-4), and reports to /healthz/schedulers as
    // `layoverAuditRetention`. A new OBSERVABLE job, so the invisible count does
    // not move.
    // 58 -> 59, 11 -> 12 and 5 -> 6 on 2026-10-04, at the integration of #549
    // with #561: #549's startDiscoveryServeLogRetentionScheduler (3501's
    // retention purge) is a NEW scheduler that both reports to
    // /healthz/schedulers and writes its own job_health row. The invisible
    // count does not move: no job lost or gained a trace, one observable job
    // was added. 60 -> 61, 13 -> 14 and 6 -> 7 the same way at the merge of lane H with lane R (census-highlights-memories §AV): startMemoryDeletionRedriveScheduler reports AND writes job_health, so 45 holds.
    // 61 -> 62, 14 -> 15 and 7 -> 8 the same way on 2026-10-10 (lane H-REST, census H157): startHighlightExpiryEventScheduler reports AND writes job_health, so 45 holds.
    // 62 -> 63 and 15 -> 16 with lane T-REL (census-telegraph T223, 3656): startMessageMediaPartsSweepScheduler reports to /healthz/schedulers as `messageMediaPartsSweep` and writes no job_health row, so 8 durable and 45 invisible hold.
    assert.equal(cov.started, 63);
    assert.equal(cov.reported, 16);
    // Moved DOWN on 2026-10-03: startHealthMonitorLoop now writes its own
    // `stamp_health_monitor` job_health row, so the stamp health monitor is no
    // longer one of the jobs whose stopping leaves no trace. 4 durable -> 5,
    // 46 invisible -> 45.
    assert.equal(cov.persisted, 8);
    assert.equal(cov.unobservable.length, 45);
    assert.equal(cov.started, cov.unobservable.length + 18, "16 reported + 8 durable overlap on 6 rows");
  });

  /**
   * The monitor's row specifically, so the fix cannot be undone by deleting one
   * field from the registry and still pass the counts above by coincidence.
   */
  it("the stamp health monitor is registered as durable, not unobservable", () => {
    const cov = schedulerCoverage();
    const row = (STARTED_SCHEDULERS as readonly SchedulerRow[]).find(
      (r) => r.start === "startHealthMonitorLoop",
    );
    assert.ok(row, "index.ts starts startHealthMonitorLoop; it must have a row");
    assert.deepEqual(row.persists, ["stamp_health_monitor"]);
    assert.ok(
      !cov.unobservable.includes("startHealthMonitorLoop"),
      "the monitor writes job_health; it must not be counted as leaving no trace",
    );
  });

  it("names the unobservable jobs rather than only counting them", () => {
    const cov = schedulerCoverage();
    // A number invites rounding; a name invites fixing. Spot-check three that
    // delete or publish user-visible things, so the list cannot quietly become
    // a count.
    for (const s of ["startAccountDeletionScheduler", "startLocationSnapshotPurgeScheduler", "startSensingRetentionScheduler"]) {
      assert.ok(cov.unobservable.includes(s), `${s} leaves no trace and must be named`);
    }
  });
});
