/**
 * THE failure this band produces, stated once as a test.
 *
 * A background job that is written, imported, reviewed and merged but never
 * started looks finished and is red nowhere: the module compiles, its unit tests
 * pass, and the work simply never happens. lib/sensingRetentionScheduler's header
 * records one instance (migration 2315 shipped
 * `purge_expired_sensing_contributions` whose only reference in the repository
 * was its own definition); lib/intelRetentionScheduler's header records another
 * (location_snapshots carried `expires_at` for months with nothing enforcing it).
 *
 * Every application worker must still start from src/index.ts. The owner also
 * requested a database-hosted operational monitor in4026; its single bounded
 * aggregate-only job is pinned separately below. No other database scheduler
 * may silently replace or duplicate an application worker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const LIB = path.resolve(process.cwd(), "src/lib");
const INDEX = path.resolve(process.cwd(), "src/index.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

/**
 * What counts as a background worker: an exported `start…` function whose name
 * ends in one of the suffixes this tree uses for recurring work. The suffix list
 * is the contract — a new worker that does not match one of these is invisible
 * to this guard, so name it like its neighbours.
 */
const WORKER_SUFFIXES = /(Scheduler|Worker|Sweeper|Sweep|Cleanup|Loop|Warmer|Reconciler|Publisher|Monitor)$/;

function exportedStarters(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/export\s+(?:async\s+)?function\s+(start[A-Za-z0-9_]*)/g)]
    .map((m) => m[1]!)
    .filter((name) => WORKER_SUFFIXES.test(name));
}

test("every background worker exported from src/lib is started from src/index.ts", () => {
  const index = readFileSync(INDEX, "utf8");
  const unstarted: string[] = [];
  for (const file of walk(LIB)) {
    for (const fn of exportedStarters(file)) {
      // A call, not merely an import: `import { startX }` with no `startX(` is
      // exactly the disguise this test exists to strip off.
      if (!new RegExp(`\\b${fn}\\s*\\(`).test(index.replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?$/gm, ""))) {
        unstarted.push(`${path.relative(process.cwd(), file)} :: ${fn}`);
      }
    }
  }
  assert.deepEqual(
    unstarted, [],
    `these workers exist and nothing ever runs them:\n  ${unstarted.join("\n  ")}`,
  );
});

test("the intel retention scheduler is started on the server boot path", () => {
  const index = readFileSync(INDEX, "utf8");
  assert.match(index, /startIntelRetentionScheduler\s*\(\s*\)/);
  assert.match(index, /startIntelCoverageScheduler\s*\(\s*\)/);
  assert.match(index, /startSensingRetentionScheduler\s*\(\s*\)/);
});

test("the owner-approved bounded database monitor is the only migration scheduler", () => {
  const dir = path.resolve(process.cwd(), "src/migrations");
  const scheduled = readdirSync(dir).filter(f => f.endsWith(".sql"))
    .filter(f => /cron\.schedule/i.test(readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(scheduled, ["4026_intelligence_system_monitor.sql"]);
  const source = readFileSync(path.join(dir, scheduled[0]!), "utf8");
  // This migration is already applied. Pin its whole reviewed definition, not
  // merely a filename exemption that could conceal another scheduler/network job.
  assert.equal(createHash("sha256").update(source).digest("hex"),
    "dd97f5286aa962ec99df463b56e88701a76101f073e17aff4df338bb98e724f3");
  assert.equal([...source.matchAll(/cron\.schedule\s*\(/gi)].length, 1);
  assert.match(source, /cron\.schedule\('intelligence-system-monitor-hourly', '7 \* \* \* \*',/);
  assert.ok(source.includes("set statement_timeout='20s'; set lock_timeout='2s'; select intelligence_monitor.collect();"));
});
