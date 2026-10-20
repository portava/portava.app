import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import compassRouter, { feedCacheKey } from "../routes/compass.js";
import { _clearTestClient, _setTestClient, _setTestServiceClient } from "../lib/http.js";
import { _setTestNowUtc, clearUserTimezoneCache } from "../lib/localTime.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import {
  captureCacheBuild,
  clearL1Cache,
  getCachedFeed,
  invalidate,
  type CacheEntryType,
} from "../compass/CompassCacheEngine.js";

type Row = Record<string, unknown>;
type QueryResult = { data: Row | Row[] | null; error: null; count: number };
type Query = { table: string; columns: string; filters: Record<string, unknown> };
type Surface = "feed" | "section" | "frontload";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function readBarrier(matches: (query: Query) => boolean) {
  const entered = deferred<void>();
  const released = deferred<void>();
  let used = false;
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    async pause(query: Query) {
      if (used || !matches(query)) return;
      used = true;
      entered.resolve();
      await released.promise;
    },
  };
}

function fakeDatabase(userId: string, barrier: ReturnType<typeof readBarrier>) {
  const tables: Record<string, Row[]> = {
    profiles: [{ id: userId, account_status: "active", user_account_states: [], spoken_languages: ["en"] }],
    feature_flags: [
      { flag: "COMPASS_ENABLED", enabled: true },
      { flag: "COMPASS_FEED_ENABLED", enabled: true },
      { flag: "COMPASS_FALLBACK_MODE_ENABLED", enabled: false },
    ],
    compass_feed_cache: [],
    compass_cache_invalidations: [],
  };
  const upserts: Row[] = [];
  const unexpectedMethods: string[] = [];
  const reads: Query[] = [];

  function from(table: string) {
    const query: Query = { table, columns: "*", filters: {} };
    const predicates: Array<(row: Row) => boolean> = [];
    let operation: "read" | "delete" | "upsert" | "insert" | "update" = "read";
    let values: Row[] = [];
    let executed: Promise<QueryResult> | undefined;
    const execute = (single = false): Promise<QueryResult> => {
      if (executed) return executed;
      executed = (async () => {
        const matching = (tables[table] ?? []).filter((row) => predicates.every((predicate) => predicate(row)));
        if (operation === "read") {
          const snapshot = structuredClone(matching);
          const read = { ...query, filters: { ...query.filters } };
          reads.push(read);
          await barrier.pause(read);
          return { data: single ? snapshot[0] ?? null : snapshot, error: null, count: snapshot.length };
        }
        if (operation === "delete") {
          tables[table] = (tables[table] ?? []).filter((row) => !matching.includes(row));
        } else if (operation === "update") {
          for (const row of matching) Object.assign(row, values[0]);
        } else {
          for (const value of values) {
            if (table === "compass_feed_cache" && operation === "upsert") {
              upserts.push(structuredClone(value));
              tables[table] = tables[table]!.filter((row) => row.user_id !== value.user_id || row.cache_key !== value.cache_key);
            }
            (tables[table] ??= []).push(structuredClone(value));
          }
        }
        return { data: null, error: null, count: matching.length };
      })();
      return executed;
    };

    const builder = new Proxy({} as Record<string, unknown>, {
      get(_target, property: string) {
        if (property === "then") return (resolve: (result: QueryResult) => unknown, reject: (error: unknown) => unknown) => execute().then(resolve, reject);
        if (property === "maybeSingle" || property === "single") return () => execute(true);
        if (property === "select") return (columns = "*") => { query.columns = columns; return builder; };
        if (property === "eq" || property === "is") return (column: string, value: unknown) => {
          query.filters[column] = value;
          predicates.push((row) => row[column] === value);
          return builder;
        };
        if (property === "neq") return (column: string, value: unknown) => { predicates.push((row) => row[column] !== value); return builder; };
        if (property === "in") return (column: string, values: unknown[]) => { predicates.push((row) => values.includes(row[column])); return builder; };
        if (property === "gt" || property === "gte" || property === "lt" || property === "lte") return (column: string, value: string | number) => {
          predicates.push((row) => {
            const actual = row[column] as string | number;
            if (property === "gt") return actual > value;
            if (property === "gte") return actual >= value;
            if (property === "lt") return actual < value;
            return actual <= value;
          });
          return builder;
        };
        if (["like", "ilike", "order", "limit", "range", "or", "not"].includes(property)) return () => builder;
        if (property === "delete") return () => { operation = "delete"; return builder; };
        if (property === "insert" || property === "upsert" || property === "update") return (value: Row | Row[]) => {
          operation = property;
          values = Array.isArray(value) ? value : [value];
          return builder;
        };
        unexpectedMethods.push(`${table}.${property}`);
        throw new Error(`Unsupported fake query method ${table}.${property}`);
      },
    });
    return builder;
  }

  const db = {
    from,
    rpc: async () => ({ data: [], error: null }),
    auth: {
      getUser: async (token: string) => {
        assert.equal(token, "cache-build-route-token");
        return { data: { user: { id: userId } }, error: null };
      },
    },
  } as unknown as SupabaseClient;
  return { db, tables, upserts, unexpectedMethods, reads };
}

async function invoke(surface: Surface): Promise<Row> {
  const path = surface === "section" ? "/compass/feed/section/:section" : `/compass/${surface}`;
  const stack = (compassRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: { get?: boolean }; stack: Array<{ handle: RequestHandler }> } }>;
  }).stack;
  const route = stack.find((layer) => layer.route?.path === path && layer.route.methods.get)?.route;
  assert.ok(route, `real router handler exists for ${path}`);
  assert.equal(route.stack.length, 1);
  const errors: unknown[] = [];
  const request = {
    method: "GET",
    path,
    headers: { authorization: "Bearer cache-build-route-token" },
    params: { section: "for_you" },
    query: { tzOffsetMinutes: "0", network: "wifi", battery: "normal" },
    log: { info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
  } as unknown as Request;
  let statusCode = 200;
  let body: Row | undefined;
  const response = {
    status(code: number) { statusCode = code; return response; },
    json(payload: Row) { body = payload; return response; },
  } as unknown as Response;
  await route.stack[0]!.handle(request, response, (error?: unknown) => {
    throw error ?? new Error("unexpected next() from terminal handler");
  });
  assert.equal(statusCode, 200);
  assert.deepEqual(errors, [], "the normal build must finish without entering a fallback catch");
  assert.ok(body);
  if (surface === "frontload") {
    assert.equal(body.maxTier, 3);
    for (const tier of ["tier0", "tier1", "tier2", "tier3"]) assert.ok(Array.isArray(body[tier]));
  } else {
    assert.equal(body.fallback, false);
    assert.ok(Array.isArray(body.sections));
  }
  return body;
}

function cacheEntries(surface: Surface): Array<{ key: string; type: CacheEntryType }> {
  if (surface === "frontload") return [1, 2, 3].map((tier) => ({ key: `frontload:tier${tier}:wifi`, type: "frontload" }));
  return [{ key: feedCacheKey(surface === "section" ? "section:for_you" : "feed", undefined, 0, 13), type: surface === "section" ? "section" : "feed" }];
}

const settleWrites = () => new Promise<void>((resolve) => setImmediate(resolve));
let networkCalls = 0;

beforeEach(() => {
  clearL1Cache();
  clearCompassProfileCache();
  invalidateFlagsCache();
  clearUserTimezoneCache();
  _setTestNowUtc(new Date("2026-10-16T13:00:00Z"));
  networkCalls = 0;
  mock.method(globalThis, "fetch", async () => { networkCalls += 1; throw new Error("Network is forbidden in cache route tests"); });
});

afterEach(() => {
  mock.restoreAll();
  _clearTestClient();
  _setTestServiceClient(null);
  clearL1Cache();
  clearCompassProfileCache();
  invalidateFlagsCache();
  clearUserTimezoneCache();
  _setTestNowUtc(null);
  assert.equal(networkCalls, 0);
});

describe("Compass real route cache-build provenance", () => {
  const cases: Array<{ surface: Surface; boundary: string; matches: (query: Query) => boolean; earlierWrites?: number }> = [];
  for (const surface of ["feed", "section", "frontload"] as const) {
    cases.push({ surface, boundary: "profile loading", matches: (query) => query.table === "profiles" && query.columns.includes("spoken_languages") });
    cases.push({ surface, boundary: "candidate loading", matches: (query) => query.table === "posts" && query.columns.includes("canonical_place_id") });
  }
  cases.push({ surface: "frontload", boundary: "tier 2 data loading", matches: (query) => query.table === "buddy_profiles", earlierWrites: 1 });
  cases.push({ surface: "frontload", boundary: "tier 3 cache lookup", matches: (query) => query.table === "compass_feed_cache" && query.filters.cache_key === "frontload:tier3:wifi", earlierWrites: 2 });

  for (const { surface, boundary, matches, earlierWrites = 0 } of cases) {
    it(`${surface}: invalidation during ${boundary} fences old writes but allows a fresh request`, { timeout: 5_000 }, async () => {
      const userId = randomUUID();
      const barrier = readBarrier(matches);
      const fake = fakeDatabase(userId, barrier);
      _setTestClient(fake.db, true);
      const pending = invoke(surface);
      try {
        await Promise.race([barrier.entered, pending.then(() => { throw new Error(`route completed before reaching ${boundary}`); })]);
        await settleWrites();
        assert.equal(fake.upserts.length, earlierWrites);
        await invalidate(fake.db, userId, "route-build-race");
        assert.notEqual(captureCacheBuild(userId), null, "delete completed; suppression must be generation-based, not a stuck invalidation");
        assert.equal(fake.tables.compass_feed_cache!.length, 0);
        barrier.release();
        await pending;
        await settleWrites();
        assert.equal(fake.upserts.length, earlierWrites, "old build must not start any post-invalidation L2 upsert");
        assert.equal(fake.tables.compass_feed_cache!.length, 0, "old build must not restore L2 rows");
        for (const entry of cacheEntries(surface)) {
          assert.equal(await getCachedFeed(null, userId, entry.key, entry.type), null, `${entry.key} must not repopulate L1`);
        }

        const fresh = await invoke(surface);
        await settleWrites();
        const entries = cacheEntries(surface);
        assert.equal(fake.upserts.length - earlierWrites, entries.length, "a post-invalidation request still reaches every product cache writer");
        assert.deepEqual(fake.tables.compass_feed_cache!.map((row) => row.cache_key).sort(), entries.map((entry) => entry.key).sort());
        for (const [index, entry] of entries.entries()) {
          const expected = surface === "frontload" ? fresh[`tier${index + 1}`] : fresh;
          const cached = await getCachedFeed(null, userId, entry.key, entry.type);
          assert.notEqual(cached, null, `${entry.key} must populate L1 for the fresh request`);
          assert.deepEqual(cached, fake.tables.compass_feed_cache!.find((row) => row.cache_key === entry.key)?.payload);
          if (surface !== "frontload") assert.deepEqual(cached, expected);
        }
        clearL1Cache();
        for (const entry of entries) {
          const cached = await getCachedFeed(fake.db, userId, entry.key, entry.type);
          assert.notEqual(cached, null, `${entry.key} must also be readable from L2`);
          assert.deepEqual(cached, fake.tables.compass_feed_cache!.find((row) => row.cache_key === entry.key)?.payload);
        }
        assert.deepEqual(fake.unexpectedMethods, []);
      } finally {
        barrier.release();
        await pending;
      }
    });
  }
});
