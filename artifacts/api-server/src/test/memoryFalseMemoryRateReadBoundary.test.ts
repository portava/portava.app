import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  _resetMemoryQualityMetrics,
  noteCandidatesSurfaced,
  readFalseMemoryRate,
  type FalseMemoryRateResult,
} from "../services/memory/memoryQualityMetrics.js";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const episodeId = "10000000-0000-4000-8000-000000000001";
const memoryId = "20000000-0000-4000-8000-000000000001";
const startedAt = "2026-10-15T10:00:00.000Z";
const endedAt = "2026-10-15T11:00:00.000Z";
const tableNames = ["memory_episodes", "memory_evidence", "memories", "memory_id_redirects"] as const;
type Table = typeof tableNames[number];
type Row = Record<string, unknown>;
type Tables = Record<Table, Row[]>;
type Query = { table: Table; ids: { column: string; values: string[] } };
type Overrides = Partial<Record<Table, unknown>>;
type Setup = (tables: Tables, overrides: Overrides) => void;
const originalFetch = globalThis.fetch;

function defaults(): Tables {
  return {
    memory_episodes: [{ id: episodeId, user_id: ownerId, state: "confirmed" }],
    memory_evidence: [{ episode_id: episodeId, user_id: ownerId, source_id: memoryId }],
    memories: [{ id: memoryId, owner_id: ownerId, state: "published", starts_at: startedAt, ends_at: endedAt, location_city: "Sintra", location_country: "Portugal" }],
    memory_id_redirects: [],
  };
}

function register(count = 1) {
  _resetMemoryQualityMetrics();
  const candidates = Array.from({ length: count }, (_, index) => ({
    id: count === 1 ? episodeId : `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    startedAt, endedAt, city: "Lisbon", country: "Portugal",
  }));
  noteCandidatesSurfaced(ownerId, candidates);
  return candidates;
}

function fakeClient(tables: Tables, overrides: Overrides = {}) {
  const calls: Query[] = [];
  const counts: Partial<Record<Table, number>> = {};
  const client = {
    from(table: Table) {
      assert.ok(tableNames.includes(table));
      const query: Query = { table, ids: { column: "", values: [] } };
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        in(column: string, values: string[]) { query.ids = { column, values }; return builder; },
        async limit() {
          calls.push(query);
          counts[table] = (counts[table] ?? 0) + 1;
          if (Object.hasOwn(overrides, table)) {
            const override = overrides[table];
            return typeof override === "function" ? override(counts[table], query) : override;
          }
          return { data: tables[table].filter(row => query.ids.values.includes(row[query.ids.column] as string)), error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function expectUnknown(result: FalseMemoryRateResult) {
  assert.equal(result.status, "UNPRODUCIBLE");
  assert.equal(result.value, null);
  assert.equal(result.numerator, null);
  assert.equal(result.denominator, null);
  for (const kind of ["time", "place"] as const) {
    assert.equal(result.byAssertion[kind].status, "UNPRODUCIBLE");
    assert.equal(result.byAssertion[kind].value, null);
    assert.equal(result.byAssertion[kind].decided, null);
    assert.equal(result.byAssertion[kind].corrected, null);
  }
}

function expectKnown(result: FalseMemoryRateResult, expected: Partial<Record<"decided" | "kept" | "erased" | "undecided" | "merged" | "place" | "time", number>> = {}) {
  assert.deepEqual({
    decided: result.population.decided, kept: result.population.kept, erased: result.population.erased,
    undecided: result.population.undecided, merged: result.population.excludedMerged,
    place: result.byAssertion.place.corrected, time: result.byAssertion.time.corrected,
  }, { decided: 1, kept: 1, erased: 0, undecided: 0, merged: 0, place: 1, time: 0, ...expected });
  assert.notEqual(result.numerator, null);
  assert.notEqual(result.denominator, null);
}

function readerCase(name: string, setup: Setup, expectResult: (result: FalseMemoryRateResult) => void = expectUnknown) {
  it(name, async () => {
    const tables = defaults();
    const overrides: Overrides = {};
    setup(tables, overrides);
    const { client } = fakeClient(tables, overrides);
    expectResult(await readFalseMemoryRate(client));
  });
}

beforeEach(() => {
  register();
  globalThis.fetch = async () => { throw new Error("Network forbidden in H217 fixtures"); };
});

afterEach(() => {
  _resetMemoryQualityMetrics();
  globalThis.fetch = originalFetch;
});

describe("H217 valid and compatibility controls", () => {
  readerCase("corrected place", () => {}, result => expectKnown(result));
  readerCase("unchanged place", tables => { tables.memories[0].location_city = "Lisbon"; }, result => expectKnown(result, { place: 0 }));
  readerCase("explicit nullable time and place are clears", tables => {
    Object.assign(tables.memories[0], { starts_at: null, ends_at: null, location_city: null, location_country: null });
  }, result => expectKnown(result, { time: 1 }));
  readerCase("blank text is an explicit clear", tables => { tables.memories[0].location_city = ""; }, result => expectKnown(result));
  readerCase("normalization and equivalent offset timestamps", tables => {
    Object.assign(tables.memories[0], { starts_at: "2026-10-15T12:00:00+02:00", ends_at: "2026-10-15T13:00:00+02:00", location_city: "  LISBON ", location_country: "PORTUGAL" });
  }, result => expectKnown(result, { place: 0 }));
  readerCase("nullable kept-state interface compatibility", tables => { tables.memories[0].state = null; }, result => expectKnown(result));
  readerCase("future episode state is undecided", tables => { tables.memory_episodes[0].state = "future_state"; }, result => expectKnown(result, { decided: 0, kept: 0, undecided: 1, place: 0 }));
  readerCase("genuinely absent episode", tables => { tables.memory_episodes = []; }, result => expectKnown(result, { decided: 0, kept: 0, erased: 1, place: 0 }));
  readerCase("well-formed foreign episode owner", tables => { tables.memory_episodes[0].user_id = otherId; }, result => expectKnown(result, { decided: 0, kept: 0, erased: 1, place: 0 }));
  readerCase("genuinely empty links", tables => { tables.memory_evidence = []; }, result => expectKnown(result, { decided: 0, kept: 0, undecided: 1, place: 0 }));
  readerCase("foreign evidence owner is not an owner Keep", tables => { tables.memory_evidence[0].user_id = otherId; }, result => expectKnown(result, { decided: 0, kept: 0, undecided: 1, place: 0 }));
  readerCase("evidence source_id remains TEXT", tables => { tables.memory_evidence[0].source_id = ""; }, result => expectKnown(result, { decided: 0, kept: 0, undecided: 1, place: 0 }));
  readerCase("genuinely absent kept Memory", tables => { tables.memories = []; }, result => expectKnown(result, { kept: 0, place: 0 }));
  readerCase("deleted Memory is not a correction", tables => { tables.memories[0].state = "deleted"; }, result => expectKnown(result, { kept: 0, place: 0 }));
  readerCase("actual merge survivor is excluded", tables => { tables.memory_id_redirects = [{ new_memory_id: memoryId }]; }, result => expectKnown(result, { decided: 0, kept: 0, merged: 1, place: 0 }));
  for (const error of [
    { code: "42P01", message: 'relation "public.memory_id_redirects" does not exist' },
    { code: "PGRST205", message: "Could not find the table" },
    { message: 'relation "public.memory_id_redirects" does not exist' },
  ]) readerCase(`explicit merge table absence ${"code" in error ? error.code : "exact-message"}`, (_tables, overrides) => {
    overrides.memory_id_redirects = { data: null, error };
  }, result => expectKnown(result));
  for (const code of ["42501", "42703", "PGRST204", "PGRST200"]) readerCase(`merge ${code} is not table absence`, (_tables, overrides) => {
    overrides.memory_id_redirects = { data: null, error: { code, message: "denied or incomplete" } };
  });
});

describe("H217 whole-read honesty", () => {
  for (const table of tableNames) {
    for (const [name, reply] of [
      ["null data", { data: null, error: null }],
      ["missing data", { error: null }],
      ["missing error", { data: defaults()[table] }],
      ["false error", { data: defaults()[table], error: false }],
      ["string data", { data: "[]", error: null }],
      ["object data", { data: {}, error: null }],
      ["null envelope", null],
    ]) readerCase(`${table}: ${name}`, (_tables, overrides) => { overrides[table] = reply; });
    for (const [name, row] of [["empty row", {}], ["array row", []], ["null row", null]]) {
      readerCase(`${table}: ${name}`, (_tables, overrides) => { overrides[table] = { data: [row], error: null }; });
    }
  }
  const coercions: Array<[Table, string, unknown]> = [
    ["memory_episodes", "id", [episodeId]], ["memory_episodes", "user_id", [ownerId]],
    ["memory_episodes", "state", ["confirmed"]], ["memory_episodes", "state", null],
    ["memory_episodes", "user_id", null], ["memory_episodes", "id", null],
    ["memory_evidence", "episode_id", [episodeId]], ["memory_evidence", "user_id", [ownerId]],
    ["memory_evidence", "source_id", [memoryId]], ["memory_evidence", "source_id", null],
    ["memory_evidence", "source_id", 23],
    ["memories", "id", [memoryId]], ["memories", "owner_id", [ownerId]],
    ["memories", "state", ["published"]], ["memories", "location_city", { name: "Lisbon" }],
    ["memories", "location_city", ["Lisbon"]], ["memories", "location_country", false],
    ["memories", "starts_at", [startedAt]], ["memories", "ends_at", 23],
    ["memory_id_redirects", "new_memory_id", [memoryId]], ["memory_id_redirects", "new_memory_id", null],
  ];
  for (const [table, field, value] of coercions) readerCase(`${table}: no coercion of ${field}=${JSON.stringify(value)}`, (tables, overrides) => {
    const row: Row = table === "memory_id_redirects" ? { new_memory_id: memoryId } : { ...tables[table][0] };
    row[field] = value;
    overrides[table] = { data: [row], error: null };
  });
  for (const field of ["state", "starts_at", "ends_at", "location_city", "location_country"]) {
    readerCase(`missing selected Memory ${field} is not explicit null`, (tables, overrides) => {
      const row = { ...tables.memories[0] };
      delete row[field];
      overrides.memories = { data: [row], error: null };
    });
  }
  for (const table of ["memory_evidence", "memory_id_redirects"] as const) {
    readerCase(`${table}: full page is possibly truncated`, (tables, overrides) => {
      const row = table === "memory_id_redirects" ? { new_memory_id: memoryId } : tables[table][0];
      overrides[table] = { data: Array.from({ length: 1000 }, () => ({ ...row })), error: null };
    });
  }
  readerCase("later episode chunk returning null invalidates the whole metric", (tables, overrides) => {
    const candidates = register(101);
    tables.memory_episodes = candidates.map(candidate => ({ id: candidate.id, user_id: ownerId, state: "confirmed" }));
    overrides.memory_episodes = (count: number, query: Query) => ({ data: count === 2 ? null : tables.memory_episodes.filter(row => query.ids.values.includes(row.id as string)), error: null });
  });
});

describe("H217 installed Supabase client decoding", () => {
  for (const table of tableNames) {
    it(`${table}: actual HTTP 200 null is not an empty successful read`, async () => {
      const tables = defaults();
      const requests: string[] = [];
      const client = createClient("http://127.0.0.1:9", "dummy", {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: async (input, options) => {
          const url = new URL(String(input));
          const current = url.pathname.split("/").at(-1) as Table;
          assert.equal(url.origin, "http://127.0.0.1:9");
          assert.ok(tableNames.includes(current));
          assert.equal(options?.method, "GET");
          requests.push(current);
          return new Response(JSON.stringify(current === table ? null : tables[current]), { status: 200, headers: { "Content-Type": "application/json" } });
        } },
      });
      expectUnknown(await readFalseMemoryRate(client));
      assert.ok(requests.includes(table));
    });
  }
});

describe("H217 source-specific errors and all-chunk boundaries", () => {
  for (const table of tableNames) {
    for (const failure of ["throw", "null envelope", "null data", "malformed row"]) {
      readerCase(`${table}: ${failure} names its source without leaking rows`, (_tables, overrides) => {
        overrides[table] = failure === "throw" ? () => { throw new Error("sensitive fixture error"); }
          : failure === "null envelope" ? null
          : { data: failure === "null data" ? null : [{ private_fixture: "not-for-output" }], error: null };
      }, result => {
        expectUnknown(result);
        assert.match(String(result.blockedBy), new RegExp(table));
        assert.doesNotMatch(JSON.stringify(result), /sensitive fixture|not-for-output/);
      });
    }
    readerCase(`${table}: valid first chunk cannot rescue malformed second chunk`, (tables, overrides) => {
      const candidates = register(101);
      tables.memory_episodes = candidates.map(candidate => ({ id: candidate.id, user_id: ownerId, state: "confirmed" }));
      tables.memories = candidates.map((_, index) => ({ ...defaults().memories[0], id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
      tables.memory_evidence = candidates.map((candidate, index) => ({ episode_id: candidate.id, user_id: ownerId, source_id: tables.memories[index].id }));
      overrides[table] = (count: number, query: Query) => ({ data: count === 2 ? null : tables[table].filter(row => query.ids.values.includes(row[query.ids.column] as string)), error: null });
    }, result => {
      expectUnknown(result);
      assert.match(String(result.blockedBy), new RegExp(table));
      assert.equal(result.population.tracked, 101);
      assert.equal(result.byAssertion.place.surfaced, 101);
    });
  }
  const uuidColumns: Array<[Table, string]> = [
    ["memory_episodes", "id"], ["memory_episodes", "user_id"],
    ["memory_evidence", "episode_id"], ["memory_evidence", "user_id"],
    ["memories", "id"], ["memories", "owner_id"], ["memory_id_redirects", "new_memory_id"],
  ];
  for (const [table, field] of uuidColumns) {
    for (const value of ["", "not-a-uuid", ` ${ownerId} `]) readerCase(`${table}.${field} rejects malformed UUID scalar ${JSON.stringify(value)}`, (tables, overrides) => {
      overrides[table] = { data: [{ ...(tables[table][0] ?? {}), [field]: value }], error: null };
    });
  }
  readerCase("a good row does not hide a malformed adjacent row", (tables, overrides) => {
    overrides.memories = { data: [...tables.memories, { id: memoryId, owner_id: ownerId }], error: null };
  });
  readerCase("repeated valid merge survivors are not malformed duplicates", tables => {
    tables.memory_id_redirects = [{ new_memory_id: memoryId }, { new_memory_id: memoryId }];
  }, result => expectKnown(result, { decided: 0, kept: 0, merged: 1, place: 0 }));
});
