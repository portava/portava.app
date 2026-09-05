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
    /** Long enough that at least one poll is logged before the deadline; the
     *  loop checks the clock BEFORE polling, so a 1s budget can expire on the
     *  first iteration and print no `holder=` line at all. */
    timeoutSeconds?: number;
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "portava-slot-"));
    writeFileSync(join(dir, "listing.txt"), opts.listing ?? "");
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
