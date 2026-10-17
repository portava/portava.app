import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { VISUAL_MODEL_ID, MAX_IMAGE_BYTES, normalizeVector, type ClipEncoder } from "./contracts.js";

export class LocalClipEncoder implements ClipEncoder {
  readonly modelId = VISUAL_MODEL_ID;
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  private async run(request: object, signal: AbortSignal): Promise<number[]> {
    signal.throwIfAborted();
    const python = this.env.MEDIA_VISUAL_PYTHON;
    const worker = this.env.MEDIA_VISUAL_WORKER;
    const model = this.env.MEDIA_VISUAL_MODEL_DIR;
    const lock = this.env.MEDIA_VISUAL_MODEL_LOCK_SHA256;
    if (!python || !worker || !model || !lock || ![python, worker, model].every(isAbsolute) || !/^[a-f0-9]{64}$/.test(lock)) throw new Error("local CLIP runtime not configured");
    return await new Promise((resolve, reject) => {
      const child = spawn(python, ["-I", "-B", worker, "--model-dir", model, "--lock-sha256", lock], {
        shell: false, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", HOME: model, PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", OMP_NUM_THREADS: "1", TOKENIZERS_PARALLELISM: "false" },
      });
      let output = Buffer.alloc(0);
      let failure: Error | null = null;
      const stop = (message: string) => { failure = new Error(message); child.kill("SIGKILL"); };
      const abort = () => stop("visual inference cancelled");
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => stop("visual inference timed out"), 90_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > 32_768) stop("visual inference output exceeded bound");
        else output = Buffer.concat([output, chunk]);
      });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => stop("visual inference input failed"));
      child.once("error", () => { failure = new Error("visual inference executable unavailable"); });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure || signal.aborted || code !== 0) { reject(failure ?? new Error("visual inference failed")); return; }
        try {
          const answer = JSON.parse(output.toString("utf8"));
          if (answer.modelId !== this.modelId) throw new Error("visual inference model mismatch");
          resolve(normalizeVector(answer.vector));
        } catch { reject(new Error("visual inference response invalid")); }
      });
      if (signal.aborted) abort();
      else child.stdin.end(JSON.stringify(request));
    });
  }

  image(bytes: Buffer, signal: AbortSignal): Promise<number[]> {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("invalid visual image size");
    return this.run({ kind: "image", bytes: bytes.toString("base64") }, signal);
  }

  text(text: string, signal: AbortSignal): Promise<number[]> {
    if (!text.trim() || text.length > 512 || /[\x00-\x1f]/.test(text)) throw new Error("invalid visual text size");
    return this.run({ kind: "text", text, language: "en" }, signal);
  }
}
