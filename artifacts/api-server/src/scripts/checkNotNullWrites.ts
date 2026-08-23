/**
 * check-not-null-writes — no write payload may put null in a NOT NULL column.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Supersedes check:anonymisation-payload, which checked one file. The narrow
 * version was written for a real defect: executeAccountDeletion's
 * `anonymise_profile` step wrote `handle: null` against
 * `profiles.handle text NOT NULL UNIQUE`, raising 23502 on every run — and
 * because that step is fatal and runs AFTER the irreversible content steps,
 * deletion destroyed the user's content and then kept their auth row and email.
 *
 * Widening the same check to the whole tree immediately found a second instance
 * of the identical class, which is why it is worth having as a gate rather than
 * a one-off fix:
 *
 *   POST /api/me/preferences/mute-category inserted `recommendation_id: null`
 *   against `user_preference_events.recommendation_id text NOT NULL`. The
 *   insert failed every time, the handler logged it as best-effort and returned
 *   200 {ok:true, muted:true}. Muting a category silently did nothing, and
 *   user_preference_events holds 0 rows in production.
 *
 * ── THE TWO SHAPES IT CATCHES ───────────────────────────────────────────────
 *   col: null                    — a literal null
 *   col: something ?? null       — a nullish fallback TO null, which is the same
 *                                  bug wearing a default. writePreferenceEvent
 *                                  had exactly this, while typing the field
 *                                  optional and so inviting callers to hit it.
 *
 * ── LIMITS, STATED RATHER THAN IMPLIED ──────────────────────────────────────
 *   * Only literal nulls. `col: maybeUndefined` is invisible here — a variable
 *     that happens to be null at runtime cannot be seen statically.
 *   * Only tables in the committed baseline dump. Post-cutover tables are
 *     counted and printed as unverifiable rather than passed silently.
 *   * Says nothing about whether a column SHOULD be NOT NULL. It reports the
 *     disagreement between the code and the schema, not which one is wrong.
 *
 * Static, so it needs no database and runs on every push.
 * Run: node --import tsx/esm src/scripts/checkNotNullWrites.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_PATH, notNullColumns } from "./parseBaselineSchema.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dir, "..");

/** Generated types and test mocks legitimately contain nulls. */
const SKIP_DIRS = new Set(["test", "node_modules"]);
const SKIP_FILES = new Set(["database.types.ts"]);

export interface NullWrite {
  file: string;
  line: number;
  table: string;
  op: string;
  /** Columns the payload sets to null, either literally or via `?? null`. */
  nulled: string[];
}

const FROM_RE = /\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g;
const WRITE_RE = /\.(insert|update|upsert)\(\s*\{/;

/**
 * Split an object literal's body on its TOP-LEVEL commas.
 *
 * Line-based splitting is wrong and quietly so: this codebase frequently puts
 * several keys on one line, e.g.
 *
 *   { owner_id: ctx.userId, title: p.title, description: p.description ?? null }
 *
 * A per-line regex matches that whole line and reports the FIRST key, so the
 * null belonging to `description` gets attributed to `owner_id` — a NOT NULL
 * column — and the check invents a defect that is not there. An early version of
 * this gate did exactly that and produced 16 false positives, every one of them
 * claiming a foreign key was being nulled.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  let quote: string | null = null;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

/** The column a `key: value` pair nulls, or null if it does not null anything. */
export function nulledColumn(pair: string): string | null {
  const cleaned = pair.replace(/\/\/.*$/gm, "").trim();
  const colon = cleaned.indexOf(":");
  if (colon === -1) return null;
  const key = cleaned.slice(0, colon).trim();
  if (!/^[A-Za-z0-9_]+$/.test(key)) return null;
  const value = cleaned.slice(colon + 1).trim();
  // `col: null` and `col: expr ?? null` are the same defect; the second is it
  // wearing a default.
  if (value === "null" || /\?\?\s*null$/.test(value)) return key;
  return null;
}

/** Every write payload in one file that sets at least one column to null. */
export function findNullWrites(src: string, file: string): NullWrite[] {
  const out: NullWrite[] = [];
  FROM_RE.lastIndex = 0;

  for (let m = FROM_RE.exec(src); m !== null; m = FROM_RE.exec(src)) {
    const table = m[1];
    const after = m.index + m[0].length;
    // Only look as far as the next .from(), so a payload is never attributed
    // to the wrong table.
    const nextFrom = src.indexOf(".from(", after);
    const horizon = nextFrom === -1 ? Math.min(src.length, after + 3000) : nextFrom;
    const wm = WRITE_RE.exec(src.slice(after, horizon));
    if (!wm) continue;

    const bodyStart = after + wm.index + wm[0].length;
    let i = bodyStart, depth = 1;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const body = src.slice(bodyStart, i - 1);

    const nulled = splitTopLevel(body)
      .map(nulledColumn)
      .filter((c): c is string => c !== null);

    if (nulled.length > 0) {
      out.push({ file, line: src.slice(0, m.index).split("\n").length, table, op: wm[1], nulled });
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, acc);
    } else if (entry.endsWith(".ts") && !SKIP_FILES.has(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

function main(): void {
  const baselineSql = readFileSync(BASELINE_PATH, "utf8");
  const files = walk(SRC_ROOT);

  const writes: NullWrite[] = [];
  for (const f of files) {
    writes.push(...findNullWrites(readFileSync(f, "utf8"), relative(SRC_ROOT, f)));
  }

  // A check that finds nothing to inspect is not a passing check.
  if (writes.length === 0) {
    console.error(
      "check-not-null-writes: FOUND NO write payload containing a null, across " +
      `${files.length} file(s). The extractor is stale — refusing to report success.`,
    );
    process.exit(1);
  }

  const problems: string[] = [];
  const unverifiable = new Set<string>();

  for (const w of writes) {
    const nn = notNullColumns(baselineSql, w.table);
    if (nn.size === 0) { unverifiable.add(w.table); continue; }
    const bad = w.nulled.filter((c) => nn.has(c));
    if (bad.length > 0) {
      problems.push(
        `${w.file}:${w.line} — .${w.op}() on ${w.table} sets ${bad.join(", ")} to null, ` +
        `but the baseline declares ${bad.length > 1 ? "them" : "it"} NOT NULL. ` +
        `This raises 23502 at runtime.`,
      );
    }
  }

  console.log(
    `\ncheck-not-null-writes: ${files.length} source file(s), ` +
    `${writes.length} write payload(s) containing a null\n` +
    `   ${unverifiable.size} table(s) absent from the baseline — not verifiable here` +
    (unverifiable.size > 0 ? `: ${[...unverifiable].sort().join(", ")}` : ""),
  );

  if (problems.length > 0) {
    console.error("\n✗ a write payload puts null in a NOT NULL column:\n");
    for (const p of problems) console.error(`   - ${p}`);
    console.error(
      "\n  Write a non-null value instead. If the column has no natural value at this\n" +
      "  call site, a synthetic composite id is the established convention here\n" +
      "  (telegraphCommands uses `${commandId}:${actionId}`). If the column genuinely\n" +
      "  ought to be nullable, change the schema — do not leave the code disagreeing\n" +
      "  with it, especially where the failure is swallowed as best-effort.\n",
    );
    process.exit(1);
  }

  console.log("✓ no write payload nulls a NOT NULL column.\n");
}

// Run only when executed directly; the test suite imports findNullWrites.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
