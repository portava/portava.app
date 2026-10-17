import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_UNDERSTANDING_MODEL, IMAGE_UNDERSTANDING_REVISION, IMAGE_UNDERSTANDING_TAXONOMY, IMAGE_UNDERSTANDING_MAX_OUTPUT_BYTES, imageUnderstandingRecognitionSchema, type ImageUnderstandingRecognition } from "./imageUnderstandingContract.js";

export interface ImageUnderstandingRunner {
  infer(bytes: Buffer, signal: AbortSignal): Promise<ImageUnderstandingRecognition>;
  close(): void;
}

export function createLocalImageUnderstandingRunner(env: NodeJS.ProcessEnv = process.env): ImageUnderstandingRunner {
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending: { resolve(value: ImageUnderstandingRecognition): void; reject(error: Error): void; cleanup(): void } | undefined;
  let output = "";
  const close = () => {
    const running = child; child = undefined;
    running?.kill("SIGKILL");
    if (pending) { const task = pending; pending = undefined; task.cleanup(); task.reject(new Error("vision_inference_stopped")); }
    output = "";
  };
  const start = () => {
    const python = env.MEDIA_VISION_PYTHON;
    const modelDir = env.MEDIA_VISION_MODEL_DIR;
    if (!python || !modelDir || !isAbsolute(python) || !isAbsolute(modelDir)) throw new Error("vision_runtime_not_configured");
    const process = spawn(python, ["-I", "-B", fileURLToPath(new URL("../../../../../../tools/media-vision/worker.py", import.meta.url)), "--model-dir", modelDir], {
      shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false", OMP_NUM_THREADS: "2" },
    });
    child = process;
    process.stderr.on("data", () => {});
    process.stdin.on("error", () => { if (child === process) close(); });
    process.on("error", () => { if (child === process) close(); });
    process.on("exit", () => { if (child === process) close(); });
    process.stdout.on("data", chunk => {
      if (child !== process) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 16_384) { close(); return; }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      const task = pending;
      if (!task || output.trim()) { close(); return; }
      try {
        const response = JSON.parse(line);
        if (response.ok !== true || Object.keys(response).some(key => key !== "ok" && key !== "value")) throw new Error("vision_inference_refused");
        const value = imageUnderstandingRecognitionSchema.parse(response.value);
        pending = undefined; task.cleanup(); task.resolve(value);
      } catch {
        close();
      }
    });
  };
  return {
    close,
    async infer(bytes, signal) {
      signal.throwIfAborted();
      if (pending || bytes.length === 0 || bytes.length > IMAGE_UNDERSTANDING_MAX_OUTPUT_BYTES || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error("vision_inference_refused");
      if (!child) start();
      return new Promise((resolve, reject) => {
        const cancel = () => close();
        pending = { resolve, reject, cleanup: () => signal.removeEventListener("abort", cancel) };
        signal.addEventListener("abort", cancel, { once: true });
        const message = { protocol: "portava-vision-v1", modelId: IMAGE_UNDERSTANDING_MODEL, modelRevision: IMAGE_UNDERSTANDING_REVISION, taxonomyVersion: IMAGE_UNDERSTANDING_TAXONOMY, imageBase64: bytes.toString("base64") };
        child!.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) close(); });
      });
    },
  };
}
