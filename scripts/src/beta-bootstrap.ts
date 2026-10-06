/**
 * beta-bootstrap.ts — build the EMPTY portava-beta project from the repo's
 * schema truth, through the Supabase Management API.
 *
 * WHAT IT DOES, IN ORDER (each step prints its counts)
 * ====================================================
 *   a. GUARDS. The repo's strict front door (ciSupabaseGuard.mjs: the ref in
 *      SUPABASE_URL must EQUAL CI_SUPABASE_PROJECT_REF and must not be
 *      KNOWN_PROD_PROJECT_REF; no libpq string, no CLI) AND a hard-coded
 *      BETA_PROJECT_REF: anything but emfpckykpzfturllshly exits 2, even when
 *      the allowlist has been pointed at portava-ci or production. This script
 *      restores a baseline over whatever is there; the allowlist alone would
 *      let it do that to portava-ci.
 *   b. EMPTINESS. auth.users must be empty (always — --reset does not change
 *      that) and public may hold no base table but the ledger; otherwise exit 2
 *      unless --reset --confirm-reset=RESET-BETA, which drops and recreates
 *      public (see buildResetSql in beta-db-core.ts).
 *   c. EXTENSIONS. postgis and pg_trgm WITH SCHEMA public, then the census
 *      against portava-ci's measured set (EXTENSION_CENSUS).
 *   d. BASELINE. 5,200 top-level statements, split with the applier's
 *      maskNonCode(); 134 skipped by four named rules (printed, grouped by
 *      rule), 5,066 executed. The measured shape is asserted before anything
 *      is sent.
 *   e. EXECUTION. Batches of ≤ BATCH_SIZE statements, each ONE Management API
 *      call: a SET LOCAL prelude and ONE `SELECT * FROM beta_bootstrap.run(…)`.
 *      run() tolerates only the already-exists SQLSTATEs (TOLERATED_SQLSTATES)
 *      and re-raises anything else, so a failing batch rolls back whole.
 *   f. CENSUS. Public tables, views, policies, functions and types, and the
 *      four storage.objects policies, must equal what the baseline declares.
 *   g. REFERENCE ROWS from the snapshot (beta-reference-snapshot.ts), validated
 *      against the current baseline, INSERT … ON CONFLICT (pk) DO NOTHING.
 *   h. LEDGER. 2254's DDL (its INSERT and postcondition cut) plus one
 *      applied_by='backfill' row per canonical file sorting before
 *      CHAIN_START_PREFIX, in one transaction. Every file at or after it has
 *      NO row, so the unchanged applier sees all of them as pending; 2254 then
 *      runs later as an ordinary pending migration (its INSERT is ON CONFLICT
 *      DO NOTHING).
 *   Then the scratch schema is dropped and the script exits 0. The chain is
 *   applied by the UNCHANGED applier in a later workflow step.
 *
 * USAGE
 *   pnpm --dir scripts run db:beta-bootstrap --snapshot <path>
 *   pnpm --dir scripts run db:beta-bootstrap --snapshot <path> --reset --confirm-reset=RESET-BETA
 *   (In CI, only through .github/workflows/beta-db.yml and .github/scripts/pnpm-run.sh.)
 *
 * EXIT CODES
 *   0  bootstrapped; the chain is ready for the applier
 *   1  a statement, a census or an import failed — the output names it
 *   2  refused: wrong target, missing token or snapshot, not empty, bad flags,
 *      or a baseline whose measured shape no longer matches BASELINE_SHAPE
 *
 * TARGET GUARD — the same arrangement as apply-migrations.ts: the guard is a
 * dynamic import under RUN_DIRECTLY, awaited before main(); nothing at module
 * scope reaches a network, so the unit test can import beta-db-core.ts and
 * this file's pure parsing with no credentials.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BATCH_SIZE,
  BETA_PROJECT_REF,
  CHAIN_START_PREFIX,
  DROP_SCRATCH_SQL,
  EMPTINESS_SQL,
  EXTENSION_CENSUS_SQL,
  IMPORT_CHUNK_ROWS,
  LEDGER_FILENAMES_SQL,
  LEDGER_TABLE,
  ManagementApiError,
  POST_BASELINE_CENSUS_SQL,
  PRODUCTION_PROJECT_REF,
  SKIP_RULE_REASONS,
  TOLERATED_SQLSTATES,
  argValue,
  backfillFilenames,
  boolField,
  baselineShapeProblems,
  buildBatchQuery,
  buildCreateExtensionsSql,
  buildLedgerPrecreationSql,
  buildReferenceImportSql,
  buildResetSql,
  buildRunFunctionSql,
  decideEmptiness,
  diffMultiset,
  expectedPostBaselineCensus,
  extensionCensusProblems,
  loadBaselineModel,
  loadLedgerDdl,
  managementApi,
  parseRunFailureOrdinal,
  planBatches,
  planReferenceTables,
  resolveProjectRef,
  jsonField,
  stringArrayField,
  textField,
  validateSnapshot,
  type ClassifiedStatement,
  type EmptinessState,
  type ManagementApi,
  type ReferenceSnapshot,
  type SkipRule,
} from "./beta-db-core.js";
import { compareMigrationFilenames } from "./apply-migrations.js";

export const RESET_CONFIRMATION = "RESET-BETA";

export interface BootstrapArgs {
  snapshot: string;
  reset: boolean;
}

/** Parse argv; returns a reason string on refusal. */
export function parseBootstrapArgs(argv: readonly string[]): BootstrapArgs | string {
  const snapshot = argValue(argv, "--snapshot");
  if (!snapshot) {
    return "--snapshot <path> is required: the reference rows the structure-only baseline lacks come from it.";
  }
  const reset = argv.includes("--reset");
  const confirm = argValue(argv, "--confirm-reset");
  if (reset && confirm !== RESET_CONFIRMATION) {
    return `--reset drops the public schema and needs --confirm-reset=${RESET_CONFIRMATION} beside it.`;
  }
  if (!reset && confirm !== null) {
    return "--confirm-reset was given without --reset. Refusing a confirmation that confirms nothing.";
  }
  return { snapshot, reset };
}

/**
 * The hard-coded target check, independent of the allowlist: null when the
 * URL names portava-beta, otherwise the reason for refusing.
 */
export function bootstrapTargetRefusal(url: string | undefined): string | null {
  const ref = resolveProjectRef(url);
  if (ref === null) return "SUPABASE_URL is not https://<ref>.supabase.co; there is no target to verify.";
  if (ref === PRODUCTION_PROJECT_REF) return "SUPABASE_URL names PRODUCTION. Never.";
  if (ref !== BETA_PROJECT_REF) {
    return (
      `SUPABASE_URL names project ${ref}, not portava-beta (${BETA_PROJECT_REF}). This script restores a ` +
      "baseline over whatever it finds, so it is hard-wired to the one project that is meant to receive " +
      "one. Pointing CI_SUPABASE_PROJECT_REF at another project does not change that."
    );
  }
  return null;
}

const RUN_DIRECTLY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function refuse(message: string): never {
  console.error(`::error::beta-bootstrap REFUSED: ${message}`);
  process.exit(2);
}

function fail(message: string): never {
  console.error(`::error::beta-bootstrap FAILED: ${message}`);
  process.exit(1);
}

function step(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(4, 70 - title.length))}`);
}

async function readEmptiness(api: ManagementApi): Promise<EmptinessState> {
  const [row] = await api.query(EMPTINESS_SQL);
  const ledgerPresent = boolField(row, "ledger_present");
  const ledgerFiles = ledgerPresent
    ? (await api.query(LEDGER_FILENAMES_SQL)).map((r) => textField(r, "filename"))
    : null;
  return {
    authUsers: Number(textField(row, "auth_users")),
    publicTables: stringArrayField(row, "public_tables"),
    publicFunctions: Number(textField(row, "public_functions")),
    publicTypes: Number(textField(row, "public_types")),
    publicExtensions: stringArrayField(row, "public_extensions"),
    scratchSchema: boolField(row, "scratch_schema"),
    ledgerFiles,
  };
}

function printEmptiness(s: EmptinessState): void {
  console.log(`  auth.users rows              : ${s.authUsers}`);
  console.log(`  public base tables           : ${s.publicTables.length}${s.publicTables.length ? ` (${s.publicTables.slice(0, 8).join(", ")}${s.publicTables.length > 8 ? ", …" : ""})` : ""}`);
  console.log(`  public functions (non-ext)   : ${s.publicFunctions}`);
  console.log(`  public types (non-ext)       : ${s.publicTypes}`);
  console.log(`  extensions in public         : ${s.publicExtensions.join(", ") || "(none)"}`);
  console.log(`  ${LEDGER_TABLE.padEnd(29)}: ${s.ledgerFiles === null ? "absent" : `${s.ledgerFiles.length} row(s)`}`);
}

async function main(): Promise<never> {
  // ── a. guards ─────────────────────────────────────────────────────────────
  step("a · guards");
  const parsed = parseBootstrapArgs(process.argv.slice(2));
  if (typeof parsed === "string") refuse(parsed);
  const args = parsed;

  const targetRefusal = bootstrapTargetRefusal(process.env.SUPABASE_URL);
  if (targetRefusal !== null) refuse(targetRefusal);
  const ref = BETA_PROJECT_REF;
  const token = process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    refuse("no Management API token (SUPABASE_PROJECT_TOKEN or SUPABASE_ACCESS_TOKEN). A bootstrap that did not run is not a skip.");
  }
  console.log(`  target ${ref} (portava-beta) — allowlist guard passed, hard-coded beta ref matched.`);

  // Everything that can be decided offline is decided before the first request.
  const model = loadBaselineModel();
  const shape = baselineShapeProblems(model);
  if (shape.length > 0) {
    refuse(
      "the committed baseline no longer has the shape the skip rules were reviewed against:\n  " +
        shape.join("\n  ") +
        "\nRe-read the rules in beta-db-core.ts against the new dump and update BASELINE_SHAPE in the same PR.",
    );
  }
  let snapshot: ReferenceSnapshot;
  let ledgerDdl: string;
  let backfill: string[];
  try {
    const plans = planReferenceTables(model);
    let snapshotRaw: unknown;
    try {
      snapshotRaw = JSON.parse(readFileSync(args.snapshot, "utf8"));
    } catch (err) {
      throw new Error(`cannot read the reference snapshot at ${args.snapshot}: ${(err as Error).message}`);
    }
    snapshot = validateSnapshot(snapshotRaw, plans, model.sha256);
    ledgerDdl = loadLedgerDdl();
    backfill = backfillFilenames();
  } catch (err) {
    refuse((err as Error).message);
  }
  console.log(
    `  baseline sha256 ${model.sha256.slice(0, 16)}…, snapshot from ${snapshot.sourceProjectRef} at ${snapshot.takenAt}, ` +
      `${backfill.length} file(s) before ${CHAIN_START_PREFIX} to backfill.`,
  );

  const api = managementApi(ref, token);

  try {
    // ── b. emptiness ────────────────────────────────────────────────────────
    step("b · emptiness");
    let state = await readEmptiness(api);
    printEmptiness(state);
    const verdict = decideEmptiness(state, { reset: args.reset });
    if (verdict.action === "refuse") refuse(verdict.reasons.join("\n  "));
    for (const n of verdict.notes) console.log(`  note: ${n}`);
    let fresh = verdict.action === "proceed" ? verdict.fresh : true;
    if (verdict.action === "reset") {
      const policies = model.policies.filter((p) => p.schema === "storage" && p.table === "objects").map((p) => p.name);
      console.log(
        `  RESET requested and confirmed: dropping ${state.publicExtensions.length} extension(s) in public, ` +
          `${policies.length} storage.objects polic(ies), schema beta_bootstrap, and schema public.`,
      );
      await api.query(buildResetSql(policies, state.publicExtensions));
      state = await readEmptiness(api);
      printEmptiness(state);
      if (state.publicTables.length > 0 || state.ledgerFiles !== null) {
        fail("the reset did not leave public empty; refusing to restore over it.");
      }
      fresh = true;
    }
    console.log(`  verdict: ${verdict.action}${fresh ? " (fresh project)" : ""}`);

    // ── c. extensions ───────────────────────────────────────────────────────
    step("c · extensions");
    await api.query(buildCreateExtensionsSql());
    const ext = (await api.query(EXTENSION_CENSUS_SQL)).map((r) => ({
      name: textField(r, "name"),
      schema: textField(r, "schema"),
    }));
    console.log(`  installed: ${ext.map((e) => `${e.name}@${e.schema}`).join(", ")}`);
    const census = extensionCensusProblems(ext);
    for (const w of census.warnings) console.log(`::warning::${w}`);
    if (census.errors.length > 0) fail(`extension census:\n  ${census.errors.join("\n  ")}`);

    // ── d. baseline plan ────────────────────────────────────────────────────
    step("d · baseline statements");
    const executed: ClassifiedStatement[] = [];
    const skippedByRule = new Map<SkipRule, ClassifiedStatement[]>();
    for (const s of model.statements) {
      if (s.decision.action === "execute") executed.push(s);
      else skippedByRule.set(s.decision.rule, [...(skippedByRule.get(s.decision.rule) ?? []), s]);
    }
    console.log(`  ${model.statements.length} top-level statements; ${executed.length} executed; ${model.statements.length - executed.length} skipped.`);
    for (const [rule, list] of skippedByRule) {
      console.log(`\n  SKIPPED by ${rule} — ${list.length}: ${SKIP_RULE_REASONS[rule]}`);
      for (const s of list) console.log(`    [${s.ordinal}] L${s.line}: ${s.code.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    const kept = executed.filter((s) => s.decision.action === "execute" && s.decision.appStoragePolicy);
    console.log(`\n  KEPT in schema storage — ${kept.length} app policies on storage.objects:`);
    for (const s of kept) console.log(`    [${s.ordinal}] ${s.code.replace(/\s+/g, " ").slice(0, 100)}`);

    // ── e. execution ────────────────────────────────────────────────────────
    step("e · execution");
    await api.query(buildRunFunctionSql());
    const batches = planBatches(executed, BATCH_SIZE);
    let tolerated = 0;
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const q = buildBatchQuery(batch.map((s) => s.code));
      const label = `batch ${b + 1}/${batches.length} (statements ${batch[0].ordinal}–${batch[batch.length - 1].ordinal}, $${q.tag}$)`;
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await api.query(q.sql);
      } catch (err) {
        const msg = (err as Error).message;
        const ord = parseRunFailureOrdinal(msg);
        console.error(`\n::error::${label} FAILED and was rolled back as a whole.`);
        if (ord !== null && batch[ord - 1]) {
          const s = batch[ord - 1];
          console.error(`  failing statement: baseline statement ${s.ordinal}, line ${s.line}:\n\n${s.code};\n`);
        }
        console.error(`  error: ${msg}`);
        if (err instanceof ManagementApiError && err.status === null) {
          console.error(
            "  The request did not complete, so whether this batch committed is UNKNOWN. Re-dispatch with " +
              "reset=RESET-BETA rather than retrying over it.",
          );
        }
        fail(`${label}; earlier batches are committed — re-dispatch with reset=RESET-BETA after fixing the cause.`);
      }
      tolerated += rows.length;
      console.log(`  ${label}: ${batch.length} executed, ${rows.length} tolerated`);
      for (const r of rows) {
        const code = textField(r, "err_code");
        console.log(
          `    tolerated [${TOLERATED_SQLSTATES[code] ?? code}] statement #${textField(r, "ord")}: ` +
            `${textField(r, "err_message")} :: ${String(r.stmt_head ?? "").replace(/\s+/g, " ").slice(0, 120)}`,
        );
      }
    }
    if (tolerated === 0) {
      console.log(`  tolerated duplicates: 0${fresh ? " — as required on a first run against an empty project." : "."}`);
    } else if (fresh) {
      console.log(
        `::warning::${tolerated} statement(s) were tolerated as duplicates on a FRESH project. Nothing should ` +
          "already exist there, so a statement is being absorbed by duplication rather than executed — read the list above.",
      );
    } else {
      console.log(`  tolerated duplicates: ${tolerated} (a re-run over a partly built schema).`);
    }

    // ── f. census ───────────────────────────────────────────────────────────
    step("f · post-baseline census");
    const expected = expectedPostBaselineCensus(model);
    const [live] = await api.query(POST_BASELINE_CENSUS_SQL);
    const policyPairs = jsonField(live, "policies");
    if (!Array.isArray(policyPairs)) throw new Error("the census returned no policy list");
    const livePolicies = policyPairs.map((p: unknown) => {
      if (!Array.isArray(p) || typeof p[0] !== "string" || typeof p[1] !== "string") {
        throw new Error(`unexpected pg_policies row ${JSON.stringify(p)}`);
      }
      return `${p[0]}.${p[1]}`;
    });
    const checks: Array<[string, string[], string[], string[]]> = [
      ["public base tables", expected.tables, stringArrayField(live, "tables"), ["schema_migration_ledger"]],
      ["public views", expected.views, stringArrayField(live, "views"), []],
      ["public policies", expected.policies, livePolicies, []],
      ["storage.objects policies", expected.storageObjectPolicies, stringArrayField(live, "storage_object_policies"), []],
      ["public functions", expected.functions, stringArrayField(live, "functions"), []],
      ["public types", expected.types, stringArrayField(live, "types"), []],
    ];
    const deltas: string[] = [];
    for (const [what, want, have, extra] of checks) {
      const d = diffMultiset(want, have, extra);
      const ok = d.missing.length === 0 && d.unexpected.length === 0;
      console.log(`  ${what.padEnd(26)} baseline ${String(want.length).padStart(4)}  live ${String(have.length).padStart(4)}  ${ok ? "OK" : "MISMATCH"}`);
      if (d.missing.length) deltas.push(`${what} missing on beta: ${d.missing.join(", ")}`);
      if (d.unexpected.length) deltas.push(`${what} on beta but not in the baseline: ${d.unexpected.join(", ")}`);
    }
    if (deltas.length > 0) fail(`the restored schema is not the baseline:\n  ${deltas.join("\n  ")}`);

    // ── g. reference rows ───────────────────────────────────────────────────
    step("g · reference rows");
    for (const t of snapshot.tables) {
      let inserted = 0;
      for (const chunk of planBatches(t.rows, IMPORT_CHUNK_ROWS)) {
        const [r] = await api.query(buildReferenceImportSql(t, chunk));
        inserted += Number(textField(r, "inserted"));
      }
      const nulled = Object.keys(t.nulledColumns);
      const forced = Object.entries(t.forcedValues).map(([c, v]) => `${c}=${v}`);
      console.log(
        `  ${`${t.schema}.${t.table}`.padEnd(34)} snapshot ${String(t.rowCount).padStart(5)}  inserted ${String(inserted).padStart(5)}` +
          `${nulled.length ? `  nulled: ${nulled.join(", ")}` : ""}${forced.length ? `  forced: ${forced.join(", ")}` : ""}`,
      );
    }

    // ── h. ledger ───────────────────────────────────────────────────────────
    step("h · ledger pre-creation");
    await api.query(buildLedgerPrecreationSql(ledgerDdl, backfill));
    const ledger = (await api.query(LEDGER_FILENAMES_SQL)).map((r) => ({
      filename: textField(r, "filename"),
      checksum: textField(r, "checksum"),
      appliedBy: textField(r, "applied_by"),
    }));
    const byName = new Map(ledger.map((r) => [r.filename, r]));
    const notBackfill = backfill.filter((f) => {
      const r = byName.get(f);
      return !r || r.appliedBy !== "backfill" || r.checksum !== "backfill";
    });
    const chainRows = ledger.filter((r) => compareMigrationFilenames(r.filename, CHAIN_START_PREFIX) >= 0);
    console.log(`  ledger rows: ${ledger.length}; backfilled before ${CHAIN_START_PREFIX}: ${backfill.length - notBackfill.length}/${backfill.length}; rows at or after it: ${chainRows.length}`);
    if (notBackfill.length > 0) fail(`files without a backfill row: ${notBackfill.slice(0, 10).join(", ")}`);
    if (chainRows.length > 0) {
      fail(`the ledger already has rows for chain files (${chainRows.slice(0, 6).map((r) => r.filename).join(", ")}); the applier would not apply them.`);
    }

    await api.query(DROP_SCRATCH_SQL);
    console.log("\nbeta-bootstrap PASSED — baseline restored, reference rows imported, ledger pre-created.");
    console.log("Next: db:apply-migrations:dry-run, then db:apply-migrations (every file at or after 2093_ is pending).");
    process.exit(0);
  } catch (err) {
    fail((err as Error).message);
  }
}

if (RUN_DIRECTLY) {
  // THE TARGET GUARD, first, before any client or query — see the header.
  await import("../../artifacts/api-server/src/lib/ciSupabaseGuard.mjs");
  await main();
}
