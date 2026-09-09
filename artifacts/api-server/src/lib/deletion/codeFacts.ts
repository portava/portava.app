/**
 * codeFacts — what the SERVER CODE does with each table, measured by scanning
 * the source tree rather than asserted from memory.
 *
 * The graph needs three things this answers mechanically:
 *   * who READS a table (and in particular whether an HTTP route does), which
 *     is half of "can a non-owner see this today, and through what";
 *   * who WRITES it, which separates a table the product maintains from a
 *     legacy one nothing touches;
 *   * whether some RETENTION sweeper already deletes from it on a timer, which
 *     is the "another retention rule already governs it" field.
 *
 * ── LIMITS, stated ──────────────────────────────────────────────────────────
 * This is a lexical scan of `.from("<table>")` call sites, not a type-aware
 * analysis. It therefore:
 *   * cannot see a table addressed through a variable (`sc.from(tableName)`) —
 *     such a site is invisible here and the count is a FLOOR, never a proof of
 *     absence. `unreferencedByCode` means "no literal call site", nothing more;
 *   * cannot see SQL inside an RPC/SECURITY DEFINER function, so a table only
 *     touched by `erase_intel_for_actor` reads as unreferenced;
 *   * cannot see views, PostgREST embedded selects (`select("*, other(*)")`) or
 *     the mobile client, which talks to PostgREST directly with the user's JWT.
 *     RLS, not this scan, is what governs that path — which is why the graph
 *     carries the schema-derived RLS exposure alongside these route lists.
 *   * classifies a call site's VERB by looking at the text that follows it, so
 *     an unusual chain shape can be miscounted. It never guesses in the
 *     permissive direction: a site whose verb cannot be identified is recorded
 *     as an "unknown verb" reference and still counts as a reference.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface TableCodeUsage {
  table: string;
  /** Repo-relative files containing a `.from("table").select(...)` site. */
  reads: string[];
  /** Files containing insert/update/upsert on the table. */
  writes: string[];
  /** Files containing a delete on the table. */
  deletes: string[];
  /** Reads that live under src/routes — an HTTP surface reaches the table. */
  routeReaders: string[];
  /** Files that delete from the table AND look like a timed retention sweep. */
  retentionSweepers: string[];
  /** Call sites whose chain verb could not be identified. */
  unknownVerbSites: number;
}

const FROM_RE = /\.from\(\s*"([a-z][a-z0-9_]*)"\s*\)/g;
/** A module whose job is timed deletion. Name-based, deliberately narrow. */
const RETENTION_FILE_RE = /(retention|cleanup|sweeper|sweep|purge|expiry|prune)/i;

function walk(dir: string, out: string[], skip: (p: string) => boolean): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (skip(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out, skip);
    else if (p.endsWith(".ts") || p.endsWith(".mts")) out.push(p);
  }
}

/**
 * Scan `<root>/src` for table call sites.
 *
 * Test files are excluded: a fake client in a test proves nothing about what
 * production reads, and including them would make every table look reachable.
 */
export function scanCodeUsage(root: string): Map<string, TableCodeUsage> {
  const files: string[] = [];
  const srcDir = join(root, "src");
  walk(srcDir, files, (p) => {
    const rel = relative(root, p);
    return rel.split(sep).includes("test") || rel.endsWith(".test.ts") || rel.endsWith(".d.ts");
  });

  const usage = new Map<string, TableCodeUsage>();
  const get = (t: string): TableCodeUsage => {
    let u = usage.get(t);
    if (!u) {
      u = { table: t, reads: [], writes: [], deletes: [], routeReaders: [], retentionSweepers: [], unknownVerbSites: 0 };
      usage.set(t, u);
    }
    return u;
  };
  const add = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v); };

  for (const file of files) {
    const rel = relative(root, file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(FROM_RE)) {
      const idx = m.index ?? 0;
      // `sc.storage.from("bucket")` is a STORAGE bucket, not a table.
      if (/storage\s*$/.test(src.slice(Math.max(0, idx - 12), idx))) continue;
      const table = m[1];
      const tail = src.slice(idx + m[0].length, idx + m[0].length + 300);
      const u = get(table);
      let known = false;
      if (/^\s*\.?\s*(select|maybeSingle|single)\b/.test(tail) || /\.select\(/.test(tail.slice(0, 120))) {
        add(u.reads, rel);
        if (rel.startsWith(`src${sep}routes${sep}`)) add(u.routeReaders, rel);
        known = true;
      }
      if (/^\s*\.?\s*(insert|update|upsert)\b/.test(tail)) { add(u.writes, rel); known = true; }
      if (/^\s*\.?\s*delete\b/.test(tail)) {
        add(u.deletes, rel);
        if (RETENTION_FILE_RE.test(rel)) add(u.retentionSweepers, rel);
        known = true;
      }
      if (!known) u.unknownVerbSites += 1;
    }
  }
  return usage;
}

/**
 * Retention that runs through an RPC instead of a PostgREST delete.
 *
 * `scanCodeUsage` cannot see it: `intelRetentionScheduler` calls
 * `db.rpc("purge_intel_contributions_older_than", …)` and the tables it clears
 * are named only inside the SQL function body. So this reads the MIGRATIONS —
 * still a measurement, still mechanical — and links three facts:
 *   the function name, the tables its body DELETEs FROM, and the server module
 *   that calls it.
 * A table appears here only when all three line up, so a purge function nothing
 * calls does not count as a live retention rule.
 */
export interface RetentionRpcFact {
  fn: string;
  migration: string;
  tables: string[];
  callers: string[];
}

const PURGE_FN_RE = /CREATE (?:OR REPLACE )?FUNCTION public\.([a-z0-9_]+)\s*\(/gi;
const RETENTION_FN_NAME_RE = /(purge|retention|cleanup|expire|prune|sweep)/i;

export function scanRetentionRpcs(root: string): Map<string, RetentionRpcFact[]> {
  const migrationsDir = join(root, "src", "migrations");
  const codeFiles: string[] = [];
  walk(join(root, "src"), codeFiles, (p) => {
    const rel = relative(root, p);
    return rel.split(sep).includes("test") || rel.endsWith(".test.ts") || rel.endsWith(".d.ts");
  });
  const sources = codeFiles
    // The deletion library itself names these functions in prose. A comment is
    // not a caller, and counting one would make this scan cite itself.
    .filter((f) => !relative(root, f).split(sep).includes("deletion"))
    .map((f) => ({ rel: relative(root, f), text: readFileSync(f, "utf8") }));

  const byTable = new Map<string, RetentionRpcFact[]>();
  let migrations: string[] = [];
  try {
    migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  } catch {
    return byTable; // no migrations directory in this checkout
  }

  for (const file of migrations) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const m of sql.matchAll(PURGE_FN_RE)) {
      const fn = m[1];
      if (!RETENTION_FN_NAME_RE.test(fn)) continue;
      // Body = from this CREATE FUNCTION to the next one (or end of file).
      const start = m.index ?? 0;
      const rest = sql.slice(start + m[0].length);
      const nextIdx = rest.search(/CREATE (?:OR REPLACE )?FUNCTION public\./i);
      const body = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
      const tables = [...body.matchAll(/DELETE FROM (?:public\.)?([a-z0-9_]+)/gi)].map((d) => d[1]);
      if (tables.length === 0) continue;
      const callers = sources.filter((s) => s.text.includes(`"${fn}"`) || s.text.includes(`'${fn}'`)).map((s) => s.rel);
      if (callers.length === 0) continue;
      for (const table of new Set(tables)) {
        const list = byTable.get(table) ?? [];
        list.push({ fn, migration: `src/migrations/${file}`, tables: [...new Set(tables)], callers });
        byTable.set(table, list);
      }
    }
  }
  return byTable;
}
