import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CaptionJobError, createWhisperMediaJobHandler, type WhisperCaptionConfig } from "./whisperCaptionHandler.js";

function integer(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new CaptionJobError("invalid_caption_configuration", false);
  return parsed;
}

export function captionAsrConfig(env: NodeJS.ProcessEnv = process.env): WhisperCaptionConfig | null {
  const enabled = env.MEDIA_CAPTION_ASR_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "false") return null;
  if (enabled !== "true") throw new CaptionJobError("invalid_caption_configuration", false);
  const pythonPath = env.MEDIA_CAPTION_ASR_PYTHON_PATH;
  const ffmpegPath = env.MEDIA_CAPTION_ASR_FFMPEG_PATH;
  const modelPath = env.MEDIA_CAPTION_ASR_MODEL_PATH;
  const modelVersion = env.MEDIA_CAPTION_ASR_MODEL_VERSION;
  const configVersion = env.MEDIA_CAPTION_ASR_CONFIG_VERSION;
  const languages = env.MEDIA_CAPTION_ASR_ALLOWED_LANGUAGES?.split(",").map((language) => language.trim());
  if (!pythonPath || !ffmpegPath || !modelPath || ![pythonPath, ffmpegPath, modelPath].every((path) => isAbsolute(path) && !/[\x00-\x1f]/.test(path))
    || !modelVersion || !/^sha256:[a-f0-9]{64}$/.test(modelVersion)
    || !configVersion || !/^[A-Za-z0-9._:/@+\-]{1,200}$/.test(configVersion)
    || !languages?.length || languages.length > 50 || new Set(languages).size !== languages.length
    || languages.some((language) => !/^[a-z]{2,3}$/.test(language) || language === "und")) throw new CaptionJobError("invalid_caption_configuration", false);
  return { enabled: true, pythonPath, ffmpegPath, modelPath, modelVersion, configVersion, allowedLanguages: languages,
    timeoutMs: integer(env.MEDIA_CAPTION_ASR_TIMEOUT_MS, 600000, 1000, 600000),
    maxDurationMs: integer(env.MEDIA_CAPTION_ASR_MAX_DURATION_MS, 900000, 1, 900000) };
}

function requirePinnedLocalModel(config: WhisperCaptionConfig): void {
  try {
    for (const executable of [config.pythonPath, config.ffmpegPath]) {
      accessSync(executable, constants.X_OK);
      if (!statSync(executable).isFile()) throw new Error();
    }
    if (!statSync(config.modelPath).isDirectory()) throw new Error();
    const descriptor = openSync(join(config.modelPath, "model.bin"), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const source = fstatSync(descriptor);
      const limit = 8 * 1024 * 1024 * 1024;
      if (!source.isFile() || source.size <= 0 || source.size > limit) throw new Error();
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let total = 0;
      for (;;) {
        const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
        if (!bytes) break;
        total += bytes;
        if (total > source.size) throw new Error();
        hash.update(buffer.subarray(0, bytes));
      }
      if (total !== source.size || fstatSync(descriptor).mtimeMs !== source.mtimeMs) throw new Error();
      if (`sha256:${hash.digest("hex")}` !== config.modelVersion) throw new CaptionJobError("local_model_pin_mismatch", false);
    } finally { closeSync(descriptor); }
  } catch (error) {
    if (error instanceof CaptionJobError) throw error;
    throw new CaptionJobError("local_model_or_tools_unavailable", false);
  }
}

export function createConfiguredWhisperMediaJobHandler(sc: SupabaseClient, env: NodeJS.ProcessEnv,
  jobError: (code: string, retryable: boolean) => Error) {
  try {
    const config = captionAsrConfig(env);
    if (!config) return null;
    requirePinnedLocalModel(config);
    return createWhisperMediaJobHandler(sc, config, { jobError });
  } catch (error) {
    if (error instanceof CaptionJobError) throw jobError(error.code, error.retryable);
    throw jobError("invalid_caption_configuration", false);
  }
}
