import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import memoryCandidatesRouter from "../routes/memoryCandidates.js";
import { resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";
import { _resetKernelIds, makeKernelRpc, type KernelState } from "./memoryCommandKernelFake.js";
import { _resetMemoryQualityMetrics, noteCandidatesSurfaced, readFalseMemoryRate } from "../services/memory/memoryQualityMetrics.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const episodeId = "44444444-4444-4444-8444-444444444444";
const startsAt = "2026-03-02T19:00:12.123456+00:00";
const endsAt = "2026-03-02T20:30:13.654321+00:00";
type Row = Record<string, any>;

function fixture(kernelOn: boolean): KernelState {
  return { rpcCalls: [], failOn: new Set(), absent: false, tables: {
    feature_flags: kernelOn ? [{ flag: "memory_kernel_enabled", enabled: true }] : [],
    profiles: [ownerId, otherId].map(id => ({ id, account_status: "active", role: "user", handle: "fixture" })),
    memories: [{ id: memoryId, owner_id: ownerId, title: "Coffee", caption: "Owner words", visibility: "only_me",
      trip_id: null, event_id: null, place_id: null, location_city: null, location_country: null,
      location_lat: null, location_lng: null, canonical_location_id: null, allowed_user_ids: [], hidden_user_ids: [],
      starts_at: startsAt, ends_at: endsAt, state: "published", created_at: startsAt, updated_at: startsAt }],
    memory_episodes: [{ id: episodeId, user_id: ownerId, episode_kind: "meal", summary: "Coffee",
      started_at: startsAt, ended_at: endsAt, place_id: null, city: null, country: null, detection_reason: "media_cluster",
      detector_version: 1, detection_digest: "fixture", significance: 1, significance_basis: "user_affirmed",
      state: "confirmed", state_changed_at: startsAt, merged_into_id: null, sensitivity: "normal", visibility: "private",
      retention_class: "trip_context", created_at: startsAt, updated_at: startsAt }],
    memory_evidence: [{ id: "55555555-5555-4555-8555-555555555555", user_id: ownerId, episode_id: episodeId,
      source_table: "memories", source_id: memoryId, truth_level: "asserted", source_class: "explicit",
      source_ref: { confirmed_by: "owner" }, observed_at: startsAt }],
    media_assets: [{ id: "66666666-6666-4666-8666-666666666666", owner_id: ownerId, captured_at: startsAt,
      provenance: { source: "camera" } }],
    memory_items: [], memory_tags: [], memory_command_audit: [], memory_command_receipts: [],
    memory_domain_events: [], memory_event_outbox: [],
  } };
}

function makeClient(state: KernelState, writes: Array<{ table: string; patch: Row }>, failures: Set<string>) {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let patch: Row | undefined;
    let single = false;
    let limit = Infinity;
    const chain: any = {
      select() { return chain; },
      update(value: Row) { patch = value; return chain; },
      eq(column: string, value: unknown) { filters.push(row => row[column] === value); return chain; },
      neq(column: string, value: unknown) { filters.push(row => row[column] !== value); return chain; },
      is(column: string, value: unknown) { filters.push(row => row[column] === value); return chain; },
      in(column: string, values: unknown[]) { filters.push(row => values.includes(row[column])); return chain; },
      limit(value: number) { limit = value; return chain; },
      order() { return chain; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(resolve: any, reject: any) { return run().then(resolve, reject); },
    };
    async function run() {
      if (failures.has(table)) return { data: null, error: { code: "57014", message: "Fixture unavailable" } };
      const rows = (state.tables[table] ?? []).filter(row => filters.every(filter => filter(row))).slice(0, limit);
      if (patch) {
        writes.push({ table, patch: structuredClone(patch) });
        for (const row of rows) Object.assign(row, patch);
      }
      return { data: single ? structuredClone(rows[0] ?? null) : structuredClone(rows), error: null, count: rows.length };
    }
    return chain;
  }
  return { from, rpc: makeKernelRpc(state),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) } };
}

async function start(kernelOn = false) {
  const state = fixture(kernelOn);
  const writes: Array<{ table: string; patch: Row }> = [];
  const failures = new Set<string>();
  const client = makeClient(state, writes, failures);
  _setTestClient(client as any, true);
  const app = express();
  app.use(express.json());
  app.use((request: any, _response, next) => {
    request.log = { error() {}, warn() {}, info() {}, debug() {} }; next();
  });
  app.use("/api", memoriesRouter);
  app.use("/api", memoryCandidatesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { state, writes, failures, client, base,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
    }),
  };
}

type App = Awaited<ReturnType<typeof start>>;
let app: App | undefined;
async function call(body: unknown, actor: string | null = ownerId, method = "PATCH", path = `/api/memories/${memoryId}`) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Idempotency-Key": "time-editor-fixture", connection: "close" };
  if (actor) headers.Authorization = `Bearer ${actor}`;
  const response = await fetch(app!.base + path, { method, headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const memory = () => app!.state.tables.memories![0]!;
const evidence = () => structuredClone({ episodes: app!.state.tables.memory_episodes,
  links: app!.state.tables.memory_evidence, media: app!.state.tables.media_assets });

beforeEach(() => { _resetKernelIds(); resetHighlightSchemaMemo(); _resetMemoryQualityMetrics(); });
afterEach(async () => { await app?.close(); app = undefined; _setTestClient(null, false); _resetMemoryQualityMetrics(); });

describe("H217 existing owner time PATCH contract — mounted router, synthetic storage", () => {
  for (const kernelOn of [false, true]) {
    it(`saves exact supplied time fields through the existing command with kernel=${kernelOn}`, async () => {
      app = await start(kernelOn); const before = evidence();
      const corrected = "2026-03-02T18:15:02.123456+00:00";
      const result = await call({ startsAt: corrected });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.memory.startsAt, corrected); assert.equal(result.body.memory.endsAt, endsAt);
      assert.equal(memory().starts_at, corrected); assert.deepEqual(evidence(), before);
      if (kernelOn) {
        assert.equal(app.state.rpcCalls[0]!.args.p_command.type, "UPDATE_MEMORY");
        assert.equal(app.state.tables.memory_domain_events![0]!.type, "memory.corrected");
      } else {
        assert.deepEqual(app.writes.map(write => write.table), ["memories"]);
        assert.equal(app.state.rpcCalls.length, 0);
      }
    });

    it(`preserves the current editor's audience command precedence with kernel=${kernelOn}`, async () => {
      app = await start(kernelOn);
      const result = await call({ title: "Coffee", caption: "Owner words", visibility: "only_me", endsAt: null });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(memory().ends_at, null); assert.equal(memory().starts_at, startsAt);
      if (kernelOn) assert.equal(app.state.rpcCalls[0]!.args.p_command.type, "CHANGE_VISIBILITY");
    });

    for (const field of ["startsAt", "endsAt"]) {
      it(`explicit null clears ${field}, omission preserves its peer with kernel=${kernelOn}`, async () => {
        app = await start(kernelOn);
        const result = await call({ [field]: null });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.memory[field], null);
        assert.equal(result.body.memory[field === "startsAt" ? "endsAt" : "startsAt"], field === "startsAt" ? endsAt : startsAt);
      });
    }

    it(`omitted times remain byte-identical on an unrelated patch with kernel=${kernelOn}`, async () => {
      app = await start(kernelOn);
      assert.equal((await call({ caption: "Edited caption" })).status, 200);
      assert.equal(memory().starts_at, startsAt); assert.equal(memory().ends_at, endsAt);
    });
  }

  for (const value of ["", "2026-03-02", "2026-03-02T19:00:00", "2026-02-30T19:00:00Z", "not a time", 17, []]) {
    it(`rejects malformed timestamp ${JSON.stringify(value)} before a command`, async () => {
      app = await start(true); const before = structuredClone(memory());
      const result = await call({ startsAt: value });
      assert.equal(result.status, 400); assert.equal(result.body.error, "invalid_payload");
      assert.deepEqual(memory(), before); assert.equal(app.writes.length, 0); assert.equal(app.state.rpcCalls.length, 0);
    });
  }

  for (const actor of [null, otherId]) {
    it(`refuses ${actor === null ? "anonymous" : "another owner's"} edits without writes`, async () => {
      app = await start(); const before = structuredClone(memory());
      const result = await call({ startsAt: null }, actor);
      assert.equal(result.status, actor === null ? 401 : 403);
      assert.deepEqual(memory(), before); assert.equal(app.writes.length, 0);
    });
  }

  it("refuses an unavailable kernel instead of silently using the legacy write", async () => {
    app = await start(true); app.state.absent = true;
    assert.equal((await call({ startsAt: null })).status, 503);
    assert.equal(memory().starts_at, startsAt); assert.equal(app.writes.length, 0);
  });

  it("refuses an unreadable canonical row rather than acknowledging a correction", async () => {
    app = await start(); app.failures.add("memories");
    assert.equal((await call({ startsAt: null })).status, 500);
    assert.equal(memory().starts_at, startsAt); assert.equal(app.writes.length, 0);
  });

  it("reads the changed canonical value for H217 without rewriting inferred episode or capture evidence", async () => {
    app = await start(); const before = evidence();
    noteCandidatesSurfaced(ownerId, [{ id: episodeId, startedAt: startsAt, endedAt: endsAt, city: null, country: null }]);
    assert.equal((await readFalseMemoryRate(app.client as any)).byAssertion.time.corrected, 0);
    assert.equal((await call({ startsAt: "2026-03-02T18:00:00.123456Z" })).status, 200);
    assert.equal((await readFalseMemoryRate(app.client as any)).byAssertion.time.corrected, 1);
    assert.deepEqual(evidence(), before);
    assert.equal((await call({ startsAt })).status, 200);
    assert.equal((await readFalseMemoryRate(app.client as any)).byAssertion.time.corrected, 0);
  });

  it("an existing Keep replay does not replace the owner's corrected time", async () => {
    app = await start(); const before = evidence();
    const corrected = "2026-03-02T18:00:00Z";
    assert.equal((await call({ startsAt: corrected })).status, 200);
    const result = await call({}, ownerId, "POST", `/api/me/memory-candidates/${episodeId}/confirm`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.memoryId, memoryId); assert.equal(result.body.replayed, true);
    assert.equal(memory().starts_at, corrected); assert.deepEqual(evidence(), before);
  });
});
