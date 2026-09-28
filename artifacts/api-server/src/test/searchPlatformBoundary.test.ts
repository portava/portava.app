/**
 * searchPlatformBoundary — census-discovery §70 (lane P30), row A08 reason 1.
 *
 * GII `:8` says the shared input layer "is not owned by Discovery … Those
 * surfaces consume it through a shared platform layer". Until §70 the platform
 * layer's candidate generation WAS Discovery's route module:
 * `lib/inputAssistance/gateway.ts` imported `dispatchSearch` from
 * `routes/discoverySearch.ts`, and four more `lib/inputAssistance/` modules
 * imported types and helpers from it. So the platform depended on a Discovery
 * route, the opposite of the spec's direction.
 *
 * §70 moved `dispatchSearch`, its coverage form, the `type=all` fan-out and
 * every per-type searcher into `lib/inputAssistance/searchCandidates.ts`. The
 * gateway and the route now both import that module, and the route re-exports
 * what it used to export so no caller changes.
 *
 * WHAT THIS PINS
 *   B1  No module under `src/lib/` imports `routes/discoverySearch` (static,
 *       type-only, re-export or dynamic). This one was seen RED before the move,
 *       naming the five importers.
 *   B2  The detector is not vacuous. It flags three synthetic importers held in
 *       memory, and it does not flag `routes/discoverySearchHelpers`.
 *   B3  One implementation, not two. The route's `dispatchSearch` (and the other
 *       re-exports) IS the platform module's function object, and the route
 *       file defines no per-type searcher and no dispatcher of its own.
 *   B4  The gateway takes its candidate generator from the platform module.
 *   B5  A RESIDUAL, pinned so it can only shrink: `lib/` modules that still
 *       import `routes/discoverySearchHelpers.ts` (pure helpers, no router).
 *       §70 did not move that file; it is named in §70 as remaining.
 *
 * WHAT THIS DOES NOT PIN: that responses are unchanged. That is
 * searchPlatformGolden.test.ts, which compares every search type, the suggest
 * route and four gateway contexts against a golden captured before the move.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(SRC, "lib");
const ROUTE = path.join(SRC, "routes", "discoverySearch");
const HELPERS = path.join(SRC, "routes", "discoverySearchHelpers");
const PLATFORM_REL = "lib/inputAssistance/searchCandidates.ts";

/** Every .ts file under a directory, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * Every module specifier a source text names: `import … from`, `export … from`,
 * `import type … from`, a bare side-effect `import "…"`, and `import("…")`.
 */
export function specifiers(src: string): string[] {
  const out: string[] = [];
  const res = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of res) for (const m of src.matchAll(re)) out.push(m[1]!);
  return out;
}

/** A relative specifier resolved to an extensionless absolute path. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return path.resolve(path.dirname(fromFile), spec).replace(/\.(?:js|ts)$/, "");
}

/** Files (from `sources`) whose imports resolve to `target`. */
export function importersOf(sources: ReadonlyMap<string, string>, target: string): string[] {
  const hits: string[] = [];
  for (const [file, src] of sources) {
    if (specifiers(src).some((s) => resolveSpec(file, s) === target)) hits.push(path.relative(SRC, file));
  }
  return hits.sort();
}

function libSources(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of tsFiles(LIB)) m.set(f, readFileSync(f, "utf8"));
  return m;
}

describe("search platform boundary (census-discovery §70, A08 reason 1)", () => {
  it("B1: no module under src/lib/ imports routes/discoverySearch", () => {
    const sources = libSources();
    assert.ok(sources.size > 100, `walked only ${sources.size} lib files — the walker is broken`);
    assert.ok(
      sources.has(path.join(LIB, "inputAssistance", "gateway.ts")),
      "the walker did not see lib/inputAssistance/gateway.ts",
    );
    const importers = importersOf(sources, ROUTE);
    assert.deepEqual(
      importers, [],
      `the platform layer imports Discovery's route module again: ${importers.join(", ")}. ` +
        `Import the platform module (${PLATFORM_REL}) instead.`,
    );
  });

  it("B2: the detector flags a route import in any form, and does not flag the helpers module", () => {
    const fake = new Map<string, string>([
      [path.join(LIB, "inputAssistance", "fakeA.ts"), `import type { SearchResult } from '../../routes/discoverySearch';`],
      [path.join(LIB, "fakeB.ts"), `export { dispatchSearch } from "../routes/discoverySearch.js";`],
      [path.join(LIB, "x", "fakeC.ts"), `const m = await import("../../routes/discoverySearch.js");`],
      [path.join(LIB, "fakeD.ts"), `import { applyAliases } from '../routes/discoverySearchHelpers';`],
      [path.join(LIB, "fakeE.ts"), `// routes/discoverySearch is only named in a comment\nconst s = "../routes/discoverySearch";`],
    ]);
    assert.deepEqual(importersOf(fake, ROUTE), ["lib/fakeB.ts", "lib/inputAssistance/fakeA.ts", "lib/x/fakeC.ts"]);
    assert.deepEqual(importersOf(fake, HELPERS), ["lib/fakeD.ts"]);
  });

  it("B3: the route re-exports the platform module's functions and defines no searcher of its own", async () => {
    const route = await import("../routes/discoverySearch.js");
    const platform = await import("../lib/inputAssistance/searchCandidates.js");
    for (const name of [
      "dispatchSearch", "dispatchSearchWithCoverage", "sanitizeQuery", "fetchAgeRestrictedSet",
      "invalidateBuddyLaunchGateCache", "buddiesWithheldByLaunchGate", "gemSearchPosition",
      "canonicalToCityResult", "mergeCitySuggestions", "DiscoverySearchReadError", "fetchBlockedSet",
    ] as const) {
      assert.equal(
        typeof (platform as Record<string, unknown>)[name] === "function", true,
        `${PLATFORM_REL} does not export ${name}`,
      );
      assert.equal(
        (route as Record<string, unknown>)[name], (platform as Record<string, unknown>)[name],
        `routes/discoverySearch.${name} is not the platform module's ${name}: a second copy exists`,
      );
    }
    const routeSrc = readFileSync(`${ROUTE}.ts`, "utf8");
    const own = [...routeSrc.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(search[A-Z]\w*|dispatch\w*)\s*\(/gm)].map((m) => m[1]);
    assert.deepEqual(own, [], `routes/discoverySearch.ts defines search code again: ${own.join(", ")}`);
    assert.match(routeSrc, /from "\.\.\/lib\/inputAssistance\/searchCandidates\.js"/);
  });

  it("B4: the gateway takes dispatchSearch from the platform module", () => {
    const gw = readFileSync(path.join(LIB, "inputAssistance", "gateway.ts"), "utf8");
    assert.match(gw, /import \{[^}]*\bdispatchSearch\b[^}]*\} from '\.\/searchCandidates'/);
    const platform = readFileSync(path.join(SRC, PLATFORM_REL), "utf8");
    assert.match(platform, /^export async function dispatchSearch\(/m);
    assert.match(platform, /^async function dispatchOne\(/m);
  });

  it("B5 (residual, shrink-only): lib/ importers of routes/discoverySearchHelpers", () => {
    // Pure helpers (alias table, match tiers, time and nearby intent, the
    // query-context type) with no router in them. Still a routes/ path, so
    // still named in §70 as remaining. A new importer fails here; removing
    // one means deleting it from this list.
    const KNOWN = [
      "lib/inputAssistance/gateway.ts",
      "lib/inputAssistance/projection.ts",
      "lib/inputAssistance/queryNormalizer.ts",
      "lib/inputAssistance/searchCandidates.ts",
      "lib/inputAssistance/semanticParser.ts",
      "lib/inputAssistance/socialIdentity.ts",
    ];
    const importers = importersOf(libSources(), HELPERS);
    const added = importers.filter((f) => !KNOWN.includes(f));
    assert.deepEqual(added, [], `new lib/ importer(s) of routes/discoverySearchHelpers: ${added.join(", ")}`);
  });
});
