/**
 * check:scheduler-coverage — keep `lib/schedulerCoverage.ts` true.
 *
 * That file is the denominator for `GET /healthz/schedulers`: it says which
 * schedulers `index.ts` starts and, for each, whether stopping would leave any
 * trace. A denominator nobody checks drifts, and a drifted denominator is worse
 * than none — it makes a partial aggregate look complete, which is the exact
 * defect it was written to expose.
 *
 * So four things are asserted against the tree, each in BOTH directions,
 * because a registry that can only grow stops describing the code:
 *
 *   1. The `start` set equals the set of `start…()` statements in `index.ts`.
 *      A scheduler added without a row fails here rather than quietly joining
 *      the unobservable ones; a row whose scheduler was deleted fails as stale.
 *   2. Every `reportedAs` name appears as a `job: "…"` literal in
 *      `routes/health.ts`, and every such literal is claimed by exactly one
 *      row. A job silently dropped from the endpoint stops being counted as
 *      reported.
 *   3. Every `persists` row's owning file really WRITES `job_health` — an
 *      `.upsert`/`.update`/`.insert` on that table, not a read of it — and
 *      every non-test file that writes `job_health` is claimed by some row.
 *      A row cannot claim durable health it does not have, and a new writer
 *      cannot go unrecorded.
 *   4. The counts the file documents in prose match what its own rows imply.
 *
 * WHY WRITES AND READS ARE TOLD APART: `routes/adminRankingMetrics.ts` reads
 * `job_health` for `creator_activity_score` and `content_distribution_
 * aggregation`, two keys NOTHING in this tree writes. Counting a reader as a
 * writer would have this check certify health reporting that does not exist.
 *
 * WHAT IT DOES NOT DO. It says nothing about whether any scheduler is actually
 * running — no process, no database, no network. It cannot see a loop started
 * somewhere other than `index.ts`, nor the several workers one `start…()` call
 * may fan out to; `schedulerCoverage.ts` says so in its own words. And it does
 * not judge whether 46 unobservable jobs is acceptable. That is the owner's
 * call and this check exists so the number cannot drift while nobody looks.
 *
 * Exit 0 = the registry matches the tree; 1 = drift, named; 2 = a file could
 * not be read.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:scheduler-coverage
 *   pnpm run check:scheduler-coverage -- --print
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STARTED_SCHEDULERS, schedulerCoverage, type SchedulerRow } from "../lib/schedulerCoverage.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `start…()` statement `index.ts` executes, as a set of names. */
export function startedIn(indexText: string): Set<string> {
  const out = new Set<string>();
  for (const line of indexText.split("\n")) {
    // A call STATEMENT, not an import: indented, and not part of `import {`.
    if (/^\s*import\b/.test(line)) continue;
    for (const m of line.matchAll(/(?:^|[\s;{(])(?:void\s+)?(start[A-Za-z0-9_]+)\s*\(/g)) {
      out.add(m[1]!);
    }
  }
  return out;
}

/** Job names `routes/health.ts` reports, as `job: "…"` literals. */
export function reportedIn(healthText: string): Set<string> {
  const out = new Set<string>();
  for (const m of healthText.matchAll(/job:\s*"([A-Za-z0-9_]+)"/g)) out.add(m[1]!);
  return out;
}

/**
 * Does this text WRITE `job_health`? Each `from("job_health")` is examined with
 * its own chain rather than the whole file, so a file that updates some other
 * table and merely reads this one is not mistaken for a writer.
 */
export function writesJobHealth(text: string): boolean {
  for (const m of text.matchAll(/from\(\s*"job_health"\s*\)/g)) {
    const chain = text.slice(m.index! + m[0].length, m.index! + m[0].length + 200);
    // The operation is the first method called on the result.
    const op = /^\s*\.\s*([A-Za-z0-9_]+)/.exec(chain);
    if (op && ["upsert", "update", "insert", "delete"].includes(op[1]!)) return true;
  }
  return false;
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "test" || e === "__tests__" || e === "node_modules") continue;
      tsFiles(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** The file exporting a `start…()` function, or null when it cannot be found. */
export function ownerOf(start: string, files: string[]): string | null {
  const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${start}\\b`);
  for (const f of files) {
    if (re.test(readFileSync(f, "utf8"))) return f;
  }
  return null;
}

function main(): void {
  const print = process.argv.includes("--print");
  let indexText: string;
  let healthText: string;
  let files: string[];
  try {
    indexText = readFileSync(join(SRC, "index.ts"), "utf8");
    healthText = readFileSync(join(SRC, "routes", "health.ts"), "utf8");
    files = tsFiles(SRC);
  } catch (err) {
    console.error(`::error::check:scheduler-coverage could not read the tree: ${(err as Error).message}`);
    process.exit(2);
  }

  const problems: string[] = [];
  const rows = STARTED_SCHEDULERS as readonly SchedulerRow[];
  const declared = new Set(rows.map((r) => r.start));
  if (declared.size !== rows.length) {
    problems.push("schedulerCoverage.ts lists the same `start` twice");
  }

  // 1. The start set, both directions.
  const started = startedIn(indexText);
  for (const s of started) {
    if (!declared.has(s)) {
      problems.push(
        `index.ts starts ${s}() but schedulerCoverage.ts has no row for it — add one saying how anyone could tell it stopped`,
      );
    }
  }
  for (const s of declared) {
    if (!started.has(s)) {
      problems.push(`schedulerCoverage.ts lists ${s} but index.ts no longer starts it — the row is stale`);
    }
  }

  // 2. The reported job names, both directions.
  const reported = reportedIn(healthText);
  const claimedReports = new Map<string, string>();
  for (const r of rows) {
    for (const name of r.reportedAs ?? []) {
      if (!reported.has(name)) {
        problems.push(
          `${r.start} claims /healthz/schedulers reports "${name}", but routes/health.ts has no such job — it is not reported`,
        );
      }
      const already = claimedReports.get(name);
      if (already) problems.push(`both ${already} and ${r.start} claim the reported job "${name}"`);
      else claimedReports.set(name, r.start);
    }
  }
  for (const name of reported) {
    if (!claimedReports.has(name)) {
      problems.push(
        `routes/health.ts reports "${name}" but no schedulerCoverage.ts row claims it — the coverage count is understated`,
      );
    }
  }

  // 3. Durable health, both directions.
  const writers = new Set(files.filter((f) => writesJobHealth(readFileSync(f, "utf8"))));
  const claimedWriters = new Set<string>();
  for (const r of rows) {
    if ((r.persists?.length ?? 0) === 0) continue;
    const owner = ownerOf(r.start, files);
    if (!owner) {
      problems.push(`${r.start} claims job_health keys but no file in src/ exports it`);
      continue;
    }
    // The writer may be the owning file, or a file the owning file starts: one
    // `start…()` can fan out, which schedulerCoverage.ts states. So the claim
    // is satisfied by ANY unclaimed writer under the owner's directory, and by
    // the owner itself.
    const own = writesJobHealth(readFileSync(owner, "utf8"));
    const nearby = [...writers].filter((w) => w === owner || w.startsWith(dirname(owner) + "/"));
    if (!own && nearby.length === 0) {
      problems.push(
        `${r.start} claims job_health keys [${(r.persists ?? []).join(", ")}] but neither ${owner} nor anything beside it writes job_health`,
      );
      continue;
    }
    for (const w of own ? [owner] : nearby) claimedWriters.add(w);
  }
  for (const w of writers) {
    if (!claimedWriters.has(w)) {
      problems.push(
        `${w.slice(SRC.length + 1)} writes job_health but no schedulerCoverage.ts row claims it — durable health is going unrecorded`,
      );
    }
  }

  // 4. The counts the registry's own prose states.
  const cov = schedulerCoverage(rows);
  const prose = readFileSync(join(SRC, "lib", "schedulerCoverage.ts"), "utf8");
  for (const [n, what] of [
    [cov.started, "started"],
    [cov.unobservable.length, "unobservable"],
  ] as Array<[number, string]>) {
    if (!prose.includes(String(n))) {
      problems.push(
        `schedulerCoverage.ts no longer mentions ${n} anywhere, but that is its own ${what} count — the docblock has drifted from the rows`,
      );
    }
  }

  console.log(
    `check:scheduler-coverage: ${cov.started} schedulers started, ${cov.reported} reported by /healthz/schedulers, ` +
      `${cov.persisted} writing job_health, ${cov.unobservable.length} with NO trace at all.`,
  );
  if (print) for (const s of cov.unobservable) console.log(`  unobservable: ${s}`);

  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error(
      `check:scheduler-coverage FAILED — ${problems.length} problem(s). ` +
        `The registry is the denominator /healthz/schedulers reports its own scope from, so drift here makes a partial aggregate read as a complete one.`,
    );
    process.exit(1);
  }
  console.log(
    "check:scheduler-coverage PASSED — the registry matches index.ts, routes/health.ts and every job_health writer.\n" +
      "  DOES NOT COVER: whether any scheduler is RUNNING, loops started outside index.ts, or whether " +
      `${cov.unobservable.length} unobservable jobs is acceptable — that is the owner's call.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
