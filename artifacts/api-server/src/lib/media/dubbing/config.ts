import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { DubbingError, languageSchema, type SyntheticSpeechDescriptor } from "./contracts.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const localPath = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value));
const runtimeSchema = z.object({
  executable: localPath, executableSha256: hashSchema,
  modelPath: localPath, modelSha256: hashSchema, configSha256: hashSchema,
  language: languageSchema,
  stockVoiceApproved: z.literal(true),
  offlineSandboxAttested: z.literal(true),
}).strict();

export type PiperRuntimeConfig = Readonly<z.infer<typeof runtimeSchema>>;
export type DubbingEnvironment = Readonly<Record<string, string | undefined>>;
export interface DubbingConfiguration {
  readonly status: "configured" | "missing_bucket" | "invalid_bucket" | "missing_runtime" | "invalid_runtime";
  readonly bucketName?: string;
  readonly runtime?: PiperRuntimeConfig;
  readonly descriptor?: SyntheticSpeechDescriptor;
}

export function validatePiperRuntimeConfig(config: unknown): PiperRuntimeConfig {
  const parsed = runtimeSchema.safeParse(config);
  if (!parsed.success) throw new DubbingError("not_configured");
  return Object.freeze(parsed.data);
}

export function describePiperRuntime(config: unknown): SyntheticSpeechDescriptor {
  const settings = validatePiperRuntimeConfig(config);
  return Object.freeze({ id: "piper-local", modelVersion: `piper-${createHash("sha256").update(JSON.stringify(settings)).digest("hex")}`, language: settings.language });
}

export function parseDubbingEnvironment(env: DubbingEnvironment = process.env): DubbingConfiguration {
  const bucketName = env.MEDIA_DUBBING_STORAGE_BUCKET;
  if (!bucketName) return Object.freeze({ status: "missing_bucket" });
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(bucketName) || bucketName === "post-media") return Object.freeze({ status: "invalid_bucket" });
  const encoded = env.MEDIA_DUBBING_PIPER_CONFIG;
  if (!encoded) return Object.freeze({ status: "missing_runtime", bucketName });
  try {
    if (Buffer.byteLength(encoded) > 8192) throw new DubbingError("not_configured");
    const runtime = validatePiperRuntimeConfig(JSON.parse(encoded));
    return Object.freeze({ status: "configured", bucketName, runtime, descriptor: describePiperRuntime(runtime) });
  } catch { return Object.freeze({ status: "invalid_runtime", bucketName }); }
}
