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

export interface GuardEntry {
  /** Path relative to artifacts/api-server. */
  checker: string;
  responsibility: string;
  reach: Reach;
}

export const GUARDS: readonly GuardEntry[] = [
  // ── reached by scripts/run-all-checks.sh ──────────────────────────────────
  {
    checker: "scripts/check-compiler-authentic.mjs",
    responsibility: "Proves the resolved TypeScript compiler REJECTS a program it must reject, so a green typecheck means something.",
    reach: { kind: "check-all", script: "check:compiler-authentic" },
  },
  {
    checker: "scripts/check-flag-polarity.mjs",
    responsibility: "Every feature flag is classified STOP/CAPABILITY/CONFIG and read through the reader that classification demands.",
    reach: { kind: "check-all", script: "check:flag-polarity" },
  },
  {
    checker: "scripts/check-guard-coverage.mjs",
    responsibility: "Every file that can reach Supabase directly imports a CI guard front door or carries a written exemption.",
    reach: { kind: "check-all", script: "check:guard-coverage" },
  },
  {
    checker: "scripts/check-route-auth-gate.mjs",
    responsibility: "A route handler that writes goes through requireUser, the only place the account ban/suspend gate is applied.",
    reach: { kind: "check-all", script: "check:route-auth-gate" },
  },
  {
    checker: "src/scripts/checkAsyncHandlers.ts",
    responsibility: "An async Express handler cannot reject unhandled, which would answer nothing and leave the request hanging.",
    reach: { kind: "check-all", script: "check:async-handlers" },
  },
  {
    checker: "src/scripts/checkAuthorizationContract.ts",
    responsibility: "No migration restores broad client mutation privileges, exposes a server-derived column, or adds an unapproved RLS policy.",
    reach: { kind: "check-all", script: "check:authorization-contract" },
  },
  {
    checker: "src/scripts/checkFrozenDir.ts",
    responsibility: "Frozen directories stay frozen — a file added there is a change nobody agreed to.",
    reach: { kind: "check-all", script: "check:frozen-dir" },
  },
  {
    checker: "src/scripts/checkMediaObjects.ts",
    responsibility: "Every post_media row points at a Storage object that actually exists, which processing_status structurally cannot tell you.",
    reach: { kind: "check-all", script: "check:media-objects" },
  },
  {
    checker: "src/scripts/checkMigrationPrefixes.ts",
    responsibility: "Migration filenames carry unique, ordered prefixes so apply order is derivable and two lanes cannot collide.",
    reach: { kind: "check-all", script: "check:migration-prefixes" },
  },
  {
    checker: "src/scripts/checkMissingLiveColumns.ts",
    responsibility: "Code never reads or writes a column the live database does not have.",
    reach: { kind: "check-all", script: "check:missing-live-columns" },
  },
  {
    checker: "src/scripts/checkNotNullWrites.ts",
    responsibility: "No write payload anywhere puts null into a NOT NULL column, which raises 23502 at run time on a path that may be mid-transaction.",
    reach: { kind: "check-all", script: "check:not-null-writes" },
  },
  {
    checker: "src/scripts/checkRankEventsSurfaces.ts",
    responsibility: "A behavioural probe that a real INSERT with each required rank_events surface is PERMITTED, rolled back.",
    reach: { kind: "check-all", script: "check:rank-events-surfaces" },
  },
  {
    checker: "src/scripts/checkSilentSupabaseWrites.ts",
    responsibility: "A mutation never discards its error, the write-side twin of the unchecked-read defect.",
    reach: { kind: "check-all", script: "check:silent-supabase-writes" },
  },
  {
    checker: "src/scripts/checkTestRunnerFlags.ts",
    responsibility: "The test invocation keeps the flags that make a failing test fail the process rather than print and exit 0.",
    reach: { kind: "check-all", script: "check:test-runner-flags" },
  },
  {
    checker: "src/scripts/checkTripKernelWriters.ts",
    responsibility: "Every writer of trip aggregate state goes through the Trip Kernel instead of updating trips directly.",
    reach: { kind: "check-all", script: "check:trip-kernel-writers" },
  },
  {
    checker: "src/scripts/checkWritePathColumns.ts",
    responsibility: "Every column a write path names exists in the live schema with a compatible type.",
    reach: { kind: "check-all", script: "check:write-path-columns" },
  },

  // ── reached by a GitHub workflow, not by check:all ────────────────────────
  {
    checker: "scripts/check-doc-citations.mjs",
    responsibility: "A documented claim cites a file:line that exists, so architecture docs cannot drift into fiction.",
    reach: { kind: "workflow", script: "check:doc-citations" },
  },
  {
    checker: "scripts/check-test-registration.mjs",
    responsibility: "A test file on disk is either in the run or on an allowlist saying why — a test nobody runs proves nothing.",
    reach: { kind: "workflow", script: "check:test-registration" },
  },
  {
    checker: "src/scripts/checkEnumLiterals.ts",
    responsibility: "Every enum literal code compares against is a label the database enum actually has.",
    reach: { kind: "workflow", script: "check:enum-literals" },
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
  },
  {
    checker: "src/scripts/checkSchemaReferences.ts",
    responsibility: "Every table and column a source file names exists in the canonical schema.",
    reach: { kind: "workflow", script: "check:schema-references" },
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
    checker: "src/scripts/checkGuardReachability.ts",
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
    checker: "src/scripts/checkAdminGuard.ts",
    responsibility: "Reports admin route handlers whose privilege check does not match the admin contract.",
    reach: {
      kind: "manual",
      reason:
        "Superseded in CI by check:route-auth-gate, which enforces the stronger structural rule (a writing handler goes " +
        "through requireUser) across every route rather than only the admin ones. Kept as a hand-run triage tool for the " +
        "admin surface specifically. NOT WIRED MEANS NOT ENFORCED: nothing here is protected by this file.",
    },
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
    responsibility: "Reports personal-data columns with no declared retention/erasure route under the data-rights contract.",
    reach: {
      kind: "manual",
      reason:
        "UNWIRED AND THIS IS A GAP, NOT A JUSTIFICATION. It is static and could run in CI; it is not wired because its " +
        "current output has standing findings that no one has burnt down, and wiring it today would make check:all " +
        "permanently red — one `|| true` away from being no check at all. The honest state is: it runs by hand, its " +
        "findings are unenforced, and it should be wired the moment its ledger reaches zero.",
    },
  },
  {
    checker: "src/scripts/checkDeletionCoverage.ts",
    responsibility: "Reports tables holding user data that the account-deletion path does not visit.",
    reach: {
      kind: "manual",
      reason:
        "UNWIRED AND THIS IS A GAP, NOT A JUSTIFICATION. Same shape as check:data-rights: static, CI-capable, and left " +
        "out because it carries standing findings. Deletion coverage is a legal-surface guarantee, so this is the most " +
        "consequential unwired guard in the list and should be wired ahead of the others.",
    },
  },
  {
    checker: "src/scripts/checkLocationPurposes.ts",
    responsibility: "Reports location reads and writes with no declared purpose under the location-privacy contract.",
    reach: {
      kind: "manual",
      reason:
        "UNWIRED AND THIS IS A GAP, NOT A JUSTIFICATION. Static and CI-capable; unwired because LOCATION_PRECISION_DEFAULT " +
        "is an open OWNER decision and the purpose taxonomy the check enforces is not settled until that is decided. " +
        "Wiring it now would encode a guess at an owner decision as a gate.",
    },
  },
  {
    checker: "src/scripts/checkMediaUrlsExternalOnly.ts",
    responsibility: "Reports media URLs built against an internal host that would not resolve for a client.",
    reach: {
      kind: "manual",
      reason:
        "UNWIRED AND THIS IS A GAP, NOT A JUSTIFICATION. Static and CI-capable. It is unwired for no recorded reason — " +
        "it simply was never added to run-all-checks.sh — and the honest classification is an oversight rather than a " +
        "decision. Nothing about media URL shape is enforced today.",
    },
  },
  {
    checker: "src/scripts/checkUncheckedSupabaseReads.ts",
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
