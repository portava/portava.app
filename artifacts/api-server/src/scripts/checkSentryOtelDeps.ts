/**
 * Sentry ↔ OpenTelemetry dependency drift guard
 *
 * @sentry/node externalises ~31 `@opentelemetry/*` packages at build time
 * (see build.mjs line 65). pnpm does not hoist transitive deps, so every
 * `@opentelemetry/*` package that @sentry/node requires must be listed as a
 * *direct* dependency of this workspace package — otherwise the server will
 * crash at startup with ERR_MODULE_NOT_FOUND.
 *
 * This script detects that drift *before* the server starts by:
 *   1. Reading @sentry/node's own package.json to learn which @opentelemetry/*
 *      packages and versions it requires at runtime.
 *   2. Resolving each of those packages from this package's node_modules.
 *   3. Comparing the installed version against the range @sentry/node declared.
 *
 * Run as a pre-start gate:
 *   node --import tsx/esm src/scripts/checkSentryOtelDeps.ts
 *
 * Exit code 0 → all required @opentelemetry/* packages are present and satisfy
 *               the version ranges @sentry/node declared.
 * Exit code 1 → one or more packages are missing or have an incompatible version;
 *               the error message tells you exactly which ones and what to run.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Root of the api-server package (two levels up from src/scripts/)
const pkgRoot = resolve(__dir, "../..");

// ── 1. Locate @sentry/node ────────────────────────────────────────────────────

const req = createRequire(import.meta.url);

let sentryPkgPath: string;
try {
  sentryPkgPath = req.resolve("@sentry/node/package.json");
} catch {
  // @sentry/node itself is bundled into dist/ by esbuild; it doesn't need to
  // live in node_modules at runtime.  Nothing to check.
  console.log(
    "check:sentry-otel-deps SKIPPED (@sentry/node not found in node_modules — bundled at build time)",
  );
  process.exit(0);
}

// ── 2. Read @sentry/node's declared @opentelemetry/* requirements ─────────────

interface PackageJson {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const sentryPkg: PackageJson = JSON.parse(readFileSync(sentryPkgPath, "utf8"));

const required: Record<string, string> = {};
for (const source of [
  sentryPkg.dependencies ?? {},
  sentryPkg.peerDependencies ?? {},
]) {
  for (const [name, range] of Object.entries(source)) {
    if (name.startsWith("@opentelemetry/")) {
      required[name] = range;
    }
  }
}

if (Object.keys(required).length === 0) {
  console.log(
    "check:sentry-otel-deps PASSED (@sentry/node declares no @opentelemetry/* dependencies)",
  );
  process.exit(0);
}

// ── 3. Resolve each required package and check its installed version ───────────

/**
 * Parses a version string "1.2.3" (or "1.2.3-beta.0") into [major, minor, patch].
 * Returns null if the string is not a recognisable semver.
 */
function parseVersion(v: string): [number, number, number] | null {
  // Strip optional leading "v"
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Returns true when `installed` (a plain version string like "1.30.1")
 * satisfies `range` (a semver range string from a package.json).
 *
 * We implement a subset of semver ranges that covers what @sentry/node uses:
 *   - Exact:     "1.2.3"
 *   - Caret:     "^1.2.3"  → >=1.2.3 <2.0.0  (or >=0.2.3 <0.3.0 when major=0)
 *   - Tilde:     "~1.2.3"  → >=1.2.3 <1.3.0
 *   - GTE:       ">=1.2.3"
 *   - Range:     ">=1.2.3 <2.0.0" (space-separated AND)
 *
 * Anything we don't recognise is considered satisfied (fail-open so the script
 * doesn't produce false positives for unusual range syntaxes).
 */
function satisfies(installed: string, range: string): boolean {
  const iv = parseVersion(installed);
  if (!iv) return true; // can't parse installed — fail-open

  const [iMaj, iMin, iPat] = iv;

  // AND-conjunction: every space-separated constraint must hold.
  const parts = range.trim().split(/\s+/);

  function cmp(a: [number, number, number], b: [number, number, number]): number {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
  }

  for (const part of parts) {
    if (!part) continue;

    if (part.startsWith("^")) {
      const rv = parseVersion(part.slice(1));
      if (!rv) continue; // fail-open
      const [rMaj, rMin, rPat] = rv;
      if (rMaj !== 0) {
        // ^1.2.3 → >=1.2.3 <2.0.0
        if (iMaj !== rMaj) return false;
        if (cmp(iv, rv) < 0) return false;
      } else if (rMin !== 0) {
        // ^0.2.3 → >=0.2.3 <0.3.0
        if (iMaj !== 0 || iMin !== rMin) return false;
        if (cmp(iv, rv) < 0) return false;
      } else {
        // ^0.0.3 → >=0.0.3 <0.0.4
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
      // Exact match or unrecognised — treat as exact if parseable
      const rv = parseVersion(part);
      if (!rv) continue; // fail-open
      if (cmp(iv, rv) !== 0) return false;
    }
  }

  return true;
}

// ── 4. Collect failures ───────────────────────────────────────────────────────

interface Failure {
  pkg: string;
  requiredRange: string;
  installedVersion: string | null;
  reason: "missing" | "incompatible";
}

const failures: Failure[] = [];

for (const [pkg, requiredRange] of Object.entries(required)) {
  let installedVersion: string | null = null;

  // Read the package.json directly from node_modules — we cannot use
  // require.resolve("<pkg>/package.json") because some @opentelemetry packages
  // block that sub-path via their "exports" field (ERR_PACKAGE_PATH_NOT_EXPORTED).
  const installedPkgPath = resolve(pkgRoot, "node_modules", pkg, "package.json");
  try {
    const installedPkg: PackageJson = JSON.parse(
      readFileSync(installedPkgPath, "utf8"),
    );
    installedVersion = installedPkg.version ?? null;
  } catch {
    // File doesn't exist → package is not installed
  }

  if (!installedVersion) {
    failures.push({ pkg, requiredRange, installedVersion: null, reason: "missing" });
    continue;
  }

  if (!satisfies(installedVersion, requiredRange)) {
    failures.push({ pkg, requiredRange, installedVersion, reason: "incompatible" });
  }
}

// ── 5. Report ─────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(
    `check:sentry-otel-deps PASSED (${Object.keys(required).length} @opentelemetry/* package(s) verified)`,
  );
  process.exit(0);
}

const missingPkgs = failures.filter((f) => f.reason === "missing");
const incompatiblePkgs = failures.filter((f) => f.reason === "incompatible");

console.error(
  "\n" +
    "╔═══════════════════════════════════════════════════════════════════════╗\n" +
    "║  check:sentry-otel-deps FAILED — @opentelemetry/* version drift      ║\n" +
    "╚═══════════════════════════════════════════════════════════════════════╝\n",
);

console.error(
  `@sentry/node@${sentryPkg.version ?? "?"} requires the following @opentelemetry/* packages\n` +
    `at runtime (they are externalised from the bundle — see build.mjs:65).\n` +
    `pnpm will NOT hoist them automatically; they must be direct deps of\n` +
    `artifacts/api-server/package.json.\n`,
);

if (missingPkgs.length > 0) {
  console.error("MISSING (not installed in api-server/node_modules):");
  for (const { pkg, requiredRange } of missingPkgs) {
    console.error(`  • ${pkg}  (required: ${requiredRange})`);
  }
  console.error();
}

if (incompatiblePkgs.length > 0) {
  console.error("INCOMPATIBLE (installed version does not satisfy the required range):");
  for (const { pkg, requiredRange, installedVersion } of incompatiblePkgs) {
    console.error(
      `  • ${pkg}  (required: ${requiredRange}, installed: ${installedVersion})`,
    );
  }
  console.error();
}

console.error(
  "Fix: run the following command from the repo root to update the pinned versions:\n",
);
console.error(
  "  node -e \"" +
    "const p=require('./artifacts/api-server/node_modules/@sentry/node/package.json');" +
    "Object.entries({...p.dependencies,...(p.peerDependencies||{})})" +
    ".filter(([k])=>k.startsWith('@opentelemetry/'))" +
    ".forEach(([k,v])=>console.log(k+'@'+v))\"" +
    " | xargs -I{} pnpm --filter @workspace/api-server add {}\n",
);

process.exit(1);
