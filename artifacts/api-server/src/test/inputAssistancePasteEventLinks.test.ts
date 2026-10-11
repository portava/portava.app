/**
 * §24 Paste Intelligence — event links (census-input-intelligence G158).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistancePasteEventLinks.test.ts
 *
 * A pasted Portava event link is read as the event — only as THIS viewer's event
 * search would show it — and its city is resolved for the place field like
 * typed text. The link's share token is never echoed or used. Behind
 * `input_paste_event_links_enabled` (3691, seeded FALSE): off, the link is the
 * unsupported link it always was. Every case names the mutation that turns it red.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { searchKey, normalizeLocationName } from "../lib/canonicalLocations.js";
import { classifyPaste } from "../lib/inputAssistance/pasteExtraction.js";
import { parseEventLink, INPUT_PASTE_EVENT_LINKS_FLAG } from "../lib/inputAssistance/pasteEventLinks.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const HOST = "cc000000-0000-4000-a000-000000000003";
const BLOCKED_HOST = "dd000000-0000-4000-a000-000000000004";
const ME_TOK = "tok-me";
const EV = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40";
const EV_PRIVATE = "1b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a41";
const EV_BLOCKED = "2b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a42";
const TOKEN = "SeCrEtShArEtOkEn123";

interface FakeState { [key: string]: any[] | undefined }
const writes: string[] = [];

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  for (const fn of ["select","eq","neq","in","not","is","ilike","or","gte","lte","lt","order","limit","range","maybeSingle"]) {
    errorBuilder[fn] = () => errorBuilder;
  }
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);

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
        ilike(c: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/\\([%_])/g, "$1").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[c] ?? "")));
          return builder;
        },
        or() { return builder; },
        // PR-D2-7c: the registry's nearest-city box reads lat/lng ranges; a row without the column is not filtered.
        gte(c: string, v: any) { filters.push((r) => r[c] == null || r[c] >= v); return builder; },
        lte(c: string, v: any) { filters.push((r) => r[c] == null || r[c] <= v); return builder; },
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

function canonCity(name: string, country: string, cc: string, lat: number, lng: number) {
  const key = searchKey(name);
  return {
    id: `canon-${key.replace(/\s+/g, "-")}`,
    kind: "city", name, normalized_name: normalizeLocationName(name), search_key: key,
    display_name: `${name}, ${country}`, city: null, region: null, country, country_code: cc,
    postal_code: null, lat, lng, provider_ids: {}, aliases: [],
  };
}


const HOI_AN = canonCity("Hoi An", "Vietnam", "VN", 15.8801, 108.338);
const SOON = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
const ev = (id: string, host: string, visibility = "public", state = "open", starts_at = SOON) =>
  ({ id, title: "Lantern Night", host_id: host, city: "Hoi An", country: "Vietnam", visibility, state, starts_at });
const STATE = (over: FakeState = {}): FakeState => ({
  feature_flags: [{ flag: INPUT_PASTE_EVENT_LINKS_FLAG, enabled: true }],
  canonical_locations: [HOI_AN],
  profiles: [{ id: ME, account_status: "active" }, { id: HOST, account_status: "active" }, { id: BLOCKED_HOST, account_status: "active" }],
  blocks: [{ blocker_id: BLOCKED_HOST, blocked_id: ME }], user_privacy_settings: [], profile_privacy_settings: [],
  trip_members: [], trips: [], input_selection_history: [], saved_places: [],
  events: [ev(EV, HOST), ev(EV_PRIVATE, HOST, "invite_only"), ev(EV_BLOCKED, BLOCKED_HOST)],
  ...over,
});

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
afterEach(() => assert.deepEqual(writes, [], "the extract endpoint must never write (G162)"));

async function extract(state: FakeState, text: string, errors?: Set<string>) {
  _setTestClient(makeFakeClient(state, errors) as any, true);
  const r = await fetch(`${base}/input-assistance/extract`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify({ context: "trip_destination", text }),
  });
  const raw = await r.text();
  return { status: r.status, raw, body: JSON.parse(raw) as any };
}

describe("G158 — parseEventLink (pure)", () => {
  it("reads Portava's own share link and app scheme; nothing else", () => {
    assert.deepEqual(parseEventLink(`https://portava.replit.app/event/${EV}?share=${TOKEN}`, {}), { eventId: EV });
    assert.deepEqual(parseEventLink(`portava.app/event/${EV}`, {}), { eventId: EV });
    assert.deepEqual(parseEventLink(`travelbuddy://event/${EV}`, {}), { eventId: EV });
    // MUTATION: drop the host allow-list → another site's /event/<uuid> is read → RED.
    assert.equal(parseEventLink(`https://evil.example/event/${EV}`, {}), null);
    assert.equal(parseEventLink(`https://portava.app/event/not-a-uuid`, {}), null);
    assert.equal(parseEventLink(`https://portava.app/place/${EV}`, {}), null);
    assert.deepEqual(parseEventLink(`https://staging.portava.test/event/${EV}`, { PORTAVA_WEB_ORIGIN: "https://staging.portava.test" }), { eventId: EV });
  });

  it("the classified item carries the event id and a FIXED label — never the URL or its token", () => {
    const c = classifyPaste(`https://portava.replit.app/event/${EV}?share=${TOKEN}`);
    assert.equal(c.items[0]!.source, "event_link");
    assert.equal(c.items[0]!.raw, "Event link");
    assert.ok(!JSON.stringify(c).includes(TOKEN));
  });
});

describe("G158 — POST /input-assistance/extract with an event link", () => {
  it("resolves to the event's city for the destination field; the token never appears in the answer", async () => {
    // MUTATION: drop the event_link branch in resolveOne → the link is unsupported → RED.
    const { status, raw, body } = await extract(STATE(), `https://portava.replit.app/event/${EV}?share=${TOKEN}`);
    assert.equal(status, 200);
    assert.equal(body.items.length, 1);
    const it0 = body.items[0];
    assert.equal(it0.status, "resolved");
    assert.equal(it0.raw, "Event: Lantern Night");
    assert.ok(it0.candidates.some((c: any) => c.entityId === HOI_AN.id), JSON.stringify(it0.candidates));
    assert.ok(!raw.includes(TOKEN), "the share token is never echoed");
    assert.ok(!raw.includes(EV), "the event id is not echoed back either");
  });

  it("a NON-PUBLIC event, or one whose host blocked the viewer, is dropped silently — existence is not disclosed", async () => {
    // MUTATION: drop the visibility check → the private event resolves → RED.
    for (const id of [EV_PRIVATE, EV_BLOCKED, "3b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a43"]) {
      const { body } = await extract(STATE(), `https://portava.app/event/${id}`);
      assert.deepEqual(body.items, [], id);
    }
  });

  it("a cancelled or draft event is not offered", async () => {
    const { body } = await extract(STATE({ events: [ev(EV, HOST, "public", "cancelled")] }), `https://portava.app/event/${EV}`);
    assert.deepEqual(body.items, []);
  });

  it("V-IN F1: a COMPLETED or PAST event — not in the viewer's event search — is not offered", async () => {
    // MUTATION: drop the starts_at window → last year's event resolves → RED. Drop 'completed' → RED.
    const lastYear = "2025-01-01T18:00:00Z";
    for (const e of [ev(EV, HOST, "public", "open", lastYear), ev(EV, HOST, "public", "completed")]) {
      const { body } = await extract(STATE({ events: [e] }), `https://portava.app/event/${EV}`);
      assert.deepEqual(body.items, [], JSON.stringify(e));
    }
    // An event that started an hour ago is still in the search (≤ 2 h), so it still resolves.
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { body } = await extract(STATE({ events: [ev(EV, HOST, "public", "open", anHourAgo)] }), `https://portava.app/event/${EV}`);
    assert.equal(body.items[0]?.status, "resolved");
  });

  it("FLAG OFF (the seed): the link is the unsupported link it always was — byte for byte the same answer as any unreadable link", async () => {
    // MUTATION: drop the eventLinksEnabled check → it resolves with the flag off → RED.
    // MUTATION (V-IN F6): keep source 'event_link' or shape 'single' when OFF → the parity below is RED.
    const { body } = await extract(STATE({ feature_flags: [] }), `https://portava.app/event/${EV}`);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].status, "unsupported");
    assert.equal(body.items[0].unsupported, "unsupported_link");
    const control = await extract(STATE({ feature_flags: [] }), `https://portava.app/place/${EV}`);
    assert.deepEqual(body.items, control.body.items);
    assert.equal(body.shape, control.body.shape);
  });

  it("an unreadable event read is a FAILURE with fixed copy, never 'no match'", async () => {
    // MUTATION: map a failed read to no_match → the item disappears → RED.
    const { body } = await extract(STATE(), `https://portava.app/event/${EV}`, new Set(["events"]));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].status, "failed");
    assert.equal(body.items[0].raw, "Event link");
  });

  it("V-IN F3: an unreadable block list, age list or host-status read is a FAILURE too", async () => {
    // MUTATION: `if (owner.error) return { ok: true, event: null }` → the item disappears → RED.
    for (const table of ["blocks", "user_privacy_settings"]) {
      const { body } = await extract(STATE(), `https://portava.app/event/${EV}`, new Set([table]));
      assert.equal(body.items[0]?.status, "failed", table);
    }
    // profiles: fail only the host-status read (the auth layer reads profiles first).
    _setTestClient(makeFakeClient(STATE()) as any, true);
    const sc: any = makeFakeClient(STATE());
    const from = sc.from.bind(sc);
    sc.from = (t: string) => {
      const b = from(t);
      if (t !== "profiles") return b;
      const origIn = b.in.bind(b);
      b.in = (c: string, v: any[]) => { if (c === "account_status") { b.maybeSingle = () => Promise.resolve({ data: null, error: { message: "down" } }); } return origIn(c, v); };
      return b;
    };
    const { readLinkedEvent } = await import("../lib/inputAssistance/pasteEventLinks.js");
    assert.deepEqual(await readLinkedEvent(sc, ME, EV), { ok: false });
  });
});
