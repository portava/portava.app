import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, open, realpath, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

const supportedPlatform = process.platform === "linux" && process.arch === "x64";
const osReleasePath = "/etc/os-release";
const systemBin = "/usr/bin";
const systemPath = "/usr/bin:/bin";
const unprivileged = process.getuid?.() !== 0;
const wholeRunMs = 300_000;
const stageOutputBytes = 4_000_000;
const totalOutputBytes = 32_000_000;
const archiveLimitBytes = 32 * 1024 * 1024;
const sources = [
  {
    name: "ffmpeg", revision: "8.0", directory: "ffmpeg-8.0", archive: "ffmpeg-8.0.tar.xz",
    url: "https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz",
    sha256: "b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e",
  },
  {
    name: "x264", revision: "b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
    directory: "x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
    archive: "x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz",
    url: "https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz",
    sha256: "cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9",
  },
];
const timeouts = { download: 45_000, extract: 15_000, configure: 30_000, x264: 90_000, ffmpeg: 180_000, install: 15_000, probe: 5_000 };
const commands = Object.fromEntries(["gcc", "make", "ar", "ranlib", "pkg-config", "curl", "tar"].map((name) => [name, join(systemBin, name)]));
const started = Date.now();
const deadline = started + wholeRunMs;
const stages = [];
let outputBytes = 0;
let interrupted;
let stopActive;

function interrupt(signal) {
  interrupted = `Interrupted by ${signal}`;
  stopActive?.(interrupted);
}

process.on("SIGINT", () => interrupt("SIGINT"));
process.on("SIGTERM", () => interrupt("SIGTERM"));

function checkDeadline() {
  if (interrupted || Date.now() >= deadline) throw new Error(interrupted ?? "Whole preparation deadline exceeded");
}

function absolutePath(value, label) {
  if (!value || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${label} must be an absolute single-line path`);
  return value;
}

function inside(root, target) {
  const path = relative(root, target);
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) throw new Error(`Path must remain inside ${root}: ${target}`);
}

async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function directory(path, root) {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a directory, never a symlink: ${path}`);
  inside(root, await realpath(path));
}

async function regularFile(path, root, executable = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0 || info.size > 64 * 1024 * 1024) throw new Error(`Expected a nonempty bounded regular file, never a symlink: ${path}`);
  inside(root, await realpath(path));
  if (executable) await access(path, constants.X_OK);
  return info;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedRead(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error(`Expected a nonempty bounded regular file: ${path}`);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      checkDeadline();
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error(`File changed while reading: ${path}`);
      offset += result.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error(`File grew while reading: ${path}`);
    return bytes;
  } finally { await file.close(); }
}

async function verifiedArchive(path, source) {
  if (!(await lstat(path)).isFile()) throw new Error(`Source archive must be a regular file, never a symlink: ${path}`);
  const bytes = await boundedRead(path, archiveLimitBytes);
  if (digest(bytes) !== source.sha256) throw new Error(`${source.name} source SHA256 mismatch`);
  console.log(`media-encoding-prepare: verified ${source.name} ${source.revision} SHA256 ${source.sha256}`);
  return bytes;
}

async function run(program, argumentsList, label, timeout, cwd, environment, build) {
  checkDeadline();
  const remaining = Math.min(timeout, deadline - Date.now());
  const stageStarted = Date.now();
  const log = join(build, `${label}.log`);
  const descriptor = openSync(log, "wx", 0o600);
  let count = 0;
  let stdout = "";
  let tail = "";
  let failure;
  console.log(`media-encoding-prepare: ${label}`);
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(program, argumentsList, { cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let cleanupTimer;
      const stop = (reason) => {
        failure ??= reason;
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") failure += `; kill failed: ${error.message}`; }
        }
        cleanupTimer ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1_000);
      };
      stopActive = stop;
      const timer = setTimeout(() => stop(`${label} timeout or whole preparation deadline exceeded`), remaining);
      const accept = (chunk, isStdout) => {
        count += chunk.length;
        outputBytes += chunk.length;
        if (count >= stageOutputBytes || outputBytes >= totalOutputBytes) {
          stop("Raw process output limit exceeded before filtering");
          return;
        }
        if (failure) return;
        try { writeSync(descriptor, chunk); }
        catch (error) { stop(`Could not write bounded log: ${error.message}`); return; }
        tail = (tail + chunk.toString("utf8")).slice(-12_000);
        if (isStdout) stdout += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk) => accept(chunk, true));
      child.stderr.on("data", (chunk) => accept(chunk, false));
      child.once("error", (error) => stop(`Could not start ${label}: ${error.message}`));
      child.once("exit", (code, signal) => {
        if (code !== 0 || signal) stop(`${label} failed: exit=${code} signal=${signal}`);
      });
      child.once("close", (code, signal) => {
        if (code !== 0 || signal) stop(`${label} failed: exit=${code} signal=${signal}`);
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        stopActive = undefined;
        resolve({ code, signal });
      });
    });
    if (failure || result.code !== 0 || result.signal) throw new Error(`${failure ?? `${label} failed`}\n${tail}`);
    checkDeadline();
    stages.push({ label, program, arguments: argumentsList, elapsedMs: Date.now() - stageStarted, outputBytes: count });
    return stdout;
  } finally { closeSync(descriptor); }
}

async function main() {
  if (process.argv.length !== 2) throw new Error("Preparation accepts no arguments or alternate source/runtime configuration");
  if (!supportedPlatform) throw new Error("Preparation requires Linux x64 (ubuntu-24.04)");
  if (!unprivileged) throw new Error("Preparation must run unprivileged, not as root");
  const release = (await boundedRead(await realpath(osReleasePath), 65_536)).toString("utf8");
  if ((release.match(/^ID=/gm) ?? []).length !== 1 || (release.match(/^VERSION_ID=/gm) ?? []).length !== 1
    || !/^ID=(?:ubuntu|"ubuntu"|'ubuntu')$/m.test(release) || !/^VERSION_ID=(?:24\.04|"24\.04"|'24\.04')$/m.test(release)) {
    throw new Error("Preparation requires the ubuntu-24.04 image");
  }
  const root = await realpath(absolutePath(process.env.RUNNER_TEMP, "RUNNER_TEMP"));
  if (!(await lstat(root)).isDirectory() || !/^\/[A-Za-z0-9_./-]+$/.test(root)) throw new Error("RUNNER_TEMP must resolve to an existing directory with safe ASCII path segments");
  const suppliedOutput = absolutePath(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  const output = join(await realpath(dirname(suppliedOutput)), basename(suppliedOutput));
  inside(root, output);
  const existingOutput = await optionalStat(output);
  if (existingOutput && (!existingOutput.isFile() || existingOutput.nlink !== 1)) throw new Error("GITHUB_OUTPUT must be a regular single-link file, never a symlink or directory");
  const outputFile = await open(output, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const outputIdentity = await outputFile.stat();
    if (!outputIdentity.isFile() || outputIdentity.nlink !== 1) throw new Error("GITHUB_OUTPUT must be a regular single-link file");
    const cache = join(root, "media-encoding-source");
    if (!await optionalStat(cache)) await mkdir(cache, { mode: 0o700 });
    await directory(cache, root);
    const archives = new Map();
    for (const source of sources) {
      const path = join(cache, source.archive);
      if (await optionalStat(path)) archives.set(source.name, await verifiedArchive(path, source));
    }
    for (const program of Object.values(commands)) {
      if (!(await lstat(await realpath(program))).isFile()) throw new Error(`Prerequisite must resolve to a regular executable: ${program}`);
      await access(program, constants.X_OK);
    }
    const build = await mkdtemp(join(root, "media-encoding-build-"));
    const runtime = join(build, "runtime");
    const environment = {
      PATH: systemPath, HOME: build, TMPDIR: build, TMP: build, TEMP: build,
      LANG: "C", LC_ALL: "C", TZ: "UTC", NODE_V8_COVERAGE: undefined,
      CC: commands.gcc, AR: commands.ar, RANLIB: commands.ranlib, PKG_CONFIG: commands["pkg-config"],
      PKG_CONFIG_LIBDIR: join(runtime, "lib/pkgconfig"), PKG_CONFIG_PATH: "",
    };
    for (const source of sources) {
      if (!archives.has(source.name)) {
        const download = join(build, `download-${source.archive}`);
        await run(commands.curl, ["--disable", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2",
          "--connect-timeout", "10", "--max-time", "30", "--retry", "1", "--retry-max-time", "40", "--max-filesize", String(archiveLimitBytes),
          "--output", download, source.url], `${source.name}-download`, timeouts.download, build, environment, build);
        archives.set(source.name, await verifiedArchive(download, source));
        await link(download, join(cache, source.archive));
        await unlink(download);
      }
      const bytes = archives.get(source.name);
      if (digest(bytes) !== source.sha256) throw new Error(`${source.name} source SHA256 mismatch before extraction`);
      await writeFile(join(build, source.archive), bytes, { flag: "wx", mode: 0o600 });
    }
    const compilerVersion = (await run(commands.gcc, ["--version"], "compiler-version", timeouts.probe, build, environment, build)).trim();
    const pkgConfigVersion = (await run(commands["pkg-config"], ["--version"], "pkg-config-version", timeouts.probe, build, environment, build)).trim();
    if (!compilerVersion || !pkgConfigVersion) throw new Error("Compiler and pkg-config must report versions");
    for (const source of sources) {
      await run(commands.tar, ["--extract", "--file", join(build, source.archive), "--directory", build, "--no-same-owner", "--no-same-permissions"],
        `${source.name}-extract`, timeouts.extract, build, environment, build);
      await directory(join(build, source.directory), build);
      await regularFile(join(build, source.directory, "configure"), build, true);
    }
    const jobs = `-j${Math.max(1, Math.min(4, availableParallelism()))}`;
    const x264 = join(build, sources[1].directory);
    await run(join(x264, "configure"), [`--prefix=${runtime}`, "--enable-static", "--enable-pic", "--disable-cli", "--disable-opencl",
      "--disable-bashcompletion", "--disable-asm", "--bit-depth=8", "--chroma-format=420"], "x264-configure", timeouts.configure, x264, environment, build);
    await run(commands.make, [jobs], "x264-build", timeouts.x264, x264, environment, build);
    await run(commands.make, ["install-lib-static"], "x264-install", timeouts.install, x264, environment, build);
    await directory(runtime, build);
    for (const path of ["lib/libx264.a", "include/x264.h", "include/x264_config.h", "lib/pkgconfig/x264.pc"]) await regularFile(join(runtime, path), runtime);
    const prefix = await run(commands["pkg-config"], ["--variable=prefix", "x264"], "x264-prefix", timeouts.probe, build, environment, build);
    const version = await run(commands["pkg-config"], ["--modversion", "x264"], "x264-version", timeouts.probe, build, environment, build);
    if (prefix.trim() !== runtime || version.trim() !== "0.165.x") throw new Error("pkg-config must resolve the fresh pinned x264 prefix and version 0.165.x");
    const ffmpeg = join(build, sources[0].directory);
    await run(join(ffmpeg, "configure"), [`--prefix=${runtime}`, `--cc=${commands.gcc}`, `--pkg-config=${commands["pkg-config"]}`, "--pkg-config-flags=--static",
      `--extra-cflags=-I${join(runtime, "include")}`, `--extra-ldflags=-L${join(runtime, "lib")}`,
      "--disable-everything", "--disable-autodetect", "--disable-network", "--disable-doc", "--disable-debug", "--disable-shared", "--enable-static",
      "--disable-x86asm", "--enable-gpl", "--enable-libx264", "--enable-ffmpeg", "--enable-ffprobe", "--enable-protocol=file,pipe",
      "--enable-demuxer=mov,matroska,mpegts,hls,image2,mjpeg", "--enable-muxer=mp4,mpegts,hls,null,image2",
      "--enable-decoder=h264,aac,mpeg4,mpeg2video,pcm_s16le,rawvideo,wrapped_avframe,mjpeg", "--enable-encoder=libx264,aac,wrapped_avframe,mjpeg,pcm_s16le",
      "--enable-parser=h264,aac,mpeg4video,mpegaudio,mjpeg", "--enable-filter=scale,format,setsar,fps,aresample,aformat,anull,null,testsrc2,sine,color", "--enable-indev=lavfi"],
    "ffmpeg-configure", timeouts.configure, ffmpeg, environment, build);
    await run(commands.make, [jobs], "ffmpeg-build", timeouts.ffmpeg, ffmpeg, environment, build);
    await run(commands.make, ["install"], "ffmpeg-install", timeouts.install, ffmpeg, environment, build);
    const bin = join(runtime, "bin");
    await directory(bin, runtime);
    const binaries = [];
    for (const name of ["ffmpeg", "ffprobe"]) {
      const path = join(bin, name);
      const info = await regularFile(path, runtime, true);
      if (binaries.some((entry) => entry.dev === info.dev && entry.ino === info.ino)) throw new Error("ffmpeg and ffprobe must be distinct executables");
      const banner = await run(path, ["-version"], `${name}-version`, timeouts.probe, build, environment, build);
      if (!new RegExp(`^${name} version 8\\.0(?:\\s|$)`).test(banner.split(/\r?\n/)[0])) throw new Error(`${name} must report exactly ${name} version 8.0`);
      binaries.push({ name, path, dev: info.dev, ino: info.ino, sha256: digest(await boundedRead(path, 64 * 1024 * 1024)), banner: banner.trim() });
    }
    checkDeadline();
    await writeFile(join(build, "preparation-evidence.json"), JSON.stringify({
      recipe: "media-encoding-v1", sources, compilerVersion, pkgConfigVersion, binaries, stages,
      elapsedMs: Date.now() - started, outputBytes, proof: "Prepared source-pinned tools; separate strict encoding gate remains required",
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const finalOutput = await lstat(output);
    if (!finalOutput.isFile() || finalOutput.nlink !== 1 || finalOutput.dev !== outputIdentity.dev || finalOutput.ino !== outputIdentity.ino) throw new Error("GITHUB_OUTPUT changed during preparation");
    checkDeadline();
    await outputFile.writeFile(binaries.map(({ name, path }) => `${name}=${path}\n`).join(""));
    console.log(`media-encoding-prepare: ready FFmpeg 8.0 tools: ${bin}; runtime proof still required`);
  } finally { await outputFile.close(); }
}

main().catch((error) => { console.error(`media-encoding-prepare: FAIL: ${error.message}`); process.exitCode = 1; });
