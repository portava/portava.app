import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rename } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

const version = "17.11";
const checksum = "dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979";
const archiveName = `postgresql-${version}.tar.bz2`;
const deadline = Date.now() + 540_000;
const timeouts = { download: 120_000, extract: 30_000, configure: 90_000, build: 300_000, install: 45_000, version: 5_000 };
let activeChild;
let interrupted = false;

function stop() {
  interrupted = true;
  if (!activeChild?.pid) return;
  try { process.kill(-activeChild.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") console.error(error.message); }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function absolutePath(value, label) {
  if (!value || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${label} must be an absolute, single-line path`);
  return value;
}

function inside(root, target) {
  const path = relative(root, target);
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) throw new Error(`Path must remain inside RUNNER_TEMP: ${target}`);
}

async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function verifyArchive(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0 || info.size > 64 * 1024 * 1024) throw new Error("Source archive must be a nonempty regular file no larger than 64 MiB");
  if (createHash("sha256").update(await readFile(path)).digest("hex") !== checksum) throw new Error("PostgreSQL source archive SHA256 mismatch");
  console.log(`memory-native-prepare: verified PostgreSQL ${version} source SHA256 ${checksum}`);
}

async function run(program, argumentsList, label, timeout, cwd, environment, logRoot) {
  const remaining = Math.min(timeout, deadline - Date.now());
  if (interrupted || remaining <= 0) throw new Error("Preparation interrupted or whole-run deadline exceeded");
  const log = join(logRoot, `${label}.log`);
  const descriptor = openSync(log, "w", 0o600);
  console.log(`memory-native-prepare: ${label}`);
  let timedOut = false;
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(program, argumentsList, { cwd, env: environment, detached: true, stdio: ["ignore", descriptor, descriptor] });
      activeChild = child;
      timer = setTimeout(() => { timedOut = true; stop(); }, remaining);
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0 || result.signal || timedOut || interrupted) {
      throw new Error(`${label} failed: exit=${result.code} signal=${result.signal} timeout=${timedOut}\n${(await readFile(log, "utf8")).slice(-12_000)}`);
    }
  } finally {
    clearTimeout(timer);
    activeChild = undefined;
    closeSync(descriptor);
  }
  return log;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("Preparation accepts no arguments or alternate source/runtime configuration");
  if (process.getuid?.() === 0) throw new Error("PostgreSQL preparation must run unprivileged, not as root");
  const root = await realpath(absolutePath(process.env.RUNNER_TEMP, "RUNNER_TEMP"));
  if (!(await lstat(root)).isDirectory()) throw new Error("RUNNER_TEMP must be an existing directory");
  absolutePath(root, "Resolved RUNNER_TEMP");
  const suppliedOutput = absolutePath(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  const outputParent = await realpath(dirname(suppliedOutput));
  const output = join(outputParent, basename(suppliedOutput));
  inside(root, output);
  const outputInfo = await optionalStat(output);
  if (outputInfo && !outputInfo.isFile()) throw new Error("GITHUB_OUTPUT must be a regular file, never a symlink or directory");
  const cache = join(root, "memory-postgres-source");
  await mkdir(cache, { recursive: true });
  if (!(await lstat(cache)).isDirectory()) throw new Error("Source cache must be a directory, never a symlink");
  inside(root, await realpath(cache));
  const build = await mkdtemp(join(root, "memory-postgres-build-"));
  const runtime = join(build, "runtime");
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: build, TMPDIR: build, LC_ALL: "C" };
  const archive = join(cache, archiveName);
  if (!await optionalStat(archive)) {
    const download = join(build, archiveName);
    await run("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2",
      "--connect-timeout", "10", "--max-time", "30", "--retry", "2", "--retry-max-time", "90", "--output", download,
      `https://ftp.postgresql.org/pub/source/v${version}/${archiveName}`], "download", timeouts.download, build, environment, build);
    await verifyArchive(download);
    await rename(download, archive);
  }
  await verifyArchive(archive);
  await run("tar", ["-xjf", archive, "--directory", build, "--no-same-owner"], "extract", timeouts.extract, build, environment, build);
  const source = join(build, `postgresql-${version}`);
  if (!(await lstat(source)).isDirectory()) throw new Error("Extracted source must be a regular directory");
  const configure = join(source, "configure");
  if (!(await lstat(configure)).isFile()) throw new Error("Extracted configure must be a regular file");
  await access(configure, constants.X_OK);
  await run(configure, [`--prefix=${runtime}`, "--without-readline", "--without-icu", "--without-zlib"], "configure", timeouts.configure, source, environment, build);
  await run("make", [`-j${Math.max(1, Math.min(4, availableParallelism()))}`], "build", timeouts.build, source, environment, build);
  await run("make", ["install"], "install", timeouts.install, source, environment, build);
  const binaryDirectory = join(runtime, "bin");
  inside(build, await realpath(binaryDirectory));
  for (const name of ["initdb", "pg_ctl", "psql", "postgres"]) {
    const binary = join(binaryDirectory, name);
    if (!(await lstat(binary)).isFile()) throw new Error(`${name} must be a regular executable file`);
    inside(build, await realpath(binary));
    await access(binary, constants.X_OK);
    const log = await run(binary, ["--version"], `${name}-version`, timeouts.version, build, environment, build);
    if ((await readFile(log, "utf8")).trim() !== `${name} (PostgreSQL) ${version}`) throw new Error(`${name} must report exact PostgreSQL ${version}`);
  }
  if (interrupted || Date.now() >= deadline) throw new Error("Preparation interrupted or whole-run deadline exceeded");
  await appendFile(output, `bin=${binaryDirectory}\n`);
  console.log(`memory-native-prepare: ready PostgreSQL ${version}: ${binaryDirectory}`);
}

main().catch((error) => { console.error(`memory-native-prepare: FAIL: ${error.message}`); process.exitCode = 1; });
