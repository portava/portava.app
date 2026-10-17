/**
 * census-telegraph T431 (§30A.16) — the server honours what the MOBILE CLIENT
 * actually sends. Cross-tree: this suite imports the client's own declaration
 * (travel-buddy-standalone/src/features/telegraph/negotiation/clientCapabilities.ts,
 * a pure module) and runs the server's negotiation on it.
 *
 * The client derives its headers from its renderers (its jest suites
 * capabilityHeaders / capabilityHeaderRequests hold that). This suite holds the
 * other half: that those exact headers, parsed by `parseClientCapabilities` and
 * applied by `decoratePlatformReads` (what GET /threads/:id/messages runs on
 * `req.headers`) and the share-projection filter, serve every declared schema as
 * itself and every undeclared one as the server's own sentence — and that the
 * `schema` the client puts on a coordination post is accepted and stamped.
 *
 * WHAT TURNS THIS RED
 *   - the client's mirror drifting from STRUCTURED_SCHEMAS (an id, kind, carrier,
 *     version or object type) — then its `schema` would be refused, or its
 *     declaration would name something else;
 *   - the §8.1 vocabulary drifting;
 *   - a declared schema served as a fallback, or an undeclared one served raw;
 *   - a coordination post the client composes refused (400) with the flag on.
 *
 * Stays W while `telegraph_structured_schemas_enabled` is seeded FALSE (3665,
 * unapplied): with it OFF the server reads neither header (asserted below).
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphClientNegotiation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import {
  STRUCTURED_SCHEMAS,
  STRUCTURED_SCHEMAS_FLAG,
  clientPerformsAction,
  clientRendersSchema,
  negotiateRender,
  parseClientCapabilities,
  schemaToStamp,
} from "../services/telegraph/structuredSchemas.js";
import { decoratePlatformReads } from "../services/telegraph/platformReadDecorations.js";
import { TELEGRAPH_ACTIONS } from "../services/telegraph/vocabulary.js";
import { COORDINATION_ENVELOPE_VERSION } from "../services/telegraph/coordination.js";
import { buildPortavaObjectBody } from "../services/telegraph/shareables.js";
/**
 * The client's module, loaded at RUNTIME from the app tree. The specifier is not a
 * literal on purpose: a literal import puts the module's TYPE graph (its card
 * helper's type-only reference to the React Native share hook, and through it the
 * app's Supabase client and DOM timers) into this package's test-typecheck
 * program, where `setTimeout(...).unref` then stops compiling in every server
 * scheduler. Its shape is declared here instead — the exports this suite uses —
 * and the values are the real module's.
 */
interface ClientNegotiationModule {
  CLIENT_ACTION_VOCABULARY: readonly string[];
  CLIENT_SCHEMA_MIRROR: ReadonlyArray<{ id: string; family: string; version: number; carrier: string; kind: string; objectTypes?: readonly string[] }>;
  coordinationSchemaFor(kind: string): string | undefined;
  shareProjectionHeaders(): Record<string, string>;
  telegraphReadHeaders(surface: "conversation" | "group_chat"): Record<string, string>;
  withCoordinationSchema<T extends { kind: string; payload: unknown }>(body: T): T & { schema?: string };
}
const CLIENT_MODULE = ["..", "..", "..", "..", "travel-buddy-standalone", "src", "features", "telegraph", "negotiation", "clientCapabilities.ts"].join("/");
const client = (await import(CLIENT_MODULE)) as ClientNegotiationModule;
const { CLIENT_ACTION_VOCABULARY, CLIENT_SCHEMA_MIRROR, coordinationSchemaFor, shareProjectionHeaders, telegraphReadHeaders, withCoordinationSchema } = client;

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "10000000-0000-4000-8000-000000000001";

const env = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: "1", payload });
const coord = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: COORDINATION_ENVELOPE_VERSION, payload });

/** One valid stored v1 row per kind the client may receive (server validators, not the client's). */
const ROWS: Array<{ id: string; msg_type: string; subtype?: string | null; body: string }> = [
  { id: "loc", msg_type: "location", subtype: "area", body: env("LOCATION", { label: "An Thuong", precision: "area" }) },
  { id: "gif", msg_type: "gif", body: env("GIF", { url: "post-media/g.gif" }) },
  { id: "album", msg_type: "media_album", body: env("MEDIA_ALBUM", { assets: [{ url: "post-media/a.jpg", mediaType: "image" }, { url: "post-media/b.jpg", mediaType: "image" }] }) },
  { id: "ann", msg_type: "announcement", body: env("ANNOUNCEMENT", { title: "Bus at 9" }) },
  { id: "safety", msg_type: "safety", subtype: "need_help", body: env("SAFETY", { kind: "need_help", label: "at the pier" }) },
  { id: "note", msg_type: "memory_note", body: env("MEMORY_NOTE", { memoryNoteId: "n1", authorId: BOB, text: "lanterns" }) },
  { id: "voice", msg_type: "voice", body: env("VOICE", { url: "voice-notes/a.m4a", durationSeconds: 3, mimeType: "audio/mp4" }) },
  { id: "action", msg_type: "action", subtype: "meet_here", body: env("ACTION", { action: "MEET_HERE", title: "Meet at the bridge", requiresConfirmation: true }) },
  { id: "place", msg_type: "portava_object", subtype: "place", body: JSON.stringify(buildPortavaObjectBody("PLACE", "p1", null)) },
  { id: "trip", msg_type: "portava_object", subtype: "trip", body: JSON.stringify(buildPortavaObjectBody("TRIP", "t1", null)) },
  { id: "status", msg_type: "coordination", body: coord("COORDINATION", { state: "ON_MY_WAY" }) },
  { id: "text", msg_type: "text", body: "hello" },
];

describe("T431 — the client's mirror and vocabulary are the server's", () => {
  it("every registry schema is mirrored with the same id, family, version, carrier, kind and object types — and nothing else is", () => {
    const server = STRUCTURED_SCHEMAS.map((s) => ({ id: s.id, family: s.family, version: s.version, carrier: s.carrier, kind: s.kind, objectTypes: s.objectTypes ? [...s.objectTypes] : undefined }));
    const client = CLIENT_SCHEMA_MIRROR.map((s) => ({ id: s.id, family: s.family, version: s.version, carrier: s.carrier, kind: s.kind, objectTypes: s.objectTypes ? [...s.objectTypes] : undefined }));
    assert.deepEqual(client, server);
  });

  it("§8.1's actions, the same list in the same order", () => {
    assert.deepEqual([...CLIENT_ACTION_VOCABULARY], [...TELEGRAPH_ACTIONS]);
  });
});

describe("T431 — what the client sends, as the server reads it", () => {
  const conversation = parseClientCapabilities(telegraphReadHeaders("conversation"));
  const groupChat = parseClientCapabilities(telegraphReadHeaders("group_chat"));
  const cards = parseClientCapabilities(shareProjectionHeaders());

  it("both headers are PRESENT (declared), so the server takes them literally — never the baseline", () => {
    for (const caps of [conversation, groupChat, cards]) assert.equal(caps.declaredSchemas && caps.declaredActions, true);
  });

  it("the conversation renders the envelope kinds and the shares, no coordination kind; the group chat, the shares only", () => {
    const rendered = (caps: typeof conversation) => STRUCTURED_SCHEMAS.filter((s) => clientRendersSchema(caps, s)).map((s) => s.id).sort();
    assert.deepEqual(rendered(conversation), STRUCTURED_SCHEMAS.filter((s) => s.carrier !== "coordination").map((s) => s.id).sort());
    assert.deepEqual(rendered(groupChat), STRUCTURED_SCHEMAS.filter((s) => s.carrier === "portava_object").map((s) => s.id).sort());
  });

  it("the stream performs no action; a card performs exactly ADD_TO_TRIP and MEET_HERE", () => {
    for (const a of TELEGRAPH_ACTIONS) {
      assert.equal(clientPerformsAction(conversation, a), false, a);
      assert.equal(clientPerformsAction(cards, a), a === "ADD_TO_TRIP" || a === "MEET_HERE", a);
    }
  });

  it("negotiateRender on real rows: each declared row is served as itself; coordination and ACTION get the server's sentence", () => {
    const served = (caps: typeof conversation) => Object.fromEntries(ROWS.map((r) => { const n = negotiateRender(r, caps); return [r.id, n.fallback ? `${n.reason}:${n.label}` : "self"]; }));
    assert.deepEqual(served(conversation), {
      loc: "self", gif: "self", album: "self", ann: "self", safety: "self", note: "self", voice: "self",
      action: "client_unsupported_action:Proposed an action",
      place: "self", trip: "self",
      status: "client_unsupported_schema:Posted a status update",
      text: "self",
    });
    const g = served(groupChat);
    assert.equal(g.place, "self");
    assert.equal(g.safety, "client_unsupported_schema:Needs help — open the latest app to see details", "SAFETY keeps its class for the group chat's fallback");
    assert.equal(g.loc, "client_unsupported_schema:Shared a location");
  });
});

// ── through decoratePlatformReads, which GET /threads/:id/messages applies to req.headers ──

function flagClient(on: boolean) {
  return {
    from(table: string) {
      const q: any = {
        select: () => q, eq: (_c: string, v: string) => { q._flag = v; return q; }, in: () => q,
        maybeSingle: async () => ({ data: table === "feature_flags" ? { enabled: on && q._flag === STRUCTURED_SCHEMAS_FLAG } : null, error: null }),
        then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return q;
    },
  };
}
const page = () => ROWS.map((r) => ({ id: r.id, body: r.body, displayBody: r.body, msgType: r.msg_type, subtype: r.subtype ?? null }));

describe("T431 — the thread page, as the conversation's headers arrive", () => {
  it("flag ON: every row the conversation draws keeps its payload; the coordination row and the ACTION arrive as plain text", async () => {
    const out = page();
    await decoratePlatformReads(flagClient(true), ROWS, out, telegraphReadHeaders("conversation"));
    const by = Object.fromEntries(out.map((m) => [m.id, m]));
    for (const id of ["loc", "gif", "album", "ann", "safety", "note", "voice", "place", "trip"]) {
      assert.equal(by[id]!.body, ROWS.find((r) => r.id === id)!.body, `${id} was degraded although the client draws it`);
      assert.equal((by[id] as any).structured?.fallback, false, id);
    }
    assert.equal(by.status!.body, "Posted a status update");
    assert.equal(by.status!.msgType, "text", "the client's stream gets a bubble it can draw, not a type it prints as 'can't be shown'");
    assert.equal(by.action!.body, "Proposed an action");
  });

  it("flag OFF (the seed): the page is byte-identical whatever the client sends — why T431 stays W", async () => {
    const out = page();
    const snap = JSON.stringify(out);
    await decoratePlatformReads(flagClient(false), ROWS, out, telegraphReadHeaders("group_chat"));
    assert.equal(JSON.stringify(out), snap);
  });
});

// ── the coordination post, through the real route ───────────────────────────

describe("T431 — every coordination post the client composes is accepted and stamped with the flag ON", () => {
  it("schemaToStamp accepts the client's id for every coordination kind it knows", () => {
    const kinds = CLIENT_SCHEMA_MIRROR.filter((s) => s.carrier === "coordination").map((s) => s.kind);
    assert.equal(kinds.length, 11);
    for (const k of kinds) assert.deepEqual(schemaToStamp({ kind: k }, coordinationSchemaFor(k)), { ok: true, schemaId: coordinationSchemaFor(k) }, k);
  });

  let server: ReturnType<typeof createServer>;
  let base = "";
  before(async () => {
    const { default: router } = await import("../routes/telegraphCoordination.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use("/api", router);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(async () => {
    _setTestClient(null, false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function routeClient(flagOn: boolean) {
    const db: Record<string, any[]> = {
      feature_flags: [{ flag: "disable_messaging", enabled: false }, { flag: STRUCTURED_SCHEMAS_FLAG, enabled: flagOn }],
      message_thread_members: [{ thread_id: THREAD, user_id: ALICE, left_at: null, muted_at: null }, { thread_id: THREAD, user_id: BOB, left_at: null, muted_at: null }],
      message_threads: [{ id: THREAD, is_e2ee: false, thread_type: "group", status: "active" }],
      messages: [], blocks: [], profiles: [{ id: ALICE, handle: "alice" }], profile_privacy_settings: [], notifications: [],
    };
    let n = 0;
    function from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let mode: "select" | "insert" = "select";
      let inserted: any = null;
      const result = () => (mode === "insert" ? { data: inserted, error: null } : { data: (db[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
      const t: any = {
        select() { return p; },
        insert(row: any) { mode = "insert"; inserted = { id: `row-${++n}`, created_at: new Date().toISOString(), ...row }; (db[table] ??= []).push(inserted); return p; },
        eq(c: string, v: any) { filters.push((r) => String(r[c]) === String(v)); return p; },
        neq(c: string, v: any) { filters.push((r) => String(r[c]) !== String(v)); return p; },
        is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return p; },
        in(c: string, vs: any[]) { filters.push((r) => vs.map(String).includes(String(r[c]))); return p; },
        maybeSingle() { const r = result(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }); },
        single() { return t.maybeSingle(); },
        then(res: any, rej?: any) { return Promise.resolve(result()).then(res, rej); },
      };
      const p: any = new Proxy(t, { get(o, k) { if (k in o) return o[k as string]; if (k === "catch" || k === "finally") return undefined; return () => p; } });
      return p;
    }
    return { db, from, rpc: async () => ({ data: null, error: { code: "PGRST202" } }), auth: { getUser: async (tok: string) => ({ data: { user: { id: tok } }, error: null }) }, channel: () => ({ send: async () => undefined, subscribe: () => undefined }), removeChannel: async () => undefined } as any;
  }
  async function post(body: unknown) {
    const r = await fetch(`${base}/threads/${THREAD}/coordination`, { method: "POST", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }

  it("a quick state, exactly as the client's postQuickState builds it: 201, stored and echoed as coordination.status.v1", async () => {
    const c = routeClient(true);
    _setTestClient(c, true);
    const body = withCoordinationSchema({ kind: "COORDINATION", payload: { state: "ON_MY_WAY" } });
    assert.equal(body.schema, "coordination.status.v1");
    const r = await post(body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.schema, "coordination.status.v1");
    assert.equal(JSON.parse(c.db.messages.at(-1).body).schema, "coordination.status.v1");
  });

  it("a session, as postCoordinationKind builds it: 201 and stamped by the session writer", async () => {
    const c = routeClient(true);
    _setTestClient(c, true);
    const r = await post(withCoordinationSchema({ kind: "COORDINATION_SESSION", payload: { title: "Dinner", idempotencyKey: "k-1" } }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.schema, "coordination.session.v1");
  });

  it("CONTROL: a schema the client did NOT compose for the kind is refused — the acceptance above is not vacuous", async () => {
    const c = routeClient(true);
    _setTestClient(c, true);
    const r = await post({ kind: "COORDINATION", payload: { state: "ON_MY_WAY" }, schema: coordinationSchemaFor("VOTE") });
    assert.equal(r.status, 400);
  });

  it("flag OFF (the seed): the client's `schema` is ignored and the stored body is the old envelope", async () => {
    const c = routeClient(false);
    _setTestClient(c, true);
    const r = await post(withCoordinationSchema({ kind: "COORDINATION", payload: { state: "ARRIVED" } }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(JSON.parse(c.db.messages.at(-1).body)).sort(), ["envelopeVersion", "kind", "payload"]);
  });
});
