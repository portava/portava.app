/**
 * migrationSessionState.ts — a migration block that runs as ITS OWN REQUEST
 * must not read state that only another request could have left behind.
 *
 * WHY THIS EXISTS
 * ===============
 * main 2de186f820 (#650), live-DB run 37737811561: the applier stopped at
 * 3974_trip_kernel_admin_restore_participant.sql, postcondition-failed,
 *
 *     42P01: relation "pg_temp._k3974_after" does not exist
 *
 * 3974's body counted something into a session temp table and its post-COMMIT
 * postcondition read it back. scripts/src/apply-migrations.ts sends the body
 * (with the ledger row) and the postconditions as SEPARATE Management API
 * requests, and each request is its own session, so the table never exists
 * where the postcondition runs. CI's local-db replay runs a whole file in ONE
 * psql session, where the same file passes — so the defect is invisible to
 * every pre-merge tier and fires only on main's live apply, after the body has
 * already committed.
 *
 * TWO PROCESSES RUN A BLOCK AS ITS OWN REQUEST, and both are modelled here
 * with their own code, not a restatement of it:
 *
 *   * the applier's phase 2 — the statements after a file's closing COMMIT
 *     (classifyMigration(...).postconditions, injected by the caller so this
 *     module never imports across the package boundary);
 *   * certify:migrations stage 4 — every assertion-only DO block that is not
 *     tagged `$pre$`, WHEREVER it sits in the file, re-run one request at a
 *     time after the whole run committed (isAssertionOnlyDoBlock /
 *     isPreconditionDoBlock, the predicates certifyMigrations.ts uses).
 *
 * WHAT SUCH A BLOCK MAY NOT DO
 * ===========================
 *   temp-table          read a temp table it did not create — by bare name
 *                       (created elsewhere in the file) or as `pg_temp.<x>` —
 *                       unless the block probes for one of the temp tables it
 *                       reads with `to_regclass('pg_temp.<x>')` /
 *                       `to_regclass('<x>')` — which is how 3390, 3460 and 3504
 *                       legitimately read their temp tables when (and only
 *                       when) they run in the applying transaction (3390 probes
 *                       one and gates all three reads on it).
 *   session-guc         read, with current_setting(), a setting the file sets
 *                       OUTSIDE the block (set_config / SET): the value lives
 *                       in the request that set it.
 *   second-apply-guard  carry the house's "I have already run" refusal ("this
 *                       migration is not idempotent by design" / "this
 *                       migration has run") without the `$pre$` tag: certify
 *                       re-runs it after the commit, where it is false by
 *                       construction (2965's lesson; 3974 had one too).
 *
 * WHAT THIS DOES NOT PROVE. It is a text guard over the block's own code. A
 * block that probes for a temp table and then reads it unconditionally anyway
 * passes it; so does state reached through a function the block calls. The
 * behavioural proof for a given file is a replay that sends each request in a
 * fresh session (the PGlite simulation recorded in docs/migrations.md for
 * 3979). This guard exists so the commonest shape — 3974's — cannot reach main
 * again unnoticed.
 */

import {
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  maskForKeywordScan,
  topLevelStatements,
} from "./migrationSqlBlocks.js";

export type RunBy = "applier post-phase" | "certify stage 4";

export interface SeparateRequestBlock {
  /** The statement text exactly as it is sent. */
  text: string;
  /** 1-based line of the block's first code line in the file. */
  line: number;
  runBy: RunBy[];
}

export type SessionStateRule = "temp-table" | "session-guc" | "second-apply-guard";

export interface SessionStateFinding {
  file: string;
  line: number;
  runBy: RunBy[];
  rule: SessionStateRule;
  /** The temp table, setting or phrase the block depends on. */
  name: string;
}

/**
 * The applier's classifier, injected. Only the two fields this module reads are
 * typed; a "refuse" classification has no post-phase (the applier never runs
 * the file).
 */
export type MigrationClassifier = (
  sql: string,
  filename: string,
) => { kind: string; postconditions?: string };

const NAME = String.raw`"?([A-Za-z_][A-Za-z0-9_$]*)"?`;
const TEMP_CREATE_RE = new RegExp(
  String.raw`\bcreate\s+(?:global\s+|local\s+)?(?:temp|temporary)\s+table\s+(?:if\s+not\s+exists\s+)?(?:pg_temp\s*\.\s*)?${NAME}` +
    "|" +
    String.raw`\binto\s+(?:temp|temporary)\s+(?:table\s+)?(?:pg_temp\s*\.\s*)?${NAME}`,
  "gi",
);
const PG_TEMP_REF_RE = new RegExp(String.raw`\bpg_temp\s*\.\s*${NAME}`, "gi");
const GUC_SET_CONFIG_RE = /\bset_config\s*\(\s*'([^']+)'/gi;
const GUC_SET_STMT_RE = /\bset\s+(?:local\s+|session\s+)?"?([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_.]*)"?\s*(?:=|\bto\b)/gi;
const GUC_READ_RE = /\bcurrent_setting\s*\(\s*'([^']+)'/gi;
const SECOND_APPLY_RE = /not idempotent by design|this migration has run/i;

/** Strip `--` comments, keeping string literals (setting names and probes live in them). */
function stripLineComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      const s = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += sql.slice(s, i);
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const lower = (s: string) => s.toLowerCase();

function tempTablesCreatedIn(sql: string): Set<string> {
  const code = maskForKeywordScan(sql);
  const out = new Set<string>();
  for (const m of code.matchAll(TEMP_CREATE_RE)) out.add(lower(m[1] ?? m[2]));
  return out;
}

function settingsSetIn(sql: string): Set<string> {
  const out = new Set<string>();
  const raw = stripLineComments(sql);
  for (const m of raw.matchAll(GUC_SET_CONFIG_RE)) out.add(lower(m[1]));
  for (const m of maskForKeywordScan(sql).matchAll(GUC_SET_STMT_RE)) out.add(lower(m[1]));
  return out;
}

function lineOf(sql: string, stmt: string, from: number): { line: number; at: number } {
  const at = sql.indexOf(stmt, from);
  const lead = /^\s*(?:--[^\n]*\n\s*)*/.exec(stmt)?.[0] ?? "";
  return { line: sql.slice(0, at + lead.length).split("\n").length, at };
}

/**
 * Every block of `sql` that some process sends as its own request, with which
 * process(es) send it. Pure.
 */
export function separateRequestBlocks(
  sql: string,
  filename: string,
  classify: MigrationClassifier,
): SeparateRequestBlock[] {
  const byText = new Map<string, SeparateRequestBlock>();
  const cls = classify(sql, filename);
  let cursor = 0;
  const statements = topLevelStatements(sql);
  for (const stmt of statements) {
    const { line, at } = lineOf(sql, stmt, cursor);
    cursor = at + stmt.length;
    if (isAssertionOnlyDoBlock(stmt) && !isPreconditionDoBlock(stmt)) {
      byText.set(stmt.trim(), { text: stmt, line, runBy: ["certify stage 4"] });
    }
  }
  if (cls.kind === "unwrapped" && cls.postconditions && cls.postconditions.trim() !== "") {
    const tailStart = sql.lastIndexOf(cls.postconditions);
    let c = tailStart;
    for (const stmt of topLevelStatements(cls.postconditions)) {
      const { line, at } = lineOf(sql, stmt, c);
      c = at + stmt.length;
      const prev = byText.get(stmt.trim());
      if (prev) prev.runBy = ["applier post-phase", ...prev.runBy];
      else byText.set(stmt.trim(), { text: stmt, line, runBy: ["applier post-phase"] });
    }
  }
  return [...byText.values()].sort((a, b) => a.line - b.line);
}

/** The findings for one migration file. Pure. */
export function findSessionStateFindings(
  file: string,
  sql: string,
  classify: MigrationClassifier,
): { blocks: SeparateRequestBlock[]; findings: SessionStateFinding[] } {
  const blocks = separateRequestBlocks(sql, file, classify);
  const fileTemps = tempTablesCreatedIn(sql);
  const fileSettings = settingsSetIn(sql);
  const findings: SessionStateFinding[] = [];

  for (const b of blocks) {
    const code = lower(maskForKeywordScan(b.text));
    const raw = lower(stripLineComments(b.text));
    const createdHere = tempTablesCreatedIn(b.text);
    const probes = (t: string) =>
      new RegExp(String.raw`\bto_regclass\s*\(\s*'(?:pg_temp\.)?"?${t.replace(/\$/g, "\\$")}"?'`).test(raw);

    const needed = new Set<string>();
    for (const t of fileTemps) {
      if (createdHere.has(t)) continue;
      if (new RegExp(String.raw`(?<![A-Za-z0-9_$])${t.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`).test(code)) needed.add(t);
    }
    for (const m of code.matchAll(PG_TEMP_REF_RE)) {
      const t = lower(m[1]);
      if (!createdHere.has(t)) needed.add(t);
    }
    // A block that probes for any of the temp tables it reads is taken to gate
    // its temp reads on that probe: 3390's $post$ probes _p3390_tables once and
    // reads _p3390_keep and _p3390_svc_before inside the same IF (re-run in a
    // fresh session on the PGlite replay, 2026-10-08: it passes).
    const gated = [...needed].some(probes);
    for (const t of [...needed].sort()) {
      if (!gated) findings.push({ file, line: b.line, runBy: b.runBy, rule: "temp-table", name: t });
    }

    const setHere = settingsSetIn(b.text);
    const reads = new Set([...raw.matchAll(GUC_READ_RE)].map((m) => lower(m[1])));
    for (const g of [...reads].sort()) {
      if (fileSettings.has(g) && !setHere.has(g)) {
        findings.push({ file, line: b.line, runBy: b.runBy, rule: "session-guc", name: g });
      }
    }

    if (b.runBy.includes("certify stage 4")) {
      for (const l of stripLineComments(b.text).split("\n")) {
        if (/\bRAISE\b/i.test(l) && SECOND_APPLY_RE.test(l)) {
          findings.push({
            file,
            line: b.line,
            runBy: b.runBy,
            rule: "second-apply-guard",
            name: (SECOND_APPLY_RE.exec(l)?.[0] ?? "").toLowerCase(),
          });
          break;
        }
      }
    }
  }
  return { blocks, findings };
}

/** Stable key for a finding, for the shrink-only ledger of known ones. */
export const findingKey = (f: Pick<SessionStateFinding, "file" | "rule" | "name">) =>
  `${f.file}|${f.rule}|${f.name}`;
