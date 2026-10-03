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
    /** Make the first N listing calls answer the way a rate-limited
     *  `gh api --jq` actually answers: the REST error body on STDOUT, exit 1.
     *  Measured on run 37113934334 job 111186609364, 2026-10-03. */
    apiRefusals?: number;
    /** Ceiling for the refusal backoff, so a test does not really sleep for
     *  the production default. */
    pollMaxSeconds?: number;
    /** Serve the fixture listing for BOTH status queries, reproducing a run
     *  that moved queued -> in_progress between the two calls. */
    bothStatuses?: boolean;
    /** Refuse with NOTHING on stdout and this one line on stderr, which is how
     *  `gh api --jq` answers an HTTP error it could not parse a body out of:
     *  the filter never runs, so stdout is empty and the only account of the
     *  cause is the summary line. Run 37122355417 refused twelve times and the
     *  script printed `exit 1` twelve times, because it was reading the stream
     *  that was empty and discarding the one that was not. */
    refusalStderr?: string;
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
    const calls = JSON.stringify(join(dir, "listing-calls"));
    const asked = JSON.stringify(join(dir, "asked-urls"));
    writeFileSync(
      join(dir, "gh"),
      "#!/usr/bin/env bash\n" +
        `printf '%s\\n' "$*" >> ${asked}\n` +
        // `gh api .../actions/workflows/<id>/runs...` -> the listing.
        // The script asks per status, so the stub answers per status: the
        // fixture listing stands in for the in-progress runs, and `queued`
        // comes back empty, as it would for a queue of running jobs.
        'if [[ "$*" == *"status=queued"* ]]; then\n' +
        (opts.bothStatuses ? `  cat ${JSON.stringify(join(dir, "listing.txt"))}\n` : "") +
        "  exit 0\n" +
        "fi\n" +
        'if [[ "$*" == *"/actions/workflows/"* ]]; then\n' +
        `  n=$(cat ${calls} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${calls}\n` +
        `  if [ "$n" -le ${opts.apiRefusals ?? 0} ]; then\n` +
        // Two real shapes, both exiting non-zero and neither saying the
        // database is free: an error object on stdout, or an empty stdout with
        // one summary line on stderr.
        (opts.refusalStderr
          ? `    printf '%s\\n' ${JSON.stringify(opts.refusalStderr)} >&2\n`
          : "    cat <<'J'\n" +
            "{\n" +
            '"message": "API rate limit exceeded for installation ID 1.",\n' +
            '"documentation_url": "https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#rate-limiting",\n' +
            '"status": "403"\n' +
            "}\n" +
            "J\n") +
        "    exit 1\n" +
        "  fi\n" +
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
        LIVE_DB_SLOT_POLL_MAX_SECONDS: String(opts.pollMaxSeconds ?? 2),
      },
    });
    let emitted = "";
    try {
      emitted = readFileSync(join(dir, "out"), "utf8");
    } catch {
      emitted = "";
    }
    let askedUrls: string[] = [];
    try {
      askedUrls = readFileSync(join(dir, "asked-urls"), "utf8").split("\n").filter(Boolean);
    } catch {
      askedUrls = [];
    }
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, emitted, askedUrls };
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

  /**
   * Measured 2026-10-03 on run 37113934334 job 111186609364. Its last 340
   * seconds were spent re-asking a rate-limited API every 20s, and the job's
   * final error told the reader to re-run because "the attempt starts at the
   * BACK of the queue" — a cause it had no evidence for. Three sessions spent
   * a morning on queue arithmetic because of that sentence. The refusal has to
   * name itself.
   */
  /**
   * The request budget, which is the resource that actually ran out on
   * 2026-10-03. The listing used to `--paginate` the workflow's whole run
   * history and filter client-side: `--jq` filters each page without stopping
   * the walk, so one poll cost ceil(2919/100) = 30 requests, every 20s, from
   * every waiting lane, against a per-REPOSITORY budget. No amount of backoff
   * fixes that, because the budget is gone before the first 403 arrives.
   */
  it("asks the API to filter by status instead of walking the whole run history", () => {
    const r = runSlotScript({
      role: "verify",
      runId: "33967153487",
      listing: "2026-09-05T12:49:56Z 33967153487\n",
    });
    assert.equal(r.code, 0, `the oldest active run must still be let through. Got ${r.code}:\n${r.out}`);

    const listings = r.askedUrls.filter((u) => u.includes("/actions/workflows/"));
    assert.ok(listings.length > 0, "the script asked for no run listing at all");
    for (const url of listings) {
      assert.match(
        url, /[?&]status=(in_progress|queued)\b/,
        `an unfiltered run listing paginates the entire workflow history (2919 runs = 30 requests ` +
          `per poll). Ask the API to filter: ${url}`,
      );
    }
    // Both statuses, or the queue is only half visible.
    assert.ok(
      listings.some((u) => u.includes("status=in_progress")) && listings.some((u) => u.includes("status=queued")),
      `both in_progress and queued must be asked for, got: ${JSON.stringify(listings)}`,
    );

    // Two calls are not one atomic snapshot, and the order decides whether a
    // run can fall through the gap between them. Runs only move queued ->
    // in_progress, so `queued` must be asked FIRST: a run queued at the first
    // call is seen there, one already running is seen by the second. Reversed,
    // a run that starts between the calls is listed by NEITHER — and a missed
    // run is how this script concludes a held database is free.
    const firstQueued = listings.findIndex((u) => u.includes("status=queued"));
    const firstRunning = listings.findIndex((u) => u.includes("status=in_progress"));
    assert.ok(
      firstQueued < firstRunning,
      `queued must be asked before in_progress, or a run starting mid-poll is listed by neither: ` +
        `${JSON.stringify(listings)}`,
    );
  });

  it("de-duplicates a run that the two status calls both returned", () => {
    // The price of the safe order: a run that starts between the calls appears
    // twice. It cannot make the slot look free — the oldest is still the
    // oldest — but it inflates `active=`, and humans read that number when
    // deciding whether to push another branch.
    const r = runSlotScript({
      role: "queue",
      runId: "37113934334",
      // The stub serves this listing for BOTH statuses, so every run is
      // returned twice, exactly as a mid-poll transition would.
      listing: "2026-10-03T09:42:05Z 37113934334\n2026-10-03T09:18:27Z 37112598597\n",
      bothStatuses: true,
      timeoutSeconds: 2,
    });
    assert.match(
      r.out, /holder=37112598597, 2 active/,
      `two distinct runs must count as 2 active, not 4. Got:\n${r.out}`,
    );
  });

  it("EXECUTES fail-closed on a refused API, and names the 403 instead of blaming the queue", () => {
    const r = runSlotScript({
      role: "verify",
      runId: "37113934334",
      listing: "2026-10-03T09:42:05Z 37113934334\n",
      apiRefusals: 99,
      timeoutSeconds: 3,
    });
    assert.equal(r.code, 75, `a job that never got a listing must exit 75. Got ${r.code}:\n${r.out}`);
    assert.match(
      r.out, /REFUSED the run listing \(HTTP 403, rate limit\)/,
      "the poll must say the API refused it, and say why",
    );
    assert.match(r.out, /refused ALL/, "the final error must attribute the failure to the API, not to a queue");
    assert.doesNotMatch(
      r.out, /BACK of the queue/,
      "a job that never saw a listing must not advise a re-run as though it had been queued",
    );
    assert.doesNotMatch(r.out, /holder=/, "it cannot name a holder it never learned");
    assert.match(
      r.emitted, /live_db_slot_api_refusals=\d+\/\d+/,
      "the refusal count must reach the telemetry, or the next reader is back to reading a 600-line log",
    );
  });

  it("quotes gh's own account of a refusal, rather than reporting a bare exit code", () => {
    // The first version of this fix named the right CATEGORY and not the cause.
    // Run 37122355417 waited 2700s and printed `(exit 1)` on all twelve polls:
    // stdout was empty, so the body-detector never fired, and the one line that
    // said what had happened went to a stream the script dropped. A number is
    // not a diagnosis — whoever reads the next timeout needs the reason.
    const r = runSlotScript({
      role: "verify",
      runId: "37122355417",
      listing: "2026-10-03T12:17:54Z 37122355417\n",
      apiRefusals: 99,
      refusalStderr: "gh: Resource not accessible by integration (HTTP 403)",
      timeoutSeconds: 3,
    });
    assert.equal(r.code, 75, `a job that never got a listing must exit 75. Got ${r.code}:\n${r.out}`);
    assert.match(
      r.out, /Resource not accessible by integration \(HTTP 403\)/,
      `the refusal must carry gh's own words. Got:\n${r.out}`,
    );
    assert.doesNotMatch(
      r.out, /REFUSED the run listing \(exit 1\) —? ?this says/,
      "a bare exit code is what sent the last reader back to the logs with nothing",
    );
    assert.match(r.out, /refused ALL/, "the final error must still blame the API, not a queue");
  });

  it("classifies a rate limit it can only see on stderr", () => {
    // The rate-limit body carries no `status` key, and with `--jq` it may not
    // reach stdout at all. A detector that reads one stream and one key calls
    // the commonest refusal "exit 1" — which is what run 37122355417 printed
    // twelve times while the cause sat one redirect away.
    const r = runSlotScript({
      role: "verify",
      runId: "37122355417",
      listing: "2026-10-03T12:17:54Z 37122355417\n",
      apiRefusals: 99,
      refusalStderr: "gh: API rate limit exceeded for installation ID 1. (HTTP 403)",
      timeoutSeconds: 3,
    });
    assert.equal(r.code, 75, `must still fail closed. Got ${r.code}:\n${r.out}`);
    assert.match(
      r.out, /REFUSED the run listing \(HTTP 403, rate limit/,
      `a rate limit visible only on stderr must still be named one. Got:\n${r.out}`,
    );
  });

  it("declares every slot diagnostic the script emits as a job output", () => {
    // A value written to $GITHUB_OUTPUT that the job does not declare goes
    // nowhere. The script learned to emit the refusal count, the holders and
    // the undecided-poll count, and for one run it emitted all three into a
    // void: run 37122355417's telemetry recorded a 2700s wait and said nothing
    // about why, because `live-db-slot` declared only slot/waited/attempt. The
    // reason sat in a 600-line log instead of the artifact built to carry it.
    const script = readFileSync(resolve(REPO_ROOT, ".github/scripts/live-db-acquire-slot.sh"), "utf8");
    const emitted = [...script.matchAll(/emit "(live_db_slot[a-z_]*)=/g)].map((m) => m[1]);
    assert.ok(emitted.length >= 6, `expected the script to emit several slot facts, found ${emitted.length}`);

    const jobStart = liveDb.indexOf("\n  live-db-slot:\n");
    assert.ok(jobStart !== -1, "live-db.yml no longer defines a live-db-slot job");
    const outStart = liveDb.indexOf("\n    outputs:\n", jobStart);
    const outEnd = liveDb.indexOf("\n    steps:\n", jobStart);
    assert.ok(
      outStart !== -1 && outEnd !== -1 && outStart < outEnd,
      "live-db-slot has no outputs: block before its steps:",
    );
    const outputs = liveDb.slice(outStart, outEnd);

    const undeclared = [...new Set(emitted)].filter((k) => !outputs.includes(k));
    assert.deepEqual(
      undeclared, [],
      `live-db-slot emits ${undeclared.join(", ")} but does not declare them as job outputs, ` +
        "so nothing downstream — the telemetry artifact, the step summary, the verdict — can read them",
    );
  });

  it("backs off while the API refuses, rather than polling it at a fixed interval", () => {
    // A fixed interval under a rate limit is self-defeating: every waiting lane
    // keeps spending the budget that none of them can get an answer without.
    //
    // The budget is deliberately far larger than the three waits measured here.
    // At 5s it was not: each poll spends real time spawning two `gh` calls, so
    // the remaining budget fell under the ceiling by the third poll and the
    // clamp — correct behaviour, pinned by its own test below — rewrote the
    // very numbers this test reads. That made a timing-sensitive test out of a
    // question about growth. 12s leaves seconds of slack, so a failure here
    // means the backoff stopped growing.
    const r = runSlotScript({
      role: "verify",
      runId: "37113934334",
      listing: "2026-10-03T09:42:05Z 37113934334\n",
      apiRefusals: 99,
      timeoutSeconds: 12,
      pollMaxSeconds: 2,
    });
    const waits = [...r.out.matchAll(/Backing off (\d+)s/g)].map((m) => Number(m[1]));
    assert.ok(waits.length >= 3, `expected several refused polls, saw ${waits.length}:\n${r.out}`);
    assert.deepEqual(
      waits.slice(0, 3), [1, 2, 2],
      `the interval must grow and then hold at the ceiling, got ${JSON.stringify(waits)}`,
    );
  });

  it("never backs off past the budget it promised to wait", () => {
    // The deadline is only checked at the top of the loop, so an unclamped
    // backoff reports a wait longer than the stated one — in a job whose
    // purpose is to report that number honestly.
    const r = runSlotScript({
      role: "verify",
      runId: "37113934334",
      listing: "2026-10-03T09:42:05Z 37113934334\n",
      apiRefusals: 99,
      timeoutSeconds: 5,
      pollMaxSeconds: 60,
    });
    const waits = [...r.out.matchAll(/Backing off (\d+)s/g)].map((m) => Number(m[1]));
    const slept = waits.reduce((a, b) => a + b, 0);
    assert.ok(
      slept <= 5,
      `the backoff slept ${slept}s against a 5s budget (${JSON.stringify(waits)}), so the ceiling ` +
        "is not clamped to the time remaining",
    );
    assert.ok(waits.every((w) => w <= 5), `no single sleep may exceed the budget: ${JSON.stringify(waits)}`);
  });

  /**
   * Measured 2026-10-03 on run 37117788717 (#564): 135 polls over 2710s, every
   * one of them `the run listing is empty`, no 403 body anywhere, no holder
   * ever named, and `Actions: read` present in the token's permissions. A
   * listing that omits the asking run cannot be true while that run is in
   * progress — and the error still called it a queue backlog and advised a
   * re-run.
   */
  it("says so when no poll ever named a holder, instead of calling it a backlog", () => {
    const r = runSlotScript({
      role: "queue",
      runId: "37117788717",
      listing: "",
      timeoutSeconds: 3,
    });
    assert.equal(r.code, 75, `still fail-closed. Got ${r.code}:\n${r.out}`);
    assert.match(
      r.out, /NOT ONE named a holder/,
      "the error must say the job never established a queue position",
    );
    assert.match(
      r.out, /NOT a queue backlog/,
      "it must not advise re-running when a drained queue would change nothing",
    );
    assert.doesNotMatch(
      r.out, /re-run it when the queue drains/,
      "that is the one piece of advice this failure cannot support",
    );
    assert.match(
      r.emitted, /live_db_slot_undecided=[1-9]/,
      "the undecidable-poll count must reach the telemetry",
    );
  });

  it("does not blame the API when the API answered and the queue was the wait", () => {
    // The mixed case, which is what both measured runs actually were: real
    // queue wait behind a named holder, and a refusal only at the end.
    const r = runSlotScript({
      role: "queue",
      runId: "37113934334",
      listing: "2026-10-03T09:42:05Z 37113934334\n2026-10-03T09:18:27Z 37112598597\n",
      apiRefusals: 1,
      timeoutSeconds: 4,
    });
    assert.equal(r.code, 75, `still fail-closed. Got ${r.code}:\n${r.out}`);
    assert.match(r.out, /holder=37112598597/, "once the API answered, the holder must be named");
    assert.doesNotMatch(
      r.out, /refused ALL/,
      "a run that did get an answer was queued, and saying otherwise is the same error in reverse",
    );
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
