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
 *   i. REFUSED-BY-SHAPE PREVIEW. The chain files the applier will refuse
 *      (refusedChainFiles(), against the ledger just written) are printed;
 *      they are applied later, by --apply-refused, where the applier stops.
 *   Then the scratch schema is dropped and the script exits 0. The chain is
 *   applied by the UNCHANGED applier in a later workflow step.
 *
 * TWO MORE MODES, FOR THE FILES THE APPLIER REFUSES BY SHAPE
 * ==========================================================
 * The applier refuses a file whose transaction control it cannot wrap in one
 * transaction with its ledger row, and its header names the remedy: "apply it
 * by hand, verify it, then INSERT its ledger row with applied_by='manual'".
 * On beta that is 2182_close_authz_rpc_oracle.sql and
 * 2190_memory_lifecycle_fixes.sql (refusedChainFiles() in beta-db-core.ts;
 * the unit test pins the set). This script is that hand:
 *
 *   --apply-refused <file>  Only when <file> is in the computed refused set,
 *       has an entry in MANUAL_VERIFICATION, has no ledger row, and every chain
 *       file sorting before it HAS one (so the applier stopped exactly there).
 *       The file is CUT at its own transaction control (planManualApply in
 *       beta-db-core.ts): the bodies of its BEGIN … COMMIT blocks are the
 *       apply; its BEGIN … ROLLBACK blocks and the SELECTs outside every block
 *       are its probes. Then, in order:
 *         1. BEFORE — each probe in BEGIN TRANSACTION READ ONLY … ROLLBACK, its
 *            rows printed; the file's pre-apply expectations asserted (2182:
 *            check A's exact caller set, and PostgREST not exposing authz).
 *            Any failure exits 2 having written nothing.
 *         2. APPLY — ONE call, ONE transaction: the apply bodies, the per-file
 *            verification as DO blocks that RAISE (2182: B, C, and D against
 *            the count measured in step 1; 2190: its second block, which has
 *            no postcondition of its own), and the ledger row
 *            (applied_by='manual', checksum = the applier's checksumOf(bytes),
 *            a plain INSERT). All of it commits or none of it does, so a
 *            failure leaves beta as it was and this mode can be re-run.
 *         3. AFTER — the ledger row read back, the probes run again and
 *            printed: the audit record of what the file's own checks show.
 *       Idempotent: a file that already has a ledger row is skipped.
 *   --check-refused <a.sql,b.sql>  Offline (no token, no request): exit 0 only
 *       if every named file is in the refused set computed from disk — the
 *       workflow's check that a dry run's refusals are exactly these.
 *
 * USAGE
 *   pnpm --dir scripts run db:beta-bootstrap --snapshot <path>
 *   pnpm --dir scripts run db:beta-bootstrap --snapshot <path> --reset --confirm-reset=RESET-BETA
 *   pnpm --dir scripts run db:beta-bootstrap --apply-refused 2182_close_authz_rpc_oracle.sql
 *   pnpm --dir scripts run db:beta-bootstrap --check-refused 2182_close_authz_rpc_oracle.sql,2190_memory_lifecycle_fixes.sql
 *   (In CI, only through .github/workflows/beta-db.yml and .github/scripts/pnpm-run.sh.)
 *
 * EXIT CODES
 *   0  bootstrapped / applied and recorded / already recorded / all named files refused-by-shape
 *   1  a statement, a census, an import, or a hand-apply transaction failed — the output names it
 *   2  refused: wrong target, missing token or snapshot, not empty, bad flags, a file
 *      that is not in the refused set or is out of order, or a baseline whose
 *      measured shape no longer matches BASELINE_SHAPE
 *
 * TARGET GUARD — the same arrangement as apply-migrations.ts: the guard is a
 * dynamic import under RUN_DIRECTLY, awaited before main(); nothing at module
 * scope reaches a network, so the unit test can import beta-db-core.ts and
 * this file's pure parsing with no credentials.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  MANUAL_VERIFICATION,
  buildManualApplySql,
  buildManualLedgerInsertSql,
  buildProbeSql,
  RPC_PROBE_CONTROL,
  planManualApply,
  type ManualApplyPlan,
  firstSentence,
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
  refusedChainFiles,
  resolveProjectRef,
  unrecordedPredecessors,
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
import {
  MIGRATIONS_DIR,
  checksumOf,
  compareMigrationFilenames,
  listMigrationFiles,
} from "./apply-migrations.js";
import { betaPublishableKey } from "./beta-smoke.js";

export const RESET_CONFIRMATION = "RESET-BETA";

export type BootstrapArgs =
  | { mode: "bootstrap"; snapshot: string; reset: boolean }
  | { mode: "apply-refused"; file: string }
  | { mode: "check-refused"; files: string[] };

const FILE_ARG_RE = /^[A-Za-z0-9_.-]+\.sql$/;

/** Parse argv; returns a reason string on refusal. The three modes are exclusive. */
export function parseBootstrapArgs(argv: readonly string[]): BootstrapArgs | string {
  const applyRefused = argValue(argv, "--apply-refused");
  const checkRefused = argValue(argv, "--check-refused");
  const snapshot = argValue(argv, "--snapshot");
  const reset = argv.includes("--reset");
  const confirm = argValue(argv, "--confirm-reset");
  const modes = [applyRefused !== null, checkRefused !== null, snapshot !== null].filter(Boolean).length;
  if (modes > 1) return "--snapshot, --apply-refused and --check-refused are separate modes; give exactly one.";
  if (applyRefused !== null || checkRefused !== null) {
    if (reset || confirm !== null) return "--reset belongs to the bootstrap mode (--snapshot), not to this one.";
    if (applyRefused !== null) {
      if (!FILE_ARG_RE.test(applyRefused)) return "--apply-refused needs one migration filename (e.g. 2182_close_authz_rpc_oracle.sql).";
      return { mode: "apply-refused", file: applyRefused };
    }
    const files = (checkRefused ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    if (files.length === 0 || !files.every((f) => FILE_ARG_RE.test(f))) {
      return "--check-refused needs a comma-separated list of migration filenames.";
    }
    return { mode: "check-refused", files };
  }
  if (!snapshot) {
    return "--snapshot <path> is required: the reference rows the structure-only baseline lacks come from it.";
  }
  if (reset && confirm !== RESET_CONFIRMATION) {
    return `--reset drops the public schema and needs --confirm-reset=${RESET_CONFIRMATION} beside it.`;
  }
  if (!reset && confirm !== null) {
    return "--confirm-reset was given without --reset. Refusing a confirmation that confirms nothing.";
  }
  return { mode: "bootstrap", snapshot, reset };
}

const readMigration = (f: string) => readFileSync(join(MIGRATIONS_DIR, f), "utf8");

/**
 * --check-refused: every named file must be one the applier refuses by shape.
 * Pure over the files on disk; returns the problems (empty = accepted).
 */
export function checkRefusedProblems(named: readonly string[], files: readonly string[] = listMigrationFiles()): string[] {
  const refused = new Set(refusedChainFiles(files, readMigration).map((r) => r.filename));
  return named
    .filter((f) => !refused.has(f))
    .map((f) =>
      files.includes(f)
        ? `${f} is not a file the applier refuses by shape at or after ${CHAIN_START_PREFIX}; the bootstrap will not hand-apply it.`
        : `${f} is not a canonical migration file.`,
    );
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

/**
 * --apply-refused <file>: the hand the applier's header asks for. See the
 * header of this file for the contract; every refusal happens before the one
 * writing call, which carries the body, the verification and the ledger row.
 */
async function applyRefused(api: ManagementApi, file: string): Promise<never> {
  step(`apply-refused · ${file}`);
  const files = listMigrationFiles();
  if (!files.includes(file)) refuse(`${file} is not a canonical migration file.`);
  const state = await readEmptiness(api);
  if (state.ledgerFiles === null) refuse(`${LEDGER_TABLE} does not exist on beta; run the bootstrap (--snapshot) first.`);
  const recorded = new Set(state.ledgerFiles);
  if (recorded.has(file)) {
    console.log(`  ${file} already has a ledger row — nothing to do (this mode is idempotent).`);
    process.exit(0);
  }
  const entry = refusedChainFiles(files, readMigration, recorded).find((r) => r.filename === file);
  if (!entry) {
    refuse(`${file} is not in the set the applier refuses by shape (chain files at or after ${CHAIN_START_PREFIX} with no ledger row). Only those are applied by hand.`);
  }
  const missing = unrecordedPredecessors(files, file, recorded);
  if (missing.length > 0) {
    refuse(
      `out of order: ${missing.length} chain file(s) sorting before ${file} have no ledger row ` +
        `(${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}). The applier must apply them first; ` +
        "this mode runs exactly where the applier stopped.",
    );
  }
  const verify = MANUAL_VERIFICATION[file];
  if (!verify) refuse(`${file} is refused by shape but has no entry in MANUAL_VERIFICATION; it is not applied without its verification.`);
  const sql = readMigration(file);
  const checksum = checksumOf(sql);
  let plan: ManualApplyPlan;
  try {
    plan = planManualApply(sql, file);
  } catch (err) {
    refuse(`cannot cut ${file} at its transaction control: ${(err as Error).message}`);
  }
  const verification = verify();
  if (plan.probes.length !== verification.probes) {
    refuse(`${file} cuts into ${plan.probes.length} probe(s); its verification is written for ${verification.probes}. The file changed — update MANUAL_VERIFICATION.`);
  }
  console.log(`  ${file}: ${Buffer.byteLength(sql, "utf8")} bytes, sha256 ${checksum}`);
  console.log(`  the applier refuses it: ${firstSentence(entry.reason)}`);
  console.log(
    `  cut: ${plan.applyBlocks} BEGIN … COMMIT block(s) → ${plan.applyStatements.length} statement(s) applied in ONE transaction ` +
      `with the verification and the ledger row; ${plan.probes.length} probe(s) run read-only before and after.`,
  );

  // 2182's check E, as written in the file: the RPC through PostgREST with the beta PUBLISHABLE key (public by
  // design; the one the beta app build carries). Only the status code is used.
  let publishableKey: string | null = null;
  const rpcStatus = async (fn: string, body: Record<string, string>): Promise<number> => {
    publishableKey ??= betaPublishableKey();
    try {
      const res = await fetch(`https://${BETA_PROJECT_REF}.supabase.co/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      await res.text();
      return res.status;
    } catch (err) {
      console.log(`  rpc/${fn}: request failed (${(err as Error).message}) — counted as status 0`);
      return 0;
    }
  };

  const runProbes = async (when: string): Promise<Array<Array<Record<string, unknown>>>> => {
    const out: Array<Array<Record<string, unknown>>> = [];
    for (const [i, p] of plan.probes.entries()) {
      const rows = await api.query(buildProbeSql(p));
      out.push(rows);
      console.log(`  probe ${i + 1} (line ${p.line}, ${p.origin}) ${when}: ${rows.length} row(s)`);
      for (const r of rows) console.log(`      ${JSON.stringify(r)}`);
    }
    return out;
  };

  step(`apply-refused · ${file} · BEFORE (read-only)`);
  // Everything here is read-only, so ANY failure — a check, a transport error, an unexpected row shape — is a
  // refusal (exit 2, nothing written), not a failure of a write.
  let before: Array<Array<Record<string, unknown>>> = [];
  const beforeProblems: string[] = [];
  try {
    before = await runProbes("before");
    beforeProblems.push(...verification.checkBefore(before));
    if (verification.rpcClosedAfter) {
      for (const { fn, body } of verification.rpcClosedAfter) {
        const status = await rpcStatus(fn, body);
        console.log(`  check E before: POST /rest/v1/rpc/${fn} → ${status} (want 200)`);
        if (status !== 200) beforeProblems.push(`check E: rpc/${fn} answered ${status} before the apply, not 200 — the probe would prove nothing.`);
      }
      const control = await rpcStatus(RPC_PROBE_CONTROL, {});
      console.log(`  check E control: POST /rest/v1/rpc/${RPC_PROBE_CONTROL} → ${control} (want 404)`);
      if (control !== 404) beforeProblems.push(`check E: a non-existent RPC answered ${control}, not 404 — a 404 after the apply would not mean "not exposed".`);
    }
  } catch (err) {
    beforeProblems.push(`a pre-apply read failed: ${(err as Error).message}`);
  }
  if (beforeProblems.length > 0) {
    refuse(`${file}: the pre-apply checks failed; nothing was written.\n  ${beforeProblems.join("\n  ")}`);
  }
  console.log("  pre-apply checks: OK");

  step(`apply-refused · ${file} · APPLY (one transaction)`);
  const inTxn = verification.inTransaction(before);
  const notes =
    `beta apply-refused: ${plan.applyBlocks} BEGIN…COMMIT block(s) applied in one transaction with ` +
    `${inTxn.length} verification statement(s) and this row; ` +
    `${plan.probes.length} probe(s) run read-only before/after. Refused by the applier: ${firstSentence(entry.reason)}`;
  const applySql = buildManualApplySql(plan, inTxn, buildManualLedgerInsertSql(file, checksum, notes));
  try {
    await api.query(applySql);
  } catch (err) {
    fail(
      `${file}: the apply transaction failed and rolled back — the file's body, its verification and its ledger row ` +
        "commit together or not at all, so beta is as it was before this call. Read the error; this mode can be re-run.\n  " +
        (err as Error).message,
    );
  }
  const row = (await api.query(LEDGER_FILENAMES_SQL)).find((r) => textField(r, "filename") === file);
  if (!row || textField(row, "applied_by") !== "manual" || textField(row, "checksum") !== checksum) {
    fail(`${file}: the apply call returned but the ledger does not show its manual row — investigate before the applier runs again.`);
  }
  console.log(`  committed: body + verification + ledger row (applied_by='manual', checksum ${checksum})`);

  step(`apply-refused · ${file} · AFTER (read-only, the audit record)`);
  await runProbes("after");
  if (verification.rpcClosedAfter) {
    // PostgREST reloads its schema cache on DDL asynchronously: 12 attempts, 5 s apart.
    const open = new Map(verification.rpcClosedAfter.map((r) => [r.fn, r.body]));
    const lastStatus = new Map<string, number>();
    for (let attempt = 1; attempt <= 12 && open.size > 0; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 5_000));
      for (const [fn, body] of [...open]) {
        const status = await rpcStatus(fn, body);
        console.log(`  check E after (attempt ${attempt}): POST /rest/v1/rpc/${fn} → ${status} (want 404)`);
        lastStatus.set(fn, status);
        if (status === 404) open.delete(fn);
      }
    }
    if (open.size > 0) {
      const still = [...open.keys()].map((fn) => `${fn} → ${lastStatus.get(fn) === 0 ? "could not be probed (network)" : lastStatus.get(fn)}`);
      fail(
        `${file} IS APPLIED AND RECORDED, but check E did not see 404 within 12 attempts: ${still.join(", ")}. ` +
          "A re-run of --apply-refused is a no-op now (the ledger row exists) and will NOT re-probe; re-verify with the " +
          "file's own curl (check E in its trailing comment). If an RPC still answers, the oracle is not closed from outside — " +
          "investigate PostgREST's exposed schemas before anything else.",
      );
    }
  }
  console.log(`\nbeta-bootstrap --apply-refused PASSED — ${file} applied, verified and recorded in one transaction. Re-run the applier.`);
  process.exit(0);
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

  if (args.mode === "check-refused") {
    const problems = checkRefusedProblems(args.files);
    if (problems.length > 0) refuse(problems.join("\n  "));
    console.log(`  check-refused: ${args.files.join(", ")} — each is refused by the applier's shape rules; --apply-refused applies them, verified, with their ledger row.`);
    process.exit(0);
  }

  const token = process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    refuse("no Management API token (SUPABASE_PROJECT_TOKEN or SUPABASE_ACCESS_TOKEN). A bootstrap that did not run is not a skip.");
  }
  console.log(`  target ${ref} (portava-beta) — allowlist guard passed, hard-coded beta ref matched.`);

  if (args.mode === "apply-refused") {
    try {
      return await applyRefused(managementApi(ref, token), args.file);
    } catch (err) {
      fail((err as Error).message);
    }
  }

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

    // ── i. the files the applier will refuse by shape ───────────────────────
    // Computed against beta's ledger as it now stands, exactly as the applier
    // will meet them. Nothing is applied here: each depends on the files
    // before it, so it can only be applied where the applier stops on it —
    // the workflow's apply loop runs `--apply-refused <file>` at that point.
    step("i · files the applier refuses by shape");
    const refusedNow = refusedChainFiles(listMigrationFiles(), readMigration, new Set(byName.keys()));
    for (const r of refusedNow) console.log(`  ${r.filename}: ${firstSentence(r.reason)}`);
    console.log(
      `  ${refusedNow.length} file(s); the apply loop hand-applies each (--apply-refused: one transaction with its verification and ledger row) where the applier stops on it.`,
    );

    await api.query(DROP_SCRATCH_SQL);
    console.log("\nbeta-bootstrap PASSED — baseline restored, reference rows imported, ledger pre-created.");
    console.log("Next: db:apply-migrations:dry-run, then the apply loop (every file at or after 2093_ is pending).");
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
