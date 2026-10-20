import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerPath = join(apiRoot, "scripts/run-memory-sql-tests.mjs");
const files = ["src/test/MemorySnapshot.pglite.test.ts", "src/test/memoryVideoSegments.pglite.test.ts", "src/test/memoryImportBatches.pglite.test.ts", "src/test/MemorySnapshotLockFixture.test.ts"];
const names = [
  "MemorySnapshot persisted HTTP/provider/SQL path (isolated single-connection PGlite)",
  "3991 executable isolated SQL contract",
  "H37 durable owner-selected existing-memory backfill (isolated PostgreSQL)",
  "MemorySnapshot native fixture compatibility (PGlite, NOT concurrency proof)",
];
const imports = 'import assert from "node:assert/strict"; import { describe, it } from "node:test";';
const healthy = (name: string, body = 'it("SQL fixture assertion", () => assert.equal(1, 1));') =>
  `${imports}\ndescribe(${JSON.stringify(name)}, () => { ${body} });\n`;

interface FixtureOptions {
  source?: string;
  argumentsList?: string[];
  missingRuntime?: boolean;
  missingFile?: boolean;
  environment?: Record<string, string>;
  entry?: "canonical" | "directory-alias" | "file-alias";
  fixtureIndex?: number;
}

async function invoke(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "memory-sql-runner-test-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "src/test"), { recursive: true });
    await mkdir(join(directory, "node_modules/@electric-sql/pglite"), { recursive: true });
    await copyFile(runnerPath, join(directory, "scripts/run-memory-sql-tests.mjs"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await symlink(await realpath(join(apiRoot, "node_modules/tsx")), join(directory, "node_modules/tsx"), "dir");
    if (!options.missingRuntime) {
      await writeFile(join(directory, "node_modules/@electric-sql/pglite/package.json"), JSON.stringify({
        name: "@electric-sql/pglite", version: "0.2.17", type: "module", exports: "./index.js",
      }));
      await writeFile(join(directory, "node_modules/@electric-sql/pglite/index.js"), "export class PGlite {}\n");
    }
    for (const [index, file] of files.entries()) {
      if (options.missingFile && index === (options.fixtureIndex ?? 0)) continue;
      await writeFile(join(directory, file), index === (options.fixtureIndex ?? 0) && options.source !== undefined ? options.source : healthy(names[index]!));
    }
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      ...options.environment,
    };
    let entry = join(directory, "scripts/run-memory-sql-tests.mjs");
    if (options.entry === "canonical") entry = await realpath(entry);
    if (options.entry === "directory-alias") {
      await symlink(await realpath(directory), join(directory, "checkout-alias"), "dir");
      entry = join(directory, "checkout-alias/scripts/run-memory-sql-tests.mjs");
    }
    if (options.entry === "file-alias") {
      const alias = join(directory, "runner-alias.mjs");
      await symlink(await realpath(entry), alias, "file");
      entry = alias;
    }
    const result = spawnSync(process.execPath, [entry, ...(options.argumentsList ?? files)], {
      cwd: directory, env: environment, encoding: "utf8", timeout: 8_000, maxBuffer: 1_000_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, "runner must finish rather than relying on the fixture timeout");
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertExecuted(result: Awaited<ReturnType<typeof invoke>>) {
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /memory-sql: PASS: 4 tests; all 4 SQL suites executed; no skips or todos/);
  for (const file of files) assert.ok(result.output.includes(`${file}: suites=1 executed=1`), result.output);
}

describe("Memory SQL runner fail-closed executable controls", () => {
  it("accepts all four explicitly named SQL suites, including nested assertions", async () => {
    const result = await invoke({ source: healthy(names[0]!, 'describe("nested", () => { it("SQL assertion", () => assert.ok(true)); });') });
    assertExecuted(result);
  });

  for (const entry of ["canonical", "directory-alias", "file-alias"] as const) {
    it(`executes all required suites through the ${entry} entry path`, async () => {
      assertExecuted(await invoke({ entry }));
    });

    it(`fails closed without an installed runtime through the ${entry} entry path`, async () => {
      const result = await invoke({ entry, missingRuntime: true });
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /memory-sql: FAIL:.*pglite/);
      assert.doesNotMatch(result.output, /memory-sql: PASS/);
    });
  }

  it("replaces supplied runtimes and strips hosted credentials, discovery activation and database URLs", async () => {
    const body = `it("synthetic environment", () => {
      assert.equal(process.env.NODE_ENV, "test");
      assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:9");
      assert.equal(process.env.EXPO_PUBLIC_SUPABASE_URL, "http://127.0.0.1:9");
      for (const key of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_ANON_KEY"]) assert.equal(process.env[key], "dummy");
      for (const key of ["DISCOVERY_PGLITE_MODULE", "LOCAL_DB_URL", "DATABASE_URL", "OPENAI_API_KEY", "HTTP_PROXY", "NODE_OPTIONS", "NODE_PATH"]) assert.equal(process.env[key], undefined);
      const expected = new URL("../../node_modules/@electric-sql/pglite/index.js", import.meta.url).pathname;
      for (const key of ["MEMORY_SNAPSHOT_PGLITE_MODULE", "MEMORY_VIDEO_SEGMENTS_PGLITE_MODULE", "MEMORY_IMPORT_PGLITE_MODULE"]) assert.equal(process.env[key], expected);
    });`;
    const result = await invoke({ source: healthy(names[0]!, body), environment: {
      NODE_ENV: "production", SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-secret",
      SUPABASE_ANON_KEY: "synthetic-not-a-secret", EXPO_PUBLIC_SUPABASE_URL: "https://synthetic.invalid",
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "synthetic-not-a-secret", OPENAI_API_KEY: "synthetic-not-a-secret",
      DATABASE_URL: "postgresql://synthetic.invalid/never", LOCAL_DB_URL: "postgresql://synthetic.invalid/never",
      HTTP_PROXY: "http://synthetic.invalid", NODE_PATH: "/synthetic/not-used", NODE_OPTIONS: "--no-warnings",
      DISCOVERY_PGLITE_MODULE: "/synthetic/not-used", MEMORY_SNAPSHOT_PGLITE_MODULE: "/synthetic/not-used",
      MEMORY_VIDEO_SEGMENTS_PGLITE_MODULE: "/synthetic/not-used", MEMORY_IMPORT_PGLITE_MODULE: "/synthetic/not-used",
    } });
    assertExecuted(result);
  });

  for (const [label, argumentsList] of [
    ["missing arguments", []],
    ["legacy three-file invocation", files.slice(0, 3)],
    ["duplicate file", [files[0]!, files[0]!, files[2]!, files[3]!]],
    ["unrelated file", [files[0]!, files[1]!, "src/test/discoveryServeRetryIdentity.pglite.test.ts", files[3]!]],
    ["path traversal", [files[0]!, files[1]!, "../src/test/memoryImportBatches.pglite.test.ts", files[3]!]],
  ] as const) {
    it(`rejects ${label} before running anything`, async () => {
      const result = await invoke({ argumentsList: [...argumentsList] });
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /Pass each required file exactly once/);
      assert.doesNotMatch(result.output, /memory-sql: PASS/);
    });
  }

  it("fails closed without an installed runtime even when an external runtime variable is supplied", async () => {
    const result = await invoke({ missingRuntime: true, environment: { MEMORY_SNAPSHOT_PGLITE_MODULE: "/synthetic/not-used" } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /pglite/);
    assert.doesNotMatch(result.output, /memory-sql: PASS/);
  });

  for (const fixtureIndex of [0, 3]) {
    it(`fails closed when required file ${files[fixtureIndex]} is missing`, async () => {
      const result = await invoke({ missingFile: true, fixtureIndex });
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /ENOENT/);
    });
  }

  const controls: Array<[string, string, RegExp]> = [
    ["skipped SQL suite hidden by passing controls", `${imports}\ndescribe(${JSON.stringify(names[0])}, { skip: true }, () => { it("not run", () => {}); }); it("unrelated control", () => {});`, /Skipped suite/],
    ["skipped test", healthy(names[0]!, 'it("skipped assertion", { skip: true }, () => {}); it("control", () => {});'), /Skipped test/],
    ["todo SQL suite", `${imports}\ndescribe(${JSON.stringify(names[0])}, { todo: true }, () => { it("assertion", () => {}); });`, /Todo suite/],
    ["todo test", healthy(names[0]!, 'it("todo assertion", { todo: true }, () => {});'), /Todo test/],
    ["failing todo test", healthy(names[0]!, 'it("todo failure", { todo: true }, () => assert.fail("expected failure"));'), /Todo test/],
    ["assertion failure", healthy(names[0]!, 'it("broken assertion", () => assert.fail("deliberate control"));'), /Failed: broken assertion/],
    ["cancelled test", healthy(names[0]!, 'it("cancelled assertion", { signal: AbortSignal.abort() }, () => {});'), /Failed: cancelled assertion/],
    ["bounded test timeout", healthy(names[0]!, 'it("timed assertion", { timeout: 25 }, async (context) => { const timer = setInterval(() => {}, 100); context.signal.addEventListener("abort", () => clearInterval(timer), { once: true }); await new Promise(() => {}); });'), /Failed: timed assertion/],
    ["missing expected SQL suite", healthy("unrelated suite"), /Expected exactly one successful SQL suite/],
    ["a test impersonating the expected suite", `${imports}\nit(${JSON.stringify(names[0])}, () => {});`, /Expected exactly one successful SQL suite/],
    ["empty SQL suite hidden by an unrelated pass", `${healthy(names[0]!, "")}it("unrelated control", () => {});`, /Zero executed SQL tests/],
    ["no SQL assertions despite forged TAP output", 'console.log("ok 1 - SQL # pass 999\\n# skipped 0");', /Zero executed SQL tests/],
    ["duplicate expected suites", healthy(names[0]!) + `describe(${JSON.stringify(names[0])}, () => { it("duplicate", () => {}); });`, /Expected exactly one successful SQL suite/],
    ["early successful process exit", "process.exit(0);", /Zero executed SQL tests/],
  ];
  for (const fixtureIndex of [0, 3]) {
    for (const [label, source, expected] of controls) {
      it(`rejects ${label} in ${files[fixtureIndex]}`, async () => {
        const result = await invoke({ source: source.replaceAll(names[0]!, names[fixtureIndex]!), fixtureIndex });
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, expected);
        assert.doesNotMatch(result.output, /memory-sql: PASS/);
      });
    }
  }
});
