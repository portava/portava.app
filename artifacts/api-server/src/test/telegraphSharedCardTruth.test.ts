/**
 * census-telegraph T448 / T359 / T445 (lane w-tg-cardtruth, 2026-10-14) — the
 * shared-card truth module and the read coalescer it resolves through.
 *
 * What this file proves, against the REAL §5 loaders (services/telegraph/
 * shareables.ts) over an in-memory PostgREST fake:
 *
 *   1. Recognition. Every legacy card kind is recognised by (msg_type, subtype),
 *      and nothing else is: a PORTAVA_OBJECT row whose subtype is `hidden_gem`
 *      or `meetup`, an ACTION whose subtype is a verb, plain text — none is a
 *      legacy card. A `text` row whose JSON says `type:"meetup_card"` IS one,
 *      because the thread screen's own parser draws it as one.
 *   2. The served body. For EVERY kind, a snapshot field never survives: the
 *      stored body is seeded with sentinel strings in every field, and the
 *      served body is searched for them under all three truths.
 *   3. Re-resolution, per family, with the family's own rule: a renamed place
 *      is served by its CURRENT name; a duplicate place, a protected gem, a
 *      deleted post, a blocker's post, a non-party's booking and a non-invitee's
 *      meetup are unavailable; a `for_you` pick, a Compass `place:` pick and a
 *      meeting-point card are withheld; an unreadable source table is
 *      unavailable/`unknown` — never the snapshot.
 *   4. Batching. Fifty cards over forty places, ten posts and their authors
 *      cost ONE `places` read, ONE `posts` read, ONE `profiles` read and TWO
 *      `blocks` reads — not one per card.
 *   5. The coalescer's own semantics: shapes it batches and shapes it replays,
 *      an error reaching every waiter, `.maybeSingle()` over two rows answering
 *      an error, and added key columns stripped from what callers receive.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphSharedCardTruth.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SHARED_CARD_KINDS,
  SHARED_CARD_REGISTRY,
  applySharedCardTruth,
  compassCardRef,
  isSharedCardRow,
  legacySourceTypeToObjectType,
  normalizeSourceId,
  resolveSharedCards,
  servedCardBody,
  sharedCardIndexText,
  sharedCardKindOf,
  withheldCardBody,
  type SharedCardKind,
  type SharedCardTruth,
} from "../services/telegraph/sharedCardTruth.js";
import { coalescableShape, coalescingClient, type CoalescingStats } from "../services/telegraph/coalescedReads.js";

const VIEWER = "aaaaaaaa-0000-4000-8000-000000000001";
const SENDER = "bbbbbbbb-0000-4000-8000-000000000002";
const BLOCKER = "cccccccc-0000-4000-8000-000000000003";
const THREAD = "00000000-0000-4000-8000-0000000000a1";

const PLACE_LIVE = "11111111-0000-4000-8000-000000000001";
const PLACE_DUP = "11111111-0000-4000-8000-000000000002";
const GEM_OK = "22222222-0000-4000-8000-000000000001";
const GEM_PROTECTED = "22222222-0000-4000-8000-000000000002";
const POST_OK = "33333333-0000-4000-8000-000000000001";
const POST_DELETED = "33333333-0000-4000-8000-000000000002";
const POST_BLOCKER = "33333333-0000-4000-8000-000000000003";
const BOOKING_MINE = "44444444-0000-4000-8000-000000000001";
const BOOKING_OTHER = "44444444-0000-4000-8000-000000000002";
const MEETUP_INVITED = "55555555-0000-4000-8000-000000000001";
const MEETUP_NOT_INVITED = "55555555-0000-4000-8000-000000000002";

/** Every snapshot field of every card is seeded with this, so a leak is a substring search. */
const SNAP = "SNAPSHOT";

// ── the fake ─────────────────────────────────────────────────────────────────

interface FakeOpts {
  failTables?: string[];
}

function baseDb(): Record<string, any[]> {
  const places: any[] = [
    { id: PLACE_LIVE, name: "Sky36 Rooftop (now)", city: "Hanoi", neighborhood: "Hoan Kiem", primary_category: "bar", status: "active", updated_at: "2026-10-01T00:00:00Z" },
    { id: PLACE_DUP, name: "Gone Cafe", city: "Hanoi", neighborhood: null, primary_category: "cafe", status: "duplicate", updated_at: "2026-10-01T00:00:00Z" },
  ];
  for (let i = 0; i < 40; i++) {
    places.push({ id: `9${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`, name: `Place ${i}`, city: "Hue", neighborhood: null, primary_category: "x", status: "active", updated_at: null });
  }
  const posts: any[] = [
    { id: POST_OK, author_id: SENDER, content: "The post as it reads today", visibility: "public", status: "active", post_status: "published", deleted_at: null, media_urls: [], location_privacy_mode: "exact", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
    { id: POST_DELETED, author_id: SENDER, content: "deleted", visibility: "public", status: "active", post_status: "published", deleted_at: "2026-09-03T00:00:00Z", media_urls: [], location_privacy_mode: "exact", created_at: "2026-09-01T00:00:00Z", updated_at: null },
    { id: POST_BLOCKER, author_id: BLOCKER, content: "a blocker's post", visibility: "public", status: "active", post_status: "published", deleted_at: null, media_urls: [], location_privacy_mode: "exact", created_at: "2026-09-01T00:00:00Z", updated_at: null },
  ];
  for (let i = 0; i < 10; i++) {
    const author = `dddddddd-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`;
    posts.push({ id: `8${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`, author_id: author, content: `post ${i}`, visibility: "public", status: "active", post_status: "published", deleted_at: null, media_urls: [], location_privacy_mode: "exact", created_at: "2026-09-01T00:00:00Z", updated_at: null });
  }
  return {
    places,
    hidden_gems: [
      { id: GEM_OK, name: "Quiet Alley Tea (now)", city: "Hue", neighborhood: "Citadel", category: "tea", status: "active", sensitivity_level: "public", merged_into: null, updated_at: null },
      { id: GEM_PROTECTED, name: "Secret Spring", city: "Hue", neighborhood: "Hills", category: "nature", status: "active", sensitivity_level: "protected", merged_into: null, updated_at: null },
    ],
    posts,
    profiles: [
      { id: SENDER, handle: "sender", account_status: "active" },
      { id: BLOCKER, handle: "blocker", account_status: "active" },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `dddddddd-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, handle: `author${i}`, account_status: "active" })),
    ],
    blocks: [{ blocker_id: BLOCKER, blocked_id: VIEWER }],
    rent_buddy_bookings: [
      { id: BOOKING_MINE, buddy_id: SENDER, traveler_id: VIEWER, city: "Hanoi", category: "Food tour", booking_date: "2026-11-01", status: "cancelled", updated_at: null },
      { id: BOOKING_OTHER, buddy_id: SENDER, traveler_id: BLOCKER, city: "Hanoi", category: "Food tour", booking_date: "2026-11-02", status: "confirmed", updated_at: null },
    ],
    meetups: [
      { id: MEETUP_INVITED, creator_id: SENDER, title: "Pho at 7 (moved)", location_name: "Pho 10", starts_at: "2026-11-01T19:00:00Z", status: "confirmed", visibility: "private", updated_at: null },
      { id: MEETUP_NOT_INVITED, creator_id: SENDER, title: "Private dinner", location_name: "Home", starts_at: null, status: "pending", visibility: "private", updated_at: null },
    ],
    meetup_invites: [{ meetup_id: MEETUP_INVITED, user_id: VIEWER, status: "going" }],
    feature_flags: [],
  };
}

function makeClient(opts: FakeOpts = {}) {
  const db = baseDb();
  const reads: Record<string, number> = {};
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let lim: number | null = null;
    let single = false;
    const run = () => {
      reads[table] = (reads[table] ?? 0) + 1;
      if (opts.failTables?.includes(table)) return { data: null, error: { message: `${table} unreadable` } };
      let rows = (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (lim !== null) rows = rows.slice(0, lim);
      if (single) {
        if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: unknown) { preds.push((r) => String(r[c]) === String(v)); return b; },
      neq(c: string, v: unknown) { preds.push((r) => String(r[c]) !== String(v)); return b; },
      in(c: string, vs: unknown[]) { const set = new Set(vs.map(String)); preds.push((r) => set.has(String(r[c]))); return b; },
      is(c: string, v: unknown) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      order() { return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { single = true; return b; },
      then(res: (v: any) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }
  return { db, reads, client: { from, rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }) } as any };
}

let seq = 0;
function row(msg_type: string, subtype: string | null, body: unknown, extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `m-${seq}`,
    thread_id: THREAD,
    sender_id: SENDER,
    msg_type,
    subtype,
    body: typeof body === "string" ? body : JSON.stringify(body),
    deleted_at: null,
    ...extra,
  };
}

/** A stored body for each kind, with the snapshot fields all carrying SNAP. */
function snapshotBody(kind: SharedCardKind, ref: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case "discovery_card":
      return { sourceId: PLACE_LIVE, sourceType: "place", title: `${SNAP} title`, category: `${SNAP} cat`, city: `${SNAP} city`, blurb: `${SNAP} blurb`, imageUrl: `https://x/${SNAP}.jpg`, priceLevel: `${SNAP}$`, caption: "you'd love this", ...ref };
    case "post_card":
      return { postId: POST_OK, permalink: `https://p/${SNAP}`, authorName: `${SNAP} name`, authorHandle: `${SNAP}handle`, authorAvatar: `https://a/${SNAP}`, snippet: `${SNAP} snippet`, thumbnail: `https://t/${SNAP}`, city: `${SNAP} city`, country: `${SNAP} country`, likeCount: 99, commentCount: 98, caption: "look", ...ref };
    case "compass_card":
      return { type: "compass_card", id: `gem:${GEM_OK}`, cardType: "hidden_gem", title: `${SNAP} title`, city: `${SNAP} city`, category: `${SNAP} cat`, description: `${SNAP} desc`, imageUrl: `https://c/${SNAP}`, ...ref };
    case "hidden_gem_card":
      return { type: "hidden_gem", gemId: GEM_OK, name: `${SNAP} name`, category: `${SNAP}`, city: `${SNAP} city`, country: `${SNAP}`, neighborhood: `${SNAP} hood`, sensitivityLabel: `${SNAP}`, verificationLevel: `${SNAP}`, priceRange: `${SNAP}`, vibeTags: [SNAP], text: `📍 Shared a hidden gem: ${SNAP}`, ...ref };
    case "event_context_card":
      return { type: "event_context_card", eventId: "e-1", title: `${SNAP} title`, startsAt: `${SNAP}`, city: `${SNAP} city`, visibility: `${SNAP}`, text: `${SNAP} text`, ...ref };
    case "booking_card":
      return { booking_id: BOOKING_MINE, status: "confirmed", booking_date: `${SNAP}`, start_time: `${SNAP}`, duration_h: 3, city: `${SNAP} city`, category: `${SNAP} cat`, total_usd: 4242, cancellation_policy: "Free cancellation up to 24h before start. After that, a 50% fee may apply.", safety_reminder: "Always meet in public places. Share your itinerary with someone you trust.", ...ref };
    case "meetup_card":
      return { meetupId: MEETUP_INVITED, title: `${SNAP} title`, locationName: `${SNAP} place`, timeBlock: `${SNAP}`, approximateDate: `${SNAP}`, plannedByName: `${SNAP} name`, ...ref };
    case "circle_status_card":
      return { subtype: "meeting_point", venueLabel: `${SNAP} venue`, approxArea: `${SNAP} area`, ...ref };
  }
}

const ROW_SHAPE: Record<SharedCardKind, [string, string | null]> = {
  discovery_card: ["system", "discovery_card"],
  post_card: ["system", "post_card"],
  compass_card: ["system", "compass_card"],
  hidden_gem_card: ["card", "hidden_gem"],
  event_context_card: ["system", "event_context_card"],
  booking_card: ["booking_card", "booking_status_confirmed"],
  meetup_card: ["system", "meetup"],
  circle_status_card: ["circle_status_card", "meeting_point"],
};

// ── 1. recognition ───────────────────────────────────────────────────────────

describe("T448 — which rows are legacy shared cards", () => {
  it("recognises every registered kind by its (msg_type, subtype)", () => {
    for (const kind of SHARED_CARD_KINDS) {
      const [mt, st] = ROW_SHAPE[kind];
      assert.equal(sharedCardKindOf({ msg_type: mt, subtype: st, body: "{}" }), kind, kind);
    }
  });

  it("does NOT read a §6.2 PORTAVA_OBJECT, an ACTION or plain text as a legacy card", () => {
    assert.equal(sharedCardKindOf({ msg_type: "portava_object", subtype: "hidden_gem", body: "{}" }), null);
    assert.equal(sharedCardKindOf({ msg_type: "portava_object", subtype: "meetup", body: "{}" }), null);
    assert.equal(sharedCardKindOf({ msg_type: "action", subtype: "meetup", body: "{}" }), null);
    assert.equal(sharedCardKindOf({ msg_type: "text", subtype: null, body: "hello" }), null);
    assert.equal(sharedCardKindOf({ msg_type: "card", subtype: "live_reference", body: "{}" }), null);
  });

  it("reads a text row whose JSON is a meetup_card as one — the thread screen draws it as one", () => {
    assert.equal(sharedCardKindOf({ msg_type: "text", subtype: null, body: JSON.stringify({ type: "meetup_card", meetupId: "x", title: "t" }) }), "meetup_card");
  });

  it("maps the legacy discovery sourceType vocabulary exactly as the client does, and Compass ids by their prefix", () => {
    assert.equal(legacySourceTypeToObjectType("gem"), "HIDDEN_GEM");
    assert.equal(legacySourceTypeToObjectType("venue"), "PLACE");
    assert.equal(legacySourceTypeToObjectType("for_you"), null);
    assert.equal(legacySourceTypeToObjectType("traveler_pick"), null);
    assert.deepEqual(compassCardRef({ id: "gem:abc", cardType: "hidden_gem" }), { objectType: "HIDDEN_GEM", objectId: "abc" });
    assert.deepEqual(compassCardRef({ id: "e1", cardType: "event" }), { objectType: "EVENT", objectId: "e1" });
    // a discovery_places id is not a `places` id: resolving it as PLACE would claim a live place was removed
    assert.equal(compassCardRef({ id: "place:abc", cardType: "place" }), null);
    assert.equal(compassCardRef({ id: "x", cardType: "activity" }), null);
  });
});

// ── 2. the served body ───────────────────────────────────────────────────────

describe("T445 — a served body never carries a field of the sender's snapshot", () => {
  const projection = { objectType: "PLACE" as const, objectId: "p", title: "LIVE title", subtitle: "LIVE sub", imageUrl: null, projectionVersion: null, deepLink: "/place/p" };
  for (const kind of SHARED_CARD_KINDS) {
    it(`${kind}: live, unavailable and withheld forms contain no snapshot value`, () => {
      const body = snapshotBody(kind, {});
      const truths: SharedCardTruth[] = [
        { kind, state: "live", objectType: "PLACE", objectId: "p", status: "active", projection, actions: [], deepLink: "/place/p" },
        { kind, state: "unavailable", objectType: "PLACE", objectId: "p", reason: "private", deepLink: "/place/p" },
        { kind, state: "withheld", reason: "no_source" },
      ];
      for (const t of truths) {
        const served = servedCardBody(kind, body, t);
        assert.ok(!served.includes(SNAP), `${kind}/${t.state} leaked a snapshot field: ${served}`);
        const parsed = JSON.parse(served);
        if (t.state === "live" && kind !== "circle_status_card") assert.ok(served.includes("LIVE title"), `${kind} live form lacks the projection: ${served}`);
        if (t.state !== "live") assert.equal(parsed.withheld, true, `${kind}/${t.state}`);
      }
      // the inbox / edit-history form, which resolves nothing
      const [mt, st] = ROW_SHAPE[kind];
      const w = withheldCardBody({ msg_type: mt, subtype: st, body: JSON.stringify(body) });
      assert.ok(w !== null && !w.includes(SNAP), `${kind} withheld-without-resolve leaked: ${w}`);
    });
  }

  it("keeps the sender's own caption and the reference — the two things that are not the source's", () => {
    const served = JSON.parse(servedCardBody("discovery_card", snapshotBody("discovery_card", {}), { kind: "discovery_card", state: "withheld", reason: "no_source" }));
    assert.deepEqual(served, { sourceId: PLACE_LIVE, sourceType: "place", caption: "you'd love this", withheld: true });
  });

  it("a withheld Compass card has no `type`, so an installed client draws its own fallback rather than printing the discriminator", () => {
    const served = JSON.parse(servedCardBody("compass_card", snapshotBody("compass_card", {}), { kind: "compass_card", state: "withheld", reason: "no_source" }));
    assert.equal(served.type, undefined);
    assert.equal(served.title, undefined);
  });

  it("a withheld Discovery card has no `title`, so an installed client falls to its fallback rather than drawing an empty card", () => {
    const served = JSON.parse(servedCardBody("discovery_card", snapshotBody("discovery_card", {}), { kind: "discovery_card", state: "unavailable", objectType: "PLACE", objectId: "p", reason: "private", deepLink: "/" }));
    assert.equal(served.title, undefined);
    assert.equal(served.category, undefined);
  });

  it("isSharedCardRow agrees with sharedCardKindOf", () => {
    assert.equal(isSharedCardRow({ msg_type: "system", subtype: "post_card", body: "{}" }), true);
    assert.equal(isSharedCardRow({ msg_type: "text", subtype: null, body: "hi" }), false);
  });
});

// ── 3. re-resolution, family by family ───────────────────────────────────────

async function truthFor(r: ReturnType<typeof row>, opts: FakeOpts = {}): Promise<SharedCardTruth | undefined> {
  const { client } = makeClient(opts);
  return (await resolveSharedCards(client, VIEWER, [{ row: r }])).get(r.id);
}

describe("T448 / T359 — every card is the source as it is NOW, for THIS viewer", () => {
  it("a renamed place is served by its current name, not the sender's", async () => {
    const r = row("system", "discovery_card", snapshotBody("discovery_card", {}));
    const t = await truthFor(r);
    assert.equal(t?.state, "live");
    assert.equal(t?.state === "live" && t.projection.title, "Sky36 Rooftop (now)");
    const { client } = makeClient();
    const out = await applySharedCardTruth(client, VIEWER, [r]);
    const served = JSON.parse(out.rows[0].body);
    assert.equal(served.title, "Sky36 Rooftop (now)");
    assert.equal(served.category, "place");
    assert.equal(served.caption, "you'd love this");
    assert.ok(!out.rows[0].body.includes(SNAP));
  });

  it("a place merged away is unavailable (deleted)", async () => {
    const t = await truthFor(row("system", "discovery_card", snapshotBody("discovery_card", { sourceId: PLACE_DUP })));
    assert.deepEqual(t && t.state === "unavailable" ? t.reason : t, "deleted");
  });

  it("a protected gem shared through a Discovery card is unavailable (unauthorized)", async () => {
    const t = await truthFor(row("system", "discovery_card", snapshotBody("discovery_card", { sourceId: GEM_PROTECTED, sourceType: "hidden_gem" })));
    assert.deepEqual(t && t.state === "unavailable" ? t.reason : t, "unauthorized");
  });

  it("a `for_you` pick names no source this server can resolve: withheld", async () => {
    const t = await truthFor(row("system", "discovery_card", snapshotBody("discovery_card", { sourceId: "place:xyz", sourceType: "for_you" })));
    assert.deepEqual(t, { kind: "discovery_card", state: "withheld", reason: "no_source" });
  });

  it("a deleted post is unavailable; a live one is its current text", async () => {
    const dead = await truthFor(row("system", "post_card", snapshotBody("post_card", { postId: POST_DELETED })));
    assert.equal(dead?.state === "unavailable" && dead.reason, "deleted");
    const live = await truthFor(row("system", "post_card", snapshotBody("post_card", {})));
    assert.equal(live?.state === "live" && live.projection.title, "The post as it reads today");
  });

  it("a post by someone who BLOCKED the viewer is unavailable — the share door is not a way round a block", async () => {
    const t = await truthFor(row("system", "post_card", snapshotBody("post_card", { postId: POST_BLOCKER })));
    assert.equal(t?.state === "unavailable" && t.reason, "unauthorized");
  });

  it("a Compass hidden-gem card resolves; a Compass place card is withheld", async () => {
    const gem = await truthFor(row("system", "compass_card", snapshotBody("compass_card", {})));
    assert.equal(gem?.state === "live" && gem.projection.title, "Quiet Alley Tea (now)");
    const place = await truthFor(row("system", "compass_card", snapshotBody("compass_card", { id: "place:abc", cardType: "place" })));
    assert.equal(place?.state, "withheld");
  });

  it("the server's own hidden-gem card resolves through the gem's disclosure rule", async () => {
    const ok = await truthFor(row("card", "hidden_gem", snapshotBody("hidden_gem_card", {})));
    assert.equal(ok?.state, "live");
    const prot = await truthFor(row("card", "hidden_gem", snapshotBody("hidden_gem_card", { gemId: GEM_PROTECTED })));
    assert.equal(prot?.state === "unavailable" && prot.reason, "unauthorized");
  });

  it("a booking card is live for a party, with the booking's CURRENT status beside the transition it records", async () => {
    const r = row("booking_card", "booking_status_confirmed", snapshotBody("booking_card", {}));
    const { client } = makeClient();
    const out = await applySharedCardTruth(client, VIEWER, [r]);
    const served = JSON.parse(out.rows[0].body);
    assert.equal(served.status, "confirmed", "the transition this card records stays");
    assert.equal(served.currentStatus, "cancelled", "and the canonical state outranks it (T448)");
    assert.ok(!out.rows[0].body.includes(SNAP));
    const other = await truthFor(row("booking_card", "booking_status_confirmed", snapshotBody("booking_card", { booking_id: BOOKING_OTHER })));
    assert.equal(other?.state === "unavailable" && other.reason, "unauthorized");
  });

  it("a meetup card is live for an invitee (its current title) and unavailable to anyone else", async () => {
    const inv = await truthFor(row("system", "meetup", snapshotBody("meetup_card", {})));
    assert.equal(inv?.state === "live" && inv.projection.title, "Pho at 7 (moved)");
    const not = await truthFor(row("system", "meetup", snapshotBody("meetup_card", { meetupId: MEETUP_NOT_INVITED })));
    assert.equal(not?.state === "unavailable" && not.reason, "unauthorized");
  });

  it("a Circle meeting-point card carries no reference: withheld, and its venue labels are not served", async () => {
    const r = row("circle_status_card", "meeting_point", snapshotBody("circle_status_card", {}));
    const { client } = makeClient();
    const out = await applySharedCardTruth(client, VIEWER, [r]);
    assert.equal(out.truth.get(r.id)?.state, "withheld");
    assert.deepEqual(JSON.parse(out.rows[0].body), { subtype: "meeting_point", withheld: true });
  });

  it("an UNREADABLE source table is unavailable/unknown — never the snapshot, never an empty card", async () => {
    const r = row("system", "discovery_card", snapshotBody("discovery_card", {}));
    const t = await truthFor(r, { failTables: ["places"] });
    assert.equal(t?.state === "unavailable" && t.reason, "unknown");
    const { client } = makeClient({ failTables: ["places"] });
    const out = await applySharedCardTruth(client, VIEWER, [r]);
    assert.ok(!out.rows[0].body.includes(SNAP));
    assert.equal(JSON.parse(out.rows[0].body).withheld, true);
  });

  it("an unreadable `blocks` refuses the post (unknown), as the loader's own rule says", async () => {
    const t = await truthFor(row("system", "post_card", snapshotBody("post_card", {})), { failTables: ["blocks"] });
    assert.equal(t?.state === "unavailable" && t.reason, "unknown");
  });

  it("rows that are not cards come back as the same objects, and a deleted card is left alone", async () => {
    const plain = row("text", null, "hello");
    const gone = row("system", "discovery_card", snapshotBody("discovery_card", {}), { deleted_at: "2026-10-01T00:00:00Z" });
    const { client } = makeClient();
    const out = await applySharedCardTruth(client, VIEWER, [plain, gone]);
    assert.equal(out.rows[0], plain);
    assert.equal(out.truth.has(gone.id), false);
  });

  it("the index text of a live card is its projection and the sender's caption, and a card that is not live has none", async () => {
    const r = row("system", "discovery_card", snapshotBody("discovery_card", {}));
    const { client } = makeClient();
    const out = await applySharedCardTruth(client, VIEWER, [r]);
    const text = sharedCardIndexText(out.truth.get(r.id), out.rows[0]);
    assert.equal(text, "Sky36 Rooftop (now) · Hoan Kiem, Hanoi · you'd love this");
    assert.equal(sharedCardIndexText({ kind: "discovery_card", state: "withheld", reason: "no_source" }, r), null);
  });
});

// ── 4. batching ──────────────────────────────────────────────────────────────

describe("T448 — the re-resolution is ONE batch, not one read per card", () => {
  it("fifty cards over forty places and ten posts cost one read per table", async () => {
    const { client, reads, db } = makeClient();
    const rows: any[] = [];
    const placeIds = db.places.slice(2).map((p) => p.id); // the forty
    for (const id of placeIds) rows.push(row("system", "discovery_card", { sourceId: id, sourceType: "place", title: SNAP, category: SNAP }));
    for (const id of placeIds.slice(0, 10)) rows.push(row("system", "discovery_card", { sourceId: id, sourceType: "place", title: SNAP, category: SNAP })); // repeats
    const postIds = db.posts.slice(3).map((p) => p.id); // the ten by ten authors
    for (const id of postIds) rows.push(row("system", "post_card", { postId: id }));
    const stats: CoalescingStats = { issued: 0, coalesced: 0 };
    const out = await applySharedCardTruth(client, VIEWER, rows, { stats });
    assert.equal(out.truth.size, rows.length);
    for (const r of out.rows) assert.ok(!String(r.body).includes(SNAP));
    assert.equal(reads.places, 1, `places read ${reads.places}×`);
    assert.equal(reads.posts, 1, `posts read ${reads.posts}×`);
    assert.equal(reads.profiles, 1, `profiles read ${reads.profiles}×`);
    assert.ok(reads.blocks <= 2, `blocks read ${reads.blocks}×`);
    assert.ok(stats.coalesced >= 40 + 10 + 10 + 20, `coalesced ${stats.coalesced}`);
    // every repeated card got the same answer as its first
    const byId = new Map(out.rows.map((r) => [r.id, r]));
    assert.equal(byId.get(rows[40].id)!.body, byId.get(rows[0].id)!.body);
  });
});

// ── 5. the coalescer ─────────────────────────────────────────────────────────

describe("coalescingClient — batches what it understands, replays the rest", () => {
  it("recognises the two shapes and nothing else", () => {
    assert.deepEqual(coalescableShape([["select", ["id, name"]], ["eq", ["id", "x"]], ["maybeSingle", []]]), { kind: "id", cols: "id, name", id: "x" });
    assert.equal(coalescableShape([["select", ["id, name"]], ["eq", ["id", "x"]], ["limit", [1]]]), null, "an id lookup must end .maybeSingle()");
    assert.equal(coalescableShape([["select", ["a"]], ["eq", ["b", 1]], ["eq", ["c", 2]], ["limit", [1]]])?.kind, "pair");
    assert.equal(coalescableShape([["select", ["a"]], ["eq", ["b", 1]], ["eq", ["c", 2]], ["maybeSingle", []]])?.kind, "pair");
    assert.equal(coalescableShape([["select", ["*"]], ["eq", ["id", "x"]], ["maybeSingle", []]]), null, "* is replayed");
    assert.equal(coalescableShape([["select", ["id, p:profiles(name)"]], ["eq", ["id", "x"]], ["maybeSingle", []]]), null, "embedded resources are replayed");
    assert.equal(coalescableShape([["select", ["a"]], ["eq", ["name", "x"]], ["maybeSingle", []]]), null, "single eq on a non-key column is replayed");
    assert.equal(coalescableShape([["select", ["a"]], ["eq", ["b", 1]], ["is", ["c", null]], ["maybeSingle", []]]), null);
    assert.equal(coalescableShape([["select", ["a"]], ["eq", ["b", 1]], ["eq", ["c", 2]], ["limit", [5]]]), null);
  });

  it("an error from the batch reaches EVERY waiter, so each loader takes its own fail-closed branch", async () => {
    const { client } = makeClient({ failTables: ["places"] });
    const c = coalescingClient(client);
    const [a, b] = await Promise.all([
      c.from("places").select("id, name").eq("id", PLACE_LIVE).maybeSingle(),
      c.from("places").select("id, name").eq("id", PLACE_DUP).maybeSingle(),
    ]);
    assert.ok(a.error && b.error);
    assert.equal(a.data, null);
  });

  it("strips a key column the batch added, and answers a missing row with null data and no error", async () => {
    const { client } = makeClient();
    const c = coalescingClient(client);
    const [hit, miss] = await Promise.all([
      c.from("profiles").select("handle, account_status").eq("id", SENDER).maybeSingle(),
      c.from("profiles").select("handle, account_status").eq("id", "nobody").maybeSingle(),
    ]);
    assert.deepEqual(hit.data, { handle: "sender", account_status: "active" });
    assert.deepEqual([miss.data, miss.error], [null, null]);
  });

  it("answers .maybeSingle() over two matching rows with an error, as PostgREST does", async () => {
    const { client, db } = makeClient();
    db.meetup_invites.push({ meetup_id: MEETUP_INVITED, user_id: VIEWER, status: "maybe" });
    const c = coalescingClient(client);
    const r = await c.from("meetup_invites").select("user_id, status").eq("meetup_id", MEETUP_INVITED).eq("user_id", VIEWER).maybeSingle();
    assert.ok(r.error);
  });

  it("answers a pair lookup ending .limit(1) per pair, and replays a chain it does not understand verbatim", async () => {
    const { client, reads } = makeClient();
    const c = coalescingClient(client);
    const [yes, no, other] = await Promise.all([
      c.from("blocks").select("blocker_id").eq("blocker_id", BLOCKER).eq("blocked_id", VIEWER).limit(1),
      c.from("blocks").select("blocker_id").eq("blocker_id", SENDER).eq("blocked_id", VIEWER).limit(1),
      c.from("places").select("id").in("id", [PLACE_LIVE]),
    ]);
    assert.deepEqual(yes.data, [{ blocker_id: BLOCKER }]);
    assert.deepEqual(no.data, []);
    assert.equal(other.data.length, 1);
    assert.equal(other.data[0].id, PLACE_LIVE);
    assert.equal(reads.blocks, 1, "both pair lookups in one query");
    assert.equal(reads.places, 1, "the .in() chain replayed once, as written");
  });

  it("passes every other property of the client straight through", async () => {
    const { client } = makeClient();
    const c: any = coalescingClient(client);
    const r = await c.rpc("anything");
    assert.equal(r.error.message, "rpc not modelled");
  });

  it("the registry has one entry per declared kind", () => {
    assert.deepEqual(Object.keys(SHARED_CARD_REGISTRY).sort(), [...SHARED_CARD_KINDS].sort());
  });
});

// ── fix round 1 (verifier F1) ─────────────────────────────────────────────

describe("fix round 1 (F1) — a source id is resolved only in its canonical uuid form", () => {
  it("normalizeSourceId strips the Discovery feed's db/ prefix and refuses a non-uuid", () => {
    assert.equal(normalizeSourceId(`db/${PLACE_LIVE}`), PLACE_LIVE);
    assert.equal(normalizeSourceId(PLACE_LIVE), PLACE_LIVE);
    assert.equal(normalizeSourceId("db/not-a-uuid"), null);
    assert.equal(normalizeSourceId("abc"), null);
    assert.equal(normalizeSourceId(null), null);
  });

  it("a For-You card's db/<uuid> is live; a non-uuid id is withheld and never reaches the table", async () => {
    const live = row("system", "discovery_card", snapshotBody("discovery_card", { sourceId: `db/${PLACE_LIVE}` }));
    const bad = row("system", "discovery_card", snapshotBody("discovery_card", { sourceId: "db/nope" }));
    const { client, reads } = makeClient();
    const out = await resolveSharedCards(client, VIEWER, [{ row: live }, { row: bad }]);
    assert.equal(out.get(live.id)?.state === "live" && out.get(live.id)?.state, "live");
    assert.deepEqual(out.get(bad.id), { kind: "discovery_card", state: "withheld", reason: "no_source" });
    assert.equal(reads.places, 1, "one read, and only for the uuid");
  });
});
