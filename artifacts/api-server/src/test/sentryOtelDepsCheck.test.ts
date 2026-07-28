/**
 * Sentry ↔ OpenTelemetry drift guard — unit tests
 *
 * Tests the semver-range comparison logic embedded in checkSentryOtelDeps.ts
 * and verifies that the check passes against the currently installed packages
 * (i.e. the integration test — if this fails in CI, drift has already occurred).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dir, "../..");

// ── Inline the satisfies() logic so we can unit-test it independently ─────────
// Duplicated intentionally: the test must not import the script (it calls
// process.exit at module level).

function parseVersion(v: string): [number, number, number] | null {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function cmp(
  a: [number, number, number],
  b: [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function satisfies(installed: string, range: string): boolean {
  const iv = parseVersion(installed);
  if (!iv) return true;
  const [iMaj, iMin, iPat] = iv;

  for (const part of range.trim().split(/\s+/)) {
    if (!part) continue;

    if (part.startsWith("^")) {
      const rv = parseVersion(part.slice(1));
      if (!rv) continue;
      const [rMaj, rMin, rPat] = rv;
      if (rMaj !== 0) {
        if (iMaj !== rMaj) return false;
        if (cmp(iv, rv) < 0) return false;
      } else if (rMin !== 0) {
        if (iMaj !== 0 || iMin !== rMin) return false;
        if (cmp(iv, rv) < 0) return false;
      } else {
        if (iMaj !== 0 || iMin !== 0 || iPat !== rPat) return false;
      }
    } else if (part.startsWith("~")) {
      const rv = parseVersion(part.slice(1));
      if (!rv) continue;
      const [rMaj, rMin] = rv;
      if (iMaj !== rMaj || iMin !== rMin) return false;
      if (cmp(iv, rv) < 0) return false;
    } else if (part.startsWith(">=")) {
      const rv = parseVersion(part.slice(2));
      if (!rv) continue;
      if (cmp(iv, rv) < 0) return false;
    } else if (part.startsWith(">")) {
      const rv = parseVersion(part.slice(1));
      if (!rv) continue;
      if (cmp(iv, rv) <= 0) return false;
    } else if (part.startsWith("<=")) {
      const rv = parseVersion(part.slice(2));
      if (!rv) continue;
      if (cmp(iv, rv) > 0) return false;
    } else if (part.startsWith("<")) {
      const rv = parseVersion(part.slice(1));
      if (!rv) continue;
      if (cmp(iv, rv) >= 0) return false;
    } else {
      const rv = parseVersion(part);
      if (!rv) continue;
      if (cmp(iv, rv) !== 0) return false;
    }
  }

  return true;
}

// ── Unit tests for the range checker ─────────────────────────────────────────

describe("satisfies() — caret ranges", () => {
  it("accepts a matching minor bump", () => {
    assert.ok(satisfies("1.30.1", "^1.9.0"));
  });
  it("accepts exact match on caret", () => {
    assert.ok(satisfies("1.9.0", "^1.9.0"));
  });
  it("rejects a patch too low", () => {
    assert.ok(!satisfies("1.9.0", "^1.9.1"));
  });
  it("rejects a different major", () => {
    assert.ok(!satisfies("2.0.0", "^1.9.0"));
  });
  it("rejects a lower major", () => {
    assert.ok(!satisfies("0.57.1", "^1.9.0"));
  });
  it("accepts a higher minor+patch within same major", () => {
    assert.ok(satisfies("1.43.0", "^1.28.0"));
  });
  it("handles ^0.x.y — locks to minor", () => {
    assert.ok(satisfies("0.57.2", "^0.57.1"));
    assert.ok(!satisfies("0.58.0", "^0.57.1"));
    assert.ok(!satisfies("0.57.0", "^0.57.1"));
  });
  it("handles ^0.0.x — locks to patch", () => {
    assert.ok(satisfies("0.0.3", "^0.0.3"));
    assert.ok(!satisfies("0.0.4", "^0.0.3"));
    assert.ok(!satisfies("0.0.2", "^0.0.3"));
  });
});

describe("satisfies() — tilde ranges", () => {
  it("accepts same minor, higher patch", () => {
    assert.ok(satisfies("1.9.5", "~1.9.0"));
  });
  it("accepts exact match", () => {
    assert.ok(satisfies("1.9.0", "~1.9.0"));
  });
  it("rejects a lower patch", () => {
    assert.ok(!satisfies("1.9.0", "~1.9.1"));
  });
  it("rejects a higher minor", () => {
    assert.ok(!satisfies("1.10.0", "~1.9.0"));
  });
});

describe("satisfies() — exact versions", () => {
  it("accepts identical version", () => {
    assert.ok(satisfies("0.47.0", "0.47.0"));
  });
  it("rejects a different patch", () => {
    assert.ok(!satisfies("0.47.1", "0.47.0"));
  });
  it("rejects a different minor", () => {
    assert.ok(!satisfies("0.46.0", "0.47.0"));
  });
});

describe("satisfies() — gte / range", () => {
  it("accepts version at the boundary", () => {
    assert.ok(satisfies("1.30.1", ">=1.30.1"));
  });
  it("accepts version above the boundary", () => {
    assert.ok(satisfies("1.31.0", ">=1.30.1"));
  });
  it("rejects version below the boundary", () => {
    assert.ok(!satisfies("1.30.0", ">=1.30.1"));
  });
  it("handles compound AND range >=x <y", () => {
    assert.ok(satisfies("1.30.1", ">=1.9.0 <2.0.0"));
    assert.ok(!satisfies("2.0.0", ">=1.9.0 <2.0.0"));
    assert.ok(!satisfies("1.8.9", ">=1.9.0 <2.0.0"));
  });
});

describe("satisfies() — edge cases", () => {
  it("returns true for unparseable installed version (fail-open)", () => {
    assert.ok(satisfies("next", "^1.9.0"));
  });
  it("returns true for unparseable range constraint (fail-open)", () => {
    assert.ok(satisfies("1.9.0", "workspace:*"));
  });
});

// ── Integration test: script exits 0 against the live node_modules ────────────

describe("check:sentry-otel-deps script", () => {
  it("passes against the currently installed @opentelemetry/* packages", () => {
    // Run the actual script; if @sentry/node has been bumped without updating
    // the declared deps this will fail here before it fails at server startup.
    const scriptPath = resolve(
      pkgRoot,
      "src/scripts/checkSentryOtelDeps.ts",
    );
    let output = "";
    let exitCode = 0;
    try {
      output = execFileSync(
        process.execPath,
        ["--import", "tsx/esm", scriptPath],
        { cwd: pkgRoot, encoding: "utf8", env: process.env },
      );
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      output = (e.stdout ?? "") + (e.stderr ?? "");
      exitCode = e.status ?? 1;
    }
    assert.strictEqual(
      exitCode,
      0,
      `check:sentry-otel-deps failed — @opentelemetry/* version drift detected.\n${output}`,
    );
    assert.ok(
      output.includes("PASSED"),
      `Expected 'PASSED' in script output but got:\n${output}`,
    );
  });

  it("@sentry/node package.json is present in node_modules", () => {
    const sentryPkgPath = resolve(
      pkgRoot,
      "node_modules/@sentry/node/package.json",
    );
    assert.ok(
      existsSync(sentryPkgPath),
      `@sentry/node not found at expected path: ${sentryPkgPath}`,
    );
    const pkg = JSON.parse(readFileSync(sentryPkgPath, "utf8")) as {
      version?: string;
    };
    assert.ok(
      typeof pkg.version === "string" && pkg.version.length > 0,
      "@sentry/node package.json missing version field",
    );
  });

  it("every @opentelemetry/* package required by @sentry/node is present in node_modules", () => {
    const sentryPkgPath = resolve(
      pkgRoot,
      "node_modules/@sentry/node/package.json",
    );
    const sentryPkg = JSON.parse(readFileSync(sentryPkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const missing: string[] = [];
    for (const name of Object.keys(sentryPkg.dependencies ?? {})) {
      if (!name.startsWith("@opentelemetry/")) continue;
      const installedPath = resolve(
        pkgRoot,
        "node_modules",
        name,
        "package.json",
      );
      if (!existsSync(installedPath)) missing.push(name);
    }
    assert.deepStrictEqual(
      missing,
      [],
      `The following @opentelemetry/* packages required by @sentry/node are not installed:\n` +
        missing.map((p) => `  • ${p}`).join("\n") +
        `\nRun: pnpm --filter @workspace/api-server add <missing-package>`,
    );
  });
});
