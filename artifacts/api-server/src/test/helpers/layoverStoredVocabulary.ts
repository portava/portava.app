/**
 * layoverStoredVocabulary.ts — what the layover decision writers CAN send, and
 * what the 2700/2992 CHECK constraints admit, each derived mechanically.
 *
 * WHY THIS EXISTS (census-layover §73, migration 3792). 2700's
 * `layover_certified_computations.verdict` CHECK listed four verdicts. The
 * engine's union gained a fifth, `entry_unverified`, on 2026-09-22, and the
 * writer (`ledgerRowFor`, spread by `certifiedComputationRowFor`) sends that
 * union unmapped. Every roomy layover with an unconfirmed entry corridor — every
 * roomy layover, while `entry_requirements` is uncurated — would therefore have
 * failed the CHECK the moment persistence was switched on. Nothing caught it:
 * `fakeLayoverDb` models no CHECK and no database suite covered the table.
 *
 * So neither side of the comparison here is a hand-written list:
 *   - the WRITER side is read from the TypeScript program by the compiler's own
 *     type checker (`ReturnType<typeof ledgerRowFor>["verdict"]` and friends), so
 *     a member added to the engine's union appears here without anyone editing
 *     this file;
 *   - the DATABASE side is read from the NEWEST migration that defines the CHECK,
 *     found by scanning, so the next widening is checked without editing this
 *     file either.
 *
 * A type that stops being a union of string literals (widened to `string`, say)
 * is REFUSED rather than read as "no members": an empty vocabulary would make
 * every subset assertion pass vacuously.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const API_SRC = path.resolve(HERE, "..", "..");
export const MIGRATIONS_DIR = path.join(API_SRC, "migrations");

// ── the writer side: the compiler's answer ──────────────────────────────────

/**
 * Each alias is a type expression over the writers' own exports. The virtual
 * module sits in services/layover/, beside LayoverDecisionStore.ts, so its
 * relative imports are the ones a real module there would write.
 */
const PROBE_SOURCE = `
import type { ledgerRowFor } from "../airport/layoverLedger.js";
import type { LeaveAdvice } from "../airport/LayoverSafetyEngine.js";
import type { LayoverFeasibilityRecord } from "../airport/LayoverFeasibility.js";
import type { LayoverConstraintSet, EntryPermissionState } from "../airport/LayoverConstraints.js";
import type { riskBandFor } from "./LayoverDecisionStore.js";
import type { TravellerCheckpointType } from "./LayoverCheckpointStore.js";
import type { BoardingOutcome } from "./LayoverOutcomeStore.js";
export type EngineVerdict = LeaveAdvice["verdict"];
export type CertifiedRowVerdict = ReturnType<typeof ledgerRowFor>["verdict"];
export type CertifiedRowConfidence = ReturnType<typeof ledgerRowFor>["confidence"];
export type CertifiedRowBufferPercentile = ReturnType<typeof ledgerRowFor>["buffer_percentile"];
export type RecordConfidence = LayoverFeasibilityRecord["confidence"];
export type RecordBufferPercentile = LayoverFeasibilityRecord["inputs"]["bufferPercentile"];
export type RiskBand = Exclude<ReturnType<typeof riskBandFor>, null>;
export type BaggageMode = LayoverConstraintSet["baggageMode"];
export type EntryPermission = EntryPermissionState;
export type CheckpointType = TravellerCheckpointType;
export type OutcomeBoarding = BoardingOutcome;
`;

export type ProbeAlias =
  | "EngineVerdict"
  | "CertifiedRowVerdict"
  | "CertifiedRowConfidence"
  | "CertifiedRowBufferPercentile"
  | "RecordConfidence"
  | "RecordBufferPercentile"
  | "RiskBand"
  | "BaggageMode"
  | "EntryPermission"
  | "CheckpointType"
  | "OutcomeBoarding";

let cached: Map<string, string[]> | null = null;

/** Every alias in the probe, resolved by the checker to its string-literal members, sorted. */
export function writerVocabularies(): Map<string, string[]> {
  if (cached) return cached;
  const dir = path.join(API_SRC, "services", "layover");
  const probePath = path.join(dir, "__stored_vocabulary_probe__.ts");
  const virtual = new Map([[probePath, PROBE_SOURCE]]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ["workspace"],
    strictNullChecks: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
  };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) => {
    const v = virtual.get(path.resolve(f));
    return v !== undefined ? ts.createSourceFile(f, v, lang, true, ts.ScriptKind.TS) : getSourceFile(f, lang, onError, create);
  };
  host.fileExists = (f) => virtual.has(path.resolve(f)) || fileExists(f);
  host.readFile = (f) => virtual.get(path.resolve(f)) ?? readFile(f);

  const program = ts.createProgram([probePath], options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(probePath);
  if (!sf) throw new Error("the vocabulary probe did not load");

  // A probe that does not resolve (a renamed export, a moved module) must fail
  // HERE, by name — an unresolved import types as `any`, which is not a union.
  const errors = ts
    .getPreEmitDiagnostics(program, sf)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  if (errors.length > 0) throw new Error(`the vocabulary probe does not type-check:\n  ${errors.join("\n  ")}`);

  const out = new Map<string, string[]>();
  for (const st of sf.statements) {
    if (!ts.isTypeAliasDeclaration(st)) continue;
    const t = checker.getTypeAtLocation(st.name);
    const parts = t.isUnion() ? t.types : [t];
    const values: string[] = [];
    for (const p of parts) {
      if (!p.isStringLiteral()) {
        throw new Error(
          `${st.name.text} has a member that is not a string literal (${checker.typeToString(p)}); ` +
            "a widened type has no vocabulary to compare, and reading it as empty would pass every check vacuously",
        );
      }
      values.push(p.value);
    }
    out.set(st.name.text, values.sort());
  }
  cached = out;
  return out;
}

export function writerVocabulary(alias: ProbeAlias): string[] {
  const v = writerVocabularies().get(alias);
  if (!v || v.length === 0) throw new Error(`no vocabulary was derived for ${alias}`);
  return v;
}

// ── the database side: the newest migration's CHECK ─────────────────────────

/** Migration files in numeric-prefix order (the applier's byte order for these four-digit names). */
function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

/** Blank `--` comments (not inside a string literal on that line) so prose quoting SQL is never read as SQL. */
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'") inQuote = !inQuote;
        else if (!inQuote && ch === "-" && line[i + 1] === "-") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/**
 * The statements of `sql` that create or alter `table` (with or without the
 * `public.` qualifier), as text. A statement ends at a `;` outside quotes and
 * dollar-quoted bodies; DO blocks are not ALTER statements and are skipped,
 * which is deliberate — a vocabulary hidden inside dynamic SQL is not one a
 * reviewer, or this reader, can see.
 */
function statementsFor(sql: string, table: string): string[] {
  const out: string[] = [];
  let i = 0;
  let start = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? sql.length : end + m[0].length;
        continue;
      }
    }
    if (ch === ";") {
      out.push(sql.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(sql.slice(start));
  const head = new RegExp(`^\\s*(?:CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?)(?:public\\.)?${table}\\b`, "i");
  return out.filter((s) => head.test(s));
}

export interface CheckVocabulary {
  /** The newest migration that states this column's enumerated CHECK. */
  file: string;
  /** The quoted literals it admits, sorted. */
  values: string[];
  /** True when the CHECK is `col IS NULL OR col IN (...)`. */
  nullable: boolean;
}

/**
 * The enumerated CHECK on `table.column`, as the NEWEST migration that states
 * one writes it. Throws when no migration states one: a caller asserting a
 * subset of nothing would pass for every writer. It reads only `col IN (...)` / `col IS NULL OR col IN (...)`: a later narrowing written as `col <> '…'`, `col = ANY (ARRAY[...])` or inside a DO block leaves it green (V-722; the CI local-db "every verdict is stored" suite is the backstop).
 */
export function newestCheckVocabulary(table: string, column: string, dir = MIGRATIONS_DIR): CheckVocabulary {
  const re = new RegExp(
    `CHECK\\s*\\(\\s*(${column}\\s+IS\\s+NULL\\s+OR\\s+)?${column}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`,
    "gi",
  );
  let found: CheckVocabulary | null = null;
  for (const f of migrationFiles(dir)) {
    const sql = stripLineComments(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const stmt of statementsFor(sql, table)) {
      for (const m of stmt.matchAll(re)) {
        found = {
          file: f,
          values: [...m[2]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!).sort(),
          nullable: Boolean(m[1]),
        };
      }
    }
  }
  if (!found) throw new Error(`no migration states an enumerated CHECK on ${table}.${column}`);
  return found;
}

// ── the writers themselves ──────────────────────────────────────────────────

export interface WriteSite {
  /** Repository-relative to src/. */
  file: string;
  table: string;
  verb: "insert" | "upsert" | "update";
  /** The payload expression's first token(s), e.g. `certifiedComputationRowFor(` or `row` or `{`. */
  payload: string;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test" || e.name === "__tests__" || e.name === "migrations" || e.name === "node_modules") continue;
      sourceFiles(p, acc);
    } else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Every production write site of `tables`: a `.from("<table>")` whose chain
 * (up to the statement's end) calls `.insert(`, `.upsert(` or `.update(`.
 * `.from(CONSTANT)` would be invisible here; LayoverDecisionStore.ts's own
 * header explains why every layover write site spells the table as a literal
 * (check:write-path-columns has the same blind spot); `tableConstants` names
 * the exported constants that hold these tables' names, and any `.from(` of one
 * is reported so a caller can refuse it.
 */
export function writeSites(
  tables: readonly string[],
  tableConstants: readonly string[],
): { sites: WriteSite[]; dynamicFroms: string[] } {
  const sites: WriteSite[] = [];
  const dynamicFroms: string[] = [];
  const names = new Set(tables);
  for (const abs of sourceFiles(API_SRC)) {
    const src = fs.readFileSync(abs, "utf8");
    const rel = path.relative(API_SRC, abs);
    for (const m of src.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)) {
      const table = m[1]!;
      if (!names.has(table)) continue;
      const rest = src.slice(m.index! + m[0].length);
      const end = rest.search(/;\s*(?:\n|$)/);
      const chain = end === -1 ? rest : rest.slice(0, end);
      const w = /\.(insert|upsert|update)\(\s*([A-Za-z_][A-Za-z0-9_]*\(?|\{)/.exec(chain);
      if (w) sites.push({ file: rel, table, verb: w[1] as WriteSite["verb"], payload: w[2]! });
    }
    for (const m of src.matchAll(/\.from\(\s*([A-Z_][A-Z0-9_]*)\s*\)/g)) {
      if (tableConstants.includes(m[1]!)) dynamicFroms.push(`${rel}: .from(${m[1]})`);
    }
  }
  return { sites, dynamicFroms };
}
