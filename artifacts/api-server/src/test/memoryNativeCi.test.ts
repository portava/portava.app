import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const preparation = join(repository, ".github/scripts/prepare-memory-native-postgres.mjs");
const officialChecksum = "dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979";
const archiveName = "postgresql-17.11.tar.bz2";
const binaries = ["initdb", "pg_ctl", "psql", "postgres"];
const variables = ["MEMORY_SNAPSHOT_POSTGRES_BIN", "MEMORY_VIDEO_SEGMENTS_POSTGRES_BIN", "MEMORY_IMPORT_POSTGRES_BIN", "PORTAVA_TEST_POSTGRES_BIN"];
const syntheticArchive = Buffer.from("independent synthetic PostgreSQL preparation archive\n");

interface FixtureOptions {
  cache?: "absent" | "corrupt" | "empty" | "directory" | "symlink" | "directory-symlink";
  runnerPath?: "unset" | "relative" | "missing" | "file" | "multiline";
  outputPath?: "unset" | "relative" | "outside" | "directory" | "symlink";
  failure?: "download" | "download-missing" | "download-corrupt" | "extract" | "configure" | "configure-timeout" | "build" | "install";
  binary?: string;
  binaryShape?: "missing" | "directory" | "symlink" | "non-executable" | "wrong-version" | "empty-version" | "version-failure";
  argumentsList?: string[];
  tempParentAlias?: boolean;
}

async function invoke(options: FixtureOptions = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "memory-native-ci-test-")));
  try {
    const root = join(directory, "runner temp with spaces");
    const tools = join(directory, "tools");
    const output = join(root, "step-output");
    const cache = join(root, "memory-postgres-source");
    const archive = join(cache, archiveName);
    await mkdir(root);
    await mkdir(tools);
    await writeFile(output, "");
    await writeFile(join(directory, "archive-fixture"), syntheticArchive);
    const original = await readFile(preparation, "utf8");
    assert.equal(original.split(officialChecksum).length, 2, "fixture substitution must change only the literal digest, not verification logic");
    const source = original.replace(officialChecksum, createHash("sha256").update(syntheticArchive).digest("hex"))
      .replace("configure: 90_000", options.failure === "configure-timeout" ? "configure: 1_000" : "configure: 90_000");
    const entry = join(directory, "prepare.mjs");
    await writeFile(entry, source);
    const stub = `#!${process.execPath}
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const directory = ${JSON.stringify(directory)};
const options = ${JSON.stringify(options)};
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const leakNames = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PGHOST', 'DATABASE_URL', 'NODE_OPTIONS', 'CFLAGS', 'H146_BASELINE'];
appendFileSync(join(directory, 'events'), JSON.stringify({ name, args, cwd: process.cwd(), home: process.env.HOME,
  leaked: leakNames.filter(key => process.env[key] !== undefined) }) + '\\n');
if (name === 'curl') {
  if (options.failure === 'download') process.exit(9);
  if (options.failure !== 'download-missing') {
    const destination = args[args.indexOf('--output') + 1];
    if (options.failure === 'download-corrupt') writeFileSync(destination, 'corrupt download');
    else copyFileSync(join(directory, 'archive-fixture'), destination);
  }
} else if (name === 'tar') {
  if (options.failure === 'extract') process.exit(9);
  const source = join(args[args.indexOf('--directory') + 1], 'postgresql-17.11');
  mkdirSync(source);
  copyFileSync(join(directory, 'stub.mjs'), join(source, 'configure'));
  chmodSync(join(source, 'configure'), 0o700);
} else if (name === 'configure') {
  if (options.failure === 'configure') process.exit(9);
  if (options.failure === 'configure-timeout') await new Promise(resolve => setTimeout(resolve, 5000));
  writeFileSync('.prefix', args.find(value => value.startsWith('--prefix=')).slice('--prefix='.length));
} else if (name === 'make') {
  const install = args.includes('install');
  if (options.failure === (install ? 'install' : 'build')) process.exit(9);
  if (install) {
    const target = join(readFileSync('.prefix', 'utf8'), 'bin');
    mkdirSync(target, { recursive: true });
    for (const binary of ${JSON.stringify(binaries)}) {
      const path = join(target, binary);
      const shape = binary === options.binary ? options.binaryShape : undefined;
      if (shape === 'missing') continue;
      if (shape === 'directory') { mkdirSync(path); continue; }
      if (shape === 'symlink') { symlinkSync(join(directory, 'stub.mjs'), path); continue; }
      copyFileSync(join(directory, 'stub.mjs'), path);
      chmodSync(path, shape === 'non-executable' ? 0o600 : 0o700);
    }
  }
} else {
  if (options.binary === name && options.binaryShape === 'version-failure') process.exit(9);
  if (!(options.binary === name && options.binaryShape === 'empty-version')) {
    console.log(name + ' (PostgreSQL) ' + (options.binary === name && options.binaryShape === 'wrong-version' ? '17.12' : '17.11'));
  }
}
`;
    await writeFile(join(directory, "stub.mjs"), stub, { mode: 0o700 });
    for (const program of ["curl", "tar", "make"]) await symlink(join(directory, "stub.mjs"), join(tools, program));
    if (options.cache === "directory-symlink") {
      await mkdir(join(directory, "outside-cache"));
      await symlink(join(directory, "outside-cache"), cache, "dir");
    } else await mkdir(cache);
    if (options.cache === "directory") await mkdir(archive);
    else if (options.cache === "symlink") await symlink(join(directory, "archive-fixture"), archive);
    else if (options.cache !== "absent") await writeFile(archive, options.cache === "corrupt" ? "corrupt cache"
      : options.cache === "empty" ? "" : syntheticArchive);
    let suppliedRoot = root;
    if (options.tempParentAlias) {
      const alias = join(directory, "temp parent alias");
      await symlink(directory, alias, "dir");
      suppliedRoot = join(alias, "runner temp with spaces");
      assert.equal(await realpath(suppliedRoot), root);
    }
    const environment: NodeJS.ProcessEnv = {
      PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: suppliedRoot, GITHUB_OUTPUT: join(suppliedRoot, "step-output"),
      SUPABASE_URL: "https://must-not-reach.invalid", SUPABASE_SERVICE_ROLE_KEY: "must-not-leak", DATABASE_URL: "must-not-leak",
      PGHOST: "must-not-leak", CFLAGS: "must-not-leak", H146_BASELINE: "1", NODE_OPTIONS: "--no-warnings",
    };
    if (options.runnerPath === "unset") delete environment.RUNNER_TEMP;
    if (options.runnerPath === "relative") environment.RUNNER_TEMP = "relative";
    if (options.runnerPath === "missing") environment.RUNNER_TEMP = join(directory, "missing");
    if (options.runnerPath === "file") environment.RUNNER_TEMP = output;
    if (options.runnerPath === "multiline") environment.RUNNER_TEMP = `${root}\nunsafe`;
    if (options.outputPath === "unset") delete environment.GITHUB_OUTPUT;
    if (options.outputPath === "relative") environment.GITHUB_OUTPUT = "relative";
    if (options.outputPath === "outside") environment.GITHUB_OUTPUT = join(directory, "outside-output");
    if (options.outputPath === "directory" || options.outputPath === "symlink") {
      await rm(output);
      if (options.outputPath === "directory") await mkdir(output);
      else await symlink(join(directory, "archive-fixture"), output);
    }
    const result = spawnSync(process.execPath, [entry, ...(options.argumentsList ?? [])], {
      cwd: directory, env: environment, encoding: "utf8", timeout: 12_000, maxBuffer: 1_000_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, "preparation must finish within the fixture emergency bound");
    const events = await readFile(join(directory, "events"), "utf8").then(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), () => []);
    const published = await readFile(output, "utf8").catch(() => "");
    return { status: result.status, output: result.stdout + result.stderr, events, published, root, suppliedRoot };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertRefused(result: Awaited<ReturnType<typeof invoke>>, expected: RegExp) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, expected);
  assert.doesNotMatch(result.output, /memory-native-prepare: ready/);
  assert.doesNotMatch(result.published, /^bin=/m);
}

describe("Memory native CI preparation executable controls", () => {
  for (const cache of [undefined, "absent"] as const) it(`verifies ${cache ?? "cached"} archive and publishes only after four exact binary checks`, async () => {
    const result = await invoke({ cache });
    assert.equal(result.status, 0, result.output);
    assert.match(result.published, /^bin=.*runner temp with spaces\/memory-postgres-build-[^/]+\/runtime\/bin\n$/);
    assert.deepEqual(result.events.filter(event => binaries.includes(event.name)).map(event => event.name), binaries);
    assert.equal(result.events.filter(event => event.name === "curl").length, cache === "absent" ? 1 : 0);
    assert.ok(result.events.every(event => event.leaked.length === 0));
    assert.ok(result.events.every(event => event.home.startsWith(result.root + "/memory-postgres-build-")));
    const configure = result.events.find(event => event.name === "configure");
    assert.deepEqual(configure.args.slice(1), ["--without-readline", "--without-icu", "--without-zlib"]);
    const build = result.events.find(event => event.name === "make");
    assert.match(build.args[0], /^-j[1-4]$/);
    if (cache === "absent") {
      const download = result.events.find(event => event.name === "curl");
      assert.equal(download.args.at(-1), `https://ftp.postgresql.org/pub/source/v17.11/${archiveName}`);
      for (const flag of ["--fail", "--proto", "--proto-redir", "--connect-timeout", "--max-time", "--retry-max-time"]) assert.ok(download.args.includes(flag));
    }
  });

  it("canonicalizes a symlinked temporary parent without weakening build confinement", async () => {
    const result = await invoke({ tempParentAlias: true });
    assert.equal(result.status, 0, result.output);
    assert.notEqual(result.suppliedRoot, result.root);
    assert.deepEqual(result.events.filter(event => binaries.includes(event.name)).map(event => event.name), binaries);
    assert.ok(result.events.every(event => event.home.startsWith(result.root + "/memory-postgres-build-")));
    assert.ok(result.events.every(event => event.cwd.startsWith(result.root + "/memory-postgres-build-")));
    assert.ok(result.published.startsWith(`bin=${result.root}/memory-postgres-build-`));
    assert.ok(!result.published.includes(result.suppliedRoot));
  });

  for (const cache of ["corrupt", "empty", "directory", "symlink", "directory-symlink"] as const) it(`refuses ${cache} cache without downloading or extracting`, async () => {
    const result = await invoke({ cache });
    assertRefused(result, /SHA256 mismatch|regular file|never a symlink/);
    assert.deepEqual(result.events, []);
  });

  for (const runnerPath of ["unset", "relative", "missing", "file", "multiline"] as const) it(`refuses ${runnerPath} RUNNER_TEMP before execution`, async () => {
    const result = await invoke({ runnerPath });
    assertRefused(result, /RUNNER_TEMP|ENOENT/);
    assert.deepEqual(result.events, []);
  });

  for (const outputPath of ["unset", "relative", "outside", "directory", "symlink"] as const) it(`refuses ${outputPath} GITHUB_OUTPUT before execution`, async () => {
    const result = await invoke({ outputPath });
    assertRefused(result, /GITHUB_OUTPUT|inside RUNNER_TEMP/);
    assert.deepEqual(result.events, []);
  });

  for (const failure of ["download", "download-missing", "download-corrupt", "extract", "configure", "configure-timeout", "build", "install"] as const) it(`fails closed on ${failure}`, async () => {
    const result = await invoke({ failure, cache: "absent" });
    assertRefused(result, /failed|ENOENT|SHA256 mismatch/);
    assert.ok(!result.events.some(event => event.name === "postgres"));
    const expectedStage = failure.startsWith("download") ? "curl" : failure === "extract" ? "tar"
      : failure.startsWith("configure") ? "configure" : "make";
    assert.equal(result.events.at(-1)?.name, expectedStage, "the intended failing stage must actually execute");
    if (failure === "install") assert.deepEqual(result.events.at(-1)?.args, ["install"]);
    if (failure === "configure-timeout") assert.match(result.output, /timeout=true/);
  });

  for (const binary of binaries) for (const binaryShape of ["missing", "wrong-version", "non-executable"] as const) it(`refuses ${binaryShape} ${binary}`, async () => {
    const result = await invoke({ binary, binaryShape });
    assertRefused(result, /ENOENT|exact PostgreSQL 17\.11|EACCES/);
    assert.ok(result.events.some(event => event.name === "make" && event.args[0] === "install"));
    assert.match(result.output, new RegExp(binary));
    if (binaryShape === "wrong-version") assert.equal(result.events.at(-1)?.name, binary);
  });

  for (const binaryShape of ["directory", "symlink", "empty-version", "version-failure"] as const) it(`refuses ${binaryShape} executable output`, async () => {
    const result = await invoke({ binary: "postgres", binaryShape });
    assertRefused(result, /regular executable file|exact PostgreSQL 17\.11|failed/);
    assert.ok(result.events.some(event => event.name === "make" && event.args[0] === "install"));
    if (binaryShape.endsWith("version") || binaryShape === "version-failure") assert.equal(result.events.at(-1)?.name, "postgres");
  });

  it("rejects alternate runtime/source CLI arguments", async () => {
    const result = await invoke({ argumentsList: ["--skip-verify"] });
    assertRefused(result, /accepts no arguments/);
    assert.deepEqual(result.events, []);
  });
});

describe("Memory native CI persistent gate contract", () => {
  it("pins verified source and bounds preparation without privilege or package installation", async () => {
    const source = await readFile(preparation, "utf8");
    assert.ok(source.includes(`const checksum = "${officialChecksum}"`));
    assert.ok(source.includes('const version = "17.11"'));
    assert.ok(source.includes("Date.now() + 540_000"));
    assert.ok(source.includes('process.getuid?.() === 0'));
    assert.doesNotMatch(source, /\bsudo\b|\bapt-get\b|process\.env\.(?:PGHOST|DATABASE_URL|SUPABASE_URL)/);
  });

  it("runs an unconditional four-suite gate within the existing job without changing totals or verdict dependencies", async () => {
    const workflow = await readFile(join(repository, ".github/workflows/ci.yml"), "utf8");
    const job = workflow.slice(workflow.indexOf("\n  api-server-tests:"), workflow.indexOf("\n  api-server-local-db:"));
    assert.match(job, /runs-on: ubuntu-24\.04/);
    assert.match(job, /\n    timeout-minutes: 60\n/);
    assert.doesNotMatch(job, /\n    services:|secrets\./);
    assert.match(workflow, /NODE_VERSION: '24'/);
    const steps = job.split(/\n      - /);
    const cache = steps.find(step => step.startsWith("name: Cache pinned PostgreSQL source archive"))!;
    const prepare = steps.find(step => step.startsWith("name: Build verified PostgreSQL for native Memory tests"))!;
    const gate = steps.find(step => step.startsWith("name: Require all four native Memory suites"))!;
    assert.ok(cache && prepare && gate);
    assert.ok(cache.includes(`key: memory-postgres-source-17.11-${officialChecksum}`));
    assert.ok(cache.includes(`path: \${{ runner.temp }}/memory-postgres-source/${archiveName}`));
    assert.doesNotMatch(cache, /restore-keys:/);
    for (const step of [prepare, gate]) {
      assert.doesNotMatch(step, /\n        if:|continue-on-error:|\|\|\s*true/);
      assert.match(step, /timeout-minutes: 10/);
      assert.ok(step.includes("set -euo pipefail"));
      assert.doesNotMatch(step, /api-test\.log/);
    }
    assert.ok(prepare.includes("node .github/scripts/prepare-memory-native-postgres.mjs"));
    for (const variable of variables) assert.ok(gate.includes(`${variable}: \${{ steps.memory-postgres.outputs.bin }}`));
    assert.ok(gate.includes("bash .github/scripts/pnpm-run.sh artifacts/api-server @workspace/api-server test:memory-native"));
    assert.ok(gate.includes('tee "$RUNNER_TEMP/memory-native.log"'));
    const beforeGate = job.slice(0, job.indexOf("      - name: Require all four native Memory suites"));
    for (const variable of variables) assert.ok(!beforeGate.includes(`${variable}:`));
    for (const floor of ["API_TEST_MIN_PASS", "API_TEST_MAX_SKIPPED", '"$PASS" -lt "$REGISTERED"']) assert.ok(job.includes(floor));
    const verdict = workflow.slice(workflow.indexOf("\n  ci-verdict:"));
    assert.ok(verdict.includes("      - api-server-tests\n"));
    assert.ok(verdict.includes("R_API_TESTS: ${{ needs['api-server-tests'].result }}"));
    assert.ok(verdict.includes('"api-server-tests:$R_API_TESTS"'));
    const manifest = JSON.parse(await readFile(join(repository, "artifacts/api-server/package.json"), "utf8")).scripts["test:memory-native"];
    assert.equal(manifest, "node scripts/run-memory-native-tests.mjs all src/test/MemorySnapshot.postgres.test.ts src/test/memoryVideoSegments.postgres.test.ts src/test/memoryImportBatches.postgres.test.ts src/test/resurfacingPolicy.native.test.ts");
  });

  it("keeps importer temporary paths portable", async () => {
    const source = await readFile(join(repository, "artifacts/api-server/src/test/memoryImportBatches.postgres.test.ts"), "utf8");
    assert.doesNotMatch(source, /\/private\/tmp/);
    assert.ok(source.includes('mkdtemp(join(tmpdir(), "MemoryImport-pg-"))'));
    assert.ok(source.includes("HOME: tmpdir()"));
  });

  it("requires the reported-review SQL suite using the same verified runtime without weakening the Memory gate", async () => {
    const workflow = await readFile(join(repository, ".github/workflows/ci.yml"), "utf8");
    const job = workflow.slice(workflow.indexOf("\n  api-server-tests:"), workflow.indexOf("\n  api-server-local-db:"));
    const steps = job.split(/\n      - /);
    const gate = steps.find(step => step.startsWith("name: Require native reported-review removal suite"));
    assert.ok(gate);
    assert.doesNotMatch(gate, /\n        if:|continue-on-error:|\|\|\s*true|secrets\.|api-test\.log/);
    assert.match(gate, /timeout-minutes: 5/);
    assert.ok(gate.includes("set -euo pipefail"));
    assert.ok(gate.includes("PORTAVA_TEST_POSTGRES_BIN: ${{ steps.memory-postgres.outputs.bin }}"));
    assert.ok(gate.includes("bash .github/scripts/pnpm-run.sh artifacts/api-server @workspace/api-server test:reported-review-native"));
    assert.ok(gate.includes('tee "$RUNNER_TEMP/reported-review-native.log"'));
    assert.ok(steps.findIndex(step => step.startsWith("name: Build verified PostgreSQL for native Memory tests")) < steps.indexOf(gate));
    assert.equal(steps.filter(step => step.startsWith("name: Require all four native Memory suites")).length, 1);
    const { scripts } = JSON.parse(await readFile(join(repository, "artifacts/api-server/package.json"), "utf8"));
    assert.equal(scripts["test:reported-review-native"], "node scripts/run-memory-native-tests.mjs review src/test/reportedReviewRemoval.native.test.ts");
  });

  it("keeps the reported-review native cluster portable and socket-only", async () => {
    const source = await readFile(join(repository, "artifacts/api-server/src/test/reportedReviewRemoval.native.test.ts"), "utf8");
    assert.doesNotMatch(source, /\/private\/tmp/);
    assert.ok(source.includes('mkdtempSync(join(tmpdir(), "reported-review-native-"))'));
    assert.ok(source.includes("SHOW listen_addresses"));
    assert.ok(source.includes("SELECT inet_server_addr() IS NULL"));
    assert.ok(source.includes("--auth-host=reject"));
  });

  it("requires retained Media translation deletion proof on the same verified native runtime", async () => {
    const workflow = await readFile(join(repository, ".github/workflows/ci.yml"), "utf8");
    const job = workflow.slice(workflow.indexOf("\n  api-server-tests:"), workflow.indexOf("\n  api-server-local-db:"));
    const steps = job.split(/\n      - /);
    const gates = steps.filter(step => step.startsWith("name: Require native media translation deletion suite"));
    assert.equal(gates.length, 1);
    const gate = gates[0]!;
    assert.doesNotMatch(gate, /\n        if:|continue-on-error:|\|\|\s*true|secrets\.|api-test\.log/);
    assert.match(gate, /timeout-minutes: 5/);
    assert.ok(gate.includes("set -euo pipefail"));
    assert.ok(gate.includes("PORTAVA_TEST_POSTGRES_BIN: ${{ steps.memory-postgres.outputs.bin }}"));
    assert.ok(gate.includes("bash .github/scripts/pnpm-run.sh artifacts/api-server @workspace/api-server test:media-translation-native"));
    assert.ok(gate.includes('tee "$RUNNER_TEMP/media-translation-native.log"'));
    assert.ok(steps.findIndex(step => step.startsWith("name: Build verified PostgreSQL for native Memory tests")) < steps.indexOf(gate));
    assert.equal(steps.filter(step => step.startsWith("name: Require all four native Memory suites")).length, 1);
    const { scripts } = JSON.parse(await readFile(join(repository, "artifacts/api-server/package.json"), "utf8"));
    assert.equal(scripts["test:media-translation-native"], "node scripts/run-memory-native-tests.mjs media-translation src/test/mediaCaptionTranslationHardDelete.native.test.ts");
    assert.ok(!scripts.pretest.includes("mediaCaptionTranslationHardDelete.native.test.ts"));
    assert.ok(!scripts.test.includes("mediaCaptionTranslationHardDelete.native.test.ts"));
  });

  it("registers ordinary tests before strict Media and Memory SQL commands, never as their extra arguments", async () => {
    const { scripts } = JSON.parse(await readFile(join(repository, "artifacts/api-server/package.json"), "utf8"));
    const commands = scripts.pretest.split(" && ");
    assert.equal(commands.length, 3);
    const mediaFiles = ["mediaCaptionManifestSql", "mediaCaptionAsrConsentSql", "mediaDubbingCaptionSql", "mediaVisualGenerationSql", "mediaDerivativeCleanupSql", "mediaCaptionTranslationSql"].map(name => `src/test/${name}.test.ts`);
    assert.equal(commands[1], "node scripts/run-media-sql-tests.mjs " + mediaFiles.join(" "));
    assert.equal(commands[2], "node scripts/run-memory-sql-tests.mjs src/test/MemorySnapshot.pglite.test.ts src/test/memoryVideoSegments.pglite.test.ts src/test/memoryImportBatches.pglite.test.ts src/test/MemorySnapshotLockFixture.test.ts");
    assert.match(commands[0], /^SUPABASE_URL=http:\/\/127\.0\.0\.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx\/esm --test /);
    const argumentsList = commands[0].split(/\s+/);
    for (const file of mediaFiles) assert.ok(!argumentsList.includes(file), file);
    for (const file of ["compassTripDisruptionPlanConsumer.test.ts", "memoryTimeCorrection.test.ts", "reportedReviewRemoval.native.test.ts", "reportedReviewRemoval.test.ts", "tripCompassDisruptionPlanProjection.test.ts"]) {
      assert.equal(argumentsList.filter((argument: string) => argument === `src/test/${file}`).length, 1, file);
    }
  });
});
