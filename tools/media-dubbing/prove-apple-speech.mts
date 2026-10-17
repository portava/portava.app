import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DUBBING_DISCLOSURE_VERSION, type SyntheticSpeechEngine } from "../../artifacts/api-server/src/lib/media/dubbing/contracts.js";
import { runLocalProcess } from "../../artifacts/api-server/src/lib/media/dubbing/localProcess.js";
import { renderDubbing } from "../../artifacts/api-server/src/lib/media/dubbing/render.js";
import { decodeWave } from "../../artifacts/api-server/src/lib/media/dubbing/wav.js";

const root = process.argv[2];
if (process.platform !== "darwin" || !root || !isAbsolute(root)) throw new Error("Requires macOS and an existing absolute external output directory");
const directory = await mkdtemp(join(root, "apple-dubbing-proof-"));
await chmod(directory, 0o700);
const controller = new AbortController();
let sequence = 0;
const engine: SyntheticSpeechEngine = {
  id: "apple-say-fixture-only", modelVersion: "system-stock-zarvox", language: "en-US",
  async synthesize(text, signal) {
    const filename = join(directory, `segment-${sequence++}.wav`);
    try {
      await runLocalProcess({ executable: "/usr/bin/say", args: ["-v", "Zarvox", "-r", "180", "-o", filename, "--file-format=WAVE", "--data-format=LEI16@24000", "--channels=1"], stdin: text, cwd: directory, signal, timeoutMs: 30_000, maxBytes: 4096 });
      return decodeWave(await readFile(filename));
    } finally { await rm(filename, { force: true }); }
  },
};
const original = Buffer.from("Synthetic original fixture: must never be overwritten.");
await writeFile(join(directory, "original.bin"), original, { mode: 0o600, flag: "wx" });
const started = performance.now();
const result = await renderDubbing({
  assetId: "00000000-0000-4000-8000-000000000001", ownerId: "00000000-0000-4000-8000-000000000002", requestedBy: "00000000-0000-4000-8000-000000000002",
  sourceVersion: 1, captionRevision: "a".repeat(64), translationRevision: "b".repeat(64), consentRevision: "c".repeat(64),
  targetLanguage: "en-US", optedIn: true, disclosureVersion: DUBBING_DISCLOSURE_VERSION,
  durationMs: 12_000, cues: [{ startMs: 500, endMs: 4500, text: "Hello friend." }, { startMs: 5500, endMs: 10_500, text: "Welcome to the garden." }],
}, engine, { signal: controller.signal, assertCurrent: async () => {} });
const decoded = decodeWave(result.audio);
assert.equal(decoded.sampleRate, 24_000);
assert.equal(decoded.samples.length, 12 * 24_000 * 2);
for (const [start, end] of [[0, 500], [4500, 5500], [10_500, 12_000]]) {
  assert(decoded.samples.subarray(start! * 48, end! * 48).every((value) => value === 0));
}
for (const [start, end] of [[500, 4500], [5500, 10_500]]) {
  assert(decoded.samples.subarray(start! * 48, end! * 48).some((value) => value !== 0));
}
assert.deepEqual(await readFile(join(directory, "original.bin")), original);
assert.equal(result.audio.subarray(0, 4).toString(), "RIFF");
await writeFile(join(directory, "dubbed.wav"), result.audio, { mode: 0o600, flag: "wx" });
const evidence = { status: "passed", runtime: "actual local macOS say/Zarvox, not Piper or translation proof", elapsedMs: Math.round(performance.now() - started), originalSha256: createHash("sha256").update(original).digest("hex"), manifest: result.manifest };
await writeFile(join(directory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ directory, ...evidence }));
