import assert from "node:assert/strict";
import http from "node:http";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { createMediaImageVariantsRouter } from "../routes/mediaImageVariants.js";
import { createImageVariantsService } from "../services/media/ImageVariantsService.js";
import { createImageVariantsRuntime, imageVariantsConfigFromEnv } from "../lib/media/imageVariants/runtime.js";
import { createConfiguredImageVariants } from "../lib/media/imageVariants/bridge.js";
import { imageVariantsFixture } from "./helpers/imageVariantsFixture.js";

type Fixture = Awaited<ReturnType<typeof imageVariantsFixture>>;
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}
afterEach(() => { _setTestClient(null, false); _clearTestClient(); _resetRateLimit(); });

async function fixtureFor(context: TestContext) {
  const fixture = await imageVariantsFixture();
  context.after(() => fixture.cleanup());
  fixture.sc.auth = { async getUser(token: string) {
    return { data: { user: token === "owner" ? { id: fixture.ownerId } : token === "viewer" ? { id: fixture.viewerId } : null }, error: null };
  } };
  _setTestClient(fixture.sc, true);
  return fixture;
}

async function request(fixture: Fixture, path: string, token = "owner", method = "GET", enabled = true) {
  const app = express();
  app.use("/api", createMediaImageVariantsRouter(sc => enabled ? createImageVariantsService(sc, fixture.config) : null));
  const socket = new Socket();
  try {
    return await new Promise<{ status: number; bytes: Buffer; headers: http.OutgoingHttpHeaders }>((resolve, reject) => {
      const incoming = new http.IncomingMessage(socket);
      incoming.method = method; incoming.url = path;
      incoming.headers = token ? { authorization: `Bearer ${token}` } : {};
      const response = new http.ServerResponse(incoming);
      const timer = setTimeout(() => reject(new Error("image route timeout")), 3000);
      response.end = ((chunk?: unknown) => {
        clearTimeout(timer);
        const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(typeof chunk === "string" ? chunk : "");
        resolve({ status: response.statusCode, bytes, headers: response.getHeaders() });
        return response;
      }) as typeof response.end;
      app(incoming, response); incoming.push(null);
    });
  } finally { socket.destroy(); }
}

function json(reply: { bytes: Buffer }): Record<string, unknown> {
  const parsed: unknown = JSON.parse(reply.bytes.toString());
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}
const sourceUrl = (fixture: Fixture, reference = `${fixture.source.bucket}/${fixture.source.path}`) =>
  `/api/media/image-variants/source?source=${encodeURIComponent(reference)}`;
const fileUrl = (fixture: Fixture, filename = "thumb.jpg", version = fixture.source.sourceVersion) =>
  `/api/media/image-variants/${fixture.source.assetId}/${version}/${filename}`;
async function publish(fixture: Fixture) {
  const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
  fixture.state.ready = (await runtime.handler.handle(fixture.context)).result;
  return runtime;
}

test("authenticated original reference returns only protected measured descriptors and actual bytes", async context => {
  const fixture = await fixtureFor(context); await publish(fixture);
  const reply = await request(fixture, sourceUrl(fixture));
  assert.equal(reply.status, 200);
  const descriptor = json(reply);
  assert.equal(descriptor.state, "ready"); assert.equal(descriptor.assetId, fixture.source.assetId); assert.equal(descriptor.sourceVersion, 4);
  assert.ok(Array.isArray(descriptor.variants)); assert.equal(descriptor.variants.length, 8);
  for (const forbidden of [fixture.root, fixture.ownerId, fixture.context.job.token, fixture.source.path, "sourceSha256", "phash", "synthetic"]) assert.equal(reply.bytes.toString().includes(forbidden), false);
  const image = await request(fixture, fileUrl(fixture, "image-320.avif"));
  assert.equal(image.status, 200); assert.equal(image.headers["content-type"], "image/avif");
  assert.equal(image.bytes.length, fixture.state.ready.files["image-320.avif"].bytes);
  for (const result of [reply, image]) {
    assert.equal(result.headers["cache-control"], "private, no-store, max-age=0");
    assert.equal(result.headers.vary, "Authorization, Cookie"); assert.equal(result.headers["x-content-type-options"], "nosniff");
    assert.equal(result.headers.etag, undefined); assert.equal(result.headers.location, undefined);
  }
  const head = await request(fixture, fileUrl(fixture), "owner", "HEAD");
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers["content-length"]), fixture.state.ready.files["thumb.jpg"].bytes);
});

test("pending publication returns explicit original fallback without encoding or signing", async context => {
  const fixture = await fixtureFor(context);
  const reply = await request(fixture, sourceUrl(fixture));
  assert.equal(reply.status, 200); assert.deepEqual(json(reply), { state: "original", reason: "not_ready", assetId: fixture.source.assetId, sourceVersion: 4, variants: [] });
  assert.equal(fixture.fetches.length, 0); assert.equal(fixture.signs.length, 0); assert.equal(fixture.enqueued.length, 0);
});

test("authentication, private audience, tombstones, holds and stale file generations deny bytes", async context => {
  const fixture = await fixtureFor(context); await publish(fixture);
  assert.equal((await request(fixture, fileUrl(fixture), "")).status, 401);
  assert.equal((await request(fixture, sourceUrl(fixture), "viewer")).status, 404);
  assert.equal((await request(fixture, fileUrl(fixture), "viewer")).status, 404);
  assert.equal((await request(fixture, fileUrl(fixture, "thumb.jpg", 3))).status, 404);
  for (const change of [{ deleted_at: "2026-10-15T00:00:00Z" }, { moderation_status: "pending" }, { purge_status: "pending" }, { version: 5 }]) {
    const previous = { ...fixture.asset }; Object.assign(fixture.asset, change);
    assert.equal((await request(fixture, fileUrl(fixture))).status, 404);
    Object.assign(fixture.asset, previous);
  }
});

test("public source still obeys canonical narrowing, attachment overrides and blocks", async context => {
  const fixture = await fixtureFor(context); await publish(fixture);
  const previous = process.env.SUPABASE_URL; process.env.SUPABASE_URL = fixture.config.storageOrigin;
  context.after(() => { if (previous === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous; });
  const postId = randomUUID();
  fixture.tables.post_media = [{ storage_path: fixture.source.path, post_id: postId, processing_status: "ready", moderation_status: "approved" }];
  fixture.tables.posts = [{ id: postId, author_id: fixture.ownerId, visibility: "public", status: "active", post_status: "published", trip_id: null }];
  assert.equal((await request(fixture, sourceUrl(fixture), "viewer")).status, 200);
  fixture.asset.visibility = "private";
  assert.equal((await request(fixture, sourceUrl(fixture), "viewer")).status, 404);
  fixture.asset.visibility = "inherit";
  fixture.tables.media_attachments = [{ media_asset_id: fixture.source.assetId, entity_type: "post", entity_id: postId, visibility_override: "private" }];
  assert.equal((await request(fixture, sourceUrl(fixture), "viewer")).status, 404);
  fixture.tables.media_attachments = []; fixture.tables.blocks = [{ blocker_id: fixture.ownerId, blocked_id: fixture.viewerId }];
  assert.equal((await request(fixture, sourceUrl(fixture), "viewer")).status, 404);
});

test("original resolver pins configured storage and rejects transformations, traversal and ambiguous rows", async context => {
  const fixture = await fixtureFor(context);
  const publicUrl = `${fixture.config.storageOrigin}/storage/v1/object/public/post-media/${fixture.source.path}`;
  for (const accepted of [publicUrl, fixture.state.signedUrl]) assert.equal((await request(fixture, sourceUrl(fixture, accepted))).status, 200);
  for (const refused of [publicUrl.replace("https:", "http:"), publicUrl.replace("image-synthetic", "other"), publicUrl.replace("/object/public/", "/render/image/public/"),
    publicUrl + "#fragment", publicUrl + "?download=1", fixture.state.signedUrl + "&token=second", publicUrl.replace("https://", "https://user@"),
    publicUrl.replace("synthetic.png", "nested/../synthetic.png"), publicUrl.replace("synthetic.png", "%2e%2e/synthetic.png"),
    `post-media/${fixture.ownerId}/../synthetic.png`, `profile-media/${fixture.source.path}`, publicUrl.replace("synthetic.png", "thumb.jpg")]) {
    assert.equal((await request(fixture, sourceUrl(fixture, refused))).status, 404, refused);
  }
  fixture.tables.media_assets.push({ ...fixture.asset, id: randomUUID() });
  assert.equal((await request(fixture, sourceUrl(fixture))).status, 404);
  assert.equal(fixture.signs.length, 0); assert.equal(fixture.fetches.length, 0);
});

test("descriptor rechecks canonical generation and publication after ready lookup", async context => {
  const fixture = await fixtureFor(context); await publish(fixture);
  fixture.state.afterReady = () => { fixture.asset.version++; };
  assert.equal((await request(fixture, sourceUrl(fixture))).status, 404);
  fixture.asset.version = 4;
  fixture.state.afterReady = () => { fixture.state.ready = null; };
  const revoked = await request(fixture, sourceUrl(fixture));
  assert.equal(revoked.status, 200); assert.equal(json(revoked).state, "original");
});

test("read relay denies late revocation and tampered disk output without fallback URLs", async context => {
  const fixture = await fixtureFor(context); await publish(fixture);
  fixture.state.afterReady = () => { fixture.asset.deleted_at = "2026-10-15T00:00:00Z"; };
  assert.equal((await request(fixture, fileUrl(fixture))).status, 404);
  fixture.asset.deleted_at = null; fixture.state.afterReady = () => {};
  await writeFile(join(fixture.config.root, "assets", fixture.source.assetId, "4", fixture.context.job.token, "thumb.jpg"), Buffer.from("corrupt"));
  const reply = await request(fixture, fileUrl(fixture)); assert.equal(reply.status, 404); assert.equal(json(reply).error, "not_found");
  assert.equal(reply.headers.location, undefined);
});

test("malformed publication and unavailable queue are typed failures, OFF never constructs a root", async context => {
  const fixture = await fixtureFor(context);
  assert.equal(createConfiguredImageVariants(fixture.sc, {}), null);
  const disabled = await request(fixture, sourceUrl(fixture), "owner", "GET", false);
  assert.equal(json(disabled).error, "feature_disabled");
  fixture.state.ready = { files: { "../secret": {} } };
  const malformed = await request(fixture, sourceUrl(fixture));
  assert.equal(malformed.status, 503); assert.equal(json(malformed).error, "degraded_unavailable");
  fixture.state.ready = null; fixture.failures.add("media_derivative_ready");
  assert.equal((await request(fixture, sourceUrl(fixture))).status, 503);
  for (const name of ["original.png", "../original", "thumb.jpg%00", "image-999.avif"]) assert.equal((await request(fixture, fileUrl(fixture, name))).status, 404);
  for (const version of [0, -1, 2147483648, 4.5]) assert.equal((await request(fixture, fileUrl(fixture, "thumb.jpg", version))).status, 404);
  assert.equal((await request(fixture, fileUrl(fixture, "descriptor").replace("/4/", "/4e0/"))).status, 404);
});

test("configured bridge enqueues through the shared RPC with the owned version, never rebasing", async context => {
  const fixture = await fixtureFor(context);
  const env = { MEDIA_IMAGE_VARIANTS_ENABLED: "1", MEDIA_IMAGE_VARIANTS_ROOT: fixture.config.root, SUPABASE_URL: fixture.config.storageOrigin };
  assert.ok(imageVariantsConfigFromEnv(env).encoderEntrypoint?.pathname.endsWith("/imageVariants/encoderChild.ts"));
  const calls: Record<string, unknown>[] = [];
  const jobId = randomUUID();
  const rpc = fixture.sc.rpc.bind(fixture.sc);
  fixture.sc.rpc = (name: string, args: Record<string, unknown>) => name !== "media_derivative_enqueue" ? rpc(name, args) : {
    abortSignal() { calls.push(args); return Promise.resolve({ data: jobId, error: null }); },
  };
  const configured = createConfiguredImageVariants(fixture.sc, env);
  assert.ok(configured);
  assert.equal(await configured.enqueue(fixture.source), jobId);
  assert.deepEqual(calls, [{ p_asset_id: fixture.source.assetId, p_owner_user_id: fixture.ownerId, p_source_version: 4,
    p_kind: "image_variants", p_model_version: "sharp-responsive-v1", p_target_language: "", p_revision_key: "" }]);
  fixture.asset.version = 5;
  assert.equal(await configured.enqueue(fixture.source), null); assert.equal(calls.length, 1);
  assert.equal(fixture.fetches.length, 0); assert.equal(fixture.signs.length, 0);
});

test("cancelled relay stops waiting and zeroes a late reader result", async context => {
  const fixture = await fixtureFor(context);
  const started = deferred<void>();
  const pending = deferred<{ bytes: Buffer; mime: string }>();
  const service = createImageVariantsService(fixture.sc, fixture.config, { readFile() { started.resolve(); return pending.promise; } });
  const controller = new AbortController();
  const operation = service.readFile(fixture.ownerId, { assetId: fixture.source.assetId, sourceVersion: 4 }, "thumb.jpg", controller.signal);
  await started.promise; controller.abort();
  await assert.rejects(operation, /cancelled/);
  const bytes = Buffer.from("late synthetic bytes");
  pending.resolve({ bytes, mime: "image/jpeg" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(bytes.every(value => value === 0));
});
