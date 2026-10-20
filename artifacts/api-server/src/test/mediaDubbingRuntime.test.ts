import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod, realpath, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPiperSpeech } from "../lib/media/dubbing/piper.js";
import { runLocalProcess } from "../lib/media/dubbing/localProcess.js";
import { DubbingError } from "../lib/media/dubbing/contracts.js";

const signal = () => new AbortController().signal;
const code = (name: string) => (error: unknown) => error instanceof DubbingError && error.code === name;
const cwd = process.cwd();

test("unconfigured or missing self-host model stays disabled", async () => {
  await assert.rejects(createPiperSpeech(undefined), code("not_configured"));
  await assert.rejects(createPiperSpeech({ executable: "/missing-piper", executableSha256: "a".repeat(64), modelPath: "/missing-model.onnx", modelSha256: "b".repeat(64), configSha256: "c".repeat(64), language: "en-US", stockVoiceApproved: true, offlineSandboxAttested: true }), code("not_configured"));
});

test("generate CLI refuses absent model without creating any dubbed artifact", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dubbing-cli-disabled-")));
  try {
    const inputPath = join(directory, "input.json");
    const runtimePath = join(directory, "runtime.json");
    await writeFile(inputPath, JSON.stringify({ text: "private synthetic fixture" }));
    await writeFile(runtimePath, "{}");
    const require = createRequire(import.meta.url);
    const cli = fileURLToPath(new URL("../../../../tools/media-dubbing/generate.mts", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", require.resolve("tsx/esm"), cli, "--input", inputPath, "--runtime", runtimePath, "--output-dir", directory], { env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 2);
    assert.deepEqual(JSON.parse(child.stderr), { status: "refused", code: "not_configured" });
    assert.deepEqual((await readdir(directory)).sort(), ["input.json", "runtime.json"]);
    assert.equal(child.stdout, "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local child accepts text only on stdin and inherits no app credentials", async () => {
  process.env.DUBBING_TEST_SECRET = "secret-must-not-propagate";
  try {
    const result = await runLocalProcess({ executable: process.execPath, args: ["-e", 'let text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({text,args:process.argv,secret:process.env.DUBBING_TEST_SECRET})))'], stdin: "invented text", cwd, signal: signal(), timeoutMs: 2000, maxBytes: 4096 });
    const output = JSON.parse(result.toString());
    assert.equal(output.text, "invented text");
    assert.equal(output.secret, undefined);
    assert(!output.args.includes("invented text"));
  } finally { delete process.env.DUBBING_TEST_SECRET; }
});

test("process timeout kills and reaps the actual child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dubbing-process-test-"));
  const marker = join(directory, "pid");
  try {
    await assert.rejects(runLocalProcess({ executable: process.execPath, args: ["-e", 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},50)', marker], stdin: "", cwd, signal: signal(), timeoutMs: 500, maxBytes: 4096 }), code("runtime_timeout"));
    const pid = Number(await readFile(marker, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stdout and stderr output limits kill runaway children without leaking diagnostics", async () => {
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(runLocalProcess({ executable: process.execPath, args: ["-e", `process.${stream}.write("private-text".repeat(100000));setInterval(()=>{},50)`], stdin: "", cwd, signal: signal(), timeoutMs: 2000, maxBytes: 1000 }), code("output_limit"));
  }
});

test("abort cancels an actual running child and refuses pre-aborted admission", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(runLocalProcess({ executable: process.execPath, args: ["-e", "setInterval(()=>{},50)"], stdin: "", cwd, signal: controller.signal, timeoutMs: 2000, maxBytes: 1000 }), code("cancelled"));
    await assert.rejects(runLocalProcess({ executable: process.execPath, args: [], stdin: "", cwd, signal: controller.signal, timeoutMs: 2000, maxBytes: 1000 }), code("cancelled"));
  } finally { clearTimeout(timer); }
});

test("Piper protocol fixture validates pinned files, language and single stock speaker; not neural proof", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dubbing-piper-protocol-")));
  const executable = join(directory, "piper-fixture");
  const modelPath = join(directory, "fixture.onnx");
  const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const script = `#!${process.execPath}\nlet text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>{if(!process.argv.includes("--output-raw")||text.includes("[["))process.exit(2);process.stdout.write(Buffer.alloc(2400,20));});\n`;
  const model = "NOT A REAL NEURAL MODEL";
  const config = JSON.stringify({ num_speakers: 1, language: { code: "en_US" }, audio: { sample_rate: 24000 } });
  try {
    await writeFile(executable, script, { mode: 0o700 }); await chmod(executable, 0o700);
    await writeFile(modelPath, model); await writeFile(`${modelPath}.json`, config);
    const settings = { executable, executableSha256: digest(script), modelPath, modelSha256: digest(model), configSha256: digest(config), language: "en-US", stockVoiceApproved: true, offlineSandboxAttested: true };
    const engine = await createPiperSpeech(settings);
    const output = await engine.synthesize("Invented sentence", signal());
    assert.equal(output.samples.length, 2400);
    assert.equal(output.sampleRate, 24000);
    await assert.rejects(engine.synthesize("[[ phonemes ]]", signal()), code("invalid_input"));
    await assert.rejects(createPiperSpeech({ ...settings, stockVoiceApproved: false }), code("not_configured"));
    await assert.rejects(createPiperSpeech({ ...settings, offlineSandboxAttested: false }), code("not_configured"));
    await assert.rejects(createPiperSpeech({ ...settings, language: "fr-FR" }), code("not_configured"));
    await writeFile(`${modelPath}.json`, JSON.stringify({ num_speakers: 2, language: { code: "en_US" }, audio: { sample_rate: 24000 } }));
    await assert.rejects(engine.synthesize("Changed configuration", signal()), code("integrity_failed"));
    const changed = await readFile(`${modelPath}.json`);
    await assert.rejects(createPiperSpeech({ ...settings, configSha256: digest(changed) }), code("not_configured"));
    await writeFile(modelPath, "altered");
    await assert.rejects(engine.synthesize("Do not synthesize", signal()), code("integrity_failed"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
