#!/usr/bin/env node
/**
 * check:compiler-authentic — prove the TypeScript compiler is real and can fail.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * On 2026-08-23 a branch was reported "typecheck clean" when it carried four
 * TS2345/TS2739 errors. The compiler had never run: `npx tsc` on that machine
 * resolved to the npm package literally named `tsc` — a decoy that prints
 * "This is not the tsc command you are looking for" and EXITS 0. Filtering its
 * output through grep for a filename produced silence, and silence read as
 * success.
 *
 * A version banner is not enough to catch that, because a decoy can print
 * anything. The only conclusive question is behavioural:
 *
 *     does this compiler REJECT a program it must reject?
 *
 * A tool that exits 0 on a file containing a type error is not a type checker,
 * whatever it calls itself. So this guard compiles two fixtures — one that must
 * pass and one that must fail — and demands the expected exit code from each.
 * It is the same principle as the repo's other guards: a check that cannot fail
 * is not a check.
 *
 * ── WHAT IT DOES NOT COVER ──────────────────────────────────────────────────
 *   * whether tsconfig.json is strict enough — a real compiler configured
 *     loosely still passes here, and should;
 *   * any compiler other than the one this package resolves. That is the point:
 *     it pins the check to the binary the `typecheck` script will actually use.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Resolve the compiler the same way the package script does: from this package. */
function resolveCompiler() {
  try {
    // typescript's own entry point, resolved through node's algorithm from HERE.
    const pkg = require.resolve("typescript/package.json");
    const version = require(pkg).version;
    const bin = join(pkg.replace(/package\.json$/, ""), "bin", "tsc");
    return { bin, version };
  } catch {
    console.error(
      "::error::check:compiler-authentic — `typescript` does not resolve from artifacts/api-server.\n" +
      "  The typecheck script would fall back to whatever `tsc` PATH happens to offer, which is exactly\n" +
      "  the resolution behaviour that let a decoy compiler report success. Declare typescript in this\n" +
      "  package's devDependencies rather than relying on workspace hoisting.",
    );
    process.exit(1);
  }
}

const { bin, version } = resolveCompiler();

const CLEAN = "export const n: number = 1;\n";
// TS2322: string is not assignable to number. Any real checker rejects this.
const BROKEN = "export const n: number = 'not a number';\n";

function compile(source, name) {
  const dir = mkdtempSync(join(tmpdir(), "tsc-authentic-"));
  try {
    const file = join(dir, name);
    writeFileSync(file, source);
    const r = spawnSync(process.execPath, [bin, "--noEmit", "--strict", file], {
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const problems = [];

if (!/^\d+\.\d+\.\d+/.test(version)) {
  problems.push(`typescript resolves to version "${version}", which is not a release version.`);
}

const clean = compile(CLEAN, "clean.ts");
if (clean.status !== 0) {
  problems.push(
    `the compiler REJECTED a valid program (exit ${clean.status}). It is not usable as a checker.\n` +
    `        ${clean.out.trim().split("\n").slice(0, 3).join("\n        ")}`,
  );
}

const broken = compile(BROKEN, "broken.ts");
if (broken.status === 0) {
  problems.push(
    "the compiler ACCEPTED a program with a type error (exit 0). This is the decoy signature:\n" +
    "        a tool that cannot fail cannot verify anything, and every green it produces is meaningless.\n" +
    `        resolved binary: ${bin}`,
  );
} else if (!/TS2322/.test(broken.out)) {
  problems.push(
    `the compiler rejected the broken fixture but did not report TS2322 — it may not be TypeScript.\n` +
    `        output: ${broken.out.trim().slice(0, 200)}`,
  );
}

if (problems.length > 0) {
  console.error("\n✗ check:compiler-authentic FAILED\n");
  for (const p of problems) console.error(`   - ${p}`);
  console.error(
    "\n  The typecheck job's result cannot be trusted while this fails. Fix the compiler\n" +
    "  resolution before reading anything into a green typecheck.\n",
  );
  process.exit(1);
}

console.log(
  `check:compiler-authentic: TypeScript ${version} resolved from this package\n` +
  `   ✓ accepts a valid program\n` +
  `   ✓ rejects a type error with TS2322 — the compiler can fail, so its green means something\n`,
);
