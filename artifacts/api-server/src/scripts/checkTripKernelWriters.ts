/**
 * check:trip-kernel-writers — the Trips spec §24 Phase 0 / Phase 1 ratchet.
 *
 * Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
 *   §24 Phase 0 "Freeze semantic drift by documenting current write paths,
 *                direct table mutations ..."
 *   §24 Phase 1 "Ratchet direct writes: new code must use commands; legacy
 *                paths are enumerated and reduced."
 *   §1  "No Map, Compass, Telegraph, Discovery, Buddy, or UI component may
 *       independently invent canonical trip state."
 *
 * WHAT IT DOES
 * ============
 * Walks src/ (excluding test/, scripts/, migrations/) and counts, per file,
 * every literal `.from("<canonical trip table>")` that is followed by
 * `.insert(` / `.update(` / `.upsert(` / `.delete(` before the statement ends.
 * The canonical tables are the Trip aggregate's own rows: trips, trip_members,
 * trip_plan_items (tripKernelWriterBaseline.ts).
 *
 * Each write is either GATED — its statement's leading comment carries the
 * token `trip-kernel:legacy-path` (LEGACY_PATH_MARKER) and the file imports
 * lib/tripKernel — or UNGATED. The baseline records both `direct` (all
 * writes) and `ungated` (writes with no kernel path) per file, and the check:
 *
 *   FAILS (exit 1) when a file not in the baseline writes a canonical table —
 *     a NEW direct writer — or when a listed file's `direct` or `ungated`
 *     count GREW, or when a file carries the marker without importing the
 *     kernel (an annotation is a claim that a command exists; the check
 *     refuses a claim the file cannot back). New code must go through
 *     lib/tripKernel.ts.
 *   PASSES (exit 0) when every count is <= its baseline. A count BELOW the
 *     baseline is reported so the baseline can be lowered; a ratchet that is
 *     never tightened stops being read.
 *   Exit 2 when it cannot establish a result (unreadable tree).
 *
 * WHAT IT CANNOT SEE — the same caveat checkWriterlessReads.ts records
 * =====================================================================
 * A dynamic `.from(expr)` is invisible to a literal scan, and so is an `.rpc(`
 * to a function that writes. Every file containing a non-literal `.from(` is
 * listed in the output as "attribution incomplete" so the reader knows the
 * count is a FLOOR for that file. Nothing here settles "nothing writes X".
 * The marker is likewise a claim, not a proof, that the gated path is
 * equivalent: src/test/tripKernel.test.ts and the lane report's byte-identity
 * scenario are what prove it.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:trip-kernel-writers
 *   pnpm run check:trip-kernel-writers -- --print-baseline   # emit the current
 *                                                            # counts as a TS literal
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_TRIP_TABLES,
  LEGACY_PATH_MARKER,
  TRIP_KERNEL_DIRECT_WRITERS,
  type WriterBaseline,
} from "./tripKernelWriterBaseline.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const EXCLUDED_DIRS = new Set(["test", "scripts", "migrations", "node_modules"]);

const WRITE_VERB_RE = /\.(insert|update|upsert|delete)\s*\(/;
const LITERAL_FROM_RE = /\.from\(\s*(["'`])([A-Za-z0-9_]+)\1\s*\)/g;
const ANY_FROM_RE = /\.from\(\s*([^)\s])/g;
const KERNEL_IMPORT_RE = /from\s+["'][^"']*\/tripKernel(?:\.js)?["']/;
/** How far back from `.from(` a leading comment may sit and still belong to the statement. */
const MARKER_WINDOW = 600;

export interface WriterCount {
  file: string;
  /** All literal direct writes. */
  count: number;
  /** Writes annotated LEGACY_PATH_MARKER (only meaningful when importsKernel). */
  gated: number;
  /** Whether the file imports lib/tripKernel — without it a marker is refused. */
  importsKernel: boolean;
  dynamicFrom: boolean;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      walk(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
}

/** Count direct writes to canonical trip tables in one file's source text. */
export function countCanonicalWrites(text: string): Pick<WriterCount, "count" | "gated" | "importsKernel" | "dynamicFrom"> {
  const canonical = new Set<string>(CANONICAL_TRIP_TABLES);
  let count = 0;
  let gated = 0;
  for (const m of text.matchAll(LITERAL_FROM_RE)) {
    if (!canonical.has(m[2])) continue;
    const at = m.index ?? 0;
    const start = at + m[0].length;
    // The chained call ends at the statement terminator; bound the window so a
    // file with no semicolons cannot make one .from() swallow the next.
    const semi = text.indexOf(";", start);
    const end = Math.min(semi === -1 ? text.length : semi, start + 800);
    if (!WRITE_VERB_RE.test(text.slice(start, end))) continue;
    count += 1;
    // The marker belongs to THIS statement only if it sits after the previous
    // statement's `;` — one marker cannot cover two writes.
    const lead = text.slice(Math.max(0, at - MARKER_WINDOW), at);
    const lastSemi = lead.lastIndexOf(";");
    if (lead.slice(lastSemi + 1).includes(LEGACY_PATH_MARKER)) gated += 1;
  }
  let dynamicFrom = false;
  for (const m of text.matchAll(ANY_FROM_RE)) {
    const ch = m[1];
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      // Array.from / Buffer.from / Promise-style helpers are not query builders.
      const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
      if (/(Array|Buffer|Uint8Array|Set|Map|BigInt)$/.test(before)) continue;
      dynamicFrom = true;
      break;
    }
  }
  return { count, gated, importsKernel: KERNEL_IMPORT_RE.test(text), dynamicFrom };
}

export function surveyTree(root: string = SRC): WriterCount[] {
  const files: string[] = [];
  walk(root, files);
  const rows: WriterCount[] = [];
  for (const f of files.sort()) {
    const c = countCanonicalWrites(readFileSync(f, "utf8"));
    if (c.count > 0 || c.dynamicFrom || c.gated > 0) {
      rows.push({ file: relative(root, f).split("\\").join("/"), ...c });
    }
  }
  return rows;
}

/** Ungated writes: every direct write the file cannot back with a kernel path. */
export function ungatedOf(r: Pick<WriterCount, "count" | "gated" | "importsKernel">): number {
  return r.importsKernel ? r.count - r.gated : r.count;
}

export interface RatchetVerdict {
  newWriters: WriterCount[];
  grew: Array<WriterCount & { baseline: WriterBaseline; ungated: number }>;
  shrank: Array<WriterCount & { baseline: WriterBaseline; ungated: number }>;
  /** Marker present in a file that does not import lib/tripKernel. */
  falseMarkers: WriterCount[];
  vanished: string[];
  incomplete: string[];
}

export function judge(rows: WriterCount[], baseline: Record<string, WriterBaseline>): RatchetVerdict {
  const v: RatchetVerdict = { newWriters: [], grew: [], shrank: [], falseMarkers: [], vanished: [], incomplete: [] };
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.dynamicFrom) v.incomplete.push(r.file);
    if (r.gated > 0 && !r.importsKernel) v.falseMarkers.push(r);
    if (r.count === 0) continue;
    seen.add(r.file);
    const b = baseline[r.file];
    const ungated = ungatedOf(r);
    if (b === undefined) { v.newWriters.push(r); continue; }
    if (r.count > b.direct || ungated > b.ungated) v.grew.push({ ...r, baseline: b, ungated });
    else if (r.count < b.direct || ungated < b.ungated) v.shrank.push({ ...r, baseline: b, ungated });
  }
  for (const f of Object.keys(baseline)) if (!seen.has(f)) v.vanished.push(f);
  return v;
}

function main(): number {
  const printBaseline = process.argv.includes("--print-baseline");
  let rows: WriterCount[];
  try {
    rows = surveyTree();
  } catch (e) {
    console.error(`check:trip-kernel-writers: cannot read the tree: ${(e as Error).message}`);
    return 2;
  }

  if (printBaseline) {
    console.log("export const TRIP_KERNEL_DIRECT_WRITERS: Record<string, WriterBaseline> = {");
    for (const r of rows) if (r.count > 0) console.log(`  "${r.file}": { direct: ${r.count}, ungated: ${ungatedOf(r)} },`);
    console.log("};");
    return 0;
  }

  const v = judge(rows, TRIP_KERNEL_DIRECT_WRITERS);
  const total = rows.reduce((n, r) => n + r.count, 0);
  const ungated = rows.reduce((n, r) => n + ungatedOf(r), 0);
  const files = rows.filter((r) => r.count > 0).length;
  const baselineUngated = Object.values(TRIP_KERNEL_DIRECT_WRITERS).reduce((n, b) => n + b.ungated, 0);
  console.log(
    `check:trip-kernel-writers — ${total} direct write(s) to ${CANONICAL_TRIP_TABLES.join("/")} across ${files} file(s); ` +
    `${ungated} UNGATED (no kernel path; baseline ${baselineUngated}); baseline lists ${Object.keys(TRIP_KERNEL_DIRECT_WRITERS).length} file(s).`,
  );

  if (v.incomplete.length) {
    console.log(`\nattribution INCOMPLETE for ${v.incomplete.length} file(s) — a non-literal .from(expr) is present, so the count there is a floor:`);
    for (const f of v.incomplete) console.log(`  ${f}`);
  }

  let rc = 0;
  if (v.newWriters.length) {
    rc = 1;
    console.log(`\nFAIL — ${v.newWriters.length} file(s) write a canonical trip table and are NOT in the baseline. New code issues Trip Commands (lib/tripKernel.ts); it does not write trips / trip_members / trip_plan_items directly:`);
    for (const r of v.newWriters) console.log(`  ${r.file}: ${r.count}`);
  }
  if (v.grew.length) {
    rc = 1;
    console.log(`\nFAIL — ${v.grew.length} file(s) gained direct or ungated writes (legacy paths may only shrink):`);
    for (const r of v.grew) console.log(`  ${r.file}: direct ${r.count} (baseline ${r.baseline.direct}), ungated ${r.ungated} (baseline ${r.baseline.ungated})`);
  }
  if (v.falseMarkers.length) {
    rc = 1;
    console.log(`\nFAIL — ${v.falseMarkers.length} file(s) carry "${LEGACY_PATH_MARKER}" but never import lib/tripKernel; a write cannot claim a kernel path it does not have:`);
    for (const r of v.falseMarkers) console.log(`  ${r.file}: ${r.gated} marker(s)`);
  }
  if (v.shrank.length) {
    console.log(`\nratchet can be tightened — ${v.shrank.length} file(s) now write LESS than the baseline; lower the entry in tripKernelWriterBaseline.ts:`);
    for (const r of v.shrank) console.log(`  ${r.file}: direct ${r.count} (baseline ${r.baseline.direct}), ungated ${r.ungated} (baseline ${r.baseline.ungated})`);
  }
  if (v.vanished.length) {
    console.log(`\nratchet can be tightened — ${v.vanished.length} baseline file(s) no longer write any canonical trip table; remove the entry:`);
    for (const f of v.vanished) console.log(`  ${f}`);
  }
  if (rc === 0) console.log("\nOK — no new direct writer, no count grew, no false marker.");
  return rc;
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) process.exit(main());
