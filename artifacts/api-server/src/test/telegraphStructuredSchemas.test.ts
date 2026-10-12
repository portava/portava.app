/**
 * Telegraph §30A.16 — versioned structured-message schemas and client
 * capability negotiation (census-telegraph T429, T431).
 *
 * WHAT IS PROVED
 *   · the registry: §30A.16's six ids verbatim; every stored structured kind and
 *     every shareable object type maps to exactly one schema; the baseline is
 *     FROZEN, so a v2 never reaches a client that did not declare it;
 *   · server-side validation on WRITE: with the flag ON the typed route and the
 *     share route stamp the schema id and REFUSE a schema the server does not
 *     write for that kind; with it OFF the body is byte-identical to before;
 *   · server-side validation on READ and the safe fallback: a row whose schema
 *     the client did not declare, a schema this server does not know, a payload
 *     that does not validate, and an interaction needing an undeclared action
 *     are each served as a TEXT row with a fixed sentence — and the serialised
 *     row is searched for the payload (exact coordinates), not merely checked
 *     for a missing field;
 *   · action negotiation on share projections.
 *
 * Run: node --import tsx/esm --test src/test/telegraphStructuredSchemas.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphShareRouter from "../routes/telegraphShare.js";
import telegraphForwardRouter from "../routes/telegraphForward.js";
import {
  ACTION_MIN_VERSIONS,
  BASELINE_CLIENT_SCHEMAS,
  CLIENT_ACTIONS_HEADER,
  CLIENT_SCHEMAS_HEADER,
  clientPerformsAction,
  clientRendersSchema,
  negotiateRender,
  parseClientCapabilities,
  schemaById,
  schemaForKind,
  schemaForObjectType,
  schemaToStamp,
  storedSchemaOf,
  STRUCTURED_SCHEMAS,
  STRUCTURED_SCHEMAS_FLAG,
  UNKNOWN_SCHEMA_FALLBACK,
} from "../services/telegraph/structuredSchemas.js";
import { applyFallback, decoratePlatformReads, negotiateQuotedBody } from "../services/telegraph/platformReadDecorations.js";
import { ENVELOPE_KINDS } from "../services/telegraph/messageKinds.js";
import { COORDINATION_KINDS } from "../services/telegraph/coordination.js";
import { buildPortavaObjectBody, SHAREABLE_OBJECT_TYPES } from "../services/telegraph/shareables.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "10000000-0000-4000-8000-000000000001";
const POST_OK = "b1000000-0000-4000-8000-000000000001";
const GEM_ACTIVE = "55550000-0000-4000-8000-000000000002";

const LAT = 16.054321;
const LNG = 108.209876;
const locationBody = JSON.stringify({
  kind: "LOCATION", envelopeVersion: "1",
  payload: { label: "Our flat, 3rd floor", precision: "exact", lat: LAT, lng: LNG },
});

// ── the registry ─────────────────────────────────────────────────────────────

describe("T429 — the registry", () => {
  it("names §30A.16's six schemas verbatim", () => {
    for (const id of ["place.share.v1", "event.share.v1", "trip.share.v1", "memory_note.v1", "location.scope.v1", "coordination.status.v1"]) {
      assert.ok(schemaById(id), `${id} is not registered`);
    }
  });

  it("every stored structured kind and every shareable object type has exactly one schema", () => {
    for (const k of ENVELOPE_KINDS) assert.ok(schemaForKind(k), `envelope kind ${k} has no schema`);
    for (const k of COORDINATION_KINDS) assert.ok(schemaForKind(k), `coordination kind ${k} has no schema`);
    for (const t of SHAREABLE_OBJECT_TYPES) {
      const owners = STRUCTURED_SCHEMAS.filter((x) => x.objectTypes?.includes(t));
      assert.ok(owners.length <= 1, `${t} belongs to ${owners.length} share schemas`);
      assert.ok(schemaForObjectType(t), `${t} has no share schema`);
    }
    assert.equal(schemaForObjectType("PLACE").id, "place.share.v1");
    assert.equal(schemaForObjectType("EVENT").id, "event.share.v1");
    assert.equal(schemaForObjectType("TRIP").id, "trip.share.v1");
    assert.equal(schemaForObjectType("POST").id, "object.share.v1");
    const ids = STRUCTURED_SCHEMAS.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate schema id");
  });

  it("the BASELINE is frozen: a registered v2 is never served to a client that declared nothing", () => {
    // Every family in the registry today is in the baseline at exactly its version…
    for (const x of STRUCTURED_SCHEMAS) assert.equal(BASELINE_CLIENT_SCHEMAS[x.family], x.version, x.id);
    // …and a future version of one of them is not.
    const baseline = parseClientCapabilities({});
    const v2 = { ...schemaById("location.scope.v1")!, id: "location.scope.v2", version: 2 };
    assert.equal(clientRendersSchema(baseline, schemaById("location.scope.v1")!), true);
    assert.equal(clientRendersSchema(baseline, v2), false);
  });

  it("no fallback sentence is a payload field", () => {
    for (const x of STRUCTURED_SCHEMAS) assert.ok(x.fallbackLabel.length > 0 && !x.fallbackLabel.includes("{"), x.id);
  });
});

describe("T431 — reading what a client declares", () => {
  it("absent headers are the baseline; a present header is taken literally; garbage declares nothing", () => {
    const none = parseClientCapabilities({});
    assert.equal(none.declaredSchemas, false);
    assert.equal(clientPerformsAction(none, "VOTE"), true);
    const some = parseClientCapabilities({ [CLIENT_SCHEMAS_HEADER]: "place.share.v1, location.scope.v3,BAD TOKEN", [CLIENT_ACTIONS_HEADER]: "VOTE.v1" });
    assert.deepEqual(some.schemas, { "place.share": 1, "location.scope": 3 });
    assert.equal(clientPerformsAction(some, "VOTE"), true);
    assert.equal(clientPerformsAction(some, "ADD_TO_TRIP"), false);
    assert.equal(clientPerformsAction(some, "NOT_AN_ACTION"), false);
    const garbage = parseClientCapabilities({ [CLIENT_SCHEMAS_HEADER]: "%%%" });
    assert.deepEqual(garbage.schemas, {});
    assert.ok(Object.values(ACTION_MIN_VERSIONS).every((v) => v === 1));
  });
});

// ── read-side classification and the fallback ────────────────────────────────

describe("T429/T431 — storedSchemaOf + negotiateRender", () => {
  const onlyPlaces = parseClientCapabilities({ [CLIENT_SCHEMAS_HEADER]: "place.share.v1" });
  const baseline = parseClientCapabilities({});

  it("legacy and plain rows are never negotiated", () => {
    for (const mt of ["text", "system", "media", "card", "booking_card", "circle_status_card", "highlight_reply", null]) {
      assert.deepEqual(storedSchemaOf({ msg_type: mt as any, body: "{\"kind\":\"X\"}" }), { structured: false }, String(mt));
      assert.equal(negotiateRender({ msg_type: mt as any, body: "hi" }, onlyPlaces).fallback, false);
    }
  });

  it("a LOCATION is location.scope.v1, served to the baseline, and degraded — WITHOUT ITS COORDINATES — to a client that did not declare it", () => {
    const row = { msg_type: "location", subtype: "exact", body: locationBody };
    assert.equal((storedSchemaOf(row) as any).schemaId, "location.scope.v1");
    assert.equal(negotiateRender(row, baseline).fallback, false);
    const neg = negotiateRender(row, onlyPlaces);
    assert.ok(neg.fallback);
    assert.equal(neg.fallback && neg.reason, "client_unsupported_schema");
    const m: Record<string, any> = { id: "m", body: locationBody, displayBody: locationBody, msgType: "location", subtype: "exact", mediaUrl: null, tags: [{ x: 1 }] };
    applyFallback(m, neg as any);
    const s = JSON.stringify(m);
    assert.ok(!s.includes(String(LAT)) && !s.includes(String(LNG)), "exact coordinates reached a client that cannot render their precision");
    assert.ok(!s.includes("3rd floor"), "the sender's label reached the fallback");
    assert.equal(m.msgType, "text", "the oldest renderer must see a plain bubble");
    assert.equal(m.body, "Shared a location");
    assert.deepEqual(m.structured, { schema: "location.scope.v1", fallback: true, reason: "client_unsupported_schema", originalMsgType: "location" });
  });

  it("a schema this server does not know (a newer build's) falls back, for every client", () => {
    const row = { msg_type: "location", body: JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", schema: "location.scope.v9", payload: {} }) };
    for (const caps of [baseline, onlyPlaces]) {
      const neg = negotiateRender(row, caps);
      assert.ok(neg.fallback);
      assert.equal(neg.fallback && neg.reason, "unknown_schema");
      assert.equal(neg.fallback && neg.label, UNKNOWN_SCHEMA_FALLBACK);
    }
  });

  it("a payload that does not validate is never served raw", () => {
    const row = { msg_type: "location", body: JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", payload: { lat: 999 } }) };
    const neg = negotiateRender(row, baseline);
    assert.equal(neg.fallback && neg.reason, "invalid_payload");
  });

  it("a declared schema that disagrees with the object it carries is invalid (no place.share label on a trip)", () => {
    const body = JSON.stringify({ ...buildPortavaObjectBody("TRIP", "t1", null), schema: "place.share.v1" });
    const neg = negotiateRender({ msg_type: "portava_object", subtype: "trip", body }, baseline);
    assert.equal(neg.fallback && neg.reason, "invalid_payload");
    const ok = JSON.stringify({ ...buildPortavaObjectBody("TRIP", "t1", null), schema: "trip.share.v1" });
    assert.equal(negotiateRender({ msg_type: "portava_object", body: ok }, baseline).fallback, false);
    assert.equal(negotiateRender({ msg_type: "portava_object", body: ok }, onlyPlaces).fallback, true);
  });

  it("SAFETY keeps its class in the fallback — 'needs help' is never reduced to 'a safety message'", () => {
    const body = JSON.stringify({ kind: "SAFETY", envelopeVersion: "1", payload: { kind: "need_help", label: "at the pier, phone dying" } });
    const neg = negotiateRender({ msg_type: "safety", subtype: "need_help", body }, onlyPlaces);
    assert.ok(neg.fallback);
    assert.match(neg.fallback ? neg.label : "", /Needs help/);
    assert.ok(!(neg.fallback ? neg.label : "").includes("pier"));
  });

  it("an interaction needing an action the client did not declare falls back (minimum action version)", () => {
    const body = JSON.stringify({ kind: "ACTION", envelopeVersion: "1", payload: { action: "JOIN_PLAN", title: "Dinner", requiresConfirmation: true } });
    const allSchemasNoJoin = parseClientCapabilities({ [CLIENT_ACTIONS_HEADER]: "VOTE.v1" });
    const neg = negotiateRender({ msg_type: "action", subtype: "join_plan", body }, allSchemasNoJoin);
    assert.equal(neg.fallback && neg.reason, "client_unsupported_action");
    assert.equal(negotiateRender({ msg_type: "action", body }, baseline).fallback, false);
  });

  it("a tombstone is not negotiated", () => {
    assert.equal(negotiateRender({ msg_type: "location", body: locationBody, deleted_at: "x" }, onlyPlaces).fallback, false);
  });

  it("a QUOTE of an undeclared structured row is degraded too (the quote is the raw body)", () => {
    assert.equal(negotiateQuotedBody(locationBody, onlyPlaces), "Shared a location");
    assert.equal(negotiateQuotedBody(locationBody, baseline), null);
    assert.equal(negotiateQuotedBody("plain words", onlyPlaces), null);
  });
});

// ── the thread read ──────────────────────────────────────────────────────────

function flagClient(flags: Record<string, boolean>) {
  return {
    from(table: string) {
      const q: any = {
        select: () => q, eq: (_c: string, v: string) => { q._flag = v; return q; }, in: () => q,
        maybeSingle: async () => ({ data: table === "feature_flags" ? { enabled: flags[q._flag] === true } : null, error: null }),
        then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return q;
    },
  };
}

describe("T431 — decoratePlatformReads on the thread page", () => {
  const rows = [
    { id: "m1", msg_type: "location", subtype: "exact", body: locationBody },
    { id: "m2", msg_type: "text", body: "hello" },
  ];
  const page = () => [
    { id: "m1", body: locationBody, displayBody: locationBody, msgType: "location", subtype: "exact" },
    { id: "m2", body: "hello", displayBody: "hello", msgType: "text", subtype: null, replyToBody: locationBody },
  ];

  it("flag OFF (the seed): the page is byte-identical, whatever the client declares", async () => {
    const out = page();
    const snap = JSON.stringify(out);
    await decoratePlatformReads(flagClient({}), rows, out, { [CLIENT_SCHEMAS_HEADER]: "" });
    assert.equal(JSON.stringify(out), snap);
  });

  it("flag ON, a client declaring nothing: served as stored, with the schema named", async () => {
    const out = page();
    await decoratePlatformReads(flagClient({ [STRUCTURED_SCHEMAS_FLAG]: true }), rows, out, {});
    assert.equal(out[0]!.body, locationBody);
    assert.deepEqual((out[0] as any).structured, { schema: "location.scope.v1", fallback: false });
    assert.equal((out[1] as any).structured, undefined);
  });

  it("flag ON, a client that renders nothing structured: the location and the quote of it both degrade", async () => {
    const out = page();
    await decoratePlatformReads(flagClient({ [STRUCTURED_SCHEMAS_FLAG]: true }), rows, out, { [CLIENT_SCHEMAS_HEADER]: "" });
    const s = JSON.stringify(out);
    assert.ok(!s.includes(String(LAT)), "coordinates survived the fallback somewhere on the page");
    assert.equal(out[0]!.body, "Shared a location");
    assert.equal(out[1]!.body, "hello");
    assert.equal((out[1] as any).replyToBody, "Shared a location");
  });
});

// ── the write side, through the real routes ──────────────────────────────────

interface WState { schemas?: boolean }

function writeClient(state: WState) {
  const db: Record<string, any[]> = {
    feature_flags: [
      { flag: STRUCTURED_SCHEMAS_FLAG, enabled: state.schemas === true },
      { flag: "disable_messaging", enabled: false },
    ],
    message_threads: [{ id: THREAD, is_e2ee: false, thread_type: "group" }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null },
    ],
    messages: [],
    posts: [{ id: POST_OK, author_id: BOB, content: "A bar", visibility: "public", status: "active", deleted_at: null, media_urls: [], updated_at: "2026-05-01T00:00:00.000Z" }],
    profiles: [{ id: BOB, handle: "bob", name: "Bob", account_status: "active" }],
    hidden_gems: [{ id: GEM_ACTIVE, name: "Rooftop", city: "Hue", neighborhood: "Old town", category: "bar", status: "active", sensitivity_level: "public", merged_into: null, updated_at: "2026-05-02T00:00:00.000Z" }],
    places: [],
    blocks: [],
  };
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let inserted: any = null;
    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const t: any = {
      select() { return p; },
      insert(row: any) { inserted = { id: `m-${(db[table] ??= []).length + 1}`, ...row }; db[table]!.push(inserted); return p; },
      update() { return p; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return p; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return p; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return p; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return p; },
      maybeSingle() { return Promise.resolve({ data: inserted ?? rowsNow()[0] ?? null, error: null }); },
      single() { return t.maybeSingle(); },
      then(res: any, rej?: any) { return Promise.resolve({ data: inserted ? [inserted] : rowsNow(), error: null }).then(res, rej); },
    };
    const p: any = new Proxy(t, { get(o, k) { if (k in o) return o[k as string]; if (k === "catch" || k === "finally") return undefined; return () => p; } });
    return p;
  }
  return {
    _db: db, from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    channel: () => ({ send: async () => undefined, subscribe: () => undefined }),
    removeChannel: async () => undefined,
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

async function call(method: string, path: string, as: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", telegraphKindsRouter);
  app.use("/api", telegraphShareRouter);
  app.use("/api", telegraphForwardRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const announcement = { kind: "ANNOUNCEMENT", payload: { title: "Bus leaves at 9" } };

describe("T429 — the write side stamps and validates", () => {
  it("flag OFF (the seed): the typed body is exactly the old envelope, and a `schema` field is ignored", async () => {
    const c = writeClient({});
    _setTestClient(c, true);
    const r = await call("POST", `/threads/${THREAD}/typed-messages`, ALICE, { ...announcement, schema: "nonsense.v7" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const body = JSON.parse(c._db.messages!.at(-1)!.body);
    assert.deepEqual(Object.keys(body).sort(), ["envelopeVersion", "kind", "payload"]);
    assert.equal(r.body.schema, undefined);
  });

  it("flag ON: the typed body names its schema; a schema the server does not write is refused, nothing written", async () => {
    const c = writeClient({ schemas: true });
    _setTestClient(c, true);
    const ok = await call("POST", `/threads/${THREAD}/typed-messages`, ALICE, announcement);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(JSON.parse(c._db.messages!.at(-1)!.body).schema, "announcement.v1");
    assert.equal(ok.body.schema, "announcement.v1");
    const n = c._db.messages!.length;
    for (const bad of ["announcement.v2", "location.scope.v1", "nonsense"]) {
      const r = await call("POST", `/threads/${THREAD}/typed-messages`, ALICE, { ...announcement, schema: bad });
      assert.equal(r.status, 400, bad);
    }
    assert.equal(c._db.messages!.length, n, "a refused schema still wrote a row");
    const named = await call("POST", `/threads/${THREAD}/typed-messages`, ALICE, { ...announcement, schema: "announcement.v1" });
    assert.equal(named.status, 201);
  });

  it("flag ON: a share names the family's schema; the wrong family is refused", async () => {
    const c = writeClient({ schemas: true });
    _setTestClient(c, true);
    const r = await call("POST", `/threads/${THREAD}/share`, ALICE, { objectType: "POST", objectId: POST_OK });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(JSON.parse(c._db.messages!.at(-1)!.body).schema, "object.share.v1");
    const bad = await call("POST", `/threads/${THREAD}/share`, ALICE, { objectType: "POST", objectId: POST_OK, schema: "place.share.v1" });
    assert.equal(bad.status, 400);
  });

  it("schemaToStamp, directly", () => {
    assert.deepEqual(schemaToStamp({ kind: "LOCATION" }, undefined), { ok: true, schemaId: "location.scope.v1" });
    assert.deepEqual(schemaToStamp({ kind: "PORTAVA_OBJECT", objectType: "MEETUP_POINT" }, null), { ok: true, schemaId: "place.share.v1" });
    assert.equal(schemaToStamp({ kind: "LOCATION" }, "location.scope.v2").ok, false);
    assert.equal(schemaToStamp({ kind: "TEXT" }, undefined).ok, false);
  });
});

describe("T431 — share projections offer only the actions the client declared", () => {
  it("flag ON + a declaring client: undeclared actions are withheld and named; flag OFF or baseline: untouched", async () => {
    const refs = { refs: [{ objectType: "HIDDEN_GEM", objectId: GEM_ACTIVE }] };
    _setTestClient(writeClient({}), true);
    const off = await call("POST", `/threads/${THREAD}/share-projections`, ALICE, refs, { [CLIENT_ACTIONS_HEADER]: "" });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const offered = off.body.projections[0].actions as string[];
    assert.ok(offered.length > 0, "fixture: the post offers no actions, so this test proves nothing");

    _setTestClient(writeClient({ schemas: true }), true);
    const baseline = await call("POST", `/threads/${THREAD}/share-projections`, ALICE, refs);
    assert.deepEqual(baseline.body.projections[0].actions, offered);
    assert.equal(baseline.body.withheldActions, undefined);

    const keep = offered[0]!;
    const declared = await call("POST", `/threads/${THREAD}/share-projections`, ALICE, refs, { [CLIENT_ACTIONS_HEADER]: `${keep}.v1` });
    assert.deepEqual(declared.body.projections[0].actions, [keep]);
    assert.deepEqual(declared.body.withheldActions[0].actions, offered.slice(1));
    assert.equal(declared.body.withheldReason, "client_unsupported_action");
  });

  it("GET /telegraph/structured-schemas: feature_disabled while OFF, the registry while ON", async () => {
    _setTestClient(writeClient({}), true);
    assert.equal((await call("GET", "/telegraph/structured-schemas", ALICE)).body.error, "feature_disabled");
    _setTestClient(writeClient({ schemas: true }), true);
    const on = await call("GET", "/telegraph/structured-schemas", ALICE);
    assert.equal(on.status, 200);
    assert.ok(on.body.schemas.some((x: any) => x.id === "coordination.status.v1"));
    assert.equal(on.body.headers.schemas, CLIENT_SCHEMAS_HEADER);
  });
});
