import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import sharp from "sharp";
import { encodeImageVariantsIsolated } from "../lib/media/imageVariants/isolatedEncoder.js";

const built = new URL("../../dist/", import.meta.url);
const execute = promisify(execFile);
before(async () => {
  await execute(process.execPath, ["build.mjs"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), env: { NODE_ENV: "production" }, timeout: 30_000, maxBuffer: 2_000_000,
  });
});

test("production worker standalone guard runs OFF with no credentials or TypeScript loader", async () => {
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("runMediaDerivativeWorker.mjs", built))], {
    env: { NODE_ENV: "production" }, timeout: 15_000, maxBuffer: 100_000,
  });
  assert.ok(stdout.split("\n").some(line => line === '{"state":"disabled","feature":"media_derivative_worker"}'));
  const cleanup = await execute(process.execPath, [fileURLToPath(new URL("runMediaDerivativeCleanup.mjs", built))], {
    env: { NODE_ENV: "production" }, timeout: 15_000, maxBuffer: 100_000,
  });
  assert.ok(cleanup.stdout.split("\n").some(line => line === '{"state":"disabled","feature":"media_derivative_cleanup"}'));
});

test("production child encodes and decodes eight real synthetic variants without source tooling", async () => {
  const input = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#296" } }).png().toBuffer();
  const original = Buffer.from(input);
  const output = await encodeImageVariantsIsolated(input, new AbortController().signal, { entrypoint: new URL("encoderChild.js", built) });
  assert.deepEqual(input, original);
  assert.equal(Object.keys(output.buffers).length, 8);
  for (const [filename, bytes] of Object.entries(output.buffers)) {
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height], [64, 32]);
    assert.equal(metadata.format, filename.endsWith(".avif") ? "heif" : filename.endsWith(".webp") ? "webp" : "jpeg");
    assert.equal(bytes.length, output.manifest.files[filename].bytes);
    assert.ok((await sharp(bytes).raw().toBuffer()).length > 0);
  }
});

test("production assets preserve source bytes and vision resolves inside dist", async () => {
  const assets = [
    ["transcribe.py", "../lib/media/captions/transcribe.py"],
    ["runtime/media-vision/worker.py", "../../../../tools/media-vision/worker.py"],
    ["runtime/media-vision/model-manifest.json", "../../../../tools/media-vision/model-manifest.json"],
    ["runtime/media-visual-index/clip_worker.py", "../../../../tools/media-visual-index/clip_worker.py"],
    ["runtime/translation-runtime.py", "../../scripts/translation-runtime.py"],
  ];
  for (const [target, source] of assets) assert.deepEqual(await readFile(new URL(target, built)), await readFile(new URL(source, import.meta.url)), target);
  const worker = await readFile(new URL("runMediaDerivativeWorker.mjs", built), "utf8");
  assert.ok(worker.includes('./runtime/media-vision/worker.py'));
  assert.equal(worker.includes('../../../../../../tools/media-vision/worker.py'), false);
});
