import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const apiRoot = resolve(dirname(scriptPath), "..");
const requiredSuites = new Map([
  ["src/test/MemorySnapshot.pglite.test.ts", "MemorySnapshot persisted HTTP/provider/SQL path (isolated single-connection PGlite)"],
  ["src/test/memoryVideoSegments.pglite.test.ts", "3991 executable isolated SQL contract"],
  ["src/test/memoryImportBatches.pglite.test.ts", "H37 durable owner-selected existing-memory backfill (isolated PostgreSQL)"],
  ["src/test/MemorySnapshotLockFixture.test.ts", "MemorySnapshot native fixture compatibility (PGlite, NOT concurrency proof)"],
]);
const eventTypes = new Set(["test:start", "test:pass", "test:fail", "test:summary"]);

export default async function* reportEvents(events) {
  for await (const event of events) {
    if (!eventTypes.has(event.type)) continue;
    const data = { ...event.data };
    if (data.details) {
      data.details = { ...data.details, error: data.details.error?.message };
    }
    yield `${JSON.stringify({ type: event.type, data })}\n`;
  }
}

function syntheticEnvironment(runtimePath) {
  const environment = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return {
    ...environment,
    NODE_ENV: "test",
    TSX_DISABLE_CACHE: "1",
    SUPABASE_URL: "http://127.0.0.1:9",
    SUPABASE_SERVICE_ROLE_KEY: "dummy",
    SUPABASE_ANON_KEY: "dummy",
    EXPO_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
    EXPO_PUBLIC_SUPABASE_ANON_KEY: "dummy",
    MEMORY_SNAPSHOT_PGLITE_MODULE: runtimePath,
    MEMORY_VIDEO_SEGMENTS_PGLITE_MODULE: runtimePath,
    MEMORY_IMPORT_PGLITE_MODULE: runtimePath,
  };
}

async function main(argumentsList) {
  if (argumentsList.length !== requiredSuites.size || new Set(argumentsList).size !== requiredSuites.size
    || argumentsList.some((file) => !requiredSuites.has(file))) {
    throw new Error(`Pass each required file exactly once: ${[...requiredSuites.keys()].join(" ")}`);
  }
  const files = argumentsList.map((file) => {
    const absolute = realpathSync(resolve(apiRoot, file));
    if (!statSync(absolute).isFile()) throw new Error(`Not a test file: ${file}`);
    return absolute;
  });
  if (new Set(files).size !== requiredSuites.size) throw new Error(`Required files must resolve to ${requiredSuites.size} distinct files`);
  const runtimePath = realpathSync(fileURLToPath(import.meta.resolve("@electric-sql/pglite")));
  const loader = import.meta.resolve("tsx/esm");
  const coverage = new Map(files.map((file, index) => [file, {
    file: argumentsList[index], name: requiredSuites.get(argumentsList[index]),
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
    "--import", loader, "--test", "--test-concurrency=1", "--test-timeout=20000",
    `--test-reporter=${import.meta.url}`, ...files,
  ], {
    cwd: apiRoot, env: syntheticEnvironment(runtimePath),
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"],
  });
  const stop = (reason) => {
    failures.add(reason);
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") failures.add(`Could not stop test process: ${error.message}`);
    }
  };
  const timer = setTimeout(() => stop("Whole-run timeout exceeded 60000ms"), 60_000);
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
    child.once("error", (error) => { failures.add(`Could not execute tests: ${error.message}`); });
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
    if (entry.suites !== 1) failures.add(`Expected exactly one successful SQL suite in ${entry.file}: ${entry.name}`);
    if (entry.tests === 0) failures.add(`Zero executed SQL tests in ${entry.file}`);
    console.log(`memory-sql: ${entry.file}: suites=${entry.suites} executed=${entry.tests}`);
  }
  for (const failure of failures) console.error(`memory-sql: FAIL: ${failure}`);
  if (failures.size > 0) return 1;
  console.log(`memory-sql: PASS: ${summary.counts.passed} tests; all ${requiredSuites.size} SQL suites executed; no skips or todos`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`memory-sql: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
