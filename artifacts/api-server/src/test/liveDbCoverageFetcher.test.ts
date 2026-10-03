/**
 * liveDbCoverageFetcher.test.ts — pins the FETCHER half of the live-DB
 * coverage detector (`.github/scripts/assert-live-db-coverage.sh`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The detector is split fetcher/decider, the same shape as
 * live-db-acquire-slot.sh + live-db-slot-decide.sh: only the fetcher needs the
 * network, and the decider is a pure predicate on stdin. The decider is pinned
 * in ciWorkflowArchitecture.test.ts.
 *
 * The fetcher was NOT pinned when it was written, and that was the wrong half
 * to leave uncovered. Both bugs found while building it were in the fetcher,
 * both in the direction that makes the check report green, and NEITHER was
 * findable by reading the script:
 *
 *   1. The per-SHA jq program did not compile. Written as a double-quoted
 *      shell string with escaped `\"\"` jq defaults, jq rejected it
 *      ("syntax error, unexpected INVALID_CHARACTER"). The call carries
 *      `2>/dev/null`, so in production the error would have been swallowed and
 *      the answer read as the empty string — i.e. as "no `CI (live DB)` run
 *      exists", for EVERY pull request. A false positive on all of them.
 *
 *   2. The two fields were split with `awk '{print $1}'`. The program returns
 *      "<run id> <first seen>" and the run id is EMPTY exactly when no live-DB
 *      run exists — the case the whole check is about. awk collapses leading
 *      whitespace, so for " 2026-10-03T06:35:40Z" it returns the TIMESTAMP as
 *      the run id: a MISSING run read as a PRESENT one. The single most
 *      important answer this check gives, silently inverted.
 *
 * Both are regressions here (see "regression:" in the test names below).
 *
 * HOW IT IS TESTED WITHOUT A NETWORK
 * ----------------------------------
 * A stub `gh` is written to a temp dir and put first on PATH, serving fixture
 * JSON through the REAL jq. The script therefore runs completely unmodified and
 * its OWN jq filters, field splitting, date arithmetic and horizon comparison
 * are what execute. A stub that returned pre-parsed values would test nothing:
 * both bugs above were in the parsing.
 *
 * The fixtures are transcribed from this repository's real API responses as
 * read on 2026-10-03 — the 16 open pull requests, the oldest visible
 * `CI (live DB)` run (id 31362783748, run_number 1, created_at
 * 2026-08-10T06:39:09Z, of 2894 runs), and the per-SHA run listings that make
 * #530 and #393 the two uncertified ones. Only shape-relevant keys are kept;
 * everything asserted here was observed, not invented.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FETCHER = resolve(REPO_ROOT, ".github/scripts/assert-live-db-coverage.sh");

/** The live-DB workflow's real numeric id in this repository. */
const LIVE_DB_WF_ID = 330887793;
/** Some other workflow's id — `ci.yml`. A run of THIS does not certify anything. */
const CI_WF_ID = 111111111;
/** The oldest `CI (live DB)` run still visible on 2026-10-03, and the total. */
const HORIZON_CREATED_AT = "2026-08-10T06:39:09Z";
const HORIZON_RUN_ID = 31362783748;
const HORIZON_TOTAL = 2894;

/**
 * The 16 open pull requests, as read on 2026-10-03.
 *   firstSeen — the earliest `created_at` across that SHA's workflow runs, the
 *               server-generated "when CI first saw this commit".
 *   gate      — the `api-server · check:all + live_pulse gate` job's
 *               conclusion, or null for a job that has not concluded.
 *   liveDb    — false for the two SHAs with NO `CI (live DB)` run at all.
 */
const PRS: { pr: number; sha: string; firstSeen: string; gate: string | null; liveDb: boolean }[] = [
  { pr: 568, sha: "ea546d1ec2a233835693ec3c0dca15d9895bde27", firstSeen: "2026-10-03T08:21:06Z", gate: "failure", liveDb: true },
  { pr: 567, sha: "17bbe7359bc1aaf8c723b14de533d78b75c1b7ce", firstSeen: "2026-10-03T06:41:10Z", gate: "success", liveDb: true },
  { pr: 566, sha: "8c6a630d2f26afd58256a36d78ca4a452f8e699f", firstSeen: "2026-10-03T08:23:57Z", gate: null, liveDb: true },
  { pr: 565, sha: "37439026ca6aae552196319b7c699eeb027885aa", firstSeen: "2026-10-03T08:32:49Z", gate: null, liveDb: true },
  { pr: 564, sha: "c8b65fa7d26847a993a433fef3489f26615744db", firstSeen: "2026-10-03T06:16:55Z", gate: "failure", liveDb: true },
  { pr: 562, sha: "f38cb2364e96fd2b89b27b59fb09de62b1cd52c7", firstSeen: "2026-10-03T08:47:30Z", gate: null, liveDb: true },
  { pr: 561, sha: "641d3170bcf15037996826ca5696d706fe8d9172", firstSeen: "2026-10-03T08:39:53Z", gate: null, liveDb: true },
  { pr: 560, sha: "a7cc849fb06636048c315a0ac94fa50e0cbc23a7", firstSeen: "2026-10-03T08:27:19Z", gate: null, liveDb: true },
  { pr: 549, sha: "fd0a600e19c0d4c2fbd9d549770e7de421f485d6", firstSeen: "2026-09-30T16:59:08Z", gate: "success", liveDb: true },
  // The measured defect, case 1. Its branch HAS a recent live-DB run — against
  // an EARLIER commit — which is why (a) selects on this exact head SHA.
  { pr: 530, sha: "846f58e7c12781d2633648354b25a5b7c98e4da7", firstSeen: "2026-10-03T06:35:40Z", gate: null, liveDb: false },
  { pr: 521, sha: "6855e2d1daff902cb7ad6b365dab0e499ed91628", firstSeen: "2026-09-28T05:17:51Z", gate: "success", liveDb: true },
  // The measured defect, case 2. Dirty since 2026-09-05.
  { pr: 393, sha: "1b78d3b6a6e570aef6c1864b7b38a3e1a8bf80b6", firstSeen: "2026-09-05T12:44:05Z", gate: null, liveDb: false },
  { pr: 89, sha: "42976b20acde328172b0ae68922093979a594505", firstSeen: "2026-08-15T22:19:55Z", gate: "success", liveDb: true },
  { pr: 65, sha: "cd1f4e1bb92340823f34c2008efd43b7d5c13008", firstSeen: "2026-08-15T11:25:20Z", gate: "success", liveDb: true },
  { pr: 54, sha: "9fa159a254859bfc586561a32d2a200ff089f916", firstSeen: "2026-08-15T05:47:51Z", gate: "success", liveDb: true },
  { pr: 52, sha: "158e4f0f99227aab8c5f8da45407294a1bf59399", firstSeen: "2026-08-15T04:57:31Z", gate: "success", liveDb: true },
];

/** The job list of a live-DB run. The U+00B7 separators are the published ones. */
const jobsFor = (gate: string | null) =>
  JSON.stringify({
    total_count: 2,
    jobs: [
      { id: 1, name: "preflight \u00b7 every CI-invoked package script exists", conclusion: "success" },
      { id: 2, name: "api-server \u00b7 check:all + live_pulse gate (needs credentials)", conclusion: gate },
    ],
  });

/** `gh api` stand-in. Routes on the URL and pipes the fixture through real jq. */
const GH_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'FIX="${GH_FIXTURE_DIR:?}"',
  'URL=""; FILTER=""',
  "shift   # the literal \"api\"",
  "while [ $# -gt 0 ]; do",
  '  case "$1" in',
  "    -H) shift 2; continue ;;",
  "    --paginate) shift; continue ;;",
  '    --jq) FILTER="$2"; shift 2; continue ;;',
  "    -*) shift; continue ;;",
  '    *) URL="$1"; shift; continue ;;',
  "  esac",
  "done",
  "pick() {",
  '  case "$URL" in',
  '    */actions/workflows\\?*)                           echo "$FIX/workflows.json" ;;',
  '    */actions/workflows/*/runs\\?per_page=1\\&page=*)    echo "$FIX/wf_runs_oldest.json" ;;',
  '    */actions/workflows/*/runs\\?per_page=1)            echo "$FIX/wf_runs_total.json" ;;',
  '    */pulls\\?*)                                       echo "$FIX/pulls.json" ;;',
  '    */actions/runs\\?head_sha=*)  S="${URL#*head_sha=}"; echo "$FIX/runs_${S%%&*}.json" ;;',
  '    */actions/runs/*/jobs\\?*)    R="${URL#*/actions/runs/}"; echo "$FIX/jobs_${R%%/*}.json" ;;',
  '    */commits/*)                                      echo "$FIX/commit_${URL##*/commits/}.json" ;;',
  '    repos/*/*)                                        echo "$FIX/repo.json" ;;',
  '    *)                                                echo "" ;;',
  "  esac",
  "}",
  'F="$(pick)"',
  // A fixture deliberately removed means "the endpoint did not answer": the
  // stub exits non-zero and writes nothing to stdout, which is the shape the
  // script must treat as a failure rather than as "no run exists".
  'if [ -z "$F" ] || [ ! -f "$F" ]; then',
  '  echo "gh(stub): no fixture for \'$URL\'" >&2',
  "  exit 1",
  "fi",
  'if [ -n "$FILTER" ]; then exec jq -r "$FILTER" "$F"; fi',
  'exec cat "$F"',
].join("\n");

type Overrides = Record<string, string | null>;

/** Build a fixture directory, then apply `overrides` (null = delete the file). */
function makeFixtures(overrides: Overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "portava-live-db-coverage-"));
  const fix = join(dir, "fix");
  const bin = join(dir, "bin");
  mkdirSync(fix);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB, { mode: 0o755 });

  const put = (name: string, body: string) => writeFileSync(join(fix, name), body);

  put(
    "workflows.json",
    JSON.stringify({
      total_count: 3,
      workflows: [
        { id: CI_WF_ID, name: "CI" },
        { id: LIVE_DB_WF_ID, name: "CI (live DB)" },
        { id: 222, name: "Unwired checks (probation)" },
      ],
    }),
  );
  put("wf_runs_total.json", JSON.stringify({ total_count: HORIZON_TOTAL, workflow_runs: [{ id: 37111793630 }] }));
  put(
    "wf_runs_oldest.json",
    JSON.stringify({
      total_count: HORIZON_TOTAL,
      workflow_runs: [{ id: HORIZON_RUN_ID, run_number: 1, created_at: HORIZON_CREATED_AT }],
    }),
  );
  put("repo.json", JSON.stringify({ open_issues_count: 17 }));
  put("pulls.json", JSON.stringify(PRS.map((p) => ({ number: p.pr, head: { sha: p.sha } }))));

  for (const p of PRS) {
    const runs: Record<string, unknown>[] = [
      { id: 700000 + p.pr, workflow_id: CI_WF_ID, created_at: p.firstSeen },
    ];
    if (p.liveDb) runs.push({ id: 900000 + p.pr, workflow_id: LIVE_DB_WF_ID, created_at: p.firstSeen });
    put(`runs_${p.sha}.json`, JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
    put(`jobs_${900000 + p.pr}.json`, jobsFor(p.gate));
    put(`commit_${p.sha}.json`, JSON.stringify({ sha: p.sha, commit: { committer: { date: p.firstSeen } } }));
  }

  for (const [name, body] of Object.entries(overrides)) {
    if (body === null) rmSync(join(fix, name), { force: true });
    else put(name, body);
  }
  return { dir, fix, bin };
}

/** Run the real fetcher against a fixture directory. */
function runFetcher(overrides: Overrides = {}, grace = "1800") {
  const { dir, fix, bin } = makeFixtures(overrides);
  const summary = join(dir, "step-summary.md");
  writeFileSync(summary, "");
  const r = spawnSync("bash", [FETCHER], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GH_FIXTURE_DIR: fix,
      // Not a credential: the stub never makes a request. The script requires
      // the variable to be non-empty, which is the thing being satisfied.
      GH_TOKEN: "stub-not-a-credential",
      GITHUB_REPOSITORY: "portava/portava.app",
      GITHUB_STEP_SUMMARY: summary,
      LIVE_DB_COVERAGE_GRACE_SECONDS: grace,
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const stepSummary = existsSync(summary) ? readFileSync(summary, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  const field = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout ?? "")?.[1] ?? null;
  return {
    code: r.status,
    out,
    stepSummary,
    checked: field("checked"),
    covered: field("covered"),
    tooNew: field("too_new"),
    uncertified: field("uncertified"),
    unmeasurable: field("unmeasurable"),
    /** The decider's per-PR verdict line, as the fetcher echoed it. */
    lineOf: (pr: number) => new RegExp(`^pr=${pr} .*$`, "m").exec(r.stdout ?? "")?.[0] ?? null,
  };
}

/** A `runs?head_sha=` response with no `CI (live DB)` run and no run at all. */
const NO_RUNS_AT_ALL = JSON.stringify({ total_count: 0, workflow_runs: [] });

describe("live-DB coverage fetcher — the network half, pinned offline", () => {
  it("the fetcher exists and is executable", () => {
    assert.ok(existsSync(FETCHER), `${FETCHER} is missing`);
    const r = spawnSync("bash", ["-n", FETCHER], { encoding: "utf8" });
    assert.equal(r.status, 0, `the fetcher does not parse as bash:\n${r.stderr}`);
  });

  it("flags EXACTLY #530 and #393 out of the 16 open pull requests read on 2026-10-03", () => {
    const r = runFetcher();
    assert.equal(r.code, 1, `the measured repository state must FAIL. Got ${r.code}:\n${r.out}`);
    assert.equal(r.checked, "16", `all 16 open PRs must be checked:\n${r.out}`);
    assert.equal(r.covered, "14", `14 of the 16 head SHAs have a live-DB run:\n${r.out}`);
    assert.equal(
      r.uncertified,
      "#530@846f58e7c12781d2633648354b25a5b7c98e4da7 #393@1b78d3b6a6e570aef6c1864b7b38a3e1a8bf80b6",
      `exactly the two measured PRs, in listing order:\n${r.out}`,
    );
    assert.equal(r.unmeasurable, "", `nothing is unmeasurable while the horizon resolves:\n${r.out}`);

    // The four dirty-but-fine PRs and the two not-yet-concluded ones must be
    // untouched. Keying on `mergeable_state` would have flagged all of them.
    for (const pr of [549, 521, 54, 52, 562, 560, 566, 565, 561]) {
      assert.match(
        r.lineOf(pr) ?? "",
        /verdict=covered/,
        `PR #${pr} has a live-DB run for its head SHA and must not be flagged:\n${r.out}`,
      );
    }
    // The gate half is reported, never gating: a red gate is still "covered".
    assert.match(r.lineOf(568) ?? "", /verdict=covered gate=failure/, r.out);
    // A gate job that has not concluded reports `none`, not blank.
    assert.match(r.lineOf(562) ?? "", /verdict=covered gate=none/, r.out);
    // Both halves of the two-part question are named in the annotation.
    assert.match(r.out, /::error::live-db coverage: these open PR head SHAs have NO 'CI \(live DB\)' run at all/);
    assert.match(r.stepSummary, /live-DB coverage of open pull requests/);
    assert.match(r.stepSummary, /Oldest visible `CI \(live DB\)` run: `2026-08-10T06:39:09Z`/);
  });

  it("regression: a per-SHA response whose FIRST field is empty must not yield a run id", () => {
    // PR #530's SHA has a `ci.yml` run and no live-DB run, so the production jq
    // program returns " 2026-10-03T06:35:40Z" — EMPTY run id, populated
    // timestamp. Read with `awk '{print $1}'` the timestamp becomes the run id
    // and the missing run reads as present.
    //
    // Both directions are asserted by one line, which is why it is asserted
    // this way: under awk the state would flip to `run` AND, field 2 being
    // empty, the age source would fall back to `commit-date`. Only correct
    // field splitting produces "UNCERTIFIED ... age_source=first-ci-run".
    const r = runFetcher();
    const line = r.lineOf(530);
    assert.ok(line, `no verdict line for PR #530:\n${r.out}`);
    assert.match(
      line,
      /verdict=UNCERTIFIED/,
      `PR #530 has no live-DB run for its head SHA; reading it as covered is the inverted bug:\n${line}`,
    );
    assert.match(
      line,
      /age_source=first-ci-run/,
      `the timestamp is field 2 and must be read as the age source, not consumed as the run id:\n${line}`,
    );
    assert.doesNotMatch(r.out, /^530 846f\S+ \d+ \S+ run /m, `PR #530 must never appear with run_state=run:\n${r.out}`);

    // And the splitting hazard itself, demonstrated rather than asserted about
    // the source: this is why the script uses `cut` and not `awk`.
    const demo = spawnSync(
      "bash",
      [
        "-c",
        `s=' 2026-10-03T06:35:40Z'; printf '%s|%s\\n' "$(printf '%s' "$s" | cut -d' ' -f1)" "$(printf '%s' "$s" | awk '{print $1}')"`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      (demo.stdout ?? "").trim(),
      "|2026-10-03T06:35:40Z",
      "the premise of this regression — that awk collapses the empty leading field while cut does not — no longer holds; re-derive the field splitting in assert-live-db-coverage.sh",
    );
  });

  it("regression: the per-SHA jq program COMPILES, so an empty answer can only mean no run", () => {
    // The first version of this filter was a jq syntax error. The call carries
    // `2>/dev/null`, so the compile failure would have been invisible and the
    // empty result indistinguishable from "no `CI (live DB)` run exists" — for
    // every pull request at once. jq exits 3 on a program that does not
    // compile, so the exit code is the assertion; the expected output is
    // checked too, because a filter can compile and still answer wrongly.
    const src = readFileSync(FETCHER, "utf8");
    const line = src.split("\n").find((l) => l.includes("--jq") && l.includes("workflow_runs[]] as $r"));
    assert.ok(line, "could not find the per-SHA jq invocation in the fetcher — re-derive this test");
    const m = /--jq '(.*)' \\$/.exec(line.trim());
    assert.ok(m, `could not extract the jq program from:\n${line}`);
    const program = m[1].replace(`'"\${WF_ID}"'`, String(LIVE_DB_WF_ID));
    assert.doesNotMatch(program, /WF_ID/, "the workflow-id splice was not substituted — re-derive this test");

    // The four response shapes recorded on 2026-10-03.
    const shapes: { why: string; body: string; expect: string }[] = [
      {
        why: "a live-DB run exists alongside a ci.yml run (PR #549)",
        body: JSON.stringify({
          total_count: 2,
          workflow_runs: [
            { id: 700549, workflow_id: CI_WF_ID, created_at: "2026-09-30T16:59:08Z" },
            { id: 900549, workflow_id: LIVE_DB_WF_ID, created_at: "2026-09-30T16:59:08Z" },
          ],
        }),
        expect: "900549 2026-09-30T16:59:08Z",
      },
      {
        why: "only other workflows ran for this SHA (PR #530, the measured defect)",
        body: JSON.stringify({
          total_count: 1,
          workflow_runs: [{ id: 700530, workflow_id: CI_WF_ID, created_at: "2026-10-03T06:35:40Z" }],
        }),
        expect: " 2026-10-03T06:35:40Z",
      },
      { why: "no workflow run of any kind", body: NO_RUNS_AT_ALL, expect: " " },
      {
        why: "a single queued live-DB run, no conclusion yet",
        body: JSON.stringify({
          total_count: 1,
          workflow_runs: [{ id: 900562, workflow_id: LIVE_DB_WF_ID, created_at: "2026-10-03T08:47:30Z" }],
        }),
        expect: "900562 2026-10-03T08:47:30Z",
      },
    ];

    for (const s of shapes) {
      const r = spawnSync("jq", ["-r", program], { input: s.body, encoding: "utf8" });
      assert.equal(
        r.status,
        0,
        `the per-SHA jq program did not run on the shape where ${s.why}. ` +
          `jq exit ${r.status} (3 = the program does not compile), stderr:\n${r.stderr}`,
      );
      assert.equal(
        (r.stdout ?? "").replace(/\n$/, ""),
        s.expect,
        `wrong answer for the shape where ${s.why}`,
      );
    }
  });

  it("an EMPTY pull-request listing is refused while the repository reports open issues-or-PRs", () => {
    const r = runFetcher({ "pulls.json": "[]" });
    assert.equal(r.code, 1, `an unexplained empty listing must FAIL, not pass vacuously:\n${r.out}`);
    assert.match(r.out, /the pull-request listing is EMPTY but the API answered/, r.out);
    assert.match(r.out, /reports 17 open issue\(s\)-or-pull-request\(s\)/, r.out);
  });

  it("an EMPTY pull-request listing passes only when the repository agrees there are none", () => {
    const r = runFetcher({ "pulls.json": "[]", "repo.json": JSON.stringify({ open_issues_count: 0 }) });
    assert.equal(r.code, 0, `two agreeing sources are the one legitimate empty case:\n${r.out}`);
    assert.match(r.out, /The two sources agree; there is nothing to certify/, r.out);
  });

  it("an unreadable open-issue count is not an exemption either", () => {
    const r = runFetcher({ "pulls.json": "[]", "repo.json": JSON.stringify({ description: "no count here" }) });
    assert.equal(r.code, 1, `an unestablished zero is not a pass:\n${r.out}`);
    assert.match(r.out, /own open-issue count could not be read/, r.out);
  });

  it("an unresolvable horizon degrades UNCERTIFIED to UNMEASURABLE and still fails", () => {
    // total_count 0 for the workflow's own runs: the oldest visible run cannot
    // be identified, so no absence can be distinguished from log retention.
    const r = runFetcher({ "wf_runs_total.json": JSON.stringify({ total_count: 0, workflow_runs: [] }) });
    assert.equal(r.code, 1, `a weaker claim is still a failure:\n${r.out}`);
    assert.match(r.out, /::warning::live-db coverage: could not establish the oldest visible/, r.out);
    assert.equal(r.uncertified, "", `nothing may be called UNCERTIFIED without a horizon:\n${r.out}`);
    assert.equal(
      r.unmeasurable,
      "#530@846f58e7c12781d2633648354b25a5b7c98e4da7 #393@1b78d3b6a6e570aef6c1864b7b38a3e1a8bf80b6",
      `both must land in UNMEASURABLE:\n${r.out}`,
    );
    assert.match(r.lineOf(530) ?? "", /verdict=UNMEASURABLE .*horizon=unknown/, r.out);
    assert.match(r.out, /::error::live-db coverage: these open PR head SHAs could NOT be measured/, r.out);
  });

  it("a SHA with no workflow run of ANY kind falls back to the commit date, and says so", () => {
    // There is then no server-generated "CI first saw it" to date the SHA from.
    const r = runFetcher({ "runs_846f58e7c12781d2633648354b25a5b7c98e4da7.json": NO_RUNS_AT_ALL });
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.lineOf(530) ?? "",
      /verdict=UNCERTIFIED .*age_source=commit-date/,
      `with no run to date the SHA from, the fallback must be named on the line:\n${r.out}`,
    );
    // The other PR still reports the sound source, so the two are not conflated.
    assert.match(r.lineOf(393) ?? "", /age_source=first-ci-run/, r.out);
    // And the weakness is stated where a reader of the failure will see it.
    assert.match(r.out, /If a line above reads age_source=commit-date, discount it/, r.out);
  });

  it("an unreadable commit date for a SHA with no runs fails rather than skipping the PR", () => {
    const r = runFetcher({
      "runs_846f58e7c12781d2633648354b25a5b7c98e4da7.json": NO_RUNS_AT_ALL,
      "commit_846f58e7c12781d2633648354b25a5b7c98e4da7.json": null,
    });
    assert.equal(r.code, 1, `an unestablished age is not an exemption:\n${r.out}`);
    assert.match(r.out, /could not read the head commit date for PR #530/, r.out);
  });

  it("a back-dated SHA lands past the horizon in the SAME run as an uncertified one", () => {
    // #530 with no runs at all and a committer date before 2026-08-10 is
    // UNMEASURABLE; #393 is still UNCERTIFIED. The two sets are reported
    // separately, with separate annotations, in one run — they are never merged
    // into a single count, because the remedies are different.
    const r = runFetcher({
      "runs_846f58e7c12781d2633648354b25a5b7c98e4da7.json": NO_RUNS_AT_ALL,
      "commit_846f58e7c12781d2633648354b25a5b7c98e4da7.json": JSON.stringify({
        sha: "846f58e7c12781d2633648354b25a5b7c98e4da7",
        commit: { committer: { date: "2026-07-01T00:00:00Z" } },
      }),
    });
    assert.equal(r.code, 1, r.out);
    assert.equal(r.unmeasurable, "#530@846f58e7c12781d2633648354b25a5b7c98e4da7", r.out);
    assert.equal(r.uncertified, "#393@1b78d3b6a6e570aef6c1864b7b38a3e1a8bf80b6", r.out);
    assert.match(r.lineOf(530) ?? "", /verdict=UNMEASURABLE .*horizon=before/, r.out);
    assert.match(r.out, /have NO 'CI \(live DB\)' run at all/, r.out);
    assert.match(r.out, /could NOT be measured/, r.out);
    assert.match(r.stepSummary, /No run exists for: `#393@/, r.stepSummary);
    assert.match(r.stepSummary, /Could not be measured: `#530@/, r.stepSummary);
  });

  it("the runs endpoint failing is a failure, NOT 'no run exists'", () => {
    // The removed fixture makes the stub exit non-zero with empty stdout: the
    // exact shape a 403 from a token without `actions: read` produces. Reading
    // that as an absent run would turn a permissions mistake into 16 false
    // accusations; reading it as a pass would be worse.
    const r = runFetcher({ "runs_fd0a600e19c0d4c2fbd9d549770e7de421f485d6.json": null });
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /listing workflow runs for fd0a600e19c0d4c2fbd9d549770e7de421f485d6 \(PR #549\) failed/,
      r.out,
    );
    assert.match(r.out, /needs `actions: read`/, r.out);
    assert.equal(r.checked, null, `the decider must never have been reached:\n${r.out}`);
  });

  it("the open-pull-request listing failing is a failure, not an empty listing", () => {
    const r = runFetcher({ "pulls.json": null });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /listing open pull requests failed/, r.out);
    assert.match(r.out, /needs `pull-requests: read`/, r.out);
  });

  it("the workflow being renamed away FAILS closed instead of certifying everything", () => {
    const r = runFetcher({
      "workflows.json": JSON.stringify({
        total_count: 2,
        workflows: [
          { id: CI_WF_ID, name: "CI" },
          { id: LIVE_DB_WF_ID, name: "CI (live database)" },
        ],
      }),
    });
    assert.equal(r.code, 1, `an unresolvable workflow name must not read as 'all clear':\n${r.out}`);
    assert.match(r.out, /could not resolve the workflow id for 'CI \(live DB\)'/, r.out);
    assert.match(r.out, /update WORKFLOW_NAME in this script and the required-status-check contexts/, r.out);
    assert.equal(r.checked, null, `nothing may be checked without the workflow id:\n${r.out}`);
  });

  it("a run of a DIFFERENT workflow on the same SHA does not count as a certification", () => {
    // Every one of the 16 SHAs carries a `ci.yml` run in the fixtures, and that
    // is the whole point of the measured defect: `ci.yml` and
    // `unwired-checks.yml` DID run and report green on #530 and #393.
    const r = runFetcher();
    assert.match(r.lineOf(530) ?? "", /verdict=UNCERTIFIED/, r.out);
    // Make the non-live-DB run the only one on a previously covered SHA too.
    const r2 = runFetcher({
      "runs_fd0a600e19c0d4c2fbd9d549770e7de421f485d6.json": JSON.stringify({
        total_count: 1,
        workflow_runs: [{ id: 700549, workflow_id: CI_WF_ID, created_at: "2026-09-30T16:59:08Z" }],
      }),
    });
    assert.equal(r2.code, 1, r2.out);
    assert.match(r2.uncertified ?? "", /#549@fd0a600e19c0d4c2fbd9d549770e7de421f485d6/, r2.out);
    assert.equal(r2.covered, "13", `one fewer SHA is covered once its live-DB run is removed:\n${r2.out}`);
  });

  it("the gate job going missing from an existing run is named `unknown`, not blanked", () => {
    const r = runFetcher({
      "jobs_900549.json": JSON.stringify({
        total_count: 1,
        jobs: [{ id: 1, name: "live DB \u00b7 acquire slot", conclusion: "failure" }],
      }),
    });
    // Still covered — (a) is yes. (b) is reported and does not gate.
    assert.match(r.lineOf(549) ?? "", /verdict=covered gate=unknown/, r.out);
    assert.doesNotMatch(r.uncertified ?? "", /#549@/, r.out);
  });

  it("the decider is invoked, not re-implemented inline", () => {
    const src = readFileSync(FETCHER, "utf8");
    assert.match(src, /live-db-coverage-decide\.sh/, "the fetcher must call the pure predicate");
    assert.ok(
      existsSync(resolve(REPO_ROOT, ".github/scripts/live-db-coverage-decide.sh")),
      "the decider is missing",
    );
    // And it refuses to run without it, rather than guessing.
    assert.match(src, /Refusing to re-implement the predicate inline/);
  });
});
