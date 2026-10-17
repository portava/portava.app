import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createImageVariantsRuntime, imageVariantsConfigFromEnv } from "../lib/media/imageVariants/runtime.js";
import { createImageVariantsAccess, createImageVariantsAcquirer } from "../lib/media/imageVariants/canonical.js";
import { imageVariantsFixture } from "./helpers/imageVariantsFixture.js";

test("private actual variants publish only from queue authority, survive runtime restart, and leave originals intact", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const original = Buffer.from(fixture.bytes);
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch, queue: fixture.queue });
  assert.ok(await runtime.enqueue(fixture.source));
  assert.equal(fixture.enqueued.length, 1);
  assert.equal(fixture.fetches.length, 0, "enqueue cannot execute inference/encoding");
  const output = await runtime.handler.handle(fixture.context);
  const directory = join(fixture.config.root, "assets", fixture.source.assetId, "4", fixture.context.job.token);
  assert.equal((await readdir(directory)).length, 8);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, "image-320.avif"))).mode & 0o777, 0o600);
  assert.equal(await runtime.readFile(fixture.ownerId, fixture.source, "image-320.avif"), null);
  fixture.state.ready = output.result;
  const restarted = createImageVariantsRuntime(fixture.sc, fixture.config);
  const read = await restarted.readFile(fixture.ownerId, fixture.source, "image-320.avif");
  assert.equal(read?.mime, "image/avif");
  assert.deepEqual(read?.bytes, await readFile(join(directory, "image-320.avif")));
  assert.deepEqual(fixture.bytes, original);
  assert.equal(await runtime.readFile(fixture.viewerId, fixture.source, "image-320.avif"), null);
  assert.equal(await runtime.readFile(fixture.ownerId, fixture.source, "../../original"), null);
  assert.equal(fixture.signs.length, 1);
  assert.equal(fixture.fetches[0].init.redirect, "error");
});

test("default OFF, unavailable policy, inactive owners and held sources cannot enqueue or read bytes", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  assert.equal(imageVariantsConfigFromEnv({}).enabled, false);
  const off = createImageVariantsRuntime(fixture.sc, { ...fixture.config, enabled: false }, { fetch: fixture.fetch, queue: fixture.queue });
  assert.equal(await off.enqueue(fixture.source), null);
  await assert.rejects(off.handler.handle(fixture.context));
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch, queue: fixture.queue });
  for (const moderation of ["pending", "rejected", "flagged", "removed", "processing", "limited"]) {
    fixture.asset.moderation_status = moderation;
    assert.equal(await runtime.enqueue(fixture.source), null);
    await assert.rejects(runtime.handler.handle(fixture.context));
  }
  fixture.asset.moderation_status = "active";
  fixture.tables.profiles[0].user_account_states = [{ state: "suspended", expires_at: null }];
  await assert.rejects(runtime.handler.handle(fixture.context));
  fixture.tables.profiles = [];
  await assert.rejects(runtime.handler.handle(fixture.context));
  fixture.failures.add("feature_flags");
  await assert.rejects(runtime.handler.handle(fixture.context));
  assert.equal(fixture.signs.length, 0);
  assert.equal(fixture.fetches.length, 0);
  assert.equal(fixture.enqueued.length, 0);
});

test("derivative audience never widens a public parent, private asset, attachment override or block", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const previous = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = fixture.config.storageOrigin;
  context.after(() => { if (previous === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous; });
  const postId = randomUUID();
  fixture.tables.post_media = [{ storage_path: fixture.source.path, post_id: postId, processing_status: "ready", moderation_status: "approved" }];
  fixture.tables.posts = [{ id: postId, author_id: fixture.ownerId, visibility: "public", status: "active", post_status: "published", trip_id: null }];
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  fixture.state.ready = (await runtime.handler.handle(fixture.context)).result;
  assert.ok(await runtime.readFile(fixture.viewerId, fixture.source, "image-800.webp"));
  fixture.asset.visibility = "private";
  assert.equal(await runtime.readFile(fixture.viewerId, fixture.source, "image-800.webp"), null);
  assert.ok(await runtime.readFile(fixture.ownerId, fixture.source, "image-800.webp"));
  fixture.asset.visibility = "inherit";
  fixture.tables.media_attachments = [{ media_asset_id: fixture.source.assetId, entity_type: "post", entity_id: postId, visibility_override: "private" }];
  assert.equal(await runtime.readFile(fixture.viewerId, fixture.source, "image-800.webp"), null);
  fixture.tables.media_attachments = [];
  fixture.tables.blocks = [{ blocker_id: fixture.ownerId, blocked_id: fixture.viewerId }];
  assert.equal(await runtime.readFile(fixture.viewerId, fixture.source, "image-800.webp"), null);
});

test("source generation and exact owner/bucket/path/size are never rebased from a stale job", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  const pristine = { ...fixture.asset };
  for (const changed of [{ version: 5 }, { owner_user_id: fixture.viewerId }, { storage_path: `${fixture.ownerId}/other.png` },
    { storage_bucket: "profile-media" }, { size_bytes: fixture.bytes.length + 1 }, { processing_status: "processing" },
    { deleted_at: "2026-10-15T00:00:00Z" }, { purge_status: "pending" }, { mime_type: "application/octet-stream" }]) {
    Object.assign(fixture.asset, pristine, changed);
    await assert.rejects(runtime.handler.handle(fixture.context), JSON.stringify(changed));
  }
  assert.equal(fixture.signs.length, 0);
  assert.equal(fixture.fetches.length, 0);
});

test("signing cannot substitute origin, owner, raw path, extra query or a newly revoked generation", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const acquire = createImageVariantsAcquirer(fixture.sc, fixture.config, createImageVariantsAccess(fixture.sc, fixture.config), fixture.fetch);
  const original = fixture.state.signedUrl;
  for (const url of [original.replace("image-synthetic.supabase.co", "attacker.invalid"), original.replace(fixture.ownerId, fixture.viewerId),
    original.replace("synthetic.png", "other.png"), `${original}&token=second`, `${original}#fragment`]) {
    fixture.state.signedUrl = url;
    await assert.rejects(acquire(fixture.source, fixture.context.signal, async () => {}));
  }
  fixture.state.signedUrl = original;
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  fixture.state.afterSign = () => { fixture.asset.version++; };
  await assert.rejects(runtime.handler.handle(fixture.context));
  assert.equal(fixture.fetches.length, 0);
});

test("private download rejects redirect/MIME/length/encoding mismatch and truncation/overflow", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const access = createImageVariantsAccess(fixture.sc, fixture.config);
  const cases = [() => new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }),
    () => new Response(fixture.bytes, { headers: { "content-type": "image/jpeg" } }),
    () => new Response(fixture.bytes, { headers: { "content-type": "image/png", "content-length": "1" } }),
    () => new Response(fixture.bytes, { headers: { "content-type": "image/png", "content-encoding": "gzip" } }),
    () => new Response(fixture.bytes.subarray(1), { headers: { "content-type": "image/png" } }),
    () => new Response(Buffer.concat([fixture.bytes, Buffer.from([1])]), { headers: { "content-type": "image/png" } })];
  for (const response of cases) {
    const acquire = createImageVariantsAcquirer(fixture.sc, fixture.config, access, async () => response());
    await assert.rejects(acquire(fixture.source, fixture.context.signal, async () => {}));
  }
  const controller = new AbortController();
  let cancelled = false;
  const acquire = createImageVariantsAcquirer(fixture.sc, fixture.config, access, async () => new Response(new ReadableStream({
    start() { setTimeout(() => controller.abort(), 5); }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "image/png" } }));
  await assert.rejects(acquire(fixture.source, controller.signal, async () => {}));
  assert.equal(cancelled, true);
});

test("a revoked lease during private writes leaves no publishable files", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  fixture.state.onCheck = () => { if (fixture.state.checks === 8) fixture.state.lease = false; };
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  await assert.rejects(runtime.handler.handle(fixture.context));
  assert.equal(fixture.state.checks, 8);
  assert.deepEqual(await readdir(join(fixture.config.root, "assets", fixture.source.assetId, "4")), []);
  assert.equal(fixture.state.ready, null);
});

test("read rechecks queue publication, account and source state after disk access", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  fixture.state.ready = (await runtime.handler.handle(fixture.context)).result;
  fixture.state.afterReady = () => { fixture.asset.version++; };
  assert.equal(await runtime.readFile(fixture.ownerId, fixture.source, "thumb.jpg"), null);
  fixture.asset.version = 4;
  fixture.state.afterReady = () => { fixture.tables.profiles[0].account_status = "deactivated"; };
  assert.equal(await runtime.readFile(fixture.ownerId, fixture.source, "thumb.jpg"), null);
  fixture.tables.profiles[0].account_status = "active";
  fixture.state.afterReady = () => { fixture.state.ready = null; };
  assert.equal(await runtime.readFile(fixture.ownerId, fixture.source, "thumb.jpg"), null);
});

test("own-lease discard preserves a newer lease and readers reject tampered bytes", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  const first = await runtime.handler.handle(fixture.context);
  const newer = { ...fixture.context, job: { ...fixture.context.job, token: randomUUID() } };
  const second = await runtime.handler.handle(newer);
  fixture.state.ready = second.result;
  await assert.rejects(runtime.handler.discard(fixture.context, second), /another/);
  await runtime.handler.discard(fixture.context, first);
  const directory = join(fixture.config.root, "assets", fixture.source.assetId, "4");
  assert.deepEqual(await readdir(directory), [newer.job.token]);
  assert.ok(await runtime.readFile(fixture.ownerId, fixture.source, "thumb.jpg"));
  const filename = join(directory, newer.job.token, "thumb.jpg");
  const bytes = await readFile(filename); bytes[bytes.length - 1] ^= 1;
  await writeFile(filename, bytes);
  assert.equal(await runtime.readFile(fixture.ownerId, fixture.source, "thumb.jpg"), null);
});

test("purge requires tombstoned exact identity, persists revocation, cancels jobs and erases only derivatives", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const originalFile = join(fixture.root, "original.png"); await writeFile(originalFile, fixture.bytes);
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  fixture.state.ready = (await runtime.handler.handle(fixture.context)).result;
  await assert.rejects(runtime.eraseSource(fixture.source), /tombstoned/);
  fixture.asset.deleted_at = "2026-10-15T00:00:00Z";
  fixture.asset.purge_status = "pending";
  await assert.rejects(runtime.eraseSource({ ...fixture.source, path: `${fixture.ownerId}/wrong.png` }));
  fixture.failures.add("media_derivative_cancel_asset");
  await assert.rejects(runtime.eraseSource(fixture.source), /unavailable/);
  assert.equal((await readdir(join(fixture.config.root, "assets"))).length, 1);
  assert.equal((await readdir(join(fixture.config.root, "revoked"))).length, 1);
  fixture.failures.clear();
  await runtime.eraseSource(fixture.source);
  assert.equal(fixture.state.cancelled, true);
  assert.deepEqual(await readdir(join(fixture.config.root, "assets")), []);
  assert.deepEqual(await readFile(originalFile), fixture.bytes);
  fixture.asset.deleted_at = null; fixture.asset.purge_status = "not_requested"; fixture.state.lease = true;
  const restarted = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  await assert.rejects(restarted.handler.handle(fixture.context), /unavailable/);
});

test("artifact root refuses unmarked or symlink directories", async context => {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const unsafe = createImageVariantsRuntime(fixture.sc, { ...fixture.config, root: fixture.root }, { fetch: fixture.fetch });
  await writeFile(join(fixture.root, "unrelated.txt"), "preserve");
  await assert.rejects(unsafe.handler.handle(fixture.context), /unmarked/);
  await symlink(fixture.root, fixture.config.root);
  const linked = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  await assert.rejects(linked.handler.handle(fixture.context), /directory/);
  assert.equal(await readFile(join(fixture.root, "unrelated.txt"), "utf8"), "preserve");
});
