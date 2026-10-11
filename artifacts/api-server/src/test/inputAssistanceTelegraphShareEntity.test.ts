/**
 * §43 `share_entity` producer in a Telegraph message (census G303; §21 "Share
 * Event", G133) — the input side only.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceTelegraphShareEntity.test.ts
 *
 * "meet at <text>" whose text names a PUBLIC upcoming event offers
 * "Share Event: …" with `share_entity` (entityType event), resolved through the
 * gateway's own privacy-gated event search — never a fresh read — behind
 * `input_telegraph_share_entity_enabled` (3691, seeded FALSE), and only to a
 * client that declares `share_entity`. Nothing is written by suggesting.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { INPUT_TELEGRAPH_SHARE_ENTITY_FLAG } from "../lib/inputAssistance/telegraphActions.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const HOST = "cc000000-0000-4000-a000-000000000003";
const BLOCKED_HOST = "dd000000-0000-4000-a000-000000000004";
const ME_TOK = "tok-me";

interface FakeState { [key: string]: any[] | undefined }
const writes: string[] = [];

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  for (const fn of ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"]) {
    errorBuilder[fn] = () => errorBuilder;
  }
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);
  const likeRe = (pat: string) =>
    new RegExp("^" + pat.replace(/\\([%_])/g, "$1").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");

  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: (name: string) => { writes.push(`rpc:${name}`); return Promise.resolve({ data: null, error: null }); },
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;
      const rows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let limitN = Infinity;
      const write = (verb: string) => () => { writes.push(`${verb}:${table}`); return builder; };
      const builder: any = {
        select() { return builder; },
        insert: write("insert"), update: write("update"), upsert: write("upsert"), delete: write("delete"),
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
        neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
        in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return builder; },
        not() { return builder; },
        is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
        ilike(c: string, pat: string) { const re = likeRe(pat); filters.push((r) => re.test(String(r[c] ?? ""))); return builder; },
        or(expr: string) {
          const parts = expr.split(",").map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.+)$/)).filter(Boolean) as RegExpMatchArray[];
          filters.push((r) => parts.some((m) => {
            const cell = String(r[m[1]!] ?? "");
            return m[2]!.toLowerCase() === "ilike" ? likeRe(m[3]!).test(cell) : m[2] === "eq" ? cell === m[3] : false;
          }));
          return builder;
        },
        gte() { return builder; },
        lt() { return builder; },
        order() { return builder; },
        range() { return builder; },
        limit(n: number) { limitN = n; return builder; },
        maybeSingle() {
          return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const out = rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN);
          return Promise.resolve({ data: out, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

function place(id: string, name: string, city: string) {
  return {
    id, name, city, blurb: null, image_url: null, header_image_source: null,
    image_source_type: null, image_accuracy_status: null, category: "landmark",
    primary_category: "landmark", lat: 16.06, lng: 108.22, canonical_location_id: null,
    created_at: "2026-01-01T00:00:00Z", submitted_by: null, status: "active", saved_count: 3,
  };
}


const SOON = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
const ev = (id: string, title: string, host: string) => ({
  id, title, host_id: host, cover_url: null, city: "Hoi An", country: "Vietnam", starts_at: SOON,
  visibility: "public", state: "open", created_at: "2026-09-01T00:00:00Z", location_lat: null, location_lng: null, show_exact_location: false,
});
const STATE = (over: FakeState = {}): FakeState => ({
  feature_flags: [{ flag: INPUT_TELEGRAPH_SHARE_ENTITY_FLAG, enabled: true }],
  profiles: [{ id: ME, account_status: "active" }, { id: HOST, account_status: "active" }, { id: BLOCKED_HOST, account_status: "active" }],
  user_account_states: [],
  blocks: [{ blocker_id: ME, blocked_id: BLOCKED_HOST }],
  user_privacy_settings: [], profile_privacy_settings: [], canonical_locations: [],
  discovery_places: [], trip_members: [], trips: [], trip_destinations: [], event_rsvps: [],
  events: [ev("ev-lantern", "Lantern Festival", HOST), ev("ev-blocked", "Lantern Rave", BLOCKED_HOST)],
  ...over,
});

const CLIENT = { schemaVersion: 1, suggestionTypes: ["action"], actionTypes: ["set_structured_value", "share_entity"] };

let base: string;
let server: Server;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); writes.length = 0; });
afterEach(() => assert.deepEqual(writes, [], "suggesting a share must never write"));

async function suggest(state: FakeState, text: string, client: unknown = CLIENT, errors?: Set<string>) {
  _setTestClient(makeFakeClient(state, errors) as any, true);
  const r = await fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify({ context: "telegraph_message", fieldId: "telegraph.message", text, client }),
  });
  assert.equal(r.status, 200);
  return (await r.json()) as any;
}
const shares = (body: any) => body.suggestions.filter((s: any) => s.action?.type === "share_entity");

describe("G303 — share_entity rows in a Telegraph message", () => {
  it("'meet at the lantern festival' offers Share Event with a share_entity action on the event", async () => {
    // MUTATION: drop the 1b block from telegraphActions.ts → RED.
    const body = await suggest(STATE(), "meet at the Lantern Festival");
    const rows = shares(body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "action");
    assert.deepEqual(rows[0].action, { type: "share_entity", entityType: "event", entityId: "ev-lantern" });
    assert.equal(rows[0].label, "Share Event: Lantern Festival");
    assert.equal(rows[0].structuredValue.objectType, "EVENT");
    // The §54 LOCATION candidates are still there beside it.
    assert.ok(body.suggestions.some((s: any) => s.structuredValue?.telegraphShare === "meeting_point"));
  });

  it("the privacy gate is the search's own: a blocked host's event is never offered", async () => {
    // MUTATION: read events directly instead of through the gateway serve → the blocked host's event appears → RED.
    const body = await suggest(STATE(), "meet at Lantern");
    assert.deepEqual(shares(body).map((r: any) => r.action.entityId), ["ev-lantern"]);
  });

  it("a non-public event is never offered (the recipient's access could not be decided)", async () => {
    const body = await suggest(STATE({ events: [{ ...ev("ev-private", "Lantern Supper", HOST), visibility: "invite_only" }] }), "meet at Lantern Supper");
    assert.equal(shares(body).length, 0);
  });

  it("FLAG OFF or absent (the seed): no share_entity row", async () => {
    // MUTATION: drop the isFlagEnabled gate → RED.
    assert.equal(shares(await suggest(STATE({ feature_flags: [] }), "meet at the Lantern Festival")).length, 0);
    assert.equal(shares(await suggest(STATE({ feature_flags: [{ flag: INPUT_TELEGRAPH_SHARE_ENTITY_FLAG, enabled: false }] }), "meet at the Lantern Festival")).length, 0);
  });

  it("§48: a client that does not declare share_entity is served none", async () => {
    const body = await suggest(STATE(), "meet at the Lantern Festival", { schemaVersion: 1, suggestionTypes: ["action"], actionTypes: ["set_structured_value"] });
    assert.equal(shares(body).length, 0);
  });

  it("an unreadable event search is a partial refusal, not 'no events'", async () => {
    const body = await suggest(STATE(), "meet at the Lantern Festival", CLIENT, new Set(["events"]));
    assert.equal(shares(body).length, 0);
    assert.ok((body.refusal?.failedSources ?? []).includes("events"), JSON.stringify(body.refusal));
  });
});
