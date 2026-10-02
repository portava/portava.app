/**
 * The suite runs on the Node major the repo deploys and CI tests on.
 *
 * The major is stated in several places: `.replit` (`modules = ["nodejs-N", …]`,
 * the deployment) and the `NODE_VERSION` of every workflow under
 * .github/workflows (ci.yml says its pin is sourced from .replit). The web
 * session hook (.claude/hooks/session-start.sh) reads it from .replit too.
 * They must agree, and the runtime executing this suite must be at least that
 * major. docs/ci/README.md § "Runtime environment" recorded that nothing
 * in-repo objected when they did not.
 *
 * WHY THIS IS A TEST. On Node 22, `node --import tsx/esm` loads a nested
 * require() of a CommonJS-scope `.ts` module natively (require(esm) with type
 * stripping) instead of through tsx. A travel-buddy-standalone module that
 * imports another then cannot load: discoveryClientRouteE2E fails with "does
 * not provide an export named 'truncateDisplayName'" although
 * travel-buddy-standalone/src/utils/identity.ts exports it (census-discovery
 * §76.5), and the standalone's own node:test files fail with
 * ERR_REQUIRE_CYCLE_MODULE. That message has been read as a missing export
 * more than once. This test fails with the real reason instead.
 *
 * Run: node --import tsx/esm --test src/test/nodeRuntimePin.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

/** The deployment's Node major, from `.replit`'s `nodejs-N` module. */
function replitPin(): number {
  const m = read(".replit").match(/^modules\s*=\s*\[[^\]]*"nodejs-(\d+)"/m);
  assert.ok(m, '.replit declares no "nodejs-N" module');
  return Number(m[1]);
}

describe("Node runtime pin — .replit, CI and the running process agree", () => {
  it("every workflow's NODE_VERSION is .replit's nodejs major", () => {
    const pin = replitPin();
    const workflows = readdirSync(join(REPO, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f));
    const pinned = workflows
      .map((f) => ({ f, m: read(join(".github", "workflows", f)).match(/^\s*NODE_VERSION:\s*['"]?(\d+)/m) }))
      .filter((w) => w.m);
    assert.ok(pinned.some((w) => w.f === "ci.yml"), "ci.yml no longer declares NODE_VERSION");
    for (const { f, m } of pinned) {
      assert.equal(Number(m![1]), pin, `.github/workflows/${f} pins Node ${m![1]}; .replit deploys nodejs-${pin}`);
    }
  });

  it("the web session hook takes its pin from .replit, not a literal of its own", () => {
    const hook = read(".claude/hooks/session-start.sh");
    assert.match(hook, /\.replit/, "the session hook must read the Node major from .replit");
    assert.doesNotMatch(hook, /\bv?2[0-9]\.[0-9]+\.[0-9]+\b/, "the session hook must not hard-code a Node version");
  });

  it("this process runs on at least that major", () => {
    const pin = replitPin();
    const major = Number(process.versions.node.split(".")[0]);
    assert.ok(
      major >= pin,
      `Node ${process.versions.node} is below the repo's pin (${pin}: .replit, every workflow). ` +
        `On Node 22, travel-buddy-standalone modules that import one another cannot load under tsx/esm, ` +
        `so discoveryClientRouteE2E fails with a misleading "does not provide an export named" error ` +
        `(census-discovery §76.5). Run the suite on Node ${pin}.`,
    );
  });
});
