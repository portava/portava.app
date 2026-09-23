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

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE PATH, TWO MOUNTED ROUTERS
 *
 * The block above ends by asserting that cross-file shadowing is "a mount-order
 * question this guard does not model". That was true, and it cost the repository
 * an endpoint: `POST /telegraph/commands` was registered by
 * routes/telegraphCommands.ts AND server/telegraph/commandRoute.ts, the
 * assistant was mounted first, and the whole §13.1 command vocabulary answered
 * `400 invalid_payload "Required"` in the running app while its own test suite —
 * which mounts the one router alone — stayed green.
 *
 * Two separate blindnesses had to be removed before that pair could be seen at
 * all, and each gets its own test below: the extractor could not read a
 * registration split across lines, and nothing compared one router against
 * another.
 * ═══════════════════════════════════════════════════════════════════════════ */

import {
  normalisePath,
  parseRouterImports,
  parseMountOrder,
  findDuplicatePaths,
  DECLARED_SHARED_PATHS,
  CONTESTED_PATH_RATCHET,
} from "../scripts/checkRouteShadowing.js";

describe("extractRoutes() — a registration split across lines is still a registration", () => {
  it("reads the method and the path when they are on different lines", () => {
    // The shape this repository writes whenever a handler has a wrapper. A
    // line-by-line scan matched neither half, so the route did not exist as far
    // as the guard was concerned.
    const src = [
      "router.post(",
      '  "/telegraph/commands",',
      "  asyncHandler(async (req, res, next) => {",
      "    next();",
      "  }),",
      ");",
    ].join("\n");
    assert.deepEqual(extractRoutes(src), [{ method: "post", path: "/telegraph/commands", line: 1 }]);
  });

  it("still reads the single-line form, and still skips a commented-out one", () => {
    const src = [
      'router.get("/a", h);',
      '// router.get("/b", h);',
      ' * router.get("/c", h);',
      "router.get(",
      '  "/d",',
      "  h);",
    ].join("\n");
    assert.deepEqual(extractRoutes(src).map((r) => r.path), ["/a", "/d"]);
  });

  it("reports the line the REGISTRATION starts on, not the line the path is on", () => {
    const src = ["", "", "router.put(", '  "/x",', "  h);"].join("\n");
    assert.equal(extractRoutes(src)[0].line, 3);
  });
});

describe("normalisePath() — a parameter's NAME is not part of the pattern", () => {
  it("two differently-named parameters in the same position are one path", () => {
    // `/circles/:circleOwnerId/chat` and `/circles/:circleId/chat` collide at
    // runtime. Keying on the written path hid that pair completely.
    assert.equal(
      normalisePath("/circles/:circleOwnerId/chat"),
      normalisePath("/circles/:circleId/chat"),
    );
  });

  it("does not collapse literals, and drops a trailing slash", () => {
    assert.notEqual(normalisePath("/circles/mine/chat"), normalisePath("/circles/:id/chat"));
    assert.equal(normalisePath("/a/b/"), normalisePath("/a/b"));
  });
});

describe("routes/index.ts parsing", () => {
  const INDEX = [
    'import aRouter from "./a";',
    'import bRouter from "../server/telegraph/b";',
    'import cRouter from "express";',
    "router.use(aRouter);",
    "router.use(bRouter);",
  ].join("\n");

  it("resolves a relative import to a path under src/, through ../", () => {
    const imports = parseRouterImports(INDEX);
    assert.equal(imports.get("aRouter"), "routes/a.ts");
    assert.equal(imports.get("bRouter"), "server/telegraph/b.ts");
  });

  it("ignores package imports, which are not routers in this tree", () => {
    assert.equal(parseRouterImports(INDEX).get("cRouter"), undefined);
  });

  it("returns the mounts in mount order", () => {
    assert.deepEqual(parseMountOrder(INDEX).mounts, ["aRouter", "bRouter"]);
  });

  it("REPORTS a prefixed mount rather than treating it as prefix-less", () => {
    // The cross-router comparison assumes every router shares one prefix. A
    // mount that breaks the assumption must make the check fail, not pass.
    const { mounts, prefixed } = parseMountOrder('router.use("/v2", vRouter);\nrouter.use(aRouter);');
    assert.deepEqual(mounts, ["aRouter"]);
    assert.equal(prefixed.length, 1);
    assert.match(prefixed[0], /\/v2/);
  });
});

describe("findDuplicatePaths() — the same path in two mounted routers", () => {
  const sources: Record<string, string> = {
    "routes/first.ts": 'router.get("/thing/:id", h);\nrouter.post("/other", h);',
    "routes/second.ts": 'router.get("/thing/:thingId", h);',
    "routes/third.ts": 'router.get("/unrelated", h);',
  };
  const read = (n: string) => sources[n];
  const mounted = [
    { name: "routes/first.ts", order: 0 },
    { name: "routes/second.ts", order: 1 },
    { name: "routes/third.ts", order: 2 },
  ];

  it("reports the pair, in mount order, even with different parameter names", () => {
    const found = findDuplicatePaths(mounted, read);
    assert.equal(found.length, 1);
    assert.equal(found[0].method, "get");
    assert.deepEqual(found[0].registrations.map((r) => r.name), [
      "routes/first.ts",
      "routes/second.ts",
    ]);
  });

  it("two registrations inside ONE file are left to the within-file check", () => {
    const one = { "routes/only.ts": 'router.get("/a", h);\nrouter.get("/a", h);' };
    assert.deepEqual(
      findDuplicatePaths([{ name: "routes/only.ts", order: 0 }], (n) => one[n as keyof typeof one]),
      [],
    );
  });

  it("a DECLARED pair in the declared mount order is permitted", () => {
    const declared = DECLARED_SHARED_PATHS[0];
    const src: Record<string, string> = {};
    declared.files.forEach((f) => { src[f] = `router.${declared.method}("${declared.path}", h);`; });
    const found = findDuplicatePaths(
      declared.files.map((name, order) => ({ name, order })),
      (n) => src[n],
    );
    assert.deepEqual(found, []);
  });

  it("the SAME pair mounted the other way round is reported", () => {
    // The declaration is an argument about which router yields. Reversed, the
    // divider is in the router that runs second and divides nothing — which is
    // precisely the state the repository was in.
    const declared = DECLARED_SHARED_PATHS[0];
    const src: Record<string, string> = {};
    declared.files.forEach((f) => { src[f] = `router.${declared.method}("${declared.path}", h);`; });
    const reversed = [...declared.files].reverse();
    const found = findDuplicatePaths(
      reversed.map((name, order) => ({ name, order })),
      (n) => src[n],
    );
    assert.equal(found.length, 1, "a declaration must not excuse the wrong mount order");
  });
});

describe("the contested-path ratchet", () => {
  it("every entry names a dead handler and the decision it is waiting on", () => {
    for (const r of CONTESTED_PATH_RATCHET) {
      assert.ok(r.dead.length > 10, `${r.path} does not say which handler is dead`);
      assert.ok(r.needs.length > 40, `${r.path} does not say what it needs to be fixed`);
    }
  });

  it("no ratchet entry is also a DECLARED shared path", () => {
    // One list says "divided, and here is the divider"; the other says "not
    // divided, and here is the defect". An entry on both would be an excuse
    // wearing an argument's clothes.
    for (const r of CONTESTED_PATH_RATCHET) {
      const clash = DECLARED_SHARED_PATHS.find(
        (d) => d.method === r.method && normalisePath(d.path) === normalisePath(r.path),
      );
      assert.equal(clash, undefined, `${r.path} is on both lists`);
    }
  });
});
