import { ChildProcess, spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import reportEvents from "./run-memory-sql-tests.mjs";

const outputLimit = 4_000_000;
const outputLimitRecord = `${JSON.stringify({ type: "media:output-limit", data: { limit: outputLimit } })}\n`;
let rawPipeBudget;
const rawStderrFiles = new Set();

function createOutputBudget(onExceeded) {
  let outputBytes = 0;
  let exceeded = false;
  return (text) => {
    if (exceeded) return false;
    outputBytes += Buffer.byteLength(text, "utf8");
    if (outputBytes <= outputLimit) return true;
    exceeded = true;
    onExceeded?.();
    return false;
  };
}

export default async function* reportMediaEvents(events) {
  const budget = rawPipeBudget ?? createOutputBudget();
  const exceeded = new Error(`Test output exceeded ${outputLimit} bytes`);
  const count = (text) => {
    if (!budget(text)) throw exceeded;
  };
  async function* countedEvents() {
    for await (const event of events) {
      if (["test:stdout", "test:diagnostic"].includes(event.type)
        || (event.type === "test:stderr" && !rawStderrFiles.has(event.data.file))) count(event.data.message);
      yield event;
    }
  }
  try {
    for await (const text of reportEvents(countedEvents())) {
      count(text);
      yield text;
    }
  } catch (error) {
    if (error !== exceeded) throw error;
    if (!rawPipeBudget) yield outputLimitRecord;
  }
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const apiRoot = resolve(dirname(scriptPath), "..");
const runTimeoutMs = 180_000;
const manifest = new Map([
  ["src/test/mediaCaptionManifestSql.test.ts", [["offline real Postgres caption manifest CAS, full generation snapshot, deletion and role denial"]]],
  ["src/test/mediaCaptionAsrConsentSql.test.ts", [["real offline queue/consent transaction: explicit grant, idempotency, revoke, regrant isolation and atomic rollback"]]],
  ["src/test/mediaDubbingCaptionSql.test.ts", [["caption edits atomically withdraw completed dubbing and reject stale caption grants"]]],
  ["src/test/mediaVisualGenerationSql.test.ts", [
    ["3981/3982 atomic generation cleanup includes actual 3320 implicit version bumps"],
    ["3981/3982 atomic generation cleanup includes actual 3320 implicit version bumps", "visibility='private'"],
    ["3981/3982 atomic generation cleanup includes actual 3320 implicit version bumps", "public_url='https://synthetic.invalid/replaced.png'"],
    ["3981/3982 atomic generation cleanup includes actual 3320 implicit version bumps", "visibility=visibility"],
  ]],
  ["src/test/mediaDerivativeCleanupSql.test.ts", [["offline PostgreSQL cleanup CAS, role boundary, generation trigger and hard-delete FK cascade"]]],
  ["src/test/mediaCaptionTranslationSql.test.ts", [
    ["a delayed old opt-in cannot create a fresh grant after acknowledged revoke"],
    ["revoke retains durable cleanup debt for an in-flight writer even before its object exists"],
    ["offline translation grant: explicit consent, original generation, idempotency, rollback and fresh identity after revoke"],
    ["translation publication cannot use missing, revoked, wrong-job or unreviewed consent"],
    ["completed reviewed translation commits exact manifest then invalidates grant; manual six-argument CAS remains valid"],
    ["final translation CAS checks the live canonical caption path even if a JS preload was current"],
    ["caption deletion and edit invalidate translation leases without source-version rebasing"],
    ["OFF and config/source changes deny publication; revoke remains available while OFF and deleted"],
    ["translation tables and all RPCs reject anon/authenticated roles"],
    ["additive 3995 preserves OFF flags and requires retained positively-settled draft and publication identities"],
  ]],
]);

if (process.execArgv.includes("--test") && process.execArgv.includes(import.meta.url)) {
  const expectedFiles = new Set([...manifest.keys()].map((file) => regularFile(resolve(apiRoot, file))));
  rawPipeBudget = createOutputBudget(() => process.stdout.write(outputLimitRecord));
  const originalSpawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function spawnWithRawStderrBudget(options) {
    const result = Reflect.apply(originalSpawn, this, [options]);
    const file = options.args?.at(-1);
    if (options.envPairs?.includes("NODE_TEST_CONTEXT=child-v8") && expectedFiles.has(file)) {
      if (!this.stderr) throw new Error("Required test stderr pipe is unavailable");
      this.stderr.on("data", (chunk) => rawPipeBudget(chunk));
      rawStderrFiles.add(file);
      process.stdout.write(`${JSON.stringify({ type: "media:raw-pipe", data: { file } })}\n`);
    }
    return result;
  };
}

function regularFile(path) {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error(`Not a regular file: ${path}`);
  return canonical;
}

function runtimeEnvironment() {
  const runtimePath = regularFile(fileURLToPath(import.meta.resolve("@electric-sql/pglite")));
  const runtimeRoot = resolve(dirname(runtimePath), "..");
  const metadata = JSON.parse(readFileSync(resolve(runtimeRoot, "package.json"), "utf8"));
  if (metadata.name !== "@electric-sql/pglite" || metadata.version !== "0.2.17"
    || runtimePath !== regularFile(resolve(runtimeRoot, "dist/index.js"))) {
    throw new Error("The installed @electric-sql/pglite must be exactly 0.2.17 with its packaged dist entry");
  }
  const vectorPath = regularFile(fileURLToPath(import.meta.resolve("@electric-sql/pglite/vector")));
  if (vectorPath !== regularFile(resolve(runtimeRoot, "dist/vector/index.js"))) {
    throw new Error("PGlite vector must resolve from the same installed package");
  }
  const environment = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return {
    ...environment,
    NODE_ENV: "test", TSX_DISABLE_CACHE: "1", NODE_V8_COVERAGE: undefined,
    SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "dummy", SUPABASE_ANON_KEY: "dummy",
    EXPO_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", EXPO_PUBLIC_SUPABASE_ANON_KEY: "dummy",
    CAPTION_PGLITE_MODULE: runtimePath, MEDIA_CLEANUP_PGLITE_MODULE: runtimePath,
    TRANSLATION_PGLITE_MODULE: runtimePath, PGLITE_ROOT: runtimeRoot,
  };
}

async function main(argumentsList) {
  if (argumentsList.length !== manifest.size || new Set(argumentsList).size !== manifest.size
    || argumentsList.some((file) => !manifest.has(file))) {
    throw new Error(`Pass each required file exactly once: ${[...manifest.keys()].join(" ")}`);
  }
  const coverage = new Map();
  for (const file of argumentsList) {
    const absolute = regularFile(resolve(apiRoot, file));
    const withinRoot = relative(apiRoot, absolute);
    if (isAbsolute(withinRoot) || withinRoot === ".." || withinRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`Required test escapes API root: ${file}`);
    }
    if (coverage.has(absolute)) throw new Error("Required tests must resolve to distinct files");
    coverage.set(absolute, {
      file, activeRoot: null, rawPipeBindings: 0,
      expected: new Map(manifest.get(file).map((path) => [JSON.stringify(path), 0])),
    });
  }
  const environment = runtimeEnvironment();
  const loader = import.meta.resolve("tsx/esm");
  const failures = new Set();
  const summaries = [];
  const receive = ({ type, data }) => {
    if (!data || typeof data !== "object") throw new Error("Malformed test event");
    if (type === "media:output-limit" && data.limit === outputLimit) {
      stop(`Test output exceeded ${outputLimit} bytes`);
      return;
    }
    const entry = coverage.get(data.file);
    if (type === "media:raw-pipe") {
      if (!entry || ++entry.rawPipeBindings !== 1) throw new Error("Unexpected raw-pipe binding");
    } else if (type === "test:start") {
      if (entry && data.nesting === 0) entry.activeRoot = data.name;
    } else if (type === "test:summary") {
      if (!data.file) summaries.push(data);
      if (data.success !== true) failures.add("Unsuccessful test summary");
      for (const name of ["failed", "cancelled", "skipped", "todo"]) {
        if (data.counts?.[name] !== 0) failures.add(`Summary ${name} is not zero`);
      }
    } else if (type === "test:pass" || type === "test:fail") {
      const skipped = data.skip !== undefined && data.skip !== false;
      const todo = data.todo !== undefined && data.todo !== false;
      if (skipped) failures.add(`Skipped: ${data.name}`);
      if (todo) failures.add(`Todo: ${data.name}`);
      if (type === "test:fail") failures.add(`Failed: ${data.name}${data.details?.error ? ` — ${data.details.error}` : ""}`);
      const key = JSON.stringify(data.nesting === 0 ? [data.name] : [entry?.activeRoot, data.name]);
      if (!entry || data.details?.type !== "test" || ![0, 1].includes(data.nesting) || !entry.expected.has(key)) {
        failures.add(`Unexpected test evidence: ${data.file ?? "no file"}: ${data.name}`);
      } else if (type === "test:pass" && !skipped && !todo) {
        entry.expected.set(key, entry.expected.get(key) + 1);
      }
    } else {
      throw new Error("Unexpected test event");
    }
  };
  const child = spawn(process.execPath, [
    "--import", import.meta.url, "--import", loader, "--test", "--test-concurrency=1", "--test-timeout=60000",
    `--test-reporter=${import.meta.url}`, ...coverage.keys(),
  ], { cwd: apiRoot, env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const stop = (reason) => {
    failures.add(reason);
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") failures.add(`Could not stop tests: ${error.message}`);
    }
  };
  let outputBytes = 0;
  const acceptOutput = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) stop(`Test output exceeded ${outputLimit} bytes`);
    return outputBytes <= outputLimit;
  };
  child.stdout.on("data", acceptOutput);
  child.stderr.on("data", (chunk) => { if (acceptOutput(chunk)) process.stderr.write(chunk); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try { receive(JSON.parse(line)); }
    catch { stop("Unreadable test event stream"); }
  });
  const timer = setTimeout(() => stop(`Whole-run timeout exceeded ${runTimeoutMs}ms`), runTimeoutMs);
  const interrupt = () => stop("Interrupted by SIGINT");
  const terminate = () => stop("Interrupted by SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
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
  let expectedTests = 0;
  for (const entry of coverage.values()) {
    if (entry.rawPipeBindings !== 1) failures.add(`Missing raw-pipe binding: ${entry.file}`);
    expectedTests += entry.expected.size;
    for (const [name, count] of entry.expected) {
      if (count !== 1) failures.add(`Expected exactly one successful named test in ${entry.file}: ${name}; received ${count}`);
    }
    console.log(`media-sql: ${entry.file}: expected=${entry.expected.size} executed=${[...entry.expected.values()].reduce((total, count) => total + count, 0)}`);
  }
  if (summaries.length !== 1 || summaries[0].success !== true || summaries[0].counts?.tests !== expectedTests
    || summaries[0].counts?.passed !== expectedTests || summaries[0].counts?.suites !== 0) {
    failures.add("Missing, empty or mismatched final test summary");
  }
  for (const failure of failures) console.error(`media-sql: FAIL: ${failure}`);
  if (failures.size > 0) return 1;
  console.log(`media-sql: PASS: ${expectedTests} named tests; all ${manifest.size} SQL files executed; no skips or todos`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`media-sql: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
