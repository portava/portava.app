/**
 * §35 "Previously successful query completions" (census-input-intelligence G229).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistancePreviousQueries.test.ts
 *
 * The viewer's own successful searches (the `search_history` they already own
 * and erase through DELETE /api/me/search-history) come back as submit rows
 * when what they type is a prefix of one — behind `input_previous_queries_enabled`
 * (migration 3690, seeded FALSE). Every case names the mutation that turns it red.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import {
  buildPreviousQueryCompletions,
  isResurfaceableQuery,
  policyAdmitsPreviousQueries,
  INPUT_PREVIOUS_QUERIES_FLAG,
} from "../lib/inputAssistance/previousQueries.js";
import { POLICY_VERSION, resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import { PREVIOUS_QUERIES_LANE, ZERO_STATE_LANES } from "../lib/inputAssistance/zeroStateLanes.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const OTHER = "aa000000-0000-4000-a000-000000000002";
const ME_TOK = "tok-me";

interface FakeState { [table: string]: any[] | undefined; }

function makeFakeClient(state: FakeState, failing: ReadonlySet<string> = new Set()) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const rows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let limitN = Infinity;
      const result = () => failing.has(table)
        ? { data: null, error: { message: `${table} unreadable` } }
        : { data: rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN === Infinity ? undefined : limitN), error: null };
      const b: any = {
        select() { return b; },
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
        neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
        in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
        not() { return b; }, is() { return b; }, ilike() { return b; }, or() { return b; },
        gte() { return b; }, lt() { return b; }, lte() { return b; }, gt() { return b; },
        order() { return b; }, range() { return b; },
        limit(n: number) { limitN = n; return b; },
        maybeSingle() { const r = result(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: r.error }); },
        single() { return b.maybeSingle(); },
        then(onF: any, onR: any) { return Promise.resolve(result()).then(onF, onR); },
      };
      return b;
    },
  };
}

const FLAG_ON = [{ flag: INPUT_PREVIOUS_QUERIES_FLAG, enabled: true }];

function world(over: FakeState = {}): FakeState {
  return {
    feature_flags: FLAG_ON,
    search_history: [
      { user_id: ME, query: "rooftop bars bangkok", searched_at: "2026-10-09T10:00:00Z" },
      { user_id: ME, query: "Rooftop pool hanoi", searched_at: "2026-10-08T10:00:00Z" },
      { user_id: ME, query: "street food", searched_at: "2026-10-07T10:00:00Z" },
      { user_id: OTHER, query: "rooftop secret party", searched_at: "2026-10-09T11:00:00Z" },
    ],
    blocks: [],
    ...over,
  };
}

let base: string;
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); });

async function suggest(state: FakeState, body: any, failing?: Set<string>) {
  _setTestClient(makeFakeClient(state, failing) as any, true);
  const r = await fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}

const previous = (body: any) => (body.suggestions ?? []).filter((s: any) => String(s.id).includes(":previous_query:"));

describe("G229 — previous successful searches through POST /input-assistance/suggest", () => {
  it("offers the viewer's own earlier searches that start with what is typed, as submit rows", async () => {
    // MUTATION: drop the buildPreviousQueryCompletions call from gateway.ts → RED.
    const { status, body } = await suggest(world(), { context: "global_search", text: "roof" });
    assert.equal(status, 200);
    const rows = previous(body);
    assert.deepEqual(rows.map((r: any) => r.label), ["rooftop bars bangkok", "Rooftop pool hanoi"]);
    for (const r of rows) {
      assert.equal(r.type, "recent");
      assert.equal(r.source, "recent");
      assert.deepEqual(r.action, { type: "submit_search", query: r.label });
      assert.equal(r.policyVersion, POLICY_VERSION);
    }
  });

  it("never reads another person's history (owner scope)", async () => {
    // MUTATION: remove `.eq('user_id', opts.userId)` → OTHER's "rooftop secret party" appears → RED.
    const { body } = await suggest(world(), { context: "global_search", text: "roof" });
    assert.ok(!previous(body).some((r: any) => /secret/.test(r.label)));
  });

  it("FLAG OFF (the seed) — nothing is offered and the history is not read", async () => {
    // MUTATION: drop the isFlagEnabled check → rows appear with the flag off → RED.
    const { body } = await suggest(world({ feature_flags: [{ flag: INPUT_PREVIOUS_QUERIES_FLAG, enabled: false }] }), { context: "global_search", text: "roof" });
    assert.equal(previous(body).length, 0);
    const absent = await suggest(world({ feature_flags: [] }), { context: "global_search", text: "roof" });
    assert.equal(previous(absent.body).length, 0, "an absent flag row is OFF");
  });

  it("an erased entry is never offered again (the store IS the erase)", async () => {
    const erased = world();
    erased.search_history = erased.search_history!.filter((r) => r.query !== "rooftop bars bangkok");
    const { body } = await suggest(erased, { context: "global_search", text: "roof" });
    assert.deepEqual(previous(body).map((r: any) => r.label), ["Rooftop pool hanoi"]);
  });

  it("a failed history read is a PARTIAL refusal naming its lane, not a clean empty answer", async () => {
    // MUTATION: drop the onUnreadable callback → coverage stays complete → RED.
    const { status, body } = await suggest(world(), { context: "global_search", text: "roof" }, new Set(["search_history"]));
    assert.equal(status, 200);
    assert.equal(previous(body).length, 0);
    assert.equal(body.refusal?.coverage, "partial");
    assert.ok((body.refusal?.failedSources ?? []).includes(PREVIOUS_QUERIES_LANE));
  });

  it("a field outside the search contexts gets none (policy + context gate)", async () => {
    // place_picker allows personalization but is not a search context; compass_prompt is not either.
    for (const context of ["place_picker", "compass_prompt", "hashtag"]) {
      const { body } = await suggest(world(), { context, text: "roof" });
      assert.equal(previous(body).length, 0, context);
    }
  });

  it("V-IN F5: a search that merely CONTAINS what is typed is not offered — it must START with it", async () => {
    // MUTATION: startsWith → includes → "best rooftop views" is offered for "roof" → RED.
    const st = world({ search_history: [{ user_id: ME, query: "best rooftop views", searched_at: "2026-10-09T10:00:00Z" }] });
    const { body } = await suggest(st, { context: "global_search", text: "roof" });
    assert.equal(previous(body).length, 0);
  });

  it("does not repeat the typed text itself (the serve already carries «Search q»)", async () => {
    const { body } = await suggest(world(), { context: "global_search", text: "street food" });
    assert.equal(previous(body).length, 0);
  });
});

describe("G229 — the builder's gates", () => {
  const policy = resolvePolicy("global_search")!;
  const sc = (state: FakeState, failing?: Set<string>) => makeFakeClient(state, failing) as any;

  it("precision: an email, a phone/booking number, a card-like group or a coordinate pair is never shown back", async () => {
    // MUTATION: make isResurfaceableQuery return true → these rows appear → RED.
    const rows = await buildPreviousQueryCompletions(sc(world({ search_history: [
      { user_id: ME, query: "hotel maya@example.com", searched_at: "2026-10-09T10:00:00Z" },
      { user_id: ME, query: "hotel +84 905 123 456", searched_at: "2026-10-09T09:00:00Z" },
      { user_id: ME, query: "hotel 4111 1111 1111 1111", searched_at: "2026-10-09T08:00:00Z" },
      { user_id: ME, query: "hotel 16.0544, 108.2022", searched_at: "2026-10-09T07:00:00Z" },
      { user_id: ME, query: "hotel rooftop", searched_at: "2026-10-09T06:00:00Z" },
    ] })), { userId: ME, context: "global_search", policy, typed: "hot", policyVersion: POLICY_VERSION });
    assert.deepEqual(rows.map((r) => r.label), ["hotel rooftop"]);
    assert.equal(isResurfaceableQuery("bangkok 2 nights"), true);
    // V-IN F7 — MUTATION: drop the DMS / address rules → RED.
    assert.equal(isResurfaceableQuery(`16°03'N 108°12'E`), false);
    assert.equal(isResurfaceableQuery("123 Nguyen Van Linh"), false);
    assert.equal(isResurfaceableQuery("rooftop bars"), true);
  });

  it("policy: personalization off, a private class or a missing completion type refuses", () => {
    assert.equal(policyAdmitsPreviousQueries("global_search", policy), true);
    // The context gate on its own: the SAME policy under a field whose submits do not write search_history.
    assert.equal(policyAdmitsPreviousQueries("buddy_service", { ...policy, context: "buddy_service" }), false);
    assert.equal(policyAdmitsPreviousQueries("global_search", { ...policy, allowPersonalization: false }), false);
    assert.equal(policyAdmitsPreviousQueries("global_search", { ...policy, privacyClass: "private_message" }), false);
    assert.equal(policyAdmitsPreviousQueries("global_search", { ...policy, allowedSuggestionTypes: ["entity", "recent"] }), false);
  });

  it("bounded: at most two rows, newest first", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ user_id: ME, query: `bar ${i}`, searched_at: `2026-10-0${9 - i}T00:00:00Z` }));
    const rows = await buildPreviousQueryCompletions(sc(world({ search_history: many })), { userId: ME, context: "global_search", policy, typed: "bar", policyVersion: POLICY_VERSION });
    assert.deepEqual(rows.map((r) => r.label), ["bar 0", "bar 1"]);
  });

  it("STATIC: the failure lane is neither a dispatched search type nor a zero-state lane (V-ZS rule)", () => {
    const src = (f: string) => readFileSync(new URL(`../lib/inputAssistance/${f}`, import.meta.url), "utf8");
    const union = /export type DispatchSearchType =([^;]+);/.exec(src("entityMap.ts"))![1]!;
    const dispatch = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    const list = /const SEARCH_TYPES = \[([\s\S]*?)\] as const;/.exec(src("searchCandidates.ts"))![1]!;
    const searchTypes = [...list.replace(/\/\/.*$/gm, "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    assert.ok(dispatch.includes("trips") && searchTypes.includes("saved"), "premise: the parsers read both lists");
    assert.ok(!dispatch.includes(PREVIOUS_QUERIES_LANE) && !searchTypes.includes(PREVIOUS_QUERIES_LANE));
    assert.ok(!ZERO_STATE_LANES.includes(PREVIOUS_QUERIES_LANE));
  });
});
