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
 * Four properties hold that up, and each is asserted below:
 *   1. One certification per SHA — no duplicate push+PR execution.
 *   2. Concurrency is keyed per PR, so only an obsolete run of the SAME PR can
 *      be superseded.
 *   3. Mutual exclusion on the shared database is a WAIT, not a cancellation.
 *   4. Cancelled / skipped / starved is reported as NOT EXECUTED, never as pass.
 *
 * WHAT THIS CANNOT CHECK
 * ----------------------
 * This is a YAML contract test. It cannot prove GitHub's scheduler behaves as
 * documented, cannot prove the queue script acquires the slot correctly under
 * real contention, and cannot observe branch protection. Those need
 * GitHub-hosted certification; see docs/ci/README.md. What it does prove is
 * that the repository never silently reverts to the shape that caused the
 * starvation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
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
