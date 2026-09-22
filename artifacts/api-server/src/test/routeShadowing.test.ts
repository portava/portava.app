/**
 * routeShadowing.test.ts — the guard that would have caught an unreachable route.
 *
 * Express matches in registration order, so a literal path registered after a
 * parameterised one that fits it is never reached. The failure is silent by
 * construction: the handler exists, typechecks, and can be unit-tested in
 * isolation — it is simply never called, and the caller gets whatever the
 * parameterised handler does with a non-id, which in this codebase is a tidy
 * `invalid_payload`. A brand-new endpoint that returns a plausible client error
 * on every request, forever.
 *
 * This is not hypothetical. Writing `GET /stories/archive` after
 * `GET /stories/:id` is exactly what happened during the Highlights archive
 * work; it was caught by reading the file, and nothing in the suite would have
 * failed. The repo has zero shadowed routes today, so this guard starts clean
 * and carries no baseline.
 *
 * Run: node --import tsx/esm --test src/test/routeShadowing.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shadows, extractRoutes, findShadowedRoutes } from "../scripts/checkRouteShadowing.js";

describe("shadows() — does an earlier path capture a later one?", () => {
  it("a parameter swallows a literal in the same position", () => {
    assert.equal(shadows("/stories/:id", "/stories/archive"), true);
    assert.equal(shadows("/highlights/:id", "/highlights/active"), true);
    assert.equal(shadows("/stories/:id/likes", "/stories/featured/likes"), true);
  });

  it("the CORRECT order is not flagged", () => {
    // This is the fix, and it must not read as the defect.
    assert.equal(shadows("/stories/archive", "/stories/:id"), false);
  });

  it("different shapes never shadow", () => {
    assert.equal(shadows("/stories/:id", "/stories/:id/viewers"), false);
    assert.equal(shadows("/stories/:id/viewers", "/stories/:id"), false);
    assert.equal(shadows("/stories/:id", "/highlights/archive"), false);
  });

  it("two parameters in the same position are a DUPLICATE, not a shadow", () => {
    // A different defect with a different fix — reporting it here would send the
    // reader to move a route that moving does not help.
    assert.equal(shadows("/stories/:id", "/stories/:storyId"), false);
  });

  it("a literal that differs is not shadowed", () => {
    assert.equal(shadows("/stories/archive", "/stories/active"), false);
  });

  it("wildcard and regex segments are skipped rather than guessed at", () => {
    assert.equal(shadows("/files/*", "/files/manifest"), false);
    assert.equal(shadows("/n/(\\d+)", "/n/latest"), false);
  });
});

describe("extractRoutes()", () => {
  it("reads method, path and line in source order", () => {
    const src = [
      'const router = Router();',
      'router.get("/a", h);',
      'router.post("/b/:id", h);',
    ].join("\n");
    assert.deepEqual(extractRoutes(src), [
      { method: "get", path: "/a", line: 2 },
      { method: "post", path: "/b/:id", line: 3 },
    ]);
  });

  it("ignores a commented-out registration", () => {
    // A documented example is not a route, and flagging one trains people to
    // ignore the guard.
    const src = [
      '// router.get("/stories/:id", h);',
      ' * router.get("/stories/:id", h);',
      'router.get("/stories/archive", h);',
    ].join("\n");
    assert.deepEqual(extractRoutes(src).map((r) => r.path), ["/stories/archive"]);
  });
});

describe("findShadowedRoutes()", () => {
  const file = (source: string) => [{ name: "routes/x.ts", source }];

  it("catches the REAL near-miss: /stories/archive behind /stories/:id", () => {
    const found = findShadowedRoutes(file([
      'router.get("/stories/:id", h);',
      'router.get("/stories/archive", h);',
    ].join("\n")));
    assert.equal(found.length, 1);
    assert.equal(found[0].earlier.path, "/stories/:id");
    assert.equal(found[0].later.path, "/stories/archive");
    assert.equal(found[0].later.line, 2);
  });

  it("passes when the literal is registered first", () => {
    assert.deepEqual(findShadowedRoutes(file([
      'router.get("/stories/archive", h);',
      'router.get("/stories/:id", h);',
    ].join("\n"))), []);
  });

  it("a different METHOD does not shadow", () => {
    assert.deepEqual(findShadowedRoutes(file([
      'router.get("/stories/:id", h);',
      'router.post("/stories/archive", h);',
    ].join("\n"))), []);
  });

  it("router.all() shadows every later method", () => {
    const found = findShadowedRoutes(file([
      'router.all("/stories/:id", h);',
      'router.post("/stories/archive", h);',
    ].join("\n")));
    assert.equal(found.length, 1);
    assert.equal(found[0].method, "POST");
  });

  it("reports each shadowed route once, not once per earlier match", () => {
    const found = findShadowedRoutes(file([
      'router.get("/s/:a", h);',
      'router.get("/s/:b", h);',
      'router.get("/s/archive", h);',
    ].join("\n")));
    assert.equal(found.length, 1, "one unreachable route, one finding");
  });

  it("scopes to one file — two files are not compared", () => {
    assert.deepEqual(findShadowedRoutes([
      { name: "routes/a.ts", source: 'router.get("/s/:id", h);' },
      { name: "routes/b.ts", source: 'router.get("/s/archive", h);' },
    ]), [], "cross-file shadowing is a mount-order question this guard does not model");
  });
});

describe("the real repository", () => {
  it("has no shadowed routes", async () => {
    // The guard's own subject. If this ever fails, a route someone wrote is
    // unreachable in production right now.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { resolve, dirname, join, relative } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const walk = (d: string, acc: Array<{ name: string; source: string }> = []) => {
      for (const e of readdirSync(d)) {
        const full = join(d, e);
        if (statSync(full).isDirectory()) { walk(full, acc); continue; }
        if (!e.endsWith(".ts") || e.endsWith(".test.ts")) continue;
        acc.push({ name: relative(SRC, full), source: readFileSync(full, "utf8") });
      }
      return acc;
    };
    const files = walk(resolve(SRC, "routes"));
    assert.ok(files.length > 20, `only ${files.length} router files found — the scan is broken, not clean`);
    const total = files.reduce((n, f) => n + extractRoutes(f.source).length, 0);
    assert.ok(total > 200, `only ${total} routes found — the scan is broken, not clean`);
    assert.deepEqual(findShadowedRoutes(files), []);
  });
});
