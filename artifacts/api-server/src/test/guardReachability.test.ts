/**
 * The guard-over-the-guards must fire — `check:guard-reachability`.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * A guard nobody runs is decorative architecture. Every piece is individually
 * correct — the checker has a mutation suite, it exits 1 on a crafted defect,
 * its header is exact — and it protects nothing, because no CI path ever points
 * it at the real tree.
 *
 * That is the state `checkUncheckedSupabaseReads` was in: the fail-open ledger,
 * the largest guard in this repo, reached by NOTHING. Its own suite spawns it
 * only through a helper whose env literal names UNCHECKED_READS_SRC_ROOT and
 * UNCHECKED_READS_ALLOWLIST, so every run is a fixture run. The 306 -> 0
 * burn-down it records is protected by nothing at all.
 *
 * ── WHY THE FALSE-POSITIVE CASES CARRY THE WEIGHT HERE ───────────────────────
 * The first version of the test-control rule required the spawn to sit lexically
 * inside the it(), and immediately reported two CORRECTLY GATED suites
 * (flagSchemaPrerequisites, stateMachineWriters) as ungated, because both spawn
 * through a helper. A guard that fails on correct code gets deleted, so the four
 * shapes are pinned below — three that must pass, one that must fail — and the
 * hard pair is C vs D: both helpers mention a seam, and only the POSITION of the
 * mention (inside a conditional, or not) separates a fixture branch the control
 * can decline from a seam every call is forced through.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/guardReachability.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasRealTreeControl } from "../scripts/checkGuardReachability.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const CHECKER = join(API_ROOT, "src", "scripts", "checkGuardReachability.ts");

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "guardreach-")); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** Run the checker with a crafted registry (and optionally a crafted run-all / workflow dir). */
function withRegistry(name: string, entries: unknown[], extra: Record<string, string> = {}) {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(entries, null, 1));
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: { ...process.env, GUARD_REGISTRY: p, ...extra },
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("guard reachability ratchet", () => {
  it("CONTROL — the real tree and the real registry pass", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
      cwd: API_ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, r.out ?? `${r.stdout}${r.stderr}`);
    // A silent pass proves nothing: the inventory must actually be printed, and
    // the unenforced count must be stated rather than rounded away.
    assert.match(r.stdout, /guard\(s\) on disk/);
    assert.match(r.stdout, /MANUAL \/ not enforced/);
  });

  it("FAILS when a guard on disk is missing from the registry", () => {
    // The discovery rule: the registry must not be usable to hide a guard.
    const { code, out } = withRegistry("hidden", [{
      checker: "src/scripts/checkGuardReachability.ts",
      responsibility: "Only one guard is declared here, so every other check*.ts on disk is undeclared.",
      reach: { kind: "manual", reason: "x".repeat(200) },
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /UNREGISTERED GUARD/);
  });

  it("FAILS a registered checker whose file does not exist", () => {
    const { code, out } = withRegistry("ghost", [{
      checker: "src/scripts/checkNoSuchGuardExists.ts",
      responsibility: "A registry entry for a checker that was deleted, which must not read as coverage.",
      reach: { kind: "manual", reason: "x".repeat(200) },
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /registered but the file does not exist/);
  });

  it("FAILS two guards claiming the SAME responsibility", () => {
    const same = "Two entries claiming this identical job, which leaves one of them unowned in a cleanup.";
    const { code, out } = withRegistry("dup", [
      { checker: "src/scripts/checkGuardReachability.ts", responsibility: same, reach: { kind: "manual", reason: "y".repeat(200) } },
      { checker: "src/scripts/checkProjectionConsumers.ts", responsibility: same, reach: { kind: "manual", reason: "y".repeat(200) } },
    ]);
    assert.notEqual(code, 0);
    assert.match(out, /DUPLICATE RESPONSIBILITY/);
  });

  it("FAILS a check-all declaration that run-all-checks.sh does not invoke", () => {
    const runAll = join(tmp, "empty-run-all.sh");
    writeFileSync(runAll, "#!/usr/bin/env bash\necho nothing\n");
    const { code, out } = withRegistry("notrun", [{
      checker: "src/scripts/checkFrozenDir.ts",
      responsibility: "Declared as gated by check:all while the shell that would run it never mentions it.",
      reach: { kind: "check-all", script: "check:frozen-dir" },
    }], { GUARD_RUN_ALL: runAll });
    assert.notEqual(code, 0);
    assert.match(out, /never invokes it/);
  });

  it("FAILS a workflow declaration when only a COMMENT names the script", () => {
    // The real case: live-db.yml mentions check:migration-ledger only inside a
    // comment, and the step actually runs certify:migrations.
    const wf = join(tmp, "wf");
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, "ci.yml"), "jobs:\n  a:\n    steps:\n      # run: pnpm check:frozen-dir\n      - run: echo hi\n");
    const { code, out } = withRegistry("commentwf", [{
      checker: "src/scripts/checkFrozenDir.ts",
      responsibility: "Declared as workflow-gated while only a YAML comment names the script that would run it.",
      reach: { kind: "workflow", script: "check:frozen-dir" },
    }], { GUARD_WORKFLOW_DIR: wf });
    assert.notEqual(code, 0);
    assert.match(out, /no live line of any workflow names it/);
  });

  it("FAILS a delegation whose delegator does not name the checker", () => {
    const { code, out } = withRegistry("baddeleg", [{
      checker: "src/scripts/checkMigrationLedger.ts",
      responsibility: "Declared as delegated from a file that has nothing to do with the migration ledger.",
      reach: { kind: "delegated", by: "src/scripts/checkFrozenDir.ts", script: "certify:migrations" },
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /never names checkMigrationLedger\.ts/);
  });

  it("FAILS a delegation chain that ends in nothing", () => {
    const runAll = join(tmp, "empty2.sh");
    writeFileSync(runAll, "#!/usr/bin/env bash\n");
    const wf = join(tmp, "wf2");
    mkdirSync(wf, { recursive: true });
    const { code, out } = withRegistry("deadchain", [{
      checker: "src/scripts/checkMigrationLedger.ts",
      responsibility: "Delegated through a script that is itself invoked by nothing, one hop from the same defect.",
      reach: { kind: "delegated", by: "src/scripts/certifyMigrations.ts", script: "certify:migrations" },
    }], { GUARD_RUN_ALL: runAll, GUARD_WORKFLOW_DIR: wf });
    assert.notEqual(code, 0);
    assert.match(out, /The chain ends in nothing/);
  });

  it("FAILS a build-gate whose runner never runs the script", () => {
    const { code, out } = withRegistry("badbuild", [{
      checker: "src/scripts/checkSentryOtelDeps.ts",
      responsibility: "Declared as a build gate against a runner script that does not invoke the build at all.",
      reach: { kind: "build-gate", script: "build", runner: "artifacts/api-server/scripts/run-all-checks.sh" },
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /never runs "build"/);
  });

  it("FAILS a manual exemption with no substantive reason", () => {
    const { code, out } = withRegistry("noreason", [{
      checker: "src/scripts/checkGuardReachability.ts",
      responsibility: "A manual entry whose reason is too short to say why CI genuinely cannot invoke it.",
      reach: { kind: "manual", reason: "because" },
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /manual requires a reason/);
  });

  it("FAILS a STALE manual exemption — it says CI cannot run it, and CI does", () => {
    const { code, out } = withRegistry("stale", [{
      checker: "src/scripts/checkFrozenDir.ts",
      responsibility: "Marked unrunnable by CI while run-all-checks.sh invokes it on every run.",
      reach: { kind: "manual", reason: "z".repeat(200) },
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /stale exemption/);
  });

  it("FAILS a test-control whose test file is not registered", () => {
    const { code, out } = withRegistry("unreg", [{
      checker: "src/scripts/checkGuardReachability.ts",
      responsibility: "Points at a control suite that exists on disk but is in no run, so it never executes.",
      reach: { kind: "test-control", test: "src/test/helpers/failClosedSupabase.ts", seams: [] },
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /is NOT in package\.json's "test" script/);
  });

  it("FAILS VACUOUSLY-EMPTY rather than reporting success", () => {
    const { code, out } = withRegistry("empty", []);
    assert.notEqual(code, 0);
    // An empty registry trips discovery first (39 unregistered guards), which is
    // itself the right answer; the vacuity floor is the backstop under it.
    assert.match(out, /UNREGISTERED GUARD|VACUOUS/);
  });
});

describe("test-control — the four shapes, on synthetic sources", () => {
  // These were end-to-end assertions against the real suites until
  // checkUncheckedSupabaseReads GAINED a real-tree control and stopped being an
  // example of shape D. Pinning the shapes to synthetic sources instead means the
  // rule keeps its proof when the tree improves, which is the whole point: the
  // guard must not lose its own regression test as a side effect of the defect
  // being fixed.
  const SEAMS = ["FIXTURE_ROOT", "FIXTURE_ALLOWLIST"] as const;
  const check = (body: string) => {
    const f = join(tmp, `shape-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(f, body);
    return hasRealTreeControl(f, "checkThing.ts", SEAMS as unknown as string[]);
  };

  it("A — an inline spawn in the it(), asserting status 0, is ACCEPTED", () => {
    const r = check(`
      it("real tree", () => {
        const r = spawnSync(node, ["--import", "tsx/esm", CHECKER], { cwd: ROOT });
        assert.equal(r.status, 0, r.stdout);
      });
    `);
    assert.equal(r.ok, true, r.why);
  });

  it("B — a helper that NEVER sets a seam is ACCEPTED", () => {
    const r = check(`
      const run = (env = {}) => spawnSync(node, ["--import", "tsx/esm", SCRIPT], { env: { ...process.env, ...env } });
      it("real tree", () => {
        const r = run();
        assert.equal(r.status, 0);
      });
    `);
    assert.equal(r.ok, true, r.why);
  });

  it("C — a helper that sets a seam CONDITIONALLY is ACCEPTED", () => {
    // stateMachineWriters' shape: run(reg) writes the seam only inside if (reg),
    // and the control calls run(null). The first version of this rule rejected it.
    const r = check(`
      function run(reg) {
        const e = { ...process.env };
        if (reg) { e.FIXTURE_ROOT = write(reg); }
        return spawnSync(node, ["--import", "tsx/esm", SCRIPT], { env: e });
      }
      it("real tree", () => {
        const r = run(null);
        assert.equal(r.code, 0);
      });
    `);
    assert.equal(r.ok, true, r.why);
  });

  it("D — a helper that ALWAYS sets a seam is REJECTED", () => {
    // The actual defect: the fail-open guard's suite spawned only through a
    // helper whose env literal named both seams unconditionally, so no call it
    // made could reach the real tree.
    const r = check(`
      const run = (root, allow) => spawnSync(node, ["--import", "tsx/esm", SCRIPT], {
        env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_ALLOWLIST: allow },
      });
      it("a crafted tree fails", () => {
        const r = run(dir, allowlist);
        assert.equal(r.status, 1);
      });
    `);
    assert.equal(r.ok, false);
    assert.match(r.why, /UNCONDITIONALLY/);
  });

  it("a seam passed at the CALL SITE is rejected even through a clean helper", () => {
    const r = check(`
      const run = (env = {}) => spawnSync(node, ["--import", "tsx/esm", SCRIPT], { env: { ...process.env, ...env } });
      it("fixture", () => {
        const r = run({ FIXTURE_ROOT: dir });
        assert.equal(r.status, 0);
      });
    `);
    assert.equal(r.ok, false);
    assert.match(r.why, /call site/);
  });

  it("a real-tree spawn that never asserts the status is REJECTED", () => {
    // Spawning without asserting is a suite that watches the guard fail and says
    // nothing — reachability without a verdict.
    const r = check(`
      it("runs it", () => {
        const r = spawnSync(node, ["--import", "tsx/esm", CHECKER], { cwd: ROOT });
        assert.match(r.stdout, /something/);
      });
    `);
    assert.equal(r.ok, false);
    assert.match(r.why, /never asserts the exit status is 0/);
  });

  it("asserting the status is NON-zero is not a control either", () => {
    const r = check(`
      it("fails", () => {
        const r = spawnSync(node, ["--import", "tsx/esm", CHECKER], { cwd: ROOT });
        assert.notEqual(r.status, 0);
      });
    `);
    assert.equal(r.ok, false);
  });

  it("a seam named only in a COMMENT does not disqualify a control", () => {
    // This checker had that bug. The fail-open guard's control explains itself by
    // NAMING its seams in a comment, and matching the raw node text read that
    // prose as a seam override — so the one genuine control in the tree looked
    // like a fixture run.
    const r = check(`
      it("real tree", () => {
        // Every other case here points at a scratch tree via FIXTURE_ROOT /
        // FIXTURE_ALLOWLIST. This one deliberately does not.
        const r = spawnSync(node, ["--import", "tsx/esm", CHECKER], { cwd: ROOT });
        assert.equal(r.status, 0);
      });
    `);
    assert.equal(r.ok, true, r.why);
  });

  it("a file that never runs the checker at all is REJECTED", () => {
    const r = check(`it("unrelated", () => { assert.equal(1, 1); });`);
    assert.equal(r.ok, false);
    assert.match(r.why, /no it\(\)\/test\(\) case runs the checker at all/);
  });
});
