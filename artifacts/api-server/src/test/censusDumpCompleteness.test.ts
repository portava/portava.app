/**
 * THE DUMP MUST ARRIVE WHOLE, and the reason this file exists is a defect that
 * corrupted the one authoritative record for Discovery compliance.
 *
 * `checkCensusIntegrity.ts` in `CENSUS_INTEGRITY_DUMP` mode is the only machine
 * source of verdicts in this repository. `buildDiscoveryLedger.ts` reads it
 * through `execFileSync`, which means A PIPE, and every human reading uses
 * `| grep`, which also means a pipe. On a pipe Node's `console.log` is
 * asynchronous, so the `process.exit(0)` at the end of the dump block discarded
 * whatever had not been flushed.
 *
 * The count on stderr is computed BEFORE the write, so it stayed truthful while
 * the bytes did not. Three consecutive runs on an unchanged tree rebuilt the
 * ledger with 177, 36 and 36 of Discovery's 187 requirements. Nothing failed.
 * Nothing was logged. The ledger simply disagreed with the census it claims it
 * "can never disagree with", and the field that would have shown it — `total` —
 * is one nobody compares between runs.
 *
 * WHAT WOULD TURN THIS RED: the dump block going back to `console.log` in a
 * loop, or anything else that lets `process.exit()` race a buffered write. The
 * assertion is deliberately not "187 rows" — that is a number that legitimately
 * moves with every census edit. It is "the transcript agrees with its own
 * declared count", which is true for every corpus and false for every truncation.
 *
 * Run: node --import tsx/esm --test src/test/censusDumpCompleteness.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join("src", "scripts", "checkCensusIntegrity.ts");

/** Runs the dump exactly as every consumer does: stdout is a PIPE, not a tty. */
function dump(filter: string): { rows: string[]; declared: number } {
  const r = spawnSync("node", ["--import", "tsx/esm", SCRIPT], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: { ...process.env, CENSUS_INTEGRITY_DUMP: filter },
    maxBuffer: 1 << 28,
    timeout: 300_000,
  });
  assert.equal(r.status, 0, `dump exited ${r.status}\n${r.stderr?.slice(-2000)}`);
  const m = /CENSUS_INTEGRITY_DUMP=[A-Z,\s]+: (\d+) row\(s\)/.exec(r.stderr ?? "");
  assert.ok(m, `stderr did not declare a row count:\n${(r.stderr ?? "").slice(-2000)}`);
  const rows = (r.stdout ?? "").split("\n").filter((l) => /^[a-z0-9-]+\|/.test(l));
  return { rows, declared: Number(m[1]) };
}

describe("CENSUS_INTEGRITY_DUMP — the transcript must agree with its own count", () => {
  it("delivers every row it says it delivered, over a pipe, five runs running", () => {
    // Five, because the truncation is a race: it reproduced 2 times in 3 under
    // load and 0 times in 3 on an idle box. One run is not evidence of absence.
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { rows, declared } = dump("ALL");
      assert.equal(
        rows.length, declared,
        `run ${i + 1}: stderr declared ${declared} row(s) and stdout carried ${rows.length}. ` +
          `A dump that undercounts is INDISTINGUISHABLE from a corpus that shrank — ` +
          `which is exactly how the Discovery ledger lost 151 of its 187 requirements without failing.`,
      );
      seen.push(rows.length);
    }
    assert.equal(
      new Set(seen).size, 1,
      `the same tree produced different row counts across five runs: ${seen.join(", ")}. ` +
        `The dump is not deterministic, so nothing built from it is either.`,
    );
  });

  it("every line is well formed, so a half-written line cannot pass as a row", () => {
    const { rows } = dump("ALL");
    assert.ok(rows.length > 0, "the corpus is not empty");
    for (const line of rows) {
      const parts = line.split("|");
      assert.equal(parts.length, 4, `not a 4-field row: ${JSON.stringify(line)}`);
      assert.match(parts[3], /^\d+$/, `line number is not a number: ${JSON.stringify(line)}`);
      assert.ok(
        ["C", "W", "N", "X"].includes(parts[2]),
        `verdict outside the vocabulary: ${JSON.stringify(line)}`,
      );
    }
  });

  /**
   * THE CASE THE SUITE ABOVE CANNOT SEE.
   *
   * `dump()` uses spawnSync, and spawnSync's stdout pipe is drained by libuv in
   * the parent. That is NOT how a person reads this tool. A person writes
   *
   *     CENSUS_INTEGRITY_DUMP=ALL npm run -s check:census-integrity | grep ...
   *
   * which is a SHELL pipeline: the shell creates the pipe, and node's fd 1 is a
   * plain pipe end. Under `--import tsx` that fd delivers exactly one 64 KiB
   * pipe buffer and silently discards the rest, while `fs.writeSync` RETURNS THE
   * FULL BYTE COUNT — it reports a write it did not perform. The dump crossed
   * 64 KiB long ago, so every such reading has been truncated mid-line.
   *
   * This case builds the pipeline with `sh -c` so the shape under test is the
   * shape people actually run.
   */
  it("delivers every row through a REAL SHELL PIPELINE, not just a drained spawnSync pipe", () => {
    const r = spawnSync("sh", ["-c", `node --import tsx/esm '${SCRIPT}' | cat`], {
      cwd: API_ROOT,
      encoding: "utf8",
      env: { ...process.env, CENSUS_INTEGRITY_DUMP: "ALL" },
      maxBuffer: 1 << 28,
      timeout: 300_000,
    });
    const m = /CENSUS_INTEGRITY_DUMP=[A-Z,\s]+: (\d+) row\(s\)/.exec(r.stderr ?? "");
    assert.ok(m, `stderr did not declare a row count:\n${(r.stderr ?? "").slice(-2000)}`);
    const declared = Number(m[1]);
    const text = r.stdout ?? "";
    const rows = text.split("\n").filter((l) => /^[a-z0-9-]+\|/.test(l));
    assert.equal(
      rows.length, declared,
      `through a shell pipeline stderr declared ${declared} row(s) and stdout carried ${rows.length} ` +
        `(${text.length} bytes). A dump that stops at a pipe-buffer boundary is INDISTINGUISHABLE from ` +
        `a corpus that shrank, and it is how every human reads this tool.`,
    );
    // A truncation lands mid-line, so the last line is a fragment. Assert the
    // transcript ENDS cleanly as well as counting right: a cut that happened to
    // fall on a newline would pass the count check on a filtered dump.
    assert.ok(text.endsWith("\n"), "the transcript does not end with a newline — it was cut mid-line");
  });

  it("a filter that matches nothing REFUSES rather than reporting an empty corpus", () => {
    const r = spawnSync("node", ["--import", "tsx/esm", SCRIPT], {
      cwd: API_ROOT, encoding: "utf8",
      env: { ...process.env, CENSUS_INTEGRITY_DUMP: "Q" },
      maxBuffer: 1 << 28, timeout: 300_000,
    });
    assert.equal(r.status, 1, "a filter matching no rows must exit non-zero");
    assert.match(r.stderr ?? "", /matched no rows/);
  });
});
