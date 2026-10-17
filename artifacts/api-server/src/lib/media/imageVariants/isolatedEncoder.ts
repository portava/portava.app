import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { IMAGE_VARIANTS_LIMITS, validManifest, type EncodedImageVariants } from "./contracts.js";

export async function encodeImageVariantsIsolated(input: Buffer, signal: AbortSignal, options: { entrypoint?: URL; timeoutMs?: number } = {}): Promise<EncodedImageVariants> {
  signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? IMAGE_VARIANTS_LIMITS.encodeMs;
  if (!input.length || input.length > IMAGE_VARIANTS_LIMITS.inputBytes || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > IMAGE_VARIANTS_LIMITS.encodeMs) throw new Error("invalid image encoder bounds");
  const entrypoint = options.entrypoint ?? new URL(import.meta.url.endsWith(".ts") ? "./encoderChild.ts" : "./encoderChild.js", import.meta.url);
  if (entrypoint.protocol !== "file:") throw new Error("local encoder required");
  const executable = fileURLToPath(entrypoint);
  const child = spawn(process.execPath, [...(executable.endsWith(".ts") ? ["--import", "tsx/esm"] : []), executable], {
    stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "production", VIPS_CONCURRENCY: "1", UV_THREADPOOL_SIZE: "1" },
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  const kill = () => { failed = true; child.kill("SIGKILL"); };
  const timer = setTimeout(kill, timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > Math.ceil(IMAGE_VARIANTS_LIMITS.outputBytes * 4 / 3) + 32_768) kill();
    else chunks.push(chunk);
  });
  child.stderr.on("data", () => {});
  child.stdin.on("error", kill);
  try {
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", () => { failed = true; });
      child.once("close", code => code === 0 && !failed ? resolve() : reject(new Error("isolated image encoding failed or cancelled")));
    });
    child.stdin.end(input);
    await closed;
    signal.throwIfAborted();
    const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const manifest: unknown = decoded.manifest;
    if (!validManifest(manifest) || !decoded.buffers || Object.keys(decoded.buffers).length !== IMAGE_VARIANTS_LIMITS.files) throw new Error("invalid encoder output");
    const buffers: Record<string, Buffer> = {};
    for (const [filename, file] of Object.entries(manifest.files)) {
      if (typeof decoded.buffers[filename] !== "string") throw new Error("missing encoded variant");
      const buffer = Buffer.from(decoded.buffers[filename], "base64");
      if (buffer.length !== file.bytes || createHash("sha256").update(buffer).digest("hex") !== file.sha256) throw new Error("encoded image integrity mismatch");
      buffers[filename] = buffer;
    }
    return { manifest, buffers };
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", kill);
    for (const chunk of chunks) chunk.fill(0);
  }
}
