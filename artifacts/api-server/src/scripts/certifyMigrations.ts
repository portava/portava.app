/**
 * certifyMigrations.ts — PROVE THAT AN APPLY ACTUALLY LANDED.
 *
 * WHY THIS EXISTS, SEPARATELY FROM THE APPLIER
 * ============================================
 *
 * An applier reports what it did. That is a claim about a request, not about a
 * database. Five migrations reached `main` with nobody noticing they had never
 * been applied; the lesson is not "add an applier" but "stop taking any single
 * report as evidence". So the apply and the proof are two processes, and the
 * proof reads the catalog rather than the applier's own output.
 *
 * IT CANNOT MUTATE, BY CONSTRUCTION AND BY CHECK
 * ==============================================
 *
 * Certification that can mutate is not certification. Every query this script
 * issues is a SELECT, with exactly one deliberate exception: stage 4 re-runs
 * the migrations' OWN postcondition `DO` blocks, because a migration's own
 * assertion is the best available oracle for whether the migration worked. Each
 * such block is scanned for mutation keywords BEFORE it is sent, and a block
 * that could change anything is refused rather than run — see
 * isAssertionOnlyDoBlock() below.
 *
 * POSTconditions, not every assertion. A `DO $pre$ … $pre$;` block states what
 * had to be true BEFORE the apply, and 23 of the 32 files carrying one guard
 * against a second apply ("… already exists; this migration is not idempotent
 * by design"). Such a block is FALSE after a successful apply by construction,
 * so re-running it here would fail the migrations that worked. Stage 4 holds
 * those blocks back, counts them in its report, and leaves them to the applier,
 * which runs them in the migration's own transaction where they belong — see
 * isPreconditionDoBlock().
 *
 * THE STAGES, IN ORDER, STOPPING AT THE FIRST FAILURE
 * ==================================================
 *
 *   1. ledger      — every migration file on disk is recorded in the ledger.
 *                    DELEGATED to src/scripts/checkMigrationLedger.ts. Not
 *                    reimplemented: two implementations of a parity rule
 *                    disagree eventually, and the one that disagrees quietly is
 *                    the one that gets believed.
 *   2. objects     — the tables, columns and indexes the certified migrations
 *                    declare exist in the live catalog.
 *   3. grants+RLS  — RLS is enabled where a certified migration enabled it; no
 *                    client role (anon / authenticated / PUBLIC) holds a write
 *                    privilege that no certified migration granted; and no
 *                    policy in the database has either of the two shapes that
 *                    have already shipped here as production defects.
 *   4. postconditions — the migrations' own POST-apply assertions, re-run AFTER
 *                    the commit, which is the only place they can observe what
 *                    persisted. `$pre$` blocks are held back and counted, not
 *                    re-run; isPreconditionDoBlock() says why.
 *   5. app checks  — the existing repo checks that read the live schema.
 *
 * Stopping at the first failure is deliberate. Stage 3's grant claims are
 * meaningless if stage 2 says the table is not there; stage 5's repo-wide
 * audits would report the same absence a third time. The point of a staged
 * verdict is that the FIRST line of the report is the diagnosis.
 *
 * WHAT "CERTIFIED MIGRATIONS" MEANS — the scope, and why it is not everything
 * =========================================================================
 *
 * Stages 2-4 certify THE MIGRATIONS THIS RUN APPLIED, identified from the
 * ledger by the run id the applier writes into `notes`. That scope is what
 * makes the assertions exact: they need no allowlist, because they concern
 * files written this month rather than the whole 380-file history, which
 * contains documented renames the repo already models in
 * auditMigrationsVsLive.ts's allowlist.
 *
 * When this run applied nothing, stages 2-4 have nothing to certify and say so.
 * That is not a skip dressed as a pass, and the reason is that the repo-wide
 * claim is made elsewhere and is still made: stage 1 proves every file on disk
 * is in the ledger, and stage 5 runs `audit:schema`, which is the check that
 * owns the repo-wide "every declared object exists live" question, allowlist
 * and all. Use --files to certify an explicit set by hand.
 *
 * TARGET
 * ======
 * First import is the STRICT front door (src/lib/ciSupabaseGuard.mjs): the
 * sanctioned CI project, or exit 2. The read-only production-audit door is
 * deliberately NOT used — that door is a capability granted to a listed set of
 * scripts so they can audit production, and this one only ever needs to look at
 * the project the apply just wrote to.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run certify:migrations
 *   pnpm run certify:migrations -- --files 2220_x.sql,2223_y.sql
 *   pnpm run certify:migrations -- --all-ledger        (certify every recorded file)
 *
 * Exit codes
 *   0  every stage passed
 *   1  a stage failed — the first line of the summary names which
 *   2  environment / precondition failure (no credentials, no ledger, …)
 */
import "../lib/ciSupabaseGuard.mjs";

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MUTATION_KEYWORD_RE,
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  maskForKeywordScan,
  maskNonCode,
  topLevelStatements,
} from "./lib/migrationSqlBlocks.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dir, "../..");
const MIGRATIONS_DIR = resolve(__dir, "../migrations");
const LEDGER_TABLE = "public.schema_migration_ledger";
const LEDGER_GATE = resolve(__dir, "checkMigrationLedger.ts");

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL) {
  console.error(
    "::error::certify:migrations: SUPABASE_URL is not set. There is no target " +
      "to certify. This is a failure, not a skip.",
  );
  process.exit(2);
}
if (!ACCESS_TOKEN) {
  console.error(
    "::error::certify:migrations: no Supabase Management API token. Set " +
      "SUPABASE_PROJECT_TOKEN (the name this repo's CI already uses) or " +
      "SUPABASE_ACCESS_TOKEN. A certification that cannot read the database " +
      "has certified nothing, so this fails rather than skipping.",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
const ENDPOINT = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

// ───────────────────────────────────────────────────────────────────────────
// SQL text helpers — see ./lib/migrationSqlBlocks.ts, imported above.
// ───────────────────────────────────────────────────────────────────────────

const stripQuotes = (s: string) => s.replace(/^"|"$/g, "").toLowerCase();
const unqualify = (s: string) => stripQuotes(s.split(".").pop() ?? s);

// ─────────────────────────────────────────────────────────────────────────────
// What a migration DECLARES
// ─────────────────────────────────────────────────────────────────────────────

interface Declarations {
  tablesCreated: Set<string>;
  columns: Set<string>; // "table.column"
  indexes: Set<string>;
  rlsEnabled: Set<string>;
  /** "table|role|PRIVILEGE" triples a migration explicitly grants. */
  grants: Set<string>;
  /**
   * Assertion-only `DO` blocks that are NOT tagged `$pre$`. Stage 4 re-runs
   * these against the committed database.
   */
  postconditions: string[];
  /**
   * Assertion-only `DO $pre$ … $pre$;` blocks. Held separately and never
   * re-run — see isPreconditionDoBlock() for why that is not a weakening.
   */
  preconditions: string[];
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\.)?(${IDENT})`;

function declarationsOf(sql: string): Declarations {
  const code = maskForKeywordScan(sql);
  const d: Declarations = {
    tablesCreated: new Set(),
    columns: new Set(),
    indexes: new Set(),
    rlsEnabled: new Set(),
    grants: new Set(),
    postconditions: [],
    preconditions: [],
  };

  for (const m of code.matchAll(
    new RegExp(String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}`, "gi"),
  )) {
    d.tablesCreated.add(unqualify(m[1]));
  }

  for (const m of code.matchAll(
    new RegExp(
      String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})\s+on\b`,
      "gi",
    ),
  )) {
    d.indexes.add(stripQuotes(m[1]));
  }

  // ALTER TABLE … — columns added, and RLS enabled.
  for (const m of code.matchAll(
    new RegExp(
      String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QUALIFIED}([\s\S]*?);`,
      "gi",
    ),
  )) {
    const table = unqualify(m[1]);
    const body = m[2] ?? "";
    if (/\benable\s+row\s+level\s+security\b/i.test(body)) d.rlsEnabled.add(table);
    for (const c of body.matchAll(
      new RegExp(String.raw`\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})`, "gi"),
    )) {
      const col = stripQuotes(c[1]);
      if (
        ["constraint", "primary", "unique", "foreign", "check", "exclude"].includes(col)
      ) {
        continue;
      }
      d.columns.add(`${table}.${col}`);
    }
  }

  // GRANT <privs> ON [TABLE] <table> TO <roles>;
  for (const m of code.matchAll(
    new RegExp(
      String.raw`\bgrant\s+([\s\S]*?)\s+on\s+(?:table\s+)?${QUALIFIED}\s+to\s+([^;]+);`,
      "gi",
    ),
  )) {
    const privs = m[1]
      .split(",")
      .map((p) => p.trim().replace(/\s*\([^)]*\)/g, "").toUpperCase())
      .filter(Boolean);
    const table = unqualify(m[2]);
    const roles = m[3]
      .split(",")
      .map((r) => stripQuotes(r.trim()))
      .filter(Boolean);
    for (const role of roles) {
      for (const priv of privs) {
        if (priv === "ALL" || priv === "ALL PRIVILEGES") {
          for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "SELECT"]) {
            d.grants.add(`${table}|${role}|${p}`);
          }
        } else {
          d.grants.add(`${table}|${role}|${priv}`);
        }
      }
    }
  }

  for (const stmt of topLevelStatements(sql)) {
    if (!isAssertionOnlyDoBlock(stmt)) continue;
    if (isPreconditionDoBlock(stmt)) d.preconditions.push(stmt);
    else d.postconditions.push(stmt);
  }

  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live catalog snapshot — one round trip, shared by stages 2, 3 and 4.
// ─────────────────────────────────────────────────────────────────────────────

interface Snapshot {
  tables: Set<string>;
  columns: Set<string>;
  indexes: Set<string>;
  rlsOn: Set<string>;
  /** "table|role|PRIVILEGE" triples the catalog actually holds. */
  grants: Set<string>;
}

const CLIENT_ROLES = ["anon", "authenticated", "public"];
const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];

async function snapshot(): Promise<Snapshot> {
  const [tables, columns, indexes, rls, grants] = await Promise.all([
    query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p','v','m','f')`,
    ),
    query<{ t: string; c: string }>(
      `select table_name as t, column_name as c from information_schema.columns
        where table_schema='public'`,
    ),
    query<{ name: string }>(
      `select indexname as name from pg_indexes where schemaname='public'`,
    ),
    query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relrowsecurity`,
    ),
    query<{ t: string; g: string; p: string }>(
      `select table_name as t, grantee as g, privilege_type as p
         from information_schema.role_table_grants where table_schema='public'`,
    ),
  ]);
  return {
    tables: new Set(tables.map((r) => r.name.toLowerCase())),
    columns: new Set(columns.map((r) => `${r.t.toLowerCase()}.${r.c.toLowerCase()}`)),
    indexes: new Set(indexes.map((r) => r.name.toLowerCase())),
    rlsOn: new Set(rls.map((r) => r.name.toLowerCase())),
    grants: new Set(
      grants.map((r) => `${r.t.toLowerCase()}|${r.g.toLowerCase()}|${r.p.toUpperCase()}`),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage plumbing
// ─────────────────────────────────────────────────────────────────────────────

interface StageResult {
  ok: boolean;
  /** Lines explaining a failure, or notable facts about a pass. */
  detail: string[];
}

const STAGES = [
  "1 ledger",
  "2 schema objects",
  "3 grants and RLS",
  "4 critical postconditions",
  "5 app checks",
] as const;

function runPackageScript(script: string, label: string): StageResult {
  const res = spawnSync("pnpm", ["run", script], {
    cwd: PKG_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (res.error) {
    return { ok: false, detail: [`${label}: could not run \`pnpm run ${script}\`: ${res.error.message}`] };
  }
  if (res.signal) {
    return { ok: false, detail: [`${label}: \`pnpm run ${script}\` was killed by ${res.signal}. No verdict is a failure.`] };
  }
  if (res.status !== 0) {
    return { ok: false, detail: [`${label}: \`pnpm run ${script}\` exited ${res.status}.`] };
  }
  return { ok: true, detail: [`${label}: \`pnpm run ${script}\` exited 0.`] };
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1 — ledger parity (delegated)
// ─────────────────────────────────────────────────────────────────────────────

function stageLedger(): StageResult {
  if (!existsSync(LEDGER_GATE)) {
    return {
      ok: false,
      detail: [
        `src/scripts/checkMigrationLedger.ts does not exist. That script is the ` +
          "parity gate — the assertion that every migration file on disk has a " +
          "ledger row. This stage DELEGATES to it rather than reimplementing it, " +
          "and a missing gate is a failure, not a skip: with it absent, nothing " +
          "at all is asserting that a merged migration was ever applied, which " +
          "is the exact defect this whole mechanism exists to close.",
      ],
    };
  }
  // Through the package script, not the file: `check:migration-ledger` carries
  // `--env-file-if-exists=.env`, so the canonical invocation and this one are
  // the same invocation. The existsSync above is what makes a DELETED gate a
  // failure rather than a missing-script error several layers down.
  //
  // NOTE, because it is the reason this delegation is load-bearing rather than
  // decorative: as of this change `check:migration-ledger` is invoked by NO
  // workflow under .github/. It is a registered script that nothing runs — the
  // same shape as check:migration-prefixes, which sat unrun through a real
  // prefix collision. This stage is currently its only caller in CI.
  const r = runPackageScript("check:migration-ledger", "stage 1");
  if (!r.ok) {
    return {
      ok: false,
      detail: [
        ...r.detail,
        "At least one migration on disk has no ledger row, a ledger row names a " +
          "file that is gone, or a file was edited after it was applied. The " +
          "gate's own output above names them, in apply order.",
      ],
    };
  }
  return { ok: true, detail: ["check:migration-ledger exited 0 — ledger and disk agree."] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function parseFilesFlag(): string[] | null {
  const idx = process.argv.indexOf("--files");
  if (idx === -1) return null;
  const raw = process.argv[idx + 1];
  if (!raw) {
    console.error("::error::certify:migrations: --files needs a comma-separated list.");
    process.exit(2);
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Which migrations this run is certifying.
 *
 * Primary source: the ledger rows whose `notes` carry THIS run's id, which the
 * applier writes. That is what makes "certify what was just applied" a fact
 * read from the database rather than a value passed between two processes that
 * could drift apart.
 */
async function resolveScope(): Promise<{ files: string[]; how: string }> {
  const explicit = parseFilesFlag();
  if (explicit) return { files: explicit, how: "--files" };

  if (process.argv.includes("--all-ledger")) {
    const rows = await query<{ filename: string }>(
      `select filename from ${LEDGER_TABLE} order by filename`,
    );
    return { files: rows.map((r) => r.filename), how: "--all-ledger" };
  }

  const runId = process.env.GITHUB_RUN_ID;
  if (runId) {
    const rows = await query<{ filename: string }>(
      `select filename from ${LEDGER_TABLE}
        where notes like '%run=${runId.replace(/[^0-9A-Za-z_-]/g, "")}%'
        order by filename`,
    );
    return { files: rows.map((r) => r.filename), how: `ledger rows tagged run=${runId}` };
  }

  return { files: [], how: "no run id and no --files" };
}

async function main(): Promise<never> {
  console.log(`certify:migrations — project ${projectRef}`);
  console.log("");

  const results = new Map<string, StageResult>();
  let failedStage: string | null = null;

  const record = (stage: string, r: StageResult) => {
    results.set(stage, r);
    for (const line of r.detail) console.log(`    ${r.ok ? "·" : "✖"} ${line}`);
    if (!r.ok && failedStage === null) failedStage = stage;
    return r.ok;
  };

  // ── STAGE 1 ───────────────────────────────────────────────────────────────
  console.log("▶ STAGE 1 ledger — every migration on disk is recorded");
  if (!record(STAGES[0], stageLedger())) return finish(results, failedStage);

  // Scope for stages 2-4.
  let scope: { files: string[]; how: string };
  try {
    scope = await resolveScope();
  } catch (err) {
    record(STAGES[1], {
      ok: false,
      detail: [`could not read ${LEDGER_TABLE} to establish scope: ${(err as Error).message}`],
    });
    return finish(results, failedStage);
  }

  const onDisk = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")));
  const missing = scope.files.filter((f) => !onDisk.has(f));
  if (missing.length > 0) {
    record(STAGES[1], {
      ok: false,
      detail: [
        `the scope (${scope.how}) names ${missing.length} file(s) that are not on ` +
          `disk: ${missing.join(", ")}. Certifying a file this checkout does not ` +
          "contain is not possible; refusing rather than certifying the rest and " +
          "reporting a pass.",
      ],
    });
    return finish(results, failedStage);
  }

  const declared = new Map<string, Declarations>();
  for (const f of scope.files) {
    declared.set(f, declarationsOf(readFileSync(join(MIGRATIONS_DIR, f), "utf8")));
  }

  const scopeNote =
    scope.files.length === 0
      ? `no migrations in scope (${scope.how}) — this run applied nothing, so ` +
        "there is nothing to certify here. The repo-wide equivalent is stage 5's " +
        "audit:schema, which still runs."
      : `${scope.files.length} migration(s) in scope (${scope.how}): ${scope.files.join(", ")}`;

  let live: Snapshot | null = null;
  if (scope.files.length > 0) {
    try {
      live = await snapshot();
    } catch (err) {
      record(STAGES[1], {
        ok: false,
        detail: [`could not read the live catalog: ${(err as Error).message}`],
      });
      return finish(results, failedStage);
    }
  }

  // ── STAGE 2 ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("▶ STAGE 2 schema objects — what the migrations declare exists live");
  if (!record(STAGES[1], stageObjects(scope.files, declared, live, scopeNote))) {
    return finish(results, failedStage);
  }

  // ── STAGE 3 ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("▶ STAGE 3 grants and RLS");
  if (!record(STAGES[2], stageGrantsAndRls(scope.files, declared, live))) {
    return finish(results, failedStage);
  }
  // Policy SHAPE is the existing suite's job, not a second implementation.
  if (!record(STAGES[2] + " (policy shape)", stagePolicyShape())) {
    return finish(results, failedStage);
  }

  // ── STAGE 4 ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("▶ STAGE 4 critical postconditions — the migrations' own assertions, re-run");
  if (!record(STAGES[3], await stagePostconditions(scope.files, declared))) {
    return finish(results, failedStage);
  }

  // ── STAGE 5 ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("▶ STAGE 5 app checks — the repo's live-schema checks");
  for (const script of ["audit:schema", "check:missing-live-columns"]) {
    if (!record(STAGES[4], runPackageScript(script, "stage 5"))) {
      return finish(results, failedStage);
    }
  }

  return finish(results, failedStage);
}

function stageObjects(
  files: string[],
  declared: Map<string, Declarations>,
  live: Snapshot | null,
  scopeNote: string,
): StageResult {
  if (files.length === 0 || live === null) return { ok: true, detail: [scopeNote] };

  const problems: string[] = [];
  let checked = 0;
  for (const f of files) {
    const d = declared.get(f)!;
    for (const t of d.tablesCreated) {
      checked++;
      if (!live.tables.has(t)) problems.push(`${f}: table public.${t} is ABSENT`);
    }
    for (const c of d.columns) {
      checked++;
      const table = c.split(".")[0];
      if (!live.tables.has(table)) continue; // the table failure above says it
      if (!live.columns.has(c)) problems.push(`${f}: column public.${c} is ABSENT`);
    }
    for (const i of d.indexes) {
      checked++;
      if (!live.indexes.has(i)) problems.push(`${f}: index ${i} is ABSENT`);
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      detail: [
        scopeNote,
        `${problems.length} declared object(s) are not in the live catalog. The ` +
          "apply reported success and the objects are not there — which is " +
          "exactly the state an applier's own report cannot rule out.",
        ...problems,
      ],
    };
  }
  return { ok: true, detail: [scopeNote, `${checked} declared object(s) present.`] };
}

function stageGrantsAndRls(
  files: string[],
  declared: Map<string, Declarations>,
  live: Snapshot | null,
): StageResult {
  if (files.length === 0 || live === null) {
    return { ok: true, detail: ["nothing in scope."] };
  }
  const problems: string[] = [];

  // 3a. RLS enabled where a migration enabled it.
  for (const f of files) {
    for (const t of declared.get(f)!.rlsEnabled) {
      if (!live.tables.has(t)) continue;
      if (!live.rlsOn.has(t)) {
        problems.push(
          `${f}: ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY, but ` +
            "pg_class.relrowsecurity is false — the table is readable by anyone " +
            "the grants allow, with no policy consulted.",
        );
      }
    }
  }

  // 3b. EXCESS write privilege on tables these migrations created.
  //
  // WHY THIS IS NOT A DUPLICATE OF audit:schema. docs/migrations.md states it
  // plainly: audit:schema parses the grants a migration CLAIMS and checks each
  // one is present, so excess privilege is "unrepresentable, not merely
  // unchecked" — a migration has no way to say what a role must NOT hold. That
  // gap shipped: 2092 claimed service_role INSERT+SELECT, both were present,
  // and the live catalog nonetheless read all seven privileges because Supabase
  // grants ALL on public at CREATE TABLE and the migration revoked from
  // PUBLIC/anon/authenticated but never from service_role.
  //
  // This is the EXACT-SET form, scoped to the tables in hand: for a table a
  // certified migration created, a client role may hold a write privilege ONLY
  // if a certified migration granted it by name.
  const grantedAnywhere = new Set<string>();
  for (const f of files) for (const g of declared.get(f)!.grants) grantedAnywhere.add(g);

  for (const f of files) {
    for (const t of declared.get(f)!.tablesCreated) {
      if (!live.tables.has(t)) continue;
      for (const role of CLIENT_ROLES) {
        for (const priv of WRITE_PRIVILEGES) {
          const key = `${t}|${role}|${priv}`;
          if (!live.grants.has(key)) continue;
          if (grantedAnywhere.has(key)) continue;
          problems.push(
            `${f}: role '${role}' holds ${priv} on public.${t}, and no migration ` +
              "in scope grants it. Supabase's default privileges grant ALL on " +
              "public at CREATE TABLE time; a migration that does not REVOKE " +
              "leaves the table client-writable while every presence check stays " +
              "green. REVOKE it, or grant it explicitly so the intent is on record.",
          );
        }
      }
    }
  }

  if (problems.length > 0) return { ok: false, detail: problems };
  return {
    ok: true,
    detail: [
      "RLS is enabled on every table a scoped migration enabled it on; no client " +
        "role holds an ungranted write privilege on a table these migrations created.",
    ],
  };
}

/**
 * Policy SHAPE — asserted to be WIRED, deliberately not re-run here.
 *
 * src/test/rlsPolicyShapeLive.test.ts already mechanises the two defect classes
 * this repo shipped to production: a self-referential policy that raises 42P17
 * and kills EVERY read of its table, and a tautological `(x.c = x.c)`
 * self-compare whose correlation is absent, so the predicate answers "is this
 * user a member of ANY row" instead of "of THIS row". It carries a KNOWN_OPEN
 * allowlist that is documented to shrink and never grow.
 *
 * A SECOND CHECKER WOULD BE A SECOND ALLOWLIST, AND TWO ALLOWLISTS DRIFT. This
 * script could in fact read `pg_policies` more directly than that suite can —
 * it goes through the Management API, so it needs neither a service-role key
 * nor the pg_policies_snapshot RPC the suite depends on. It does not, because
 * the cost is not the query: it is a duplicate KNOWN_OPEN list that would go
 * stale silently while looking authoritative.
 *
 * Re-invoking the suite from here was the other option and is worse than it
 * looks. It already runs in THIS workflow — live-db.yml's
 * `live-db-security-suites` job, through .github/scripts/run-live-suite.sh,
 * which is the only wrapper that reads the pass/fail/skipped counts out of the
 * output. That scoring is what makes it meaningful, because every assertion in
 * the suite sits behind `{ skip: !CREDS }` and `t.skip()` exits 0. Running it a
 * second time from here would duplicate a check that already fails the run, and
 * would require handing the migration job a service-role key it has no other
 * use for — widening a job's blast radius to buy a duplicate.
 *
 * SO THIS STAGE MAKES THE NARROWER CLAIM THAT IS ACTUALLY ITS OWN: the shape
 * check has not silently left CI. That is the failure mode certification can
 * add here — a check that stops being invoked is this repo's most-repeated
 * defect (check:migration-prefixes sat unrun through a real collision;
 * auditMigrationsVsLive was invoked by nothing). The verdict names its own
 * scope in the output rather than implying more.
 */
const POLICY_SHAPE_SCRIPT = "test:rls-policy-shape";
const LIVE_DB_WORKFLOW = resolve(PKG_ROOT, "../../.github/workflows/live-db.yml");

function stagePolicyShape(): StageResult {
  let yaml: string;
  try {
    yaml = readFileSync(LIVE_DB_WORKFLOW, "utf8");
  } catch (err) {
    return {
      ok: false,
      detail: [
        `could not read ${LIVE_DB_WORKFLOW}: ${(err as Error).message}. This stage ` +
          "asserts that the RLS policy-shape suite is still wired into CI; it " +
          "cannot establish that from a file it cannot open, and an unestablished " +
          "result is not a pass.",
      ],
    };
  }
  const wired = yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .some(
      (l) =>
        l.includes("run-live-suite.sh") && l.includes(POLICY_SHAPE_SCRIPT),
    );
  if (!wired) {
    return {
      ok: false,
      detail: [
        `${POLICY_SHAPE_SCRIPT} is no longer invoked through ` +
          ".github/scripts/run-live-suite.sh in .github/workflows/live-db.yml. " +
          "That suite is the repo's only check for the two RLS policy shapes it " +
          "has already shipped to production (42P17 self-recursion, and a " +
          "tautological self-compare that silently stops discriminating), and " +
          "run-live-suite.sh is the only wrapper that scores its output — its " +
          "exit code alone is not a usable signal, because every assertion is " +
          "behind `{ skip: !CREDS }` and a fully-skipped run exits 0.",
      ],
    };
  }
  return {
    ok: true,
    detail: [
      `${POLICY_SHAPE_SCRIPT} is wired through run-live-suite.sh in live-db.yml ` +
        "(output-scored, so a credential-less skip is a failure there). " +
        "SCOPE: this stage asserts the shape check is still INVOKED, not that " +
        "the policies are clean — that verdict is that job's, and live-db-verdict " +
        "makes its failure a failure of the run.",
    ],
  };
}

/**
 * STAGE 4 — re-run the migrations' own postconditions, AFTER the commit.
 *
 * The migrations state this themselves; 2224_route_hop_signal.sql:
 *
 *     -- ── Postconditions (separate transaction: an assertion inside the
 *     --    transaction it is verifying proves nothing about what persisted …)
 *
 * The applier already runs them once, immediately after the apply. Running them
 * again here is not redundant: this process is a different process, in a later
 * job, reading the committed database, and it is the only run that would still
 * happen if the apply step were ever removed or its output ignored.
 *
 * Each block is proven read-only before it is sent. A migration whose
 * "postcondition" mutates is REFUSED, not run — certification that can mutate
 * is not certification.
 *
 * `$pre$` blocks are held back rather than re-run, for the reason set out at
 * isPreconditionDoBlock(): a precondition is a claim about the state BEFORE the
 * apply, and the commonest kind here refuses a second apply, so after the
 * commit it must be false. The count is printed, and a scoped migration that
 * declares preconditions ONLY is named, so that a file this stage asserted
 * nothing about is never mistaken for one it certified.
 */
async function stagePostconditions(
  files: string[],
  declared: Map<string, Declarations>,
): Promise<StageResult> {
  if (files.length === 0) return { ok: true, detail: ["nothing in scope."] };

  let ran = 0;
  let preHeld = 0;
  const problems: string[] = [];
  const withNone: string[] = [];
  const preOnly: string[] = [];

  for (const f of files) {
    const d = declared.get(f)!;
    preHeld += d.preconditions.length;

    if (d.postconditions.length === 0) {
      // A file with `$pre$` blocks and nothing else has declared preconditions
      // only. This stage does no work for it — reported on its own line rather
      // than folded into "declares no assertions", because only one of those
      // two is the author having written nothing.
      (d.preconditions.length > 0 ? preOnly : withNone).push(f);
      continue;
    }
    for (const block of d.postconditions) {
      if (!isAssertionOnlyDoBlock(block)) {
        problems.push(`${f}: a postcondition block is not read-only; REFUSED rather than run.`);
        continue;
      }
      try {
        await query(block);
        ran++;
      } catch (err) {
        problems.push(`${f}: POSTCONDITION FAILED — ${(err as Error).message}`);
      }
    }
  }

  const detail = [
    `${ran} assertion block(s) re-run against the committed database.`,
    withNone.length > 0
      ? `${withNone.length} scoped migration(s) declare no assertions: ${withNone.join(", ")}. ` +
        "Stage 2 and stage 3 are what covers those."
      : "every scoped migration declared at least one assertion.",
  ];
  // Counted and printed, never silent: an exclusion nobody can see in the
  // report is an exemption, and this one has to stay auditable.
  if (preHeld > 0) {
    detail.push(
      `${preHeld} \`$pre$\` precondition block(s) held back from the re-run — a ` +
        "precondition describes the state BEFORE the apply, so after the commit it " +
        "is a tautology or a false alarm. The applier ran every one of them inside " +
        "the migration's own transaction, where a raise aborts the apply. Reasoning " +
        "in isPreconditionDoBlock().",
    );
  }
  if (preOnly.length > 0) {
    detail.push(
      `${preOnly.length} scoped migration(s) declare PRECONDITIONS ONLY, so this stage ` +
        `asserted nothing of its own about them: ${preOnly.join(", ")}. Stage 2 and ` +
        "stage 3 are what covers those.",
    );
  }
  if (problems.length > 0) return { ok: false, detail: [...detail, ...problems] };
  return { ok: true, detail };
}

function finish(results: Map<string, StageResult>, failedStage: string | null): never {
  console.log("");
  console.log("─".repeat(74));
  if (failedStage === null) {
    console.log("certify:migrations PASSED — every stage reached a verdict and every verdict was a pass:");
    for (const s of STAGES) {
      const r = results.get(s);
      console.log(`  ✔ ${s}${r ? "" : " (nothing in scope)"}`);
    }
    process.exit(0);
  }
  console.error(
    `::error::certify:migrations FAILED AT STAGE: ${failedStage}. Stages after it ` +
      "were not run — a later stage's verdict is not meaningful once an earlier " +
      "one has failed (grant claims about an absent table, for instance). The " +
      "lines marked ✖ above are the diagnosis.",
  );
  process.exit(1);
}

await main();
