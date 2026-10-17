import sharp from "sharp";
import { encodeImageVariants } from "./encoder.js";
import { IMAGE_VARIANTS_LIMITS } from "./contracts.js";

sharp.concurrency(1);
sharp.cache(false);
const chunks: Buffer[] = [];
let size = 0;
try {
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > IMAGE_VARIANTS_LIMITS.inputBytes) throw new Error("input budget exceeded");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  try {
    const output = await encodeImageVariants(input);
    process.stdout.write(JSON.stringify({ manifest: output.manifest,
      buffers: Object.fromEntries(Object.entries(output.buffers).map(([filename, bytes]) => [filename, bytes.toString("base64")])) }));
    for (const bytes of Object.values(output.buffers)) bytes.fill(0);
  } finally { input.fill(0); }
} catch {
  process.stderr.write("image_encode_failed\n");
  process.exitCode = 1;
}
