import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createClient } from "@supabase/supabase-js";
import router from "../routes/adminLayoverMetrics.js";
import { _clearTestClient, _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import {
  certifiedComputationRowFor,
  decisionsInWindow,
  storedComputationsInWindow,
} from "../services/layover/LayoverDecisionStore.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";

type Source = "events" | "generations" | "decisions" | "replay";
type ResponsePatch = { data?: unknown; count?: unknown; error?: unknown };
type FixtureOptions = {
  total?: number;
  cap?: number;
  persistence?: boolean;
  source?: Source;
  patch?: ResponsePatch;
};

const fromIso = "2000-01-01T00:00:00.000Z";
const toIso = "2100-01-01T00:00:00.000Z";
const computedMs = Date.now() - 3_600_000;
const record = certifySessionFeasibility({
  id: "fixture-airport", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
  domesticBufferMin: 60, internationalBufferMin: 120,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
}, {
  id: "fixture-session", arrivalTime: new Date(computedMs).toISOString(),
  departureTime: new Date(computedMs + 10 * 3_600_000).toISOString(),
  boardingTime: null, flightType: "international", immigrationRequired: true,
  checkedBags: false, wantsToLeave: true,
}, { nowMs: computedMs, entry: { state: "unresolved", reason: "no_data_for_corridor" } });
const storedRow = certifiedComputationRowFor("fixture-user", "fixture-session", record);

afterEach(() => {
  _clearTestClient();
  _setTestServiceClient(null);
});

function fixture(options: FixtureOptions = {}) {
  const total = options.total ?? 3;
  const tables = {
    profiles: [{ id: "fixture-admin", role: "admin" }],
    feature_flags: options.persistence === false ? [] : [{ flag: "layover_decision_persistence_enabled", enabled: true }],
    layover_events: Array.from({ length: total }, (_, index) => ({
      session_id: `fixture-session-${index}`, event_type: "recommendation_generated",
      created_at: new Date(computedMs - index * 1000).toISOString(),
      metadata: { contract: { checked: 1, violating: index === total - 1 ? 1 : 0, byCheck: index === total - 1 ? { HARD_RETURN_DIVERGES: 1 } : {} } },
    })),
    layover_certified_computations: Array.from({ length: total }, () => structuredClone(storedRow)),
  };
  const database = makeLayoverDb(tables, { users: { "fixture-token": "fixture-admin" } });
  const reads: Array<{ source: Source; count: unknown; limit: number | undefined }> = [];
  const originalFrom = database.from;
  database.from = (table: string) => {
    const builder = originalFrom(table);
    if (!["layover_events", "layover_certified_computations"].includes(table)) return builder;
    if (table !== "layover_events" && table !== "layover_certified_computations") return builder;
    const originalSelect = builder.select;
    const originalLimit = builder.limit;
    const originalThen = builder.then;
    let source: Source;
    let count: unknown;
    let limit: number | undefined;
    builder.select = (columns: string, selectOptions?: { count?: string }) => {
      source = table === "layover_events"
        ? columns.includes("session_id") ? "events" : "generations"
        : columns.includes("verdict") ? "replay" : "decisions";
      count = selectOptions?.count;
      return originalSelect(columns, selectOptions);
    };
    builder.limit = (value: number) => { limit = value; return originalLimit(value); };
    builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => originalThen((result: any) => {
      reads.push({ source, count, limit });
      const capped = { ...result, data: result.data?.slice(0, options.cap ?? Number.POSITIVE_INFINITY) };
      return resolve(source === options.source ? { ...capped, ...options.patch } : capped);
    }, reject);
    return builder;
  };
  return { database, reads };
}

async function routeRead(options: FixtureOptions = {}) {
  const { database, reads } = fixture(options);
  _setTestClient(database, true);
  _setTestServiceClient(database as never);
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === "/admin/layover/metrics").route.stack[0].handle;
  const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    let statusCode = 200;
    const response = {
      status(code: number) { statusCode = code; return response; },
      json(body: unknown) { resolve({ status: statusCode, body }); return response; },
    };
    handler({ headers: { authorization: "Bearer fixture-token" }, query: {} }, response, reject);
  });
  return { ...result, reads };
}

const invalidCounts = [undefined, null, -1, 1.5, "3", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2];
const malformedData = [null, undefined, {}, "rows", [null], [3], [[]], [{}]];
const sources: Source[] = ["events", "generations", "decisions", "replay"];

describe("admin Layover metrics counted-window disclosure", () => {
  for (const cap of [2, 1000]) {
    it(`discloses every capped source and ranking window at server cap ${cap}`, async () => {
      const result = await routeRead({ total: cap + 1, cap });
      assert.equal(result.status, 200);
      for (const source of Object.values(result.body.sources) as any[]) {
        assert.equal(source.rows, cap);
        assert.equal(source.truncated, true);
      }
      assert.equal(result.body.layoverRollout.ranking.window.truncated, true);
      assert.equal(result.body.metrics.find((metric: any) => metric.name === "recommendation_contract_violation").value, null);
      assert.equal(result.body.metrics.find((metric: any) => metric.name === "recommendation_contract_violation").status, "UNPRODUCIBLE");
      assert.deepEqual(result.reads.map((read) => read.count), ["exact", "exact", "exact", "exact"]);
      assert.deepEqual(result.reads.map((read) => read.limit), [50_001, 5001, 5001, 5001]);
    });
  }

  for (const total of [0, 2, 3]) {
    it(`complete control with ${total} rows and a server cap of 3`, async () => {
      const result = await routeRead({ total, cap: 3 });
      assert.equal(result.status, 200);
      for (const source of Object.values(result.body.sources) as any[]) {
        assert.equal(source.rows, total);
        assert.equal(source.truncated, false);
      }
      assert.equal(result.body.layoverRollout.ranking.window.truncated, false);
      const metric = result.body.metrics.find((candidate: any) => candidate.name === "recommendation_contract_violation");
      assert.equal(metric.value, total === 0 ? null : 1);
    });
  }

  it("persistence OFF never reads either decision window", async () => {
    const result = await routeRead({ persistence: false, cap: 2 });
    assert.equal(result.status, 200);
    assert.deepEqual(result.reads.map((read) => read.source), ["events", "generations"]);
    assert.equal(result.body.sources.decisions.state, "persistence_off");
    assert.equal(result.body.sources.replay.state, "persistence_off");
  });

  for (const metadata of [null, false, 3, "metadata", [], [1]]) {
    it(`does not classify invalid generation metadata ${JSON.stringify(metadata)} as clean legacy`, async () => {
      const result = await routeRead({ source: "generations", patch: {
        data: [{ created_at: new Date(computedMs).toISOString(), metadata }], count: 1,
      } });
      assert.equal(result.status, 503);
      assert.equal(result.body.metrics, undefined);
    });
  }

  it("keeps a genuine empty legacy metadata object readable", async () => {
    const result = await routeRead({ source: "generations", patch: {
      data: [{ created_at: new Date(computedMs).toISOString(), metadata: {} }], count: 1,
    } });
    assert.equal(result.status, 200);
    assert.equal(result.body.sources.recommendationGenerations.unchecked, 1);
  });

  for (const source of sources) {
    it(`${source}: missing, invalid and contradictory counts refuse the whole response`, async () => {
      for (const count of invalidCounts) {
        const result = await routeRead({ source, patch: { count } });
        assert.equal(result.status, 503, `${source}: count=${String(count)}`);
        assert.equal(result.body.metrics, undefined);
        assert.equal(result.reads.at(-1)?.source, source);
      }
    });

    it(`${source}: malformed data is unavailable, not empty or clean`, async () => {
      for (const data of malformedData) {
        const result = await routeRead({ source, patch: { data } });
        assert.equal(result.status, 503, `${source}: data=${JSON.stringify(data)}`);
        assert.equal(result.body.metrics, undefined);
      }
    });

    it(`${source}: a later error cannot publish earlier successful reads`, async () => {
      const result = await routeRead({ source, patch: { error: { message: "fixture read failed" } } });
      assert.equal(result.status, 503);
      assert.equal(result.body.metrics, undefined);
      assert.deepEqual(result.reads.map((read) => read.source), sources.slice(0, sources.indexOf(source) + 1));
    });

    it(`${source}: a positive count with no rows is not an empty window`, async () => {
      const result = await routeRead({ source, patch: { data: [], count: 3 } });
      assert.equal(result.status, 503);
    });
  }
});

const readers = [
  { source: "decisions" as const, read: decisionsInWindow },
  { source: "replay" as const, read: storedComputationsInWindow },
];

for (const { source, read } of readers) {
  describe(`${source} counted store window`, () => {
    it("discloses a server cap below the requested bound", async () => {
      const { database } = fixture({ cap: 2 });
      const result = await read(database as never, fromIso, toIso);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value.truncated, true);
    });

    it("complete and empty controls remain available", async () => {
      for (const total of [0, 2, 3]) {
        const { database } = fixture({ total, cap: 3 });
        const result = await read(database as never, fromIso, toIso);
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.value.truncated, false);
      }
    });

    it("refuses every unknown or invalid count", async () => {
      for (const count of invalidCounts) {
        const { database } = fixture({ source, patch: { count } });
        assert.deepEqual(await read(database as never, fromIso, toIso), { ok: false, reason: "read_failed" }, String(count));
      }
    });

    it("refuses malformed data rather than throwing or returning rows", async () => {
      for (const data of malformedData) {
        const { database } = fixture({ source, patch: { data } });
        assert.deepEqual(await read(database as never, fromIso, toIso), { ok: false, reason: "read_failed" }, JSON.stringify(data));
      }
    });

    it("the installed PostgREST client requests exact count on the same bounded read", async () => {
      const requests: string[] = [];
      const database = createClient("https://fixture.invalid", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.toString());
          assert.equal(url.searchParams.get("limit"), "5001");
          assert.deepEqual(url.searchParams.getAll("computed_at"), [`gte.${fromIso}`, `lt.${toIso}`]);
          const counted = new Headers(init?.headers).get("prefer")?.includes("count=exact");
          return new Response(JSON.stringify([storedRow, storedRow]), {
            status: 206,
            headers: { "content-type": "application/json", "content-range": `0-1/${counted ? 3 : "*"}` },
          });
        } },
      });
      const result = await read(database, fromIso, toIso);
      assert.equal(requests.length, 1);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value.truncated, true);
    });
  });
}
