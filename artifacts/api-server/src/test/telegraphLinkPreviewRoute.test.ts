/**
 * census-telegraph T404 / T446 (B58 TM-1) — the two link-preview doors in
 * `routes/telegraphLinkPreview.ts`, driven through their real handlers over
 * `failClosedSupabase` (the double checked against the real client).
 *
 * WHAT IS PROVED
 *   P*  The POST: OFF reads nothing and fetches nothing; only the SENDER of a
 *       live plain-text message in a plaintext thread a member can read, within
 *       15 minutes of writing it, gets a fetch; the URL fetched is the stored
 *       body's first external https link and never anything from the request;
 *       one fetch per message (a repeat is served from storage, a concurrent
 *       second POST waits for the first); every unreadable input is a 503 with
 *       no fetch.
 *   R*  The GET: it NEVER fetches (the network is replaced by a thrower and the
 *       transport is booby-trapped; a POST through the same router reaching the
 *       same spy is the positive control); it serves a stored row only for a
 *       message the caller may read now — member, not E2EE, not deleted or
 *       unsent, in the §14.3 window, no block either way — and only beside the
 *       body it was made from; every unreadable input is a 503.
 *
 * `telegraph_store_link_preview` (3825) is modelled here by an rpc handler that
 * applies the function's checks to the same rows; the function itself runs on a
 * real database in `src/test/db/telegraphLinkPreviews.db.test.ts`.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphLinkPreviewRoute.test.ts
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { OutboundFetchGate, type PreviewResult } from "../lib/outboundPreviewFetch.js";
import { makeFailClosedClient, noopLog, type FakeDbError } from "./helpers/failClosedSupabase.js";
import {
  createLinkPreviewRouter,
  linkPreviewGetHandler,
  linkPreviewPostHandler,
  parseIds,
} from "../routes/telegraphLinkPreview.js";
import { firstExternalUrl, portavaOwnHosts, sourceDigest, LINK_PREVIEW_BATCH_MAX } from "../services/telegraph/linkPreviews.js";
import { PORTAVA_LINK_HOSTS } from "../lib/inputAssistance/pasteEventLinks.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // sender
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // recipient
const CAROL = "cccccccc-0000-4000-8000-000000000003"; // not a member
const DAVE = "dddddddd-0000-4000-8000-000000000004"; // a member in a block with BOB
const TOKENS: Record<string, string> = { "t-alice": ALICE, "t-bob": BOB, "t-carol": CAROL, "t-dave": DAVE };

const THREAD = "70000000-0000-4000-8000-000000000001";
const E2EE_THREAD = "70000000-0000-4000-8000-000000000002";
const OTHER_THREAD = "70000000-0000-4000-8000-000000000003";

const M_LINK = "30000000-0000-4000-8000-000000000001";
const M_OLD = "30000000-0000-4000-8000-000000000002";
const M_CARD = "30000000-0000-4000-8000-000000000003";
const M_DELETED = "30000000-0000-4000-8000-000000000004";
const M_HTTP = "30000000-0000-4000-8000-000000000005";
const M_OWN_FIRST = "30000000-0000-4000-8000-000000000006";
const M_BOB = "30000000-0000-4000-8000-000000000007";
const M_E2EE = "30000000-0000-4000-8000-000000000008";
const M_NO_LINK = "30000000-0000-4000-8000-000000000009";
const M_EDITED_RECENTLY = "30000000-0000-4000-8000-00000000000a";
const M_DAVE = "30000000-0000-4000-8000-00000000000b";
const M_OTHER_THREAD = "30000000-0000-4000-8000-00000000000c";
const M_EARLY = "30000000-0000-4000-8000-00000000000d";
const M_ALICE_EARLY = "30000000-0000-4000-8000-00000000000e";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const LINK_BODY = "look at https://public.example/a, it's great";

function msg(id: string, over: Record<string, unknown>) {
  return { id, thread_id: THREAD, sender_id: ALICE, body: LINK_BODY, msg_type: "text", subtype: null, created_at: ago(1), edited_at: null, deleted_at: null, ...over };
}

function stored(messageId: string, body: string, over: Record<string, unknown> = {}) {
  return {
    message_id: messageId, thread_id: THREAD, status: "ok", url: "https://public.example/a", host: "public.example",
    title: "Public page", description: "About it", site_name: "Public", source_digest: sourceDigest(body), fetched_at: ago(1), ...over,
  };
}

interface World {
  rows: Record<string, Record<string, any>[]>;
  reads: string[];
  storeCalls: Array<Record<string, unknown>>;
  failing: Set<string>;
  storeAnswer: ((args: any) => { data: unknown; error: unknown }) | null;
}

function world(flags: Record<string, boolean> = { telegraph_link_previews_enabled: true }): World {
  const w: World = {
    reads: [],
    storeCalls: [],
    failing: new Set(),
    storeAnswer: null,
    rows: {
      feature_flags: Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled })),
      message_threads: [
        { id: THREAD, is_e2ee: false },
        { id: E2EE_THREAD, is_e2ee: true },
        { id: OTHER_THREAD, is_e2ee: false },
      ],
      message_thread_members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
        { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null },
        { thread_id: THREAD, user_id: DAVE, left_at: null, visible_from_at: null },
        { thread_id: E2EE_THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
        { thread_id: OTHER_THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      ],
      messages: [
        msg(M_LINK, {}),
        msg(M_OLD, { created_at: ago(16) }),
        msg(M_CARD, { msg_type: "card", subtype: "discovery_card", body: JSON.stringify({ imageUrl: "https://public.example/i.png" }) }),
        msg(M_DELETED, { deleted_at: ago(0.5), body: "" }),
        msg(M_HTTP, { body: "plain http://public.example/a only" }),
        msg(M_OWN_FIRST, { body: "event https://portava.app/event/x then https://public.example/b." }),
        msg(M_BOB, { sender_id: BOB }),
        msg(M_E2EE, { thread_id: E2EE_THREAD, body: null }),
        msg(M_NO_LINK, { body: "no link here" }),
        msg(M_EDITED_RECENTLY, { created_at: ago(60), edited_at: ago(2) }),
        msg(M_DAVE, { sender_id: DAVE }),
        msg(M_OTHER_THREAD, { thread_id: OTHER_THREAD }),
        msg(M_EARLY, { sender_id: DAVE, created_at: ago(120) }),
        msg(M_ALICE_EARLY, { sender_id: ALICE, created_at: ago(120) }),
      ],
      message_link_previews: [],
      blocks: [],
    },
  };
  return w;
}

/** The 3825 writer's checks, applied to the same rows (the real function runs in the db suite). */
function storeModel(w: World) {
  return (args: any) => {
    w.storeCalls.push(args);
    if (w.storeAnswer) return w.storeAnswer(args);
    const m = w.rows.messages.find((x) => x.id === args.p_message_id);
    if (!m || m.deleted_at || m.thread_id !== args.p_thread_id) return { data: "message_gone", error: null };
    const t = w.rows.message_threads.find((x) => x.id === m.thread_id);
    if (t?.is_e2ee !== false) return { data: "e2ee", error: null };
    if (!m.body || sourceDigest(m.body) !== args.p_source_digest) return { data: "stale", error: null };
    if (w.rows.message_link_previews.some((r) => r.message_id === args.p_message_id)) return { data: "exists", error: null };
    w.rows.message_link_previews.push({
      message_id: args.p_message_id, thread_id: m.thread_id, status: args.p_status, url: args.p_url, host: args.p_host,
      title: args.p_title, description: args.p_description, site_name: args.p_site_name, source_digest: args.p_source_digest,
    });
    return { data: "stored", error: null };
  };
}

function install(w: World) {
  const client = makeFailClosedClient({
    rows: w.rows,
    users: TOKENS,
    failOn: (ctx) => {
      w.reads.push(ctx.table);
      return w.failing.has(ctx.table) ? ({ message: "connection terminated unexpectedly", code: "57P01" } as FakeDbError) : null;
    },
    rpc: { telegraph_store_link_preview: storeModel(w) },
  });
  _setTestClient(client, true);
  return client;
}

/** A preview service double: records each URL it is handed. */
function fetcher(answer: (url: string) => PreviewResult = (url) => ({ kind: "preview", preview: { url, host: new URL(url).hostname, title: "Public page", description: "About it", siteName: "Public" } })) {
  const urls: string[] = [];
  let gate: Promise<void> | null = null;
  const service = async (url: string) => { urls.push(url); if (gate) await gate; return answer(url); };
  return { service, urls, hold(p: Promise<void>) { gate = p; } };
}

interface Res { statusCode: number; body: any; headers: Record<string, string> }
async function call(handler: (req: any, res: any) => Promise<void>, opts: { token?: string | null; params: Record<string, string>; query?: Record<string, unknown>; body?: unknown }): Promise<Res> {
  const req: any = {
    headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? "t-alice"}` },
    params: opts.params, query: opts.query ?? {}, body: opts.body ?? {}, log: noopLog,
  };
  const res: any = {
    statusCode: 200, body: undefined, headers: {},
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
  };
  await handler(req, res);
  return res;
}

const AUTH_TABLES = new Set(["profiles", "user_account_states", "user_restrictions", "device_sessions", "account_states"]);
const dataReads = (w: World) => w.reads.filter((t) => !AUTH_TABLES.has(t));

function post(f: ReturnType<typeof fetcher>, gate = new OutboundFetchGate()) {
  return linkPreviewPostHandler({ preview: f.service, gate, now: () => NOW });
}
const postTo = (h: ReturnType<typeof post>, messageId: string, token = "t-alice", threadId = THREAD, body: unknown = {}) =>
  call(h, { token, params: { threadId, messageId }, body });
const get = (ids: string[], token = "t-bob", threadId = THREAD) =>
  call(linkPreviewGetHandler(), { token, params: { threadId }, query: { ids: ids.join(",") } });

beforeEach(() => { _resetRateLimit(); });
afterEach(() => { _clearTestClient(); mock.restoreAll(); });

// ── The POST ─────────────────────────────────────────────────────────────────

describe("T404 POST — the sender's send-time fetch", () => {
  it("P1 flag OFF or absent: no_preview, nothing read past the flag, nothing fetched, nothing stored", async () => {
    for (const flags of [{ telegraph_link_previews_enabled: false }, {}] as Array<Record<string, boolean>>) {
      const w = world(flags); install(w); const f = fetcher();
      const r = await postTo(post(f), M_LINK);
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.body, { kind: "no_preview", reason: "disabled" });
      assert.deepEqual(dataReads(w), ["feature_flags"]);
      assert.equal(f.urls.length, 0);
      assert.equal(w.storeCalls.length, 0);
    }
  });

  it("P2 unauthenticated: 401 before the flag is read", async () => {
    const w = world(); install(w); const f = fetcher();
    const r = await call(post(f), { token: null, params: { threadId: THREAD, messageId: M_LINK } });
    assert.equal(r.statusCode, 401);
    assert.deepEqual(dataReads(w), []);
    assert.equal(f.urls.length, 0);
  });

  it("P3 the happy path: the stored body's first external link is fetched ONCE and stored with the body's digest", async () => {
    const w = world(); install(w); const f = fetcher();
    const h = post(f);
    const r = await postTo(h, M_LINK);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { kind: "preview", preview: { messageId: M_LINK, url: "https://public.example/a", host: "public.example", title: "Public page", description: "About it", siteName: "Public" } });
    assert.deepEqual(f.urls, ["https://public.example/a"]);
    assert.equal(w.storeCalls.length, 1);
    assert.equal(w.storeCalls[0]!.p_source_digest, sourceDigest(LINK_BODY));
    assert.equal(w.storeCalls[0]!.p_thread_id, THREAD);
    // A repeat is served from storage: no second fetch, no second store.
    const again = await postTo(h, M_LINK);
    assert.deepEqual(again.body, r.body);
    assert.equal(f.urls.length, 1);
    assert.equal(w.storeCalls.length, 1);
  });

  it("P4 a URL in the request is ignored: the server fetches only what the stored body says", async () => {
    const w = world(); install(w); const f = fetcher();
    await postTo(post(f), M_LINK, "t-alice", THREAD, { url: "https://evil.example/tracker?r=bob", body: "https://evil.example" });
    assert.deepEqual(f.urls, ["https://public.example/a"]);
  });

  it("P5 only the SENDER: a member who did not send it is refused before the message's state is used, nothing fetched", async () => {
    const w = world(); install(w); const f = fetcher();
    const r = await postTo(post(f), M_LINK, "t-bob");
    assert.equal(r.statusCode, 403);
    assert.equal(f.urls.length, 0);
    const deleted = await postTo(post(f), M_DELETED, "t-bob");
    assert.equal(deleted.statusCode, 403, "a non-sender learns nothing about a message's lifecycle");
  });

  it("P6 a non-member is refused, nothing about the message read", async () => {
    const w = world(); install(w); const f = fetcher();
    const r = await postTo(post(f), M_LINK, "t-carol");
    assert.equal(r.statusCode, 403);
    assert.equal(dataReads(w).includes("messages"), false);
    assert.equal(f.urls.length, 0);
  });

  it("P7 an E2EE thread: refused before the message is read — no fetch, no store (Q-LP3)", async () => {
    const w = world(); install(w); const f = fetcher();
    const r = await postTo(post(f), M_E2EE, "t-alice", E2EE_THREAD);
    assert.equal(r.statusCode, 422);
    assert.equal(r.body.error, "e2ee_thread");
    assert.equal(dataReads(w).includes("messages"), false);
    assert.equal(f.urls.length, 0);
    assert.equal(w.storeCalls.length, 0);
  });

  it("P8 deleted / unsent: 410, nothing fetched", async () => {
    const w = world(); install(w); const f = fetcher();
    const r = await postTo(post(f), M_DELETED);
    assert.equal(r.statusCode, 410);
    assert.equal(f.urls.length, 0);
  });

  it("P9 the send-time window: 16 minutes after sending is refused; an edit 2 minutes ago reopens it", async () => {
    const w = world(); install(w); const f = fetcher();
    const h = post(f);
    assert.deepEqual((await postTo(h, M_OLD)).body, { kind: "no_preview", reason: "window_closed" });
    assert.equal(f.urls.length, 0);
    assert.equal((await postTo(h, M_EDITED_RECENTLY)).body.kind, "preview");
    assert.equal(f.urls.length, 1);
  });

  it("P10 a structured message (a card) is never previewed, whatever URL its body holds", async () => {
    const w = world(); install(w); const f = fetcher();
    assert.deepEqual((await postTo(post(f), M_CARD)).body, { kind: "no_preview", reason: "not_text" });
    assert.equal(f.urls.length, 0);
  });

  it("P11 https only (Q-LP7): a first link on http is no preview, nothing fetched, nothing stored", async () => {
    const w = world(); install(w); const f = fetcher();
    assert.deepEqual((await postTo(post(f), M_HTTP)).body, { kind: "no_preview", reason: "unsupported_link" });
    assert.equal(f.urls.length, 0);
    assert.equal(w.storeCalls.length, 0);
  });

  it("P12 Portava's own links are skipped; no link at all is no preview", async () => {
    const w = world(); install(w); const f = fetcher();
    const h = post(f);
    assert.equal((await postTo(h, M_OWN_FIRST)).body.kind, "preview");
    assert.deepEqual(f.urls, ["https://public.example/b"]);
    assert.deepEqual((await postTo(h, M_NO_LINK)).body, { kind: "no_preview", reason: "no_link" });
    assert.equal(f.urls.length, 1);
  });

  it("P13 a concurrent second POST for the same message waits for the first: ONE fetch", async () => {
    const w = world(); install(w); const f = fetcher();
    let open!: () => void;
    f.hold(new Promise<void>((r) => { open = r; }));
    const h = post(f);
    const first = postTo(h, M_LINK);
    const second = postTo(h, M_LINK);
    await new Promise((r) => setImmediate(r));
    open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.body.kind, "preview");
    assert.deepEqual(b.body, a.body);
    assert.equal(f.urls.length, 1);
    assert.equal(w.storeCalls.length, 1);
  });

  it("P14 the in-flight gate is full: 429 with Retry-After, nothing fetched", async () => {
    const w = world(); install(w); const f = fetcher();
    const gate = new OutboundFetchGate({ global: 1, perUser: 1, perHost: 1 });
    const held = gate.tryAcquire("someone-else", "other.example");
    assert.ok(held.ok);
    const r = await postTo(post(f, gate), M_LINK);
    assert.equal(r.statusCode, 429);
    assert.equal(r.headers["retry-after"], "5");
    assert.equal(f.urls.length, 0);
  });

  it("P15 the per-person request budget: the 21st POST in a minute is 429 and fetches nothing", async () => {
    const w = world(); install(w); const f = fetcher();
    const h = post(f);
    for (let i = 0; i < 20; i++) assert.notEqual((await postTo(h, M_NO_LINK)).statusCode, 429);
    const r = await postTo(h, M_LINK);
    assert.equal(r.statusCode, 429);
    assert.equal(f.urls.length, 0);
  });

  it("P16 every unreadable input is 503 with no fetch: membership, thread, message, stored preview", async () => {
    for (const table of ["message_thread_members", "message_threads", "messages", "message_link_previews"]) {
      const w = world(); install(w); const f = fetcher();
      w.failing.add(table);
      const r = await postTo(post(f), M_LINK);
      assert.equal(r.statusCode, 503, table);
      assert.equal(r.body.error, "degraded_unavailable", table);
      assert.equal(f.urls.length, 0, table);
    }
  });

  it("P17 a store that fails or answers an unknown outcome is 503, never a preview the database does not hold", async () => {
    for (const answer of [{ data: null, error: { message: "boom" } }, { data: "maybe", error: null }]) {
      const w = world(); install(w); const f = fetcher();
      w.storeAnswer = () => answer;
      const r = await postTo(post(f), M_LINK);
      assert.equal(r.statusCode, 503);
      assert.equal(w.rows.message_link_previews.length, 0);
    }
  });

  it("P18 the message changed while fetching: the store refuses (stale / gone) and nothing is served", async () => {
    for (const [outcome, reason] of [["stale", "stale"], ["message_gone", "message_gone"], ["e2ee", "message_gone"]] as const) {
      const w = world(); install(w); const f = fetcher();
      w.storeAnswer = () => ({ data: outcome, error: null });
      assert.deepEqual((await postTo(post(f), M_LINK)).body, { kind: "no_preview", reason }, outcome);
    }
  });

  it("P19 a fetch that yields nothing is stored as 'none' and not fetched again", async () => {
    const w = world(); install(w); const f = fetcher(() => ({ kind: "no_preview" }));
    const h = post(f);
    assert.deepEqual((await postTo(h, M_LINK)).body, { kind: "no_preview", reason: "none" });
    assert.equal(w.storeCalls[0]!.p_status, "none");
    assert.equal(w.storeCalls[0]!.p_url, null);
    assert.deepEqual((await postTo(h, M_LINK)).body, { kind: "no_preview", reason: "none" });
    assert.equal(f.urls.length, 1);
  });

  it("P20 a stored row that no longer matches the body is never served by the POST either", async () => {
    const w = world(); install(w); const f = fetcher();
    w.rows.message_link_previews.push(stored(M_LINK, "an older body https://public.example/a"));
    assert.deepEqual((await postTo(post(f), M_LINK)).body, { kind: "no_preview", reason: "stale" });
    assert.equal(f.urls.length, 0);
  });

  it("P21 a malformed id is 400 before anything is read", async () => {
    const w = world(); install(w); const f = fetcher();
    const r = await postTo(post(f), "not-a-uuid");
    assert.equal(r.statusCode, 400);
    assert.deepEqual(dataReads(w), []);
  });
});

// ── The GET ──────────────────────────────────────────────────────────────────

describe("T446 GET — recipients read storage only", () => {
  it("R1 the read path makes ZERO outbound requests; the same router's POST reaching the same spy is the control", async () => {
    const w = world(); install(w);
    w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY));
    const spy = fetcher();
    const sockets: string[] = [];
    mock.method(https, "request", () => { sockets.push("https"); throw new Error("no outbound on the read path"); });
    mock.method(http, "request", () => { sockets.push("http"); throw new Error("no outbound on the read path"); });
    mock.method(globalThis, "fetch", async () => { sockets.push("fetch"); throw new Error("no outbound on the read path"); });
    const router = createLinkPreviewRouter({ preview: spy.service, now: () => NOW });
    const handle = (method: string, path: string) =>
      (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;
    const run = (h: any, req: any) => new Promise<Res>((resolve, reject) => {
      const res: any = { statusCode: 200, headers: {}, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; resolve(this); return this; }, setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; } };
      h({ headers: { authorization: `Bearer ${req.token}` }, params: req.params, query: req.query ?? {}, body: {}, log: noopLog }, res, reject);
    });
    const r = await run(handle("get", "/threads/:threadId/link-previews"), { token: "t-bob", params: { threadId: THREAD }, query: { ids: `${M_LINK},${M_OLD}` } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.previews.length, 1);
    assert.equal(spy.urls.length, 0, "the GET never reached the fetcher");
    assert.deepEqual(sockets, [], "the GET opened no connection of any kind");
    // Positive control: the POST on the same router DOES reach the same spy.
    const p = await run(handle("post", "/threads/:threadId/messages/:messageId/link-preview"), { token: "t-alice", params: { threadId: THREAD, messageId: M_EDITED_RECENTLY } });
    assert.equal(p.body.kind, "preview");
    assert.equal(spy.urls.length, 1);
  });

  it("R2 a member reads the stored preview, text fields only — no image field exists", async () => {
    const w = world(); install(w);
    w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY));
    const r = await get([M_LINK]);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { previews: [{ messageId: M_LINK, url: "https://public.example/a", host: "public.example", title: "Public page", description: "About it", siteName: "Public" }] });
    assert.equal(r.headers["cache-control"], "private, no-store");
  });

  it("R3 flag OFF: an empty list and no preview row read", async () => {
    const w = world({ telegraph_link_previews_enabled: false }); install(w);
    w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY));
    assert.deepEqual((await get([M_LINK])).body, { previews: [] });
    assert.deepEqual(dataReads(w), ["feature_flags"]);
  });

  it("R4 an unsent or deleted message serves nothing, even if a row survived — body blanked or not", async () => {
    const w = world(); install(w);
    w.rows.message_link_previews.push(stored(M_DELETED, ""));
    w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY));
    // A delete that set deleted_at and kept the body (so the digest still matches): still nothing.
    w.rows.messages.find((m) => m.id === M_DAVE)!.deleted_at = ago(0.5);
    w.rows.message_link_previews.push(stored(M_DAVE, LINK_BODY));
    const r = await get([M_DELETED, M_LINK, M_DAVE], "t-alice");
    assert.deepEqual(r.body.previews.map((p: any) => p.messageId), [M_LINK]);
  });

  it("R5 an edited body serves nothing until it is regenerated (source_digest)", async () => {
    const w = world(); install(w);
    w.rows.message_link_previews.push(stored(M_LINK, "the body before the edit https://public.example/a"));
    assert.deepEqual((await get([M_LINK])).body, { previews: [] });
  });

  it("R6 a block either way withholds the sender's previews; an unreadable block state is 503", async () => {
    const w = world(); install(w);
    w.rows.message_link_previews.push(stored(M_DAVE, LINK_BODY), stored(M_LINK, LINK_BODY));
    w.rows.blocks.push({ blocker_id: DAVE, blocked_id: BOB });
    assert.deepEqual((await get([M_DAVE, M_LINK])).body.previews.map((p: any) => p.messageId), [M_LINK]);
    w.rows.blocks.length = 0;
    w.rows.blocks.push({ blocker_id: BOB, blocked_id: DAVE });
    assert.deepEqual((await get([M_DAVE, M_LINK])).body.previews.map((p: any) => p.messageId), [M_LINK]);
    w.failing.add("blocks");
    const r = await get([M_DAVE, M_LINK]);
    assert.equal(r.statusCode, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("R7 the §14.3 history window: a message before the reader's window is withheld; their OWN earlier message is not (Q6)", async () => {
    const w = world({ telegraph_link_previews_enabled: true, telegraph_history_bound_enabled: true }); install(w);
    for (const m of w.rows.message_thread_members) if (m.user_id === BOB || m.user_id === ALICE) m.visible_from_at = ago(30);
    w.rows.messages.push(msg("30000000-0000-4000-8000-00000000000f", { sender_id: BOB, created_at: ago(120) }));
    w.rows.message_link_previews.push(stored(M_EARLY, LINK_BODY), stored(M_LINK, LINK_BODY), stored("30000000-0000-4000-8000-00000000000f", LINK_BODY));
    const r = await get([M_EARLY, M_LINK, "30000000-0000-4000-8000-00000000000f"]);
    assert.deepEqual(r.body.previews.map((p: any) => p.messageId).sort(), [M_LINK, "30000000-0000-4000-8000-00000000000f"].sort());
  });

  it("R8 an E2EE thread serves nothing; a thread that BECAME E2EE serves nothing", async () => {
    const w = world(); install(w);
    w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY));
    w.rows.message_threads.find((t) => t.id === THREAD)!.is_e2ee = true;
    assert.deepEqual((await get([M_LINK])).body, { previews: [] });
    assert.equal(dataReads(w).includes("message_link_previews"), false);
  });

  it("R9 a non-member is refused; a member of ANOTHER thread cannot read this thread's previews by id", async () => {
    const w = world(); install(w);
    w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY), stored(M_OTHER_THREAD, LINK_BODY, { thread_id: OTHER_THREAD }));
    assert.equal((await get([M_LINK], "t-carol")).statusCode, 403);
    // BOB names OTHER_THREAD's message under THREAD: the read is thread-scoped.
    assert.deepEqual((await get([M_OTHER_THREAD])).body, { previews: [] });
  });

  it("R10 only 'ok' rows are served; a 'none' row is nothing — even one carrying a link (3825's CHECK forbids it; the reader does not rely on that)", async () => {
    const w = world(); install(w);
    w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY, { status: "none", url: null, host: null, title: null, description: null, site_name: null }));
    assert.deepEqual((await get([M_LINK])).body, { previews: [] });
    w.rows.message_link_previews.length = 0;
    w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY, { status: "none" }));
    assert.deepEqual((await get([M_LINK])).body, { previews: [] });
  });

  it("R11 every unreadable input is 503: membership, thread, messages, previews", async () => {
    for (const table of ["message_thread_members", "message_threads", "messages", "message_link_previews"]) {
      const w = world(); install(w);
      w.rows.message_link_previews.push(stored(M_LINK, LINK_BODY));
      w.failing.add(table);
      const r = await get([M_LINK]);
      assert.equal(r.statusCode, 503, table);
    }
  });

  it("R12 ids: at most 50 distinct uuids; anything else is 400", async () => {
    const w = world(); install(w);
    assert.equal((await get(["nope"])).statusCode, 400);
    assert.equal((await call(linkPreviewGetHandler(), { token: "t-bob", params: { threadId: THREAD }, query: {} })).statusCode, 400);
    const many = Array.from({ length: LINK_PREVIEW_BATCH_MAX + 1 }, (_, i) => `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    assert.equal((await get(many)).statusCode, 400);
    assert.equal(parseIds(`${M_LINK},${M_LINK}`)!.length, 1);
    assert.equal(parseIds(many.slice(0, LINK_PREVIEW_BATCH_MAX).join(","))!.length, LINK_PREVIEW_BATCH_MAX);
  });

  it("R13 a card's row is never served (only plain text messages have previews)", async () => {
    const w = world(); install(w);
    const card = w.rows.messages.find((m) => m.id === M_CARD)!;
    w.rows.message_link_previews.push(stored(M_CARD, card.body));
    assert.deepEqual((await get([M_CARD])).body, { previews: [] });
  });
});

describe("link extraction", () => {
  it("X1 first external link, trailing punctuation dropped, a link's own parentheses kept", () => {
    assert.equal(firstExternalUrl("see https://public.example/a."), "https://public.example/a");
    assert.equal(firstExternalUrl("(https://public.example/a)"), "https://public.example/a");
    assert.equal(firstExternalUrl("https://en.wikipedia.org/wiki/Foo_(bar)"), "https://en.wikipedia.org/wiki/Foo_(bar)");
    assert.equal(firstExternalUrl("xhttps://public.example/a"), null);
    assert.equal(firstExternalUrl("https://www.portava.app/event/1 https://public.example/z"), "https://public.example/z");
    assert.equal(firstExternalUrl("no link"), null);
  });

  it("X2 Portava's own hosts include every host pasteEventLinks treats as Portava's", () => {
    const own = portavaOwnHosts({}, null);
    for (const h of PORTAVA_LINK_HOSTS) assert.ok(own.has(h), h);
    assert.ok(portavaOwnHosts({}, "https://abc.supabase.co").has("abc.supabase.co"));
    assert.ok(portavaOwnHosts({ PORTAVA_WEB_ORIGIN: "https://staging.portava.example" }, null).has("staging.portava.example"));
    assert.equal(firstExternalUrl("https://abc.supabase.co/storage/v1/x https://public.example/q", portavaOwnHosts({}, "https://abc.supabase.co")), "https://public.example/q");
  });
});
