/**
 * The tree-mutation lock is per CHECKOUT.
 *
 * `helpers/treeMutationLock.ts` serialises the suites that mutate the real
 * source tree against the suites that scan it. Its lock directory used to be one
 * fixed name under the temp directory, shared by every checkout on a machine, so
 * two worktrees under test at once starved each other and the loser failed with
 * cancellations that looked like a finding. These cases pin the property that
 * fixes it — and the one it must not lose: the same tree still gets ONE lock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { treeLockDirFor } from "./helpers/treeMutationLock.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API_ROOT = resolve(HERE, "../..");

describe("tree-mutation lock — one per checkout", () => {
  it("two different trees get two different lock directories", () => {
    const a = treeLockDirFor("/work/checkout-a/artifacts/api-server", "/tmp/x");
    const b = treeLockDirFor("/work/checkout-b/artifacts/api-server", "/tmp/x");
    assert.notEqual(a, b);
  });

  it("the same tree gets the same lock however its path is spelled", () => {
    const a = treeLockDirFor("/work/checkout-a/artifacts/api-server", "/tmp/x");
    const b = treeLockDirFor("/work/checkout-a/artifacts/../artifacts/api-server/", "/tmp/x");
    assert.equal(a, b, "one tree must have ONE lock, or the suites it serialises stop taking turns");
  });

  it("the lock lives directly under the temp directory it was given", () => {
    const d = treeLockDirFor("/work/checkout-a/artifacts/api-server", "/tmp/x");
    assert.match(d, /^\/tmp\/x\/portava-tree-mutation-[0-9a-f]{16}\.lock$/);
  });

  it("CONTROL — the real helper, in a real process, creates the lock for THIS tree and removes it", () => {
    // Run acquire/release in a child whose temp directory is ours alone, so the
    // assertion is about the directory the helper really makes, not about the
    // pure function above agreeing with itself.
    const tmp = mkdtempSync(join(tmpdir(), "treelock-"));
    try {
      const script =
        `import { acquireTreeLock } from ${JSON.stringify(join(HERE, "helpers/treeMutationLock.ts"))};` +
        `import { readdirSync } from "node:fs";` +
        `const release = await acquireTreeLock("per-checkout-control");` +
        // tsx keeps its own cache directory in the same temp directory; only lock directories are the subject here.
        `process.stdout.write(JSON.stringify(readdirSync(${JSON.stringify(tmp)}).filter((n) => n.startsWith("portava-tree-mutation"))));` +
        `release();`;
      const r = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
        cwd: API_ROOT,
        env: { ...process.env, TMPDIR: tmp },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      const held = JSON.parse(r.stdout) as string[];
      const expected = treeLockDirFor(API_ROOT, tmp);
      assert.deepEqual(held, [expected.slice(tmp.length + 1)], "while held, exactly this tree's lock exists");
      assert.equal(existsSync(expected), false, "released");
      assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("portava-tree-mutation")), [], "no lock is left behind");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
