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
  NON_AGGREGATE_MARKER,
  TRIP_KERNEL_DIRECT_WRITERS,
  type WriterBaseline,
} from "./tripKernelWriterBaseline.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const EXCLUDED_DIRS = new Set(["test", "scripts", "migrations", "node_modules"]);

const WRITE_VERB_RE = /\.(insert|update|upsert|delete)\s*\(/;
/** `trip-kernel:non-aggregate(trips.col, trips.other_col)` in a statement's leading comment. */
const NON_AGGREGATE_RE = new RegExp(`${NON_AGGREGATE_MARKER}\\(([^)]*)\\)`);
const LITERAL_FROM_RE = /\.from\(\s*(["'`])([A-Za-z0-9_]+)\1\s*\)/g;
const ANY_FROM_RE = /\.from\(\s*([^)\s])/g;
const KERNEL_IMPORT_RE = /from\s+["'][^"']*\/tripKernel(?:\.js)?["']/;
/** How far back from `.from(` a leading comment may sit and still belong to the statement. */
const MARKER_WINDOW = 600;
/**
 * The same for NON_AGGREGATE_MARKER, but larger. A non-aggregate declaration
 * has to be ARGUED next to the write — why a version bump would be semantically
 * wrong, at this site, in this file — and that argument is longer than 600
 * characters. Widening the window does not widen the exemption: the
 * previous-statement `;` rule below still binds a declaration to exactly one
 * statement, and the declaration is still checked column-for-column against
 * that statement's own payload.
 */
const NON_AGGREGATE_WINDOW = 4000;

export interface WriterCount {
  file: string;
  /** All literal direct writes. */
  count: number;
  /** Writes annotated LEGACY_PATH_MARKER (only meaningful when importsKernel). */
  gated: number;
  /** Writes carrying a VERIFIED NON_AGGREGATE_MARKER declaration. */
  nonAggregate: number;
  /** Whether the file imports lib/tripKernel — without it a marker is refused. */
  importsKernel: boolean;
  dynamicFrom: boolean;
  /**
   * One entry per NON_AGGREGATE_MARKER the check REFUSED, saying why. Each is a
   * hard failure: an exemption nobody can verify is not an exemption.
   */
  refusedNonAggregate: string[];
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

/**
 * Read the top-level keys of the object literal that starts at or after `from`.
 *
 * Returns null — meaning "this payload cannot be verified" — for anything that
 * is not a plain literal object written in place: a variable, a spread, a
 * computed key. That null is what makes a non-aggregate declaration refusable
 * rather than merely unchecked; a payload assembled elsewhere can grow a column
 * without this file changing, which is exactly the silent expansion the marker
 * must not permit.
 */
export function readObjectKeys(text: string, from: number): string[] | null {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] !== "{") return null;
  const keys: string[] = [];
  let depth = 0;
  let expectKey = true;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    // Strings first: a quote suspends every other rule until it closes.
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let raw = "";
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === ch) break;
        raw += text[j];
        j += 1;
      }
      if (depth === 1 && expectKey) {
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k])) k += 1;
        if (text[k] === ":") { keys.push(raw); expectKey = false; }
      }
      i = j;
      continue;
    }
    if (depth === 1 && expectKey) {
      // `...rest` and `[expr]:` can both name a column this file never spells.
      if (text.startsWith("...", i)) return null;
      if (ch === "[") return null;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth += 1;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0) return keys;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ",") { expectKey = true; continue; }
    if (ch === ":") { expectKey = false; continue; }
    if (!expectKey) continue;
    if (!/[A-Za-z_$]/.test(ch)) continue;
    let j = i;
    let id = "";
    while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) { id += text[j]; j += 1; }
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k += 1;
    // `col:` is a key; `col,` / `col}` is a shorthand key. Anything else is a
    // value expression (`new Date(...)`, `null`, `lang`) and names no column.
    if (text[k] === ":" || text[k] === "," || text[k] === "}") { keys.push(id); expectKey = false; }
    i = j - 1;
  }
  return null;
}

/**
 * Verify one `trip-kernel:non-aggregate(...)` declaration against the statement
 * it annotates. Returns null when the declaration holds, else the sentence that
 * says what is wrong with it.
 */
export function verifyNonAggregate(
  declaration: string,
  table: string,
  verb: string,
  payloadKeys: string[] | null,
): string | null {
  if (verb !== "update") {
    return `${NON_AGGREGATE_MARKER} on a .${verb}() of "${table}": creating or destroying a canonical trip row IS aggregate state; only a column-scoped update can be outside the aggregate`;
  }
  const declared = declaration.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (declared.length === 0) return `${NON_AGGREGATE_MARKER}() declares no column`;
  const cols: string[] = [];
  for (const d of declared) {
    const dot = d.indexOf(".");
    if (dot <= 0 || dot === d.length - 1) {
      return `${NON_AGGREGATE_MARKER}: "${d}" is not <table>.<column> — an exemption must name the table it applies to`;
    }
    const t = d.slice(0, dot);
    const c = d.slice(dot + 1);
    if (t !== table) return `${NON_AGGREGATE_MARKER}: declares "${d}" but the statement writes "${table}"`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) return `${NON_AGGREGATE_MARKER}: "${d}" is not a column name`;
    cols.push(c);
  }
  if (payloadKeys === null) {
    return `${NON_AGGREGATE_MARKER} on a payload that is not a literal object (a spread, a variable or a computed key): the columns written here cannot be read from this file, so the exemption cannot be bounded`;
  }
  const want = [...new Set(cols)].sort();
  const got = [...new Set(payloadKeys)].sort();
  if (want.join("|") !== got.join("|")) {
    return `${NON_AGGREGATE_MARKER} declares {${want.join(", ")}} but the statement writes {${got.join(", ")}} — an exemption covers exactly the columns it names`;
  }
  return null;
}

/** Count direct writes to canonical trip tables in one file's source text. */
export function countCanonicalWrites(
  text: string,
): Pick<WriterCount, "count" | "gated" | "nonAggregate" | "importsKernel" | "dynamicFrom" | "refusedNonAggregate"> {
  const canonical = new Set<string>(CANONICAL_TRIP_TABLES);
  let count = 0;
  let gated = 0;
  let nonAggregate = 0;
  const refusedNonAggregate: string[] = [];
  for (const m of text.matchAll(LITERAL_FROM_RE)) {
    if (!canonical.has(m[2])) continue;
    const table = m[2];
    const at = m.index ?? 0;
    const start = at + m[0].length;
    // The chained call ends at the statement terminator; bound the window so a
    // file with no semicolons cannot make one .from() swallow the next.
    const semi = text.indexOf(";", start);
    const end = Math.min(semi === -1 ? text.length : semi, start + 800);
    const verbMatch = WRITE_VERB_RE.exec(text.slice(start, end));
    if (!verbMatch) continue;
    count += 1;
    // The marker belongs to THIS statement only if it sits after the previous
    // statement's `;` — one marker cannot cover two writes.
    const lead = text.slice(Math.max(0, at - MARKER_WINDOW), at);
    const stmt = lead.slice(lead.lastIndexOf(";") + 1);
    if (stmt.includes(LEGACY_PATH_MARKER)) gated += 1;
    const wide = text.slice(Math.max(0, at - NON_AGGREGATE_WINDOW), at);
    const naStmt = wide.slice(wide.lastIndexOf(";") + 1);
    const declared = NON_AGGREGATE_RE.exec(naStmt);
    if (declared) {
      const payloadAt = start + (verbMatch.index ?? 0) + verbMatch[0].length;
      const why = verifyNonAggregate(declared[1], table, verbMatch[1], readObjectKeys(text, payloadAt));
      if (why === null) nonAggregate += 1;
      else refusedNonAggregate.push(why);
    } else if (naStmt.includes(NON_AGGREGATE_MARKER)) {
      // The bare token with no `(...)` names nothing and would be a blanket
      // exemption by another name.
      refusedNonAggregate.push(`${NON_AGGREGATE_MARKER} on a "${table}" write with no (table.column, ...) list — an exemption must name the exact columns it covers`);
    }
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
  return { count, gated, nonAggregate, importsKernel: KERNEL_IMPORT_RE.test(text), dynamicFrom, refusedNonAggregate };
}

export function surveyTree(root: string = SRC): WriterCount[] {
  const files: string[] = [];
  walk(root, files);
  const rows: WriterCount[] = [];
  for (const f of files.sort()) {
    const c = countCanonicalWrites(readFileSync(f, "utf8"));
    if (c.count > 0 || c.dynamicFrom || c.gated > 0 || c.refusedNonAggregate.length > 0) {
      rows.push({ file: relative(root, f).split("\\").join("/"), ...c });
    }
  }
  return rows;
}

/**
 * Ungated writes: every direct write the file can back with neither a kernel
 * path nor a verified non-aggregate declaration. A REFUSED declaration counts
 * as ungated — it is also its own separate failure, so a bad declaration can
 * never lower this number.
 */
export function ungatedOf(r: Pick<WriterCount, "count" | "gated" | "nonAggregate" | "importsKernel">): number {
  return r.count - (r.importsKernel ? r.gated : 0) - r.nonAggregate;
}

export interface RatchetVerdict {
  newWriters: WriterCount[];
  grew: Array<WriterCount & { baseline: WriterBaseline; ungated: number }>;
  shrank: Array<WriterCount & { baseline: WriterBaseline; ungated: number }>;
  /** Marker present in a file that does not import lib/tripKernel. */
  falseMarkers: WriterCount[];
  /** A non-aggregate declaration the check could not verify, with its reason. */
  refusedExemptions: WriterCount[];
  vanished: string[];
  incomplete: string[];
}

/** A baseline's non-aggregate allowance; an absent field means "none yet". */
export function baselineNonAggregate(b: WriterBaseline): number {
  return b.nonAggregate ?? 0;
}

export function judge(rows: WriterCount[], baseline: Record<string, WriterBaseline>): RatchetVerdict {
  const v: RatchetVerdict = { newWriters: [], grew: [], shrank: [], falseMarkers: [], refusedExemptions: [], vanished: [], incomplete: [] };
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.dynamicFrom) v.incomplete.push(r.file);
    if (r.gated > 0 && !r.importsKernel) v.falseMarkers.push(r);
    if (r.refusedNonAggregate.length > 0) v.refusedExemptions.push(r);
    if (r.count === 0) continue;
    seen.add(r.file);
    const b = baseline[r.file];
    const ungated = ungatedOf(r);
    if (b === undefined) { v.newWriters.push(r); continue; }
    const bNon = baselineNonAggregate(b);
    // Each of the three numbers ratchets independently. nonAggregate is in here
    // so a file cannot quietly convert a kernel-gated or ungated write into an
    // exemption: widening the exempt surface requires editing the baseline.
    if (r.count > b.direct || ungated > b.ungated || r.nonAggregate > bNon) v.grew.push({ ...r, baseline: b, ungated });
    else if (r.count < b.direct || ungated < b.ungated || r.nonAggregate < bNon) v.shrank.push({ ...r, baseline: b, ungated });
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
    for (const r of rows) {
      if (r.count === 0) continue;
      const na = r.nonAggregate > 0 ? `, nonAggregate: ${r.nonAggregate}` : "";
      console.log(`  "${r.file}": { direct: ${r.count}, ungated: ${ungatedOf(r)}${na} },`);
    }
    console.log("};");
    return 0;
  }

  const v = judge(rows, TRIP_KERNEL_DIRECT_WRITERS);
  const total = rows.reduce((n, r) => n + r.count, 0);
  const ungated = rows.reduce((n, r) => n + ungatedOf(r), 0);
  const files = rows.filter((r) => r.count > 0).length;
  const nonAggregate = rows.reduce((n, r) => n + r.nonAggregate, 0);
  const kernelGated = rows.reduce((n, r) => n + (r.importsKernel ? r.gated : 0), 0);
  const baselineUngated = Object.values(TRIP_KERNEL_DIRECT_WRITERS).reduce((n, b) => n + b.ungated, 0);
  console.log(
    `check:trip-kernel-writers — ${total} direct write(s) to ${CANONICAL_TRIP_TABLES.join("/")} across ${files} file(s); ` +
    `${kernelGated} kernel-gated, ${nonAggregate} declared non-aggregate, ` +
    `${ungated} UNGATED (neither; baseline ${baselineUngated}); baseline lists ${Object.keys(TRIP_KERNEL_DIRECT_WRITERS).length} file(s).`,
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
    for (const r of v.grew) console.log(`  ${r.file}: direct ${r.count} (baseline ${r.baseline.direct}), ungated ${r.ungated} (baseline ${r.baseline.ungated}), nonAggregate ${r.nonAggregate} (baseline ${baselineNonAggregate(r.baseline)})`);
  }
  if (v.falseMarkers.length) {
    rc = 1;
    console.log(`\nFAIL — ${v.falseMarkers.length} file(s) carry "${LEGACY_PATH_MARKER}" but never import lib/tripKernel; a write cannot claim a kernel path it does not have:`);
    for (const r of v.falseMarkers) console.log(`  ${r.file}: ${r.gated} marker(s)`);
  }
  if (v.refusedExemptions.length) {
    rc = 1;
    console.log(`\nFAIL — ${v.refusedExemptions.length} file(s) carry a "${NON_AGGREGATE_MARKER}" declaration the check REFUSES. An exemption that cannot be verified against the columns the statement actually writes is a blanket exemption wearing a precise costume:`);
    for (const r of v.refusedExemptions) for (const why of r.refusedNonAggregate) console.log(`  ${r.file}: ${why}`);
  }
  if (v.shrank.length) {
    console.log(`\nratchet can be tightened — ${v.shrank.length} file(s) now write LESS than the baseline; lower the entry in tripKernelWriterBaseline.ts:`);
    for (const r of v.shrank) console.log(`  ${r.file}: direct ${r.count} (baseline ${r.baseline.direct}), ungated ${r.ungated} (baseline ${r.baseline.ungated}), nonAggregate ${r.nonAggregate} (baseline ${baselineNonAggregate(r.baseline)})`);
  }
  if (v.vanished.length) {
    console.log(`\nratchet can be tightened — ${v.vanished.length} baseline file(s) no longer write any canonical trip table; remove the entry:`);
    for (const f of v.vanished) console.log(`  ${f}`);
  }
  if (rc === 0) console.log("\nOK — no new direct writer, no count grew, no false marker, no unverifiable exemption.");
  return rc;
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) process.exit(main());
