import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/buildDiscoveryLedger.ts", import.meta.url));

function run(output: string, args: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, DISCOVERY_LEDGER_OUTPUT: output },
    timeout: 60_000,
  });
}

describe("Discovery compliance ledger freshness", () => {
  it("reconciles current census rows and never gives correct rows a blocker", () => {
    const directory = mkdtempSync(join(tmpdir(), "discovery-ledger-"));
    try {
      const output = join(directory, "ledger.json");
      const built = run(output);
      assert.equal(built.status, 0, built.stderr);
      const ledger = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(ledger.total, 188);
      assert.equal(ledger.rows.length, ledger.total);
      assert.equal(new Set(ledger.rows.map((row: { id: string }) => row.id)).size, ledger.total);
      const counts: Record<string, number> = {};
      for (const row of ledger.rows) {
        counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
        assert.equal(row.blocker === "NONE", row.verdict === "C");
      }
      assert.deepEqual(counts, ledger.byVerdict);
      const mainProtection = ledger.rows.find((row: { id: string }) => row.id === "DV-75");
      assert.equal(mainProtection.verdict, "C");
      assert.equal(mainProtection.blocker, "NONE");
      assert.equal(ledger.rows.find((row: { id: string }) => row.id === "DV-41").blocker, "OWNER_APPROVAL");
      assert.equal(ledger.rows.find((row: { id: string }) => row.id === "C32").blocker, "OBSERVATION_WINDOW");
      assert.equal(run(output, ["--check"]).status, 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refuses a missing or stale ledger without overwriting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "discovery-ledger-"));
    try {
      const output = join(directory, "ledger.json");
      assert.equal(run(output, ["--check"]).status, 1);
      const stale = '{"total":187}\n';
      writeFileSync(output, stale);
      const checked = run(output, ["--check"]);
      assert.equal(checked.status, 1);
      assert.match(checked.stderr, /missing or stale/);
      assert.equal(readFileSync(output, "utf8"), stale);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
