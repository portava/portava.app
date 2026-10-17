import assert from "node:assert/strict";
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { createMediaVisualIndexRouter } from "../routes/mediaVisualIndex.js";
import { generationKey, VISUAL_MODEL_ID } from "../lib/media/visualIndex/contracts.js";
import { visualAsset, visualOther, visualOwner, visualSidecarFixture } from "./helpers/mediaVisualSidecarFixture.js";

const ambientFetch = globalThis.fetch;
const redisUrl = process.env.REDIS_URL;
beforeEach(() => { delete process.env.REDIS_URL; _resetRateLimit(); globalThis.fetch = async () => { throw new Error("ambient fetch forbidden in consent API"); }; });
afterEach(() => { globalThis.fetch = ambientFetch; if (redisUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = redisUrl; _setTestClient(null, false); _clearTestClient(); });

async function request(fixture: ReturnType<typeof visualSidecarFixture>, method: string, action: string, body: unknown, token = "owner") {
  _setTestClient(fixture.sc, true);
  const app = express(); app.use(express.json({ limit: "4kb" })); app.use(createMediaVisualIndexRouter(fixture.env));
  const socket = new Socket();
  try {
    return await new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const incoming = new http.IncomingMessage(socket);
      incoming.method = method; incoming.url = `/media/visual-index/${visualAsset}/${action}`;
      incoming.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)), ...(token ? { authorization: `Bearer ${token}` } : {}) };
      const response = new http.ServerResponse(incoming);
      const timeout = setTimeout(() => reject(new Error("in-memory route timeout")), 2000);
      const end = response.end;
      response.end = ((chunk?: any, ...args: any[]) => {
        clearTimeout(timeout);
        try {
          const text = chunk ? Buffer.from(chunk).toString() : "";
          const result = { status: response.statusCode, body: text ? JSON.parse(text) : null, headers: response.getHeaders() as http.IncomingHttpHeaders };
          end.call(response, chunk, ...args); resolve(result);
        } catch (error) { reject(error); }
        return response;
      }) as typeof response.end;
      app(incoming, response);
      incoming.push(payload); incoming.push(null);
    });
  } finally { socket.destroy(); }
}

const grantBody = () => ({ sourceVersion: 4, scope: "media_visual_index", expiresAt: new Date(Date.now() + 60_000).toISOString() });

test("authenticated owner consent persists a grant and queues only the exact canonical generation", async () => {
  const fixture = visualSidecarFixture(); const body = grantBody();
  const reply = await request(fixture, "POST", "consent", body);
  assert.equal(reply.status, 202); assert.equal(reply.body.state, "queued");
  assert.equal(reply.headers["cache-control"], "private, no-store");
  const grant = fixture.tables.media_visual_index_consents![0];
  assert.equal(grant.owner_id, visualOwner); assert.equal(grant.source_version, 4);
  assert.equal(fixture.jobs.size, 1); assert.equal(fixture.signs.length, 0);
  const queued = [...fixture.jobs.values()][0];
  assert.equal(queued.p_owner_user_id, visualOwner);
  assert.equal(queued.p_revision_key, generationKey({ assetId: visualAsset, sourceVersion: 4, bucket: "post-media", path: fixture.asset.storage_path }, `${VISUAL_MODEL_ID}:${grant.revision}`));
  assert.equal((await request(fixture, "POST", "enqueue", { sourceVersion: 4 })).status, 202);
  assert.equal(fixture.jobs.size, 1); assert.equal(fixture.tables.media_visual_index_consents![0].revision, grant.revision);
});

test("anonymous, forged body actors and another owner cannot grant, revoke or enqueue", async () => {
  const fixture = visualSidecarFixture();
  assert.equal((await request(fixture, "POST", "consent", grantBody(), "")).status, 401);
  assert.equal((await request(fixture, "POST", "consent", { ...grantBody(), actorId: visualOwner }, "other")).status, 400);
  for (const [method, action, body] of [["POST", "consent", grantBody()], ["POST", "enqueue", { sourceVersion: 4 }], ["DELETE", "consent", { sourceVersion: 4 }]] as const) {
    assert.equal((await request(fixture, method, action, body, "other")).status, 404);
  }
  assert.equal(fixture.rpcCalls.length, 0); assert.equal(fixture.jobs.size, 0); assert.equal(fixture.tables.media_visual_index_consents!.length, 0);
});

test("missing/stale generations, unsafe owner paths, invalid expiry and default OFF never grant", async () => {
  for (const patch of [{ sourceVersion: undefined }, { sourceVersion: 3 }, { expiresAt: "not-a-date" }, { expiresAt: new Date(Date.now() + 31 * 86400000).toISOString() }]) {
    const fixture = visualSidecarFixture(); const reply = await request(fixture, "POST", "consent", { ...grantBody(), ...patch });
    assert.ok([400, 404].includes(reply.status)); assert.equal(fixture.rpcCalls.length, 0);
  }
  const fixture = visualSidecarFixture(); fixture.asset.storage_path = `${visualOther}/image.png`;
  assert.equal((await request(fixture, "POST", "consent", grantBody())).status, 404);
  fixture.asset.storage_path = `${visualOwner}/image.png`; fixture.env.MEDIA_VISUAL_INDEX_ENABLED = "0";
  assert.equal((await request(fixture, "POST", "consent", grantBody())).status, 404);
  assert.equal(fixture.rpcCalls.length, 0);
});

test("OFF revoke works for held/deleted media, erases vectors and never deletes shared storage", async () => {
  const fixture = visualSidecarFixture(); fixture.grant(); fixture.tables.media_visual_embeddings = [{ asset_id: visualAsset }];
  fixture.env.MEDIA_VISUAL_INDEX_ENABLED = "0"; fixture.asset.moderation_status = "owner_deleted"; fixture.asset.purge_status = "pending";
  const reply = await request(fixture, "DELETE", "consent", { sourceVersion: 4 });
  assert.equal(reply.status, 204); assert.ok(fixture.tables.media_visual_index_consents![0].revoked_at);
  assert.equal(fixture.tables.media_visual_embeddings!.length, 0); assert.equal(fixture.signs.length, 0); assert.equal(fixture.jobs.size, 0);
  assert.equal(fixture.rpcCalls[0]?.args.p_actor_id, visualOwner);
});

test("write/read errors cannot report a grant, queue success or completed revoke", async () => {
  const fixture = visualSidecarFixture(); fixture.failures.add("media_visual_index_consent");
  assert.equal((await request(fixture, "POST", "consent", grantBody())).status, 503);
  assert.equal(fixture.tables.media_visual_index_consents!.length, 0);
  fixture.failures.clear(); fixture.failures.add("media_derivative_enqueue");
  const reply = await request(fixture, "POST", "consent", grantBody());
  assert.equal(reply.status, 503); assert.equal(reply.body.consentGranted, true); assert.equal(reply.body.queued, null); assert.equal(reply.body.state, "queue_unconfirmed");
  assert.equal(fixture.jobs.size, 0); assert.equal(fixture.tables.media_visual_index_consents!.length, 1);
  fixture.failures.clear(); fixture.failures.add("media_visual_index_consents");
  assert.equal((await request(fixture, "POST", "enqueue", { sourceVersion: 4 })).status, 503);
  fixture.failures.clear(); fixture.failures.add("media_visual_embeddings");
  assert.equal((await request(fixture, "DELETE", "consent", { sourceVersion: 4 })).status, 503);
});

test("ban/unreadable account gates and revoked consent prevent enqueue", async () => {
  const fixture = visualSidecarFixture();
  assert.equal((await request(fixture, "POST", "enqueue", { sourceVersion: 4 })).status, 404);
  fixture.tables.profiles![0].user_account_states = [{ state: "banned", expires_at: null }];
  assert.equal((await request(fixture, "POST", "consent", grantBody())).status, 403);
  fixture.tables.profiles![0].user_account_states = []; fixture.failures.add("profiles");
  assert.equal((await request(fixture, "POST", "consent", grantBody())).status, 503);
  assert.equal(fixture.rpcCalls.length, 0); assert.equal(fixture.jobs.size, 0);
});
