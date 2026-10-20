import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DUBBING_LIMITS, DubbingError, checkCancelled, validateSpeechText, type SyntheticSpeechEngine } from "./contracts.js";
import { runLocalProcess } from "./localProcess.js";
import { describePiperRuntime, validatePiperRuntimeConfig } from "./config.js";

export type { PiperRuntimeConfig } from "./config.js";

async function verifyFile(filename: string, expectedHash: string, maxBytes: number): Promise<void> {
  if (!isAbsolute(filename)) throw new DubbingError("not_configured");
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes || await realpath(filename) !== filename) throw new DubbingError("integrity_failed");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest("hex") !== expectedHash) throw new DubbingError("integrity_failed");
}

export async function createPiperSpeech(config: unknown): Promise<SyntheticSpeechEngine> {
  const settings = validatePiperRuntimeConfig(config);
  const configPath = `${settings.modelPath}.json`;
  const verify = async () => {
    try {
      await verifyFile(settings.executable, settings.executableSha256, 32 * 1024 * 1024);
      await access(settings.executable, constants.X_OK);
      await verifyFile(settings.modelPath, settings.modelSha256, 256 * 1024 * 1024);
      await verifyFile(configPath, settings.configSha256, 1024 * 1024);
    } catch (error) {
      if (error instanceof DubbingError) throw error;
      throw new DubbingError("not_configured");
    }
  };
  await verify();
  let model;
  try { model = JSON.parse(await readFile(configPath, "utf8")); } catch { throw new DubbingError("not_configured"); }
  const rate = model?.audio?.sample_rate;
  const language = model?.language?.code;
  if (model?.num_speakers !== 1 || typeof language !== "string" || language.replaceAll("_", "-") !== settings.language || !Number.isInteger(rate) || rate < 8_000 || rate > 48_000) throw new DubbingError("not_configured");
  const descriptor = describePiperRuntime(settings);
  let busy = false;
  return Object.freeze({
    ...descriptor,
    async synthesize(text: string, signal: AbortSignal) {
      checkCancelled(signal);
      const safeText = validateSpeechText(text);
      if (busy) throw new DubbingError("runtime_busy");
      busy = true;
      try {
        await verify();
        checkCancelled(signal);
        const samples = await runLocalProcess({
          executable: settings.executable,
          args: ["--model", settings.modelPath, "--output-raw", "--length-scale", "1", "--sentence-silence", "0"],
          stdin: `${safeText}\n`, cwd: dirname(settings.modelPath), signal,
          timeoutMs: 60_000, maxBytes: rate * 2 * DUBBING_LIMITS.segmentMs / 1000,
        });
        checkCancelled(signal);
        return { sampleRate: rate, samples };
      } finally { busy = false; }
    },
  });
}
