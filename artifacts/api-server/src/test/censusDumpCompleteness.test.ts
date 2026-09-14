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
