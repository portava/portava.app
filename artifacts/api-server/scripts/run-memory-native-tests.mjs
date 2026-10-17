import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export { default } from "./run-memory-sql-tests.mjs";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const apiRoot = resolve(dirname(scriptPath), "..");
const manifests = {
  snapshot: {
    file: "src/test/MemorySnapshot.postgres.test.ts",
    suite: "MemorySnapshot native two-session locks (fresh socket-only disposable cluster)",
    binaryVariable: "MEMORY_SNAPSHOT_POSTGRES_BIN",
  },
  video: {
    file: "src/test/memoryVideoSegments.postgres.test.ts",
    suite: "3991 native PostgreSQL two-session segment races (fresh socket-only cluster)",
    binaryVariable: "MEMORY_VIDEO_SEGMENTS_POSTGRES_BIN",
  },
  import: {
    file: "src/test/memoryImportBatches.postgres.test.ts",
    suite: "H37 native import/correction locks (fresh socket-only disposable cluster)",
    binaryVariable: "MEMORY_IMPORT_POSTGRES_BIN",
  },
  policy: {
    file: "src/test/resurfacingPolicy.native.test.ts",
    suite: "H146 owner resurfacing policy native contract",
    binaryVariable: "PORTAVA_TEST_POSTGRES_BIN",
  },
  review: {
    file: "src/test/reportedReviewRemoval.native.test.ts",
    suite: "reported-review audited removal: PostgreSQL 17",
    binaryVariable: "PORTAVA_TEST_POSTGRES_BIN",
  },
  "media-translation": {
    file: "src/test/mediaCaptionTranslationHardDelete.native.test.ts",
    suite: "Caption translation retained hard-delete recovery",
    binaryVariable: "PORTAVA_TEST_POSTGRES_BIN",
    expectedTests: 28,
  },
  "account-media": {
    file: "src/test/accountDeletionMediaBoundary.native.test.ts",
    suite: "Account Media deletion native source barrier",
    binaryVariable: "PORTAVA_TEST_POSTGRES_BIN",
    expectedTests: 15,
  },
};
const memoryProfiles = ["snapshot", "video", "import", "policy"];
const eventTypes = new Set(["test:start", "test:pass", "test:fail", "test:summary"]);

function syntheticEnvironment(selected) {
  const environment = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  for (const { binaryVariable } of selected) {
    const supplied = process.env[binaryVariable];
    if (!supplied || !isAbsolute(supplied)) throw new Error(`${binaryVariable} must name an absolute trusted local PostgreSQL bin directory`);
    const directory = realpathSync(supplied);
    if (!statSync(directory).isDirectory()) throw new Error(`${binaryVariable} is not a directory`);
    for (const name of ["initdb", "pg_ctl", "psql", "postgres"]) {
      const binary = join(directory, name);
      if (!statSync(binary).isFile()) throw new Error(`${binaryVariable}/${name} is not a regular executable file`);
      accessSync(binary, constants.X_OK);
    }
    environment[binaryVariable] = directory;
  }
  return {
    ...environment,
    NODE_ENV: "test",
    TSX_DISABLE_CACHE: "1",
    NODE_V8_COVERAGE: undefined,
    SUPABASE_URL: "http://127.0.0.1:9",
    SUPABASE_SERVICE_ROLE_KEY: "dummy",
    SUPABASE_ANON_KEY: "dummy",
    EXPO_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
    EXPO_PUBLIC_SUPABASE_ANON_KEY: "dummy",
  };
}

async function main([profile, ...argumentsList]) {
  if (profile !== "all" && !Object.hasOwn(manifests, profile ?? "")) {
    throw new Error("Select a native manifest: snapshot, video, import, policy, review, media-translation, account-media, or all (four Memory suites); then pass its literal test paths");
  }
  const selected = profile === "all" ? memoryProfiles.map((name) => manifests[name]) : [manifests[profile]];
  const required = new Map(selected.map((manifest) => [manifest.file, manifest]));
  if (argumentsList.length !== required.size || new Set(argumentsList).size !== required.size
    || argumentsList.some((file) => !required.has(file))) {
    throw new Error(`Pass each required file exactly once for ${profile}: ${[...required.keys()].join(" ")}`);
  }
  const files = argumentsList.map((file) => {
    const absolute = realpathSync(resolve(apiRoot, file));
    const withinRoot = relative(apiRoot, absolute);
    if (withinRoot === ".." || withinRoot.startsWith("../") || withinRoot.startsWith("..\\") || isAbsolute(withinRoot)) {
      throw new Error(`Required test resolves outside the API checkout: ${file}`);
    }
    if (!statSync(absolute).isFile()) throw new Error(`Not a test file: ${file}`);
    return absolute;
  });
  if (new Set(files).size !== required.size) throw new Error("Required native files must resolve to distinct files");
  const environment = syntheticEnvironment(selected);
  const loader = import.meta.resolve("tsx/esm");
  const coverage = new Map(files.map((file, index) => [file, {
    file: argumentsList[index], name: required.get(argumentsList[index]).suite,
    expectedTests: required.get(argumentsList[index]).expectedTests,
    root: null, suites: 0, tests: 0,
  }]));
  const failures = new Set();
  let summary;
  let summaryCount = 0;
  const receive = (event) => {
    if (!eventTypes.has(event.type) || !event.data || typeof event.data !== "object") {
      failures.add("Malformed test event");
      return;
    }
    const data = event.data;
    const entry = coverage.get(data.file);
    if (event.type === "test:start") {
      if (entry && data.nesting === 0) entry.root = data.name;
      return;
    }
    if (event.type === "test:summary") {
      if (!data.file) { summary = data; summaryCount += 1; }
      if (data.success !== true) failures.add("Test runner reported an unsuccessful summary");
      for (const name of ["failed", "cancelled", "skipped", "todo"]) {
        if (data.counts?.[name] !== 0) failures.add(`Summary ${name} is not zero`);
      }
      return;
    }
    const skipped = data.skip !== undefined && data.skip !== false;
    const todo = data.todo !== undefined && data.todo !== false;
    if (skipped) failures.add(`Skipped ${data.details?.type ?? "test"}: ${data.name}`);
    if (todo) failures.add(`Todo ${data.details?.type ?? "test"}: ${data.name}`);
    if (event.type === "test:fail") failures.add(`Failed: ${data.name}${data.details?.error ? ` — ${data.details.error}` : ""}`);
    if (event.type !== "test:pass" || skipped || todo || !entry) return;
    if (data.details?.type === "suite" && data.nesting === 0 && data.name === entry.name) entry.suites += 1;
    if (data.details?.type === "test" && data.nesting > 0 && entry.root === entry.name) entry.tests += 1;
  };

  const child = spawn(process.execPath, [
    "--import", loader, "--test", "--test-concurrency=1", "--test-timeout=120000",
    `--test-reporter=${import.meta.url}`, ...files,
  ], { cwd: apiRoot, env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"] });
  const stop = (reason) => {
    failures.add(reason);
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") failures.add(`Could not stop native tests: ${error.message}`);
    }
  };
  const timeout = selected.length * 120_000 + 30_000;
  const timer = setTimeout(() => stop(`Whole-run timeout exceeded ${timeout}ms`), timeout);
  const interrupt = () => stop("Interrupted by SIGINT");
  const terminate = () => stop("Interrupted by SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try { receive(JSON.parse(line)); }
    catch { failures.add("Unreadable test event stream"); }
  });
  const exitCode = await new Promise((finish) => {
    child.once("error", (error) => { failures.add(`Could not execute native tests: ${error.message}`); });
    child.once("close", (code, signal) => {
      if (signal) failures.add(`Test process terminated by ${signal}`);
      finish(code);
    });
  });
  clearTimeout(timer);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  lines.close();
  if (exitCode !== 0) failures.add(`Test process exited ${exitCode}`);
  if (summaryCount !== 1 || summary?.success !== true || !Number.isInteger(summary?.counts?.tests)
    || summary.counts.tests <= 0 || summary.counts.passed !== summary.counts.tests) {
    failures.add("Missing, empty or unsuccessful final test summary");
  }
  for (const entry of coverage.values()) {
    if (entry.suites !== 1) failures.add(`Expected exactly one successful native suite in ${entry.file}: ${entry.name}`);
    if (entry.tests === 0) failures.add(`Zero executed native tests in ${entry.file}`);
    if (entry.expectedTests !== undefined && entry.tests !== entry.expectedTests) {
      failures.add(`Expected exactly ${entry.expectedTests} executed native tests in ${entry.file}; received ${entry.tests}`);
    }
    console.log(`memory-native: ${entry.file}: suites=${entry.suites} executed=${entry.tests}`);
  }
  for (const failure of failures) console.error(`memory-native: FAIL: ${failure}`);
  if (failures.size > 0) return 1;
  console.log(`memory-native: PASS: ${summary.counts.passed} tests; all ${required.size} native suites executed; no skips or todos`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`memory-native: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
