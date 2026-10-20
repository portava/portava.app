import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifests = [
  { profile: "snapshot", file: "src/test/MemorySnapshot.postgres.test.ts", name: "MemorySnapshot native two-session locks (fresh socket-only disposable cluster)", variable: "MEMORY_SNAPSHOT_POSTGRES_BIN" },
  { profile: "video", file: "src/test/memoryVideoSegments.postgres.test.ts", name: "3991 native PostgreSQL two-session segment races (fresh socket-only cluster)", variable: "MEMORY_VIDEO_SEGMENTS_POSTGRES_BIN" },
  { profile: "import", file: "src/test/memoryImportBatches.postgres.test.ts", name: "H37 native import/correction locks (fresh socket-only disposable cluster)", variable: "MEMORY_IMPORT_POSTGRES_BIN" },
  { profile: "policy", file: "src/test/resurfacingPolicy.native.test.ts", name: "H146 owner resurfacing policy native contract", variable: "PORTAVA_TEST_POSTGRES_BIN" },
  { profile: "review", file: "src/test/reportedReviewRemoval.native.test.ts", name: "reported-review audited removal: PostgreSQL 17", variable: "PORTAVA_TEST_POSTGRES_BIN" },
  { profile: "media-translation", file: "src/test/mediaCaptionTranslationHardDelete.native.test.ts", name: "Caption translation retained hard-delete recovery", variable: "PORTAVA_TEST_POSTGRES_BIN" },
  { profile: "account-media", file: "src/test/accountDeletionMediaBoundary.native.test.ts", name: "Account Media deletion native source barrier", variable: "PORTAVA_TEST_POSTGRES_BIN" },
];
const files = manifests.slice(0, 4).map((manifest) => manifest.file);
const imports = 'import assert from "node:assert/strict"; import { describe, it } from "node:test";';
const healthy = (name: string, body = 'it("native fixture assertion", () => assert.equal(1, 1));') =>
  `${imports}\ndescribe(${JSON.stringify(name)}, () => { ${body} });\n`;

interface FixtureOptions {
  source?: string;
  fixtureIndex?: number;
  argumentsList?: string[];
  missingFile?: boolean;
  duplicateFile?: boolean;
  outsideFile?: boolean;
  missingLoader?: boolean;
  missingVariable?: string;
  binaryShape?: "missing" | "directory" | "non-executable";
  directoryShape?: "relative" | "missing" | "file";
  environment?: NodeJS.ProcessEnv;
  entry?: "canonical" | "directory-alias" | "file-alias";
}

async function invoke(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "memory-native-runner-test-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "src/test"), { recursive: true });
    await mkdir(join(directory, "node_modules"));
    await mkdir(join(directory, "bin"));
    for (const name of ["run-memory-native-tests.mjs", "run-memory-sql-tests.mjs"]) {
      await copyFile(join(apiRoot, "scripts", name), join(directory, "scripts", name));
    }
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    if (!options.missingLoader) await symlink(await realpath(join(apiRoot, "node_modules/tsx")), join(directory, "node_modules/tsx"), "dir");
    for (const name of ["initdb", "pg_ctl", "psql", "postgres"]) {
      const target = join(directory, "bin", name);
      if (name === "initdb" && options.binaryShape === "missing") continue;
      if (name === "initdb" && options.binaryShape === "directory") await mkdir(target);
      else if (name === "initdb" && options.binaryShape === "non-executable") {
        await writeFile(target, "synthetic non-executable fixture");
        await chmod(target, 0o600);
      } else await symlink(process.execPath, target, "file");
    }
    for (const [index, manifest] of manifests.entries()) {
      if (options.missingFile && index === (options.fixtureIndex ?? 0)) continue;
      if (options.duplicateFile && index === 1) {
        await symlink(join(directory, files[0]!), join(directory, manifest.file), "file");
      } else if (options.outsideFile && index === 0) {
        await symlink(join(apiRoot, manifest.file), join(directory, manifest.file), "file");
      } else await writeFile(join(directory, manifest.file), index === (options.fixtureIndex ?? 0) && options.source !== undefined
        ? options.source : healthy(manifest.name, ["media-translation", "account-media"].includes(manifest.profile)
          ? Array.from({ length: manifest.profile === "account-media" ? 15 : 28 }, (_, index) => `it("native assertion ${index}", () => assert.equal(1, 1));`).join("\n")
          : undefined));
    }
    const binaryDirectory = options.directoryShape === "relative" ? "bin" : options.directoryShape === "missing"
      ? join(directory, "no-bin") : options.directoryShape === "file" ? join(directory, "package.json") : join(directory, "bin");
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      ...Object.fromEntries(manifests.map(({ variable }) => [variable, binaryDirectory])),
      ...options.environment,
    };
    if (options.missingVariable) delete environment[options.missingVariable];
    let entry = join(directory, "scripts/run-memory-native-tests.mjs");
    if (options.entry === "canonical") entry = await realpath(entry);
    if (options.entry === "directory-alias") {
      await symlink(await realpath(directory), join(directory, "checkout-alias"), "dir");
      entry = join(directory, "checkout-alias/scripts/run-memory-native-tests.mjs");
    }
    if (options.entry === "file-alias") {
      const alias = join(directory, "runner-alias.mjs");
      await symlink(await realpath(entry), alias, "file");
      entry = alias;
    }
    const result = spawnSync(process.execPath, [entry, ...(options.argumentsList ?? ["all", ...files])], {
      cwd: directory, env: environment, encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, "runner must finish without the fixture's emergency bound");
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertExecuted(result: Awaited<ReturnType<typeof invoke>>, selected = files) {
  assert.equal(result.status, 0, result.output);
  const count = (file: string) => file === manifests[5]!.file ? 28 : file === manifests[6]!.file ? 15 : 1;
  const total = selected.reduce((sum, file) => sum + count(file), 0);
  assert.ok(result.output.includes(`memory-native: PASS: ${total} tests; all ${selected.length} native suites executed; no skips or todos`), result.output);
  for (const file of selected) assert.ok(result.output.includes(`${file}: suites=1 executed=${count(file)}`), result.output);
}

function assertRefused(result: Awaited<ReturnType<typeof invoke>>, expected: RegExp) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, expected);
  assert.doesNotMatch(result.output, /memory-native: PASS/);
}

describe("Memory native runner fail-closed executable controls", () => {
  it("matches the builders' actual suite names and explicit binary variables", async () => {
    for (const { file, name, variable } of manifests) {
      const source = await readFile(join(apiRoot, file), "utf8");
      assert.ok(source.includes(`describe(${JSON.stringify(name)}`) || source.includes(`describe('${name}'`), file);
      assert.ok(source.includes(`process.env.${variable}`), file);
    }
  });

  it("registers dedicated commands with exact literal paths and runner controls", async () => {
    const { scripts } = JSON.parse(await readFile(join(apiRoot, "package.json"), "utf8"));
    for (const { profile, file } of manifests) {
      const command = profile === "review" ? "test:reported-review-native"
        : profile === "media-translation" ? "test:media-translation-native"
          : profile === "account-media" ? "test:account-media-native" : `test:memory-${profile}-native`;
      assert.equal(scripts[command], `node scripts/run-memory-native-tests.mjs ${profile} ${file}`);
    }
    assert.equal(scripts["test:memory-native"], `node scripts/run-memory-native-tests.mjs all ${files.join(" ")}`);
    assert.equal(scripts["test:memory-native-runner"], "node --import tsx/esm --test src/test/memoryNativeRunner.test.ts");
  });

  for (const { profile, file, variable } of manifests) {
    it(`runs the explicit ${profile} manifest without requiring other suites' binaries`, async () => {
      const environment = Object.fromEntries(manifests.filter((entry) => entry.variable !== variable).map(({ variable }) => [variable, undefined]));
      assertExecuted(await invoke({ argumentsList: [profile, file], environment }), [file]);
    });
  }

  it("requires nested evidence from all four suites", async () => {
    assertExecuted(await invoke({ source: healthy(manifests[0]!.name, 'describe("nested", () => { it("native assertion", () => assert.ok(true)); });') }));
  });

  for (const entry of ["canonical", "directory-alias", "file-alias"] as const) {
    it(`executes every suite through the ${entry} entry path`, async () => {
      assertExecuted(await invoke({ entry }));
    });
    it(`fails without binaries through the ${entry} entry path`, async () => {
      assertRefused(await invoke({ entry, missingVariable: manifests[0]!.variable }), /MEMORY_SNAPSHOT_POSTGRES_BIN must name/);
    });
  }

  for (const filter of ["--test-name-pattern=NO_MATCH", "--test-skip-pattern=.*", "--test-only"]) {
    it(`strips inherited ${filter} and proves every file executed`, async () => {
      assertExecuted(await invoke({ environment: { NODE_OPTIONS: filter } }));
    });
    it(`cannot bypass missing native binaries with ${filter}`, async () => {
      assertRefused(await invoke({ environment: { NODE_OPTIONS: filter }, missingVariable: manifests[0]!.variable }), /MEMORY_SNAPSHOT_POSTGRES_BIN must name/);
    });
  }

  it("cleans credentials, database destinations, alternate runtimes and test filters", async () => {
    const body = `it("synthetic environment", () => {
      assert.equal(process.env.NODE_ENV, "test");
      assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:9");
      assert.equal(process.env.EXPO_PUBLIC_SUPABASE_URL, "http://127.0.0.1:9");
      for (const key of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_ANON_KEY"]) assert.equal(process.env[key], "dummy");
      for (const key of ["NODE_OPTIONS", "NODE_PATH", "DATABASE_URL", "LOCAL_DB_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "HTTP_PROXY", "OPENAI_API_KEY", "DISCOVERY_PGLITE_MODULE", "MEMORY_SNAPSHOT_PGLITE_MODULE", "MEMORY_VIDEO_SEGMENTS_PGLITE_MODULE", "MEMORY_IMPORT_PGLITE_MODULE", "TEST_NAME_PATTERN", "H146_BASELINE"]) assert.equal(process.env[key], undefined);
      const expected = new URL("../../bin", import.meta.url).pathname;
      for (const key of ${JSON.stringify(manifests.map(({ variable }) => variable))}) assert.equal(process.env[key], expected);
    });`;
    assertExecuted(await invoke({ source: healthy(manifests[0]!.name, body), environment: {
      NODE_ENV: "production", SUPABASE_URL: "https://synthetic.invalid", EXPO_PUBLIC_SUPABASE_URL: "https://synthetic.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic", SUPABASE_ANON_KEY: "synthetic", EXPO_PUBLIC_SUPABASE_ANON_KEY: "synthetic",
      NODE_OPTIONS: "--test-only", NODE_PATH: "/synthetic/unused", DATABASE_URL: "postgresql://synthetic.invalid/unused",
      LOCAL_DB_URL: "postgresql://synthetic.invalid/unused", PGHOST: "synthetic.invalid", PGPORT: "5432", PGUSER: "synthetic",
      PGPASSWORD: "synthetic", PGSERVICE: "synthetic", PGSERVICEFILE: "/synthetic/unused", PGOPTIONS: "synthetic",
      HTTP_PROXY: "http://synthetic.invalid", OPENAI_API_KEY: "synthetic", DISCOVERY_PGLITE_MODULE: "/synthetic/unused",
      MEMORY_SNAPSHOT_PGLITE_MODULE: "/synthetic/unused", MEMORY_VIDEO_SEGMENTS_PGLITE_MODULE: "/synthetic/unused",
      MEMORY_IMPORT_PGLITE_MODULE: "/synthetic/unused", TEST_NAME_PATTERN: "NO_MATCH", H146_BASELINE: "1",
    } }));
  });

  for (const [label, argumentsList] of [
    ["missing manifest", []], ["unknown manifest", ["unknown", ...files]],
    ["incomplete all manifest", ["all", ...files.slice(0, 2)]],
    ["former three-suite manifest", ["all", ...files.slice(0, 3)]],
    ["duplicate file", ["all", files[0]!, files[0]!, files[2]!]],
    ["wrong single file", ["snapshot", files[1]!]],
    ["wrong review file", ["review", files[3]!]],
    ["review mixed into Memory manifest", ["all", ...files, manifests[4]!.file]],
    ["review with test filter", ["review", manifests[4]!.file, "--test-only"]],
    ["wrong Media file", ["media-translation", files[0]!]],
    ["Media mixed into Memory manifest", ["all", ...files, manifests[5]!.file]],
    ["Media with test filter", ["media-translation", manifests[5]!.file, "--test-only"]],
    ["path traversal", ["snapshot", `../${files[0]}`]],
    ["extra test filter", ["all", ...files, "--test-only"]],
  ] as const) {
    it(`rejects ${label}`, async () => {
      assertRefused(await invoke({ argumentsList: [...argumentsList] }), /Select a native manifest|Pass each required file exactly once/);
    });
  }

  for (const [fixtureIndex, { profile, file, variable }] of manifests.entries()) {
    const argumentsList = files.includes(file) ? undefined : [profile, file];
    it(`fails closed when ${file} is missing`, async () => {
      assertRefused(await invoke({ fixtureIndex, missingFile: true, argumentsList }), /ENOENT/);
    });
    it(`fails closed when ${variable} is missing`, async () => {
      assertRefused(await invoke({ missingVariable: variable, argumentsList }), new RegExp(`${variable} must name`));
    });
    for (const [label, body, expected] of [
      ["suite skip", `${imports}\ndescribe(${JSON.stringify(manifests[fixtureIndex]!.name)}, { skip: true }, () => { it("not run", () => {}); }); it("unrelated", () => {});`, /Skipped suite/],
      ["suite todo", `${imports}\ndescribe(${JSON.stringify(manifests[fixtureIndex]!.name)}, { todo: true }, () => { it("assertion", () => {}); });`, /Todo suite/],
      ["zero nested execution", `${healthy(manifests[fixtureIndex]!.name, "")}it("unrelated", () => {});`, /Zero executed native tests/],
    ] as const) {
      it(`rejects ${label} in ${file} even when other files pass`, async () => {
        assertRefused(await invoke({ fixtureIndex, source: body, argumentsList }), expected);
      });
    }
  }

  for (const [fixtureIndex, { profile, file, name }] of manifests.entries()) {
    if (!["review", "media-translation", "account-media"].includes(profile)) continue;
    for (const [label, source, expected] of [
      ["skipped test", healthy(name, 'it("skipped", { skip: true }, () => {}); it("control", () => {});'), /Skipped test/],
      ["todo test", healthy(name, 'it("todo", { todo: true }, () => {});'), /Todo test/],
      ["assertion failure", healthy(name, 'it("broken", () => assert.fail("expected"));'), /Failed: broken/],
      ["wrong suite", healthy("unrelated suite"), /Expected exactly one successful native suite/],
      ["early exit", "process.exit(0);", /Zero executed native tests/],
    ] as const) {
      it(`rejects ${label} in the mandatory ${profile} gate`, async () => {
        assertRefused(await invoke({ fixtureIndex, argumentsList: [profile, file], source }), expected);
      });
    }
    it(`strips inherited test filters from the ${profile} gate`, async () => {
      assertExecuted(await invoke({ argumentsList: [profile, file], environment: { NODE_OPTIONS: "--test-only" } }), [file]);
    });
  }

  it("refuses partial Media execution even when the named native suite passes", async () => {
    const manifest = manifests[5]!;
    assertRefused(await invoke({ fixtureIndex: 5, argumentsList: [manifest.profile, manifest.file],
      source: healthy(manifest.name) }), /Expected exactly 28 executed native tests/);
  });

  for (const count of [1, 14, 16]) it(`refuses ${count} account Media assertions instead of exactly fifteen`, async () => {
    const manifest = manifests[6]!;
    const body = Array.from({ length: count }, (_, index) => `it("account native assertion ${index}", () => assert.equal(1, 1));`).join("\n");
    assertRefused(await invoke({ fixtureIndex: 6, argumentsList: [manifest.profile, manifest.file],
      source: healthy(manifest.name, body) }), /Expected exactly 15 executed native tests/);
  });

  for (const directoryShape of ["relative", "missing", "file"] as const) {
    it(`rejects a ${directoryShape} binary directory`, async () => {
      assertRefused(await invoke({ directoryShape }), /must name|ENOENT|not a directory/);
    });
  }
  for (const binaryShape of ["missing", "directory", "non-executable"] as const) {
    it(`rejects a ${binaryShape} required executable`, async () => {
      assertRefused(await invoke({ binaryShape }), /ENOENT|not a regular executable|EACCES/);
    });
  }
  it("rejects an empty binary variable", async () => {
    assertRefused(await invoke({ environment: { MEMORY_SNAPSHOT_POSTGRES_BIN: "" } }), /MEMORY_SNAPSHOT_POSTGRES_BIN must name/);
  });
  it("fails without the installed TypeScript loader", async () => {
    assertRefused(await invoke({ missingLoader: true }), /tsx/);
  });
  it("rejects two required files resolving to the same file", async () => {
    assertRefused(await invoke({ duplicateFile: true }), /must resolve to distinct files/);
  });
  it("rejects a test symlink escaping the checkout", async () => {
    assertRefused(await invoke({ outsideFile: true }), /outside the API checkout/);
  });

  for (const [label, source, expected] of [
    ["skipped test", healthy(manifests[0]!.name, 'it("skipped", { skip: true }, () => {}); it("control", () => {});'), /Skipped test/],
    ["todo test", healthy(manifests[0]!.name, 'it("todo", { todo: true }, () => {});'), /Todo test/],
    ["failing todo", healthy(manifests[0]!.name, 'it("todo failure", { todo: true }, () => assert.fail("expected"));'), /Todo test/],
    ["assertion failure", healthy(manifests[0]!.name, 'it("broken", () => assert.fail("expected"));'), /Failed: broken/],
    ["cancelled test", healthy(manifests[0]!.name, 'it("cancelled", { signal: AbortSignal.abort() }, () => {});'), /Failed: cancelled/],
    ["bounded timeout", healthy(manifests[0]!.name, 'it("timed", { timeout: 25 }, async (context) => { const timer = setInterval(() => {}, 100); context.signal.addEventListener("abort", () => clearInterval(timer), { once: true }); await new Promise(() => {}); });'), /Failed: timed/],
    ["wrong suite", healthy("unrelated suite"), /Expected exactly one successful native suite/],
    ["test impersonating suite", `${imports}\nit(${JSON.stringify(manifests[0]!.name)}, () => {});`, /Expected exactly one successful native suite/],
    ["forged TAP", 'console.log("ok 1 - native SQL # pass 999\\n# skipped 0");', /Zero executed native tests/],
    ["duplicate suite", healthy(manifests[0]!.name) + `describe(${JSON.stringify(manifests[0]!.name)}, () => { it("duplicate", () => {}); });`, /Expected exactly one successful native suite/],
    ["early successful exit", "process.exit(0);", /Zero executed native tests/],
  ] as const) {
    it(`rejects ${label}`, async () => {
      assertRefused(await invoke({ source }), expected);
    });
  }
});
