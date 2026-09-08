/**
 * The security suite must be watched FAILING — `scripts/run-security-checks.sh`.
 *
 * ── WHAT IS BEING PROVEN ─────────────────────────────────────────────────────
 * A runner that aggregates other checks is only worth its green if its FAILURE
 * paths work. Those paths are unreachable while the real tree passes, so the
 * runner exposes two seams — SECURITY_SUITE_CHECKS and SECURITY_SUITE_UNENFORCED,
 * each a bash manifest sourced INSTEAD of the built-in list — and the cases below
 * drive stub checks through every way a check can fail:
 *
 *   exit 2 (CANNOT RUN)          an unrunnable security check must not read as a
 *                                clean one, so it fails and is never skipped
 *   exit 1 (died involuntarily)  a crash proves nothing
 *   exit 3 while printing NOTHING  the PIPE PROOF: `cmd | tee log` reports TEE's
 *                                status, and tee succeeds. A runner that reads
 *                                `$?` there scores this stub as a PASS. It must
 *                                be read off ${PIPESTATUS[0]}
 *   exit 0, required line absent  a process that dies before printing its verdict
 *                                still leaves a passing-looking status behind
 *   command not found (127)      a check that cannot run at all
 *   an empty check list          a suite that examines nothing must not report
 *                                success
 *
 * and one case where everything genuinely passes, which must be the ONLY way to
 * exit 0.
 *
 * ── THE REAL-TREE CONTROL ────────────────────────────────────────────────────
 * The first case runs the suite with NO seam set, against the real tree, and
 * asserts its ACTUAL status. It cannot assert 0: check:authorization-contract
 * reads the live CI database and exits 2 — a FAILURE, not a skip — in a
 * credential-free environment, which is the same reason ci.yml does not invoke
 * check:all. So the control asserts the honest and much stronger property:
 *
 *   * every credential-free security check PASSES, by name;
 *   * the ONLY check permitted to fail is the credential-gated one;
 *   * the exit status AGREES with the printed summary (0 iff nothing failed) —
 *     a runner whose summary and status disagree is the defect itself;
 *   * the suite is never vacuous and never mis-configured (status 2).
 *
 * A regression in any static security guard therefore fails this test, and so
 * does a runner that starts swallowing statuses.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/securityCheckSuite.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const SUITE = join(API_ROOT, "scripts", "run-security-checks.sh");

/**
 * The one check in the suite that reads a live database. It exits 2 (CANNOT RUN)
 * without credentials, and the runner is required to score that as a failure.
 * It is therefore the only label the control tolerates in the failed set.
 */
const CREDENTIAL_GATED = ["check:authorization-contract"];

/** Every check the suite runs that needs no credentials: all must pass, by name. */
const CREDENTIAL_FREE = [
  "check:guard-reachability",
  "check:guard-coverage",
  "check:route-auth-gate",
  "check:client-privilege-boundary",
  "check:unchecked-supabase-reads",
  "check:silent-supabase-writes",
  "check:flag-polarity",
  "check:deletion-coverage",
  "check:data-rights",
  "check:location-purposes",
];

let tmp = "";
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "secsuite-"));
});
after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  out: string;
}

function runSuite(env: Record<string, string> = {}): Run {
  const r = spawnSync("bash", [SUITE], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Write an executable stub check and return its absolute path. */
function stub(name: string, body: string): string {
  const p = join(tmp, `${name}.sh`);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Write a bash manifest for the SECURITY_SUITE_CHECKS seam. */
function manifest(name: string, body: string): string {
  const p = join(tmp, `${name}.manifest.sh`);
  writeFileSync(p, `${body}\n`);
  return p;
}

/** A manifest that declares no unenforced guards, so those cases stay isolated. */
function emptyUnenforced(): string {
  return manifest("no-unenforced", "# no unenforced guards declared\n:");
}

/** Labels the runner scored, read off its own PASSED / FAILED lines. */
function scored(out: string): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  for (const line of out.split("\n")) {
    const p = /^✔ PASSED: (\S+)/.exec(line);
    if (p) passed.push(p[1]);
    const f = /^✘ FAILED: (\S+)/.exec(line);
    if (f) failed.push(f[1]);
  }
  return { passed, failed };
}

describe("security check suite runner", () => {
  it("CONTROL — the real tree, no seams: its true status, and every static security guard passes", () => {
    const r = runSuite();
    const { passed, failed } = scored(r.out);

    assert.notEqual(
      r.status,
      2,
      `the suite reported a configuration error or a vacuous run:\n${r.out}`,
    );
    // FIXTURE MODE must not be reachable without a seam — otherwise a real run
    // could silently be a fixture run.
    assert.ok(!r.out.includes("FIXTURE MODE"), r.out);

    // Every credential-free security guard passes on the real tree today.
    for (const label of CREDENTIAL_FREE) {
      assert.ok(passed.includes(label), `${label} did not PASS on the real tree:\n${r.out}`);
    }
    // Nothing else is allowed to fail. In a credential-free environment
    // check:authorization-contract exits 2 and legitimately appears here; in a
    // credentialed one this set is empty.
    for (const label of failed) {
      assert.ok(
        CREDENTIAL_GATED.includes(label),
        `unexpected security check failure: ${label}\n${r.out}`,
      );
    }
    // The printed summary and the exit status must agree.
    assert.equal(
      r.status,
      failed.length === 0 ? 0 : 1,
      `exit status disagrees with the summary (failed: ${failed.join(", ") || "none"}):\n${r.out}`,
    );
    // Non-vacuity, and the unenforced gap is measured rather than implied.
    assert.equal(passed.length + failed.length, CREDENTIAL_FREE.length + CREDENTIAL_GATED.length, r.out);
    assert.match(r.out, /NOT RUN AS A GATE: [1-9][0-9]* security-relevant guard\(s\) are UNENFORCED/);
    assert.match(r.out, /NOT GATED: src\/scripts\/checkAdminGuard\.ts/);

    // A ratchet's green must be reprinted with what it does not cover.
    // "check:deletion-coverage passed" is true and means far less than it sounds:
    // 225 of 248 user-keyed tables survive account deletion undecided. If that
    // disclosure ever stops being printed, this fails.
    assert.match(r.out, /WHAT THESE GREENS DO NOT COVER/);
    assert.match(r.out, /check:deletion-coverage: [1-9][0-9]* UNCLASSIFIED — survive deletion/);
    assert.match(r.out, /check:data-rights: [1-9][0-9]* carry or could reconstruct personal data/);
    assert.match(r.out, /check:location-purposes: [0-9]+ process PRECISE location/);
    assert.ok(!/UNKNOWN — no line matched/.test(r.out), `a declared disclosure went missing:\n${r.out}`);
  });

  it("lifts declared disclosure lines into the summary without moving the verdict", () => {
    const s = stub(
      "ratchet",
      ['echo "check-stub: 248 table(s) in the baseline"',
       'echo "   225 UNCLASSIFIED — survive deletion, undecided"',
       'echo "VERDICT OK"',
       "exit 0"].join("\n"),
    );
    const m = manifest(
      "disclose",
      `security_check "stub:ratchet" --require '^VERDICT OK$' ` +
        `--report-ere '^[[:space:]]*[0-9]+ UNCLASSIFIED — survive deletion' -- bash ${s}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /stub:ratchet: 225 UNCLASSIFIED — survive deletion, undecided/);
  });

  it("reports a disclosure that matched nothing as UNKNOWN rather than dropping it", () => {
    const s = stub("silentratchet", 'echo "VERDICT OK"; exit 0');
    const m = manifest(
      "disclose-missing",
      `security_check "stub:quiet" --require '^VERDICT OK$' ` +
        `--report-ere '^[[:space:]]*[0-9]+ UNCLASSIFIED' -- bash ${s}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /stub:quiet: UNKNOWN — no line matched/);
  });

  it("says the registry cross-reference is UNAVAILABLE rather than claiming 0 are unenforced", () => {
    // A FAILING check:guard-reachability still prints its headline
    // "(9 MANUAL / not enforced)" while printing no per-guard rows. A runner that
    // greps for the WORD reports "0 of N are MANUAL" — a false all-clear on the
    // honesty line itself. This is the shape that bug had.
    const s = stub(
      "reach-fail",
      ['echo "check:guard-reachability — 40 guard(s) on disk, 39 registered (9 MANUAL / not enforced)"',
       'echo "FAIL — 1 problem(s):"',
       "exit 1"].join("\n"),
    );
    const m = manifest(
      "reach-noRows",
      `security_check "check:guard-reachability" --guard "src/scripts/checkDataRights.ts" -- bash ${s}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /registry cross-reference UNAVAILABLE/);
    assert.ok(!/0 of the [0-9]+ check\(s\) above are declared MANUAL/.test(r.out), r.out);
  });

  it("names a check that the registry declares MANUAL, read from the registry rather than hardcoded", () => {
    const s = stub(
      "reach-ok",
      ['echo "check:guard-reachability — 40 guard(s) on disk, 40 registered (1 MANUAL / not enforced)"',
       'echo "  src/scripts/stubUnwired.ts            MANUAL         not enforced by CI"',
       "exit 0"].join("\n"),
    );
    const other = stub("otherguard", "exit 0");
    const m = manifest(
      "reach-rows",
      [`security_check "check:guard-reachability" --guard "src/scripts/checkGuardReachability.ts" -- bash ${s}`,
       `security_check "stub:unwired-guard" --guard "src/scripts/stubUnwired.ts" -- bash ${other}`].join("\n"),
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /1 of the 2 check\(s\) above are declared MANUAL \/ NOT ENFORCED BY CI/);
    assert.match(r.out, /• stub:unwired-guard — enforced by THIS suite only/);
  });

  it("FAILS and names a check that exits 2 — CANNOT RUN is never a skip", () => {
    const s = stub("cannotrun", 'echo "ERROR: credentials required"; exit 2');
    const m = manifest(
      "exit2",
      `security_check "stub:needs-credentials" -- bash ${s}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /✘ FAILED: stub:needs-credentials \(exit 2/);
    assert.match(r.out, /✘ stub:needs-credentials/); // named in the summary
    assert.ok(!r.out.includes("ALL 1 SECURITY CHECK(S) PASSED"), r.out);
  });

  it("FAILS and names a check that exits 1 — a crash proves nothing", () => {
    const s = stub("crash", 'echo "TypeError: cannot read properties of undefined" >&2; exit 1');
    const m = manifest("exit1", `security_check "stub:crashed" -- bash ${s}`);
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /✘ FAILED: stub:crashed \(exit 1/);
  });

  it("PIPE PROOF — a check that exits 3 while printing nothing still FAILS", () => {
    // `cmd | tee log` reports tee's status, and tee succeeds on empty input, so a
    // runner that reads $? instead of ${PIPESTATUS[0]} scores this as a pass.
    const s = stub("silent3", "exit 3");
    const m = manifest("exit3", `security_check "stub:silent-blocked" -- bash ${s}`);
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /✘ FAILED: stub:silent-blocked \(exit 3/);
  });

  it("FAILS a check that exits 0 but never prints its required verdict line", () => {
    const s = stub("noverdict", 'echo "scanning..."; exit 0');
    const m = manifest(
      "noline",
      `security_check "stub:no-verdict" --require '^VERDICT: [1-9][0-9]* table\\(s\\) clean$' -- bash ${s}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /✘ FAILED: stub:no-verdict \(exit 0 but a REQUIRED verdict line is absent/);
    assert.match(r.out, /missing: \/\^VERDICT/);
  });

  it("FAILS a required line that is present but VACUOUS (zero examined)", () => {
    // The non-vacuity half of the real suite's patterns: a checker that examined
    // nothing and printed green must not score a pass.
    const s = stub("vacuous", 'echo "VERDICT: 0 table(s) clean"; exit 0');
    const m = manifest(
      "vac",
      `security_check "stub:vacuous" --require '^VERDICT: [1-9][0-9]* table\\(s\\) clean$' -- bash ${s}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /✘ FAILED: stub:vacuous \(exit 0 but a REQUIRED verdict line is absent/);
  });

  it("FAILS a check that cannot be executed at all (127)", () => {
    const m = manifest(
      "missing-binary",
      `security_check "stub:unrunnable" -- ${join(tmp, "this-binary-does-not-exist")}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /✘ FAILED: stub:unrunnable \(exit 127 — the check COULD NOT RUN/);
  });

  it("runs EVERY check to completion, so each failure is attributable by name", () => {
    const bad = stub("bad", "exit 2");
    const good = stub("good", 'echo "VERDICT OK"; exit 0');
    const m = manifest(
      "mixed",
      [
        `security_check "stub:first-fails" -- bash ${bad}`,
        `security_check "stub:second-passes" --require '^VERDICT OK$' -- bash ${good}`,
        `security_check "stub:third-fails" -- bash ${bad}`,
      ].join("\n"),
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    const { passed, failed } = scored(r.out);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(failed, ["stub:first-fails", "stub:third-fails"], r.out);
    assert.deepEqual(passed, ["stub:second-passes"], r.out);
    assert.match(r.out, /checks run:\s+3/);
    assert.match(r.out, /failed:\s+2/);
  });

  it("EXITS 0 only when everything genuinely passes — and still reports the unenforced gap", () => {
    const good = stub("allgood", 'echo "VERDICT: 7 table(s) clean"; exit 0');
    const m = manifest(
      "allpass",
      [
        `security_check "stub:a" --require '^VERDICT: [1-9][0-9]* table\\(s\\) clean$' -- bash ${good}`,
        `security_check "stub:b" -- bash ${good}`,
      ].join("\n"),
    );
    const findings = stub("findings", 'echo "FAILED — 4 locally declared admin guard(s)"; exit 1');
    const u = manifest(
      "unenforced",
      `security_unenforced "src/scripts/stubUnwired.ts" "a real gap, measured" ` +
        `--count-ere 'FAILED — [0-9]+ locally declared admin guard' -- bash ${findings}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: u });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /✔ ALL 2 SECURITY CHECK\(S\) PASSED/);
    // A green suite must still say what it did not run — otherwise it is the
    // false green this whole runner exists to prevent.
    assert.match(r.out, /NOT RUN AS A GATE: 1 security-relevant guard\(s\) are UNENFORCED/);
    assert.match(r.out, /src\/scripts\/stubUnwired\.ts — 4 standing finding\(s\)/);
    assert.match(r.out, /This is not a clean bill/);
    // and it must never be mistaken for a real run
    assert.match(r.out, /FIXTURE MODE WAS ACTIVE/);
  });

  it("reports an uncountable unenforced guard as UNKNOWN, never as 0", () => {
    const good = stub("ok", "exit 0");
    const silent = stub("silentguard", "exit 2");
    const m = manifest("one", `security_check "stub:ok" -- bash ${good}`);
    const u = manifest(
      "uncountable",
      `security_unenforced "src/scripts/stubLive.ts" "needs a live project" --needs-credentials ` +
        `--count-ere '[0-9]+ leaky key' -- bash ${silent}`,
    );
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: u });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /src\/scripts\/stubLive\.ts — findings UNKNOWN/);
    assert.ok(!/stubLive\.ts — 0 standing/.test(r.out), r.out);
  });

  it("FAILS with exit 2 on a vacuous run — a suite that examines nothing is not a pass", () => {
    const m = manifest("empty", "# declares no checks at all\n:");
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /✘ VACUOUS — 0 checks executed/);
  });

  it("FAILS with exit 2 when a declared check has no command behind it", () => {
    const m = manifest("nocmd", `security_check "stub:declared-but-empty" --guard "x.ts"`);
    const r = runSuite({ SECURITY_SUITE_CHECKS: m, SECURITY_SUITE_UNENFORCED: emptyUnenforced() });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /SUITE CONFIGURATION ERROR: stub:declared-but-empty: no command given/);
  });

  it("FAILS with exit 2 when the seam names a manifest that does not exist", () => {
    const r = runSuite({
      SECURITY_SUITE_CHECKS: join(tmp, "nope.manifest.sh"),
      SECURITY_SUITE_UNENFORCED: emptyUnenforced(),
    });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /SUITE CONFIGURATION ERROR: SECURITY_SUITE_CHECKS=.*does not exist/);
  });
});
