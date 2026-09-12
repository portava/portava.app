/**
 * Telegraph §21 Search & Retrieval — against the real service and the real
 * routes.
 *
 * Spec (identical in v1 and v1.1):
 *   §21 "Telegraph search is object-aware and authorization-scoped."
 *       MESSAGES / PLACES / MEDIA / PLANS / MEMORIES
 *       "Index message text, permitted voice/video transcripts, object titles
 *        and safe metadata."
 *       "Private semantic indexes require access filtering BEFORE retrieval,
 *        not post-filtering after unrestricted search."
 *       "Unsent/deleted/revoked objects must be removed from normal user search
 *        and Compass retrieval."
 *       "'Ask this conversation' should prefer structured plans/decisions/
 *        actions over inferred prose."
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - Dropping `.in("thread_id", …)`: the unscoped-query assertion fails
 *     immediately — the fake records every filter, so a search that reaches
 *     `messages` without a thread scope is caught by construction, not by a
 *     result that happens to look right.
 *   - Treating an unreadable membership table as "no restrictions": the
 *     degraded test fails AND the no-query-at-all test fails.
 *   - Post-filtering the §14.3 window in JavaScript instead of putting `.gte`
 *     in the query: the observed-filters assertion fails.
 *   - Widening the safe-field allowlist to the whole card body: the coordinate
 *     test fails — a search for the latitude digits would start matching.
 *   - Dropping `.is("deleted_at", null)`: the tombstone test fails.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphSearch.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import searchRouter from "../server/telegraph/searchRoute.js";
import { searchConversations, askConversation, authorizedConversationScope } from "../services/telegraphSearch.js";
import {
  TELEGRAPH_SEARCH_BUCKETS,
  classifyMessage,
  indexableText,
} from "../domain/telegraph/contracts/conversationSearch.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";

const T_OPEN = "00000000-0000-4000-8000-00000000000a";    // Alice member, unbounded
const T_BOUND = "00000000-0000-4000-8000-00000000000b";   // Alice member, §14.3 bound
const T_FOREIGN = "00000000-0000-4000-8000-00000000000c"; // Alice NOT a member
const T_LEFT = "00000000-0000-4000-8000-00000000000d";    // Alice has left

const BOUND = "2026-03-01T00:00:00.000Z";

/** A place card whose coordinates must never be indexed or echoed. */
const PLACE_CARD = JSON.stringify({
  title: "Sky36 Rooftop",
  city: "Hanoi",
  lat: 21.0287654,
  lng: 105.8542,
  placeId: "fsq-sky36-secret-id",
});

/** A card whose only occurrence of the needle is in a NON-allowlisted field. */
const HIDDEN_FIELD_CARD = JSON.stringify({
  title: "Somewhere else",
  internalNote: "sky36 is the real target",
});

interface State {
  membershipError?: boolean;
  messagesError?: boolean;
  flag?: boolean;
}

interface Observed {
  queries: Array<{ table: string; filters: Array<[string, string, any]> }>;
}

function fixture() {
  return {
    feature_flags: [{ flag: "telegraph_history_bound_enabled", enabled: true }],
    message_thread_members: [
      { thread_id: T_OPEN, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: T_BOUND, user_id: ALICE, left_at: null, visible_from_at: BOUND },
      { thread_id: T_LEFT, user_id: ALICE, left_at: "2026-04-01T00:00:00.000Z", visible_from_at: null },
      { thread_id: T_FOREIGN, user_id: BOB, left_at: null, visible_from_at: null },
    ],
    messages: [
      m("m1", T_OPEN, "Dinner at sky36 tonight?", { created_at: "2026-05-01T00:00:00.000Z" }),
      m("m2", T_OPEN, PLACE_CARD, { subtype: "discovery_card", created_at: "2026-05-02T00:00:00.000Z" }),
      m("m3", T_OPEN, JSON.stringify({ title: "Sky36 meetup", when: "Friday" }),
        { subtype: "meetup", created_at: "2026-05-03T00:00:00.000Z" }),
      m("m4", T_OPEN, "sky36 photo", { msg_type: "media", media_url: "https://cdn/x.jpg", created_at: "2026-05-04T00:00:00.000Z" }),
      m("m5", T_OPEN, JSON.stringify({ title: "sky36 night", caption: "our sky36 evening" }),
        { subtype: "post_card", created_at: "2026-05-05T00:00:00.000Z" }),
      m("m6", T_OPEN, "a deleted mention of sky36",
        { deleted_at: "2026-05-06T01:00:00.000Z", created_at: "2026-05-06T00:00:00.000Z" }),
      m("m7", T_OPEN, HIDDEN_FIELD_CARD, { subtype: "discovery_card", created_at: "2026-05-07T00:00:00.000Z" }),
      // The bounded thread: one match before the window, one after.
      m("m8", T_BOUND, "sky36 before Alice joined", { created_at: "2026-02-01T00:00:00.000Z" }),
      m("m9", T_BOUND, "sky36 after Alice joined", { created_at: "2026-04-01T00:00:00.000Z" }),
      // A thread Alice is not in, and one she left.
      m("m10", T_FOREIGN, "sky36 in someone else's thread", { created_at: "2026-05-08T00:00:00.000Z" }),
      m("m11", T_LEFT, "sky36 in a thread Alice left", { created_at: "2026-05-09T00:00:00.000Z" }),
    ],
  } as Record<string, any[]>;
}

function m(id: string, thread_id: string, body: string, over: Record<string, any> = {}) {
  return {
    id, thread_id, sender_id: BOB, body,
    created_at: "2026-05-01T00:00:00.000Z", deleted_at: null,
    msg_type: "text", subtype: null, media_url: null,
    ...over,
  };
}

function makeClient(state: State = {}) {
  const db = fixture();
  if (state.flag === false) db["feature_flags"] = [{ flag: "telegraph_history_bound_enabled", enabled: false }];
  const observed: Observed = { queries: [] };

  function from(table: string) {
    const filters: Array<[string, string, any]> = [];
    const preds: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    const entry = { table, filters };
    observed.queries.push(entry);

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const injected = () => {
      if (table === "message_thread_members" && state.membershipError) return { message: "membership read blew up" };
      if (table === "messages" && state.messagesError) return { message: "messages read blew up" };
      return null;
    };

    const target: any = {
      select(sel?: string) { filters.push(["select", "", sel ?? ""]); return proxy; },
      eq(col: string, val: any) { filters.push(["eq", col, val]); preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { filters.push(["neq", col, val]); preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { filters.push(["is", col, val]); preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in(col: string, vals: any[]) { filters.push(["in", col, vals]); preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      gte(col: string, val: any) { filters.push(["gte", col, val]); preds.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      ilike(col: string, pattern: string) {
        filters.push(["ilike", col, pattern]);
        const needle = pattern.replace(/%/g, "").toLowerCase();
        preds.push((r) => String(r[col] ?? "").toLowerCase().includes(needle));
        return proxy;
      },
      order() { return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
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
    _observed: observed,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

const messageQueries = (sc: any) => sc._observed.queries.filter((q: any) => q.table === "messages");
const ids = (r: any) => r.hits.map((h: any) => h.messageId).sort();

/* ───────────────────── authorization before retrieval ────────────────── */

describe("Telegraph §21 — access filtering happens BEFORE retrieval", () => {
  it("every messages query is scoped to the caller's own thread ids", async () => {
    const sc = makeClient();
    await searchConversations(sc, ALICE, "sky36");
    const qs = messageQueries(sc);
    assert.ok(qs.length > 0, "the search must actually query messages");
    for (const q of qs) {
      const scope = q.filters.find((f: any) => f[0] === "in" && f[1] === "thread_id");
      assert.ok(scope, "a messages query with no thread scope is an unrestricted search");
      for (const id of scope[2]) {
        assert.ok(id === T_OPEN || id === T_BOUND, `queried an unauthorized thread: ${id}`);
      }
    }
  });

  it("never returns a message from a thread the caller is not in, or has left", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36");
    const returned = new Set(r.hits.map((h) => h.conversationId));
    assert.ok(!returned.has(T_FOREIGN), "a foreign thread's message was returned");
    assert.ok(!returned.has(T_LEFT), "a departed thread's message was returned");
  });

  it("an unreadable membership table searches NOTHING and says it is degraded", async () => {
    const sc = makeClient({ membershipError: true });
    const r = await searchConversations(sc, ALICE, "sky36");
    assert.equal(r.degraded, true);
    assert.deepEqual(r.hits, []);
    assert.equal(messageQueries(sc).length, 0,
      "a failed scope must never fall through to an unscoped messages query");
  });

  it("the scope resolver reports the bound split rather than collapsing it", async () => {
    const sc = makeClient();
    const scope = await authorizedConversationScope(sc, ALICE);
    assert.deepEqual(scope.unbounded, [T_OPEN]);
    assert.equal(scope.bounded.length, 1);
    assert.equal(scope.bounded[0]!.threadId, T_BOUND);
    assert.equal(scope.degraded, false);
  });
});

/* ──────────────────────── the §14.3 window is a filter ────────────────── */

describe("Telegraph §21 × §14.3 — the history window is in the query", () => {
  it("a bounded thread gets its own query carrying .gte(created_at, bound)", async () => {
    const sc = makeClient();
    await searchConversations(sc, ALICE, "sky36");
    const bounded = messageQueries(sc).find((q: any) =>
      q.filters.some((f: any) => f[0] === "in" && f[1] === "thread_id" && f[2].includes(T_BOUND)));
    assert.ok(bounded, "the bounded thread was never queried");
    const gte = bounded.filters.find((f: any) => f[0] === "gte" && f[1] === "created_at");
    assert.ok(gte, "the window was not applied in the query — that is post-filtering");
    assert.equal(gte[2], BOUND);
  });

  it("a pre-window match is not returned; a post-window match is", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36");
    const found = new Set(r.hits.map((h) => h.messageId));
    assert.ok(!found.has("m8"), "a message from before the member joined was returned");
    assert.ok(found.has("m9"));
    assert.equal(r.conversationsBounded, 1);
  });

  it("with the bound flag OFF the membership query does not name visible_from_at", async () => {
    const sc = makeClient({ flag: false });
    await searchConversations(sc, ALICE, "sky36");
    const memberQ = sc._observed.queries.filter((q: any) => q.table === "message_thread_members");
    for (const q of memberQ) {
      const sel = q.filters.find((f: any) => f[0] === "select");
      assert.ok(sel && !String(sel[2]).includes("visible_from_at"),
        "a database without migration 2400 must not be asked for that column");
    }
  });
});

/* ─────────────────────────── object-awareness ─────────────────────────── */

describe("Telegraph §21 — object-aware buckets", () => {
  it("returns all five buckets as keys, even at zero", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36");
    assert.deepEqual(Object.keys(r.counts).sort(), [...TELEGRAPH_SEARCH_BUCKETS].sort());
  });

  it("classifies a place card, a meetup, media, a post card and prose into their buckets", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36");
    const byId = new Map(r.hits.map((h) => [h.messageId, h.bucket]));
    assert.equal(byId.get("m2"), "PLACES");
    assert.equal(byId.get("m3"), "PLANS");
    assert.equal(byId.get("m4"), "MEDIA");
    assert.equal(byId.get("m5"), "MEMORIES");
    assert.equal(byId.get("m1"), "MESSAGES");
  });

  it("the bucket filter narrows the result without changing the scope", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36", { buckets: ["PLACES"] });
    assert.ok(r.hits.length > 0);
    assert.ok(r.hits.every((h) => h.bucket === "PLACES"));
  });

  it("classifyMessage sends an unknown subtype to MESSAGES, not to nowhere", () => {
    assert.equal(classifyMessage({ subtype: "a_card_kind_invented_tomorrow" }), "MESSAGES");
  });
});

/* ────────────────────── safe metadata is an allowlist ─────────────────── */

describe("Telegraph §21 — object titles and SAFE metadata only", () => {
  it("indexes the card title and never the coordinates", () => {
    const { text, objectTitle } = indexableText(PLACE_CARD, "discovery_card");
    assert.equal(objectTitle, "Sky36 Rooftop");
    assert.ok(text.includes("Sky36 Rooftop"));
    assert.ok(!text.includes("21.0287"), "a latitude reached the index");
    assert.ok(!text.includes("105.85"), "a longitude reached the index");
    assert.ok(!text.includes("fsq-sky36-secret-id"), "a provider id reached the index");
  });

  it("a match that exists ONLY in a non-allowlisted field is not a hit", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36");
    assert.ok(!r.hits.some((h) => h.messageId === "m7"),
      "matching on an unindexed field lets a searcher confirm a value they may not read");
  });

  it("an unparseable card body indexes to nothing rather than to raw JSON", () => {
    const { text } = indexableText("{not json at all", "discovery_card");
    assert.equal(text, "");
  });

  it("the returned snippet for a card is the safe text, not the body", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36");
    const place = r.hits.find((h) => h.messageId === "m2");
    assert.ok(place);
    assert.ok(!place!.snippet.includes("lat"));
    assert.equal(place!.objectTitle, "Sky36 Rooftop");
  });
});

/* ───────────────────────── lifecycle exclusions ───────────────────────── */

describe("Telegraph §21 — deleted objects are removed in the query", () => {
  it("every messages query carries .is(deleted_at, null)", async () => {
    const sc = makeClient();
    await searchConversations(sc, ALICE, "sky36");
    for (const q of messageQueries(sc)) {
      assert.ok(q.filters.some((f: any) => f[0] === "is" && f[1] === "deleted_at" && f[2] === null),
        "a tombstone that reaches the process has already consumed a limit slot");
    }
  });

  it("a deleted message never appears in the result", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36");
    assert.ok(!ids(r).includes("m6"));
  });
});

/* ─────────────────────── ask this conversation ────────────────────────── */

describe("Telegraph §21 — 'Ask this conversation' prefers structured objects", () => {
  it("returns structured plans and places separately from prose", async () => {
    const sc = makeClient();
    const { structured, prose } = await askConversation(sc, ALICE, T_OPEN, "sky36");
    assert.ok(structured.length >= 2, "the meetup and the place card are structured");
    assert.ok(structured.every((h) => h.subtype !== null));
    assert.ok(prose.some((h) => h.messageId === "m1"), "the prose message belongs in prose");
    assert.ok(!prose.some((h) => h.subtype === "meetup"));
  });

  it("ranks structured hits ahead of prose in the combined list", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36", { conversationId: T_OPEN, preferStructured: true });
    const firstProse = r.hits.findIndex((h) => h.subtype === null);
    const lastStructured = r.hits.map((h) => h.subtype !== null).lastIndexOf(true);
    assert.ok(firstProse === -1 || lastStructured < firstProse,
      "prose outranked a structured object");
  });

  it("scoping to one conversation does not widen the authorized set", async () => {
    const sc = makeClient();
    const r = await searchConversations(sc, ALICE, "sky36", { conversationId: T_FOREIGN });
    assert.deepEqual(r.hits, []);
    assert.equal(r.conversationsSearched, 0);
  });
});

/* ──────────────────────────────── routes ─────────────────────────────── */

describe("GET /telegraph/search · /threads/:id/search · /threads/:id/ask", () => {
  let server: any;
  let base = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", searchRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    _setTestClient(null, false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  const asAlice = { headers: { authorization: `Bearer ${ALICE}` } };

  it("global search returns the five counts", async () => {
    _setTestClient(makeClient(), true);
    const res = await fetch(`${base}/telegraph/search?q=sky36`, asAlice);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.deepEqual(Object.keys(body.counts).sort(), [...TELEGRAPH_SEARCH_BUCKETS].sort());
    assert.ok(body.counts.PLACES >= 1);
    assert.ok(body.counts.PLANS >= 1);
  });

  it("a thread the caller is not in returns an empty 200, not a 403 oracle", async () => {
    _setTestClient(makeClient(), true);
    const res = await fetch(`${base}/threads/${T_FOREIGN}/search?q=sky36`, asAlice);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.deepEqual(body.hits, []);
  });

  it("refuses a one-character query rather than scanning for it", async () => {
    _setTestClient(makeClient(), true);
    const res = await fetch(`${base}/telegraph/search?q=s`, asAlice);
    assert.equal(res.status, 400);
  });

  it("requires a verified user", async () => {
    _setTestClient(makeClient(), true);
    const res = await fetch(`${base}/telegraph/search?q=sky36`);
    assert.equal(res.status, 401);
  });

  it("ask returns structured and prose as separate fields", async () => {
    _setTestClient(makeClient(), true);
    const res = await fetch(`${base}/threads/${T_OPEN}/ask?q=sky36`, asAlice);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.structured));
    assert.ok(Array.isArray(body.prose));
    assert.ok(body.structured.length > 0);
  });

  it("a failed messages read is reported as degraded, not as 'nothing matched'", async () => {
    _setTestClient(makeClient({ messagesError: true }), true);
    const res = await fetch(`${base}/telegraph/search?q=sky36`, asAlice);
    const body = (await res.json()) as any;
    assert.equal(body.degraded, true);
    assert.deepEqual(body.hits, []);
  });
});
