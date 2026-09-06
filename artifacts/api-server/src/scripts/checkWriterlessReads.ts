/**
 * Static writerless-read check — `check:writerless-reads`.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * A table that this server READS and that NOTHING anywhere WRITES. Every such
 * read returns zero rows, in every environment, forever. The query is
 * well-formed, the columns exist, the enum labels are valid, the types check,
 * and the test suite is green — because a query against an empty table is
 * indistinguishable from a query against an empty fixture. Every existing guard
 * looks at the SHAPE of the query; this one asks whether the data can exist at
 * all.
 *
 * Two confirmed instances, both of which survived years of review:
 *
 *   `activity_events` — four of the five CreatorActivityScore components plus
 *   both penalties read it. Its only writer was an internal-secret-gated route
 *   nothing called, so 0.70 of the score's weight was structurally zero and a
 *   real score was the new-user floor of 10. The scheduler had the same shape
 *   twice: its candidate pool was (rows only it writes) UNION (activity_events
 *   actors), both empty forever, so no creator was ever scored a first time.
 *
 *   `public.circles` — seven readers, no writer in server TS, client TS, or
 *   SQL, and no circle-creation UI. One reader is an AUTHORIZATION predicate,
 *   so it denies every user, silently. The product's real "Circle" is the pair
 *   table `circle_memberships`; `public.circles` is an abandoned named-group
 *   design.
 *
 * WHAT COUNTS AS A WRITER
 * -----------------------
 * Deliberately generous, because a false failure here blocks unrelated work:
 *   - `.insert/.upsert/.update/.delete` in server TS (this workspace), OR
 *   - the same in client TS (the client writes plenty via PostgREST), OR
 *   - `INSERT INTO` / `UPDATE … SET` / `COPY … FROM` anywhere in SQL, including
 *     inside a function or trigger body, in migrations or the baseline.
 * `.delete()` counts as a writer: you cannot delete rows that never exist, so
 * its presence is evidence the table is populated by something.
 *
 * A dynamic `.from(expr)` anywhere makes attribution incomplete, and the run
 * says so rather than pretending otherwise.
 *
 * NOT EVERY WRITERLESS TABLE IS A DEFECT
 * --------------------------------------
 * Three legitimate shapes, and the ratchet below records which is which:
 *   - externally seeded reference data (`fsq_places`, `canonical_locations`)
 *   - a deliberately empty, human-curated allowlist — `intel_live_promoted_scopes`
 *     is documented as exactly this in migration 2179, and its emptiness is the
 *     fail-closed default, not a bug
 *   - a legacy decoy superseded by another table, pending removal
 * Each entry must say which, and why. An entry with no reason is a dead lane
 * wearing a note.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:writerless-reads
 *   pnpm run check:writerless-reads -- --verbose
 *
 * Exit 0 → every writerless read is on the ratchet with a stated reason.
 * Exit 1 → a new one appeared, or a ratcheted one was fixed and not struck off.
 */
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractTableAccess,
  collectStringLiterals,
  listSourceFiles,
  extractSqlWrittenTables,
  extractViewNames,
  listSqlFiles,
} from "./lib/tableAccessExtract.js";

const __dir = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = resolve(__dir, "../..");
export const REPO_ROOT = resolve(API_ROOT, "../..");

/** Server code whose reads are judged. */
export const SERVER_DIRS = [
  resolve(API_ROOT, "src/routes"),
  resolve(API_ROOT, "src/services"),
  resolve(API_ROOT, "src/lib"),
  resolve(API_ROOT, "src/compass"),
];
/** Additional places a WRITE may live. Reads here are not judged. */
export const WRITER_ONLY_DIRS = [
  resolve(API_ROOT, "src/scripts"),
  resolve(REPO_ROOT, "travel-buddy-standalone/src"),
  resolve(REPO_ROOT, "travel-buddy-standalone/app"),
];
export const SQL_DIRS = [
  resolve(API_ROOT, "src/migrations"),
  resolve(API_ROOT, "migrations"),
  resolve(API_ROOT, "baseline"),
];

/**
 * Tables this server reads that nothing writes — a RATCHET, not an allowlist.
 *
 * Counts are EXACT, so this fails in both directions: a new writerless read at
 * a listed table fails, and one that gained a writer but was not struck off
 * fails too. Entries whose `reason` is "dead lane" must reach zero.
 */
export const KNOWN_WRITERLESS_READS: Record<
  string,
  { readers: number; classification: "external-seed" | "human-allowlist" | "legacy-decoy" | "dead-lane"; note: string }
> = {};

/** file -> text, for the crude "is this route path mentioned anywhere else" test. */
function readAllSourceText(dirs: string[], repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of dirs) {
    for (const f of listSourceFiles(d)) {
      // Keyed RELATIVE to the repo root, because the write sites this is compared
      // against are relative. Keying by absolute path means the defining file
      // never matches itself, so its OWN definition of the route counts as an
      // external caller and the table is silently never reported.
      //
      // The VALUE is the file's string literals only, never its raw text. Prose
      // defeats a text search: the doc comment above the route, and the comments
      // in checkWriterlessReads.ts describing this very defect, all contain
      // "/internal/activity-events".
      out.set(relative(repoRoot, f), collectStringLiterals(f));
    }
  }
  return out;
}

export interface Writerless {
  table: string;
  readers: number;
  sites: string[];
}

export interface UnreachableProducer {
  table: string;
  readers: number;
  routePath: string;
  writerSite: string;
}

/**
 * Tables whose ONLY writers sit inside internal-secret-gated routes that nothing
 * in the repo calls.
 *
 * This is the second half of the defect, and the half that the plain
 * writerless check CANNOT see. `activity_events` had a writer —
 * POST /internal/activity-events — so it never looked dead. That route is gated
 * on the internal-service secret and is called by NOTHING: not this server, not
 * the client, not a scheduler, not a trigger. The table was therefore just as
 * empty as one with no writer at all, and it cost 0.70 of the creator-activity
 * score's weight.
 *
 * "Called by nothing" is judged by searching the repo for the route's path
 * string outside its own definition. That is deliberately crude and errs toward
 * silence: any mention at all — a client fetch, a scheduler, a doc listing it
 * as live — counts as a caller and the table is not reported.
 */
export function findUnreachableProducers(
  reads: Map<string, { file: string; line: number }[]>,
  writes: Map<string, { file: string; line: number; routePath?: string; internalGated?: boolean }[]>,
  pathIsReferencedElsewhere: (routePath: string, definedIn: string) => boolean,
): UnreachableProducer[] {
  const out: UnreachableProducer[] = [];
  for (const [table, sites] of reads) {
    const w = writes.get(table);
    if (!w || w.length === 0) continue; // the plain writerless check owns this case
    // every writer must be an internal-gated route handler
    if (!w.every((x) => x.internalGated === true && typeof x.routePath === "string")) continue;
    const unreferenced = w.filter((x) => !pathIsReferencedElsewhere(x.routePath!, x.file));
    if (unreferenced.length !== w.length) continue; // at least one route has a caller
    const first = unreferenced[0]!;
    out.push({
      table,
      readers: sites.length,
      routePath: first.routePath!,
      writerSite: `${first.file}:${first.line}`,
    });
  }
  return out.sort((a, b) => b.readers - a.readers || a.table.localeCompare(b.table));
}

/** Pure core, so a test can drive it against fixtures. */
export function findWriterless(
  reads: Map<string, { file: string; line: number }[]>,
  writtenAnywhere: Set<string>,
): Writerless[] {
  const out: Writerless[] = [];
  for (const [table, sites] of reads) {
    if (writtenAnywhere.has(table)) continue;
    out.push({
      table,
      readers: sites.length,
      sites: sites.map((s) => `${s.file}:${s.line}`),
    });
  }
  return out.sort((a, b) => b.readers - a.readers || a.table.localeCompare(b.table));
}

export function partition(
  found: Writerless[],
  ratchet: typeof KNOWN_WRITERLESS_READS,
): { fresh: Writerless[]; known: Writerless[]; stale: string[]; miscounted: string[] } {
  const fresh: Writerless[] = [];
  const known: Writerless[] = [];
  const miscounted: string[] = [];
  for (const w of found) {
    const entry = ratchet[w.table];
    if (!entry) { fresh.push(w); continue; }
    known.push(w);
    if (entry.readers !== w.readers) {
      miscounted.push(`${w.table} — ratchet says ${entry.readers} reader(s), found ${w.readers}`);
    }
  }
  const seen = new Set(found.map((w) => w.table));
  const stale = Object.keys(ratchet).filter((t) => !seen.has(t));
  return { fresh, known, stale, miscounted };
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");

  const server = extractTableAccess(SERVER_DIRS, REPO_ROOT);
  const elsewhere = extractTableAccess(WRITER_ONLY_DIRS, REPO_ROOT);
  const sqlFiles = listSqlFiles(SQL_DIRS);
  const sqlWritten = extractSqlWrittenTables(sqlFiles);
  // A VIEW is never written directly; reading one with no writer is not a defect.
  const views = extractViewNames(sqlFiles);

  const writtenAnywhere = new Set<string>([
    ...server.writes.keys(),
    ...elsewhere.writes.keys(),
    ...sqlWritten,
    ...views,
  ]);

  console.log(
    `Scanned ${server.filesScanned} server file(s) and ${elsewhere.filesScanned} other file(s); ` +
      `${server.reads.size} relation(s) read, ${writtenAnywhere.size} written or view-backed ` +
      `(${server.writes.size} server TS, ${elsewhere.writes.size} client/scripts TS, ${sqlWritten.size} SQL, ` +
      `${views.size} view(s) excluded).`,
  );
  if (server.sawDynamicFrom || elsewhere.sawDynamicFrom) {
    console.log(
      "  note: at least one dynamic .from(expr) was seen, so writer attribution is incomplete.\n" +
        "  This check errs toward silence: an unattributable write means a table is NOT reported.",
    );
  }

  // Is a route path mentioned anywhere outside the file that defines it?
  const allText = readAllSourceText([...SERVER_DIRS, ...WRITER_ONLY_DIRS], REPO_ROOT);
  const pathIsReferencedElsewhere = (routePath: string, definedIn: string): boolean => {
    if (routePath.length < 6) return true; // too generic to judge — stay silent
    for (const [file, text] of allText) {
      if (file === definedIn) continue;
      if (text.includes(routePath)) return true;
    }
    return false;
  };
  const unreachable = findUnreachableProducers(server.reads, server.writes, pathIsReferencedElsewhere);

  const found = findWriterless(server.reads, writtenAnywhere);
  const { fresh, known, stale, miscounted } = partition(found, KNOWN_WRITERLESS_READS);

  if (verbose) {
    for (const w of known) {
      const e = KNOWN_WRITERLESS_READS[w.table]!;
      console.log(`  [ratchet:${e.classification}] ${w.table} (${w.readers} reader(s))`);
    }
  }

  let failed = false;

  if (fresh.length > 0) {
    failed = true;
    console.error(`\n✗ ${fresh.length} table(s) are READ by this server but written by NOTHING:\n`);
    for (const w of fresh) {
      console.error(`  ${w.table} — ${w.readers} reader(s)`);
      for (const s of w.sites.slice(0, 6)) console.error(`      ${s}`);
      if (w.sites.length > 6) console.error(`      … and ${w.sites.length - 6} more`);
    }
    console.error(
      "\n  Every read of these returns zero rows, in every environment, forever. The query is\n" +
        "  well-formed and the suite is green, because an empty table and an empty fixture are\n" +
        "  the same thing to a fake Supabase client. If the table is externally seeded, a\n" +
        "  human-curated allowlist, or a legacy decoy, add it to KNOWN_WRITERLESS_READS with\n" +
        "  that classification and the evidence. If it is none of those, it is a dead lane:\n" +
        "  either give it a producer or remove the readers.\n",
    );
  }

  if (unreachable.length > 0) {
    failed = true;
    console.error(
      `\n✗ ${unreachable.length} table(s) have a writer, but the ONLY writer is an internal-secret-gated\n` +
        `  route that nothing in this repo calls:\n`,
    );
    for (const u of unreachable) {
      console.error(`  ${u.table} — ${u.readers} reader(s)`);
      console.error(`      only writer: ${u.writerSite}  (${u.routePath})`);
    }
    console.error(
      "\n  A producer nothing invokes is not a producer. This is exactly how activity_events\n" +
        "  looked healthy while being permanently empty: it HAD a writer, so no writerless check\n" +
        "  saw it, and 0.70 of the creator-activity score was structurally zero for months.\n" +
        "  Either give the route a caller, or treat the readers as dead and remove them.\n",
    );
  }

  if (miscounted.length > 0) {
    failed = true;
    console.error("\n✗ KNOWN_WRITERLESS_READS reader counts are wrong:");
    for (const m of miscounted) console.error(`  ${m}`);
  }

  if (stale.length > 0) {
    failed = true;
    console.error(
      "\n✗ KNOWN_WRITERLESS_READS entries no longer match — the table gained a writer, or the\n" +
        "  readers were removed, and the entry was not struck off:",
    );
    for (const t of stale) console.error(`  ${t}`);
  }

  if (failed) process.exit(1);

  const deadLanes = Object.values(KNOWN_WRITERLESS_READS).filter((e) => e.classification === "dead-lane").length;
  console.log(
    `\n✓ No unrecorded writerless reads. ${known.length} table(s) on the ratchet` +
      (deadLanes > 0 ? `, of which ${deadLanes} are dead lanes that must reach zero.` : "."),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  await main();
}
