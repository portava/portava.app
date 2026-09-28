/**
 * Entry wiring that a line comment silently disabled (census-discovery §90).
 *
 * Several lanes add an import or a start call to an EXISTING line of
 * src/index.ts or src/routes/index.ts, so that no line a census cites moves.
 * When that existing line already ended in a `//` comment, the appended code
 * became part of the comment: it type-checks (nothing references it), every
 * unit test that mounts the router or calls the scheduler directly passes,
 * and production never runs it. Two such cases were found on 2026-09-28:
 *
 *   - src/index.ts:35 and :293 — startDiscoveryTrendRebuildScheduler's import
 *     and call (census-discovery §84, DC-07) sat after `// census-discovery §52`.
 *   - src/routes/index.ts:80 and :247 — adminTrailsRouter's import and mount
 *     (§86, DV-74) sat after `// census-discovery §52`.
 *
 * This file reads the two entry files the way the compiler does (TypeScript's
 * own parser, so comments are comments) and asserts that every imported
 * `start…` function is called and every imported router is mounted. A third
 * test scans the whole server tree for the textual shape of the bug. Each
 * check also runs against the pre-fix text as a CONTROL, so the test is known
 * to see the defect it guards.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/entryWiringNotCommentedOut.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

function importedNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    if (c.name) names.push(c.name.text);
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
      for (const el of c.namedBindings.elements) names.push(el.name.text);
    }
  }
  return names;
}

/** Identifiers that appear as the callee of a call, or as an argument to `<x>.use(...)`. */
function callsAndMounts(sf: ts.SourceFile): { called: Set<string>; mounted: Set<string> } {
  const called = new Set<string>();
  const mounted = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) called.add(n.expression.text);
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "use") {
        for (const a of n.arguments) if (ts.isIdentifier(a)) mounted.add(a.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { called, mounted };
}

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Imported `start…` functions in an entry file that are never called. */
export function uncalledStarters(text: string): string[] {
  const sf = parse("index.ts", text);
  const { called } = callsAndMounts(sf);
  return importedNames(sf).filter((n) => /^start[A-Z]\w*$/.test(n) && !called.has(n));
}

/** Imported routers in routes/index.ts that are never passed to `.use(...)`. */
export function unmountedRouters(text: string): string[] {
  const sf = parse("routes-index.ts", text);
  const { mounted } = callsAndMounts(sf);
  return importedNames(sf).filter((n) => /^(?!I?Router$)\w+Router$/.test(n) && !mounted.has(n)); // express's own Router / IRouter are types and factories, not routers to mount
}

/**
 * The textual shape of the bug: a code line whose trailing `//` comment goes on
 * to contain an import, a `.use(` mount, or a `start…();` call. String contents
 * are blanked first so a URL or a quoted `//` is never mistaken for a comment.
 */
const HIDDEN = /\bimport\s+(?:\{|\*\s+as\s|\w+\s+from\b)|\b(?:app|router)\.use\(|\bstart[A-Z]\w*\(\s*\)\s*;/;
export function hiddenStatements(text: string): number[] {
  const hits: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a whole-line comment is prose, not an appended statement
    const blanked = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[0]);
    const at = blanked.indexOf("//");
    if (at <= 0) return;
    if (HIDDEN.test(blanked.slice(at + 2))) hits.push(i + 1);
  });
  return hits;
}

function serverSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "test" || e === "node_modules") continue;
      serverSources(p, out);
    } else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

// The two lines as they stood before the fix, verbatim in the parts that matter.
const PRE_FIX_INDEX =
  'import { startCreatorAttributionScheduler } from "./lib/creatorAttributionScheduler"; // census-discovery §52 (DV-56) import { startDiscoveryTrendRebuildScheduler } from "./lib/discoveryTrendRebuildScheduler.js"; // census-discovery §84 (DC-07)\n' +
  "function boot() {\n  startCreatorAttributionScheduler(); // census-discovery §52 (DV-56): one flag read an hour startDiscoveryTrendRebuildScheduler(); // §84 (DC-07)\n}\n";
const PRE_FIX_ROUTES =
  'import adminCreatorLedgerRouter from "./adminCreatorLedger"; // census-discovery §52 (DC-23): appended to this line import adminTrailsRouter from "./adminTrails"; // census-discovery §86 (DV-74)\n' +
  "router.use(adminCreatorLedgerRouter); // census-discovery §52 router.use(adminTrailsRouter); // §86\n";

describe("census-discovery §90 — entry wiring is not commented out", () => {
  it("CONTROL: each check sees the 2026-09-28 defect in the pre-fix text", () => {
    // The hidden import is not an import to the parser, so the starter is simply absent;
    // the textual scan is what catches that half, and it must.
    assert.deepEqual(hiddenStatements(PRE_FIX_INDEX), [1, 3]);
    assert.deepEqual(hiddenStatements(PRE_FIX_ROUTES), [1, 2]);
    // With the import visible but the call still hidden, the AST check catches it.
    const importVisible = PRE_FIX_INDEX.replace(
      '// census-discovery §52 (DV-56) import { startDiscoveryTrendRebuildScheduler } from "./lib/discoveryTrendRebuildScheduler.js";',
      'import { startDiscoveryTrendRebuildScheduler } from "./lib/discoveryTrendRebuildScheduler.js"; // census-discovery §52 (DV-56)',
    );
    assert.deepEqual(uncalledStarters(importVisible), ["startDiscoveryTrendRebuildScheduler"]);
    const routerVisible = PRE_FIX_ROUTES.replace(
      '// census-discovery §52 (DC-23): appended to this line import adminTrailsRouter from "./adminTrails";',
      'import adminTrailsRouter from "./adminTrails"; // census-discovery §52 (DC-23): appended to this line',
    );
    assert.deepEqual(unmountedRouters(routerVisible), ["adminTrailsRouter"]);
  });

  it("src/index.ts calls every start… function it imports, including DC-07's trend rebuild scheduler", () => {
    const text = readFileSync(join(SRC, "index.ts"), "utf8");
    assert.deepEqual(uncalledStarters(text), []);
    const sf = parse("index.ts", text);
    const { called } = callsAndMounts(sf);
    for (const s of ["startDiscoveryTrendRebuildScheduler", "startPlaceCooccurrenceRebuildScheduler", "startCreatorAttributionScheduler"]) {
      assert.ok(importedNames(sf).includes(s), `${s} is imported by src/index.ts`);
      assert.ok(called.has(s), `${s}() is called by src/index.ts`);
    }
  });

  it("src/routes/index.ts mounts every router it imports, including §86's adminTrailsRouter and §91's output kinds", () => {
    const text = readFileSync(join(SRC, "routes", "index.ts"), "utf8");
    assert.deepEqual(unmountedRouters(text), []);
    const sf = parse("routes-index.ts", text);
    const { mounted } = callsAndMounts(sf);
    for (const r of ["adminTrailsRouter", "discoveryOutputKindsRouter"]) assert.ok(mounted.has(r), `${r} is mounted`);
  });

  it("no server source hides an import, a mount or a start call behind a line comment", () => {
    const found: string[] = [];
    for (const f of serverSources(SRC)) {
      for (const line of hiddenStatements(readFileSync(f, "utf8"))) found.push(`${relative(SRC, f)}:${line}`);
    }
    assert.deepEqual(found, []);
  });
});
