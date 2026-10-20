import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const file = "src/test/mediaAdaptiveEncoding.real.test.ts";
const names = [
  "real CPU FFmpeg: synthetic source becomes two measured decodable renditions and a bounded preview",
  "real silent 360p source remains silent, creates 180p/360p, and unsupported bytes preserve the original",
];
const imports = 'import assert from "node:assert/strict"; import { test, describe } from "node:test";';
const namedTest = (index: number, body = "assert.equal(1, 1);", options = "{}") =>
  `test(${JSON.stringify(names[index])}, ${options}, async (context) => { ${body} });`;
const healthy = (body = "assert.equal(1, 1);") => `${imports}\n${namedTest(0, body)}\n${namedTest(1)}`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const tables: Record<string, Record<string, string[]>> = {
  ffmpeg: {
    encoders: ["libx264", "aac", "mjpeg", "wrapped_avframe"],
    decoders: ["h264", "aac", "mjpeg", "wrapped_avframe", "pcm_s16le"],
    demuxers: ["mov", "hls", "mpegts", "image2", "mjpeg", "lavfi"],
    muxers: ["mp4", "mpegts", "hls", "null", "image2"],
    filters: ["scale", "setsar", "testsrc2", "sine", "format", "aresample", "aformat"],
    protocols: ["Input:file", "Input:pipe", "Output:file", "Output:pipe"],
  },
  ffprobe: {
    decoders: ["h264", "aac", "mjpeg"],
    demuxers: ["mov", "hls", "mpegts", "image2", "mjpeg"],
    protocols: ["Input:file", "Input:pipe"],
  },
};

function table(category: string, entries: string[]) {
  if (category === "protocols") return ["Input", "Output"].map((direction) =>
    `${direction}:\n${entries.filter((name) => name.startsWith(`${direction}:`)).map((name) => `  ${name.split(":")[1]}`).join("\n")}`).join("\n");
  return entries.map((name) => category === "encoders" || category === "decoders" ? ` V....D ${name} synthetic control`
    : category === "filters" ? ` .. ${name} V->V synthetic control`
      : category === "muxers" ? `  E  ${name} synthetic control`
        : name === "lavfi" ? " D d lavfi synthetic device" : ` D   ${name === "mov" ? "mov,mp4,m4a,3gp,3g2,mj2" : name} synthetic control`).join("\n");
}

interface FixtureOptions {
  source?: string;
  argumentsList?: string[];
  environment?: Record<string, string>;
  entry?: "canonical" | "directory-alias" | "file-alias";
  tool?: "ffmpeg" | "ffprobe";
  pathState?: "missing" | "relative" | "nonexistent" | "directory" | "nonexecutable" | "alias" | "same";
  version?: string;
  wrongIdentity?: boolean;
  missingCapability?: [string, string];
  descriptionSpoof?: boolean;
  wrongDirection?: boolean;
  probeFailure?: "nonzero" | "hang" | "output";
  shortWatchdog?: boolean;
  fileState?: "missing" | "outside" | "directory";
  missingLoader?: boolean;
  malformedReporter?: boolean;
  environmentAssertions?: boolean;
  descendant?: "failure" | "exit" | "watchdog";
}

async function invoke(options: FixtureOptions = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "media encoding runner-")));
  const directory = join(temporary, "checkout");
  const pidFile = join(temporary, "owned-child.pid");
  try {
    await mkdir(join(directory, "scripts"), { recursive: true });
    await mkdir(join(directory, "src/test"), { recursive: true });
    await mkdir(join(directory, "node_modules"));
    await mkdir(join(temporary, "tools"));
    let runner = await readFile(join(apiRoot, "scripts/run-media-encoding-tests.mjs"), "utf8");
    if (options.shortWatchdog || options.descendant === "watchdog") {
      assert.ok(runner.includes("const runTimeoutMs = 390_000;"));
      // 6s, not 2s: the synthetic tool probes share this whole-run deadline, and under load they consumed a 2s budget
      // themselves, so the run failed as "Tool probe timeout" before the stuck encoding stage it is meant to bound.
      runner = runner.replace("const runTimeoutMs = 390_000;", "const runTimeoutMs = 6_000;");
    }
    if (options.probeFailure === "hang") {
      assert.ok(runner.includes("const probeTimeoutMs = 5_000;"));
      runner = runner.replace("const probeTimeoutMs = 5_000;", "const probeTimeoutMs = 100;");
    }
    await writeFile(join(directory, "scripts/run-media-encoding-tests.mjs"), runner);
    await copyFile(join(apiRoot, "scripts/run-memory-sql-tests.mjs"), join(directory, "scripts/run-memory-sql-tests.mjs"));
    if (options.malformedReporter) await writeFile(join(directory, "scripts/run-memory-sql-tests.mjs"), 'export default async function* () { yield "not-json\\n"; }');
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    if (!options.missingLoader) await symlink(await realpath(join(apiRoot, "node_modules/tsx")), join(directory, "node_modules/tsx"), "dir");
    const toolPaths: Record<string, string | undefined> = {};
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const selected = tool === (options.tool ?? "ffmpeg");
      const outputs: Record<string, string> = { "-version": `${selected && options.wrongIdentity ? "unrelated" : tool} version ${selected ? options.version ?? "8.0" : "8.0"} synthetic control` };
      for (const [category, entries] of Object.entries(tables[tool]!)) {
        const omitted = selected && options.missingCapability?.[0] === category ? options.missingCapability[1] : undefined;
        const retained = entries.filter((name) => name !== omitted);
        if (selected && options.wrongDirection && category === "protocols") outputs[`-${category}`] = table(category, ["Output:file", "Output:pipe"]);
        else outputs[`-${category}`] = table(category, retained) + (omitted && options.descriptionSpoof
          ? `\n V....D not_${omitted} description mentions ${omitted}\n ${omitted}\n` : "");
      }
      const forbidden = ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "NODE_TEST_NAME_PATTERN", "NODE_TEST_SKIP_PATTERN",
        "TEST_NAME_PATTERN", "NODE_TEST_CONTEXT", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "LOCAL_DB_URL",
        "HTTP_PROXY", "HTTPS_PROXY", "ADAPTIVE_EVIDENCE_DIR", "CAPTION_PGLITE_MODULE", "PGLITE_ROOT", "MEDIA_ADAPTIVE_ENABLED",
        "FFMPEG_PATH", "FFPROBE_PATH", "MEDIA_REQUIRE_ENCODING_TESTS"];
      const toolPath = join(temporary, "tools", tool);
      const nodeSource = `#!${process.execPath}\n
        const assert = require("node:assert/strict");
        const { appendFileSync } = require("node:fs");
        const args = process.argv.slice(2);
        appendFileSync(${JSON.stringify(join(temporary, "probes.jsonl"))}, JSON.stringify({ tool: ${JSON.stringify(tool)}, args }) + "\\n");
        assert.ok(args.length === 1 && args[0] === "-version" || args.length === 2 && args[0] === "-hide_banner");
        ${options.environmentAssertions ? `
          for (const key of ${JSON.stringify(forbidden)}) assert.equal(process.env[key], undefined, key);
          assert.equal(process.env.NODE_ENV, "test"); assert.equal(process.env.LC_ALL, "C");
          assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:9");
          assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, "dummy");
        ` : ""}
        ${selected && options.probeFailure === "nonzero" ? "process.exit(7);" : ""}
        ${selected && options.probeFailure === "hang" ? "setInterval(() => {}, 100);" : selected && options.probeFailure === "output"
          ? 'process.stdout.write("x".repeat(4_100_000));' : `const output = ${JSON.stringify(outputs)}[args.at(-1)]; assert.notEqual(output, undefined); console.log(output);`}
      `;
      const shellSource = [
        "#!/bin/sh",
        `printf '{"tool":"${tool}","args":["%s","%s"]}\\n' "$1" "\${2-}" >> ${shellQuote(join(temporary, "probes.jsonl"))}`,
        selected && options.probeFailure === "nonzero" ? "exit 7" : selected && options.probeFailure === "hang"
          ? "while :; do /bin/sleep 1; done" : [
            'case "$*" in',
            ...Object.entries(outputs).map(([argument, output]) => `${shellQuote(argument === "-version" ? argument : `-hide_banner ${argument}`)}) printf '%s\\n' ${shellQuote(output)} ;;`),
            "*) exit 9 ;;", "esac",
          ].join("\n"),
      ].join("\n");
      await writeFile(toolPath, options.environmentAssertions || selected && options.probeFailure === "output" ? nodeSource : shellSource, { mode: 0o755 });
      let path: string | undefined = toolPath;
      if (selected) {
        if (options.pathState === "missing") path = undefined;
        if (options.pathState === "relative") path = tool;
        if (options.pathState === "nonexistent") path = join(temporary, "absent");
        if (options.pathState === "directory") path = join(temporary, "tools");
        if (options.pathState === "nonexecutable") await chmod(toolPath, 0o644);
        if (options.pathState === "alias") {
          path = join(temporary, `${tool}-alias`);
          await symlink(toolPath, path);
        }
      }
      toolPaths[tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] = path;
    }
    if (options.pathState === "same") toolPaths.FFPROBE_PATH = toolPaths.FFMPEG_PATH;
    let source = options.source ?? healthy();
    if (options.environmentAssertions) source = healthy(`
      assert.equal(process.env.MEDIA_REQUIRE_ENCODING_TESTS, "true");
      assert.equal(process.env.FFMPEG_PATH, ${JSON.stringify(join(temporary, "tools/ffmpeg"))});
      assert.equal(process.env.FFPROBE_PATH, ${JSON.stringify(join(temporary, "tools/ffprobe"))});
      assert.equal(process.env.NODE_ENV, "test"); assert.equal(process.env.TSX_DISABLE_CACHE, "1");
      for (const key of ["SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL"]) assert.equal(process.env[key], "http://127.0.0.1:9");
      for (const key of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_ANON_KEY"]) assert.equal(process.env[key], "dummy");
      for (const key of ${JSON.stringify(Object.keys(options.environment ?? {}).filter((key) => !["NODE_ENV", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_ANON_KEY", "MEDIA_REQUIRE_ENCODING_TESTS", "FFMPEG_PATH", "FFPROBE_PATH"].includes(key)))}) assert.equal(process.env[key], undefined, key);
    `);
    if (options.descendant) {
      source = `${imports} import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; ${namedTest(0, `
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 100);"], { detached: true, stdio: "ignore" });
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();
        ${options.descendant === "exit" ? "process.exit(0);" : options.descendant === "failure" ? 'assert.fail("intentional with live tool");' : "setInterval(() => {}, 100); await new Promise(() => {});"}
      `)}${namedTest(1)}`;
    }
    if (options.fileState === "directory") await mkdir(join(directory, file));
    else if (options.fileState === "outside") {
      await writeFile(join(temporary, "outside.test.ts"), source);
      await symlink(join(temporary, "outside.test.ts"), join(directory, file));
    } else if (options.fileState !== "missing") await writeFile(join(directory, file), source);
    let entry = join(directory, "scripts/run-media-encoding-tests.mjs");
    if (options.entry === "canonical") entry = await realpath(entry);
    if (options.entry === "directory-alias") {
      await symlink(directory, join(temporary, "alias"), "dir");
      entry = join(temporary, "alias/scripts/run-media-encoding-tests.mjs");
    }
    if (options.entry === "file-alias") {
      await symlink(entry, join(temporary, "runner-alias.mjs"));
      entry = join(temporary, "runner-alias.mjs");
    }
    const result = spawnSync(process.execPath, [entry, ...(options.argumentsList ?? [file])], {
      cwd: temporary, encoding: "utf8", timeout: 12_000, maxBuffer: 5_000_000,
      env: {
        PATH: `${join(temporary, "tools")}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        ...options.environment, ...toolPaths,
        NODE_V8_COVERAGE: options.environment?.NODE_V8_COVERAGE ? join(temporary, "coverage") : undefined,
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, "runner must terminate without the fixture watchdog");
    if (options.descendant) {
      const pid = Number(await readFile(pidFile, "utf8"));
      let stopped = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") { stopped = true; break; }
          throw error;
        }
        await new Promise((finish) => setTimeout(finish, 25));
      }
      assert.ok(stopped, "the real detached tool process must not outlive runner failure");
    }
    const probes = await readFile(join(temporary, "probes.jsonl"), "utf8").catch(() => "");
    return { status: result.status, output: result.stdout + result.stderr, probes: probes.trim().split("\n").filter(Boolean) };
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertExecuted(result: Awaited<ReturnType<typeof invoke>>) {
  assert.equal(result.status, 0, result.output);
  assert.equal(result.probes.length, 11, "both versions and all nine capability tables must execute");
  for (const name of names) assert.ok(result.output.includes(`media-encoding: executed=1: ${name}`), result.output);
  assert.match(result.output, /media-encoding: PASS: 2 named tests;/);
}

function assertRejected(result: Awaited<ReturnType<typeof invoke>>, expected: RegExp) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, expected);
  assert.doesNotMatch(result.output, /media-encoding: PASS:/);
}

describe("Media encoding runner fail-closed executable controls", () => {
  for (const entry of ["canonical", "directory-alias", "file-alias"] as const) {
    it(`executes both exact names through the ${entry} entry`, async () => { assertExecuted(await invoke({ entry })); });
    it(`cannot bypass missing tools through the ${entry} entry`, async () => {
      assertRejected(await invoke({ entry, pathState: "missing" }), /explicit absolute executable path/);
    });
  }
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    it(`accepts and canonicalizes an absolute ${tool} symlink`, async () => { assertExecuted(await invoke({ tool, pathState: "alias" })); });
    for (const [pathState, expected] of [
      ["missing", /explicit absolute executable path/], ["relative", /explicit absolute executable path/],
      ["nonexistent", /ENOENT/], ["directory", /regular file/], ["nonexecutable", /EACCES/],
    ] as const) {
      it(`rejects ${pathState} ${tool} even with an available PATH fallback`, async () => {
        const result = await invoke({ tool, pathState });
        assertRejected(result, expected);
        assert.equal(result.probes.length, 0);
      });
    }
    for (const version of ["7.1", "8.0.1", "8.0-dev", "80.0"]) {
      it(`rejects ${tool} version ${version}`, async () => { assertRejected(await invoke({ tool, version }), /exactly version 8.0/); });
    }
    it(`rejects the wrong ${tool} executable identity`, async () => { assertRejected(await invoke({ tool, wrongIdentity: true }), /exactly version 8.0/); });
    for (const [category, entries] of Object.entries(tables[tool]!)) {
      for (const capability of entries) {
        it(`requires ${tool} ${category} ${capability}`, async () => {
          assertRejected(await invoke({ tool, missingCapability: [category, capability] }), /missing required/);
        });
      }
    }
    for (const probeFailure of ["nonzero", "hang", "output"] as const) {
      it(`rejects and bounds a ${probeFailure} ${tool} probe`, async () => {
        assertRejected(await invoke({ tool, probeFailure }), probeFailure === "nonzero" ? /Process exited 7/ : probeFailure === "hang" ? /timeout exceeded/ : /output exceeded/);
      });
    }
  }
  it("rejects one executable supplied as both tools", async () => { assertRejected(await invoke({ pathState: "same" }), /distinct executables/); });
  it("does not confuse description/substrings with an encoder capability", async () => {
    assertRejected(await invoke({ missingCapability: ["encoders", "libx264"], descriptionSpoof: true }), /missing required encoders: libx264/);
  });
  it("does not accept output protocols in place of input protocols", async () => {
    assertRejected(await invoke({ tool: "ffprobe", wrongDirection: true }), /missing required protocols/);
  });
  it("cleans both tool probes and tests while forcing real proof and preserving canonical paths", async () => {
    assertExecuted(await invoke({ environmentAssertions: true, pathState: "alias", environment: {
      NODE_ENV: "production", NODE_OPTIONS: "--no-warnings", NODE_PATH: "/synthetic/unused", NODE_V8_COVERAGE: "/synthetic/unused",
      NODE_TEST_NAME_PATTERN: "never", NODE_TEST_SKIP_PATTERN: ".*", TEST_NAME_PATTERN: "never", NODE_TEST_CONTEXT: "synthetic-inherited",
      OPENAI_API_KEY: "synthetic", AWS_SECRET_ACCESS_KEY: "synthetic", DATABASE_URL: "postgresql://synthetic.invalid/never",
      LOCAL_DB_URL: "postgresql://synthetic.invalid/never", HTTP_PROXY: "http://synthetic.invalid", HTTPS_PROXY: "http://synthetic.invalid",
      ADAPTIVE_EVIDENCE_DIR: "/synthetic/unused", CAPTION_PGLITE_MODULE: "/synthetic/unused", PGLITE_ROOT: "/synthetic/unused",
      MEDIA_ADAPTIVE_ENABLED: "true", MEDIA_REQUIRE_ENCODING_TESTS: "false", SUPABASE_URL: "https://synthetic.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic", SUPABASE_ANON_KEY: "synthetic", EXPO_PUBLIC_SUPABASE_URL: "https://synthetic.invalid",
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "synthetic",
    } }));
  });
  for (const argumentsList of [[], [file, file], ["src/test/unrelated.test.ts"], [`../${file}`],
    ["--test-name-pattern=never", file], ["--test-skip-pattern=.*", file], ["--test-only", file]]) {
    it(`rejects incomplete/filtered/unrelated CLI ${JSON.stringify(argumentsList)}`, async () => {
      const result = await invoke({ argumentsList }); assertRejected(result, /Pass exactly:/); assert.equal(result.probes.length, 0);
    });
  }
  for (const fileState of ["missing", "directory", "outside"] as const) {
    it(`rejects a ${fileState} required file`, async () => {
      assertRejected(await invoke({ fileState }), fileState === "missing" ? /ENOENT/ : /regular file inside the API root/);
    });
  }
  it("rejects an absent TSX loader before tool probes", async () => {
    const result = await invoke({ missingLoader: true }); assertRejected(result, /tsx/); assert.equal(result.probes.length, 0);
  });
  const controls: Array<[string, (index: number) => string, RegExp]> = [
    ["skip", (index) => namedTest(index, "", "{ skip: true }"), /Skipped:/],
    ["todo", (index) => namedTest(index, "", "{ todo: true }"), /Todo:/],
    ["failing todo", (index) => namedTest(index, 'assert.fail("intentional");', "{ todo: true }"), /Todo:/],
    ["failure", (index) => namedTest(index, 'assert.fail("intentional");'), /Failed:/],
    ["cancellation", (index) => namedTest(index, "", "{ signal: AbortSignal.abort() }"), /Failed:/],
    ["test timeout", (index) => namedTest(index, 'const timer = setInterval(() => {}, 100); context.signal.addEventListener("abort", () => clearInterval(timer), { once: true }); await new Promise(() => {});', "{ timeout: 25 }"), /Failed:/],
    ["suite impersonation", (index) => `describe(${JSON.stringify(names[index])}, () => {});`, /Unexpected named-test evidence/],
    ["nested impersonation", (index) => `describe("unrelated", () => { ${namedTest(index)} });`, /Unexpected named-test evidence/],
    ["wrong name", () => 'test("unrelated", () => {});', /Unexpected named-test evidence/],
    ["duplicate name", (index) => namedTest(index) + namedTest(index), /received 2/],
    ["missing expected test", () => "", /received 0/],
  ];
  for (const index of [0, 1]) {
    for (const [label, source, expected] of controls) {
      it(`rejects ${label} for named test ${index + 1}`, async () => {
        assertRejected(await invoke({ source: `${imports}${index === 0 ? source(index) + namedTest(1) : namedTest(0) + source(index)}` }), expected);
      });
    }
  }
  for (const source of ["", "process.exit(0);", `${healthy()}process.exitCode = 1;`]) {
    it(`rejects empty/early/nonzero execution ${JSON.stringify(source.slice(-25))}`, async () => {
      assertRejected(await invoke({ source }), /received 0|Process exited 1|Unexpected named-test evidence/);
    });
  }
  it("ignores authentic-looking stdout/stderr events and TAP without actual test execution", async () => {
    assertRejected(await invoke({ source: `import { fileURLToPath } from "node:url";
      for (const name of ${JSON.stringify(names)}) for (const type of ["test:start", "test:pass"]) {
        const line = JSON.stringify({ type, data: { file: fileURLToPath(import.meta.url), name, nesting: 0, details: { type: "test" } } });
        console.log(line); console.error(line);
      }
      console.log(JSON.stringify({ type: "test:summary", data: { success: true, counts: { tests: 2, passed: 2, suites: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } }));
      console.log("ok 1 - encoding\\n# pass 2\\n# skipped 0");
    ` }), /received 0|Unexpected named-test evidence/);
  });
  it("rejects a corrupt reporter stream", async () => { assertRejected(await invoke({ malformedReporter: true }), /Invalid test evidence/); });
  for (const stream of ["stdout", "stderr"]) {
    it(`bounds raw test ${stream} before it can be discarded`, async () => {
      assertRejected(await invoke({ source: healthy(`process.${stream}.write("x".repeat(4_100_000));`) }), /output exceeded/);
    });
  }
  it("bounds combined stdout and stderr, not only each stream separately", async () => {
    assertRejected(await invoke({ source: healthy('process.stdout.write("x".repeat(2_100_000)); process.stderr.write("x".repeat(2_100_000));') }), /output exceeded/);
  });
  for (const types of [["test:stdout"], ["test:stderr"], ["test:stdout", "test:stderr"]]) {
    it(`bounds native output events before reporter filtering: ${types.join("+")}`, async () => {
      const { default: reporter } = await import(pathToFileURL(join(apiRoot, "scripts/run-media-encoding-tests.mjs")).href);
      async function* events() {
        for (const type of types) yield { type, data: { message: "é".repeat(Math.floor(2_000_000 / types.length) + 1) } };
      }
      await assert.rejects(async () => { for await (const line of reporter(events())) assert.fail(String(line)); }, /Reported test output exceeded 4000000 bytes before filtering/);
    });
  }
  it("bounds an otherwise stuck test process", async () => {
    assertRejected(await invoke({ source: healthy("setInterval(() => {}, 100); await new Promise(() => {});"), shortWatchdog: true }), /Encoding run timeout exceeded/);
  });
  for (const descendant of ["failure", "exit", "watchdog"] as const) {
    it(`terminates an actual detached child on ${descendant}`, async () => {
      assertRejected(await invoke({ descendant }), descendant === "failure" ? /Failed:/ : descendant === "exit"
        ? /live tool children/ : /Encoding run timeout exceeded/);
    });
  }
});
