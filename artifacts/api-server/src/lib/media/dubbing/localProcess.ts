import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { DubbingError, checkCancelled } from "./contracts.js";

export async function runLocalProcess(input: {
  executable: string; args: string[]; stdin: string; cwd: string; signal: AbortSignal;
  timeoutMs: number; maxBytes: number;
}): Promise<Buffer> {
  checkCancelled(input.signal);
  if (!isAbsolute(input.executable) || !isAbsolute(input.cwd) || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000 || !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 30_000_000) throw new DubbingError("invalid_input");
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnosticBytes = 0;
    let failure: DubbingError | undefined;
    const stop = (error: DubbingError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(new DubbingError("cancelled"));
    const timer = setTimeout(() => stop(new DubbingError("runtime_timeout")), input.timeoutMs);
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > input.maxBytes) stop(new DubbingError("output_limit"));
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 65_536) stop(new DubbingError("output_limit"));
    });
    child.on("error", () => { failure ??= new DubbingError("runtime_failed"); });
    child.stdin.on("error", () => { failure ??= new DubbingError("runtime_failed"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
      if (failure || code !== 0) {
        for (const chunk of chunks) chunk.fill(0);
        reject(failure ?? new DubbingError("runtime_failed"));
      } else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input.stdin);
  });
}
