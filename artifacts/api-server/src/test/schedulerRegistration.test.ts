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
 * There is NO pg_cron anywhere in src/migrations, so for every worker in this
 * tree the ONLY thing that can start it is a call from src/index.ts. This test
 * asserts that for all of them, by source, with no allowlist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

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

test("no migration schedules work in the database, so a Node boot path is the only invoker", () => {
  // If this ever stops being true the test above stops being sufficient, because
  // a pg_cron entry would be a second, invisible invoker.
  const dir = path.resolve(process.cwd(), "src/migrations");
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /cron\.schedule/i.test(readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(offenders, []);
});
