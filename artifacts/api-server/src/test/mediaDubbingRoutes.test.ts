import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMediaDubbingRouter, type MediaDubbingDependencies } from "../routes/mediaDubbing.js";
import { DUBBING_DISCLOSURE_VERSION, DubbingError, type SyntheticSpeechEngine, type TimedDubbingInput } from "../lib/media/dubbing/contracts.js";
import { renderDubbing } from "../lib/media/dubbing/render.js";

const owner = "00000000-0000-4000-8000-000000000001";
const asset = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const jobId = "00000000-0000-4000-8000-000000000004";
const engine: SyntheticSpeechEngine = { id: "test-tone-not-speech", modelVersion: "fixture-1", language: "en-US", async synthesize() { return { sampleRate: 24000, samples: Buffer.alloc(12000, 20) }; } };
const source = (): TimedDubbingInput => ({ assetId: asset, ownerId: owner, requestedBy: owner, sourceVersion: 1, captionRevision: "a".repeat(64), translationRevision: "b".repeat(64), consentRevision: "c".repeat(64), targetLanguage: "en-US", optedIn: true, disclosureVersion: DUBBING_DISCLOSURE_VERSION, durationMs: 2000, cues: [{ startMs: 500, endMs: 1500, text: "Invented sentence." }] });
const requestBody = { explicitOptIn: true, targetLanguage: "en-US", disclosureVersion: DUBBING_DISCLOSURE_VERSION, expectedConsentRevision: "0".repeat(64) };

function fixture() {
  const state = { enabled: true, actor: owner as string | null, consent: false, held: false, queued: [] as unknown[], refuseQueue: false, reads: 0, revokeAfterRead: false };
  const dependencies: MediaDubbingDependencies = {
    enabled: async () => state.enabled, authenticate: async () => state.actor, engine,
    consentState: async ({ actorId }) => { if (actorId !== owner) throw new DubbingError("consent_required"); return { consentRevision: state.consent ? "c".repeat(64) : "0".repeat(64), optedIn: state.consent }; },
    queue: { enqueue: async (request) => { if (state.refuseQueue) return null; state.queued.push(request); return jobId; } },
    grantAndLoad: async ({ actorId }) => { if (actorId !== owner) throw new DubbingError("consent_required"); if (state.held) throw new DubbingError("source_revoked"); state.consent = true; return source(); },
    assertCurrent: async () => { if (!state.consent || state.held) throw new DubbingError("source_revoked"); },
    revoke: async ({ actorId }) => { if (actorId !== owner) throw new DubbingError("consent_required"); state.consent = false; state.queued = []; },
    read: async ({ viewerId }) => {
      state.reads++;
      if (viewerId !== owner || !state.consent || state.held) return null;
      const output = await renderDubbing(source(), engine, { signal: new AbortController().signal, assertCurrent: async () => {} });
      if (state.revokeAfterRead) state.consent = false;
      return output;
    },
    assertReadable: async ({ viewerId }) => { if (viewerId !== owner || !state.consent || state.held) throw new DubbingError("source_revoked"); },
  };
  return { state, dependencies };
}

async function server(dependencies: MediaDubbingDependencies | undefined, run: (url: string) => Promise<void>) {
  const app = express(); app.use(createMediaDubbingRouter(dependencies));
  const http = createServer(app);
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  try { await run(`http://127.0.0.1:${(http.address() as AddressInfo).port}/media/${asset}/dubbing`); }
  finally { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); }
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("unconfigured routes fail closed without storage or synthesis", async () => {
  await server(undefined, async (url) => {
    assert.equal((await post(url, requestBody)).status, 503);
    assert.equal((await fetch(`${url}/audio?language=en-US`)).status, 503);
  });
});

test("route preserves the supplied epoch token and refuses stale grants without rereading or enqueueing", async () => {
  const { state, dependencies } = fixture();
  const captured = "e".repeat(64);
  const received: string[] = [];
  let reads = 0;
  dependencies.consentState = async () => { reads++; return { consentRevision: "f".repeat(64), optedIn: false }; };
  dependencies.grantAndLoad = async (input) => { received.push(input.expectedConsentRevision); throw new DubbingError("source_revoked"); };
  await server(dependencies, async (url) => {
    assert.equal((await post(url, { ...requestBody, expectedConsentRevision: captured })).status, 409);
    assert.deepEqual(received, [captured]); assert.equal(reads, 0); assert.equal(state.queued.length, 0);
  });
});

test("explicit opt-in produces queued identity and private labeled output; revoke removes eligibility", async () => {
  const { state, dependencies } = fixture();
  await server(dependencies, async (url) => {
    const response = await post(url, requestBody);
    assert.equal(response.status, 202);
    assert.equal(state.consent, true);
    assert.equal(state.queued.length, 1);
    const queued = state.queued[0] as Record<string, unknown>;
    assert.equal(queued.kind, "dubbing"); assert.equal(queued.sourceVersion, 1);
    assert.match(String(queued.revisionKey), /^[a-f0-9]{64}$/);
    const audio = await fetch(`${url}/audio?language=en-US`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("cache-control"), "private, no-store");
    assert.equal(audio.headers.get("x-ai-generated"), "synthetic-dubbing");
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    const bytes = Buffer.from(await audio.arrayBuffer());
    assert.equal(bytes.length, 96044); assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
    state.enabled = false;
    assert.equal((await fetch(url, { method: "DELETE" })).status, 204);
    assert.equal(state.consent, false); assert.equal(state.queued.length, 0);
    state.enabled = true;
    assert.equal((await fetch(`${url}/audio?language=en-US`)).status, 404);
  });
});

test("missing consent, client text/voice overrides and unknown locales cannot enqueue", async () => {
  const { state, dependencies } = fixture();
  await server(dependencies, async (url) => {
    for (const body of [{ targetLanguage: "en-US" }, { ...requestBody, explicitOptIn: false }, { ...requestBody, text: "override" }, { ...requestBody, voiceReference: "/original.wav" }, { ...requestBody, targetLanguage: "fr-FR" }]) assert.equal((await post(url, body)).status, 400);
    assert.equal(state.consent, false); assert.equal(state.queued.length, 0);
  });
});

test("anonymous, non-owner and held sources cannot grant or enqueue", async () => {
  const { state, dependencies } = fixture();
  await server(dependencies, async (url) => {
    state.actor = null; assert.equal((await post(url, requestBody)).status, 401);
    state.actor = other; assert.equal((await post(url, requestBody)).status, 409);
    state.actor = owner; state.held = true; assert.equal((await post(url, requestBody)).status, 409);
    assert.equal(state.consent, false); assert.equal(state.queued.length, 0);
  });
});

test("queue refusal never returns a successful enqueue", async () => {
  const { state, dependencies } = fixture(); state.refuseQueue = true;
  await server(dependencies, async (url) => {
    assert.equal((await post(url, requestBody)).status, 503);
    assert.equal(state.queued.length, 0);
  });
});

test("missing TTS runtime blocks new work but never blocks withdrawing consent", async () => {
  const { state, dependencies } = fixture(); state.consent = true; dependencies.engine = undefined;
  await server(dependencies, async (url) => {
    assert.equal((await post(url, requestBody)).status, 503);
    assert.equal(state.queued.length, 0);
    assert.equal((await fetch(url, { method: "DELETE" })).status, 204);
    assert.equal(state.consent, false);
  });
});

test("oversized or malformed JSON returns bounded errors without diagnostic disclosure", async () => {
  const { state, dependencies } = fixture();
  await server(dependencies, async (url) => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"private-text":' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_input" });
    assert.equal((await post(url, { text: "x".repeat(3000) })).status, 413);
    assert.equal(state.queued.length, 0);
  });
});

test("revocation racing an audio read prevents response bytes", async () => {
  const { state, dependencies } = fixture(); state.consent = true; state.revokeAfterRead = true;
  await server(dependencies, async (url) => {
    const response = await fetch(`${url}/audio?language=en-US`);
    assert.equal(response.status, 409);
    assert.equal(state.consent, false);
    assert(!Buffer.from(await response.arrayBuffer()).includes(Buffer.from("RIFF")));
  });
});

test("corrupt or mislabeled audio is refused even when a store returns it", async () => {
  for (const corrupt of ["label", "bytes", "language"]) {
    const { state, dependencies } = fixture(); state.consent = true;
    const read = dependencies.read;
    dependencies.read = async (request) => {
      const output = (await read(request))!;
      if (corrupt === "label") (output.manifest as any).label = "Original voice";
      else if (corrupt === "language") output.manifest.language = "fr-FR";
      else output.audio[44] = 123;
      return output;
    };
    await server(dependencies, async (url) => { assert.equal((await fetch(`${url}/audio?language=en-US`)).status, 503); });
  }
});
