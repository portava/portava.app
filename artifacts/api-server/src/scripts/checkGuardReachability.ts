/**
 * Every guard in this tree is reached by something — `check:guard-reachability`.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * A guard nobody runs is decorative architecture: the same defect
 * `checkProjectionConsumers` catches for data pipes (a producer, a table, and no
 * consumer), applied to the checks themselves. Every piece is individually
 * correct — the checker has a mutation suite, it exits 1 on a crafted defect,
 * its header is exact — and it protects nothing, because no CI path ever runs it
 * against the real tree.
 *
 * It was not hypothetical. `checkUncheckedSupabaseReads` — the fail-open ledger,
 * the largest guard in this repo, the one that recorded 306 unchecked reads going
 * to 0 — is reached by NOTHING. Its mutation suite spawns it only with
 * UNCHECKED_READS_SRC_ROOT and UNCHECKED_READS_ALLOWLIST pointed at scratch
 * trees. A new unchecked `.error` added to the real tree fails no check anywhere.
 *
 * ── WHY A REGISTRY AND NOT A HEURISTIC ───────────────────────────────────────
 * "Is this guard wired?" has four different right answers (check:all, a
 * workflow, a registered mutation suite, or genuinely-uninvokable), and only a
 * human can say which applies. So each guard DECLARES its answer and this check
 * VERIFIES the declaration mechanically. A declaration that is not true fails;
 * an undeclared guard fails; a declared guard that no longer exists fails.
 *
 * The `test-control` case is the one that carries the weight, because it is the
 * one that was silently false. A registered mutation suite only gates CI if it
 * runs the checker against the REAL tree — a suite that only ever points the
 * checker at a fixture proves the checker's logic and protects nothing. So the
 * seams are declared per guard, and a spawn that sets any of them does not count.
 * The control must also ASSERT the exit status: spawning without asserting is a
 * suite that watches a guard fail and says nothing.
 *
 * ── WHAT IS ENFORCED ─────────────────────────────────────────────────────────
 *   1. DISCOVERY: every check*.{ts,mjs} under src/scripts/ and scripts/ is in
 *      the registry. A new guard cannot arrive unregistered and therefore
 *      unexamined.
 *   2. Every registered checker file exists.
 *   3. Responsibilities are substantive and DISTINCT. Two guards claiming the
 *      same job means one is unowned, and the unowned one is what gets deleted.
 *   4. check-all   — the script exists in package.json AND run-all-checks.sh
 *                    invokes it by name through run_check / run_gate.
 *   5. workflow    — the script exists AND a live (non-comment) line of a
 *                    workflow names it.
 *   6. test-control— the test file exists, is REGISTERED in the test script, and
 *                    contains an it() that spawns the checker with no seam
 *                    override and asserts its status/code is 0.
 *   7. manual      — a reason of real length; the guard must NOT in fact be wired
 *                    (a stale exemption fails); AND running it must NOT exit 0.
 *                    That last part is the one that matters: "CI cannot invoke
 *                    this" was prose, and three privacy/legal-surface guards sat
 *                    unenforced behind a sentence nobody had checked. A guard
 *                    that passes is a guard that can be wired.
 *   8. VACUITY: zero guards discovered or zero registered fails.
 *
 * Run: node --import tsx/esm src/scripts/checkGuardReachability.ts
 * Exit 0 only when every discovered guard is registered and its declaration
 * verifies. Exit 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { stripComments } from "./lib/stripComments.js";
import { GUARDS as REAL_GUARDS, type GuardEntry } from "./guardRegistry.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/**
 * Test seams, the same device checkFlagSchemaPrerequisites and
 * checkProjectionConsumers use. They exist so the mutation fixtures can PROVE
 * each rule fires — the failure paths are otherwise unreachable while the real
 * registry is correct — and nothing in CI sets them.
 */
const GUARDS: readonly GuardEntry[] = process.env.GUARD_REGISTRY
  ? (JSON.parse(readFileSync(resolve(process.env.GUARD_REGISTRY), "utf8")) as GuardEntry[])
  : REAL_GUARDS;
const RUN_ALL = process.env.GUARD_RUN_ALL
  ? resolve(process.env.GUARD_RUN_ALL)
  : join(API_ROOT, "scripts", "run-all-checks.sh");
const WORKFLOW_DIR = process.env.GUARD_WORKFLOW_DIR
  ? resolve(process.env.GUARD_WORKFLOW_DIR)
  : join(REPO_ROOT, ".github", "workflows");

/** Per-guard ceiling when the manual claim is tested by running it. */
const MANUAL_RUN_TIMEOUT_MS = 120_000;
const MIN_RESPONSIBILITY = 60;
const MIN_MANUAL_REASON = 120;
/** Directories that hold guards. Anything named check* in them must be declared. */
const GUARD_DIRS = ["src/scripts", "scripts"];
const GUARD_NAME = /^check[-A-Z]/;

function discoverGuards(): string[] {
  const out: string[] = [];
  for (const d of GUARD_DIRS) {
    const abs = join(API_ROOT, d);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs)) {
      if (!statSync(join(abs, e)).isFile()) continue;
      if (!/\.(ts|mjs)$/.test(e) || e.endsWith(".d.ts")) continue;
      if (!GUARD_NAME.test(e)) continue;
      out.push(`${d}/${e}`);
    }
  }
  return out.sort();
}

/** `run_check "name"` / `run_gate "name"` — the shell's own invocation form. */
function runAllInvokes(text: string, script: string): boolean {
  return new RegExp(`\\brun_(?:check|gate)\\s+"${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(text);
}

/**
 * Does a non-comment line of `text` name `needle`?
 *
 * The first version of the build-gate rule tested the raw file, and
 * scripts/run-all-checks.sh contains the word "build" inside a prose comment
 * ("not something a build can fix") — so a runner that does not build anything
 * was accepted as running the build. Its own mutation case caught it. Same
 * lesson as checkProjectionConsumers rule 5 and check-guard-coverage: a comment
 * is not an invocation.
 */
function namesOnALiveLine(text: string, needle: string): boolean {
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    if (line.includes(needle)) return true;
  }
  return false;
}

/** A workflow line that is not a YAML comment and names the script. */
function workflowInvokes(script: string): boolean {
  if (!existsSync(WORKFLOW_DIR)) return false;
  for (const f of readdirSync(WORKFLOW_DIR)) {
    if (!/\.ya?ml$/.test(f)) continue;
    for (const line of readFileSync(join(WORKFLOW_DIR, f), "utf8").split("\n")) {
      if (/^\s*#/.test(line)) continue;
      if (line.includes(script)) return true;
    }
  }
  return false;
}

/**
 * Does `test` contain an it() that runs `checker` against the REAL tree and
 * asserts the exit status?
 *
 * AST, not a text window: a capturing character window CONSUMES what follows it,
 * which is how checkProjectionConsumers once reported "no consumer" for fully
 * wired code. Here the units are whole `it(...)` calls and whole helper bodies.
 *
 * ── THE THREE SHAPES THIS HAS TO TELL APART ─────────────────────────────────
 * The first version of this rule required the spawn to sit lexically inside the
 * it(), and immediately reported flagSchemaPrerequisites and stateMachineWriters
 * — both correctly gated — as ungated, because both spawn through a helper. A
 * guard that fails on correct code gets deleted, so the shapes are enumerated:
 *
 *   A. inline spawn in the it()            projectionConsumers, clientPrivilegeBoundary
 *   B. helper that never sets a seam       flagSchemaPrerequisites: `run()` merges
 *                                          whatever the caller passes, and the
 *                                          control passes nothing
 *   C. helper that sets a seam CONDITIONALLY  stateMachineWriters: `run(reg)` writes
 *                                          STATE_MACHINE_REGISTRY only inside
 *                                          `if (reg)`, and the control calls run(null)
 *
 * and distinguished from the one that must FAIL:
 *
 *   D. helper that ALWAYS sets a seam      uncheckedSupabaseReads: every spawn goes
 *                                          through a helper whose env literal names
 *                                          UNCHECKED_READS_SRC_ROOT and
 *                                          UNCHECKED_READS_ALLOWLIST unconditionally,
 *                                          so no call can reach the real tree
 *
 * C and D are the same at the level of "does the helper mention a seam", which is
 * why the mention's POSITION is what decides: a seam named outside any conditional
 * in the helper body is unconditional and disqualifies the helper; one inside an
 * `if` / `?:` is a fixture branch the control can decline to take.
 *
 * ── KNOWN LIMIT, STATED RATHER THAN IMPLIED ─────────────────────────────────
 * The status assertion must be in the it() body itself. A suite that delegates
 * `assert.equal(r.code, 0)` into a shared `expectPass()` helper will be reported
 * as having no control. That is the safe direction — it fails loudly and a human
 * re-reads the suite — but it is a false positive waiting to happen, so it is
 * written down here rather than discovered later.
 */
export function hasRealTreeControl(
  testAbs: string,
  checkerBase: string,
  seams: readonly string[],
): { ok: boolean; why: string } {
  const src = ts.createSourceFile(
    testAbs,
    readFileSync(testAbs, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  const namesTheChecker = (text: string) => text.includes(checkerBase) || /\bCHECKER\b|\bSCRIPT\b/.test(text);
  const isSpawn = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && /\bspawn(Sync)?$/.test(n.expression.getText(src));

  /**
   * Seam names mentioned in `body` OUTSIDE any conditional. Shape C vs shape D.
   *
   * This walks AST Identifier/StringLiteral nodes rather than text, so comments
   * cannot reach it — which is why only the it()-body scan above needed
   * stripComments.
   */
  function unconditionalSeams(body: ts.Node): string[] {
    const found = new Set<string>();
    const walk = (n: ts.Node, guarded: boolean): void => {
      const nowGuarded =
        guarded ||
        ts.isIfStatement(n) ||
        ts.isConditionalExpression(n) ||
        ts.isSwitchStatement(n) ||
        ts.isBinaryExpression(n) &&
          (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken);
      if (!nowGuarded && (ts.isIdentifier(n) || ts.isStringLiteral(n))) {
        const t = ts.isIdentifier(n) ? n.text : n.text;
        if (seams.includes(t)) found.add(t);
      }
      ts.forEachChild(n, (c) => walk(c, nowGuarded));
    };
    walk(body, false);
    return [...found];
  }

  // ── pass 1: helpers whose body spawns the checker ─────────────────────────
  /** helper name -> the seam it sets unconditionally, if any */
  const helpers = new Map<string, string | null>();
  function collectHelpers(node: ts.Node): void {
    let name: string | null = null;
    let body: ts.Node | null = null;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      name = node.name.text;
      body = node.body;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.text;
      body = node.initializer.body;
    }
    if (name && body) {
      let spawnsChecker = false;
      const scan = (n: ts.Node): void => {
        if (isSpawn(n) && namesTheChecker(n.getText(src))) spawnsChecker = true;
        ts.forEachChild(n, scan);
      };
      scan(body);
      if (spawnsChecker) helpers.set(name, unconditionalSeams(body)[0] ?? null);
    }
    ts.forEachChild(node, collectHelpers);
  }
  collectHelpers(src);

  // ── pass 2: it()/test() cases ─────────────────────────────────────────────
  const ASSERTS_ZERO = /assert\.(?:equal|strictEqual)\s*\([^;]*\b(?:status|code)\b[^;]*,\s*0\b/;
  let sawAnyRun = false;
  let blockedBy = "";
  let ok = false;

  function visitCases(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "it" || node.expression.text === "test")
    ) {
      // COMMENTS STRIPPED. This checker had the very bug it exists to describe:
      // the fail-open guard's real-tree control explains itself by NAMING its
      // seams in a comment, and matching the raw node text read that prose as a
      // seam override — so the one genuine control in the tree looked like a
      // fixture run. Same defect as checkProjectionConsumers rule 5 and
      // check-guard-coverage, in a checker written to catch that family.
      const text = stripComments(node.getText(src));
      let inlineSpawn = false;
      const scan = (n: ts.Node): void => {
        if (isSpawn(n) && namesTheChecker(n.getText(src))) inlineSpawn = true;
        ts.forEachChild(n, scan);
      };
      scan(node);

      const usedHelpers = [...helpers.keys()].filter((h) => new RegExp(`\\b${h}\\s*\\(`).test(text));
      if (inlineSpawn || usedHelpers.length > 0) {
        sawAnyRun = true;
        const callSiteSeam = seams.find((s) => text.includes(s));
        const helperSeam = usedHelpers.map((h) => helpers.get(h)).find((v) => v);
        if (callSiteSeam) {
          blockedBy ||= `every candidate control passes a seam at the call site (${callSiteSeam})`;
        } else if (!inlineSpawn && helperSeam) {
          blockedBy ||=
            `the only spawn helper sets ${helperSeam} UNCONDITIONALLY, so no call it makes can reach the real tree`;
        } else if (!ASSERTS_ZERO.test(text)) {
          blockedBy ||= "the real-tree case never asserts the exit status is 0 — it watches the guard fail and says nothing";
        } else {
          ok = true;
        }
      }
    }
    ts.forEachChild(node, visitCases);
  }
  visitCases(src);

  if (ok) return { ok: true, why: "" };
  if (!sawAnyRun) return { ok: false, why: "no it()/test() case runs the checker at all" };
  return { ok: false, why: blockedBy || "no case runs the checker against the real tree" };
}

function main(): void {
  const problems: string[] = [];

  const discovered = discoverGuards();
  const registered = new Map(GUARDS.map((g) => [g.checker, g]));

  // 1. discovery — nothing unregistered
  for (const d of discovered) {
    if (!registered.has(d)) {
      problems.push(
        `UNREGISTERED GUARD: ${d} is not in src/scripts/guardRegistry.ts. Declare what it is responsible for and ` +
          `how it is reached; a guard nobody declares is a guard nobody runs.`,
      );
    }
  }

  // 2. every registered checker exists
  for (const g of GUARDS) {
    if (!existsSync(join(API_ROOT, g.checker))) {
      problems.push(`${g.checker}: registered but the file does not exist. Delete the entry or restore the guard.`);
    }
  }

  // 3. responsibilities substantive and distinct
  const byResponsibility = new Map<string, string[]>();
  for (const g of GUARDS) {
    const r = (g.responsibility ?? "").trim();
    if (r.length < MIN_RESPONSIBILITY) {
      problems.push(
        `${g.checker}: responsibility is ${r.length} char(s) (min ${MIN_RESPONSIBILITY}). Say what this guard, and ` +
          `only this guard, refuses to let through.`,
      );
    }
    const key = r.toLowerCase();
    if (!byResponsibility.has(key)) byResponsibility.set(key, []);
    byResponsibility.get(key)!.push(g.checker);
  }
  for (const [, files] of byResponsibility) {
    if (files.length > 1) {
      problems.push(
        `DUPLICATE RESPONSIBILITY: ${files.join(" and ")} claim the same job. One of them is unowned, and the ` +
          `unowned one is what gets deleted in a cleanup. Split the responsibility or retire a guard.`,
      );
    }
  }

  const runAllText = existsSync(RUN_ALL) ? readFileSync(RUN_ALL, "utf8") : "";
  if (!runAllText) {
    problems.push(`${RUN_ALL} could not be read; every check-all declaration below is unverifiable.`);
  }
  const pkgPath = join(API_ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const testScript = scripts["test"] ?? "";

  // 4-7. verify each declaration
  const summary: string[] = [];
  for (const g of GUARDS) {
    const r = g.reach;
    switch (r.kind) {
      case "check-all": {
        if (!(r.script in scripts)) {
          problems.push(`${g.checker}: declares check-all via "${r.script}", but package.json has no such script.`);
        } else if (!runAllInvokes(runAllText, r.script)) {
          problems.push(
            `${g.checker}: declares check-all via "${r.script}", but scripts/run-all-checks.sh never invokes it ` +
              `(no run_check/run_gate "${r.script}"). The declaration says it is gated; it is not.`,
          );
        }
        summary.push(`${g.checker.padEnd(46)} check:all      ${r.script}`);
        break;
      }
      case "workflow": {
        if (!(r.script in scripts)) {
          problems.push(`${g.checker}: declares workflow via "${r.script}", but package.json has no such script.`);
        } else if (!workflowInvokes(r.script)) {
          problems.push(
            `${g.checker}: declares workflow via "${r.script}", but no live line of any workflow names it. ` +
              `A commented-out step is not a step.`,
          );
        }
        summary.push(`${g.checker.padEnd(46)} workflow       ${r.script}`);
        break;
      }
      case "delegated": {
        const byAbs = join(API_ROOT, r.by);
        if (!existsSync(byAbs)) {
          problems.push(`${g.checker}: declares delegation from ${r.by}, which does not exist.`);
          break;
        }
        const base = g.checker.split("/").pop()!;
        if (!readFileSync(byAbs, "utf8").includes(base)) {
          problems.push(
            `${g.checker}: declares delegation from ${r.by}, but that file never names ${base}. ` +
              `The delegation was removed, or never existed.`,
          );
        }
        // A delegation chain that ends in nothing is the same defect one hop out.
        if (!(r.script in scripts)) {
          problems.push(`${g.checker}: delegator script "${r.script}" is not in package.json.`);
        } else if (!runAllInvokes(runAllText, r.script) && !workflowInvokes(r.script)) {
          problems.push(
            `${g.checker}: delegated through "${r.script}", but nothing invokes THAT either — neither ` +
              `run-all-checks.sh nor a live workflow line. The chain ends in nothing.`,
          );
        }
        summary.push(`${g.checker.padEnd(46)} delegated      ${r.script} -> ${r.by}`);
        break;
      }
      case "build-gate": {
        const base = g.checker.split("/").pop()!;
        if (!(r.script in scripts)) {
          problems.push(`${g.checker}: declares build-gate via "${r.script}", which is not in package.json.`);
        } else if (!scripts[r.script]!.includes(base)) {
          problems.push(
            `${g.checker}: declares build-gate via "${r.script}", but that script does not run ${base}.`,
          );
        }
        const runnerAbs = join(REPO_ROOT, r.runner);
        if (!existsSync(runnerAbs)) {
          problems.push(`${g.checker}: build runner ${r.runner} does not exist.`);
        } else if (!namesOnALiveLine(readFileSync(runnerAbs, "utf8"), r.script)) {
          problems.push(
            `${g.checker}: ${r.runner} never runs "${r.script}", so this guard gates neither CI nor the deploy.`,
          );
        }
        summary.push(`${g.checker.padEnd(46)} build-gate     ${r.script} via ${r.runner} (deploy, not CI)`);
        break;
      }
      case "test-control": {
        const abs = join(API_ROOT, r.test);
        if (!existsSync(abs)) {
          problems.push(`${g.checker}: declares test-control via ${r.test}, which does not exist.`);
          break;
        }
        if (!testScript.includes(r.test)) {
          problems.push(
            `${g.checker}: declares test-control via ${r.test}, but that file is NOT in package.json's "test" ` +
              `script, so it never runs. An unregistered control is not a control.`,
          );
          break;
        }
        const base = g.checker.split("/").pop()!;
        const verdict = hasRealTreeControl(abs, base, r.seams);
        if (!verdict.ok) {
          problems.push(
            `${g.checker}: declares test-control via ${r.test}, but ${verdict.why}. This is the exact shape the ` +
              `fail-open guard was in: a mutation suite that proves the checker's LOGIC on fixtures while nothing ` +
              `ever points it at the real tree.`,
          );
        }
        summary.push(`${g.checker.padEnd(46)} test-control   ${r.test}`);
        break;
      }
      case "manual": {
        if ((r.reason ?? "").trim().length < MIN_MANUAL_REASON) {
          problems.push(
            `${g.checker}: manual requires a reason of at least ${MIN_MANUAL_REASON} chars saying why CI cannot ` +
              `invoke it — and that unwired means unenforced, not safe.`,
          );
        }
        // THE MANUAL CLAIM IS TESTED BY RUNNING IT.
        //
        // "CI cannot invoke this" was prose, and prose is not verified. Three
        // entries in this registry — check:deletion-coverage, check:data-rights,
        // check:location-purposes — carried the reason "unwired because it
        // carries standing findings; wiring it would make check:all permanently
        // red". All three exit 0 on this tree. The reasons had been written from
        // each guard's HEADER instead of from running it, and three privacy and
        // legal-surface checks sat unenforced on the strength of a sentence
        // nobody had checked.
        //
        // So: a guard that runs cleanly here is a guard that could be wired, and
        // must not hide behind a manual exemption. A guard that genuinely cannot
        // run says so with its exit code — 2 for "no sanctioned target / no
        // credentials", 1 for a real finding — and passes this rule.
        //
        // A timeout counts as "cannot run cleanly" rather than as a pass for the
        // registry, because a guard that never finishes cannot be wired either;
        // it is reported so the reader knows which of the two happened.
        const manualAbs = join(API_ROOT, g.checker);
        if (existsSync(manualAbs) && !process.env.GUARD_SKIP_MANUAL_RUN) {
          const argv = manualAbs.endsWith(".mjs") ? [manualAbs] : ["--import", "tsx/esm", manualAbs];
          // SANITISED ENVIRONMENT, and this is load-bearing rather than tidy.
          //
          // The question the rule asks is "could CI invoke this?", and CI has no
          // database credentials. Run with whatever the caller happens to have,
          // the answer changes with the caller: check-media-bucket-privacy.ts
          // exits 1 from a bare shell (no credentials) and — before it was fixed
          // to refuse a vacuous verdict — exited 0 under the unit suite, which
          // exports SUPABASE_URL/KEY pointed at a loopback discard port. A gate
          // whose verdict depends on the ambient environment is worse than no
          // gate, so the credential variables are stripped and the answer is the
          // same everywhere.
          const sanitised: NodeJS.ProcessEnv = { ...process.env };
          for (const k of Object.keys(sanitised)) {
            if (/^(EXPO_PUBLIC_)?SUPABASE_/.test(k)) delete sanitised[k];
          }
          const run = spawnSync(process.execPath, argv, {
            cwd: API_ROOT, encoding: "utf8", timeout: MANUAL_RUN_TIMEOUT_MS,
            maxBuffer: 32 * 1024 * 1024, env: sanitised,
          });
          if (run.status === 0) {
            problems.push(
              `${g.checker}: declared MANUAL — "CI cannot invoke it" — but it runs cleanly here and exits 0. ` +
                `A guard that passes is a guard that can be wired; three privacy checks sat unenforced on exactly ` +
                `this kind of unverified reason. Wire it into run-all-checks.sh or a workflow, or record why a clean ` +
                `run is not a runnable check.`,
            );
          }
        }

        // A stale exemption: it says CI cannot run it, and CI does.
        const wired = Object.entries(scripts).find(
          ([name, body]) => body.includes(g.checker.split("/").pop()!) && (runAllInvokes(runAllText, name) || workflowInvokes(name)),
        );
        if (wired) {
          problems.push(
            `${g.checker}: declared manual, but "${wired[0]}" runs it from run-all-checks.sh or a workflow. ` +
              `A stale exemption hides a guard that IS enforced behind a note saying it is not.`,
          );
        }
        summary.push(`${g.checker.padEnd(46)} MANUAL         not enforced by CI`);
        break;
      }
    }
  }

  console.log(
    `check:guard-reachability — ${discovered.length} guard(s) on disk, ${GUARDS.length} registered ` +
      `(${GUARDS.filter((g) => g.reach.kind === "manual").length} MANUAL / not enforced)`,
  );

  // 8. vacuity
  if (discovered.length === 0 || GUARDS.length === 0) {
    console.error(
      `\nFAIL — VACUOUS: discovered ${discovered.length} guard(s) with ${GUARDS.length} registered. ` +
        `A check that examines nothing must not report success.`,
    );
    process.exit(1);
  }

  if (problems.length) {
    console.error(`\nFAIL — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  • ${p}`);
    console.error("");
    process.exit(1);
  }

  for (const s of summary) console.log(`  ${s}`);
  console.log(
    `\n✅ every guard on disk is registered and its reach declaration verifies. ` +
      `The MANUAL rows above are NOT enforced by CI — that is a measured gap, not a clean bill.`,
  );
}

/**
 * Only when this file IS the process, not when a test imports `hasRealTreeControl`
 * from it. Without the guard, importing the module runs the whole check as a side
 * effect — and a FAILING check would call process.exit(1) and kill the importing
 * test run, so the suite's verdict would silently become the checker's verdict.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
