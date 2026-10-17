import { readFile, writeFile, mkdir, cp, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const api = join(checkout, "artifacts/api-server");
const require = createRequire(join(api, "package.json"));
const loader = require.resolve("tsx/esm");
const [outputRoot, pglite, queueMigration] = process.argv.slice(2);
if (!outputRoot || !pglite || !queueMigration) throw new Error("Expected new external output directory, installed PGlite entry and parent 3980 path");
assert(!resolve(outputRoot).startsWith(resolve(checkout)));
await mkdir(outputRoot, { recursive: false });
const cases = [
  { name: "implicit-consent", file: "src/lib/media/dubbing/contracts.ts", before: "optedIn: z.literal(true)", after: "optedIn: z.boolean().default(true)", expected: "refuses consent omitted before synthesis" },
  { name: "clip-overflow", file: "src/lib/media/dubbing/render.ts", before: "if (rendered.length / 2 > end - start)", after: "if (false && rendered.length / 2 > end - start)", expected: "oversized speech refuses rather than truncating or stretching" },
  { name: "skip-revocation-check", file: "src/lib/media/dubbing/render.ts", before: "await options.assertCurrent(structuredClone(value));", after: "await Promise.resolve();", expected: "revocation between segments prevents later synthesis and output" },
  { name: "retain-failed-stage", file: "src/lib/media/dubbing/handler.ts", before: "try { await dependencies.remove(context, artifactId); }", after: "try { await Promise.resolve(); }", expected: "hold arriving during storage staging removes bytes and refuses success" },
  { name: "restore-old-consent", file: "src/migrations/3986_media_synthetic_dubbing.sql", before: "UPDATE media_dubbing_consents SET opted_in = false, consent_revision = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), updated_at = now() WHERE asset_id = NEW.id;", after: "UPDATE media_dubbing_consents SET opted_in = true, updated_at = now() WHERE asset_id = NEW.id;", expected: "restore does not restore consent", sql: true },
  { name: "foreign-stage-lease", file: "src/migrations/3986_media_synthetic_dubbing.sql", before: "job_row.lease_token IS DISTINCT FROM p_token", after: "false", expected: "Missing expected rejection", sql: true },
  { name: "late-consent-retry", file: "src/migrations/3986_media_synthetic_dubbing.sql", before: "IF p_expected IS DISTINCT FROM existing_consent.consent_revision THEN RETURN NULL; END IF;", after: "IF false THEN RETURN NULL; END IF;", expected: "pre-revocation consent request cannot reauthorize after revocation", sql: true },
  { name: "implicit-offline-approval", file: "src/lib/media/dubbing/config.ts", before: "offlineSandboxAttested: z.literal(true)", after: "offlineSandboxAttested: z.boolean()", expected: "✖ missing or malformed runtime retains independently validated cleanup bucket", composition: true },
  { name: "api-model-file-check", file: "src/lib/media/dubbing/config.ts", before: "const settings = validatePiperRuntimeConfig(config);", after: 'const settings = validatePiperRuntimeConfig(config); if (settings.modelPath.startsWith("/absent/")) throw new DubbingError("not_configured");', expected: "✖ configured API enqueues with nonexistent model files using actual caption/store/queue composition", composition: true },
  { name: "missing-bucket-false-erasure", file: "src/lib/media/dubbing/store.ts", before: 'if (!bucket) throw new DubbingError("cleanup_failed");', after: "if (!bucket) return;", expected: "✖ missing bucket API retains withdrawal but never acknowledges retained bytes as erased", composition: true },
  { name: "incomplete-erasure-ack", file: "src/lib/media/dubbing/composition.ts", before: "if (await cleanup.eraseOwned(sourceOwner, assetId) === 100)", after: "if (await cleanup.eraseOwned(sourceOwner, assetId) === -1)", expected: "✖ source erasure requires retry after full bounded page rather than acknowledging incomplete deletion", composition: true },
  { name: "worker-skips-runtime-verification", file: "src/lib/media/dubbing/composition.ts", before: "engine = await createPiperSpeech(config.runtime);", after: "engine = config.descriptor as any;", expected: "✖ worker stays disabled for missing config, flags OFF and nonexistent runtime", composition: true },
];
for (const fault of cases) {
  const root = join(outputRoot, fault.name);
  const destination = join(root, "artifacts/api-server");
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "package.json"), '{"type":"module"}\n');
  await symlink(await import("node:fs/promises").then(({ realpath }) => realpath(join(api, "node_modules"))), join(destination, "node_modules"));
  for (const relative of ["src/lib/media/dubbing", "src/lib/media/vendors", "src/test/mediaDubbing.test.ts", "src/migrations/3986_media_synthetic_dubbing.sql"]) {
    await mkdir(resolve(destination, relative, ".."), { recursive: true });
    await cp(join(api, relative), join(destination, relative), { recursive: true });
  }
  if (fault.composition) {
    for (const relative of ["src/routes/mediaDubbing.ts", "src/test/mediaDubbingComposition.test.ts"]) {
      await mkdir(resolve(destination, relative, ".."), { recursive: true });
      await cp(join(api, relative), join(destination, relative));
    }
    for (const relative of ["http.ts", "rateLimit.ts", "featureFlags.ts"]) await symlink(join(api, "src/lib", relative), join(destination, "src/lib", relative));
    const parentSource = resolve(queueMigration, "../..");
    await symlink(join(parentSource, "lib/media/jobs"), join(destination, "src/lib/media/jobs"));
    await mkdir(join(destination, "src/services"), { recursive: true });
    await symlink(join(parentSource, "services/media"), join(destination, "src/services/media"));
  }
  await mkdir(join(root, "tools/media-dubbing"), { recursive: true });
  await cp(join(checkout, "tools/media-dubbing/test-store.mts"), join(root, "tools/media-dubbing/test-store.mts"));
  const filename = join(destination, fault.file);
  const original = await readFile(filename, "utf8");
  assert.equal(original.split(fault.before).length - 1, 1, fault.name);
  await writeFile(filename, original.replace(fault.before, fault.after));
  const args = ["--import", loader, ...(fault.sql ? [join(root, "tools/media-dubbing/test-store.mts"), pglite, queueMigration] : ["--test", "--test-concurrency=1", fault.composition ? "src/test/mediaDubbingComposition.test.ts" : "src/test/mediaDubbing.test.ts"])];
  const result = spawnSync(process.execPath, args, { cwd: destination, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, encoding: "utf8", timeout: 30_000, maxBuffer: 2_000_000 });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  await writeFile(join(root, "red.log"), log);
  assert.equal(result.status, 1, `${fault.name}: expected test assertion failure`);
  assert(log.includes(fault.expected), `${fault.name}: expected specific failure, not setup/compile failure`);
  console.log(`RED ${fault.name}: ${fault.expected}`);
}
console.log(`${cases.length} deliberate faults caught in isolated copies; checkout unchanged. Run the unchanged focused suites next for green confirmation.`);
