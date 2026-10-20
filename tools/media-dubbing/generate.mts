import { readFile, mkdtemp, writeFile, rm, stat, chmod } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createPiperSpeech } from "../../artifacts/api-server/src/lib/media/dubbing/piper.js";
import { DubbingError } from "../../artifacts/api-server/src/lib/media/dubbing/contracts.js";
import { renderDubbing } from "../../artifacts/api-server/src/lib/media/dubbing/render.js";

export async function generateLocalDubbing(args: string[]): Promise<void> {
  if (args.length !== 6 || args[0] !== "--input" || args[2] !== "--runtime" || args[4] !== "--output-dir" || !args.filter((_, index) => index % 2 === 1).every(isAbsolute)) throw new DubbingError("invalid_input");
  const [inputPath, configPath, outputRoot] = [args[1]!, args[3]!, args[5]!];
  for (const filename of [inputPath, configPath]) {
    const info = await stat(filename);
    if (!info.isFile() || info.size > 128 * 1024) throw new DubbingError("invalid_input");
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const engine = await createPiperSpeech(JSON.parse(await readFile(configPath, "utf8")));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 300_000);
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let directory: string | undefined;
  try {
    const result = await renderDubbing(input, engine, { signal: controller.signal, assertCurrent: async () => {} });
    directory = await mkdtemp(join(outputRoot, "dubbing-"));
    await chmod(directory, 0o700);
    await writeFile(join(directory, "dubbed.wav"), result.audio, { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ directory, bytes: result.audio.length, durationMs: result.manifest.durationMs, engine: engine.id, publication: "none-local-artifact-only" }));
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateLocalDubbing(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ status: "refused", code: error instanceof DubbingError ? error.code : "invalid_input" }));
    process.exitCode = 2;
  });
}
