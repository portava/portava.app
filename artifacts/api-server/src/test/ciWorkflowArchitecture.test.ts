/**
 * CI architecture guard — the live-DB certification contract.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `live-db.yml` triggered on BOTH `push: ['**']` and `pull_request: ['**']`, so
 * every PR commit enqueued TWO runs, and serialized them with a GLOBAL
 * concurrency group:
 *
 *     concurrency:
 *       group: live-db-shared-supabase-project   # no ref — every branch
 *       cancel-in-progress: false
 *
 * GitHub concurrency does not queue. It keeps one in-progress run and one
 * pending run per group and EVICTS the rest — so with a global group, a push to
 * branch B cancelled branch A's certification. Measured over 100 runs before
 * the fix: 64 cancelled, 12 successful, and 45% of commits received no live-DB
 * verdict AT ALL.
 *
 * That is a correctness bug, not a slow pipeline. A commit with no verdict is
 * indistinguishable, in GitHub's check list, from a commit that passed. PR #339
 * showed 20/20 green with zero live-DB entries, and `places.country` reached
 * `main` through the same gap.
 *
 * THE INVARIANT THIS PROTECTS
 * ---------------------------
 *   Every current PR head that requires live-database certification must
 *   eventually receive an authoritative verdict, and unrelated work must not be
 *   able to cancel it.
 *
 * Five properties hold that up, and each is asserted below:
 *   1. One certification per SHA — no duplicate push+PR execution.
 *   2. Concurrency is keyed per PR, so only an obsolete run of the SAME PR can
 *      be superseded.
 *   3. Mutual exclusion on the shared database is a WAIT, not a cancellation.
 *   4. Every database job re-proves the slot IN ITS OWN ATTEMPT, because
 *      `gh run rerun --failed` does not re-run the job that proved it.
 *   5. Cancelled / skipped / starved is reported as NOT EXECUTED, never as pass.
 *
 * WHAT THIS CANNOT CHECK
 * ----------------------
 * This is mostly a YAML contract test, with two exceptions that run real
 * processes: the verdict classifier and the slot decider/wait loop are executed
 * here (the latter against a stub `gh` on PATH), because control flow is what a
 * static read is worst at and both previous escapes were control-flow bugs.
 *
 * It still cannot prove GitHub's scheduler behaves as documented, cannot prove
 * that a partial re-run really does carry a succeeded job forward (that is
 * GitHub's behaviour, observed on 2026-09-05, not something reproducible
 * locally), cannot prove the loop's live `gh api` query returns the runs it is
 * assumed to, and cannot observe branch protection. Those need GitHub-hosted
 * certification; see docs/ci/README.md. What it does prove is that the
 * repository never silently reverts to a shape that caused a documented
 * failure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../../..");
const WF = resolve(REPO_ROOT, ".github/workflows");

const liveDb = readFileSync(resolve(WF, "live-db.yml"), "utf8");
const ci = readFileSync(resolve(WF, "ci.yml"), "utf8");
const unwired = readFileSync(resolve(WF, "unwired-checks.yml"), "utf8");

/** The `on:` block, as raw text (yaml parsing turns `on` into `true`). */
function triggerBlock(src: string): string {
  const start = src.indexOf("\non:\n");
  assert.ok(start >= 0, "no `on:` block found");
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(?:permissions|concurrency|env|jobs):/);
  return rest.slice(0, end === -1 ? undefined : end);
}

function concurrencyBlock(src: string): string {
  const start = src.indexOf("\nconcurrency:\n");
  assert.ok(start >= 0, "no top-level `concurrency:` block found");
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(?:permissions|env|jobs|on):/);
  return rest.slice(0, end === -1 ? undefined : end);
}

describe("CI architecture — live-DB certification is not duplicated", () => {
  it("does not run live-DB on every branch push", () => {
    const on = triggerBlock(liveDb);
    assert.ok(
      !/push:\s*\n\s*branches:\s*\['\*\*'\]/.test(on),
      "live-db.yml triggers on `push: ['**']`. Combined with `pull_request`, " +
        "that enqueues TWO certifications for every PR commit against one shared " +
        "database — 63% of sampled SHAs had a duplicate, and the duplicate is " +
        "what was evicting other branches. Certify the PR head on `pull_request` " +
        "and the merged commit on `push: [main]`.",
    );
  });

  it("still certifies the PR head and the merged commit", () => {
    const on = triggerBlock(liveDb);
    assert.match(on, /pull_request:/, "the pre-merge verdict must exist");
    assert.match(
      on, /push:\s*\n\s*branches:\s*\[main\]/,
      "post-merge certification of main must exist — no pre-merge run can " +
        "certify the merge commit, because it does not exist until it lands",
    );
  });

  it("leaves ordinary non-DB CI running on every push", () => {
    // The fix must not cost the repo its normal CI coverage.
    for (const [name, src] of [["ci.yml", ci], ["unwired-checks.yml", unwired]] as const) {
      const on = triggerBlock(src);
      assert.match(
        on, /push:\s*\n\s*branches:\s*\['\*\*'\]/,
        `${name} must keep running on every branch push — only the DB lane was narrowed`,
      );
    }
  });
});

describe("CI architecture — concurrency cannot cancel unrelated work", () => {
  it("keys the live-DB group per PR, not globally", () => {
    const c = concurrencyBlock(liveDb);
    const group = /group:\s*(.+)/.exec(c)?.[1]?.trim() ?? "";
    assert.ok(group.length > 0, "live-db.yml has no concurrency group");
    assert.ok(
      /\$\{\{/.test(group),
      `live-db.yml concurrency group is the constant "${group}". A constant group ` +
        "is shared by every branch, so GitHub's eviction crosses refs and one " +
        "branch's push cancels another branch's certification. It must be keyed " +
        "on the PR number or ref.",
    );
    assert.ok(
      /pull_request\.number|github\.ref|head_ref/.test(group),
      `live-db.yml concurrency group "${group}" is not keyed on the PR or ref`,
    );
  });

  it("serializes the shared database by WAITING, not by cancelling", () => {
    const script = resolve(REPO_ROOT, ".github/scripts/live-db-acquire-slot.sh");
    assert.ok(existsSync(script), "the queue script is missing");
    assert.ok(
      (statSync(script).mode & 0o111) !== 0,
      "live-db-acquire-slot.sh is not executable",
    );
    assert.match(
      liveDb, /live-db-acquire-slot\.sh/,
      "live-db.yml no longer invokes the queue script — if serialization moved " +
        "back to a global concurrency group, cross-branch eviction is back too",
    );
    const body = readFileSync(script, "utf8");
    assert.match(body, /exit 75/, "a slot timeout must exit non-zero, not fall through");
  });

  it("makes every database job wait behind the slot", () => {
    // A DB job that skips the queue races the run that holds it.
    for (const job of [
      "api-server-check-all",
      "schema-drift",
      "post-media-revocation-rehearsal",
      "live-db-security-suites",
    ]) {
      const i = liveDb.indexOf(`\n  ${job}:\n`);
      assert.ok(i > 0, `job ${job} not found`);
      const block = liveDb.slice(i, i + 600);
      assert.match(
        block, /needs:\s*\[[^\]]*live-db-slot/,
        `${job} does not depend on live-db-slot, so it can touch the shared ` +
          "database while another run holds it",
      );
    }
  });

  it("orders schema-mutating DDL ahead of the jobs that assert schema state", () => {
    // schema-drift applies real migrations when github.ref == refs/heads/main.
    // A suite that enumerates RLS policies WHILE a migration adds or drops one
    // can observe a half-applied schema and report a confident, wrong result —
    // the same class of failure this workflow exists to eliminate.
    //
    for (const job of ["post-media-revocation-rehearsal", "live-db-security-suites"]) {
      const i = liveDb.indexOf(`\n  ${job}:\n`);
      assert.ok(i > 0, `job ${job} not found`);
      assert.match(
        liveDb.slice(i, i + 1400), /needs:\s*\[[^\]]*schema-drift/,
        `${job} asserts schema state but does not wait for schema-drift, so it can ` +
          "run against a database mid-migration",
      );
    }

    // api-server-check-all BELONGS IN THAT CATEGORY. This assertion used to deny
    // it: it required the edge to be ABSENT, reasoning that the job is "read-only
    // apart from a self-aborting probe, so this costs time and buys nothing
    // (measured: +55s narrow vs +2m52s wide)".
    //
    // The measurement was right. The premise was wrong, and main run 33988500200
    // is the counterexample. check:all contains TWO checks that assert live schema
    // state:
    //   • check:write-path-columns fetches the live schema and fails on any table
    //     the code references but the database lacks;
    //   • check:rank-events-surfaces probes the live rank_events CHECK constraint
    //     to prove every surface literal is actually accepted.
    // On that run the two jobs started one second apart, the schema fetch landed
    // at 20:01:19, and schema-drift's applier did not finish until 20:02:04. So
    // check:write-path-columns read a schema from BEFORE its own run's migrations
    // and reported event_passport_shares — created by 2294, merged minutes earlier
    // in #394 — as missing from nine call sites. Main went red on a table that its
    // own run created 45 seconds later.
    //
    // READ-ONLY IS NOT ORDER-INDEPENDENT. Being read-only is what makes this
    // failure mode SILENT rather than absent: the job cannot corrupt the schema,
    // so it just reports, confidently and wrongly, whatever it happened to see.
    // That is the "confident, wrong result" this test's own opening paragraph
    // exists to prevent — the earlier wording scoped it to mid-migration
    // interleaving and missed not-yet-applied entirely.
    //
    // The edge is therefore REQUIRED, and the +2m52s is the price of not emitting
    // a false red on every commit that adds a table alongside its migration.
    const k = liveDb.indexOf("\n  api-server-check-all:\n");
    assert.ok(k > 0, "job api-server-check-all not found");
    const afterJobStart = liveDb.slice(k + 1);
    const nextJob = afterJobStart.search(/\n {2}[a-z0-9-]+:\n/);
    const checkAll = nextJob > 0 ? afterJobStart.slice(0, nextJob) : afterJobStart;
    assert.match(
      checkAll, /needs:\s*\[[^\]]*schema-drift/,
      "api-server-check-all asserts live schema state (check:write-path-columns, " +
        "check:rank-events-surfaces) but does not wait for schema-drift, so it can " +
        "read a schema from before its own run's migrations and report a table that " +
        "its own run creates seconds later as missing",
    );
    // ORDERING, NOT GATING — this half is load-bearing. On a PR branch the branch's
    // own migration is never applied to the CI project, so schema-drift legitimately
    // FAILS whenever a PR creates an object. A plain `needs:` reads that expected
    // failure as a reason to SKIP, which is exactly what happens to the two jobs
    // above. Letting it skip check:all too would silently disable the primary
    // code-quality gate on precisely the PRs that change the schema — and a job that
    // silently skips is indistinguishable from one that passed, which is the failure
    // this whole workflow exists to eliminate.
    assert.match(
      checkAll, /if:\s*\$\{\{\s*!\s*cancelled\(\)\s*\}\}/,
      "api-server-check-all waits for schema-drift but has no `if: ${{ !cancelled() }}`, " +
        "so a schema-drift failure now SKIPS it — turning the primary code-quality " +
        "gate off for every PR that creates a database object",
    );
  });
});

/**
 * ── THE RE-RUN BYPASS, MEASURED 2026-09-05 ──────────────────────────────────
 *
 * The `needs: live-db-slot` edge asserted above is necessary and NOT
 * sufficient. `gh run rerun --failed` re-runs only the jobs that FAILED; the
 * queue job had SUCCEEDED, so GitHub carried its result forward and the
 * database jobs of the new attempt started with their `needs:` satisfied by a
 * proof belonging to a previous attempt. From the Actions API:
 *
 *   33967089832 (main)     attempt 1  slot 12:49:14→13:06:58, DB 13:08:09→13:15:46
 *   33967153487 (PR #408)  attempt 1  slot 12:51:13→13:17:10, DB 13:17:56→13:23:28
 *   33967089832 (main)     attempt 2  run_started_at 13:17:42, DB 13:17:47→13:23:12
 *                                     — and NO acquire-slot job in the attempt
 *
 * The two attempts overlapped on the shared CI project for five and a half
 * minutes. Five suites went red across the two runs with "my fixture row
 * vanished" errors while the code under test was correct.
 *
 * The structural lesson: THE JOB THAT PROVES THE SLOT MUST BE THE JOB THAT USES
 * IT, because only then does re-running the user re-run the proof. These tests
 * hold that shape in place, and exercise the decider against the real listing.
 */
describe("CI architecture — a re-run cannot inherit somebody else's slot", () => {
  const DECIDER = resolve(REPO_ROOT, ".github/scripts/live-db-slot-decide.sh");

  /** Run the decider over a listing, exactly as the wait loop pipes it in. */
  const decide = (runId: string, listing: string) => {
    const r = spawnSync("bash", [DECIDER], {
      input: listing,
      encoding: "utf8",
      env: { ...process.env, GITHUB_RUN_ID: runId },
    });
    return { holder: /holder=(\d+)/.exec(r.stdout)?.[1] ?? "", code: r.status };
  };

  it("keeps the predicate in a script with no network, so it can be executed here", () => {
    assert.ok(
      existsSync(DECIDER),
      "live-db-slot-decide.sh is missing. Inlining the predicate back into the wait " +
        "loop makes it untestable by construction — the loop needs the Actions API.",
    );
    assert.ok((statSync(DECIDER).mode & 0o111) !== 0, "live-db-slot-decide.sh is not executable");
  });

  // ── THE FORFEIT CLAUSE (2026-09-21) ────────────────────────────────────────
  //
  // Measured on run 35612480282. Its queue job hit the 45-minute timeout and
  // FAILED; its three slot-gated DB jobs were skipped, correctly. But
  // `api-server-check-all` carries `if: !cancelled()`, so it started anyway,
  // and its `verify` step re-asked this predicate — which said YES, because the
  // run was the oldest in_progress run. It was the oldest BECAUSE it was still
  // running, and still running BECAUSE that job had been told it held the slot.
  // Seven consecutive runs sat in that loop, each occupying ~90 minutes against
  // a 45-minute timeout.
  //
  // These cases pin both halves of the fix: a forfeited run stops blocking
  // others, and — the half that keeps this from being an eviction — a run that
  // is merely SLOW is never dropped.

  it("a run whose queue job FAILED stops blocking the runs behind it", () => {
    const listing =
      "2026-09-21T13:47:00Z 35612480282 forfeited\n" + "2026-09-21T14:29:15Z 35624863434 held\n";
    assert.deepEqual(
      decide("35624863434", listing),
      { holder: "35624863434", code: 0 },
      "the later run must acquire: the run ahead of it demonstrably never held the slot",
    );
  });

  it("a forfeited run is refused its OWN slot, so its verify step fails instead of proceeding", () => {
    // This is the half that actually stops the database being touched. Without
    // it the run keeps working on a claim its queue job never won.
    const listing =
      "2026-09-21T13:47:00Z 35612480282 forfeited\n" + "2026-09-21T14:29:15Z 35624863434 held\n";
    const r = decide("35612480282", listing);
    assert.equal(r.code, 1, "a run that forfeited must not be told it holds the slot");
    assert.notEqual(r.holder, "35612480282");
  });

  it("does NOT evict a run that is merely slow — only one that already lost", () => {
    // The mutual-exclusion property this whole tier exists for. A run whose
    // queue job succeeded or is still running keeps the slot until its jobs
    // finish, however long that takes.
    const listing =
      "2026-09-21T13:47:00Z 35612480282 held\n" + "2026-09-21T14:29:15Z 35624863434 held\n";
    assert.deepEqual(
      decide("35624863434", listing),
      { holder: "35612480282", code: 1 },
      "waiting is the price of a shared mutable database; evicting an active user is not on the menu",
    );
  });

  it("an UNKNOWN claim keeps a run blocking — the annotation fails closed", () => {
    // `annotate_claims` emits `held` when the Actions API cannot be reached or
    // the job cannot be found, and a two-field line means `held` too. Either
    // way the behaviour must be the pre-fix behaviour, never "assume it is
    // done with the database".
    const twoField = "2026-09-21T13:47:00Z 35612480282\n2026-09-21T14:29:15Z 35624863434\n";
    assert.deepEqual(decide("35624863434", twoField), { holder: "35612480282", code: 1 });
    const explicitHeld = "2026-09-21T13:47:00Z 35612480282 held\n2026-09-21T14:29:15Z 35624863434 held\n";
    assert.deepEqual(decide("35624863434", explicitHeld), { holder: "35612480282", code: 1 });
  });

  it("a claim value it cannot name is REFUSED, not ignored", () => {
    const listing = "2026-09-21T13:47:00Z 35612480282 probably\n2026-09-21T14:29:15Z 35624863434 held\n";
    assert.equal(
      decide("35624863434", listing).code,
      3,
      "a listing that did not parse is not a listing that proves the database is free",
    );
  });

  it("when EVERY active run has forfeited, nobody holds the slot — including us", () => {
    // Not "the slot is free". This run still has to establish its own claim,
    // and it cannot do that by being the oldest of an empty set.
    const listing = "2026-09-21T13:47:00Z 35612480282 forfeited\n2026-09-21T14:29:15Z 35624863434 forfeited\n";
    assert.equal(decide("35624863434", listing).code, 1);
  });

  it("refuses the exact attempt-2 bypass measured on 2026-09-05", () => {
    // The listing as it stood at 13:17:47: main's attempt 2 had just restarted
    // (run_started_at 13:17:42) while PR #408's run, started 12:49:56, was
    // still in progress and mid-suite.
    const listing = "2026-09-05T13:17:42Z 33967089832\n2026-09-05T12:49:56Z 33967153487\n";

    assert.deepEqual(
      decide("33967089832", listing),
      { holder: "33967153487", code: 1 },
      "main's re-run attempt must NOT be told it holds the database — it is the newer " +
        "of the two active runs and the older one was mid-suite",
    );
    assert.deepEqual(
      decide("33967153487", listing),
      { holder: "33967153487", code: 0 },
      "the run that actually queued must keep the slot across the other run's re-run",
    );
  });

  it("treats an unusable listing as 'I cannot see', never as 'nobody is there'", () => {
    for (const listing of ["", "\n\n", "gh: could not fetch\n"]) {
      assert.equal(
        decide("33967089832", listing).code, 3,
        `listing ${JSON.stringify(listing)} must be undecidable, not free`,
      );
    }
    // A listing that does not contain the asking run is stale or filtered, so
    // the "oldest" it names is not authoritative either.
    assert.equal(decide("33967089832", "2026-09-05T12:49:56Z 33967153487\n").code, 3);
  });

  it("grants the slot when this run really is the oldest active one", () => {
    assert.deepEqual(
      decide("100", "2026-09-05T12:00:00Z 100\n2026-09-05T12:30:00Z 200\n"),
      { holder: "100", code: 0 },
    );
    assert.deepEqual(
      decide("200", "2026-09-05T12:00:00Z 100\n2026-09-05T12:30:00Z 200\n"),
      { holder: "100", code: 1 },
    );
  });

  it("makes EVERY database job re-prove the slot itself, before it installs anything", () => {
    // Comment lines are removed FIRST. Every one of these jobs carries a
    // comment containing the words "pnpm install", and the first version of
    // this test ordered the verify step against that comment rather than
    // against the step — the same "a comment satisfied the guard" mistake
    // liveFixtureEmails.test.ts records one level down.
    const stripYamlComments = (src: string) =>
      src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

    for (const job of [
      "api-server-check-all",
      "schema-drift",
      "post-media-revocation-rehearsal",
      "live-db-security-suites",
    ]) {
      const start = liveDb.indexOf(`\n  ${job}:\n`);
      assert.ok(start > 0, `job ${job} not found`);
      const nextJob = liveDb.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n {4}name:/);
      const block = stripYamlComments(
        liveDb.slice(start, nextJob === -1 ? undefined : start + 1 + nextJob),
      );

      const verifyAt = block.indexOf("LIVE_DB_SLOT_ROLE: verify");
      assert.ok(
        verifyAt > 0,
        `${job} does not re-verify the shared-database slot. Its 'needs: live-db-slot' edge is ` +
          "satisfied by a job that 'gh run rerun --failed' does NOT re-run, so on a partial " +
          "re-run this job would touch the shared CI project having proved nothing about THIS " +
          "attempt. That is the 2026-09-05 corruption. Add the verify step.",
      );
      assert.ok(
        block.slice(0, verifyAt).includes("live-db-acquire-slot.sh") === false,
        `${job} appears to run the queue script before declaring the verify role`,
      );

      // Before anything can reach the database: before install, before the
      // suites, before the migration applier.
      const installAt = block.indexOf("pnpm install --frozen-lockfile");
      assert.ok(installAt > 0, `${job} has no install step to order against`);
      assert.ok(
        verifyAt < installAt,
        `${job} verifies the slot AFTER installing. Move it above: the point is to refuse ` +
          "before any step that can reach the database.",
      );

      // A step guarded by `if:` is a step that can be turned off in one word.
      const stepStart = block.lastIndexOf("      - name:", verifyAt);
      assert.ok(
        !/\n\s{8}if:/.test(block.slice(stepStart, verifyAt)),
        `${job}'s slot verification is conditional. A fail-closed check with an 'if:' is not fail-closed.`,
      );
    }
  });

  /**
   * The wait loop, executed for real against a stub Actions API.
   *
   * Reading the script is not proof that it calls the decider or that it exits
   * 75 rather than falling through — the previous version's bug was exactly a
   * control-flow one (a job that never ran the check at all), and control flow
   * is what a static read is worst at. So `gh` is replaced with a stub on PATH
   * and the script is run.
   */
  const runSlotScript = (opts: {
    role: string;
    runId: string;
    listing: string | null;
    /** Long enough that more than one poll is logged before the deadline. The
     *  script always polls once before it may time out, so even a 1s budget
     *  prints one `holder=` line. */
    timeoutSeconds?: number;
    /** Stub `date` so every call advances one second: every call crosses a
     *  second boundary, the case a real 1-second-resolution clock hits only
     *  occasionally. */
    tickingClock?: boolean;
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "portava-slot-"));
    writeFileSync(join(dir, "listing.txt"), opts.listing ?? "");
    if (opts.tickingClock) {
      const clock = JSON.stringify(join(dir, "clock"));
      writeFileSync(
        join(dir, "date"),
        "#!/usr/bin/env bash\n" +
          `n=$(cat ${clock} 2>/dev/null || echo 1000); echo $((n + 1)) > ${clock}; echo "$n"\n`,
        { mode: 0o755 },
      );
    }
    writeFileSync(
      join(dir, "gh"),
      "#!/usr/bin/env bash\n" +
        // `gh api .../actions/workflows/<id>/runs...` -> the listing.
        'if [[ "$*" == *"/actions/workflows/"* ]]; then\n' +
        `  cat ${JSON.stringify(join(dir, "listing.txt"))}\n` +
        "  exit 0\n" +
        "fi\n" +
        // `gh api repos/<r>/actions/runs/<id> --jq .workflow_id` -> a workflow id.
        "echo 424242\n",
      { mode: 0o755 },
    );
    const r = spawnSync("bash", [resolve(REPO_ROOT, ".github/scripts/live-db-acquire-slot.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "stub",
        GITHUB_REPOSITORY: "portava/portava.app",
        GITHUB_RUN_ID: opts.runId,
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_OUTPUT: join(dir, "out"),
        LIVE_DB_SLOT_ROLE: opts.role,
        LIVE_DB_SLOT_TIMEOUT_SECONDS: String(opts.timeoutSeconds ?? 1),
        LIVE_DB_SLOT_POLL_SECONDS: "1",
      },
    });
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("EXECUTES fail-closed: a verify that cannot prove the slot exits 75", () => {
    // The measured scenario, run for real: main's attempt 2 asking while PR
    // #408's older run is still active.
    const contended = runSlotScript({
      role: "verify",
      runId: "33967089832",
      listing: "2026-09-05T13:17:42Z 33967089832\n2026-09-05T12:49:56Z 33967153487\n",
      timeoutSeconds: 5,
    });
    assert.equal(
      contended.code, 75,
      `a contended verify must exit 75 (EX_TEMPFAIL), not proceed. Got ${contended.code}:\n${contended.out}`,
    );
    assert.match(contended.out, /holder=33967153487/, "it must name the run that actually holds the database");
    assert.match(contended.out, /rerun --failed/, "the error must say how the attempt got here");

    // And an unusable listing is not a free slot either.
    assert.equal(runSlotScript({ role: "verify", runId: "1", listing: "" }).code, 75);
  });

  it("EXECUTES pass-through: an uncontended verify proceeds immediately", () => {
    const r = runSlotScript({
      role: "verify",
      runId: "33967153487",
      listing: "2026-09-05T13:17:42Z 33967089832\n2026-09-05T12:49:56Z 33967153487\n",
    });
    assert.equal(r.code, 0, `the oldest active run must be let through. Got ${r.code}:\n${r.out}`);
    assert.match(r.out, /ACQUIRED/);
  });

  it("EXECUTES ask-before-timeout: a second boundary before the first poll never times out the slot holder", () => {
    // The CI failure this pins: START and the first NOW straddled a second
    // boundary, ELAPSED was already 1 >= a 1s budget, and the oldest active run
    // exited 75 without ever asking. With a clock that ticks on every call the
    // boundary is crossed every time.
    const r = runSlotScript({
      role: "verify",
      runId: "33967153487",
      listing: "2026-09-05T13:17:42Z 33967089832\n2026-09-05T12:49:56Z 33967153487\n",
      tickingClock: true,
    });
    assert.equal(r.code, 0, `the slot holder must be let through after its first poll. Got ${r.code}:\n${r.out}`);
    assert.match(r.out, /ACQUIRED/);

    // Still fail-closed: a contended verify on the same ticking clock polls
    // once, names the holder, and then times out with 75.
    const contended = runSlotScript({
      role: "verify",
      runId: "33967089832",
      listing: "2026-09-05T13:17:42Z 33967089832\n2026-09-05T12:49:56Z 33967153487\n",
      tickingClock: true,
    });
    assert.equal(contended.code, 75, `a contended verify must still exit 75. Got ${contended.code}:\n${contended.out}`);
    assert.match(contended.out, /holder=33967153487/, "it must have asked once before timing out");
  });

  it("refuses an unknown role rather than defaulting to something permissive", () => {
    assert.equal(runSlotScript({ role: "advisory", runId: "1", listing: "" }).code, 64);
  });

  it("routes both roles through one implementation, and both fail closed", () => {
    const body = readFileSync(resolve(REPO_ROOT, ".github/scripts/live-db-acquire-slot.sh"), "utf8");
    assert.match(
      body, /live-db-slot-decide\.sh/,
      "the wait loop no longer calls the tested decider — an inline copy of the predicate is " +
        "untested by construction",
    );
    assert.match(body, /LIVE_DB_SLOT_ROLE/, "the verify role is gone; each DB job would have nothing to call");
    // Neither role may treat 'I could not decide' as 'the slot is free'.
    assert.ok(
      !/exit 0/.test(body.split("while :;")[0] ?? ""),
      "the script exits 0 before it has decided anything",
    );
  });
});

describe("CI architecture — an unexecuted certification is not a pass", () => {
  const i = liveDb.indexOf("\n  live-db-verdict:\n");
  const verdict = i > 0 ? liveDb.slice(i) : "";

  it("has a verdict job that always runs", () => {
    assert.ok(i > 0, "live-db-verdict job is missing — nothing aggregates the result");
    assert.match(
      verdict, /if:\s*\$\{\{\s*always\(\)\s*\}\}/,
      "the verdict must run even when a job failed or was cancelled; otherwise " +
        "the one check that reports 'nothing ran' is itself skipped",
    );
  });

  it("depends on every job whose result it reports", () => {
    for (const job of [
      "preflight",
      "live-db-slot",
      "api-server-check-all",
      "schema-drift",
      "live-db-security-suites",
      "post-media-revocation-rehearsal",
    ]) {
      assert.ok(
        new RegExp(`needs:[\\s\\S]{0,400}- ${job}\\b`).test(verdict),
        `live-db-verdict does not list '${job}' in needs — a job it cannot see ` +
          "cannot be required to have succeeded",
      );
    }
  });

  it("distinguishes NOT EXECUTED from FAIL, and neither from PASS — by BEHAVIOUR", () => {
    // This assertion used to grep the YAML for the string "NOT_EXECUTED", and a
    // mutation that collapsed the state into FAIL survived it, because the word
    // still appeared in the surrounding comment. Greping prose is not testing
    // behaviour, so the classifier is now a script and this runs it.
    const script = resolve(REPO_ROOT, ".github/scripts/live-db-verdict.sh");
    assert.ok(existsSync(script), "the verdict classifier script is missing");

    const verdictOf = (...pairs: string[]) => {
      const r = spawnSync("bash", [script, ...pairs], { encoding: "utf8" });
      return {
        state: (r.stdout.split("\n")[0] ?? "").replace("live-DB certification: ", "").trim(),
        code: r.status,
      };
    };

    assert.deepEqual(verdictOf("a=success", "b=success"), { state: "PASS", code: 0 });
    assert.deepEqual(verdictOf("a=success", "b=failure"), { state: "FAIL", code: 1 });

    // The three shapes an evicted / starved run actually leaves behind.
    for (const absent of ["cancelled", "skipped", ""]) {
      assert.deepEqual(
        verdictOf("a=success", `b=${absent}`),
        { state: "NOT_EXECUTED", code: 1 },
        `result '${absent}' must be NOT_EXECUTED — that is what an evicted run looks like`,
      );
    }

    // A real failure outranks an absence: "it is broken" is the headline.
    assert.equal(verdictOf("a=failure", "b=cancelled").state, "FAIL");

    // Anything GitHub adds later must land on the safe side.
    assert.deepEqual(
      verdictOf("a=success", "b=some_future_state"),
      { state: "NOT_EXECUTED", code: 1 },
      "an unrecognised job result must not be assumed good",
    );
  });

  it("invokes that classifier rather than re-implementing it inline", () => {
    assert.match(
      verdict, /live-db-verdict\.sh/,
      "the verdict job no longer calls the tested classifier — an inline copy is " +
        "untested by construction, which is how the NOT_EXECUTED collapse " +
        "survived a mutation once already",
    );
  });

  it("never softens a failure with continue-on-error", () => {
    // A guard one `continue-on-error: true` away from advisory is not a guard.
    for (const [name, src] of [
      ["live-db.yml", liveDb], ["ci.yml", ci], ["unwired-checks.yml", unwired],
    ] as const) {
      assert.ok(
        !/continue-on-error:\s*true/.test(src),
        `${name} contains continue-on-error: true — that converts a required ` +
          "check into an advisory one without saying so",
      );
    }
  });
});

/**
 * THE THREE NAMED VERDICTS — one guard, applied uniformly.
 *
 * WHY THIS BLOCK EXISTS
 * ---------------------
 * `live-db-verdict` was guarded above from the day it was written. `ci-verdict`
 * and `unwired-verdict` were not: before this block, their names appeared
 * NOWHERE in the repository outside the YAML that defines them. Deleting
 * `ci-verdict` from `ci.yml`, or quietly dropping `api-server-tests` from its
 * `needs:` list, broke nothing that anything could notice.
 *
 * That is the same failure one level up from the one the verdict jobs exist to
 * catch. A verdict job's whole claim is *"every job in this workflow ran and
 * succeeded"*. The claim is only true while its `needs:` list is COMPLETE — and
 * `needs:` is a list a human maintains by hand, in a different part of the file
 * from the job it must track. Add a job to a workflow, forget the verdict, and
 * the verdict goes green while reporting on a strictly smaller workflow than the
 * one that ran. Nothing is red. Nothing is skipped. The check simply stopped
 * covering the thing it is named for.
 *
 * So the job list is DERIVED from each workflow rather than restated here. A
 * hardcoded list is a second copy that rots in the same silence.
 *
 * PROSE IS NOT EVIDENCE
 * ---------------------
 * These assertions deliberately do NOT grep for a job name anywhere in the
 * verdict body. `ci-verdict`'s own `::error::` string contains the word
 * "preflight", so a naive containment check is satisfied by an error message
 * about a job the verdict no longer inspects — exactly the trap that let the
 * NOT_EXECUTED collapse survive a mutation further up this file. Each job must
 * appear in two STRUCTURAL positions instead: bound to a real
 * `needs.<job>.result` expression, and inspected as a `"<job>:$…"` / `"<job>=…"`
 * operand.
 *
 * WHAT THIS DOES NOT COVER
 * ------------------------
 *   * It cannot observe branch protection FROM HERE. The tests are offline, so
 *     no assertion below can tell a verdict that gates `main` from one that gates
 *     nothing. What this block CAN do — and now does — is pin the string that
 *     setting is expressed in; see the `name:` assertion below.
 *
 *     The setting itself is NOT unreadable, which is worth recording because the
 *     opposite was assumed. `GET /repos/portava/portava.app/rules/branches/main`
 *     and `GET /repos/portava/portava.app/rulesets` are both readable by a
 *     read-only token, and on 2026-09-15 they returned, respectively, `[]` and a
 *     single ruleset — id 20680634, "bughunt-20260805 protection", enforcement
 *     `active`, `conditions.ref_name.include = ["refs/heads/bughunt-20260805"]`.
 *     That ruleset requires exactly these three contexts, and it applies to a
 *     one-off August branch rather than to `main`. `GET .../branches/main`
 *     reported `protected: false` with classic protection `enabled: false`, and
 *     the same token read `protected: true` for `bughunt-20260805`, so the
 *     `false` is a real read and not a permissions mask.
 *
 *     So as of that date the three verdicts gate NOTHING on `main`: the jobs are
 *     correct, complete and wired, and the required-check setting that would make
 *     them load-bearing points at the wrong ref. Moving it is a GitHub settings
 *     change, not a code change, and nothing in this tree can make it.
 *   * It does not re-prove the classifier behaviour for `live-db-verdict`; that
 *     is executed as a real process above.
 *   * It does not execute `ci-verdict`'s or `unwired-verdict`'s inline bash.
 *     Those bodies are inline YAML and therefore untested by construction — the
 *     same objection recorded against the live-DB classifier before it was
 *     extracted to `.github/scripts/live-db-verdict.sh`. This block asserts the
 *     wiring is complete and that the body cannot exit 0 on a non-success; it
 *     does not prove the loop's arithmetic.
 *   * It says nothing about whether the jobs a verdict names are the RIGHT jobs
 *     to run. Completeness against the workflow is not adequacy of the workflow.
 */
describe("CI architecture — each workflow's verdict covers every job in it", () => {
  /** Top-level job ids of a workflow, in file order. */
  function jobIds(src: string): string[] {
    const start = src.indexOf("\njobs:\n");
    assert.ok(start >= 0, "no top-level `jobs:` block found");
    const body = src.slice(start + "\njobs:\n".length);
    return [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]!);
  }

  /** One job's block, from its id line to the next top-level job id. */
  function jobBlock(src: string, id: string): string {
    const i = src.indexOf(`\n  ${id}:\n`);
    if (i < 0) return "";
    const rest = src.slice(i + 1);
    const end = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  }

  /** The job ids listed under the block's `needs:`. */
  function needsOf(block: string): string[] {
    const m = block.match(/needs:\n((?:\s+- .*\n)+)/);
    return m ? [...m[1]!.matchAll(/- ([A-Za-z0-9_-]+)/g)].map((x) => x[1]!) : [];
  }

  const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /**
   * `context` is the CHECK RUN NAME, which is the job's `name:` value — NOT its
   * job id. A required status check is matched by that string and by nothing
   * else, so it is the load-bearing identifier of the three, and these literals
   * are the exact contexts ruleset 20680634 names (verified byte-for-byte against
   * the REST response on 2026-09-15; the separator is U+00B7 MIDDLE DOT).
   */
  const VERDICTS = [
    {
      file: "ci.yml", src: ci, id: "ci-verdict",
      context: "CI \u00b7 verdict (skipped or cancelled is not a pass)",
    },
    {
      file: "live-db.yml", src: liveDb, id: "live-db-verdict",
      context: "live DB \u00b7 verdict (cancelled or skipped is not a pass)",
    },
    {
      file: "unwired-checks.yml", src: unwired, id: "unwired-verdict",
      context: "unwired \u00b7 verdict (skipped or cancelled is not a pass)",
    },
  ] as const;

  for (const { file, src, id, context } of VERDICTS) {
    describe(`${file} · ${id}`, () => {
      const block = jobBlock(src, id);
      const steps = block.slice(block.indexOf("steps:"));
      const needs = needsOf(block);

      it("exists under exactly that name", () => {
        assert.ok(
          block.length > 0,
          `${file} has no '${id}' job. This is one of the three verdicts the ` +
            "CI phase is defined by; without it, a failed `preflight` SKIPS the " +
            "jobs that need it, and GitHub scores a skipped required status " +
            "check as SUCCESSFUL. Renaming it also silently unbinds it from " +
            "branch protection, which matches required checks by name.",
        );
      });

      it("publishes under the exact check-run name a required check is matched by", () => {
        // THE GAP THIS CLOSES, found by mutation on 2026-09-15. Every other
        // assertion in this block keys off the JOB ID. Branch protection does
        // not: it matches a required status check against the CHECK RUN NAME,
        // which GitHub takes from the job's `name:`. The two are unrelated
        // strings here — job id `ci-verdict` publishes as
        // "CI · verdict (skipped or cancelled is not a pass)".
        //
        // So rewriting `name:` while leaving the job id alone silently unbinds
        // the job from every ruleset that requires it, and a mutation doing
        // exactly that passed all 36 assertions. The check simply disappears
        // from the branch's required set — and a required check that no longer
        // reports is not red, it is ABSENT, which is the same
        // "nothing ran, nothing is red" failure the verdict jobs exist to catch,
        // one level up.
        //
        // This is pinned to a literal rather than derived, because the whole
        // point is that the string is shared with a setting stored OUTSIDE the
        // repository. A derived assertion would follow the rename and prove
        // nothing. Changing `name:` must therefore be a deliberate two-place
        // edit: this literal, and the required-checks setting.
        assert.match(
          block, new RegExp(`^ {4}name: ${rx(context)}$`, "m"),
          `${id}'s \`name:\` is not exactly ${JSON.stringify(context)}. That string — not ` +
            `the job id '${id}' — is the context a required status check is matched by, so ` +
            "changing it unbinds the job from branch protection without turning anything " +
            "red. If the rename is intended, update the required-checks setting in the same " +
            "change and then update this literal.",
        );
      });

      it("runs even when an upstream job failed, was skipped or was cancelled", () => {
        assert.match(
          block, /if:\s*\$\{\{\s*always\(\)\s*\}\}/,
          `${id} is not \`if: always()\`. A verdict that is itself skipped when ` +
            "an upstream job dies is the one check that can never report the " +
            "outage it exists to report.",
        );
      });

      it("needs every other job the workflow defines", () => {
        const all = jobIds(src);
        assert.ok(all.includes(id), `${id} is not a top-level job of ${file}`);
        const uncovered = all.filter((j) => j !== id && !needs.includes(j));
        assert.deepEqual(
          uncovered, [],
          `${id} does not list ${JSON.stringify(uncovered)} in \`needs:\`. A job ` +
            "the verdict does not need is a job it cannot see, and a job it " +
            "cannot see is one it will report success without. Every job added " +
            "to this workflow must be added to the verdict in the same commit.",
        );
      });

      it("binds and inspects a real result for every job it needs", () => {
        assert.ok(needs.length > 0, `${id} declares no \`needs:\` at all`);
        for (const job of needs) {
          assert.match(
            steps,
            new RegExp(`needs(?:\\.${rx(job)}|\\[.${rx(job)}.\\])\\.result`),
            `${id} needs '${job}' but never reads \`needs.${job}.result\`. ` +
              "Waiting for a job is not checking it: the verdict would block on " +
              `'${job}' and then pass regardless of how it ended.`,
          );
          assert.match(
            steps, new RegExp(`"${rx(job)}[:=]`),
            `${id} binds '${job}' but never passes it to the comparison. Note ` +
              "this asserts an OPERAND, not a mention — the job name appears in " +
              "this verdict's own error prose, so a containment check would be " +
              "satisfied by a job that is merely talked about.",
          );
        }
      });

      it("cannot conclude successfully when a needed job did not succeed", () => {
        const delegates = /live-db-verdict\.sh/.test(steps);
        assert.ok(
          delegates || (/!=\s*"success"/.test(steps) && /exit 1/.test(steps)),
          `${id} neither delegates to the unit-tested classifier nor compares ` +
            "against 'success' and exits non-zero. Some upstream state must be " +
            "able to turn this job red, or it is a green light wired to nothing.",
        );
      });
    });
  }
});

/**
 * census-discovery DC-26 (§66.4, §69) — the rehearsal the "CI rehearsal" class
 * names is the `schema-drift` job's APPLY and CERTIFY steps. Until this block,
 * no assertion in this file named either step, so deleting both left the suite
 * green (§66.4: "it would not notice if they stopped being rehearsed").
 *
 * What this pins, and only this: the live-DB workflow's `schema-drift` job has a
 * step that runs `db:apply-migrations` (the real apply, not `:dry-run`) and,
 * AFTER it, a step that runs `certify:migrations`. It does NOT prove a rehearsal
 * has passed on `portava-ci` for any migration — that is an EVENT, and DC-26
 * does not move on this block.
 *
 * `P29_LIVE_DB_YML` exists so the mutation can be run against a real edited
 * copy of the workflow without touching `.github/` (census-discovery §69.8).
 */
describe("CI architecture — the schema-drift job rehearses migrations (census-discovery DC-26)", () => {
  const src = readFileSync(process.env.P29_LIVE_DB_YML ?? resolve(WF, "live-db.yml"), "utf8");

  /** The `schema-drift` job, from its id line to the next top-level job id. */
  function schemaDriftJob(text: string): string {
    const i = text.indexOf("\n  schema-drift:\n");
    if (i < 0) return "";
    const rest = text.slice(i + 1);
    const end = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  }

  /** Offsets of the apply and certify `run:` invocations inside the job, or -1. */
  function rehearsalSteps(text: string): { apply: number; certify: number } {
    const job = schemaDriftJob(text);
    const apply = job.search(/scripts db:apply-migrations(?!:dry-run)\b/);
    const certify = job.search(/@workspace\/api-server certify:migrations\b/);
    return { apply, certify };
  }

  it("has a step that applies migrations (not only the dry run)", () => {
    assert.ok(schemaDriftJob(src).length > 0, "live-db.yml has no `schema-drift` job — nothing rehearses a migration");
    assert.ok(
      rehearsalSteps(src).apply >= 0,
      "the schema-drift job no longer runs `db:apply-migrations`. That step IS the CI rehearsal `12` names " +
        "(\"rehearse on portava-ci\"); without it no migration is ever applied to the CI project.",
    );
  });

  it("certifies the apply, after it, in the same job", () => {
    const { apply, certify } = rehearsalSteps(src);
    assert.ok(certify >= 0, "the schema-drift job no longer runs `certify:migrations`: an apply nobody reads back is a claim, not a rehearsal");
    assert.ok(apply >= 0 && certify > apply, "`certify:migrations` must run AFTER `db:apply-migrations` in the schema-drift job");
  });

  it("control: the same reading rejects the workflow with either step removed", () => {
    const noApply = src.replace(/^.*scripts db:apply-migrations(?!:dry-run)\b.*$/gm, "");
    const noCertify = src.replace(/^.*certify:migrations\b.*$/gm, "");
    assert.ok(rehearsalSteps(src).apply >= 0 && rehearsalSteps(src).certify >= 0, "precondition: both steps present");
    assert.equal(rehearsalSteps(noApply).apply, -1, "removing the apply lines must be seen");
    assert.equal(rehearsalSteps(noCertify).certify, -1, "removing the certify line must be seen");
  });
});

/**
 * THE LIVE-DB COVERAGE DETECTOR — the predicate, pinned.
 *
 * WHY THIS BLOCK EXISTS
 * =====================
 * `.github/workflows/live-db-coverage.yml` answers a question no other check
 * in this repository asks: not "did the live-DB certification pass" but "does
 * a `CI (live DB)` RUN EXIST AT ALL for this pull request's head SHA". It
 * exists because a pull request with a merge conflict gets NO run created —
 * GitHub cannot build the merge ref, so the `pull_request` event never fires,
 * and `push: ['**']` was deliberately removed from that workflow on measured
 * evidence (docs/ci/README.md § "Concurrency: the shared database is a queue,
 * not a race"). `ci.yml` and `unwired-checks.yml` still run on `push` and
 * report green, so the PR reads FULLY GREEN with no live-database
 * certification and not even a grey entry for the missing one.
 *
 * Measured 2026-10-03: PR #530 (head 846f58e7…) 11 check runs all success, no
 * live-DB name present, its branch's newest live-DB run against an EARLIER
 * commit; PR #393 (head 1b78d3b6…) 10/10 success, dirty since 2026-09-05,
 * newest live-DB run on its branch against a different commit.
 *
 * The predicate lives in `.github/scripts/live-db-coverage-decide.sh` and
 * takes its listing on stdin, so it can be executed here with no network —
 * the same split, for the same reason, as live-db-slot-decide.sh above. An
 * unpinned predicate rots: this check will red `main`'s board when it fires,
 * so a false positive is expensive and the cases that must NOT be flagged are
 * asserted as hard as the cases that must.
 *
 * WHAT THIS BLOCK DOES NOT COVER, stated rather than implied:
 *   * It does not execute the fetcher. The fetcher needs the Actions API, by
 *     construction — that is why the predicate was split out of it. The
 *     listings below are TRANSCRIBED from real API responses, so they pin what
 *     the decider does with the truth, not that the fetcher reports the truth.
 *   * It says nothing about whether the grace window is the right length, or
 *     whether `commit.committer.date` is a sound clock. It is not: the field is
 *     author-controlled, which is why the fetcher prefers the earliest
 *     `created_at` among the SHA's own workflow runs and why `age_source` is on
 *     every line.
 */
describe("CI architecture — a pull request with no live-DB run at all is caught", () => {
  const DECIDER = resolve(REPO_ROOT, ".github/scripts/live-db-coverage-decide.sh");

  /** Run the decider over a listing, exactly as the fetcher pipes it in. */
  const decide = (listing: string, grace = "1800") => {
    const r = spawnSync("bash", [DECIDER], {
      input: listing,
      encoding: "utf8",
      env: { ...process.env, LIVE_DB_COVERAGE_GRACE_SECONDS: grace },
    });
    const field = (k: string) =>
      new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout ?? "")?.[1] ?? null;
    return {
      code: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      checked: field("checked"),
      covered: field("covered"),
      tooNew: field("too_new"),
      uncertified: field("uncertified"),
      unmeasurable: field("unmeasurable"),
      /** The decider's one-line verdict for a PR, e.g. "UNCERTIFIED". */
      verdictOf: (pr: number) =>
        new RegExp(`^pr=${pr} \\S+ verdict=(\\S+)`, "m").exec(r.stdout ?? "")?.[1] ?? null,
    };
  };

  /**
   * THE MEASURED LISTING, 2026-10-03T08:51:09Z, all 16 open pull requests, as
   * the fetcher would have produced it. Columns:
   *
   *   <pr> <head_sha> <age_s> <age_source> <run_state> <gate> <horizon>
   *
   * Every `run_state` here was established from the API: a branch-filtered
   * listing of `CI (live DB)` runs matched on exact `head_sha`, cross-checked
   * against the head commit's check runs. The two load-bearing ages (#530,
   * #393) are measured from the earliest `created_at` among each SHA's own
   * workflow runs. Ages on COVERED rows are not load-bearing — `run`
   * short-circuits before the window is consulted — and are left at 0, which
   * is what the fetcher emits for them rather than spending an API call on a
   * number nothing reads.
   *
   * The horizon was measured too: the oldest `CI (live DB)` run still visible
   * is run_number 1, id 31362783748, created_at 2026-08-10T06:39:09Z, of 2894
   * runs. Every open PR's head postdates it, so every row is `within` and no
   * row is excused by retention.
   */
  const MEASURED_20261003 = [
    "568 ea546d1ec2a233835693ec3c0dca15d9895bde27 0 first-ci-run run failure within",
    "567 17bbe7359bc1aaf8c723b14de533d78b75c1b7ce 0 first-ci-run run success within",
    "566 8c6a630d2f26afd58256a36d78ca4a452f8e699f 0 first-ci-run run none within",
    "565 37439026ca6aae552196319b7c699eeb027885aa 0 first-ci-run run none within",
    "564 c8b65fa7d26847a993a433fef3489f26615744db 0 first-ci-run run failure within",
    "562 f38cb2364e96fd2b89b27b59fb09de62b1cd52c7 0 first-ci-run run none within",
    "561 641d3170bcf15037996826ca5696d706fe8d9172 0 first-ci-run run none within",
    "560 a7cc849fb06636048c315a0ac94fa50e0cbc23a7 0 first-ci-run run none within",
    "549 fd0a600e19c0d4c2fbd9d549770e7de421f485d6 0 first-ci-run run success within",
    "530 846f58e7c12781d2633648354b25a5b7c98e4da7 8129 first-ci-run no-run - within",
    "521 6855e2d1daff902cb7ad6b365dab0e499ed91628 0 first-ci-run run success within",
    "393 1b78d3b6a6e570aef6c1864b7b38a3e1a8bf80b6 2405224 first-ci-run no-run - within",
    "89 42976b20acde328172b0ae68922093979a594505 0 first-ci-run run success within",
    "65 cd1f4e1bb92340823f34c2008efd43b7d5c13008 0 first-ci-run run success within",
    "54 9fa159a254859bfc586561a32d2a200ff089f916 0 first-ci-run run success within",
    "52 158e4f0f99227aab8c5f8da45407294a1bf59399 0 first-ci-run run success within",
  ].join("\n") + "\n";

  it("keeps the predicate in a script with no network, so it can be executed here", () => {
    assert.ok(
      existsSync(DECIDER),
      "live-db-coverage-decide.sh is missing. Inlining the predicate back into " +
        "assert-live-db-coverage.sh makes it untestable by construction — the " +
        "fetcher needs the Actions API.",
    );
    assert.ok(
      (statSync(DECIDER).mode & 0o111) !== 0,
      "live-db-coverage-decide.sh is not executable",
    );
  });

  it("flags EXACTLY the two pull requests measured to have no run, out of 16", () => {
    const r = decide(MEASURED_20261003);
    assert.equal(r.checked, "16");
    assert.equal(r.covered, "14");
    assert.equal(
      r.uncertified,
      "#530@846f58e7c12781d2633648354b25a5b7c98e4da7 #393@1b78d3b6a6e570aef6c1864b7b38a3e1a8bf80b6",
      "the detector must name #530 and #393 and nothing else. These are the two " +
        "SHAs with no live-DB run at all; the other fourteen have one.",
    );
    assert.equal(r.unmeasurable, "", "no open PR's head predates the visible run history");
    assert.equal(r.code, 1, "a missing certification must FAIL, not warn");
  });

  it("does NOT flag the four dirty pull requests that are fine", () => {
    // THE WHOLE REASON THIS IS NOT KEYED ON `mergeable_state`. Six open PRs
    // were dirty on 2026-10-03 — #549, #530, #521, #393, #54, #52 — and only
    // two were in the bad state. #549's live-DB verdict is FAILURE, so it is
    // visibly red; #521's and #54's are SUCCESS; #52's runs predate the trigger
    // narrowing. Keying on the conflict would flag four PRs that are fine and
    // would miss any future SHA that loses its run for some other reason.
    const r = decide(MEASURED_20261003);
    for (const pr of [549, 521, 54, 52]) {
      assert.equal(
        r.verdictOf(pr), "covered",
        `#${pr} is dirty but HAS a run for its head SHA. Flagging it would make ` +
          "this check a merge-conflict detector, which is the cause and not the symptom.",
      );
    }
  });

  it("does not flag a pull request whose run is still queued or in progress", () => {
    // Measured: #562's head f38cb2364e had `CI (live DB)` run 37110875715 in
    // state `queued`, and #560's 37109728991 was `in_progress` with its gate
    // job not yet started (gate=none). A run that exists but has not finished
    // RENDERS in the check list; absence does not. Treating "no conclusion yet"
    // as "no run" would flag every PR in its first few minutes.
    const r = decide(MEASURED_20261003);
    assert.equal(r.verdictOf(562), "covered");
    assert.equal(r.verdictOf(560), "covered");
  });

  it("does not flag a superseded SHA whose run was CANCELLED", () => {
    // Verified: run 37103666245 is `conclusion: cancelled` and its verdict job
    // 111149624241 is `failure`, so that SHA is already visibly red and a later
    // commit gets certified. 24 of the 98 runs on one branch sampled that day
    // were cancelled. Flagging this population would bury the real signal in
    // roughly a quarter of all SHAs.
    const r = decide("777 c04c7a5c44000000000000000000000000000000 7000 first-ci-run run failure within\n");
    assert.equal(r.verdictOf(777), "covered");
    assert.equal(r.code, 0, "a run that exists and failed is a DIFFERENT, already-visible problem");
  });

  it("does not flag a SHA pushed moments ago, and does flag the same SHA later", () => {
    // Run CREATION is near-instant but not synchronous with anything, and
    // GitHub delays it under load. Without the window this would flag the very
    // SHA that was just pushed — a false positive on a healthy repository,
    // which is the one failure mode that gets a check deleted.
    const fresh = "999 abcdef1234000000000000000000000000000000 120 first-ci-run no-run - within\n";
    const stale = "999 abcdef1234000000000000000000000000000000 1800 first-ci-run no-run - within\n";
    assert.equal(decide(fresh).verdictOf(999), "inside-window");
    assert.equal(decide(fresh).code, 0);
    assert.equal(decide(stale).verdictOf(999), "UNCERTIFIED");
    assert.equal(decide(stale).code, 1, "the window is a delay, not an exemption");
  });

  it("treats a SHA stamped in the future as inside the window, not as a finding", () => {
    // A negative age means the clock disagrees, or the commit was forward-dated.
    // Neither is evidence that a run is missing.
    const r = decide("999 abcdef1234000000000000000000000000000000 -45 commit-date no-run - within\n");
    assert.equal(r.verdictOf(999), "inside-window");
    assert.equal(r.code, 0);
  });

  it("reports UNMEASURABLE, separately and still red, for a SHA past the retention horizon", () => {
    // GitHub DELETES workflow runs once log retention elapses, and a SHA can
    // also predate the workflow. In either case a run may genuinely have
    // existed and certified the commit, so "no run" is not evidence. Calling
    // that UNCERTIFIED would be a false accusation against every long-lived PR,
    // arriving on a schedule, forever.
    //
    // It is NOT silently excused either: an unestablished result is not a pass
    // in this repository, so it fails — under its own name, with its own count,
    // because the remedy differs (a run, versus a human deciding whether a PR
    // that old should still be open).
    const r = decide("7 1111111111111111111111111111111111111111 99999999 commit-date no-run - before\n");
    assert.equal(r.verdictOf(7), "UNMEASURABLE");
    assert.equal(r.uncertified, "", "an unmeasurable SHA must NOT be reported as uncertified");
    assert.equal(r.unmeasurable, "#7@1111111111111111111111111111111111111111");
    assert.equal(r.code, 1, "unmeasurable is the weakest state, and it is not a pass");
  });

  it("reports UNMEASURABLE when the horizon itself could not be established", () => {
    // The fetcher sets horizon=unknown rather than exiting, so the check still
    // reports — with the weaker claim it can actually support.
    const r = decide("7 1111111111111111111111111111111111111111 99999999 commit-date no-run - unknown\n");
    assert.equal(r.verdictOf(7), "UNMEASURABLE");
    assert.equal(r.code, 1);
  });

  it("REFUSES a listing it cannot parse rather than skipping the line", () => {
    // A listing we cannot parse is not a listing that proves every PR is
    // certified. Skipping the bad line is how a parser bug becomes a green
    // check: the one row that failed to render is exactly the row most likely
    // to be the finding.
    const withGarbage =
      "530 846f58e7c12781d2633648354b25a5b7c98e4da7 8129 first-ci-run no-run - within\n" +
      "this is not a listing line\n";
    const r = decide(withGarbage);
    assert.equal(r.code, 3, "an unparseable listing must be refused, not partially trusted");
    assert.match(r.stderr, /refusing to decide from a listing that did not parse/);
  });

  it("REFUSES an unrecognised run_state instead of assuming it means covered", () => {
    const r = decide("530 846f58e7c12781d2633648354b25a5b7c98e4da7 8129 first-ci-run maybe - within\n");
    assert.equal(r.code, 3);
  });

  it("reports an empty listing as vacuous rather than clean", () => {
    // "No open pull requests" and "the fetcher handed me nothing" are the same
    // bytes here, and only the fetcher can tell them apart — it cross-checks an
    // empty pulls listing against the repository's own open-issue count before
    // this script ever sees it. So the decider says what it actually knows.
    const r = decide("");
    assert.equal(r.checked, "0");
    assert.equal(r.code, 0);
    assert.match(
      r.stderr, /NOTHING was certified and nothing was checked. This is vacuous, not clean/,
      "a zero must never be printed as if it were a pass",
    );
  });

  it("refuses a grace window that is not a number of seconds", () => {
    const r = decide(MEASURED_20261003, "soon");
    assert.equal(r.code, 64, "a misconfigured window must be a usage error, not a default");
  });

  it("control: emptying the predicate's finding cannot be mistaken for a clean run", () => {
    // The mutation this guards against is the obvious one — make every row read
    // `run` and the check goes green forever. The assertion is that the
    // MEASURED listing produces a NON-ZERO exit, so a tree in which #530 and
    // #393 are genuinely fixed will still execute this block against the
    // recorded bytes rather than against today's API.
    const allCovered = MEASURED_20261003.replace(/no-run -/g, "run success");
    assert.equal(decide(allCovered).code, 0, "precondition: a fully covered listing passes");
    assert.equal(decide(MEASURED_20261003).code, 1, "the recorded defect must still be seen");
  });
});

/**
 * The coverage workflow's own shape. Three things about it are load-bearing and
 * were each arrived at by getting them wrong first, so they are pinned.
 */
describe("CI architecture — the coverage detector is repo-wide, not per-branch", () => {
  const coverage = readFileSync(resolve(WF, "live-db-coverage.yml"), "utf8");

  it("never triggers per-branch", () => {
    // IT WAS BUILT AS A JOB IN ci.yml FIRST, AND THAT WAS WRONG. The question
    // is repo-wide — "does EVERY open PR have a run" — and ci.yml is
    // per-branch, so one stale conflicted PR would turn every branch's CI red.
    // Worse, the verdict block above requires every ci.yml job to be in
    // `ci-verdict`'s `needs:`, and ci-verdict is the context branch protection
    // is meant to require: one conflicted PR nobody is working on would then
    // block the merge of every other PR. A repo-wide question gets a repo-wide
    // trigger and reds its own board only.
    const on = triggerBlock(coverage);
    assert.ok(
      !/pull_request:/.test(on),
      "live-db-coverage.yml must not trigger on `pull_request`: it would then " +
        "report one PR's problem on another PR's check list.",
    );
    assert.ok(
      !/branches:\s*\['\*\*'\]/.test(on),
      "live-db-coverage.yml must not trigger on every branch — see above.",
    );
    assert.match(
      on, /push:\s*\n\s*branches:\s*\[main\]/,
      "a merge to main is the event that MAKES open PRs conflict, so it is the " +
        "causal trigger and must stay",
    );
    assert.match(
      on, /schedule:/,
      "the state also changes with no push at all — a run can be deleted, and a " +
        "head SHA can cross the retention horizon while the repository sits idle",
    );
  });

  it("does not collide with the other scheduled workflows", () => {
    // GitHub names the top of the hour as a high-load time and delays scheduled
    // runs under it, which is why every cron in this repository is off the hour
    // and offset from the others.
    const cron = /-\s*cron:\s*'([^']+)'/.exec(triggerBlock(coverage))?.[1] ?? "";
    assert.ok(cron.length > 0, "no cron found");
    const minute = cron.split(" ")[0];
    assert.notEqual(minute, "0", "a cron on the hour is the one GitHub delays");
    for (const taken of ["17", "47", "23"]) {
      assert.notEqual(
        minute, taken,
        `minute ${taken} is already used by live-db.yml (17 6), ` +
          "clean-build-proof.yml (47 3) or story-retention.yml (23 *)",
      );
    }
  });

  it("carries its own verdict, so a cancelled detector is not a pass", () => {
    // The `concurrency` group cancels a superseded pass, and a workflow whose
    // only job was cancelled does not read as failed in every surface. This is
    // the same job live-db.yml, ci.yml and unwired-checks.yml each carry, for
    // the same reason.
    assert.match(coverage, /^ {2}coverage-verdict:$/m, "no verdict job");
    const block = coverage.slice(coverage.indexOf("\n  coverage-verdict:\n"));
    assert.match(block, /if:\s*\$\{\{\s*always\(\)\s*\}\}/, "the verdict must be `if: always()`");
    assert.match(block, /needs:\n\s+- coverage\b/, "the verdict must need the detector");
    assert.match(block, /needs\.coverage\.result/, "the verdict must READ the detector's result");
    assert.match(block, /"coverage:\$R_COVERAGE"/, "the result must reach the comparison as an operand");
    assert.match(
      block, /!=\s*"success"/,
      "anything that is not success — skipped, cancelled, failure — must be red",
    );
  });

  it("stays credential-free and read-only", () => {
    // The condition this workflow reports is "the credentialed lane did not
    // run", so it must not be able to fail for the same reasons that lane does.
    assert.ok(
      !/secrets\./.test(coverage),
      "live-db-coverage.yml must read no repository secret — it uses github.token",
    );
    for (const scope of ["actions: read", "pull-requests: read", "contents: read"]) {
      assert.ok(coverage.includes(scope), `the permissions block must declare \`${scope}\``);
    }
    assert.ok(
      !/\b(write|write-all)\b/.test(/permissions:\n(?:\s+\S+:.*\n)+/.exec(coverage)?.[0] ?? ""),
      "no scope here may be writable",
    );
  });
});

/**
 * CI architecture — the two strings the coverage detector identifies its
 * target by, pinned the way the three verdict contexts above are pinned.
 *
 * WHY. `.github/scripts/assert-live-db-coverage.sh` asks its question about one
 * named workflow and one named job, and it finds them BY THOSE NAMES:
 *
 *   WORKFLOW_NAME   = 'CI (live DB)'
 *   GATE_JOB_PREFIX = 'api-server · check:all + live_pulse gate'
 *
 * Neither is derived, and neither can be: they are the published identities —
 * what appears in a pull request's check list and what a required status check
 * is matched against — and a derived assertion would simply follow a rename and
 * prove nothing. Exactly the reasoning in the VERDICTS block above.
 *
 * The two halves fail DIFFERENTLY if a rename is not mirrored here, and that
 * asymmetry is the reason this block exists:
 *
 *   * WORKFLOW_NAME is fail-closed. An unresolvable name exits 1 with "could
 *     not resolve the workflow id", verified by fixture in
 *     src/test/liveDbCoverageFetcher.test.ts. Loud.
 *
 *   * GATE_JOB_PREFIX is NOT. The lookup is `select(.name | startswith(...))`
 *     and a miss is normalised to `gate=unknown` — a legitimate state for a run
 *     whose gate job was skipped out of the job list, so it cannot be made
 *     fatal without flagging PRs that are fine. A rename therefore degrades the
 *     (b) half of the question to `unknown` for EVERY pull request, silently,
 *     while the check stays green. That is the shape of defect this whole lane
 *     is about, so the rename is caught here instead.
 *
 * Both separators are U+00B7 MIDDLE DOT, written as an escape so a copy-paste
 * through a lossy editor cannot substitute a hyphen or an ASCII dot and leave
 * the file looking right.
 */
describe("CI architecture — the live-DB coverage detector's target names are pinned", () => {
  const FETCHER_PATH = resolve(REPO_ROOT, ".github/scripts/assert-live-db-coverage.sh");
  const fetcher = existsSync(FETCHER_PATH) ? readFileSync(FETCHER_PATH, "utf8") : "";

  /** `name:` of live-db.yml — the workflow whose absence is being detected. */
  const WORKFLOW_NAME = "CI (live DB)";
  /** The leading segment of the gate job's `name:`; the published name adds
   *  " (needs credentials)", which is prose rather than identity. */
  const GATE_JOB_PREFIX = "api-server · check:all + live_pulse gate";

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("the detector exists (nothing below means anything if it does not)", () => {
    assert.ok(
      fetcher.length > 0,
      `${FETCHER_PATH} is missing. The live-DB coverage detector is the only thing that ` +
        "observes a pull request whose head SHA got no `CI (live DB)` run at all — an " +
        "absence that renders as nothing in the check list, not as a grey or red entry.",
    );
  });

  it("WORKFLOW_NAME is the literal 'CI (live DB)'", () => {
    assert.match(
      fetcher, new RegExp(`^WORKFLOW_NAME='${esc(WORKFLOW_NAME)}'$`, "m"),
      `assert-live-db-coverage.sh no longer sets WORKFLOW_NAME to exactly ` +
        `${JSON.stringify(WORKFLOW_NAME)}. That string is how the detector finds the workflow ` +
        "whose runs it counts; it is resolved through the Actions API by `name:`, not by " +
        "filename or numeric id. If the workflow was renamed, change it in live-db.yml, in " +
        "this script, in the required-status-check settings and in this literal — all four, in " +
        "one change.",
    );
  });

  it("WORKFLOW_NAME is live-db.yml's actual `name:` — the two cannot drift apart", () => {
    assert.match(
      liveDb, new RegExp(`^name: ${esc(WORKFLOW_NAME)}$`, "m"),
      `live-db.yml's \`name:\` is not exactly ${JSON.stringify(WORKFLOW_NAME)}, so the ` +
        "coverage detector is looking for a workflow that no longer exists under that name. " +
        "Its lookup fails closed, so this is a red build rather than a false green — but it " +
        "reds on every run until both sides are changed together.",
    );
  });

  it("GATE_JOB_PREFIX is the literal 'api-server · check:all + live_pulse gate'", () => {
    assert.match(
      fetcher, new RegExp(`^GATE_JOB_PREFIX='${esc(GATE_JOB_PREFIX)}'$`, "m"),
      `assert-live-db-coverage.sh no longer sets GATE_JOB_PREFIX to exactly ` +
        `${JSON.stringify(GATE_JOB_PREFIX)}. Unlike WORKFLOW_NAME this one does NOT fail ` +
        "closed: a prefix that matches no job is normalised to `gate=unknown`, which is also " +
        "the legitimate reading for a run whose gate job was skipped out of its job list. So a " +
        "stale prefix reports `unknown` for every pull request while the check stays green — " +
        "the (b) half of the question answered by nothing at all.",
    );
  });

  it("GATE_JOB_PREFIX actually prefixes the job name live-db.yml declares", () => {
    const m = /^ {4}name: (api-server · check:all.*)$/m.exec(liveDb);
    assert.ok(
      m,
      "live-db.yml declares no job whose `name:` begins 'api-server · check:all'. That job is " +
        "the live-database certification itself; GATE_JOB_PREFIX in " +
        ".github/scripts/assert-live-db-coverage.sh is matched against it with " +
        "`startswith()`, and a prefix matching nothing degrades to `gate=unknown` without " +
        "failing. Re-derive both.",
    );
    assert.ok(
      m[1].startsWith(GATE_JOB_PREFIX),
      `the gate job publishes as ${JSON.stringify(m[1])}, which does not start with ` +
        `${JSON.stringify(GATE_JOB_PREFIX)}. \`startswith()\` therefore matches nothing and ` +
        "the detector's (b) half silently reports `unknown` for every pull request. Update the " +
        "prefix in assert-live-db-coverage.sh and this literal together.",
    );
  });

  it("both separators are U+00B7 MIDDLE DOT, in the script and in the workflow", () => {
    // Pinned explicitly because the three characters are visually
    // indistinguishable at a glance and two of them break the match silently.
    for (const [what, text] of [
      ["GATE_JOB_PREFIX in assert-live-db-coverage.sh", /^GATE_JOB_PREFIX='api-server (.) check:all/m.exec(fetcher)?.[1]],
      ["the gate job's `name:` in live-db.yml", /^ {4}name: api-server (.) check:all/m.exec(liveDb)?.[1]],
    ] as const) {
      assert.equal(
        text, "·",
        `${what} does not use U+00B7 MIDDLE DOT as its separator (got ` +
          `${text === undefined ? "no match at all" : `U+${text.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`}). ` +
          "U+00B7, U+2022 BULLET and a plain ASCII '.' all look alike here, and the job name " +
          "is matched as a byte string.",
      );
    }
  });
});
