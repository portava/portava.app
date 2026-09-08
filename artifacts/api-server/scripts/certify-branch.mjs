#!/usr/bin/env node
/**
 * certify-branch — ONE command whose exit code means "this branch is certified".
 *
 * ── WHY THIS EXISTS SEPARATELY FROM run-all-checks.sh ────────────────────────
 * run-all-checks.sh runs 26 checks in a workflow slot and prints a human log.
 * This runs the full certification surface, captures the TRUE exit code of every
 * step, and emits a machine-readable summary alongside the table. The
 * distinction matters because the failure this repository keeps meeting is a
 * status that got lost on the way to a human: a pipeline that swallowed a code,
 * a check nobody wired, a green that meant "did not run".
 *
 * ── NO STATUS IS EVER HIDDEN BY A PIPELINE ───────────────────────────────────
 * Every step runs through execFileSync with the exit code read directly. No
 * `| tee`, no `|| true`, no `set -e` interaction, no grep deciding a verdict.
 * A step that crashes is a FAIL, not a skip: an unrecognised outcome is an
 * unknown state, and an unknown state is not a pass.
 *
 * ── SKIPS ARE NOT PASSES ─────────────────────────────────────────────────────
 * Some steps need a live database and refuse without credentials. Those are
 * reported CANNOT-RUN and counted separately. They do NOT count towards the
 * green total, and their presence is printed in the summary line, because a
 * certification that silently drops the checks it could not run is the exact
 * false green this file is written against.
 *
 * Usage:
 *   node scripts/certify-branch.mjs            human table + summary
 *   node scripts/certify-branch.mjs --json     machine-readable only
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const JSON_ONLY = process.argv.includes("--json");

/** How much of a failing step's output to keep. Enough to name the defect. */
const FAIL_EXCERPT_LINES = 25;

/**
 * kind:
 *   gate      must exit 0
 *   liveonly  needs live DB credentials; refuses without them (CANNOT-RUN, not a pass)
 */
const STEPS = [
  // ── compile ───────────────────────────────────────────────────────────────
  { id: "typecheck",                     kind: "gate", cmd: ["npm", "run", "-s", "typecheck"] },
  { id: "typecheck:tests",               kind: "gate", cmd: ["npm", "run", "-s", "typecheck:tests"] },
  // ── the registered test suite ─────────────────────────────────────────────
  { id: "test",                          kind: "gate", cmd: ["npm", "run", "-s", "test"] },
  { id: "check:test-registration",       kind: "gate", cmd: ["npm", "run", "-s", "check:test-registration"] },
  { id: "check:test-runner-flags",       kind: "gate", cmd: ["npm", "run", "-s", "check:test-runner-flags"] },
  // ── the guards about guards ───────────────────────────────────────────────
  { id: "check:guard-reachability",      kind: "gate", cmd: ["npm", "run", "-s", "check:guard-reachability"] },
  { id: "check:guard-coverage",          kind: "gate", cmd: ["npm", "run", "-s", "check:guard-coverage"] },
  // ── database read/write honesty ───────────────────────────────────────────
  { id: "check:unchecked-supabase-reads", kind: "gate", cmd: ["node", "--import", "tsx/esm", "src/scripts/checkUncheckedSupabaseReads.ts"] },
  { id: "check:silent-supabase-writes",  kind: "gate", cmd: ["npm", "run", "-s", "check:silent-supabase-writes"] },
  { id: "check:unissued-supabase-writes", kind: "gate", cmd: ["npm", "run", "-s", "check:unissued-supabase-writes"] },
  { id: "check:writerless-reads",        kind: "gate", cmd: ["npm", "run", "-s", "check:writerless-reads"] },
  { id: "check:not-null-writes",         kind: "gate", cmd: ["npm", "run", "-s", "check:not-null-writes"] },
  // ── authorization and privilege ───────────────────────────────────────────
  { id: "check:route-auth-gate",         kind: "gate", cmd: ["npm", "run", "-s", "check:route-auth-gate"] },
  { id: "check:admin-guard",             kind: "gate", cmd: ["npm", "run", "-s", "check:admin-guard"] },
  { id: "check:authorization-contract",  kind: "liveonly", cmd: ["npm", "run", "-s", "check:authorization-contract"] },
  { id: "check:security-definer-oracles", kind: "gate", cmd: ["npm", "run", "-s", "check:security-definer-oracles"] },
  // ── data rights, deletion, location ───────────────────────────────────────
  { id: "check:deletion-coverage",       kind: "gate", cmd: ["npm", "run", "-s", "check:deletion-coverage"] },
  { id: "check:data-rights",             kind: "gate", cmd: ["npm", "run", "-s", "check:data-rights"] },
  { id: "check:location-purposes",       kind: "gate", cmd: ["npm", "run", "-s", "check:location-purposes"] },
  // ── schema, migrations, snapshots ─────────────────────────────────────────
  { id: "check:migration-prefixes",      kind: "gate", cmd: ["npm", "run", "-s", "check:migration-prefixes"] },
  { id: "check:migration-ledger",        kind: "liveonly", cmd: ["npm", "run", "-s", "check:migration-ledger"] },
  { id: "check:schema-references",       kind: "gate", cmd: ["npm", "run", "-s", "check:schema-references"] },
  { id: "check:enum-literals",           kind: "gate", cmd: ["npm", "run", "-s", "check:enum-literals"] },
  { id: "check:memory-table-ownership",  kind: "gate", cmd: ["npm", "run", "-s", "check:memory-table-ownership"] },
  // ── flags and capability ──────────────────────────────────────────────────
  { id: "check:flag-polarity",           kind: "gate", cmd: ["npm", "run", "-s", "check:flag-polarity"] },
  { id: "check:layover-cutover",         kind: "gate", cmd: ["npm", "run", "-s", "check:layover-cutover"] },
  // ── trip kernel ───────────────────────────────────────────────────────────
  { id: "check:trip-kernel-writers",     kind: "gate", cmd: ["npm", "run", "-s", "check:trip-kernel-writers"] },
  // ── documentation truth ───────────────────────────────────────────────────
  { id: "check:doc-citations",           kind: "gate", cmd: ["npm", "run", "-s", "check:doc-citations"] },
  { id: "check:census-integrity",        kind: "gate", cmd: ["npm", "run", "-s", "check:census-integrity"] },
  { id: "check:census-freshness",        kind: "gate", cmd: ["npm", "run", "-s", "check:census-freshness"] },
  // ── misc structural ───────────────────────────────────────────────────────
  { id: "check:api-prefix",              kind: "gate", cmd: ["npm", "run", "-s", "check:api-prefix"] },
  { id: "check:async-handlers",          kind: "gate", cmd: ["npm", "run", "-s", "check:async-handlers"] },
  { id: "check:frozen-dir",              kind: "gate", cmd: ["npm", "run", "-s", "check:frozen-dir"] },
  { id: "check:compiler-authentic",      kind: "gate", cmd: ["npm", "run", "-s", "check:compiler-authentic"] },
  // ── need a live database; they REFUSE without credentials ─────────────────
  { id: "certify:migrations",            kind: "liveonly", cmd: ["npm", "run", "-s", "certify:migrations"] },
  { id: "check:write-path-columns",      kind: "liveonly", cmd: ["npm", "run", "-s", "check:write-path-columns"] },
  { id: "check:missing-live-columns",    kind: "liveonly", cmd: ["npm", "run", "-s", "check:missing-live-columns"] },
  { id: "check:production-drift",        kind: "gate", cmd: ["npm", "run", "-s", "check:production-drift"] },
];

const results = [];
for (const step of STEPS) {
  const started = Date.now();
  let code = 0;
  let output = "";
  try {
    output = execFileSync(step.cmd[0], step.cmd.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, SUPABASE_URL: process.env.SUPABASE_URL ?? "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "dummy" },
    });
  } catch (err) {
    code = typeof err.status === "number" ? err.status : 1;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  // A live-only step that refused for want of credentials is CANNOT-RUN, which
  // is neither a pass nor a failure of the branch. Anything else it does is.
  // The guard's own REFUSED banner, not a passing mention of an env var name.
  // A real finding can quote CI_SUPABASE_PROJECT_REF in its message; only the
  // banner means the process asserted its target and stopped before doing any
  // work, which is the one thing that makes a non-zero exit not a branch defect.
  const refused =
    step.kind === "liveonly" &&
    /\[(?:ciSupabaseGuard|ciProdReadOnlyAuditGuard)\] REFUSED|Nothing downstream of this point has run|no live credentials/i.test(output);
  const status = code === 0 ? "PASS" : refused ? "CANNOT-RUN" : "FAIL";
  // Keep the tail of a failing step's output. The first version of this command
  // reported six FAILs and not one line of WHY, so an operator had to re-run
  // each by hand to find out — which is a pipeline hiding a status by another
  // route: the verdict was visible and the reason was not. Tail rather than head
  // because these tools print their findings last.
  const excerpt =
    status === "FAIL"
      ? output.split("\n").filter((l) => l.trim().length > 0).slice(-FAIL_EXCERPT_LINES).join("\n")
      : "";
  results.push({ id: step.id, kind: step.kind, exit: code, status, ms: Date.now() - started, excerpt });
}

const pass = results.filter((r) => r.status === "PASS");
const fail = results.filter((r) => r.status === "FAIL");
const cannot = results.filter((r) => r.status === "CANNOT-RUN");

let headCommit = "unknown";
try { headCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a git tree */ }

const summary = {
  certified: fail.length === 0,
  head_commit: headCommit,
  generated_at: new Date().toISOString(),
  total: results.length,
  passed: pass.length,
  failed: fail.length,
  cannot_run: cannot.length,
  // Stated explicitly so nobody reads `certified: true` as "everything ran".
  cannot_run_note:
    "CANNOT-RUN steps need live database credentials and refused without them. They are NOT passes and are not " +
    "included in `passed`. A certification that silently dropped them would be reporting a smaller surface than it checked.",
  steps: results,
};

if (JSON_ONLY) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("");
  console.log(`Branch certification — HEAD ${headCommit.slice(0, 8)}`);
  console.log("".padEnd(64, "─"));
  for (const r of results) {
    const mark = r.status === "PASS" ? "✔" : r.status === "FAIL" ? "✘" : "•";
    console.log(`  ${mark} ${r.id.padEnd(34)} ${r.status.padEnd(11)} exit ${String(r.exit).padStart(3)}  ${String(r.ms).padStart(6)}ms`);
  }
  console.log("".padEnd(64, "─"));
  console.log(`  ${pass.length} passed, ${fail.length} failed, ${cannot.length} CANNOT-RUN (live credentials absent — not passes)`);
  console.log(`  CERTIFIED: ${summary.certified ? "YES" : "NO"}`);
  if (fail.length > 0) {
    console.log(`  failing: ${fail.map((f) => f.id).join(", ")}`);
    for (const f of fail) {
      console.log("");
      console.log(`── ${f.id} — exit ${f.exit}, last ${FAIL_EXCERPT_LINES} non-empty line(s) ${"".padEnd(10, "─")}`);
      console.log(f.excerpt || "  (the step failed and printed nothing — that is itself the finding)");
    }
  }
  console.log("");
  console.log(JSON.stringify({ certified: summary.certified, passed: pass.length, failed: fail.length, cannot_run: cannot.length, head_commit: headCommit }));
}

process.exit(fail.length === 0 ? 0 : 1);
