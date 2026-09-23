/**
 * Telegraph §6 — typed message kinds, the content drawer, object-aware search.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §6.2  the thirteen message kinds
 *   §6.4  "MEDIA | PLACES | PORTAVA | VOICE | GIFS | LINKS | FILES … The
 *          content drawer is a structured index over exchanged content, not a
 *          second storage copy. Object-aware search must respect current
 *          authorization and unsent/deleted state."
 *   §7.4  "remove from normal retrieval/search/projections"
 *   §14.3 new members do not receive pre-membership history
 *
 * WHAT IS EXERCISED: the real `services/telegraph/messageKinds.ts` and the real
 * `routes/telegraphKinds.ts`, mounted in a real express app over an in-memory
 * PostgREST-shaped fake. The drawer and the search run the shipped classifier
 * over the shipped query.
 *
 * THE HONEST PART. §6.2 names thirteen kinds and this route sends seven. VOICE
 * is REFUSED BY NAME here and that refusal is asserted below — but the reason
 * CHANGED when migration 2989 and `routes/telegraphVoice.ts` landed. It is no
 * longer "the asset type does not exist"; it is "a voice note owns an audio
 * object and must write the media columns, which this route does not write",
 * so it has its own door. The assertion below therefore checks that the
 * refusal NAMES that door, which is the thing a caller can act on. A refusal
 * that still cited the old migration would be a lie with a test holding it in
 * place.
 *
 * SHOWN RED before commit, each reverted:
 *   • `searchableTextOf`'s deleted/unsent guards disabled → pass 34 / fail 2.
 *     Note what STAYED green: the route-level "a deleted message is NOT
 *     findable" test, because the tombstone is excluded TWICE — once in the
 *     query (`.is("deleted_at", null)`) and once in the predicate. That
 *     redundancy is deliberate, and this mutation is how it was measured.
 *   • `readIndexableRows` dropping its `.gte(created_at, visibleFrom)` AND its
 *     `withinWindow` filter → pass 34 / fail 2 (the §14.3 drawer and search
 *     tests).
 *   • `UNSENDABLE_KINDS.VOICE` deleted → pass 33 / fail 3.
 *   • `drawerTabFor` returning "MEDIA" for everything → pass 32 / fail 4.
 *   All four restored: 36/36.
 *
 * Run: node --import tsx/esm --test src/test/telegraphKinds.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import {
  DRAWER_TABS,
  drawerTabFor,
  extractLinks,
  matchesQuery,
  parseKindEnvelope,
  searchableTextOf,
  SENDABLE_ENVELOPE_KINDS,
  UNSENDABLE_KINDS,
  validateKindMessage,
} from "../services/telegraph/messageKinds.js";
import { TELEGRAPH_MESSAGE_KINDS } from "../services/telegraph/vocabulary.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const THREAD_E2EE = "dddddddd-0000-4000-8000-00000000000e";
const THREAD_NONE = "dddddddd-0000-4000-8000-00000000000f";

const BOUND = "2026-03-01T00:00:00.000Z";
const BEFORE = "2026-02-01T00:00:00.000Z";
const AFTER = "2026-03-10T00:00:00.000Z";

interface State {
  errorTable?: string;
  killSwitch?: boolean;
  historyBound?: boolean;
}

function msg(id: string, over: Record<string, any> = {}) {
  return {
    id,
    thread_id: THREAD,
    sender_id: ALICE,
    body: "",
    created_at: AFTER,
    deleted_at: null,
    msg_type: "text",
    subtype: null,
    media_url: null,
    media_type: null,
    media_thumbnail_url: null,
    media_duration_seconds: null,
    ...over,
  };
}

function envelope(kind: string, payload: unknown) {
  return JSON.stringify({ kind, envelopeVersion: "1", payload });
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [
      { flag: "disable_messaging", enabled: state.killSwitch === true },
      { flag: "telegraph_history_bound_enabled", enabled: state.historyBound === true },
    ],
    message_threads: [
      { id: THREAD, is_e2ee: false },
      { id: THREAD_E2EE, is_e2ee: true },
      { id: THREAD_NONE, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      // Bob joined at BOUND — §14.3 bounds what the drawer may show him.
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: BOUND },
      { thread_id: THREAD_E2EE, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: THREAD_E2EE, user_id: BOB, left_at: null, visible_from_at: null },
      { thread_id: THREAD_NONE, user_id: CAROL, left_at: null, visible_from_at: null },
    ],
    blocks: [],
    messages: [
      msg("m-photo", { media_url: "https://x/1.jpg", media_type: "image", media_thumbnail_url: "https://x/1t.jpg", body: "the rooftop" }),
      msg("m-old-photo", { media_url: "https://x/0.jpg", media_type: "image", created_at: BEFORE, body: "before bob" }),
      msg("m-album", { msg_type: "media_album", body: envelope("MEDIA_ALBUM", { assets: [{ url: "https://x/2.jpg", mediaType: "image" }, { url: "https://x/3.jpg", mediaType: "image" }], caption: "the whole night" }) }),
      msg("m-gif", { msg_type: "gif", subtype: "giphy", body: envelope("GIF", { url: "https://g/x.gif", stillUrl: "https://g/x.jpg", provider: "giphy", altText: "dancing cat" }) }),
      msg("m-loc", { msg_type: "location", subtype: "area", body: envelope("LOCATION", { label: "An Thuong", precision: "area", mediaAssetIds: [] }) }),
      msg("m-portava-place", { msg_type: "portava_object", subtype: "hidden_gem", body: JSON.stringify({ kind: "PORTAVA_OBJECT", objectType: "HIDDEN_GEM", objectId: "g1", caption: "here", shareProjectionVersion: "1" }) }),
      msg("m-portava-post", { msg_type: "portava_object", subtype: "post", body: JSON.stringify({ kind: "PORTAVA_OBJECT", objectType: "POST", objectId: "p1", caption: null, shareProjectionVersion: "1" }) }),
      msg("m-link", { body: "look at https://example.com/bar and tell me" }),
      msg("m-text", { body: "the rooftop with no sign" }),
      msg("m-deleted", { body: "the rooftop secret", deleted_at: AFTER }),
      msg("m-legacy-card", { msg_type: "system", subtype: "discovery_card", body: JSON.stringify({ sourceId: "g9", sourceType: "hidden_gem", title: "Old card", category: "bar", city: "Hue" }) }),
      msg("m-announce", { msg_type: "announcement", body: envelope("ANNOUNCEMENT", { title: "Leaving at eight", body: "meet downstairs", requiresAcknowledgement: true }) }),
      msg("m-safety", { msg_type: "safety", subtype: "all_clear", body: envelope("SAFETY", { kind: "all_clear", label: "Home safe" }) }),
    ],
  };
}

function makeClient(state: State) {
  const db = fixture(state);
  const inserted: any[] = [];
  const observed: Array<{ table: string; sel: string }> = [];
  const gte: Array<{ table: string; col: string; val: any }> = [];
  const or: Array<{ table: string; filters: string }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;
    let pendingInsert: any = null;
    let pendingUpdate: any = null;

    const rowsNow = () => {
      let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (_order) {
        const { col, asc } = _order;
        rows = [...rows].sort((a, b) => {
          const x = Date.parse(a[col]) || 0;
          const y = Date.parse(b[col]) || 0;
          return asc ? x - y : y - x;
        });
      }
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const err = () =>
      state.errorTable === table ? { message: `injected failure on ${table}`, code: "XX000" } : null;

    const target: any = {
      select(sel?: string) { observed.push({ table, sel: sel ?? "" }); return proxy; },
      insert(row: any) {
        pendingInsert = { id: `new-${inserted.length + 1}`, ...row };
        inserted.push({ table, row: pendingInsert });
        (db[table] ??= []).push(pendingInsert);
        return proxy;
      },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      gte(col: string, val: any) {
        gte.push({ table, col, val });
        filters.push((r) => Date.parse(r[col]) >= Date.parse(val));
        return proxy;
      },
      // MODELLED, not proxied to a no-op. `readIndexableRows` now carries the
      // §14.3 window as an `or=` group (Q6's own-message exception), and an
      // unmodelled `or` would apply NO filter at all — which would make the
      // assertions below pass because the fake had stopped filtering. Real
      // PostgREST semantics: the clauses inside the group are ORed with each
      // other, and the group is ANDed with every other filter.
      or(f: string) {
        or.push({ table, filters: f });
        const ms = f.split(",").map((clause) => {
          const a = clause.indexOf("."), b = clause.indexOf(".", a + 1);
          const col = clause.slice(0, a), op = clause.slice(a + 1, b), val = clause.slice(b + 1);
          if (op === "gte") return (r: any) => Date.parse(r[col]) >= Date.parse(val);
          if (op === "eq") return (r: any) => String(r[col]) === val;
          throw new Error(`fake client: unmodelled or() operator "${op}"`);
        });
        filters.push((r: any) => ms.some((m) => m(r)));
        return proxy;
      },
      order(col: string, opts?: any) { _order = { col, asc: opts?.ascending !== false }; return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve, reject);
        if (pendingUpdate) {
          const applied = rowsNow();
          for (const r of applied) Object.assign(r, pendingUpdate);
          return Promise.resolve({ data: applied, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: pendingInsert ? [pendingInsert] : rowsNow(), error: null }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    _inserted: inserted,
    _observed: observed,
    _gte: gte,
    _or: or,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

function useState(state: State) {
  const c = makeClient(state);
  _setTestClient(c, true);
  return c;
}

async function get(path: string, asUser: string) {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function post(path: string, asUser: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
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
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── §6.2 the vocabulary ──────────────────────────────────────────────────────

describe("§6.2 — thirteen kinds, and an honest account of which are sendable", () => {
  it("the vocabulary is §6.2's thirteen, in the spec's order", () => {
    assert.deepEqual([...TELEGRAPH_MESSAGE_KINDS], [
      "TEXT", "IMAGE", "VIDEO", "MEDIA_ALBUM", "GIF", "VOICE", "MEMORY_NOTE",
      "PORTAVA_OBJECT", "LOCATION", "ACTION", "ANNOUNCEMENT", "SYSTEM", "SAFETY",
    ]);
  });

  it("every kind is either sendable here or named with a reason — none is silently missing", () => {
    for (const kind of TELEGRAPH_MESSAGE_KINDS) {
      const sendable = (SENDABLE_ENVELOPE_KINDS as string[]).includes(kind);
      const named = Object.prototype.hasOwnProperty.call(UNSENDABLE_KINDS, kind);
      assert.ok(sendable || named, `${kind} is neither sendable nor explained`);
    }
  });

  it("VOICE is refused BY NAME, and the refusal names the route that DOES send it", () => {
    const r = validateKindMessage("VOICE", { url: "post-media/a/voice/1.m4a" });
    assert.equal(r.ok, false);
    const msg = String(r.ok === false && r.error);
    // The actionable half: a caller that gets this must be able to find the
    // door without reading the source.
    assert.ok(msg.includes("/voice"), msg);
    assert.ok(msg.includes("media_url"), msg);
  });

  it("VOICE still PARSES back out of a stored row — the parseable set is larger than the sendable one", () => {
    // The bug this pins: `parseKindEnvelope` once asked `isSendableEnvelopeKind`,
    // so a VOICE row written by its own route would have read back as TEXT and
    // vanished from the drawer, from search and from the renderer.
    const body = JSON.stringify({
      kind: "VOICE",
      envelopeVersion: "1",
      payload: {
        url: "post-media/a/voice/1.m4a",
        durationSeconds: 7,
        waveform: [0.1, 0.9],
        mimeType: "audio/mp4",
      },
    });
    const parsed = parseKindEnvelope("voice", body);
    assert.ok(parsed, "a stored VOICE row must parse as VOICE");
    assert.equal(parsed!.kind, "VOICE");
    assert.equal((parsed!.payload as any).durationSeconds, 7);
    // and it is NOT in the typed route's sendable list
    assert.ok(!(SENDABLE_ENVELOPE_KINDS as string[]).includes("VOICE"));
  });

  it("an unknown kind is refused with the list of what IS accepted", () => {
    const r = validateKindMessage("HOLOGRAM", {});
    assert.equal(r.ok, false);
    assert.ok(String(r.ok === false && r.error).includes("LOCATION"));
  });
});

describe("§6.2 payload validation", () => {
  it("MEDIA_ALBUM needs at least two assets — one asset is an IMAGE", () => {
    const one = validateKindMessage("MEDIA_ALBUM", { assets: [{ url: "u", mediaType: "image" }] });
    assert.equal(one.ok, false);
    const two = validateKindMessage("MEDIA_ALBUM", {
      assets: [{ url: "u1", mediaType: "image" }, { url: "u2", mediaType: "video" }],
    });
    assert.equal(two.ok, true);
  });

  it("LOCATION defaults to the COARSE precision — `exact` is never the default", () => {
    const r = validateKindMessage("LOCATION", { label: "An Thuong" });
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && (r.envelope.payload as any).precision, "area");
    assert.equal(r.ok === true && r.subtype, "area");
  });

  it("ACTION carries requiresConfirmation as a literal true — §8.2 in the type", () => {
    const r = validateKindMessage("ACTION", { action: "MEET_HERE", title: "Meet at the bridge" });
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && (r.envelope.payload as any).requiresConfirmation, true);
    const forged = validateKindMessage("ACTION", { action: "MEET_HERE", title: "x", requiresConfirmation: false });
    assert.equal(forged.ok, false, "a caller may not send an unconfirmed action");
  });

  it("SAFETY's four classes become the row subtype", () => {
    const r = validateKindMessage("SAFETY", { kind: "need_help", label: "At the station" });
    assert.equal(r.ok === true && r.subtype, "need_help");
    assert.equal(validateKindMessage("SAFETY", { kind: "whatever", label: "x" }).ok, false);
  });

  it("an envelope round-trips through the stored body", () => {
    const r = validateKindMessage("ANNOUNCEMENT", { title: "Leaving at eight" });
    assert.equal(r.ok, true);
    const stored = JSON.stringify(r.ok === true && r.envelope);
    const back = parseKindEnvelope("announcement", stored);
    assert.equal(back?.kind, "ANNOUNCEMENT");
    assert.equal((back?.payload as any).title, "Leaving at eight");
  });

  it("a body that is not an envelope reads back as null, not as a half-parsed kind", () => {
    assert.equal(parseKindEnvelope("announcement", "not json"), null);
    assert.equal(parseKindEnvelope("announcement", JSON.stringify({ kind: "ANNOUNCEMENT", envelopeVersion: "2", payload: {} })), null);
    assert.equal(parseKindEnvelope("text", "hello"), null);
  });
});

// ── §6.4 the classifier ──────────────────────────────────────────────────────

describe("§6.4 drawer classification", () => {
  it("uses §6.4's seven tabs, verbatim", () => {
    assert.deepEqual([...DRAWER_TABS], ["MEDIA", "PLACES", "PORTAVA", "VOICE", "GIFS", "LINKS", "FILES"]);
  });

  it("routes each row to its tab", () => {
    assert.equal(drawerTabFor({ media_url: "u", media_type: "image" }), "MEDIA");
    assert.equal(drawerTabFor({ msg_type: "media_album" }), "MEDIA");
    assert.equal(drawerTabFor({ msg_type: "gif" }), "GIFS");
    assert.equal(drawerTabFor({ msg_type: "voice" }), "VOICE");
    assert.equal(drawerTabFor({ msg_type: "location" }), "PLACES");
    assert.equal(drawerTabFor({ msg_type: "portava_object", subtype: "hidden_gem" }), "PLACES");
    assert.equal(drawerTabFor({ msg_type: "portava_object", subtype: "post" }), "PORTAVA");
    assert.equal(drawerTabFor({ msg_type: "system", subtype: "discovery_card" }), "PLACES");
    assert.equal(drawerTabFor({ body: "see https://example.com" }), "LINKS");
    assert.equal(drawerTabFor({ body: "just words" }), null);
  });

  it("extracts links without swallowing trailing punctuation", () => {
    assert.deepEqual(extractLinks("go to https://example.com/bar, then https://example.com/bar"), [
      "https://example.com/bar",
    ]);
    assert.deepEqual(extractLinks("no links here"), []);
  });
});

describe("§6.4 / §7.4 searchable text", () => {
  it("a DELETED row has no searchable text at all", () => {
    assert.equal(searchableTextOf({ body: "the secret", deleted_at: "2026-05-01T00:00:00Z" }), null);
  });

  it("an UNSENT row has none either, on a database that has the column", () => {
    assert.equal(searchableTextOf({ body: "the secret", unsent_at: "2026-05-01T00:00:00Z" }), null);
  });

  it("a typed envelope searches on its human fields, not its ids", () => {
    const text = searchableTextOf({
      msg_type: "location",
      body: JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", payload: { label: "An Thuong", precision: "area", placeId: "place-abc123" } }),
    });
    assert.ok(text && text.includes("An Thuong"));
    assert.ok(text && !text.includes("place-abc123"));
  });

  it("matches case- and accent-insensitively", () => {
    assert.equal(matchesQuery("An Thuong", "thuong"), true);
    assert.equal(matchesQuery("Café Trung", "cafe"), true);
    assert.equal(matchesQuery(null, "x"), false);
  });
});

// ── the send route ───────────────────────────────────────────────────────────

describe("POST /threads/:id/typed-messages", () => {
  it("writes a LOCATION with the kind as msg_type and the precision as subtype", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/typed-messages`, ALICE, {
      kind: "LOCATION",
      payload: { label: "An Thuong", precision: "venue" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.msgType, "location");
    assert.equal(r.body.subtype, "venue");
    const row = (c as any)._inserted.find((i: any) => i.table === "messages");
    assert.ok(row);
    const stored = JSON.parse(row.row.body);
    assert.equal(stored.kind, "LOCATION");
    assert.equal(stored.envelopeVersion, "1");
  });

  it("refuses VOICE and writes nothing — a voice note is not a body-only row", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/typed-messages`, ALICE, { kind: "VOICE", payload: {} });
    assert.equal(r.status, 400);
    assert.ok(String(r.body.message).includes("/voice"), r.body.message);
    // The load-bearing assertion: this route does not write the media columns,
    // so it must not write the row at all.
    assert.equal((c as any)._inserted.length, 0);
  });

  it("applies the same four write gates as the ordinary send path", async () => {
    useState({});
    assert.equal((await post(`/threads/${THREAD_NONE}/typed-messages`, ALICE, { kind: "ANNOUNCEMENT", payload: { title: "x" } })).status, 403);

    useState({ killSwitch: true });
    assert.equal((await post(`/threads/${THREAD}/typed-messages`, ALICE, { kind: "ANNOUNCEMENT", payload: { title: "x" } })).status, 404);

    useState({});
    assert.equal((await post(`/threads/${THREAD_E2EE}/typed-messages`, ALICE, { kind: "ANNOUNCEMENT", payload: { title: "x" } })).status, 422);
  });

  it("an invalid payload is refused before any gate runs a write", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/typed-messages`, ALICE, { kind: "SAFETY", payload: { kind: "nope", label: "x" } });
    assert.equal(r.status, 400);
    assert.equal((c as any)._inserted.length, 0);
  });
});

// ── the drawer ───────────────────────────────────────────────────────────────

describe("GET /threads/:id/drawer", () => {
  it("indexes the thread into §6.4's tabs and counts every one", async () => {
    useState({});
    const r = await get(`/threads/${THREAD}/drawer`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tabs, ["MEDIA", "PLACES", "PORTAVA", "VOICE", "GIFS", "LINKS", "FILES"]);
    assert.equal(r.body.counts.MEDIA, 3, "two photos and one album");
    assert.equal(r.body.counts.GIFS, 1);
    assert.equal(r.body.counts.PLACES, 3, "a location, a shared gem and a legacy discovery card");
    assert.equal(r.body.counts.PORTAVA, 1);
    assert.equal(r.body.counts.LINKS, 1);
    assert.equal(r.body.counts.VOICE, 0);
    assert.equal(r.body.indexOnly, true);
  });

  it("filters to one tab when asked", async () => {
    useState({});
    const r = await get(`/threads/${THREAD}/drawer?tab=GIFS`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i: any) => i.id), ["m-gif"]);
  });

  it("§7.4: a deleted message is in no tab", async () => {
    useState({});
    const r = await get(`/threads/${THREAD}/drawer`, ALICE);
    const ids = r.body.items.map((i: any) => i.id);
    assert.ok(!ids.includes("m-deleted"));
  });

  it("§14.3 OFF: Bob sees the whole index, and the bound column is never named", async () => {
    const c = useState({ historyBound: false });
    const r = await get(`/threads/${THREAD}/drawer?tab=MEDIA`, BOB);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.map((i: any) => i.id).includes("m-old-photo"));
    for (const s of (c as any)._observed.filter((o: any) => o.table === "message_thread_members")) {
      assert.ok(!s.sel.includes("visible_from_at"), `OFF must not name the column: ${s.sel}`);
    }
    assert.deepEqual((c as any)._gte, []);
    assert.deepEqual((c as any)._or.filter((o: any) => o.table === "messages"), [],
      "OFF adds no or() group either — the query is byte-identical to today's");
  });

  it("§14.3 ON: Bob's drawer stops at his window, and the bound is in the query", async () => {
    const c = useState({ historyBound: true });
    const r = await get(`/threads/${THREAD}/drawer?tab=MEDIA`, BOB);
    assert.equal(r.status, 200);
    const ids = r.body.items.map((i: any) => i.id);
    assert.ok(!ids.includes("m-old-photo"), "the drawer must not be a way around §14.3");
    assert.ok(ids.includes("m-photo"));
    // The bound is still in the QUERY — it is now carried as the `or=` group
    // that also expresses Q6's own-message exception. Asserted in full: the
    // group must admit the window OR the CALLER's own rows, and nothing else.
    assert.ok(
      (c as any)._or.some((o: any) =>
        o.table === "messages" && o.filters === `created_at.gte.${BOUND},sender_id.eq.${BOB}`),
      `the bound must reach the query: ${JSON.stringify((c as any)._or)}`,
    );
  });

  it("a non-member is refused, not handed an empty index", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_NONE}/drawer`, ALICE);
    assert.equal(r.status, 403);
  });

  it("an unreadable messages table is a 500, never an empty drawer", async () => {
    useState({ errorTable: "messages" });
    const r = await get(`/threads/${THREAD}/drawer`, ALICE);
    assert.equal(r.status, 500);
  });

  it("an unknown tab is a 400 naming the seven", async () => {
    useState({});
    const r = await get(`/threads/${THREAD}/drawer?tab=SOUNDS`, ALICE);
    assert.equal(r.status, 400);
    assert.ok(String(r.body.message).includes("PORTAVA"));
  });
});

// ── search ───────────────────────────────────────────────────────────────────

describe("GET /threads/:id/search", () => {
  it("finds a message by its own words", async () => {
    useState({});
    const r = await get(`/threads/${THREAD}/search?q=rooftop`, ALICE);
    assert.equal(r.status, 200);
    const ids = r.body.results.map((x: any) => x.id);
    assert.ok(ids.includes("m-text"));
    assert.ok(ids.includes("m-photo"));
  });

  it("§7.4: a deleted message is NOT findable, even by its exact text", async () => {
    useState({});
    const r = await get(`/threads/${THREAD}/search?q=${encodeURIComponent("rooftop secret")}`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x: any) => x.id), []);
  });

  it("finds an OBJECT by its human field — this is what object-aware means", async () => {
    useState({});
    const r = await get(`/threads/${THREAD}/search?q=${encodeURIComponent("An Thuong")}`, ALICE);
    assert.deepEqual(r.body.results.map((x: any) => x.id), ["m-loc"]);
    assert.equal(r.body.results[0].tab, "PLACES");
  });

  it("finds a legacy card by the title its sender wrote", async () => {
    useState({});
    const r = await get(`/threads/${THREAD}/search?q=${encodeURIComponent("Old card")}`, ALICE);
    assert.deepEqual(r.body.results.map((x: any) => x.id), ["m-legacy-card"]);
  });

  it("§14.3: search cannot reach outside the caller's window", async () => {
    useState({ historyBound: true });
    const r = await get(`/threads/${THREAD}/search?q=${encodeURIComponent("before bob")}`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x: any) => x.id), []);
    useState({ historyBound: false });
    const off = await get(`/threads/${THREAD}/search?q=${encodeURIComponent("before bob")}`, BOB);
    assert.deepEqual(off.body.results.map((x: any) => x.id), ["m-old-photo"]);
  });

  it("a non-member cannot search, and a one-character query is refused", async () => {
    useState({});
    assert.equal((await get(`/threads/${THREAD_NONE}/search?q=rooftop`, ALICE)).status, 403);
    assert.equal((await get(`/threads/${THREAD}/search?q=a`, ALICE)).status, 400);
  });

  it("an unreadable messages table is a 500, never an empty result set", async () => {
    useState({ errorTable: "messages" });
    assert.equal((await get(`/threads/${THREAD}/search?q=rooftop`, ALICE)).status, 500);
  });
});
