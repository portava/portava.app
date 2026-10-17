import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const preparation = join(repository, ".github/scripts/prepare-media-encoding-tools.mjs");
const pins = [
  { name: "ffmpeg", archive: "ffmpeg-8.0.tar.xz", directory: "ffmpeg-8.0", checksum: "b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e", url: "https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz" },
  { name: "x264", archive: "x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz", directory: "x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55", checksum: "cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9", url: "https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz" },
];
const programs = ["gcc", "make", "ar", "ranlib", "pkg-config", "curl", "tar"];
const poisoned = {
  NODE_OPTIONS: "--no-warnings", NODE_PATH: "/synthetic-node-path", NODE_TEST_CONTEXT: "synthetic-context", NODE_TEST_NAME_PATTERN: "never-match",
  NODE_V8_COVERAGE: "coverage", CFLAGS: "poison", CXXFLAGS: "poison", CPPFLAGS: "poison", LDFLAGS: "poison", MAKEFLAGS: "poison", MAKEFILES: "poison",
  BASH_ENV: "/synthetic-shell", ENV: "/synthetic-shell", LD_LIBRARY_PATH: "/synthetic-library", DYLD_LIBRARY_PATH: "/synthetic-library",
  PKG_CONFIG_SYSROOT_DIR: "/synthetic-sysroot", SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-key", DATABASE_URL: "synthetic-db",
  HTTPS_PROXY: "http://synthetic.invalid", http_proxy: "http://synthetic.invalid", CURL_CA_BUNDLE: "/synthetic-ca", GIT_CONFIG_GLOBAL: "/synthetic-git",
  FFMPEG_PATH: "/synthetic-existing-ffmpeg", FFPROBE_PATH: "/synthetic-existing-ffprobe", MEDIA_REQUIRE_ENCODING_TESTS: "false",
  MEDIA_ENCODING_SOURCE_URL: "https://synthetic.invalid", MEDIA_ENCODING_SHA256: "synthetic", MEDIA_ENCODING_TIMEOUT: "9999999",
};

type Shape = "absent" | "corrupt" | "empty" | "directory" | "symlink" | "oversized";
interface Options {
  cache?: Record<string, Shape | undefined>;
  root?: "unset" | "relative" | "missing" | "file" | "newline" | "space" | "metacharacter" | "alias";
  output?: "unset" | "relative" | "outside" | "parent-symlink" | "directory" | "symlink" | "hardlink" | "missing";
  cacheDirectory?: "symlink" | "file";
  platform?: boolean;
  distribution?: "other" | "wrong-version" | "duplicate" | "missing";
  privileged?: boolean;
  argumentsList?: readonly string[];
  entryAlias?: boolean;
  prerequisite?: string;
  prerequisiteShape?: "missing" | "directory" | "nonexecutable";
  failure?: string;
  mode?: string;
  binary?: string;
  binaryShape?: string;
  wholeDeadline?: boolean;
  poisonEnvironment?: boolean;
  shrinkTotalLimit?: boolean;
}
interface Event { label: string; name: string; args: string[]; cwd: string; environment: Record<string, string>; }
interface Evidence {
  sources: Array<{ name: string; sha256: string; revision: string; url: string }>;
  binaries: Array<{ name: string; path: string; sha256: string; banner: string }>;
  stages: Array<{ label: string; outputBytes: number; arguments: string[] }>;
  compilerVersion: string;
  pkgConfigVersion: string;
  outputBytes: number;
  proof: string;
}

function replaceOnce(source: string, before: string, after: string) {
  assert.equal(source.split(before).length, 2, `synthetic fixture must replace exactly one literal: ${before}`);
  return source.replace(before, after);
}

async function invoke(options: Options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "media-encoding-ci-control-")));
  try {
    const root = join(directory, options.root === "space" ? "runner temp" : options.root === "metacharacter" ? "runner;$temp" : "runner-temp");
    const tools = join(directory, "synthetic-tools");
    const output = join(root, "step-output");
    const cache = join(root, "media-encoding-source");
    await mkdir(root);
    await mkdir(tools);
    await writeFile(output, "existing=preserved\n");
    let source = await readFile(preparation, "utf8");
    source = replaceOnce(source, 'const supportedPlatform = process.platform === "linux" && process.arch === "x64";', `const supportedPlatform = ${options.platform !== false};`);
    const release = join(directory, "synthetic-os-release");
    source = replaceOnce(source, 'const osReleasePath = "/etc/os-release";', `const osReleasePath = ${JSON.stringify(release)};`);
    if (options.distribution !== "missing") await writeFile(release, options.distribution === "other" ? 'ID=debian\nVERSION_ID="24.04"\n'
      : options.distribution === "wrong-version" ? 'ID=ubuntu\nVERSION_ID="22.04"\n'
        : 'ID=ubuntu\nVERSION_ID="24.04"\n' + (options.distribution === "duplicate" ? 'ID=debian\n' : ''));
    source = replaceOnce(source, 'const systemBin = "/usr/bin";', `const systemBin = ${JSON.stringify(tools)};`);
    source = replaceOnce(source, "const unprivileged = process.getuid?.() !== 0;", `const unprivileged = ${!options.privileged};`);
    if (options.wholeDeadline) source = replaceOnce(source, "const wholeRunMs = 300_000;", "const wholeRunMs = 5_000;");
    if (options.mode === "timeout") source = replaceOnce(source, "configure: 30_000", "configure: 600");
    if (options.mode?.startsWith("inherited-pipe-")) source = replaceOnce(source, "configure: 30_000", "configure: 2_000");
    if (options.shrinkTotalLimit) source = replaceOnce(source, "const totalOutputBytes = 32_000_000;", "const totalOutputBytes = 50_000;");
    const fixtureBytes = new Map(pins.map((pin) => [pin.name, Buffer.from(`EXPLICITLY SYNTHETIC ${pin.name} archive; not source or runtime evidence\n`)]));
    for (const pin of pins) {
      source = replaceOnce(source, pin.checksum, createHash("sha256").update(fixtureBytes.get(pin.name)!).digest("hex"));
      await writeFile(join(directory, `${pin.name}-fixture`), fixtureBytes.get(pin.name)!);
    }
    const entry = join(directory, "prepare.mjs");
    await writeFile(entry, source);
    const stub = `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const directory = ${JSON.stringify(directory)};
const options = ${JSON.stringify(options)};
const pins = ${JSON.stringify(pins)};
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const family = basename(process.cwd()).startsWith('x264-') ? 'x264' : 'ffmpeg';
const archivePin = pins.find(pin => args.some(value => value.endsWith(pin.archive)) || args.includes(pin.url));
const install = args[0] === 'install' || args[0] === 'install-lib-static';
const label = name === 'curl' ? archivePin.name + '-download' : name === 'tar' ? archivePin.name + '-extract'
  : name === 'configure' ? family + '-configure' : name === 'make' ? family + (install ? '-install' : '-build')
  : name === 'gcc' ? 'compiler-version' : name === 'pkg-config' ? args[0] === '--version' ? 'pkg-config-version' : args[0] === '--modversion' ? 'x264-version' : 'x264-prefix'
  : name + '-version';
appendFileSync(join(directory, 'events'), JSON.stringify({ label, name, args, cwd: process.cwd(), environment: process.env }) + '\\n');
if (options.mode === 'aggregate-output') process.stdout.write('a'.repeat(12000));
if (options.failure === label) {
  if (['timeout', 'deadline', 'signal', 'descendant-failure'].includes(options.mode)) {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(join(directory, 'descendant-pid'), String(descendant.pid));
    if (options.mode === 'descendant-failure') process.exit(9);
    if (options.mode === 'signal') process.kill(process.ppid, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 10000));
  } else if (options.mode?.startsWith('inherited-pipe-')) {
    const healthy = options.mode === 'inherited-pipe-success';
    const descendant = spawn(process.execPath, ['-e', healthy
      ? "setTimeout(() => process.stdout.write('late inherited pipe output'), 250)"
      : 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    writeFileSync(join(directory, 'descendant-pid'), String(descendant.pid));
    if (healthy) {
      writeFileSync('.prefix', args.find(value => value.startsWith('--prefix=')).slice('--prefix='.length));
      process.exit(0);
    }
    if (options.mode === 'inherited-pipe-signal') {
      process.kill(process.pid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    process.exit(9);
  } else if (options.mode === 'stdout-flood' || options.mode === 'stderr-flood' || options.mode === 'mixed-flood') {
    const chunk = Buffer.alloc(options.mode === 'mixed-flood' ? 2100000 : 4100000, 'x');
    await new Promise(resolve => (options.mode === 'stderr-flood' ? process.stderr : process.stdout).write(chunk, resolve));
    if (options.mode === 'mixed-flood') await new Promise(resolve => process.stderr.write(chunk, resolve));
  } else process.exit(9);
}
if (name === 'curl') {
  const destination = args[args.indexOf('--output') + 1];
  if (options.mode === 'download-missing') process.exit(0);
  if (options.mode === 'download-corrupt') writeFileSync(destination, 'corrupt');
  else if (options.mode === 'download-symlink') symlinkSync(join(directory, archivePin.name + '-fixture'), destination);
  else copyFileSync(join(directory, archivePin.name + '-fixture'), destination);
  if (options.mode === 'download-oversized') truncateSync(destination, 32 * 1024 * 1024 + 1);
} else if (name === 'tar') {
  const bytes = readFileSync(args[args.indexOf('--file') + 1]);
  if (!args[args.indexOf('--file') + 1].startsWith(process.env.HOME + '/') || !bytes.equals(readFileSync(join(directory, archivePin.name + '-fixture')))) process.exit(19);
  const source = join(args[args.indexOf('--directory') + 1], archivePin.directory);
  if (options.mode === 'source-missing') process.exit(0);
  if (options.mode === 'source-symlink') { symlinkSync(directory, source); process.exit(0); }
  mkdirSync(source);
  const configure = join(source, 'configure');
  if (options.mode === 'configure-missing') process.exit(0);
  if (options.mode === 'configure-symlink') symlinkSync(join(directory, 'stub.mjs'), configure);
  else { copyFileSync(join(directory, 'stub.mjs'), configure); chmodSync(configure, options.mode === 'configure-nonexecutable' ? 0o600 : 0o700); }
} else if (name === 'configure') {
  writeFileSync('.prefix', args.find(value => value.startsWith('--prefix=')).slice('--prefix='.length));
} else if (name === 'make') {
  if (install) {
    const prefix = readFileSync('.prefix', 'utf8');
    if (family === 'x264') {
      if (options.mode === 'runtime-symlink') { symlinkSync(directory, prefix); process.exit(0); }
      for (const artifact of ['lib/libx264.a', 'include/x264.h', 'include/x264_config.h', 'lib/pkgconfig/x264.pc']) {
        const path = join(prefix, artifact);
        mkdirSync(join(path, '..'), { recursive: true });
        if (options.mode === 'x264-artifact-missing' && artifact === 'lib/libx264.a') continue;
        if (options.mode === 'x264-artifact-symlink' && artifact === 'lib/libx264.a') symlinkSync(join(directory, 'stub.mjs'), path);
        else writeFileSync(path, 'synthetic x264 artifact');
      }
    } else {
      const bin = join(prefix, 'bin');
      if (options.mode === 'bin-symlink') { symlinkSync(directory, bin); process.exit(0); }
      mkdirSync(bin);
      for (const binary of ['ffmpeg', 'ffprobe']) {
        const path = join(bin, binary);
        const shape = options.binary === binary ? options.binaryShape : undefined;
        if (shape === 'missing') continue;
        if (shape === 'directory') { mkdirSync(path); continue; }
        if (shape === 'symlink') { symlinkSync(join(directory, 'stub.mjs'), path); continue; }
        if (shape === 'hardlink') { linkSync(join(bin, 'ffmpeg'), path); continue; }
        copyFileSync(join(directory, 'stub.mjs'), path);
        chmodSync(path, shape === 'nonexecutable' ? 0o600 : 0o700);
        if (shape === 'empty') truncateSync(path, 0);
      }
      if (options.mode === 'output-replaced') { rmSync(${JSON.stringify(output)}); writeFileSync(${JSON.stringify(output)}, 'replaced'); }
    }
  }
} else if (name === 'gcc') {
  if (options.mode === 'mutate-cache') for (const pin of pins) writeFileSync(join(${JSON.stringify(cache)}, pin.archive), 'changed after validation');
  console.log('synthetic gcc control (NOT a compiler)');
} else if (name === 'pkg-config') {
  if (args[0] === '--version') console.log('synthetic pkg-config control');
  else if (args[0] === '--modversion') console.log(options.mode === 'wrong-x264-version' ? '0.164.x' : '0.165.x');
  else console.log(options.mode === 'wrong-x264-prefix' ? '/usr/lib' : join(process.env.HOME, 'runtime'));
} else if (name === 'ffmpeg' || name === 'ffprobe') {
  const shape = options.binary === name ? options.binaryShape : undefined;
  if (shape === 'version-failure') process.exit(9);
  if (shape === 'empty-version') process.exit(0);
  console.log((shape === 'wrong-name' ? 'unrelated' : name) + ' version ' + (shape?.startsWith('version:') ? shape.slice(8) : '8.0') + ' synthetic control only');
}
`;
    await writeFile(join(directory, "stub.mjs"), stub, { mode: 0o700 });
    for (const program of programs) {
      const path = join(tools, program);
      if (options.prerequisite === program && options.prerequisiteShape === "missing") continue;
      if (options.prerequisite === program && options.prerequisiteShape === "directory") await mkdir(path);
      else {
        await writeFile(path, stub, { mode: options.prerequisite === program && options.prerequisiteShape === "nonexecutable" ? 0o600 : 0o700 });
      }
    }
    if (options.cacheDirectory === "symlink") await symlink(directory, cache, "dir");
    else if (options.cacheDirectory === "file") await writeFile(cache, "not a directory");
    else {
      await mkdir(cache);
      for (const pin of pins) {
        const shape = options.cache?.[pin.name];
        const path = join(cache, pin.archive);
        if (shape === "absent") continue;
        if (shape === "directory") await mkdir(path);
        else if (shape === "symlink") await symlink(join(directory, `${pin.name}-fixture`), path);
        else {
          await writeFile(path, shape === "empty" ? "" : shape === "corrupt" ? "corrupt" : fixtureBytes.get(pin.name)!);
          if (shape === "oversized") await truncate(path, 32 * 1024 * 1024 + 1);
        }
      }
    }
    let suppliedRoot = root;
    if (options.root === "alias") {
      suppliedRoot = join(directory, "root-alias");
      await symlink(root, suppliedRoot, "dir");
    }
    const environment: NodeJS.ProcessEnv = { PATH: "/synthetic-unusable-path", RUNNER_TEMP: suppliedRoot, GITHUB_OUTPUT: join(suppliedRoot, "step-output") };
    if (options.poisonEnvironment) Object.assign(environment, poisoned, { NODE_V8_COVERAGE: join(directory, "coverage"), CC: "poison", AR: "poison", RANLIB: "poison", PKG_CONFIG: "poison", PKG_CONFIG_PATH: "poison", PKG_CONFIG_LIBDIR: "poison", HOME: "/synthetic-home", TMPDIR: "/synthetic-temp", LANG: "poison", TZ: "poison", __CF_USER_TEXT_ENCODING: "synthetic-must-not-leak" });
    if (options.root === "unset") delete environment.RUNNER_TEMP;
    if (options.root === "relative") environment.RUNNER_TEMP = "relative";
    if (options.root === "missing") environment.RUNNER_TEMP = join(directory, "missing");
    if (options.root === "file") environment.RUNNER_TEMP = output;
    if (options.root === "newline") environment.RUNNER_TEMP = `${root}\nunsafe`;
    if (options.output === "unset") delete environment.GITHUB_OUTPUT;
    if (options.output === "relative") environment.GITHUB_OUTPUT = "relative";
    if (options.output === "outside") environment.GITHUB_OUTPUT = join(directory, "outside-output");
    if (options.output === "parent-symlink") {
      await symlink(directory, join(root, "outside-parent"), "dir");
      environment.GITHUB_OUTPUT = join(root, "outside-parent", "outside-output");
    }
    if (["directory", "symlink", "hardlink", "missing"].includes(options.output ?? "")) {
      await rm(output);
      if (options.output === "directory") await mkdir(output);
      if (options.output === "symlink") await symlink(join(directory, "ffmpeg-fixture"), output);
      if (options.output === "hardlink") await link(join(directory, "ffmpeg-fixture"), output);
    }
    let suppliedEntry = entry;
    if (options.entryAlias) {
      suppliedEntry = join(directory, "entry-alias.mjs");
      await symlink(entry, suppliedEntry);
    }
    const result = spawnSync(process.execPath, [suppliedEntry, ...(options.argumentsList ?? [])], { cwd: directory, env: environment, encoding: "utf8", timeout: 18_000, maxBuffer: 500_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, "script must finish before the emergency fixture timeout");
    const events: Event[] = await readFile(join(directory, "events"), "utf8").then(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), () => []);
    const published = await readFile(output, "utf8").catch(() => "");
    const builds = (await readdir(root)).filter(name => name.startsWith("media-encoding-build-"));
    const evidence: Evidence | null = builds[0] ? await readFile(join(root, builds[0], "preparation-evidence.json"), "utf8").then(JSON.parse, () => null) : null;
    const logs = builds[0] ? await Promise.all((await readdir(join(root, builds[0]))).filter(name => name.endsWith(".log")).map(async name => ({ name, size: (await stat(join(root, builds[0], name))).size }))) : [];
    const descendant = await readFile(join(directory, "descendant-pid"), "utf8").then(Number, () => null);
    if (descendant) {
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt++) {
        try { process.kill(descendant, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
        catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); alive = false; }
      }
      if (alive) { process.kill(descendant, "SIGKILL"); assert.fail("preparation leaked its observed build descendant"); }
    }
    return { status: result.status, output: result.stdout + result.stderr, events, published, evidence, logs, root, suppliedRoot, tools, descendant };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function refused(result: Awaited<ReturnType<typeof invoke>>, expected: RegExp) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, expected);
  assert.doesNotMatch(result.output, /media-encoding-prepare: ready/);
  assert.doesNotMatch(result.published, /^ffmpeg=|^ffprobe=/m);
}

function successful(result: Awaited<ReturnType<typeof invoke>>) {
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.events.filter(event => ["ffmpeg-version", "ffprobe-version"].includes(event.label)).map(event => event.label), ["ffmpeg-version", "ffprobe-version"]);
  assert.equal(result.published.split("\n").filter(line => /^ffmpeg=|^ffprobe=/.test(line)).length, 2);
  for (const binary of ["ffmpeg", "ffprobe"]) assert.ok(result.published.includes(`${binary}=${result.root}/media-encoding-build-`));
  assert.ok(result.evidence);
  assert.deepEqual(result.evidence.binaries.map(binary => binary.name), ["ffmpeg", "ffprobe"]);
  assert.ok(result.evidence.binaries.every(binary => /^[a-f0-9]{64}$/.test(binary.sha256)));
  assert.equal(result.evidence.stages.length, result.events.length);
  assert.match(result.evidence.proof, /separate strict encoding gate remains required/);
  assert.ok(result.logs.every(log => log.size < 4_000_000));
}

describe("Media encoding CI preparation executable synthetic controls", { timeout: 300_000 }, () => {
  for (const cache of [undefined, { ffmpeg: "absent", x264: "absent" }, { x264: "absent" }] as const) it(`prepares both tools with ${JSON.stringify(cache ?? "verified cache")}`, async () => {
    const result = await invoke({ cache });
    successful(result);
    assert.deepEqual(result.events.filter(event => event.name === "curl").map(event => event.label), pins.filter(pin => cache?.[pin.name as keyof typeof cache] === "absent").map(pin => `${pin.name}-download`));
    for (const event of result.events.filter(event => event.name === "curl")) {
      assert.equal(event.args[0], "--disable");
      assert.ok(pins.some(pin => event.args.at(-1) === pin.url));
      for (const flag of ["--fail", "--proto", "--proto-redir", "--connect-timeout", "--max-time", "--retry-max-time", "--max-filesize"]) assert.ok(event.args.includes(flag));
    }
    assert.deepEqual(result.events.filter(event => event.name === "make").map(event => event.args), [[result.events.find(event => event.label === "x264-build")!.args[0]], ["install-lib-static"], [result.events.find(event => event.label === "ffmpeg-build")!.args[0]], ["install"]]);
    assert.ok(result.events.filter(event => event.label.endsWith("-build")).every(event => /^-j[1-4]$/.test(event.args[0])));
    assert.deepEqual(result.events.find(event => event.label === "x264-configure")!.args.slice(1), ["--enable-static", "--enable-pic", "--disable-cli", "--disable-opencl", "--disable-bashcompletion", "--disable-asm", "--bit-depth=8", "--chroma-format=420"]);
    const ffmpeg = result.events.find(event => event.label === "ffmpeg-configure")!;
    for (const argument of ["--disable-everything", "--disable-autodetect", "--disable-network", "--disable-shared", "--enable-static", "--disable-x86asm", "--enable-gpl", "--enable-libx264", "--enable-ffmpeg", "--enable-ffprobe", "--enable-protocol=file,pipe", "--pkg-config-flags=--static"]) assert.ok(ffmpeg.args.includes(argument));
    assert.deepEqual(result.evidence!.sources.map(source => source.url), pins.map(pin => pin.url));
  });

  it("replaces inherited environment with the fixed recipe for every child", async () => {
    const result = await invoke({ poisonEnvironment: true, cache: { ffmpeg: "absent", x264: "absent" } });
    successful(result);
    for (const { environment, cwd } of result.events) {
      const systemAdded = process.platform === "darwin" && environment.__CF_USER_TEXT_ENCODING !== undefined ? ["__CF_USER_TEXT_ENCODING"] : [];
      if (systemAdded.length) assert.match(environment.__CF_USER_TEXT_ENCODING!, /^(?:0x)?[0-9a-f]+:(?:0x)?[0-9a-f]+:(?:0x)?[0-9a-f]+$/i);
      assert.deepEqual(Object.keys(environment).sort(), ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "CC", "AR", "RANLIB", "PKG_CONFIG", "PKG_CONFIG_LIBDIR", "PKG_CONFIG_PATH", ...systemAdded].sort());
      for (const name of Object.keys(poisoned)) assert.equal(environment[name], undefined, name);
      assert.equal(environment.PATH, "/usr/bin:/bin");
      assert.ok(environment.HOME.startsWith(`${result.root}/media-encoding-build-`));
      assert.ok(cwd.startsWith(environment.HOME));
      assert.equal(environment.TMPDIR, environment.HOME);
      assert.equal(environment.TMP, environment.HOME);
      assert.equal(environment.TEMP, environment.HOME);
      assert.equal(environment.LANG, "C");
      assert.equal(environment.LC_ALL, "C");
      assert.equal(environment.TZ, "UTC");
      assert.equal(environment.CC, join(result.tools, "gcc"));
      assert.equal(environment.PKG_CONFIG_LIBDIR, join(environment.HOME, "runtime/lib/pkgconfig"));
      assert.equal(environment.PKG_CONFIG_PATH, "");
    }
  });

  it("canonicalizes aliased roots and actually executes an aliased script entry", async () => {
    const result = await invoke({ root: "alias", entryAlias: true });
    successful(result);
    assert.notEqual(result.root, result.suppliedRoot);
    assert.ok(!result.published.includes(result.suppliedRoot));
  });
  it("creates a missing confined output file only with complete success", async () => successful(await invoke({ output: "missing" })));
  it("extracts only verified private archive copies", async () => successful(await invoke({ mode: "assert-private-archive" })));
  it("does not extract cache bytes changed after verification", async () => successful(await invoke({ mode: "mutate-cache" })));

  for (const pin of pins) for (const shape of ["corrupt", "empty", "directory", "symlink", "oversized"] as const) it(`refuses ${shape} ${pin.name} cache before any command`, async () => {
    const result = await invoke({ cache: { [pin.name]: shape } });
    refused(result, /SHA256 mismatch|regular file/);
    assert.deepEqual(result.events, []);
  });
  for (const cacheDirectory of ["file", "symlink"] as const) it(`refuses ${cacheDirectory} cache directory`, async () => {
    const result = await invoke({ cacheDirectory });
    refused(result, /directory, never a symlink/);
    assert.deepEqual(result.events, []);
  });
  for (const root of ["unset", "relative", "missing", "file", "newline", "space", "metacharacter"] as const) it(`refuses ${root} root before execution`, async () => {
    const result = await invoke({ root });
    refused(result, /RUNNER_TEMP|ENOENT/);
    assert.deepEqual(result.events, []);
  });
  for (const output of ["unset", "relative", "outside", "parent-symlink", "directory", "symlink", "hardlink"] as const) it(`refuses ${output} output path before execution`, async () => {
    const result = await invoke({ output });
    refused(result, /GITHUB_OUTPUT|Path must remain inside/);
    assert.deepEqual(result.events, []);
  });
  for (const options of [{ platform: false }, { privileged: true }, { argumentsList: ["--skip-verify"] }, { entryAlias: true, prerequisite: "gcc", prerequisiteShape: "missing" }] as const) it(`refuses unsupported invocation ${JSON.stringify(options)}`, async () => {
    const result = await invoke(options);
    refused(result, /Linux x64|unprivileged|accepts no arguments|ENOENT/);
    assert.deepEqual(result.events, []);
  });
  for (const distribution of ["other", "wrong-version", "duplicate", "missing"] as const) it(`refuses ${distribution} OS release before execution`, async () => {
    const result = await invoke({ distribution });
    refused(result, /ubuntu-24\.04|ENOENT/);
    assert.deepEqual(result.events, []);
  });
  for (const prerequisite of programs) for (const prerequisiteShape of ["missing", "directory", "nonexecutable"] as const) it(`refuses ${prerequisiteShape} ${prerequisite} prerequisite`, async () => {
    const result = await invoke({ prerequisite, prerequisiteShape });
    refused(result, /ENOENT|EACCES|regular executable/);
    assert.deepEqual(result.events, []);
  });

  for (const failure of ["ffmpeg-download", "x264-download", "compiler-version", "pkg-config-version", "ffmpeg-extract", "x264-extract", "x264-configure", "x264-build", "x264-install", "x264-prefix", "x264-version", "ffmpeg-configure", "ffmpeg-build", "ffmpeg-install", "ffmpeg-version", "ffprobe-version"]) it(`fails closed on executed ${failure}`, async () => {
    const result = await invoke({ failure, cache: { ffmpeg: "absent", x264: "absent" } });
    refused(result, /failed: exit=9/);
    assert.equal(result.events.at(-1)?.label, failure);
    assert.equal(result.evidence, null);
  });
  for (const mode of ["download-missing", "download-corrupt", "download-symlink", "download-oversized"]) it(`refuses ${mode} before extraction`, async () => {
    const result = await invoke({ mode, cache: { ffmpeg: "absent" } });
    refused(result, /ENOENT|SHA256 mismatch|regular file/);
    assert.deepEqual(result.events.map(event => event.label), ["ffmpeg-download"]);
  });
  for (const mode of ["source-missing", "source-symlink", "configure-missing", "configure-symlink", "configure-nonexecutable", "runtime-symlink", "x264-artifact-missing", "x264-artifact-symlink", "wrong-x264-prefix", "wrong-x264-version", "bin-symlink", "output-replaced"]) it(`refuses ${mode} without publishing tools`, async () => {
    const result = await invoke({ mode });
    refused(result, /ENOENT|directory, never a symlink|regular file|EACCES|fresh pinned x264|GITHUB_OUTPUT changed/);
    assert.ok(result.events.some(event => event.label === "ffmpeg-extract"));
  });

  for (const binary of ["ffmpeg", "ffprobe"]) for (const binaryShape of ["missing", "directory", "symlink", "nonexecutable", "empty", "empty-version", "wrong-name", "version:7.0", "version:8.0.1", "version:8.0-dev", "version:80.0", "version-failure"]) it(`refuses ${binaryShape} ${binary}`, async () => {
    const result = await invoke({ binary, binaryShape });
    refused(result, /ENOENT|regular file|EACCES|must report exactly|failed: exit=9/);
    assert.ok(result.events.some(event => event.label === "ffmpeg-install"));
    if (["empty-version", "wrong-name", "version-failure"].includes(binaryShape) || binaryShape.startsWith("version:")) assert.equal(result.events.at(-1)?.label, `${binary}-version`);
  });
  it("refuses hardlinked tools even when the executable spoofs both banners", async () => {
    const result = await invoke({ binary: "ffprobe", binaryShape: "hardlink" });
    refused(result, /distinct executables/);
    assert.equal(result.events.at(-1)?.label, "ffmpeg-version");
  });
  for (const mode of ["stdout-flood", "stderr-flood", "mixed-flood"]) it(`bounds all raw ${mode} before log filtering`, async () => {
    const result = await invoke({ mode, failure: "ffmpeg-configure" });
    refused(result, /Raw process output limit exceeded before filtering/);
    assert.equal(result.events.at(-1)?.label, "ffmpeg-configure");
    assert.ok(result.logs.every(log => log.size < 4_000_000));
  });
  it("bounds cumulative raw output across individually bounded stages", async () => {
    const result = await invoke({ mode: "aggregate-output", shrinkTotalLimit: true });
    refused(result, /Raw process output limit exceeded before filtering/);
    assert.ok(result.events.length > 1);
    assert.ok(result.logs.every(log => log.size < 4_000_000));
  });
  for (const mode of ["timeout", "deadline", "signal", "descendant-failure"]) it(`fails and cleans the build process group on ${mode}`, async () => {
    const result = await invoke({ mode, failure: "x264-configure", wholeDeadline: mode === "deadline" });
    refused(result, /timeout|deadline|Interrupted by SIGTERM|failed: exit=9/);
    assert.equal(result.events.at(-1)?.label, "x264-configure");
    assert.ok(result.descendant, "the intended real local descendant must have started");
  });
  for (const [mode, expected] of [
    ["inherited-pipe-exit", /x264-configure failed: exit=9 signal=null/],
    ["inherited-pipe-signal", /x264-configure failed: exit=null signal=SIGTERM/],
  ] as const) it(`cleans inherited pipes on direct-child ${mode} without losing the original failure`, async () => {
    const result = await invoke({ mode, failure: "x264-configure" });
    refused(result, expected);
    assert.doesNotMatch(result.output, /timeout or whole preparation deadline/);
    assert.equal(result.events.at(-1)?.label, "x264-configure");
    assert.equal(result.evidence, null);
    assert.ok(result.descendant, "the inherited-pipe descendant must have started and been cleaned");
  });
  it("awaits healthy inherited-pipe closure and retains its late output", async () => {
    const result = await invoke({ mode: "inherited-pipe-success", failure: "x264-configure" });
    successful(result);
    const stage = result.evidence!.stages.find(entry => entry.label === "x264-configure");
    assert.equal(stage?.outputBytes, Buffer.byteLength("late inherited pipe output"));
    assert.ok(result.descendant, "the healthy inherited-pipe descendant must have completed");
  });
});

describe("Media encoding preparation production contract", () => {
  it("pins the official immutable sources and fixed bounded Linux recipe without fallback", async () => {
    const source = await readFile(preparation, "utf8");
    for (const pin of pins) {
      assert.equal(source.split(pin.checksum).length, 2);
      assert.ok(source.includes(pin.url));
    }
    assert.ok(source.includes('process.platform === "linux" && process.arch === "x64"'));
    assert.ok(source.includes('const systemBin = "/usr/bin"'));
    assert.ok(source.includes('const systemPath = "/usr/bin:/bin"'));
    assert.ok(source.includes("const wholeRunMs = 300_000"));
    assert.ok(source.includes("const stageOutputBytes = 4_000_000"));
    assert.ok(source.includes("const totalOutputBytes = 32_000_000"));
    assert.ok(source.includes("Math.min(4, availableParallelism())"));
    assert.ok(source.includes("process.getuid?.() !== 0"));
    assert.deepEqual([...source.matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1]).sort(), ["GITHUB_OUTPUT", "RUNNER_TEMP"]);
    assert.doesNotMatch(source, /\bsudo\b|\bapt-get\b|\bbrew\b|x264-stable|snapshots\/|mirror\/x264|--extra-version/);
    assert.doesNotMatch(source, /run-media-encoding-tests|mediaAdaptiveEncoding\.real\.test/);
  });

  it("refuses an unmodified production invocation without its required host and execution context", () => {
    const result = spawnSync(process.execPath, [preparation], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires Linux x64|requires the ubuntu-24\.04 image|RUNNER_TEMP|unprivileged/);
  });
});
