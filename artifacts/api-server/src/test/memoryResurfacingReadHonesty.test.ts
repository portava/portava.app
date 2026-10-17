import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTROLS_PAGE, keptPrivate, readMemoryControls, readRecapControls,
  MEMORY_RESURFACING_CONTROLS,
} from "../services/memory/memoryResurfacingControls.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const memoryId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";

function client(data: unknown, error: unknown = null) {
  const requests: Array<{ table: string; owner?: string; ids?: readonly string[] }> = [];
  return {
    requests,
    from(table: string) {
      const request: typeof requests[number] = { table };
      requests.push(request);
      const query = {
        select() { return query; },
        eq(column: string, value: string) {
          assert.equal(column, "owner_id");
          request.owner = value;
          return query;
        },
        in(column: string, values: readonly string[]) {
          assert.equal(column, "memory_id");
          request.ids = values;
          return query;
        },
        then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
          return Promise.resolve({ data, error }).then(resolve);
        },
      };
      return query;
    },
  };
}

describe("Memory resurfacing reads preserve unknown privacy state", () => {
  for (const invalid of [
    null, {}, [], "KEEP_PRIVATE_FOREVER",
    { memory_id: memoryId },
    { memory_id: memoryId, control: "UNKNOWN_CONTROL" },
    { memory_id: memoryId, control: null },
    { memory_id: null, control: "KEEP_PRIVATE_FOREVER" },
    { memory_id: 17, control: "KEEP_PRIVATE_FOREVER" },
    { memory_id: "", control: "KEEP_PRIVATE_FOREVER" },
    { memory_id: " ", control: "KEEP_PRIVATE_FOREVER" },
    { memory_id: "not-a-memory-id", control: "KEEP_PRIVATE_FOREVER" },
    { memory_id: "__proto__", control: "KEEP_PRIVATE_FOREVER" },
    { memory_id: `${memoryId}extra`, control: "KEEP_PRIVATE_FOREVER" },
  ]) {
    it(`refuses malformed rows rather than dropping a control: ${JSON.stringify(invalid)}`, async () => {
      const database = client([invalid]);
      assert.equal((await readMemoryControls(database, ownerId, [memoryId])).state, "unreadable");
      assert.equal((await readRecapControls(database, ownerId, [memoryId])).state, "unreadable");
      const privacy = await keptPrivate(database, ownerId, [memoryId]);
      assert.deepEqual(privacy.kept, [memoryId]);
      assert.notEqual(privacy.unreadable, null);
    });
  }

  it("rejects a filtered response containing an unrequested Memory", async () => {
    const database = client([{ memory_id: otherId, control: "KEEP_PRIVATE_FOREVER" }]);
    assert.equal((await readMemoryControls(database, ownerId, [memoryId])).state, "unreadable");
    assert.deepEqual(await readRecapControls(database, ownerId, [memoryId]), { state: "ok", byMemory: {} });
  });

  it("does not discard a malformed row alongside a valid control", async () => {
    const database = client([
      { memory_id: memoryId, control: "DO_NOT_RESURFACE" },
      { memory_id: memoryId, control: "keep_private_forever" },
    ]);
    assert.equal((await readMemoryControls(database, ownerId, [memoryId])).state, "unreadable");
    assert.equal((await readRecapControls(database, ownerId, [memoryId])).state, "unreadable");
  });

  it("preserves valid empty and known-control reads with owner filtering", async () => {
    assert.deepEqual(await readMemoryControls(client([]), ownerId, [memoryId]), { state: "ok", byMemory: new Map() });
    const database = client(MEMORY_RESURFACING_CONTROLS.map(control => ({ memory_id: memoryId, control })));
    const controls = await readMemoryControls(database, ownerId, [memoryId, memoryId]);
    assert.equal(controls.state, "ok");
    if (controls.state === "ok") assert.deepEqual(controls.byMemory.get(memoryId), new Set(MEMORY_RESURFACING_CONTROLS));
    assert.deepEqual(database.requests, [{ table: "memory_resurfacing_preferences", owner: ownerId, ids: [memoryId] }]);
    assert.deepEqual(await readRecapControls(database, ownerId, [memoryId]), { state: "ok", byMemory: { [memoryId]: [...MEMORY_RESURFACING_CONTROLS] } });
  });

  it("preserves table absence separately from permission and transport failure", async () => {
    for (const code of ["42P01", "PGRST205", "42501", "PGRST204", "57014"]) {
      const state = ["42P01", "PGRST205"].includes(code) ? "absent" : "unreadable";
      assert.equal((await readMemoryControls(client(null, { code }), ownerId, [memoryId])).state, state);
      assert.equal((await readRecapControls(client(null, { code }), ownerId, [memoryId])).state, state);
    }
  });

  it("refuses a full potentially truncated response", async () => {
    const database = client(Array.from({ length: CONTROLS_PAGE }, () => ({ memory_id: memoryId, control: "DO_NOT_RESURFACE" })));
    assert.equal((await readMemoryControls(database, ownerId, [memoryId])).state, "unreadable");
    assert.equal((await readRecapControls(database, ownerId, [memoryId])).state, "unreadable");
  });

  it("does not query an empty filtered selection", async () => {
    const database = client(null);
    assert.deepEqual(await readMemoryControls(database, ownerId, []), { state: "ok", byMemory: new Map() });
    assert.deepEqual(database.requests, []);
  });
});
