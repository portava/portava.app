/**
 * Every guard in this tree, and the ONE thing each is responsible for.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A guard nobody runs is decorative architecture — the same defect
 * `checkProjectionConsumers` catches for data pipes, applied to the checks
 * themselves. It was not hypothetical: `checkUncheckedSupabaseReads`, the
 * fail-open ledger and the largest guard in this repo, was reached by NOTHING.
 * Its mutation suite runs it only against scratch trees through
 * UNCHECKED_READS_SRC_ROOT / UNCHECKED_READS_ALLOWLIST, so a new unchecked
 * `.error` added to the real tree tomorrow would fail no check anywhere. The
 * 306 -> 0 burn-down it recorded was protected by nothing at all.
 *
 * ── WHAT AN ENTRY MUST SAY ───────────────────────────────────────────────────
 * `responsibility` — what this guard, and only this guard, refuses to let
 * through. Required to be DISTINCT across the registry: two guards with the same
 * stated job means one of them is unowned, and an unowned guard is the one that
 * gets deleted in a cleanup.
 *
 * `reach` — HOW it runs, verified mechanically rather than asserted:
 *
 *   check-all     a package script that scripts/run-all-checks.sh invokes by
 *                 name through run_check / run_gate.
 *   workflow      a package script named on a live line of a GitHub workflow.
 *   test-control  a REGISTERED test that spawns the checker against the REAL
 *                 tree — no seam override — and asserts its exit status is 0.
 *                 The seams must be listed so "real tree" is checkable: a spawn
 *                 that sets any of them is a fixture run and does not count.
 *                 This is the distinction the fail-open guard failed.
 *   delegated     another checker runs it as a sub-gate. Verified in three
 *                 parts: the delegator exists, its source actually names this
 *                 checker, and the delegator's own package script is itself
 *                 invoked by CI. A delegation chain that ends in nothing is the
 *                 same defect one hop further out.
 *   build-gate    it runs as part of the production build rather than in CI.
 *                 Verified that the package script really names it and that the
 *                 build script really runs that script. A build gate fails the
 *                 DEPLOY, not the pull request — weaker than CI, and recorded as
 *                 such rather than counted as the same thing.
 *   manual        CI cannot invoke it (it needs live credentials, or a human
 *                 decides when it runs). Requires a reason. A manual entry that
 *                 IS wired is a stale exemption and fails.
 */

export type Reach =
  | { kind: "check-all"; script: string }
  | { kind: "workflow"; script: string }
  /** Another checker spawns it as a sub-gate; that delegator is itself reached. */
  | { kind: "delegated"; by: string; script: string }
  /** Runs as part of the production BUILD rather than in CI. */
  | { kind: "build-gate"; script: string; runner: string }
  | { kind: "test-control"; test: string; seams: readonly string[] }
  | { kind: "manual"; reason: string };

/**
 * How a guard PROVES it inspected something.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A guard's exit code says whether it found a problem. It says nothing about
 * whether it LOOKED. Three CI-enforced guards printed a success message that was
 * byte-identical whether they had inspected everything or nothing:
 *
 *   check-admin-guard   "PASSED — no local admin guards in src/routes/"
 *   check-data-rights   "every intel column has a stated ownership class."
 *
 * check-admin-guard is a SECURITY guard, wired into check:all, and would have
 * printed that line if its route directory had been renamed or its walker had
 * broken. "Nothing is wrong" and "I did not look" are not the same sentence, and
 * an exit code cannot tell them apart.
 *
 * So a CI-enforced guard declares the line that carries its inspected count, and
 * checkGuardReachability RUNS it and reads the number. Zero fails.
 *
 * `zeroIsProved` is the one escape, and it is deliberately narrow: a guard whose
 * subject genuinely can be empty must say WHY zero is a proved expected state,
 * not merely that it is possible. Reaching for it to silence a collapsed scan is
 * the thing this rule exists to stop.
 */
export interface InspectionProof {
  /** ERE matched against the guard's combined output; group 1 must be the count. */
  countPattern: string;
  /** What the number counts, for a reader of the failure message. */
  unit: string;
  /** Set ONLY when zero is a proved expected state, with the proof. */
  zeroIsProved?: string;
}

export interface GuardEntry {
  /** Path relative to artifacts/api-server. */
  checker: string;
  /**
   * Required for a `check-all` guard that runs without credentials. A
   * credentialed guard is exempt because running it here would either need
   * credentials CI must not hold, or produce a NO_VERDICT that proves nothing.
   */
  inspects?: InspectionProof;
  /** True when the guard needs live credentials, so its count cannot be read here. */
  credentialed?: boolean;
  /**
   * Set ONLY on a guard whose job is to RUN OTHER GUARDS and require a verdict
   * line from each. Its inspection proof is those requirements, so
   * checkGuardReachability does not run it a second time to read a count of its
   * own. The value is the prose saying why — a bare `true` here would be the
   * loophole this field exists to avoid being. Mutually exclusive with
   * `inspects`.
   */
  aggregator?: string;
  responsibility: string;
  reach: Reach;
}

export const GUARDS: readonly GuardEntry[] = [
  // ── reached by scripts/run-all-checks.sh ──────────────────────────────────
  {
    checker: "scripts/check-compiler-authentic.mjs",
    inspects: { countPattern: "(\\d+) probe program\\(s\\) compiled", unit: "probe programs compiled" },
    responsibility: "Proves the resolved TypeScript compiler REJECTS a program it must reject, so a green typecheck means something.",
    reach: { kind: "check-all", script: "check:compiler-authentic" },
  },
  {
    checker: "scripts/check-flag-polarity.mjs",
    // Matches BOTH output paths: this guard prints "N flags seeded across" when
    // clean and "N flags across" when it has findings. A pattern keyed on the
    // clean-run wording alone went quiet exactly when the guard had something to say.
    inspects: { countPattern: "(\\d+) flags (?:seeded )?across", unit: "feature flags seeded and accounted for" },
    responsibility: "Every feature flag is classified STOP/CAPABILITY/CONFIG and read through the reader that classification demands.",
    reach: { kind: "check-all", script: "check:flag-polarity" },
  },
  {
    checker: "scripts/check-guard-coverage.mjs",
    inspects: { countPattern: "\\| source files scanned \\| (\\d+) \\|", unit: "source files scanned" },
    responsibility: "Every file that can reach Supabase directly imports a CI guard front door or carries a written exemption.",
    reach: { kind: "check-all", script: "check:guard-coverage" },
  },
  {
    checker: "scripts/check-route-auth-gate.mjs",
    inspects: { countPattern: "(\\d+) route files scanned", unit: "route files scanned" },
    responsibility: "A route handler that writes goes through requireUser, the only place the account ban/suspend gate is applied.",
    reach: { kind: "check-all", script: "check:route-auth-gate" },
  },
  {
    checker: "src/scripts/checkAsyncHandlers.ts",
    inspects: { countPattern: "(\\d+) route file\\(s\\) clean", unit: "route files checked for unhandled async rejection" },
    responsibility: "An async Express handler cannot reject unhandled, which would answer nothing and leave the request hanging.",
    reach: { kind: "check-all", script: "check:async-handlers" },
  },
  {
    checker: "src/scripts/checkAuthorizationContract.ts",
    // Reads a live database through the Management API. Running it here to read an
    // inspected count would need credentials CI must not hold, and its own exit 2
    // (CANNOT-RUN) is already the honest verdict in a credential-free environment.
    credentialed: true,
    responsibility: "No migration restores broad client mutation privileges, exposes a server-derived column, or adds an unapproved RLS policy.",
    reach: { kind: "check-all", script: "check:authorization-contract" },
  },
  {
    checker: "src/scripts/checkFrozenDir.ts",
    inspects: { countPattern: "\\((\\d+) known file\\(s\\), unchanged\\)", unit: "frozen loose files verified" },
    responsibility: "Frozen directories stay frozen — a file added there is a change nobody agreed to.",
    reach: { kind: "check-all", script: "check:frozen-dir" },
  },
  {
    checker: "src/scripts/checkMediaObjects.ts",
    // Reads a live database through the Management API. Running it here to read an
    // inspected count would need credentials CI must not hold, and its own exit 2
    // (CANNOT-RUN) is already the honest verdict in a credential-free environment.
    credentialed: true,
    responsibility: "Every post_media row points at a Storage object that actually exists, which processing_status structurally cannot tell you.",
    reach: { kind: "check-all", script: "check:media-objects" },
  },
  {
    checker: "src/scripts/checkMigrationPrefixes.ts",
    inspects: { countPattern: "PASSED \\((\\d+) file\\(s\\)", unit: "migration files checked for prefix collision" },
    responsibility: "Migration filenames carry unique, ordered prefixes so apply order is derivable and two lanes cannot collide.",
    reach: { kind: "check-all", script: "check:migration-prefixes" },
  },
  {
    checker: "src/scripts/checkMissingLiveColumns.ts",
    // Reads a live database through the Management API. Running it here to read an
    // inspected count would need credentials CI must not hold, and its own exit 2
    // (CANNOT-RUN) is already the honest verdict in a credential-free environment.
    credentialed: true,
    responsibility: "Code never reads or writes a column the live database does not have.",
    reach: { kind: "check-all", script: "check:missing-live-columns" },
  },
  {
    checker: "src/scripts/checkNotNullWrites.ts",
    inspects: { countPattern: "(\\d+) source file\\(s\\), \\d+ write payload", unit: "source files scanned for null-into-NOT-NULL" },
    responsibility: "No write payload anywhere puts null into a NOT NULL column, which raises 23502 at run time on a path that may be mid-transaction.",
    reach: { kind: "check-all", script: "check:not-null-writes" },
  },
  {
    checker: "src/scripts/checkRankEventsSurfaces.ts",
    // Reads a live database through the Management API. Running it here to read an
    // inspected count would need credentials CI must not hold, and its own exit 2
    // (CANNOT-RUN) is already the honest verdict in a credential-free environment.
    credentialed: true,
    responsibility: "A behavioural probe that a real INSERT with each required rank_events surface is PERMITTED, rolled back.",
    reach: { kind: "check-all", script: "check:rank-events-surfaces" },
  },
  {
    checker: "src/scripts/checkSilentSupabaseWrites.ts",
    inspects: { countPattern: "(\\d+) pre-existing site\\(s\\) baseline", unit: "baselined write sites" },
    responsibility: "A mutation never discards its error, the write-side twin of the unchecked-read defect.",
    reach: { kind: "check-all", script: "check:silent-supabase-writes" },
  },
  {
    checker: "src/scripts/checkTestRunnerFlags.ts",
    inspects: { countPattern: "PASSED \\((\\d+) file\\(s\\) scanned", unit: "test-invocation files scanned" },
    responsibility: "The test invocation keeps the flags that make a failing test fail the process rather than print and exit 0.",
    reach: { kind: "check-all", script: "check:test-runner-flags" },
  },
  {
    checker: "src/scripts/checkTripKernelWriters.ts",
    inspects: { countPattern: "(\\d+) direct write\\(s\\) to trips", unit: "direct trip-aggregate writes inventoried" },
    responsibility: "Every writer of trip aggregate state goes through the Trip Kernel instead of updating trips directly.",
    reach: { kind: "check-all", script: "check:trip-kernel-writers" },
  },
  {
    checker: "src/scripts/checkWritePathColumns.ts",
    // Reads a live database through the Management API. Running it here to read an
    // inspected count would need credentials CI must not hold, and its own exit 2
    // (CANNOT-RUN) is already the honest verdict in a credential-free environment.
    credentialed: true,
    responsibility: "Every column a write path names exists in the live schema with a compatible type.",
    reach: { kind: "check-all", script: "check:write-path-columns" },
  },

  // ── reached by a GitHub workflow, not by check:all ────────────────────────
  {
    checker: "scripts/check-doc-citations.mjs",
    responsibility: "A documented claim cites a file:line that exists, so architecture docs cannot drift into fiction.",
    reach: { kind: "workflow", script: "check:doc-citations" },
    // MEASURED: "  file:line citations ...... 145" — printed on both paths.
    inspects: {
      countPattern: "file:line citations \\.+ (\\d+)",
      unit: "file:line citation(s) found in the committed docs it covers",
    },
  },
  {
    checker: "scripts/check-test-registration.mjs",
    responsibility: "A test file on disk is either in the run or on an allowlist saying why — a test nobody runs proves nothing.",
    reach: { kind: "workflow", script: "check:test-registration" },
    // MEASURED: "✅ check-test-registration: 872 test file(s) on disk under src/".
    // The clean path is the only one that prints it, which is the path this proof
    // is about: a green here must mean it enumerated the suite.
    inspects: {
      countPattern: "(\\d+) test file\\(s\\) on disk",
      unit: "test file(s) on disk under src/",
    },
  },
  {
    checker: "src/scripts/checkEnumLiterals.ts",
    responsibility: "Every enum literal code compares against is a label the database enum actually has.",
    reach: { kind: "workflow", script: "check:enum-literals" },
    // MEASURED: "Extracted 1383 filter literal(s) and 871 write literal(s) across 793 file(s)".
    inspects: {
      countPattern: "Extracted (\\d+) filter literal\\(s\\)",
      unit: "enum filter literal(s) extracted from source",
    },
  },
  {
    checker: "src/scripts/checkMigrationLedger.ts",
    responsibility: "The migration ledger matches what is applied, so provenance of a schema change is recoverable.",
    // Its own script name appears in live-db.yml only inside a COMMENT. The real
    // reach is certifyMigrations.ts, which spawns it as stage 1 (LEDGER_GATE) and
    // IS run by that workflow. Declaring it "workflow" was wrong and this check
    // caught it.
    reach: { kind: "delegated", by: "src/scripts/certifyMigrations.ts", script: "certify:migrations" },
  },
  {
    checker: "src/scripts/checkNoApiRoutePrefix.ts",
    responsibility: "A router path does not repeat the /api mount prefix, which would serve it at /api/api and reach nobody.",
    reach: { kind: "workflow", script: "check:api-prefix" },
    // MEASURED: "1534 route declaration(s) inspected across 143 route file(s)".
    // The count is the DECLARATION population, not the offender population: this
    // guard's whole output when clean is an absence, and an absence proves nothing
    // unless something was there to be absent from. Added when this guard was
    // instrumented; before that it printed no number at all.
    inspects: {
      countPattern: "(\\d+) route declaration\\(s\\) inspected",
      unit: "route declaration(s) inspected in src/routes/",
    },
  },
  {
    checker: "src/scripts/checkSchemaReferences.ts",
    responsibility: "Every table and column a source file names exists in the canonical schema.",
    reach: { kind: "workflow", script: "check:schema-references" },
    // MEASURED: "Extracted 5035 statically-resolvable schema references".
    inspects: {
      countPattern: "Extracted (\\d+) statically-resolvable schema references",
      unit: "statically-resolvable schema reference(s)",
    },
  },
  {
    checker: "src/scripts/checkSentryOtelDeps.ts",
    responsibility: "The Sentry/OpenTelemetry dependency set stays consistent, so instrumentation does not silently stop reporting.",
    // No workflow names check:sentry-otel-deps. It runs as the first half of the
    // `build` script, which scripts/build-production.sh invokes — so it gates the
    // DEPLOY, not the pull request. A drift lands in a red deploy rather than a
    // red PR, which is later and louder than CI would be.
    reach: { kind: "build-gate", script: "build", runner: "scripts/build-production.sh" },
  },
  {
    checker: "src/scripts/checkWriterlessReads.ts",
    responsibility: "No code reads a table nothing writes, which returns zero rows for ever and looks like an empty feature.",
    reach: { kind: "workflow", script: "check:writerless-reads" },
    // MEASURED: "Scanned 692 server file(s) ...; 353 relation(s) read".
    inspects: {
      countPattern: "(\\d+) relation\\(s\\) read",
      unit: "relation(s) observed being read",
    },
  },

  // ── reached by a registered mutation suite with a real-tree control ───────
  {
    checker: "src/scripts/checkClientPrivilegeBoundary.ts",
    responsibility: "No migration grants a client role a privilege RLS does not police — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN.",
    reach: {
      kind: "test-control",
      test: "src/test/clientPrivilegeBoundary.test.ts",
      seams: ["CLIENT_PRIVILEGE_DIRS"],
    },
  },
  {
    checker: "src/scripts/checkFlagSchemaPrerequisites.ts",
    responsibility: "A feature flag is never ON while the schema capability it depends on is absent — capability = flag AND schema, fail closed.",
    reach: {
      kind: "test-control",
      test: "src/test/flagSchemaPrerequisites.test.ts",
      seams: ["FLAG_SCHEMA_SNAPSHOT", "FLAG_SCHEMA_APPLIED"],
    },
  },
  {
    checker: "src/scripts/checkProjectionConsumers.ts",
    responsibility: "Every stored projection has a producer that writes it AND a consumer outside that producer that reads it.",
    reach: {
      kind: "test-control",
      test: "src/test/projectionConsumers.test.ts",
      seams: ["PROJECTION_REGISTRY", "PROJECTION_SRC"],
    },
  },
  {
    checker: "src/scripts/checkStateMachineWriters.ts",
    responsibility: "Every state a registered machine can hold has a real writer, or a recorded classification saying who blocks it.",
    reach: {
      kind: "test-control",
      test: "src/test/stateMachineWriters.test.ts",
      seams: ["STATE_MACHINE_REGISTRY", "STATE_MACHINE_SRC", "STATE_MACHINE_API_ROOT", "STATE_MACHINE_REPO_ROOT"],
    },
  },
  {
    // Not discovered by discoverGuards (a .sh aggregator, not a check*.ts), so
    // this entry is voluntary. It is here because an aggregator that nothing runs
    // is the same defect as a guard that nothing runs, and the registry is where
    // that question is answered.
    checker: "scripts/run-security-checks.sh",
    aggregator:
      "It IS the inspection proof for the twelve checks it gates: every one is declared with --require verdict " +
      "lines, and a check that exits 0 without printing them FAILS here rather than passing — that is how the " +
      "deletion-coverage and data-rights verdict patterns were caught going stale. Running it inside " +
      "checkGuardReachability to read a count of its own would re-run all twelve guards a second time, and the " +
      "count it produced would be an aggregate of theirs.",
    responsibility:
      "The security- and privacy-relevant guards run as one attributable suite: only exit 0 passes, a check that " +
      "cannot run FAILS rather than skips, and the security guards that remain unenforced are counted by name on " +
      "every run.",
    // workflow, not test-control: test-control requires the control to assert
    // exit 0, and this suite contains check:authorization-contract, which reads
    // the live CI database and exits 2 without credentials. Asserting 0 in a
    // credential-free run would mean relaxing the very contract the suite exists
    // to enforce. It runs in live-db.yml's credentialed job instead.
    // Seams, for a reader looking for the failure paths:
    // SECURITY_SUITE_CHECKS, SECURITY_SUITE_UNENFORCED.
    reach: { kind: "workflow", script: "check:security" },
  },

  {
    checker: "src/scripts/checkLayoverCutover.ts",
    responsibility:
      "Migration 2411 is never applied to production while a cutover condition is unmet — dependency, non-vacuity, " +
      "backfill completeness, reversibility, apply order, writer readiness or flag posture.",
    reach: {
      kind: "test-control",
      test: "src/test/layoverCutover.test.ts",
      seams: [
        "LAYOVER_CUTOVER_MIGRATION_DIR", "LAYOVER_CUTOVER_SNAPSHOT", "LAYOVER_CUTOVER_APPLIED",
        "LAYOVER_CUTOVER_ROLLBACK_DIR", "LAYOVER_CUTOVER_SRC", "LAYOVER_CUTOVER_MEASUREMENT",
        "LAYOVER_CUTOVER_COTOUCHERS",
      ],
    },
  },

  {
    checker: "src/scripts/checkGuardReachability.ts",
    inspects: { countPattern: "(\\d+) guard\\(s\\) on disk", unit: "guards discovered on disk" },
    responsibility: "Every guard in this tree is reached by something that would go red if it started failing.",
    reach: {
      kind: "test-control",
      test: "src/test/guardReachability.test.ts",
      seams: ["GUARD_REGISTRY", "GUARD_RUN_ALL", "GUARD_WORKFLOW_DIR"],
    },
  },

  // ── CI cannot invoke these ────────────────────────────────────────────────
  {
    checker: "src/scripts/checkProductionDrift.ts",
    responsibility: "Reports where the live production schema has drifted from the committed canonical schema.",
    reach: {
      kind: "manual",
      reason:
        "Reads PRODUCTION over the Management API. CI has no production credentials and must not be given any — the " +
        "Supabase guard front door exists precisely to refuse that. Run by a human against declared production when a " +
        "drift question is being asked; its findings become migrations, which ARE checked.",
    },
  },
  {
    checker: "src/scripts/checkDiscoveryCacheKeys.ts",
    responsibility: "Reports discovery cache keys whose shape would collide or leak across viewers.",
    reach: {
      kind: "manual",
      reason:
        "A read-only audit against a live database with real cache rows. There is nothing for it to read in CI — the " +
        "rehearsal database has no discovery traffic — so wiring it would make it pass vacuously, which is worse than " +
        "not running it: a check that examines nothing and prints green is the trap this repo has hit repeatedly.",
    },
  },
  {
    checker: "src/scripts/checkUnissuedSupabaseWrites.ts",
    inspects: { countPattern: "(\\d+) void statement\\(s\\) examined", unit: "void statements examined" },
    responsibility:
      "A void supabase mutation with no .then/.catch/await is never SENT — PostgrestBuilder issues its request " +
      "inside then() — so the row is not written at all.",
    // Was MANUAL with "NOT WIRED YET, AND THAT IS A GAP WITH A DATE ON IT" and a
    // promise to move it in the same change that cleared the 20. The 20 are
    // cleared, and the manual-run rule in checkGuardReachability is what demanded
    // this — it refuses a MANUAL entry for a guard that runs cleanly.
    reach: { kind: "check-all", script: "check:unissued-supabase-writes" },
  },

  {
    checker: "src/scripts/checkAdminGuard.ts",
    inspects: { countPattern: "(\\d+) route file\\(s\\) inspected", unit: "route files inspected" },
    responsibility: "Every admin-gated handler decides 'is this caller an admin' through the shared guard, not through its own role check.",
    // WAS MANUAL, on the reason "superseded in CI by check:route-auth-gate". That
    // was false in the way that matters: route-auth-gate enforces the broader,
    // weaker rule (a WRITING handler goes through requireUser) and says nothing
    // about who counts as an admin. Nine route files declared their own admin
    // check; all nine now go through lib/requireAdmin, the guard exits 0, and the
    // manual-run rule in checkGuardReachability is what surfaced the stale claim.
    reach: { kind: "check-all", script: "check:admin-guard" },
  },
  {
    checker: "src/scripts/checkMemoryTableOwnership.ts",
    inspects: {
      countPattern: "(\\d+) file\\(s\\) reference a memory event log",
      unit: "files referencing a memory event log",
    },
    responsibility:
      "public.memory_events (the projection family's log, live) and public.memory_domain_events (the spec \u00a717 " +
      "command log, unapplied) stay distinguishable: every reference is classified and no object name straddles them.",
    // Migration 2710 was written to call the command log `memory_events`, which
    // already exists in production as a different table that the
    // account-deletion cascade reads. CREATE TABLE IF NOT EXISTS would not have
    // created it and would not have complained. The rename fixed the table; a
    // second pass found nine dependent objects still named memory_events_*.
    // This is what stops the third instance.
    reach: { kind: "check-all", script: "check:memory-table-ownership" },
  },
  {
    checker: "src/scripts/checkCensusIntegrity.ts",
    inspects: {
      countPattern: "(\\d+) verdict row\\(s\\) parsed",
      unit: "census verdict rows parsed",
    },
    responsibility:
      "Each per-architecture census agrees with itself \u2014 its verdict rows parse, no requirement id is " +
      "double-counted, and it never states fewer requirements than it lists.",
    // It checks the DOCUMENT against itself, never the document against the
    // code. Three of the thirteen censuses already carry a correction header
    // saying their headline had drifted from their own body, which is the
    // failure this makes harder rather than one it can claim to have closed.
    reach: { kind: "check-all", script: "check:census-integrity" },
  },
  {
    checker: "src/scripts/checkSecurityDefinerOracles.ts",
    inspects: {
      countPattern: "(\\d+) SECURITY DEFINER function\\(s\\) alive",
      unit: "SECURITY DEFINER functions alive at the end of the migration corpus",
    },
    responsibility:
      "Every SECURITY DEFINER function in `public` is called by something in the database or the application — " +
      "an uncalled one is an authorization answer served over PostgREST to whoever asks.",
    // The remedy it asks for is a DROP, never a REVOKE. Revoking EXECUTE on a
    // definer function that a POLICY calls makes the policy raise "permission
    // denied for function" for every end-user token; that was measured on CI
    // for both language sql and language plpgsql before this guard was written,
    // because the obvious reading of the Supabase advisory is the wrong one.
    reach: { kind: "check-all", script: "check:security-definer-oracles" },
  },
  {
    checker: "src/scripts/check-media-bucket-privacy.ts",
    responsibility: "Reports Storage buckets whose public/private flag disagrees with the media privacy contract.",
    reach: {
      kind: "manual",
      reason:
        "Reads live Storage bucket configuration, which is project state rather than repository state — no diff can " +
        "change it and no CI run can observe the project it matters for. Run by a human against declared production " +
        "when bucket privacy is being changed. EXEMPT MEANS UNENFORCED, NOT SAFE.",
    },
  },
  {
    checker: "scripts/check-memory-citations.mjs",
    responsibility: "Reports memory/session notes whose cited file:line no longer resolves.",
    reach: {
      kind: "manual",
      reason:
        "Operates on session memory notes, which are not repository artifacts and are not present in a CI checkout, so " +
        "in CI it would examine nothing and pass — a vacuous green. check:doc-citations covers the same class for the " +
        "docs that ARE committed, and that one is wired.",
    },
  },
  {
    checker: "src/scripts/checkDataRights.ts",
    inspects: { countPattern: "(\\d+) intel column\\(s\\) inspected", unit: "intel columns inspected" },
    responsibility: "Every intel column carries a stated ownership class, so no personal contribution is stored with its owner undecided.",
    // WAS MANUAL, on a reason written from this guard's header rather than from
    // running it: "unwired because it carries standing findings". It exits 0.
    reach: { kind: "check-all", script: "check:data-rights" },
  },
  {
    checker: "src/scripts/checkDeletionCoverage.ts",
    // Repointed when the denominator was CORRECTED. The old line said "248
    // user-keyed table(s) in the baseline", and that number was wrong: user-linked
    // tables were identified by matching 18 column NAMES, so a table joined to
    // profiles.id by a foreign key without one of those names fell out of scope
    // entirely. The schema-driven graph puts the real denominator at 366.
    inspects: { countPattern: "DENOMINATOR\\s+(\\d+) table\\(s\\)", unit: "tables that must have a stated deletion fate" },
    responsibility: "Every user-keyed table has a STATED deletion fate, so a new one cannot arrive with its fate undecided and unnoticed.",
    // WAS MANUAL, and the reason was false — it exits 0. Read the responsibility
    // literally: it enforces that a fate is stated, NOT that the fate is erasure.
    // 225 of 248 tables currently state "survive deletion, undecided, owner
    // decision D6", which is a real and large gap that this guard passing does
    // not close. Wired anyway, because unwired it does not even hold the line
    // against a new table arriving with nothing said about it at all.
    reach: { kind: "check-all", script: "check:deletion-coverage" },
  },
  {
    checker: "src/scripts/checkLocationPurposes.ts",
    inspects: { countPattern: "(\\d+) table\\(s\\) hold coordinates", unit: "coordinate-holding tables" },
    responsibility: "Every coordinate-holding table is claimed by a documented purpose under the location-privacy contract.",
    // WAS MANUAL, on the theory that LOCATION_PRECISION_DEFAULT being an open
    // owner decision made the purpose taxonomy unsettled. Running it shows the
    // taxonomy it enforces is settled and satisfied — exit 0. The owner decision
    // is about PRECISION, which this guard does not touch.
    reach: { kind: "check-all", script: "check:location-purposes" },
  },
  {
    checker: "src/scripts/checkMediaUrlsExternalOnly.ts",
    responsibility: "Reports media URLs built against an internal host that would not resolve for a client.",
    reach: {
      kind: "manual",
      reason:
        "STAYS MANUAL, but not for the reason first recorded here. It was filed as an unwired oversight; running it " +
        "shows it exits 2 because ciProdReadOnlyAuditGuard refuses the target — it is a read-only audit against a live " +
        "database, and .github/scripts/assert-nonprod-supabase.sh will not sanction a credential-less or production " +
        "target. Wiring it into CI would score a permanent failure for a verdict that was never available. NOT WIRED " +
        "MEANS NOT ENFORCED: nothing about media URL shape is checked on a pull request.",
    },
  },
  {
    checker: "src/scripts/checkUncheckedSupabaseReads.ts",
    inspects: { countPattern: "judged (\\d+) read site\\(s\\)", unit: "supabase read sites judged" },
    responsibility: "No in-scope read discards its .error, which supabase-js turns into an empty result on a database failure.",
    // WAS MANUAL, AND WAS THE FINDING THAT MADE THIS REGISTRY EXIST. Every spawn
    // in its mutation suite pointed at a scratch tree through
    // UNCHECKED_READS_SRC_ROOT / UNCHECKED_READS_ALLOWLIST, so nothing anywhere
    // ran it against the real tree: a new unchecked .error added tomorrow failed
    // no check, and the 306 -> 0 burn-down it records was protected by nothing.
    //
    // It could only move here once the write-precondition tier's 91 findings were
    // FIXED rather than ledgered — 91/91, across three lanes, with no new benign
    // exemption and no new UNCLASSIFIED entry. Adding the control while the guard
    // was red would have meant a permanently-red suite, which is one deletion
    // away from being no suite at all.
    reach: {
      kind: "test-control",
      test: "src/test/uncheckedSupabaseReads.test.ts",
      seams: ["UNCHECKED_READS_SRC_ROOT", "UNCHECKED_READS_ALLOWLIST"],
    },
  },
];
