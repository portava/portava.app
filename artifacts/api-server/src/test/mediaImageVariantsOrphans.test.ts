import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ImageVariantArtifacts } from "../lib/media/imageVariants/artifacts.js";
import { createImageVariantsRuntime } from "../lib/media/imageVariants/runtime.js";
import { imageVariantsFixture } from "./helpers/imageVariantsFixture.js";

async function setup(context: TestContext) {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  await runtime.handler.handle(fixture.context);
  const artifacts = new ImageVariantArtifacts(fixture.config.root);
  const candidate = { assetId: fixture.source.assetId, sourceVersion: 4, token: fixture.context.job.token };
  const signal = new AbortController().signal;
  const snapshot = await artifacts.inspect(candidate, signal); assert.ok(snapshot);
  const path = join(fixture.config.root, "assets", candidate.assetId, "4", candidate.token);
  return { ...fixture, runtime, artifacts, candidate, snapshot, signal, path };
}

test("orphan inventory is exact and bounded to measured private rendition files", async context => {
  const fixture = await setup(context);
  const inventory = [];
  for await (const candidate of fixture.artifacts.inventory(fixture.signal)) inventory.push(candidate);
  assert.deepEqual(inventory, [fixture.candidate]);
  assert.equal(fixture.snapshot.files, 8); assert.ok(fixture.snapshot.bytes > 0); assert.match(fixture.snapshot.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await fixture.artifacts.inspect({ ...fixture.candidate, token: randomUUID() }, fixture.signal), null);
});

test("missing DB permission, unavailable proof and changed snapshots preserve bytes without revoking", async context => {
  const fixture = await setup(context);
  assert.equal(await fixture.artifacts.eraseOrphan(fixture.snapshot, async () => false, fixture.signal), false);
  await assert.rejects(fixture.artifacts.eraseOrphan(fixture.snapshot, async () => { throw new Error("DB unavailable"); }, fixture.signal), /DB unavailable/);
  assert.equal(await fixture.artifacts.revoked(fixture.candidate.assetId), false);
  await writeFile(join(fixture.path, "thumb.jpg"), "changed synthetic rendition");
  let proofCalls = 0;
  assert.equal(await fixture.artifacts.eraseOrphan(fixture.snapshot, async () => { proofCalls++; return true; }, fixture.signal), false);
  assert.equal(proofCalls, 0); assert.equal((await readdir(fixture.path)).length, 8);
  assert.equal(await fixture.artifacts.revoked(fixture.candidate.assetId), false);
});

test("confirmed orphan erasure runs proof under the asset lock and preserves other leases and originals", async context => {
  const fixture = await setup(context);
  const newer = { ...fixture.context, job: { ...fixture.context.job, token: randomUUID() } };
  await fixture.runtime.handler.handle(newer);
  const snapshot = await fixture.artifacts.inspect(fixture.candidate, fixture.signal); assert.ok(snapshot);
  const original = join(fixture.root, "original.png"); await writeFile(original, fixture.bytes);
  const erased = await fixture.artifacts.eraseOrphan(snapshot, async candidate => {
    assert.deepEqual(candidate, fixture.candidate);
    assert.ok((await lstat(join(fixture.config.root, "locks", candidate.assetId))).isDirectory());
    return true;
  }, fixture.signal);
  assert.equal(erased, true);
  assert.deepEqual(await readdir(join(fixture.config.root, "assets", fixture.candidate.assetId, "4")), [newer.job.token]);
  assert.deepEqual(await readFile(original), fixture.bytes);
  assert.equal(await fixture.artifacts.revoked(fixture.candidate.assetId), true);
});

test("file changes during final authorization refuse deletion", async context => {
  const fixture = await setup(context);
  assert.equal(await fixture.artifacts.eraseOrphan(fixture.snapshot, async () => {
    await writeFile(join(fixture.path, "thumb.jpg"), "changed during proof"); return true;
  }, fixture.signal), false);
  assert.equal((await readdir(fixture.path)).length, 8);
  assert.equal(await fixture.artifacts.revoked(fixture.candidate.assetId), false);
});

test("orphan inspection and erasure never follow linked or unexpected files", async context => {
  const fixture = await setup(context);
  const original = join(fixture.root, "preserve.txt"); await writeFile(original, "preserve");
  await unlink(join(fixture.path, "thumb.jpg")); await symlink(original, join(fixture.path, "thumb.jpg"));
  await assert.rejects(fixture.artifacts.inspect(fixture.candidate, fixture.signal), /unsafe/);
  await assert.rejects(fixture.artifacts.eraseOrphan(fixture.snapshot, async () => true, fixture.signal), /unsafe/);
  assert.equal(await readFile(original, "utf8"), "preserve");
  await unlink(join(fixture.path, "thumb.jpg")); await writeFile(join(fixture.path, "unknown.bin"), "unexpected");
  await assert.rejects(fixture.artifacts.inspect(fixture.candidate, fixture.signal), /unsafe/);
});

test("cleanup requires an already marked root and cancellation cannot authorize erasure", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const artifacts = new ImageVariantArtifacts(fixture.root);
  await writeFile(join(fixture.root, "unrelated"), "preserve");
  await assert.rejects(artifacts.assertCleanupRoot());
  assert.deepEqual(await readdir(fixture.root), ["unrelated"]);
  const encoded = await setup(context);
  await assert.rejects(encoded.artifacts.eraseOrphan(encoded.snapshot, async () => true, AbortSignal.abort()));
  assert.equal((await readdir(encoded.path)).length, 8);
});

test("inventory refuses a symlinked asset rather than traversing it", async context => {
  const fixture = await setup(context);
  await symlink(fixture.root, join(fixture.config.root, "assets", randomUUID()));
  await assert.rejects(async () => {
    for await (const candidate of fixture.artifacts.inventory(fixture.signal)) assert.equal(candidate.assetId, fixture.candidate.assetId);
  }, /unsafe/);
});

test("cancellation preserves an existing lock and releases only a cleanup-owned lock on unavailable proof", async context => {
  const fixture = await setup(context);
  const lock = join(fixture.config.root, "locks", fixture.candidate.assetId);
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(fixture.artifacts.eraseOrphan(fixture.snapshot, async () => true, AbortSignal.timeout(25)));
  assert.ok((await lstat(lock)).isDirectory());
  await rmdir(lock);
  await assert.rejects(fixture.artifacts.eraseOrphan(fixture.snapshot, async () => new Promise<boolean>(() => {}), AbortSignal.timeout(25)));
  assert.deepEqual(await readdir(join(fixture.config.root, "locks")), []);
  assert.equal(await fixture.artifacts.revoked(fixture.candidate.assetId), false);
  assert.equal((await readdir(fixture.path)).length, 8);
});
