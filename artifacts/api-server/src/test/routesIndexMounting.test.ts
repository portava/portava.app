/**
 * routes/index.ts — a router registered inside a comment is not registered.
 *
 * THE DEFECT, FOUND BY AN INDEPENDENT VERIFIER (lane C, 2026-10-05). The file
 * is pinned at a fixed line count (censuses cite it by line, and
 * creatorLedgerMigrationShape3385 M6 asserts the length), so new routers are
 * appended to existing long lines. Wave 1 appended
 * `import tripAnchorSharesRouter …; router.use(tripAnchorSharesRouter);` AFTER
 * an existing `// census-discovery §58 …` comment on line 437, so both
 * statements were part of the comment. Every share route answered Express's
 * HTML 404 through the real app, and the route suite could not see it because
 * it mounts the router itself.
 *
 * WHAT IS ASSERTED
 *   A. Through the REAL `app`, the three private-anchor share routes are mounted:
 *      unauthenticated, each answers this API's own JSON 401, not Express's
 *      HTML "Cannot GET". (A 401 is only possible if requireUser ran.)
 *   B. The general guard: no line of routes/index.ts carries `import …Router`
 *      or `router.use(` inside a `//` comment, and every router the file
 *      imports in CODE is passed to `router.use(` in CODE. The scan is a small
 *      tokenizer (strings, line comments, block comments), because a regex
 *      reads `// /stamps/* path` as opening a block comment.
 *
 * SHOWN RED: at `85bb3c5339` A fails (HTML 404 on all three) and B fails naming
 * line 437 and `tripAnchorSharesRouter`.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/routesIndexMounting.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

import app from "../app.js";

const SRC = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");

/** Split one source into code and comment text, per line. */
export function scanComments(src: string): { code: string; lineComments: Array<{ line: number; text: string }> } {
  let code = "";
  const lineComments: Array<{ line: number; text: string }> = [];
  let i = 0;
  let line = 1;
  let state: "code" | "str" | "line" | "block" = "code";
  let quote = "";
  let comment = "";
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; comment = ""; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { state = "str"; quote = ch; code += ch; i += 1; continue; }
      code += ch;
    } else if (state === "str") {
      code += ch;
      if (ch === "\\") { code += next ?? ""; i += 2; continue; }
      if (ch === quote) state = "code";
    } else if (state === "line") {
      if (ch === "\n") { lineComments.push({ line, text: comment }); state = "code"; code += ch; }
      else comment += ch;
    } else {
      if (ch === "*" && next === "/") { state = "code"; i += 2; continue; }
      if (ch === "\n") code += ch;
    }
    if (ch === "\n") line += 1;
    i += 1;
  }
  if (state === "line") lineComments.push({ line, text: comment });
  return { code, lineComments };
}

let server: Server;
let base = "";
before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => { server.close(); });

const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const ITEM = "bbbbbbbb-0000-4000-8000-00000000000b";
const MEMBER = "cccccccc-0000-4000-8000-00000000000c";

describe("A. the private-anchor share routes are mounted in the real app", () => {
  for (const [method, path] of [
    ["GET", `/trips/${TRIP}/anchors/${ITEM}/shares`],
    ["POST", `/trips/${TRIP}/anchors/${ITEM}/shares`],
    ["DELETE", `/trips/${TRIP}/anchors/${ITEM}/shares/${MEMBER}`],
  ] as const) {
    it(`${method} ${path.replace(TRIP, ":tripId").replace(ITEM, ":itemId").replace(MEMBER, ":memberId")} answers the API's JSON 401 — not Express's HTML 404`, async () => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ memberId: MEMBER }) } : {}),
      });
      const text = await res.text();
      assert.doesNotMatch(text, /Cannot (GET|POST|DELETE)/, "Express's default 404: the route is not mounted");
      assert.equal(res.status, 401, text.slice(0, 200));
      assert.equal(JSON.parse(text).error, "unauthenticated");
    });
  }
});

describe("B. routes/index.ts registers nothing inside a comment, and mounts every router it imports", () => {
  const { code, lineComments } = scanComments(SRC);

  it("B1. no `//` comment carries an import of a router or a router.use(", () => {
    const offenders = lineComments
      .filter((c) => /\bimport\s+\w+\s+from\s+["']/.test(c.text) || /\brouter\.use\(/.test(c.text))
      .map((c) => `line ${c.line}: //${c.text.slice(0, 120)}`);
    assert.deepEqual(offenders, []);
  });

  it("B2. every router imported in code is passed to router.use( in code", () => {
    const imported = [...code.matchAll(/\bimport\s+(\w+)\s+from\s+["'][^"']+["']/g)].map((m) => m[1]!)
      .filter((n) => /Router$/.test(n));
    const used = new Set([...code.matchAll(/\brouter\.use\(\s*(?:["'][^"']*["']\s*,\s*)?(\w+)\s*\)/g)].map((m) => m[1]!));
    assert.ok(imported.length > 100, `only ${imported.length} router imports parsed — the scan is not reading the file`);
    assert.deepEqual(imported.filter((n) => !used.has(n)), []);
  });

  it("B3. the scanner itself: a router after `//` is comment, `// /x/* y` opens no block, a string's // is code", () => {
    const s = scanComments('a(); // b(); router.use(x)\n// /stamps/* path\nimport fooRouter from "./f.js"; router.use(fooRouter); const u = "http://x";\n');
    assert.match(s.lineComments[0]!.text, /router\.use\(x\)/);
    assert.match(s.code, /router\.use\(fooRouter\)/);
    assert.match(s.code, /"http:\/\/x"/);
  });

  it("B4. the file keeps its pinned length (censuses cite it by line)", () => {
    assert.equal(SRC.split("\n").length, 439);
  });
});
