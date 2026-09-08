/**
 * Every stored projection must have a consumer — `check:projection-consumers`.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * DECORATIVE ARCHITECTURE. A producer that runs, a table that fills, and nothing
 * that reads it. Every piece is individually correct: the worker has tests, the
 * table has a migration, the scheduler is registered. The feature still does not
 * exist, because the last hop was never built — and nothing fails, so nothing
 * says so.
 *
 * This is the mirror of `checkWriterlessReads.ts` (a read whose table nothing
 * writes, returning zero rows forever). Together they assert that data can flow
 * BOTH ways along every declared pipe.
 *
 * ── WHY IT RESOLVES CONSTANTS AND RPCs, AND WHY THAT MATTERS ────────────────
 * The naive version of this check — scan for `.from("table").select(...)` —
 * reports "no consumer" for `trip_map_projections`, which is fully wired. Twice
 * over:
 *
 *   * it is READ through the constant `TRIP_MAP_PROJECTIONS_TABLE`, not a
 *     literal;
 *   * it is WRITTEN by the SQL function `trip_map_projection_drain`, not by
 *     `.insert(...)`.
 *
 * A guard that fails on the one feature it was written for gets deleted, so this
 * resolves `export const X = "table"` declarations and counts RPC producers.
 *
 * ── WHAT IS ENFORCED ─────────────────────────────────────────────────────────
 *   1. Every registered projection's producer file exists AND actually writes
 *      the storage (directly, or through a declared producer function).
 *   2. Every registered consumer file exists AND actually reads the storage.
 *   3. kind "projection" has at least one consumer that is NOT its own producer.
 *   4. kind queue / backfill / sink carries a reason.
 *   5. An async producer's scheduler is actually started from its entry point.
 *   6. DISCOVERY: any table written by a projection-shaped file
 *      (Projection / Producer / Worker) that is not registered FAILS. The
 *      registry cannot be used to hide a projection — omitting one is itself a
 *      failure.
 *   7. Non-vacuity: the scan must examine a plausible number of files, and the
 *      registry must be non-empty.
 *
 * Run: node --import tsx/esm src/scripts/checkProjectionConsumers.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECTIONS as REAL_PROJECTIONS, type ProjectionEntry } from "../lib/projections/registry.js";

/**
 * The registry can be swapped for a crafted one, the same seam
 * FLAG_SCHEMA_SNAPSHOT gives checkFlagSchemaPrerequisites. It exists so the
 * mutation fixtures can PROVE each rule fires: a guard nobody has watched fail
 * is not a guard, and the failure paths here are otherwise unreachable while the
 * real registry is correct.
 */
const PROJECTIONS: readonly ProjectionEntry[] = process.env.PROJECTION_REGISTRY
  ? (JSON.parse(readFileSync(resolve(process.env.PROJECTION_REGISTRY), "utf8")) as ProjectionEntry[])
  : REAL_PROJECTIONS;

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const SRC = process.env.PROJECTION_SRC ? resolve(process.env.PROJECTION_SRC) : join(API_ROOT, "src");

const MIN_FILES_SCANNED = 100;
/** Files whose name says "I move data on a schedule" — the discovery surface. */
const PROJECTION_SHAPED = /(projection|producer|worker)/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "test" && e !== "migrations" && e !== "node_modules") walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** `export const FOO_TABLE = "some_table"` → FOO_TABLE ↦ some_table, tree-wide. */
function tableConstants(files: string[]): Map<string, string> {
  const m = new Map<string, string>();
  const re = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*["'`]([a-z0-9_]+)["'`]/g;
  for (const f of files) {
    for (const hit of readFileSync(f, "utf8").matchAll(re)) m.set(hit[1], hit[2]);
  }
  return m;
}

/** Table names a file reaches with `verb`, resolving constants through `consts`. */
function tablesTouched(sql: string, consts: Map<string, string>, verbs: RegExp): Set<string> {
  const out = new Set<string>();
  // LOOKAHEAD, not a capture. A capturing window CONSUMES those 500 characters,
  // so every later `.from(...)` inside it is skipped — which made this report
  // "no consumer" for routes/placeLiving.ts and routes/intelReadModels.ts, both
  // of which plainly read the table a few lines further down. A guard that
  // fails on correct code gets deleted, so the window must be non-consuming.
  const re = /\.from\(\s*(?:["'`]([a-z0-9_]+)["'`]|([A-Z][A-Z0-9_]*))\s*\)(?=([\s\S]{0,500}))/g;
  for (const m of sql.matchAll(re)) {
    const table = m[1] ?? consts.get(m[2] ?? "");
    if (!table) continue;
    if (verbs.test(m[3] ?? "")) out.add(table);
  }
  return out;
}

const WRITE_VERBS = /\.(insert|upsert|update|delete)\s*\(/;
const READ_VERBS = /\.select\s*\(/;

function main(): void {
  const files = walk(SRC);
  const consts = tableConstants(files);
  const rel = (f: string) => relative(SRC, f);

  const writesBy = new Map<string, Set<string>>();
  const readsBy = new Map<string, Set<string>>();
  const rpcBy = new Map<string, Set<string>>();

  for (const f of files) {
    const s = readFileSync(f, "utf8");
    const r = rel(f);
    for (const t of tablesTouched(s, consts, WRITE_VERBS)) {
      if (!writesBy.has(t)) writesBy.set(t, new Set());
      writesBy.get(t)!.add(r);
    }
    for (const t of tablesTouched(s, consts, READ_VERBS)) {
      if (!readsBy.has(t)) readsBy.set(t, new Set());
      readsBy.get(t)!.add(r);
    }
    for (const m of s.matchAll(/\.rpc\(\s*(?:["'`]([a-z0-9_]+)["'`]|([A-Z][A-Z0-9_]*))/g)) {
      const fn = m[1] ?? consts.get(m[2] ?? "");
      if (!fn) continue;
      if (!rpcBy.has(fn)) rpcBy.set(fn, new Set());
      rpcBy.get(fn)!.add(r);
    }
  }

  const problems: string[] = [];
  const registered = new Set<string>();

  for (const p of PROJECTIONS) {
    for (const t of p.storage) registered.add(t);

    // 1. producers exist and actually write the storage
    for (const prod of p.producers) {
      if (!existsSync(join(SRC, prod))) {
        problems.push(`${p.key}: producer ${prod} does not exist.`);
        continue;
      }
      const writesDirectly = p.storage.some((t) => writesBy.get(t)?.has(prod));
      const writesViaFn = (p.producerFunctions ?? []).some((fn) => rpcBy.get(fn)?.has(prod));
      if (!writesDirectly && !writesViaFn) {
        problems.push(
          `${p.key}: producer ${prod} writes neither ${p.storage.join("/")} directly nor any declared ` +
            `producer function (${(p.producerFunctions ?? []).join(", ") || "none declared"}). ` +
            `Either it stopped producing, or the registry is describing a pipe that no longer exists.`,
        );
      }
    }

    // 2 + 3. consumers exist, actually read, and (for a projection) are not just the producer
    const externalConsumers: string[] = [];
    for (const c of p.consumers) {
      if (!existsSync(join(SRC, c))) {
        problems.push(`${p.key}: consumer ${c} does not exist.`);
        continue;
      }
      const reads = p.storage.some((t) => readsBy.get(t)?.has(c));
      if (!reads) {
        problems.push(
          `${p.key}: declared consumer ${c} does not read ${p.storage.join("/")}. ` +
            `A consumer that stopped consuming is exactly the state this check exists to catch.`,
        );
        continue;
      }
      if (!p.producers.includes(c)) externalConsumers.push(c);
    }
    if (p.kind === "projection" && externalConsumers.length === 0) {
      problems.push(
        `${p.key}: NO CONSUMER outside its own producer. ${p.storage.join("/")} fills and nothing reads it — ` +
          `decorative architecture. Wire a real consumer, or reclassify as queue/backfill/sink WITH A REASON.`,
      );
    }

    // 4. non-projection kinds must justify themselves
    if (p.kind !== "projection" && !(p.reason && p.reason.trim().length > 40)) {
      problems.push(`${p.key}: kind "${p.kind}" requires a substantive reason; "nobody reads it" is the defect, not an exemption.`);
    }

    // 5. an async producer must actually be started
    if (p.scheduler) {
      const entry = join(SRC, p.scheduler.from);
      if (!existsSync(entry)) {
        problems.push(`${p.key}: scheduler entry point ${p.scheduler.from} does not exist.`);
      } else {
        const src = readFileSync(entry, "utf8");
        const called = new RegExp(`${p.scheduler.starts}\\s*\\(`).test(src);
        if (!called) {
          problems.push(
            `${p.key}: ${p.scheduler.starts} is never CALLED from ${p.scheduler.from}. ` +
              `An unstarted producer fills nothing, and the consumer then reads an empty table forever.`,
          );
        }
      }
    }
  }

  // 6. discovery — a projection-shaped writer whose storage is not registered
  for (const [table, writers] of writesBy) {
    if (registered.has(table)) continue;
    // Only the RUNTIME tree can strand a projection. src/scripts is operational
    // tooling — and this very file matches PROJECTION_SHAPED by name, so without
    // the exclusion the check reports itself as an unregistered projection.
    const shaped = [...writers].filter((w) => PROJECTION_SHAPED.test(w) && !w.startsWith("scripts/"));
    if (shaped.length === 0) continue;
    problems.push(
      `UNREGISTERED PROJECTION: ${table} is written by ${shaped.join(", ")} and is not in the projection registry. ` +
        `Add it (with its consumers), or the consumerless-projection defect can reappear unseen.`,
    );
  }

  console.log(
    `check:projection-consumers — ${files.length} file(s), ${consts.size} table constant(s) resolved, ` +
      `${PROJECTIONS.length} registered projection(s)`,
  );

  // 7. non-vacuity
  if (files.length < MIN_FILES_SCANNED || PROJECTIONS.length === 0) {
    console.error(
      `\nFAIL — VACUOUS: scanned ${files.length} file(s) (min ${MIN_FILES_SCANNED}) with ` +
        `${PROJECTIONS.length} registered projection(s). A check that examines nothing must not report success.`,
    );
    process.exit(1);
  }

  if (problems.length) {
    console.error(`\nFAIL — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  • ${p}`);
    console.error("");
    process.exit(1);
  }

  for (const p of PROJECTIONS) {
    const ext = p.consumers.filter((c) => !p.producers.includes(c));
    console.log(
      `  ${p.key.padEnd(28)} ${p.kind.padEnd(11)} ${p.storage.join(",").padEnd(46)} ` +
        `${ext.length} external consumer(s)${p.scheduler ? `, started by ${p.scheduler.starts}` : ""}`,
    );
  }
  console.log("\n✅ every registered projection has a producer that writes it and a consumer that reads it.");
}

main();
