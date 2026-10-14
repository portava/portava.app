/**
 * census-telegraph T448 / T359 / T445 (lane w-tg-cardtruth, 2026-10-14) —
 * EVERY server door that reads a shared card, driven through the real routes
 * and services.
 *
 * T448 (W since §45c): "Historical card text is still served AS CURRENT by
 * three doors: the Compass tool getSharedPlaces …, thread search …, and
 * GET /threads/:id/messages (the full snapshot body)". The lane's recon added
 * the rest of the readers that hand a card body to a viewer: the reply quote,
 * the translated body, the group-chat read, saved messages, edit history, the
 * inbox preview, the drawer and in-thread search, and the Memory draft title.
 *
 * THE ONE ASSERTION, REPEATED AT EVERY DOOR: every card in this fixture is
 * stored with the word SNAPSHOT in every source-derived field — title, city,
 * blurb, image, the venue label, the translation of the card. A door passes
 * only if SNAPSHOT appears NOWHERE in what it returns, and a live card is
 * served by its source's CURRENT name. Written against main, every door below
 * returned SNAPSHOT (the lane report lists the red run); none imports the new
 * module, so this file runs unchanged on main.
 *
 * Fixture: Alice (viewer) and Bob (sender) in one trip thread. Bob shared
 *   M_PLACE   a Discovery card for a place since RENAMED      → live, current name
 *   M_GEM     a Discovery card for a gem since made PROTECTED → unavailable
 *   M_POST    a post card for a post by Carol, who BLOCKED Alice → unavailable
 *   M_COMPASS a Compass `place:` pick (no §5 family)         → withheld
 *   M_CIRCLE  a Circle meeting-point card with a venue label → withheld
 *   M_REPLY   plain text quoting M_GEM
 * Alice has a stored translation of M_PLACE (the translated SNAPSHOT), has
 * saved M_PLACE and M_GEM, and M_PLACE has an edit-history version.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphCardTruthDoors.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphMemoryRouter from "../routes/telegraphMemory.js";
import groupChatRouter from "../routes/groupChat.js";
import { searchConversations } from "../services/telegraphSearch.js";
import { telegraphGetSharedPlaces, telegraphSearchConversation } from "../compass/TelegraphConversationTools.js";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b2";
const CAROL = "cccccccc-0000-4000-8000-0000000000c3";
const THREAD = "00000000-0000-4000-8000-0000000000d4";
const TRIP = "eeeeeeee-0000-4000-8000-0000000000e5";

const PLACE = "11111111-0000-4000-8000-000000000001";
const GEM = "22222222-0000-4000-8000-000000000002";
const POST = "33333333-0000-4000-8000-000000000003";

const M_PLACE = "a0000000-0000-4000-8000-000000000001";
const M_GEM = "a0000000-0000-4000-8000-000000000002";
const M_POST = "a0000000-0000-4000-8000-000000000003";
const M_COMPASS = "a0000000-0000-4000-8000-000000000004";
const M_CIRCLE = "a0000000-0000-4000-8000-000000000005";
const M_REPLY = "a0000000-0000-4000-8000-000000000006";

const SNAP = "SNAPSHOT";
const CURRENT_NAME = "Sky36 Rooftop (now)";

const placeCard = JSON.stringify({ sourceId: PLACE, sourceType: "place", title: `${SNAP} Sky36`, category: `${SNAP} bar`, city: `${SNAP} Hanoi`, blurb: `${SNAP} blurb`, imageUrl: `https://img/${SNAP}.jpg`, priceLevel: `${SNAP}$$`, caption: "you'd love this" });
const gemCard = JSON.stringify({ sourceId: GEM, sourceType: "hidden_gem", title: `${SNAP} spring`, category: `${SNAP} nature`, city: `${SNAP} Hue`, blurb: `${SNAP} where it is` });
const postCard = JSON.stringify({ postId: POST, authorName: `${SNAP} Carol`, authorHandle: `${SNAP}carol`, snippet: `${SNAP} her words`, city: `${SNAP} city`, likeCount: 3 });
const compassCard = JSON.stringify({ type: "compass_card", id: "place:9f9f", cardType: "place", title: `${SNAP} pick`, city: `${SNAP} city`, category: `${SNAP} cat`, description: `${SNAP} desc`, imageUrl: null });
const circleCard = JSON.stringify({ subtype: "meeting_point", venueLabel: `${SNAP} venue`, approxArea: `${SNAP} area` });

function msg(id: string, sender: string, body: string, created_at: string, extra: Record<string, unknown> = {}) {
  return {
    id, thread_id: THREAD, sender_id: sender, body, created_at,
    deleted_at: null, edited_at: null, original_language: null, msg_type: "text", subtype: null,
    media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null,
    reply_to_id: null, sequence: null, ...extra,
  };
}

function fixture(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", account_status: "active" },
      { id: BOB, handle: "bob", name: "Bob", account_status: "active" },
      { id: CAROL, handle: "carol", name: "Carol", account_status: "active" },
    ],
    trips: [{ id: TRIP, owner_id: BOB, title: "Hanoi", destination_city: "Hanoi", status: "active" }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: BOB, role: "owner", status: "accepted" },
    ],
    message_threads: [
      { id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "Hanoi", status: "active", is_e2ee: false,
        created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T06:00:00.000Z", last_message_at: "2026-10-01T06:00:00.000Z" },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, role: "member", joined_at: "2026-10-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, role: "member", joined_at: "2026-10-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      msg(M_PLACE, BOB, placeCard, "2026-10-01T01:00:00.000Z", { msg_type: "system", subtype: "discovery_card" }),
      msg(M_GEM, BOB, gemCard, "2026-10-01T02:00:00.000Z", { msg_type: "system", subtype: "discovery_card" }),
      msg(M_POST, BOB, postCard, "2026-10-01T03:00:00.000Z", { msg_type: "system", subtype: "post_card" }),
      msg(M_COMPASS, BOB, compassCard, "2026-10-01T04:00:00.000Z", { msg_type: "system", subtype: "compass_card" }),
      msg(M_REPLY, BOB, "look at that one", "2026-10-01T05:00:00.000Z", { reply_to_id: M_GEM }),
      msg(M_CIRCLE, BOB, circleCard, "2026-10-01T06:00:00.000Z", { msg_type: "circle_status_card", subtype: "meeting_point" }),
    ],
    message_translations: [
      { message_id: M_PLACE, recipient_id: ALICE, source_language: "vi", target_language: "en", translated_body: `${SNAP} translated card`, status: "translated", confidence: "high" },
    ],
    saved_messages: [
      { user_id: ALICE, message_id: M_PLACE, saved_at: "2026-10-02T00:00:00.000Z" },
      { user_id: ALICE, message_id: M_GEM, saved_at: "2026-10-02T00:01:00.000Z" },
    ],
    message_edits: [
      { message_id: M_PLACE, version: 1, previous_body: placeCard.replace("Sky36", "Older"), editor_id: BOB, edited_at: "2026-10-01T01:30:00.000Z" },
    ],
    places: [{ id: PLACE, name: CURRENT_NAME, city: "Hanoi", neighborhood: "Hoan Kiem", primary_category: "bar", status: "active", updated_at: "2026-10-10T00:00:00.000Z" }],
    hidden_gems: [{ id: GEM, name: "Secret Spring", city: "Hue", neighborhood: "Hills", category: "nature", status: "active", sensitivity_level: "protected", merged_into: null, updated_at: null }],
    posts: [{ id: POST, author_id: CAROL, content: "Carol's words", visibility: "public", status: "active", post_status: "published", deleted_at: null, media_urls: [], location_privacy_mode: "exact", created_at: "2026-09-01T00:00:00.000Z", updated_at: null }],
    blocks: [{ blocker_id: CAROL, blocked_id: ALICE }],
    memories: [],
  };
}

// ── a PostgREST fake (models or(), so no filter silently disappears) ─────────

function splitTop(s: string): string[] {
  const out: string[] = [];
  let d = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") { d++; cur += ch; } else if (ch === ")") { d--; cur += ch; }
    else if (ch === "," && d === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function clause(c: string): (r: any) => boolean {
  const a = c.indexOf("."), b = c.indexOf(".", a + 1);
  const col = c.slice(0, a), op = c.slice(a + 1, b), val = c.slice(b + 1);
  if (op === "gte") return (r) => Date.parse(r[col]) >= Date.parse(val);
  if (op === "gt") return (r) => Date.parse(r[col]) > Date.parse(val);
  if (op === "lt") return (r) => Date.parse(r[col]) < Date.parse(val);
  if (op === "lte") return (r) => Date.parse(r[col]) <= Date.parse(val);
  if (op === "eq") return (r) => String(r[col]) === val;
  if (op === "is") return (r) => (val === "null" ? r[col] == null : String(r[col]) === val);
  if (op === "in") { const items = splitTop(val.replace(/^\(/, "").replace(/\)$/, "")).map((x) => x.replace(/^"|"$/g, "")); return (r) => items.includes(String(r[col])); }
  throw new Error(`fake: unmodelled or() operator ${op}`);
}

function makeClient(db: Record<string, any[]>) {
  let idSeq = 0;
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let lim: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let single = false;
    let head = false;
    let pendingInsert: any[] | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    const rows = () => {
      let rs = (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (order) { const { col, asc } = order; rs = [...rs].sort((x, y) => { const a = Date.parse(x[col]) || 0, b = Date.parse(y[col]) || 0; return asc ? a - b : b - a; }); }
      return lim !== null ? rs.slice(0, lim) : rs;
    };
    const run = () => {
      if (pendingInsert) {
        const ins = pendingInsert.map((r) => ({ id: r.id ?? `ins-${table}-${++idSeq}`, ...r }));
        (db[table] ??= []).push(...ins);
        return single ? { data: ins[0], error: null } : { data: ins, error: null };
      }
      if (pendingUpdate) { for (const r of rows()) Object.assign(r, pendingUpdate); return { data: null, error: null }; }
      const rs = rows();
      if (single) return { data: rs[0] ?? null, error: null };
      return { data: head ? null : rs, error: null, count: rs.length };
    };
    const b: any = {
      select(_s?: string, o?: any) { if (o?.head) head = true; return b; },
      insert(v: any) { pendingInsert = Array.isArray(v) ? v : [v]; return b; },
      upsert(v: any) { pendingInsert = Array.isArray(v) ? v : [v]; return b; },
      update(v: any) { pendingUpdate = v; return b; },
      delete() { return b; },
      eq(c: string, v: unknown) { preds.push((r) => String(r[c]) === String(v)); return b; },
      neq(c: string, v: unknown) { preds.push((r) => String(r[c]) !== String(v)); return b; },
      in(c: string, vs: unknown[]) { const s = new Set(vs.map(String)); preds.push((r) => s.has(String(r[c]))); return b; },
      is(c: string, v: unknown) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not(c: string, op: string, v: unknown) { if (op === "is") preds.push((r) => (v === null ? r[c] != null : r[c] !== v)); return b; },
      lt(c: string, v: any) { preds.push((r) => Date.parse(r[c]) < Date.parse(v)); return b; },
      gt(c: string, v: any) { preds.push((r) => (typeof v === "number" ? Number(r[c]) > v : Date.parse(r[c]) > Date.parse(v))); return b; },
      gte(c: string, v: any) { preds.push((r) => Date.parse(r[c]) >= Date.parse(v)); return b; },
      lte(c: string, v: any) { preds.push((r) => Date.parse(r[c]) <= Date.parse(v)); return b; },
      ilike(c: string, p: string) { const n = p.replace(/%/g, "").toLowerCase(); preds.push((r) => String(r[c] ?? "").toLowerCase().includes(n)); return b; },
      or(f: string) { const ms = splitTop(f).map(clause); preds.push((r) => ms.some((m) => m(r))); return b; },
      order(c: string, o?: any) { order = { col: c, asc: o?.ascending !== false }; return b; },
      limit(n: number) { lim = n; return b; },
      range(a: number, z: number) { lim = z - a + 1; return b; },
      maybeSingle() { single = true; return b; },
      single() { single = true; return b; },
      then(res: (v: any) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return new Proxy(b, { get(t, p) { if (p in t) return t[p as string]; if (p === "catch" || p === "finally") return undefined; return () => b; } });
  }
  return {
    _db: db,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    channel: () => ({ send: async () => "ok", subscribe: () => ({}) }),
    removeChannel: async () => "ok",
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

// ── harness ──────────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let base = "";
let client: ReturnType<typeof makeClient>;

async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", messagingRouter);
  app.use("/api", telegraphKindsRouter);
  app.use("/api", telegraphMemoryRouter);
  app.use("/api", groupChatRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { client = makeClient(fixture()); _setTestClient(client, true); });

function noSnapshot(where: string, payload: unknown) {
  const s = typeof payload === "string" ? payload : JSON.stringify(payload);
  assert.ok(!s.includes(SNAP), `${where} served a card's stored snapshot:\n${s.slice(0, 1200)}`);
}

// ── the doors ────────────────────────────────────────────────────────────────

describe("T448 door 1 — GET /threads/:id/messages", () => {
  it("serves no snapshot anywhere: body, translated body, reply quote, venue label", async () => {
    const r = await call("GET", `/threads/${THREAD}/messages`, ALICE);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    noSnapshot("GET /threads/:id/messages", r.body);
  });

  it("serves a live card by its source's CURRENT name, with the truth on the message", async () => {
    const r = await call("GET", `/threads/${THREAD}/messages`, ALICE);
    const m = (r.body.messages as any[]).find((x) => x.id === M_PLACE);
    assert.equal(JSON.parse(m.body).title, CURRENT_NAME);
    assert.equal(m.displayBody, m.body, "a card's display body is the served body, never a translation of the snapshot");
    assert.equal(m.card?.state, "live");
    assert.equal(m.card?.projection?.title, CURRENT_NAME);
  });

  it("a protected gem and a blocker's post are unavailable; a Compass place pick and a meeting point are withheld", async () => {
    const r = await call("GET", `/threads/${THREAD}/messages`, ALICE);
    const by = new Map((r.body.messages as any[]).map((x) => [x.id, x]));
    assert.equal(by.get(M_GEM).card?.state, "unavailable");
    assert.equal(by.get(M_POST).card?.state, "unavailable");
    assert.equal(by.get(M_COMPASS).card?.state, "withheld");
    assert.equal(by.get(M_CIRCLE).card?.state, "withheld");
    assert.equal(by.get(M_REPLY).card, undefined, "plain text is not a card");
  });
});

describe("T448 door 2 — the group-chat read (GET /trips/:tripId/chat)", () => {
  it("serves no snapshot", async () => {
    const r = await call("GET", `/trips/${TRIP}/chat`, ALICE);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(Array.isArray(r.body.messages), r.text.slice(0, 600));
    assert.ok((r.body.messages as any[]).length >= 5);
    noSnapshot("GET /trips/:tripId/chat", r.body);
    const m = (r.body.messages as any[]).find((x) => x.id === M_PLACE);
    assert.equal(JSON.parse(m.body).title, CURRENT_NAME);
  });
});

describe("T448 door 3 — GET /me/saved-messages", () => {
  it("serves no snapshot, and the saved card as it is now", async () => {
    const r = await call("GET", `/me/saved-messages`, ALICE);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal((r.body.saved as any[]).length, 2);
    noSnapshot("GET /me/saved-messages", r.body);
  });
});

describe("T448 door 4 — GET /threads/:id/messages/:id/edits", () => {
  it("serves neither the snapshot as the current body nor in an old version", async () => {
    const r = await call("GET", `/threads/${THREAD}/messages/${M_PLACE}/edits`, ALICE);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    noSnapshot("GET edits", r.body);
    assert.equal(JSON.parse(r.body.currentBody).title, CURRENT_NAME);
  });
});

describe("T448 door 5 — GET /me/threads (the inbox preview)", () => {
  it("previews a card with nothing from its source", async () => {
    const r = await call("GET", `/me/threads`, ALICE);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    noSnapshot("GET /me/threads", r.body);
  });
});

describe("T448 / T359 door 6 — the drawer and in-thread search", () => {
  it("the drawer indexes no snapshot", async () => {
    const r = await call("GET", `/threads/${THREAD}/drawer`, ALICE);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    noSnapshot("GET /threads/:id/drawer", r.body);
  });

  it("searching the snapshot finds nothing; searching the current name finds the card", async () => {
    const miss = await call("GET", `/threads/${THREAD}/search?q=${SNAP}`, ALICE);
    assert.equal(miss.status, 200, miss.text.slice(0, 300));
    assert.deepEqual(miss.body.results, [], "a snapshot is not a haystack");
    const hit = await call("GET", `/threads/${THREAD}/search?q=${encodeURIComponent("Rooftop (now)")}`, ALICE);
    assert.deepEqual((hit.body.results as any[]).map((x) => x.id), [M_PLACE]);
    noSnapshot("GET /threads/:id/search", hit.body);
  });
});

describe("T448 / T359 door 7 — §21 search and Compass's search tool", () => {
  it("a term only the snapshot contains is not a hit; the current name is, with the current title", async () => {
    const miss = await searchConversations(client as any, ALICE, SNAP);
    assert.deepEqual(miss.hits, []);
    const hit = await searchConversations(client as any, ALICE, "Rooftop");
    assert.deepEqual(hit.hits.map((h) => h.messageId), [M_PLACE]);
    assert.equal(hit.hits[0].objectTitle, CURRENT_NAME);
    noSnapshot("searchConversations", hit);
    const tool = await telegraphSearchConversation(client as any, ALICE, { conversationId: THREAD, query: SNAP });
    noSnapshot("telegraph_search_conversation", tool);
  });
});

describe("T448 door 8 — Compass getSharedPlaces", () => {
  it("hands the model the source as it is now, and an unavailable card as unavailable — never the snapshot", async () => {
    const out: any = await telegraphGetSharedPlaces(client as any, ALICE, { conversationId: THREAD });
    assert.equal(out.authorized, true, JSON.stringify(out));
    noSnapshot("telegraph_get_shared_places", out);
    const byId = new Map((out.places as any[]).map((p) => [p.messageId, p]));
    assert.equal(byId.get(M_PLACE)?.title, CURRENT_NAME);
    assert.equal(byId.get(M_GEM)?.available, false);
    assert.equal(byId.get(M_GEM)?.title, undefined);
  });
});

describe("T448 door 9 — a Memory draft made from a card", () => {
  it("is titled by the source as it is now, never by the snapshot JSON", async () => {
    const live = await call("POST", `/me/memory-drafts`, ALICE, { messageId: M_PLACE });
    assert.equal(live.status, 201, live.text.slice(0, 300));
    assert.equal(live.body.draft.title, CURRENT_NAME);
    const gone = await call("POST", `/me/memory-drafts`, ALICE, { messageId: M_GEM });
    assert.equal(gone.status, 201, gone.text.slice(0, 300));
    assert.equal(gone.body.draft.title, "Saved place");
    noSnapshot("memory drafts", client._db.memories);
  });
});
