import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const files = [
  "src/test/mediaCaptionManifestSql.test.ts",
  "src/test/mediaCaptionAsrConsentSql.test.ts",
  "src/test/mediaDubbingCaptionSql.test.ts",
  "src/test/mediaVisualGenerationSql.test.ts",
  "src/test/mediaDerivativeCleanupSql.test.ts",
  "src/test/mediaCaptionTranslationSql.test.ts",
];
const names = [
  "offline real Postgres caption manifest CAS, full generation snapshot, deletion and role denial",
  "real offline queue/consent transaction: explicit grant, idempotency, revoke, regrant isolation and atomic rollback",
  "caption edits atomically withdraw completed dubbing and reject stale caption grants",
  "3981/3982 atomic generation cleanup includes actual 3320 implicit version bumps",
  "offline PostgreSQL cleanup CAS, role boundary, generation trigger and hard-delete FK cascade",
];
const visualCases = ["visibility='private'", "public_url='https://synthetic.invalid/replaced.png'", "visibility=visibility"];
const translationNames = [
  "a delayed old opt-in cannot create a fresh grant after acknowledged revoke",
  "revoke retains durable cleanup debt for an in-flight writer even before its object exists",
  "offline translation grant: explicit consent, original generation, idempotency, rollback and fresh identity after revoke",
  "translation publication cannot use missing, revoked, wrong-job or unreviewed consent",
  "completed reviewed translation commits exact manifest then invalidates grant; manual six-argument CAS remains valid",
  "final translation CAS checks the live canonical caption path even if a JS preload was current",
  "caption deletion and edit invalidate translation leases without source-version rebasing",
  "OFF and config/source changes deny publication; revoke remains available while OFF and deleted",
  "translation tables and all RPCs reject anon/authenticated roles",
  "additive 3995 preserves OFF flags and requires retained positively-settled draft and publication identities",
];
const imports = 'import assert from "node:assert/strict"; import { test, describe } from "node:test";';
const namedTest = (name: string, body = "assert.equal(1, 1);", options = "{}") =>
  `test(${JSON.stringify(name)}, ${options}, async (context) => { ${body} });`;
const healthy = (index: number, body?: string) => index === 5
  ? `${imports}\n${translationNames.map((name) => namedTest(name, body)).join("\n")}\n`
  : `${imports}\n${namedTest(names[index]!, body ?? (index === 3
  ? visualCases.map((name) => `await context.test(${JSON.stringify(name)}, () => assert.equal(1, 1));`).join("\n")
  : "assert.equal(1, 1);"))}\n`;

interface FixtureOptions {
  source?: string;
  sources?: Record<number, string>;
  fixtureIndex?: number;
  argumentsList?: string[];
  environment?: Record<string, string>;
  entry?: "canonical" | "directory-alias" | "file-alias";
  missingRuntime?: boolean;
  missingVector?: boolean;
  missingLoader?: boolean;
  version?: string;
  packageName?: string;
  fileState?: "missing" | "directory" | "duplicate" | "outside";
  shortWatchdog?: boolean;
  summaryMutation?: "missing" | "duplicate" | "unsuccessful" | "tests" | "passed" | "suites" | "failed" | "cancelled" | "skipped" | "todo";
  ownedDescendant?: boolean;
  rawPipeOutput?: { channel: "stdout" | "stderr"; newline: boolean; bytes?: number; utf8?: boolean; directFd?: boolean; inherited?: boolean };
  ownedFixtureIndex?: number;
  rawPipeMutation?: "missing-preload" | "duplicate-binding" | "unknown-binding";
}

async function invoke(options: FixtureOptions = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "media-sql-runner-test-")));
  const directory = join(temporary, "checkout");
  const descendantFile = join(temporary, "descendant.pid");
  try {
    await mkdir(join(directory, "scripts"), { recursive: true });
    await mkdir(join(directory, "src/test"), { recursive: true });
    const runtime = join(directory, "node_modules/@electric-sql/pglite");
    await mkdir(join(runtime, "dist/vector"), { recursive: true });
    let sourceRunner = await readFile(join(apiRoot, "scripts/run-media-sql-tests.mjs"), "utf8");
    if (options.rawPipeMutation === "missing-preload") {
      const preload = '"--import", import.meta.url, "--import", loader';
      assert.ok(sourceRunner.includes(preload));
      sourceRunner = sourceRunner.replace(preload, '"--import", loader');
    } else if (options.rawPipeMutation) {
      const binding = 'process.stdout.write(`${JSON.stringify({ type: "media:raw-pipe", data: { file } })}\\n`);';
      assert.ok(sourceRunner.includes(binding));
      sourceRunner = sourceRunner.replace(binding, options.rawPipeMutation === "duplicate-binding"
        ? `${binding}\n${binding}` : binding.replace("data: { file }", 'data: { file: "synthetic" }'));
    }
    if (options.shortWatchdog || options.rawPipeOutput) assert.ok(sourceRunner.includes("const runTimeoutMs = 180_000;"));
    await writeFile(join(directory, "scripts/run-media-sql-tests.mjs"), options.rawPipeOutput
      ? sourceRunner.replace("const runTimeoutMs = 180_000;", "const runTimeoutMs = 1600;")
      : options.shortWatchdog ? sourceRunner.replace("const runTimeoutMs = 180_000;", "const runTimeoutMs = 500;") : sourceRunner);
    const reporterPath = join(directory, "scripts/run-memory-sql-tests.mjs");
    if (options.summaryMutation) {
      const original = await readFile(join(apiRoot, "scripts/run-memory-sql-tests.mjs"), "utf8");
      const anchor = "const data = { ...event.data };";
      assert.ok(original.includes(anchor));
      const mutations = {
        missing: "continue;",
        duplicate: 'yield JSON.stringify({ type: event.type, data }) + "\\n";',
        unsuccessful: "data.success = false;",
        tests: "data.counts = { ...data.counts, tests: 17 };",
        passed: "data.counts = { ...data.counts, passed: 17 };",
        suites: "data.counts = { ...data.counts, suites: 1 };",
        failed: "data.counts = { ...data.counts, failed: 1 };",
        cancelled: "data.counts = { ...data.counts, cancelled: 1 };",
        skipped: "data.counts = { ...data.counts, skipped: 1 };",
        todo: "data.counts = { ...data.counts, todo: 1 };",
      };
      await writeFile(reporterPath, original.replace(anchor, `${anchor}\nif (event.type === "test:summary" && !data.file) { ${mutations[options.summaryMutation]} }`));
    } else await copyFile(join(apiRoot, "scripts/run-memory-sql-tests.mjs"), reporterPath);
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    if (!options.missingLoader) await symlink(await realpath(join(apiRoot, "node_modules/tsx")), join(directory, "node_modules/tsx"), "dir");
    if (!options.missingRuntime) {
      await writeFile(join(runtime, "package.json"), JSON.stringify({
        name: options.packageName ?? "@electric-sql/pglite", version: options.version ?? "0.2.17", type: "module",
        exports: { ".": "./dist/index.js", "./vector": "./dist/vector/index.js" },
      }));
      await writeFile(join(runtime, "dist/index.js"), "export class PGlite {}\n");
      if (!options.missingVector) await writeFile(join(runtime, "dist/vector/index.js"), "export const vector = {};\n");
    }
    for (const [index, file] of files.entries()) {
      const target = join(directory, file);
      if (index === (options.fixtureIndex ?? 0) && options.fileState) {
        if (options.fileState === "directory") await mkdir(target);
        if (options.fileState === "duplicate") await symlink(join(directory, files[1]!), target);
        if (options.fileState === "outside") {
          const outside = join(temporary, "outside.test.ts");
          await writeFile(outside, healthy(index));
          await symlink(outside, target);
        }
        continue;
      }
      const rawOutput = options.rawPipeOutput;
      const outputExpression = rawOutput?.utf8 ? '"界".repeat(1_400_000)'
        : `"x".repeat(${rawOutput?.bytes ?? 4_100_000})`;
      const outputBody = `${outputExpression} + ${JSON.stringify(rawOutput?.newline ? "\n" : "")}`;
      const outputStatement = rawOutput?.directFd
        ? `const { writeSync } = await import("node:fs"); writeSync(2, ${outputBody});`
        : rawOutput?.inherited
          ? `const writer = spawn(process.execPath, ["-e", ${JSON.stringify(`process.stderr.write(${outputBody});`)}], { env: {}, stdio: ["ignore", "ignore", "inherit"] }); await new Promise(resolve => writer.once("exit", resolve));`
          : `await new Promise(resolve => process.${rawOutput?.channel ?? "stdout"}.write(${outputBody}, resolve));`;
      const descendantSource = options.ownedDescendant && index === (options.ownedFixtureIndex ?? 0) ? healthy(index, `
        const { spawn } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 100);`)}], { env: {}, stdio: "ignore" });
        assert.ok(descendant.pid);
        for (let attempt = 0; attempt < 100 && !existsSync(${JSON.stringify(descendantFile)}); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(existsSync(${JSON.stringify(descendantFile)}));
        ${outputStatement}
        setInterval(() => {}, 100); await new Promise(() => {});
      `) : undefined;
      await writeFile(target, descendantSource ?? options.sources?.[index] ?? (index === (options.fixtureIndex ?? 0) && options.source !== undefined ? options.source : healthy(index)));
    }
    let entry = join(directory, "scripts/run-media-sql-tests.mjs");
    if (options.entry === "canonical") entry = await realpath(entry);
    if (options.entry === "directory-alias") {
      const alias = join(temporary, "checkout-alias");
      await symlink(directory, alias, "dir");
      entry = join(alias, "scripts/run-media-sql-tests.mjs");
    }
    if (options.entry === "file-alias") {
      const alias = join(temporary, "runner-alias.mjs");
      await symlink(entry, alias, "file");
      entry = alias;
    }
    const result = spawnSync(process.execPath, [entry, ...(options.argumentsList ?? files)], {
      cwd: temporary,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...options.environment,
        NODE_V8_COVERAGE: options.environment?.NODE_V8_COVERAGE ? join(temporary, "inherited-coverage") : undefined,
      },
      encoding: "utf8", timeout: 10_000, maxBuffer: 6_000_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, "runner must stop its own child rather than rely on the fixture timeout");
    if (options.ownedDescendant) {
      const pid = Number(await readFile(descendantFile, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 1);
      const running = () => {
        try { process.kill(pid, 0); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
      };
      for (let attempt = 0; attempt < 100 && running(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(running(), false, "output limit must terminate the owned descendant, not only the reporter");
    }
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    if (options.ownedDescendant) {
      try {
        const pid = Number(await readFile(descendantFile, "utf8"));
        if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertExecuted(result: Awaited<ReturnType<typeof invoke>>) {
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /media-sql: PASS: 18 named tests; all 6 SQL files executed; no skips or todos/);
  for (const [index, file] of files.entries()) {
    const expected = index === 3 ? 4 : index === 5 ? 10 : 1;
    assert.ok(result.output.includes(`${file}: expected=${expected} executed=${expected}`), result.output);
  }
}

function assertRejected(result: Awaited<ReturnType<typeof invoke>>, expected: RegExp) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, expected);
  assert.doesNotMatch(result.output, /media-sql: PASS:/);
}

describe("Media SQL runner fail-closed executable controls", () => {
  for (const entry of ["canonical", "directory-alias", "file-alias"] as const) {
    it(`executes every named root and visual child through the ${entry} path`, async () => {
      assertExecuted(await invoke({ entry }));
    });
    it(`cannot bypass missing runtime through the ${entry} path`, async () => {
      assertRejected(await invoke({ entry, missingRuntime: true }), /pglite/);
    });
  }

  it("accepts the complete explicit manifest in a different order", async () => {
    assertExecuted(await invoke({ argumentsList: [...files].reverse() }));
  });

  it("replaces runtime overrides, strips filters/secrets/flags, and proves every file executed", async () => {
    const environment = {
      NODE_ENV: "production", NODE_OPTIONS: "--no-warnings", NODE_PATH: "/synthetic/not-used",
      NODE_TEST_CONTEXT: "synthetic-inherited-context", NODE_TEST_NAME_PATTERN: "does-not-match", NODE_TEST_SKIP_PATTERN: ".*",
      TEST_NAME_PATTERN: "does-not-match", TSX_TSCONFIG_PATH: "/synthetic/not-used",
      SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-secret",
      SUPABASE_ANON_KEY: "synthetic-not-secret", EXPO_PUBLIC_SUPABASE_URL: "https://synthetic.invalid",
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "synthetic-not-secret", DATABASE_URL: "postgresql://synthetic.invalid/never",
      LOCAL_DB_URL: "postgresql://synthetic.invalid/never", OPENAI_API_KEY: "synthetic-not-secret",
      HTTP_PROXY: "http://synthetic.invalid", HTTPS_PROXY: "http://synthetic.invalid",
      AWS_ACCESS_KEY_ID: "synthetic-not-secret", AWS_SECRET_ACCESS_KEY: "synthetic-not-secret",
      NODE_V8_COVERAGE: "/synthetic/not-used", CAPTION_QUEUE_MIGRATION: "/synthetic/not-used.sql",
      TRANSLATION_QUEUE_MIGRATION: "/synthetic/not-used.sql", TRANSLATION_CAPTION_MIGRATION: "/synthetic/not-used.sql", TRANSLATION_MIGRATION: "/synthetic/not-used.sql",
      CAPTION_PGLITE_MODULE: "/synthetic/not-used", MEDIA_CLEANUP_PGLITE_MODULE: "/synthetic/not-used",
      PGLITE_ROOT: "/synthetic/not-used", TRANSLATION_PGLITE_MODULE: "/synthetic/not-used",
      DISCOVERY_PGLITE_MODULE: "/synthetic/not-used", MEDIA_VISUAL_GENERATION_MUTATION: "3981",
      FFMPEG_PATH: "/synthetic/not-used", MEDIA_REQUIRE_ENCODING_TESTS: "true",
    };
    const body = `
      assert.equal(process.env.NODE_ENV, "test");
      assert.equal(process.env.TSX_DISABLE_CACHE, "1");
      for (const key of ["SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL"]) assert.equal(process.env[key], "http://127.0.0.1:9");
      for (const key of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_ANON_KEY"]) assert.equal(process.env[key], "dummy");
      const root = new URL("../../node_modules/@electric-sql/pglite", import.meta.url).pathname;
      assert.equal(process.env.PGLITE_ROOT, root);
      for (const key of ["CAPTION_PGLITE_MODULE", "MEDIA_CLEANUP_PGLITE_MODULE", "TRANSLATION_PGLITE_MODULE"]) assert.equal(process.env[key], root + "/dist/index.js");
      for (const key of ${JSON.stringify(Object.keys(environment).filter((key) => ![
        "NODE_ENV", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_ANON_KEY",
        "CAPTION_PGLITE_MODULE", "MEDIA_CLEANUP_PGLITE_MODULE", "TRANSLATION_PGLITE_MODULE", "PGLITE_ROOT", "NODE_TEST_CONTEXT",
      ].includes(key)))}) assert.equal(process.env[key], undefined, key);
      assert.notEqual(process.env.NODE_TEST_CONTEXT, "synthetic-inherited-context");
    `;
    assertExecuted(await invoke({ source: healthy(0, body), environment }));
  });

  for (const [label, argumentsList] of [
    ["missing manifest", []], ["omitted last file", files.slice(0, -1)],
    ["duplicate file", [files[0]!, ...files.slice(0, -1)]],
    ["translation substituted for cleanup", [...files.slice(0, 4), files[5]!]],
    ["path traversal", [`../${files[0]}`, ...files.slice(1)]],
    ["extra unrelated file", [...files, "src/test/unrelated.test.ts"]],
    ["test-name filter", ["--test-name-pattern=never", ...files]],
    ["test-skip filter", ["--test-skip-pattern=.*", ...files]],
    ["test-only filter", ["--test-only", ...files]],
  ] as const) {
    it(`rejects ${label} before execution`, async () => {
      assertRejected(await invoke({ argumentsList: [...argumentsList] }), /Pass each required file exactly once/);
    });
  }

  for (const version of ["0.2.16", "0.2.18", "0.2.17-beta.1"]) {
    it(`rejects installed PGlite version ${version}`, async () => {
      assertRejected(await invoke({ version }), /must be exactly 0.2.17/);
    });
  }
  it("rejects a package with the wrong identity", async () => {
    assertRejected(await invoke({ packageName: "synthetic-pglite" }), /must be exactly 0.2.17/);
  });
  it("rejects a missing vector extension", async () => {
    assertRejected(await invoke({ missingVector: true }), /ENOENT/);
  });
  it("rejects a missing TSX loader", async () => {
    assertRejected(await invoke({ missingLoader: true }), /tsx/);
  });
  it("cannot substitute an external environment runtime for a missing installed package", async () => {
    assertRejected(await invoke({ missingRuntime: true, environment: {
      CAPTION_PGLITE_MODULE: "/synthetic/external.js", PGLITE_ROOT: "/synthetic/external",
    } }), /pglite/);
  });

  for (const [fileState, expected] of [
    ["missing", /ENOENT/], ["directory", /Not a regular file/],
    ["duplicate", /distinct files/], ["outside", /escapes API root/],
  ] as const) {
    it(`rejects a ${fileState} required file`, async () => {
      assertRejected(await invoke({ fileState }), expected);
    });
  }

  const controls: Array<[string, (index: number) => string, RegExp]> = [
    ["skipped expected test", (index) => `${imports}${namedTest(names[index]!, "", "{ skip: true }")}`, /Skipped:/],
    ["todo expected test", (index) => `${imports}${namedTest(names[index]!, "", "{ todo: true }")}`, /Todo:/],
    ["failing todo", (index) => `${imports}${namedTest(names[index]!, 'assert.fail("intentional");', "{ todo: true }")}`, /Todo:/],
    ["assertion failure", (index) => healthy(index, 'assert.fail("intentional");'), /Failed:/],
    ["cancelled test", (index) => `${imports}${namedTest(names[index]!, "", "{ signal: AbortSignal.abort() }")}`, /Failed:/],
    ["bounded test timeout", (index) => `${imports}${namedTest(names[index]!, `
      const timer = setInterval(() => {}, 100);
      context.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
      await new Promise(() => {});
    `, "{ timeout: 25 }")}`, /Failed:/],
    ["wrong named test", () => `${imports}${namedTest("unrelated passing test")}`, /Expected exactly one successful named test/],
    ["empty suite impersonation", (index) => `${imports}describe(${JSON.stringify(names[index])}, () => {});`, /Expected exactly one successful named test/],
    ["nested root impersonation", (index) => `${imports}describe("unrelated", () => { ${namedTest(names[index]!)} });`, /Expected exactly one successful named test/],
    ["duplicate expected test", (index) => healthy(index) + namedTest(names[index]!), /received 2/],
    ["zero execution", () => "", /Expected exactly one successful named test/],
    ["early exit zero", () => "process.exit(0);", /Expected exactly one successful named test/],
    ["stdout TAP and event spoof", (index) => `
      import { fileURLToPath } from "node:url";
      const data = { file: fileURLToPath(import.meta.url), name: ${JSON.stringify(names[index])}, nesting: 0, details: { type: "test" } };
      for (const type of ["test:start", "test:pass"]) console.log(JSON.stringify({ type, data }));
      console.log(JSON.stringify({ type: "test:summary", data: { success: true, counts: { tests: 18, passed: 18, suites: 0, skipped: 0, todo: 0, failed: 0, cancelled: 0 } } }));
      console.log("ok 1 - SQL\\n# pass 999\\n# skipped 0");
    `, /Expected exactly one successful named test/],
    ["failure after otherwise successful evidence", (index) => healthy(index) + "process.exitCode = 1;", /Test process exited|Failed:/],
  ];
  for (const fixtureIndex of [0, 4]) {
    for (const [label, source, expected] of controls) {
      it(`rejects ${label} in ${files[fixtureIndex]}`, async () => {
        assertRejected(await invoke({ source: source(fixtureIndex), fixtureIndex }), expected);
      });
    }
  }

  for (const [label, body, expected] of [
    ["missing visual child", "assert.ok(true);", /Expected exactly one successful named test/],
    ["wrong visual children", 'await context.test("unrelated", () => {});', /Unexpected test evidence/],
    ["skipped visual child", visualCases.map((name) => `await context.test(${JSON.stringify(name)}, { skip: true }, () => {});`).join("\n"), /Skipped:/],
    ["todo visual child", visualCases.map((name) => `await context.test(${JSON.stringify(name)}, { todo: true }, () => {});`).join("\n"), /Todo:/],
  ] as const) {
    it(`rejects ${label} even when the expected root passes`, async () => {
      assertRejected(await invoke({ source: healthy(3, body), fixtureIndex: 3 }), expected);
    });
  }

  it("bounds a stuck child with the production watchdog path and fails closed", async () => {
    assertRejected(await invoke({ source: "setInterval(() => {}, 100);", shortWatchdog: true }), /Whole-run timeout exceeded 500ms/);
  });

  for (const channel of ["stdout", "stderr"] as const) {
    it(`output budget rejects 4.1 MB of ordinary ${channel} before filtering`, async () => {
      assertRejected(await invoke({ source: healthy(0, `await new Promise(resolve => process.${channel}.write("x".repeat(4_100_000), resolve));`) }), /output exceeded 4000000/);
    });
  }
  it("output budget accumulates both streams across separate required files", async () => {
    assertRejected(await invoke({ sources: {
      0: healthy(0, 'await new Promise(resolve => process.stdout.write("x".repeat(2_100_000), resolve));'),
      4: healthy(4, 'await new Promise(resolve => process.stderr.write("x".repeat(2_100_000), resolve));'),
    } }), /output exceeded 4000000/);
  });
  it("output budget accumulates ordinary output and serialized failure evidence", async () => {
    assertRejected(await invoke({ source: healthy(0, 'await new Promise(resolve => process.stdout.write("x".repeat(2_100_000), resolve)); throw Error("y".repeat(2_100_000));') }), /output exceeded 4000000/);
  });
  it("output budget counts UTF-8 bytes rather than UTF-16 string length", async () => {
    assertRejected(await invoke({ source: healthy(0, 'await new Promise(resolve => process.stdout.write("界".repeat(1_400_000), resolve));') }), /output exceeded 4000000/);
  });
  it("output budget also covers discarded diagnostics", async () => {
    assertRejected(await invoke({ source: healthy(0, 'context.diagnostic("x".repeat(4_100_000));') }), /output exceeded 4000000/);
  });
  it("output budget still rejects an oversized serialized assertion failure", async () => {
    assertRejected(await invoke({ source: healthy(0, 'throw Error("x".repeat(4_100_000));') }), /output exceeded 4000000/);
  });
  it("output budget preserves below-limit output without admitting fake fatal or success records", async () => {
    assertExecuted(await invoke({ source: healthy(0, `
      await new Promise(resolve => process.stdout.write("x".repeat(900_000), resolve));
      await new Promise(resolve => process.stderr.write("y".repeat(900_000), resolve));
      console.log(JSON.stringify({type:"media:output-limit",data:{limit:4000000}}));
      console.error(JSON.stringify({type:"test:summary",data:{success:true,counts:{tests:999,passed:999}}}));
    `) }));
  });

  it("output budget fatally terminates its stuck test and owned SIGTERM-resistant descendant", async () => {
    assertRejected(await invoke({ ownedDescendant: true }), /output exceeded 4000000/);
  });

  for (const channel of ["stdout", "stderr"] as const) {
    for (const newline of [false, true]) {
      it(`raw-pipe budget stops stuck ${channel} newline=${newline} before the watchdog`, async () => {
        const result = await invoke({ ownedDescendant: true, rawPipeOutput: { channel, newline } });
        assertRejected(result, /output exceeded 4000000/);
        assert.doesNotMatch(result.output, /Whole-run timeout/);
      });
    }
  }
  for (const mode of ["utf8", "directFd", "inherited"] as const) {
    it(`raw-pipe budget stops unterminated ${mode} stderr before the watchdog`, async () => {
      const result = await invoke({ ownedDescendant: true, rawPipeOutput: { channel: "stderr", newline: false, [mode]: true } });
      assertRejected(result, /output exceeded 4000000/);
      assert.doesNotMatch(result.output, /Whole-run timeout/);
    });
  }
  it("raw-pipe budget includes prior stdout when a later file stalls on unterminated stderr", async () => {
    const result = await invoke({
      sources: { 0: healthy(0, 'await new Promise(resolve => process.stdout.write("x".repeat(2_100_000), resolve));') },
      ownedDescendant: true, ownedFixtureIndex: 4,
      rawPipeOutput: { channel: "stderr", newline: false, bytes: 2_100_000 },
    });
    assertRejected(result, /output exceeded 4000000/);
    assert.doesNotMatch(result.output, /Whole-run timeout/);
  });
  it("raw-pipe budget does not double count healthy stderr or trust printed binding records", async () => {
    assertExecuted(await invoke({ sources: {
      0: healthy(0, 'await new Promise(resolve => process.stderr.write("x".repeat(1_900_000), resolve));'),
      4: healthy(4, `
        await new Promise(resolve => process.stdout.write("y".repeat(1_900_000), resolve));
        console.log(JSON.stringify({type:"media:raw-pipe",data:{file:"synthetic"}}));
        console.error(JSON.stringify({type:"media:output-limit",data:{limit:4000000}}));
      `),
    } }));
  });
  it("raw-pipe budget accumulates stderr from prior files before a later unterminated write", async () => {
    const result = await invoke({
      sources: {
        0: healthy(0, 'await new Promise(resolve => process.stderr.write("x".repeat(1_500_000), resolve));'),
        1: healthy(1, 'await new Promise(resolve => process.stderr.write("y".repeat(1_500_000), resolve));'),
      },
      ownedDescendant: true, ownedFixtureIndex: 4,
      rawPipeOutput: { channel: "stderr", newline: false, bytes: 1_100_000 },
    });
    assertRejected(result, /output exceeded 4000000/);
    assert.doesNotMatch(result.output, /Whole-run timeout/);
  });
  it("raw-pipe budget refuses a missing preloader despite real passes and forged raw binding text", async () => {
    const result = await invoke({ rawPipeMutation: "missing-preload", source: healthy(0, `
      const { fileURLToPath } = await import("node:url");
      for (const path of ${JSON.stringify(files)}) {
        const file = fileURLToPath(new URL("../../" + path, import.meta.url));
        const record = JSON.stringify({ type: "media:raw-pipe", data: { file } });
        console.log(record); console.error(record); context.diagnostic(record);
      }
    `) });
    assertRejected(result, /Missing raw-pipe binding/);
    for (const [index, file] of files.entries()) {
      const count = index === 3 ? 4 : index === 5 ? 10 : 1;
      assert.ok(result.output.includes(`${file}: expected=${count} executed=${count}`));
    }
  });
  for (const rawPipeMutation of ["duplicate-binding", "unknown-binding"] as const) {
    it(`raw-pipe budget refuses ${rawPipeMutation} control evidence`, async () => {
      assertRejected(await invoke({ rawPipeMutation }), /Unreadable test event stream/);
    });
  }

  it("executes all ten translation roots exactly once even in reversed declaration order", async () => {
    assertExecuted(await invoke({ fixtureIndex: 5, source: `${imports}\n${[...translationNames].reverse().map((name) => namedTest(name)).join("\n")}` }));
  });
  for (const rootIndex of [0, 5, 9]) {
    for (const mutation of ["missing", "wrong", "duplicate", "nested", "skipped", "todo", "failed"] as const) {
      it(`rejects ${mutation} translation root ${rootIndex + 1} despite other roots passing`, async () => {
        const declarations = translationNames.flatMap((name, index) => {
          if (index !== rootIndex) return [namedTest(name)];
          if (mutation === "missing") return [];
          if (mutation === "wrong") return [namedTest(`${name} wrong`)];
          if (mutation === "duplicate") return [namedTest(name), namedTest(name)];
          if (mutation === "nested") return [`describe("wrong nesting", () => { ${namedTest(name)} });`];
          if (mutation === "skipped") return [namedTest(name, "", "{ skip: true }")];
          if (mutation === "todo") return [namedTest(name, "", "{ todo: true }")];
          return [namedTest(name, 'assert.fail("translation failure");')];
        });
        const expected = mutation === "duplicate" ? /received 2/ : mutation === "skipped" ? /Skipped:/
          : mutation === "todo" ? /Todo:/ : mutation === "failed" ? /Failed:/ : /Expected exactly one successful named test/;
        assertRejected(await invoke({ fixtureIndex: 5, source: `${imports}\n${declarations.join("\n")}` }), expected);
      });
    }
  }
  it("rejects an unexpected translation root even when all ten expected roots pass", async () => {
    assertRejected(await invoke({ fixtureIndex: 5, source: healthy(5) + namedTest("unexpected translation root") }), /Unexpected test evidence/);
  });
  for (const summaryMutation of ["missing", "duplicate", "unsuccessful", "tests", "passed", "suites", "failed", "cancelled", "skipped", "todo"] as const) {
    it(`rejects ${summaryMutation} final summary despite all 18 named passes`, async () => {
      assertRejected(await invoke({ summaryMutation }), /summary|Summary/);
    });
  }
});
