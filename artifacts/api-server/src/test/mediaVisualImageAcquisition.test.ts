import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { createCanonicalVisualImageAcquirer } from "../lib/media/visualIndex/canonicalImageAcquisition.js";
import { canonicalVisualSource } from "../lib/media/visualIndex/canonicalVisualSource.js";
import { createVisualIndexJobHandler } from "../lib/media/visualIndex/visualIndexJobHandler.js";
import { generationKey, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, VISUAL_MODEL_ID } from "../lib/media/visualIndex/contracts.js";
import { visualAsset, visualOther, visualOrigin, visualOwner, visualSidecarFixture } from "./helpers/mediaVisualSidecarFixture.js";

async function fixture() {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  const state = visualSidecarFixture(bytes); state.grant();
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let respond = () => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) } });
  const transport: typeof fetch = async (url, options) => { calls.push({ url: String(url), options }); return respond(); };
  const source = canonicalVisualSource(state.asset)!;
  const limits = { signal: new AbortController().signal, maxBytes: MAX_IMAGE_BYTES, maxPixels: MAX_IMAGE_PIXELS };
  const acquire = createCanonicalVisualImageAcquirer(state, { fetch: transport });
  return { ...state, source, limits, calls, transport, acquire, response(callback: () => Response) { respond = callback; } };
}

test("private acquisition signs the exact owner key, denies redirects and really decodes unchanged synthetic PNG bytes", async () => {
  const state = await fixture();
  const result = await state.acquire(state.source, state.limits);
  assert.deepEqual(result, state.bytes);
  assert.deepEqual(state.signs, [{ bucket: "post-media", path: state.source.path, ttl: 15 }]);
  assert.equal(state.calls[0]?.options?.redirect, "error");
  assert.equal(state.calls[0]?.options?.credentials, "omit");
  assert.ok(state.calls[0]?.url.startsWith(`${visualOrigin}/storage/v1/object/sign/post-media/${visualOwner}/`));
  assert.ok(!state.calls[0]?.url.includes("untrusted.invalid"));
});

test("foreign keys, stale generations, missing consent, flags and restricted/deleted owner stop before signing", async () => {
  for (const change of ["version", "path", "owner", "consent", "flag", "ban", "deleted", "missing_profile", "read_error"] as const) {
    const state = await fixture();
    if (change === "version") state.asset.version++;
    if (change === "path") state.asset.storage_path = `${visualOther}/different.png`;
    if (change === "owner") state.asset.owner_user_id = visualOther;
    if (change === "consent") state.tables.media_visual_index_consents = [];
    if (change === "flag") state.tables.feature_flags![0].enabled = false;
    if (change === "ban") state.tables.profiles![0].user_account_states = [{ state: "banned", expires_at: null }];
    if (change === "deleted") state.tables.profiles![0].account_status = "deleted";
    if (change === "missing_profile") state.tables.profiles = [];
    if (change === "read_error") state.failures.add("media_assets");
    await assert.rejects(state.acquire(state.source, state.limits), change);
    assert.equal(state.signs.length, 0, change); assert.equal(state.calls.length, 0, change);
  }
});

test("signed origins, exact paths, credentials, duplicate tokens and redirects cannot escape canonical storage", async () => {
  const goodPath = `/storage/v1/object/sign/post-media/${visualOwner}/${visualAsset}.png`;
  for (const url of [`https://evil.invalid${goodPath}?token=x`, `${visualOrigin}${goodPath.replace(visualOwner, visualOther)}?token=x`,
    `${visualOrigin}${goodPath}?token=x&token=y`, `${visualOrigin}${goodPath}?token=x&download=x`, `${visualOrigin}${goodPath}?token=x#x`,
    `https://user:password@synthetic-fixture.supabase.co${goodPath}?token=x`, `http://127.0.0.1${goodPath}?token=x`]) {
    const state = await fixture(); state.signed(url);
    await assert.rejects(state.acquire(state.source, state.limits)); assert.equal(state.calls.length, 0, url);
  }
  const state = await fixture();
  state.response(() => new Response(null, { status: 302, headers: { "Content-Type": "image/png", Location: "https://evil.invalid" } }));
  await assert.rejects(state.acquire(state.source, state.limits));
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0]?.options?.redirect, "error");
});

test("a canonical row cannot authorize another owner's storage prefix or a traversal-shaped key", async () => {
  for (const path of [`${visualOther}/image.png`, `${visualOwner}/../image.png`, `${visualOwner}/%2e%2e/image.png`, `${visualOwner}//image.png`]) {
    const state = await fixture(); state.asset.storage_path = path;
    await assert.rejects(state.acquire({ ...state.source, path }, state.limits));
    assert.equal(state.signs.length, 0); assert.equal(state.calls.length, 0);
  }
});

test("real JPEG and WebP decode successfully without changing original bytes", async () => {
  for (const format of ["jpeg", "webp"] as const) {
    const state = await fixture();
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).toFormat(format).toBuffer();
    state.asset.mime_type = `image/${format}`; state.asset.size_bytes = bytes.length;
    state.response(() => new Response(new Uint8Array(bytes), { headers: { "Content-Type": `image/${format}` } }));
    const acquired = await state.acquire({ ...state.source, sizeBytes: bytes.length }, state.limits);
    assert.deepEqual(acquired, bytes);
  }
});

test("rechecks generation and consent after signing and after download", async () => {
  const state = await fixture(); state.onSign(() => { state.asset.version++; });
  await assert.rejects(state.acquire(state.source, state.limits)); assert.equal(state.calls.length, 0);
  const revoked = await fixture(); revoked.response(() => {
    revoked.tables.media_visual_index_consents![0].revoked_at = new Date().toISOString();
    return new Response(new Uint8Array(revoked.bytes), { headers: { "Content-Type": "image/png" } });
  });
  await assert.rejects(revoked.acquire(revoked.source, revoked.limits)); assert.equal(revoked.calls.length, 1);
});

test("stream overflow, dishonest lengths, MIME spoofing, corrupt decode and pixel bombs all refuse", async () => {
  for (const mode of ["oversize", "length", "type", "corrupt", "pixels", "encoded"] as const) {
    const state = await fixture();
    if (mode === "oversize") state.response(() => new Response(new Uint8Array(Buffer.alloc(state.bytes.length + 1)), { headers: { "Content-Type": "image/png" } }));
    if (mode === "length") state.response(() => new Response(new Uint8Array(state.bytes), { headers: { "Content-Type": "image/png", "Content-Length": "2" } }));
    if (mode === "type") state.response(() => new Response(new Uint8Array(state.bytes), { headers: { "Content-Type": "text/html" } }));
    if (mode === "corrupt") state.response(() => { const corrupt = Buffer.alloc(state.bytes.length); state.bytes.copy(corrupt, 0, 0, 8); return new Response(new Uint8Array(corrupt), { headers: { "Content-Type": "image/png" } }); });
    if (mode === "pixels") state.limits.maxPixels = 32;
    if (mode === "encoded") state.response(() => new Response(new Uint8Array(state.bytes), { headers: { "Content-Type": "image/png", "Content-Encoding": "gzip" } }));
    await assert.rejects(state.acquire(state.source, state.limits), mode);
  }
});

test("cancellation stops a stalled stream and already-aborted work never signs", async () => {
  const state = await fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(state.acquire(state.source, { ...state.limits, signal: controller.signal })); assert.equal(state.signs.length, 0);
  const streaming = await fixture(); const cancel = new AbortController(); let cancelled = false;
  streaming.response(() => new Response(new ReadableStream({ start() { setTimeout(() => cancel.abort(), 10); }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "image/png" } }));
  await assert.rejects(streaming.acquire(streaming.source, { ...streaming.limits, signal: cancel.signal })); assert.equal(cancelled, true);
});

test("production handler factory supplies canonical acquisition without a test acquireImage seam", async () => {
  const state = await fixture(); const committed: any[] = []; let encoded = 0;
  const handler = createVisualIndexJobHandler(state, {
    fetch: state.transport,
    encoder: { modelId: VISUAL_MODEL_ID, async image(bytes) { assert.deepEqual(bytes, state.bytes); encoded++; return Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0); }, async text() { throw new Error("no text"); } },
    store: { async commit(entry) { committed.push(entry); }, async discard() {}, async erase() {}, async seed() { return []; }, async nearest() { return []; }, async current() { return []; } },
  });
  const result = await handler.handle({ job: { id: visualAsset, token: visualOther, assetId: visualAsset, ownerUserId: visualOwner, sourceVersion: 4,
    bucket: "post-media", path: state.source.path, sizeBytes: state.bytes.length, kind: "embedding", modelVersion: VISUAL_MODEL_ID,
    revisionKey: generationKey(state.source, `${VISUAL_MODEL_ID}:${visualOther}`) }, signal: state.limits.signal, isCurrent: async () => true });
  assert.equal(encoded, 1); assert.equal(state.signs.length, 1); assert.equal(committed.length, 1);
  assert.equal(committed[0].contentSha256, createHash("sha256").update(state.bytes).digest("hex"));
  assert.equal(result.inputBytes, state.bytes.length);
});
