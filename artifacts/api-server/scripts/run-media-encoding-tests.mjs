import childProcess from "node:child_process";
import { accessSync, constants, realpathSync, statSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import reportEvents from "./run-memory-sql-tests.mjs";

export default async function* encodingReporter(events) {
  async function* boundedEvents() {
    let outputBytes = 0;
    for await (const event of events) {
      if (typeof event.data?.message === "string") outputBytes += Buffer.byteLength(event.data.message);
      if (outputBytes > 4_000_000) throw new Error("Reported test output exceeded 4000000 bytes before filtering");
      yield event;
    }
  }
  for await (const line of reportEvents(boundedEvents())) writeSync(4, line);
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const apiRoot = resolve(dirname(scriptPath), "..");
const requiredFile = "src/test/mediaAdaptiveEncoding.real.test.ts";
const requiredNames = [
  "real CPU FFmpeg: synthetic source becomes two measured decodable renditions and a bounded preview",
  "real silent 360p source remains silent, creates 180p/360p, and unsupported bytes preserve the original",
];
const runTimeoutMs = 390_000;
const probeTimeoutMs = 5_000;

function cleanEnvironment() {
  const environment = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return {
    ...environment, LANG: "C", LC_ALL: "C", NODE_ENV: "test", TSX_DISABLE_CACHE: "1", NODE_V8_COVERAGE: undefined,
    SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "dummy", SUPABASE_ANON_KEY: "dummy",
    EXPO_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", EXPO_PUBLIC_SUPABASE_ANON_KEY: "dummy",
  };
}

function executable(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an explicit absolute executable path`);
  const path = realpathSync(value);
  if (!statSync(path).isFile()) throw new Error(`${name} must resolve to a regular file`);
  accessSync(path, constants.X_OK);
  return path;
}

function execute(binary, argumentsList, environment, deadline, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs ?? probeTimeoutMs, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error("Whole-run deadline exhausted");
  return new Promise((finish, reject) => {
    const child = childProcess.spawn(binary, argumentsList, {
      cwd: apiRoot, env: environment, detached: true,
      stdio: ["ignore", "pipe", "pipe", ...(options.trackChildren ? ["pipe", "pipe"] : [])],
    });
    const descendants = new Map();
    let failure;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const kill = (pid, detached) => {
      try { process.kill(detached ? -pid : pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") failure ??= `Could not stop child ${pid}: ${error.message}`; }
    };
    const stop = (reason) => {
      failure ??= reason;
      for (const [pid, detached] of descendants) kill(pid, detached);
      if (child.pid) kill(child.pid, true);
    };
    const acceptOutput = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 4_000_000) stop("Process output exceeded 4000000 bytes");
      return outputBytes <= 4_000_000;
    };
    child.stdout.on("data", (chunk) => {
      if (acceptOutput(chunk) && !options.onEvent) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => { if (acceptOutput(chunk)) stderr += chunk; });
    const events = options.onEvent ? createInterface({ input: child.stdio[4] }) : null;
    child.stdio[4]?.on("data", acceptOutput);
    events?.on("line", (line) => {
      try { options.onEvent(JSON.parse(line)); }
      catch (error) { stop(`Invalid test evidence: ${error.message}`); }
    });
    const tracking = options.trackChildren ? createInterface({ input: child.stdio[3] }) : null;
    child.stdio[3]?.on("data", acceptOutput);
    tracking?.on("line", (line) => {
      try {
        const entry = JSON.parse(line);
        if (!Number.isSafeInteger(entry.pid) || entry.pid <= 1 || typeof entry.detached !== "boolean"
          || !["spawn", "close"].includes(entry.type)) throw new Error("Malformed child record");
        if (entry.type === "spawn") {
          if (descendants.has(entry.pid)) throw new Error("Duplicate child record");
          descendants.set(entry.pid, entry.detached);
          if (failure) kill(entry.pid, entry.detached);
        } else {
          if (!descendants.delete(entry.pid)) throw new Error("Unknown child close record");
        }
      } catch (error) { stop(`Invalid child tracking: ${error.message}`); }
    });
    const timer = setTimeout(() => stop(`${options.label ?? "Tool probe"} timeout exceeded ${timeoutMs}ms`), timeoutMs);
    const interrupt = () => stop("Interrupted by SIGINT");
    const terminate = () => stop("Interrupted by SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", (error) => stop(`Could not execute process: ${error.message}`));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      events?.close();
      tracking?.close();
      if (descendants.size) stop("Encoding process exited with live tool children");
      if (failure || code !== 0 || signal) {
        reject(new Error(`${failure ?? `Process exited ${code}${signal ? ` (${signal})` : ""}`}${stderr ? `\n${stderr}` : ""}`));
      } else finish(stdout);
    });
  });
}

function capabilityNames(output, category) {
  const names = new Set();
  let direction;
  for (const line of output.split(/\r?\n/)) {
    if (category === "protocols") {
      if (line === "Input:" || line === "Output:") direction = line.slice(0, -1);
      const protocol = /^\s+([a-z0-9_]+)\s*$/.exec(line);
      if (direction && protocol) names.add(`${direction}:${protocol[1]}`);
      continue;
    }
    const row = category === "encoders" || category === "decoders"
      ? /^\s+[VAS][A-Z.]{5}\s+([a-z0-9_]+)\s+/.exec(line)
      : category === "filters"
        ? /^\s+[TSC.]{2,3}\s+([a-z0-9_]+)\s+/.exec(line)
        : (category === "demuxers" ? /^ D [d ]\s+([a-z0-9_,]+)\s+/ : /^  E[d ]?\s+([a-z0-9_,]+)\s+/).exec(line);
    if (row) for (const name of row[1].split(",")) names.add(name);
  }
  return names;
}

async function validateTools(tools, environment, deadline) {
  const profiles = [
    ["ffmpeg", tools.FFMPEG_PATH, {
      encoders: ["libx264", "aac", "mjpeg", "wrapped_avframe"],
      decoders: ["h264", "aac", "mjpeg", "wrapped_avframe", "pcm_s16le"],
      demuxers: ["mov", "hls", "mpegts", "image2", "mjpeg", "lavfi"],
      muxers: ["mp4", "mpegts", "hls", "null", "image2"],
      filters: ["scale", "setsar", "testsrc2", "sine", "format", "aresample", "aformat"],
      protocols: ["Input:file", "Input:pipe", "Output:file", "Output:pipe"],
    }],
    ["ffprobe", tools.FFPROBE_PATH, {
      decoders: ["h264", "aac", "mjpeg"],
      demuxers: ["mov", "hls", "mpegts", "image2", "mjpeg"],
      protocols: ["Input:file", "Input:pipe"],
    }],
  ];
  for (const [name, binary, categories] of profiles) {
    const version = await execute(binary, ["-version"], environment, deadline);
    if (!new RegExp(`^${name} version 8\\.0(?:\\s|$)`).test(version.split(/\r?\n/)[0])) {
      throw new Error(`${name} must report exactly version 8.0`);
    }
    for (const [category, required] of Object.entries(categories)) {
      const output = await execute(binary, ["-hide_banner", `-${category}`], environment, deadline);
      const available = capabilityNames(output, category);
      const missing = required.filter((capability) => !available.has(capability));
      if (missing.length) throw new Error(`${name} missing required ${category}: ${missing.join(", ")}`);
    }
    console.log(`media-encoding: ${name}: version=8.0 required capabilities verified`);
  }
}

async function main(argumentsList) {
  if (argumentsList.length !== 1 || argumentsList[0] !== requiredFile) throw new Error(`Pass exactly: ${requiredFile}`);
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Encoding gate requires POSIX process-group supervision");
  const file = realpathSync(resolve(apiRoot, requiredFile));
  const withinRoot = relative(apiRoot, file);
  if (isAbsolute(withinRoot) || withinRoot === ".." || withinRoot.startsWith("../") || !statSync(file).isFile()) {
    throw new Error("Required encoding test must be a regular file inside the API root");
  }
  const tools = { FFMPEG_PATH: executable("FFMPEG_PATH"), FFPROBE_PATH: executable("FFPROBE_PATH") };
  if (tools.FFMPEG_PATH === tools.FFPROBE_PATH) throw new Error("FFmpeg and ffprobe must resolve to distinct executables");
  const environment = cleanEnvironment();
  const loader = import.meta.resolve("tsx/esm");
  const deadline = Date.now() + runTimeoutMs;
  await validateTools(tools, environment, deadline);
  const evidence = new Map(requiredNames.map((name) => [name, 0]));
  const summaries = [];
  const onEvent = ({ type, data }) => {
    if (!data || typeof data !== "object") throw new Error("Malformed test event");
    if (type === "test:start") return;
    if (type === "test:summary") {
      if (!data.file) summaries.push(data);
      if (data.success !== true || ["failed", "cancelled", "skipped", "todo"].some((name) => data.counts?.[name] !== 0)) {
        throw new Error("Unsuccessful or nonzero skipped/todo/cancelled/failed summary");
      }
      return;
    }
    if (type !== "test:pass" && type !== "test:fail") throw new Error("Unexpected test event");
    if (data.skip !== undefined && data.skip !== false) throw new Error(`Skipped: ${data.name}`);
    if (data.todo !== undefined && data.todo !== false) throw new Error(`Todo: ${data.name}`);
    if (type === "test:fail") throw new Error(`Failed: ${data.name}${data.details?.error ? ` — ${data.details.error}` : ""}`);
    if (data.file !== file || data.nesting !== 0 || data.details?.type !== "test" || !evidence.has(data.name)) {
      throw new Error(`Unexpected named-test evidence: ${data.name}`);
    }
    evidence.set(data.name, evidence.get(data.name) + 1);
  };
  const trackingImport = new URL(import.meta.url);
  trackingImport.searchParams.set("track", "1");
  await execute(process.execPath, [
    "--import", trackingImport.href, "--import", loader, "--test", "--test-isolation=none", "--test-concurrency=1",
    "--test-timeout=180000", `--test-reporter=${import.meta.url}`, file,
  ], { ...environment, ...tools, MEDIA_REQUIRE_ENCODING_TESTS: "true" }, deadline, {
    timeoutMs: runTimeoutMs, label: "Encoding run", trackChildren: true, onEvent,
  });
  for (const [name, count] of evidence) {
    if (count !== 1) throw new Error(`Expected exactly one successful named test: ${name}; received ${count}`);
    console.log(`media-encoding: executed=1: ${name}`);
  }
  if (summaries.length !== 1 || summaries[0].success !== true || summaries[0].counts?.tests !== 2
    || summaries[0].counts?.passed !== 2 || summaries[0].counts?.suites !== 0) {
    throw new Error("Missing, empty or mismatched final test summary");
  }
  console.log(`media-encoding: PASS: 2 named tests; ${requiredFile}; no skips or todos`);
}

if (new URL(import.meta.url).searchParams.get("track") === "1") {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (...argumentsList) {
    const child = Reflect.apply(originalSpawn, this, argumentsList);
    if (child.pid) {
      const options = Array.isArray(argumentsList[1]) ? argumentsList[2] : argumentsList[1];
      const record = { pid: child.pid, detached: options?.detached === true };
      writeSync(3, `${JSON.stringify({ type: "spawn", ...record })}\n`);
      child.once("close", () => writeSync(3, `${JSON.stringify({ type: "close", ...record })}\n`));
    }
    return child;
  };
  syncBuiltinESMExports();
} else if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`media-encoding: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
