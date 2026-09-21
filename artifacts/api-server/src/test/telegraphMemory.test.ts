/**
 * Telegraph §10 — Memory Notes, save-to-Memory, and the end-of-night recap.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §10.1 the `MemoryNoteShare` contract, and "shareable, saveable and
 *          actionable WITHOUT exposing the sender's canonical private Memory
 *          graph"
 *   §10.2 "A user may explicitly save a message, voice note, place share or
 *          media item as a private Memory draft. Telegraph NEVER automatically
 *          converts whole conversations into Memories."
 *   §10.3 the recap — "derived from confirmed session context and shared
 *          content references. It is an invitation to curate, not automatic
 *          historical truth."
 *
 * THE TWO PROHIBITIONS ARE THE POINT, and each is tested as a REFUSAL rather
 * than as an absence:
 *   - a Memory Note carrying a memory id is refused by name (§10.1);
 *   - a draft request naming a thread, a list or "all" is refused by name, and
 *     one call writes exactly one row (§10.2).
 *
 * SHOWN RED before commit (24 pass green), each mutation reverted:
 *   • `assertNoMemoryGraphLeak` returning ok for everything
 *       -> pass 22 / fail 2 ("REFUSES a note that would expose the sender's
 *          Memory graph", "the leak check is a refusal, not a strip")
 *   • the forbidden-key loop removed from the draft route
 *       -> pass 23 / fail 1 ("REFUSES a threadId, a list, or 'all' — by name")
 *   • `memoryDraftRow` writing `state: "published"`
 *       -> pass 22 / fail 2 ("the row is a draft and only-me, as literals",
 *          "promotes ONE message into a private draft")
 *   • `buildRecap` dropping the plan-window filter
 *       -> pass 22 / fail 2 ("counts only what happened inside the plan's own
 *          window", "recaps a completed plan and writes nothing")
 *
 * Run: node --import tsx/esm --test src/test/telegraphMemory.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphMemoryRouter from "../routes/telegraphMemory.js";
import {
  MEMORY_GRAPH_FIELDS,
  RECAP_CURATE_ACTIONS,
  assertNoMemoryGraphLeak,
  buildRecap,
  draftTitleFor,
  memoryDraftRow,
  parseMemoryNoteShare,
  recapHeadline,
} from "../services/telegraph/memoryNotes.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const THREAD_NONE = "dddddddd-0000-4000-8000-00000000000f";
const MEETUP = "20000000-0000-4000-8000-000000000001";

const M_TEXT = "11110000-0000-4000-8000-000000000001";
const M_PHOTO = "11110000-0000-4000-8000-000000000002";
const M_DELETED = "11110000-0000-4000-8000-000000000003";
const M_OTHER_THREAD = "11110000-0000-4000-8000-000000000004";

const NOW = Date.now();
const hrs = (n: number) => new Date(NOW + n * 3600_000).toISOString();

interface State {
  errorTable?: string;
  planEndsAt?: string;
  planStatus?: string;
  noPlan?: boolean;
}

function msg(id: string, over: Record<string, any> = {}) {
  return {
    id,
    thread_id: THREAD,
    sender_id: BOB,
    body: "",
    created_at: hrs(-4),
    deleted_at: null,
    msg_type: "text",
    subtype: null,
    media_type: null,
    media_url: null,
    ...over,
  };
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "telegraph_history_bound_enabled", enabled: false }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null },
      { thread_id: THREAD_NONE, user_id: CAROL, left_at: null, visible_from_at: null },
    ],
    meetups: state.noPlan
      ? []
      : [{
          id: MEETUP,
          title: "Dinner",
          starts_at: hrs(-6),
          ends_at: state.planEndsAt ?? hrs(-2),
          status: state.planStatus ?? "confirmed",
          chat_thread_id: THREAD,
          creator_id: BOB,
        }],
    meetup_invites: [
      { meetup_id: MEETUP, user_id: ALICE, status: "going" },
      { meetup_id: MEETUP, user_id: BOB, status: "going" },
      { meetup_id: MEETUP, user_id: CAROL, status: "declined" },
    ],
    messages: [
      msg(M_TEXT, { body: "what a night", created_at: hrs(-4) }),
      msg(M_PHOTO, { media_url: "https://x/1.jpg", media_type: "image", created_at: hrs(-3) }),
      msg("m-vid", { media_url: "https://x/1.mp4", media_type: "video", created_at: hrs(-3) }),
      msg("m-loc", { msg_type: "location", body: JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", payload: { label: "An Thuong", precision: "area" } }), created_at: hrs(-3) }),
      msg("m-gem", { msg_type: "portava_object", subtype: "hidden_gem", body: JSON.stringify({ kind: "PORTAVA_OBJECT", objectType: "HIDDEN_GEM", objectId: "g1", shareProjectionVersion: "1" }), created_at: hrs(-3) }),
      msg("m-album", { msg_type: "media_album", body: JSON.stringify({ kind: "MEDIA_ALBUM", envelopeVersion: "1", payload: { assets: [{ url: "a", mediaType: "image" }, { url: "b", mediaType: "image" }, { url: "c", mediaType: "video" }] } }), created_at: hrs(-3) }),
      // OUTSIDE the plan window — the morning after.
      msg("m-after", { media_url: "https://x/9.jpg", media_type: "image", created_at: hrs(-1) }),
      msg(M_DELETED, { media_url: "https://x/8.jpg", media_type: "image", created_at: hrs(-3), deleted_at: hrs(-2) }),
      msg(M_OTHER_THREAD, { thread_id: THREAD_NONE, body: "not yours", created_at: hrs(-4) }),
    ],
    memories: [],
    saved_messages: [],
  };
}

function makeClient(state: State) {
  const db = fixture(state);
  const inserted: Array<{ table: string; row: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;
    let pendingInsert: any = null;

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
      select() { return proxy; },
      insert(row: any) {
        pendingInsert = { id: `new-${inserted.length + 1}`, ...row };
        inserted.push({ table, row: pendingInsert });
        (db[table] ??= []).push(pendingInsert);
        return proxy;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      gte(col: string, val: any) { filters.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
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
  app.use("/api", telegraphMemoryRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── §10.1 the contract ───────────────────────────────────────────────────────

describe("§10.1 — MemoryNoteShare", () => {
  it("carries §10.1's eight fields and nothing else", () => {
    const r = parseMemoryNoteShare({
      memoryNoteId: "n1",
      authorId: BOB,
      text: "the bridge at midnight",
      voiceAssetId: null,
      placeId: "p1",
      occurredAt: hrs(-4),
      mediaAssetIds: ["a1", "a2"],
    });
    assert.equal(r.ok, true);
    const note = r.ok === true ? r.note : null;
    assert.deepEqual(Object.keys(note!).sort(), [
      "authorId", "mediaAssetIds", "memoryNoteId", "occurredAt", "placeId",
      "shareProjectionVersion", "text", "voiceAssetId",
    ]);
    assert.equal(note!.shareProjectionVersion, "1");
  });

  it("REFUSES a note that would expose the sender's Memory graph", () => {
    for (const field of MEMORY_GRAPH_FIELDS) {
      const r = parseMemoryNoteShare({ memoryNoteId: "n1", authorId: BOB, [field]: "x" });
      assert.equal(r.ok, false, `${field} must be refused`);
      assert.ok(String(r.ok === false && r.error).includes(field));
    }
  });

  it("the leak check is a refusal, not a strip", () => {
    assert.deepEqual(assertNoMemoryGraphLeak({ memoryId: "m1" }), { ok: false, field: "memoryId" });
    assert.deepEqual(assertNoMemoryGraphLeak({ text: "fine" }), { ok: true });
    assert.deepEqual(assertNoMemoryGraphLeak(null), { ok: true });
  });

  it("refuses a note with no id or no author", () => {
    assert.equal(parseMemoryNoteShare({ authorId: BOB }).ok, false);
    assert.equal(parseMemoryNoteShare({ memoryNoteId: "n1" }).ok, false);
  });
});

// ── §10.2 the draft ──────────────────────────────────────────────────────────

describe("§10.2 — a PRIVATE draft, one message at a time", () => {
  it("the row is a draft and only-me, as literals", () => {
    const row = memoryDraftRow({
      messageId: M_TEXT, ownerId: ALICE, title: "t", caption: null, occurredAt: hrs(-4), source: "message",
    });
    assert.equal(row.state, "draft");
    assert.equal(row.visibility, "only_me");
    assert.equal(row.owner_id, ALICE);
    assert.deepEqual(row.allowed_user_ids, []);
  });

  it("titles a draft from the message, or from what kind it was", () => {
    assert.equal(draftTitleFor("message", "  what a   night "), "what a night");
    assert.equal(draftTitleFor("media", ""), "Saved photo");
    assert.equal(draftTitleFor("place_share", null), "Saved place");
  });

  it("promotes ONE message into a private draft", async () => {
    const c = useState({});
    const r = await post("/me/memory-drafts", ALICE, { messageId: M_TEXT });
    assert.equal(r.status, 201);
    assert.equal(r.body.draft.state, "draft");
    assert.equal(r.body.draft.visibility, "only_me");
    assert.equal(r.body.draft.fromMessageId, M_TEXT);
    const memories = (c as any)._inserted.filter((i: any) => i.table === "memories");
    assert.equal(memories.length, 1, "exactly one row per call");
    assert.equal(memories[0].row.owner_id, ALICE);
  });

  it("a media message becomes a media-sourced draft", async () => {
    useState({});
    const r = await post("/me/memory-drafts", ALICE, { messageId: M_PHOTO });
    assert.equal(r.status, 201);
    assert.equal(r.body.draft.source, "media");
  });

  it("REFUSES a threadId, a list, or 'all' — by name", async () => {
    const c = useState({});
    for (const body of [
      { threadId: THREAD },
      { messageIds: [M_TEXT, M_PHOTO] },
      { conversationId: THREAD },
      { all: true },
    ]) {
      const r = await post("/me/memory-drafts", ALICE, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} must be refused`);
      assert.ok(String(r.body.message).includes("whole conversations"));
    }
    assert.equal((c as any)._inserted.filter((i: any) => i.table === "memories").length, 0);
  });

  it("a deleted message cannot be promoted", async () => {
    const c = useState({});
    const r = await post("/me/memory-drafts", ALICE, { messageId: M_DELETED });
    assert.equal(r.status, 404);
    assert.equal((c as any)._inserted.filter((i: any) => i.table === "memories").length, 0);
  });

  it("a message in a thread you are not in cannot be promoted", async () => {
    const c = useState({});
    const r = await post("/me/memory-drafts", ALICE, { messageId: M_OTHER_THREAD });
    assert.equal(r.status, 403);
    assert.equal((c as any)._inserted.filter((i: any) => i.table === "memories").length, 0);
  });

  it("an unreadable messages table is a 500, never a silent success", async () => {
    useState({ errorTable: "messages" });
    assert.equal((await post("/me/memory-drafts", ALICE, { messageId: M_TEXT })).status, 500);
  });
});

// ── §10.3 the recap ──────────────────────────────────────────────────────────

describe("§10.3 — the recap is derived from CONFIRMED session context", () => {
  it("counts only what happened inside the plan's own window", () => {
    const recap = buildRecap({
      threadId: THREAD,
      planId: MEETUP,
      windowStartsAt: hrs(-6),
      windowEndsAt: hrs(-2),
      participantIds: [ALICE, BOB],
      rows: [
        { id: "a", sender_id: BOB, created_at: hrs(-3), media_type: "image", media_url: "u" },
        { id: "b", sender_id: BOB, created_at: hrs(-1), media_type: "image", media_url: "u" },
      ],
    });
    assert.equal(recap.counts.photos, 1, "the morning-after photo is not part of the night");
    assert.deepEqual(recap.sourceMessageIds, ["a"]);
  });

  it("people are the plan's CONFIRMED participants, not everyone who typed", () => {
    const recap = buildRecap({
      threadId: THREAD, planId: MEETUP, windowStartsAt: hrs(-6), windowEndsAt: hrs(-2),
      participantIds: [ALICE, BOB],
      rows: [{ id: "a", sender_id: CAROL, created_at: hrs(-3), body: "hi" }],
    });
    assert.equal(recap.counts.people, 2);
  });

  it("a deleted message is not part of the night (§7.4)", () => {
    const recap = buildRecap({
      threadId: THREAD, planId: MEETUP, windowStartsAt: hrs(-6), windowEndsAt: hrs(-2),
      participantIds: [],
      rows: [{ id: "a", sender_id: BOB, created_at: hrs(-3), media_type: "image", media_url: "u", deleted_at: hrs(-2) }],
    });
    assert.equal(recap.counts.photos, 0);
  });

  it("counts album assets, locations and shared places", () => {
    const recap = buildRecap({
      threadId: THREAD, planId: MEETUP, windowStartsAt: hrs(-6), windowEndsAt: hrs(-2),
      participantIds: [ALICE],
      rows: [
        { id: "al", sender_id: BOB, created_at: hrs(-3), msg_type: "media_album", body: JSON.stringify({ kind: "MEDIA_ALBUM", envelopeVersion: "1", payload: { assets: [{ url: "a", mediaType: "image" }, { url: "b", mediaType: "video" }] } }) },
        { id: "lo", sender_id: BOB, created_at: hrs(-3), msg_type: "location", body: JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", payload: { label: "An Thuong", precision: "area" } }) },
        { id: "ge", sender_id: BOB, created_at: hrs(-3), msg_type: "portava_object", subtype: "hidden_gem", body: JSON.stringify({ objectId: "g1" }) },
      ],
    });
    assert.equal(recap.counts.photos, 1);
    assert.equal(recap.counts.videos, 1);
    assert.equal(recap.counts.places, 2);
  });

  it("is an INVITATION: it offers §10.3's four actions and says it wrote nothing", () => {
    const recap = buildRecap({
      threadId: THREAD, planId: MEETUP, windowStartsAt: hrs(-6), windowEndsAt: hrs(-2),
      participantIds: [ALICE], rows: [],
    });
    assert.deepEqual([...recap.curateActions], ["CREATE_MEMORY", "SHARE_PHOTOS", "FOLLOW_PEOPLE_YOU_MET", "DONE"]);
    assert.equal(recap.invitation, true);
    assert.equal(recap.empty, true);
  });

  it("renders §10.3's headline", () => {
    assert.equal(recapHeadline({ places: 4, people: 6, photos: 18, videos: 2 }), "4 places · 6 people · 18 photos · 2 videos");
    assert.equal(recapHeadline({ places: 1, people: 1, photos: 0, videos: 0 }), "1 place · 1 person");
  });
});

describe("GET /threads/:id/recap", () => {
  it("recaps a completed plan and writes nothing", async () => {
    const c = useState({});
    const r = await get(`/threads/${THREAD}/recap`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.wrote, "nothing");
    assert.equal(r.body.recap.planId, MEETUP);
    assert.equal(r.body.recap.counts.people, 2, "going only — Carol declined");
    assert.equal(r.body.recap.counts.photos, 3, "one photo, two album images");
    assert.equal(r.body.recap.counts.videos, 2);
    assert.equal(r.body.recap.counts.places, 2);
    assert.ok(String(r.body.headline).includes("places"));
    assert.equal((c as any)._inserted.length, 0, "a recap is a READ");
  });

  it("a thread with no completed plan gets no recap, not an invented one", async () => {
    useState({ noPlan: true });
    const r = await get(`/threads/${THREAD}/recap`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.recap, null);
    assert.equal(r.body.reason, "no_completed_plan");
  });

  it("a plan still running is not recapped", async () => {
    useState({ planEndsAt: hrs(+2) });
    const r = await get(`/threads/${THREAD}/recap`, ALICE);
    assert.equal(r.body.recap, null);
  });

  it("a cancelled plan is not recapped", async () => {
    useState({ planStatus: "cancelled" });
    const r = await get(`/threads/${THREAD}/recap`, ALICE);
    assert.equal(r.body.recap, null);
  });

  it("a non-member cannot read a recap", async () => {
    useState({});
    assert.equal((await get(`/threads/${THREAD_NONE}/recap`, ALICE)).status, 403);
  });

  it("an unreadable messages table is a 500, never an empty recap", async () => {
    useState({ errorTable: "messages" });
    assert.equal((await get(`/threads/${THREAD}/recap`, ALICE)).status, 500);
  });
});
