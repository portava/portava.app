import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDubbingStore } from "../lib/media/dubbing/store.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const storagePath = `synthetic-dubbing/${artifactId}.wav`;

function fixture(writeState: unknown) {
  const state = {
    artifact: { id: artifactId, storage_path: storagePath, storage_bucket: "dubbing-private", write_state: writeState } as Record<string, unknown> | null,
    removed: [] as string[],
    calls: [] as { name: string; parameters: Record<string, unknown> }[],
    removalFails: false,
    forgetSucceeds: true,
  };
  const client = {
    from() {
      const query = {
        select() { return query; }, eq() { return query; }, limit() { return query; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: [{ id: artifactId }], error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name: string, parameters: Record<string, unknown>) {
      state.calls.push({ name, parameters });
      if (name === "media_dubbing_retire") return { data: state.artifact, error: null };
      if (name === "media_dubbing_forget") return { data: state.forgetSucceeds, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
    storage: { from: () => ({ remove: async (paths: string[]) => {
      state.removed.push(...paths);
      return { data: [], error: state.removalFails ? { message: "synthetic storage failure" } : null };
    } }) },
  } as unknown as SupabaseClient;
  const store = createDubbingStore(client, "dubbing-private", {
    loadTranslatedSource: async () => { throw new Error("Generation is outside cleanup"); },
    canRead: async () => false,
  });
  return { state, store };
}

for (const writeState of ["pending", undefined, null, "", "unknown", true, 1]) {
  test(`unsettled or invalid writer state ${String(writeState)} refuses storage removal and receipt forgetting`, async () => {
    const { state, store } = fixture(writeState);
    await assert.rejects(store.eraseOwned(ownerId, assetId), /cleanup_failed/);
    assert.deepEqual(state.removed, []);
    assert.deepEqual(state.calls.map((call) => call.name), ["media_dubbing_retire"]);
    assert.deepEqual(state.calls[0]?.parameters, { p_id: artifactId, p_owner: ownerId, p_job: null, p_token: null });
  });
}

for (const writeState of ["uploaded", "aborted"]) {
  test(`${writeState} writer removes its exact object and only then forgets the retained receipt`, async () => {
    const { state, store } = fixture(writeState);
    assert.equal(await store.eraseOwned(ownerId, assetId), 1);
    assert.deepEqual(state.removed, [storagePath]);
    assert.deepEqual(state.calls.map((call) => call.name), ["media_dubbing_retire", "media_dubbing_forget"]);
    assert.deepEqual(state.calls[1]?.parameters, state.calls[0]?.parameters);
  });
}

test("storage failure preserves the positively settled receipt for retry", async () => {
  const { state, store } = fixture("uploaded");
  state.removalFails = true;
  await assert.rejects(store.eraseOwned(ownerId, assetId), /cleanup_failed/);
  assert.deepEqual(state.removed, [storagePath]);
  assert.deepEqual(state.calls.map((call) => call.name), ["media_dubbing_retire"]);
});

test("unacknowledged receipt forgetting cannot report successful cleanup", async () => {
  const { state, store } = fixture("uploaded");
  state.forgetSucceeds = false;
  await assert.rejects(store.eraseOwned(ownerId, assetId), /cleanup_failed/);
  assert.deepEqual(state.removed, [storagePath]);
  assert.equal(state.calls.at(-1)?.name, "media_dubbing_forget");
});

for (const changed of [{ id: ownerId }, { storage_path: "unrelated.wav" }, { storage_bucket: "post-media" }]) {
  test(`settled receipt with wrong ${Object.keys(changed)[0]} cannot delete an object`, async () => {
    const { state, store } = fixture("uploaded");
    Object.assign(state.artifact!, changed);
    await assert.rejects(store.eraseOwned(ownerId, assetId), /cleanup_failed/);
    assert.deepEqual(state.removed, []);
    assert.deepEqual(state.calls.map((call) => call.name), ["media_dubbing_retire"]);
  });
}

test("already absent retained receipt performs no object write", async () => {
  const { state, store } = fixture("uploaded");
  state.artifact = null;
  assert.equal(await store.eraseOwned(ownerId, assetId), 1);
  assert.deepEqual(state.removed, []);
  assert.deepEqual(state.calls.map((call) => call.name), ["media_dubbing_retire"]);
});
