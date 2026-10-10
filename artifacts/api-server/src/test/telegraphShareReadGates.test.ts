/**
 * The Telegraph share card for a Memory or a Highlight takes the same read
 * gate as the object's own routes — lane R wave-1 verification, finding F1
 * (2026-10-06).
 *
 * `POST /api/threads/:threadId/share-projections` resolves any (type, id) pair
 * an active thread member names, through the service client. Before this
 * change:
 *   - `loadHighlight` never read `blocks` at all, though the §10/§11 verdict it
 *     calls states that its caller "has ALREADY applied blocks": a viewer the
 *     owner blocked, or who blocked the owner, resolved the owner's caption and
 *     media URL into a chat card by id;
 *   - `loadMemory` read blocks in ONE direction (owner -> viewer) and honoured
 *     `allowed_user_ids` under ANY visibility, so an `only_me` Memory with a
 *     stale allow-list entry served its title and city while `canReadMemory`
 *     refused it.
 *
 * The delta verification of that fix (N1, 2026-10-06) found the same door
 * open on four more families and the sweep it asked for found more, each held
 * here to the object's OWN read route:
 *   - STAMP, EVENT, MEDIA read no `blocks`; PROFILE read one direction and put
 *     the REAL name in the title whatever `show_real_name` said;
 *   - TRIP read no `blocks` and showed a non-member the destination city, the
 *     dates and the cover past `show_destination_city` / `show_exact_dates` /
 *     `show_header_publicly` and the §6.3 absence guard;
 *   - EVENT skipped `canViewEvent` and `checkEventEligibility` (ban, age);
 *   - POST skipped `post_status` (a draft resolved);
 *   - ROUTE took a `route_plan_members` row without the trip membership
 *     `GET /route-plans/:id` requires;
 *   - RESERVATION grants crew (a block outranks it); LAYOVER_PLAN, per D-LAYOVER-SHARE-CREW, a share.
 *
 * Every case drives `resolveShareProjections`, the function the route calls,
 * and asserts the card the viewer would get — available with its title, or
 * unavailable with §5.3's reason and NO projection. The intended cases (an
 * unblocked public object of each family; a `custom` Memory the viewer is
 * allow-listed on; an opted-in name; a trip member's full trip) stay
 * available.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPortavaObjectBody, resolveShareProjections } from "../services/telegraph/shareables.js";
import type { TelegraphObjectType } from "../services/telegraph/vocabulary.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // the owner
const THREAD = "dddddddd-0000-4000-8000-00000000000d";

const HL = "aa110000-0000-4000-8000-0000000000a1";
const M_PUBLIC = "cc110000-0000-4000-8000-0000000000c1";
const M_ONLY_ME_STALE = "cc110000-0000-4000-8000-0000000000c2";
const M_CUSTOM = "cc110000-0000-4000-8000-0000000000c3";
const M_HIDDEN = "cc110000-0000-4000-8000-0000000000c4";
const STAMP = "5a110000-0000-4000-8000-0000000000a1";
const EV_PUBLIC = "e1110000-0000-4000-8000-0000000000e1";
const EV_ADULTS = "e1110000-0000-4000-8000-0000000000e2";
const EV_FRIENDS = "e1110000-0000-4000-8000-0000000000e3";
const MEDIA = "3e110000-0000-4000-8000-0000000000d1";
const TRIP_PUBLIC = "7a110000-0000-4000-8000-0000000000f1";
const POST_PUBLISHED = "90110000-0000-4000-8000-0000000000b1";
const POST_DRAFT = "90110000-0000-4000-8000-0000000000b2";
const ROUTE_NO_TRIP = "40110000-0000-4000-8000-000000000041";
const ROUTE_ON_TRIP = "40110000-0000-4000-8000-000000000042";
const RES = "2e110000-0000-4000-8000-000000000021";
const LAY = "1a110000-0000-4000-8000-000000000011";
const FUTURE_START = "2099-01-10";

type Row = Record<string, unknown>;
interface Result { data: unknown; error: unknown }

interface Builder extends PromiseLike<Result> {
  select(cols?: string): Builder;
  eq(c: string, v: unknown): Builder;
  neq(c: string, v: unknown): Builder;
  in(c: string, vs: readonly unknown[]): Builder;
  is(c: string, v: unknown): Builder;
  not(c: string, op: string, v: unknown): Builder;
  or(expr: string): Builder;
  like(c: string, pattern: string): Builder;
  gte(c: string, v: string): Builder;
  order(c?: string, o?: unknown): Builder;
  limit(n: number): Builder;
  maybeSingle(): Promise<Result>;
  single(): Promise<Result>;
}

const soon = () => new Date(Date.now() + 6 * 3600_000).toISOString();

function tables(): Record<string, Row[]> {
  return {
    highlights: [{
      id: HL, owner_id: BOB, caption: "Sunset from the roof", location_name: "Rooftop", location_city: "Hue",
      visibility: "public", expires_at: soon(), deleted_at: null, archived_at: null,
      media_url: "https://x/h1.jpg", media_type: "image", updated_at: "2026-05-01T00:00:00.000Z",
    }],
    memories: [
      { id: M_PUBLIC, owner_id: BOB, title: "The old harbour", caption: null, visibility: "public", allowed_user_ids: [], hidden_user_ids: [], state: "published", trip_id: null, location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: M_ONLY_ME_STALE, owner_id: BOB, title: "Just for me", caption: null, visibility: "only_me", allowed_user_ids: [ALICE], hidden_user_ids: [], state: "published", trip_id: null, location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: M_CUSTOM, owner_id: BOB, title: "For a chosen few", caption: null, visibility: "custom", allowed_user_ids: [ALICE], hidden_user_ids: [], state: "published", trip_id: null, location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: M_HIDDEN, owner_id: BOB, title: "Not for Alice", caption: null, visibility: "public", allowed_user_ids: [], hidden_user_ids: [ALICE], state: "published", trip_id: null, location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    blocks: [],
    highlight_resurfacing_preferences: [],
    highlight_projection_policies: [],
    user_stamps: [{ id: STAMP, user_id: BOB, stamp_definition_id: null, title_override: "First river crossing", city: "Hue", country: "VN", visibility: "public", display_on_passport: true, is_revoked: false, earned_at: "2026-05-01T00:00:00.000Z" }],
    stamp_definitions: [],
    events: [
      { id: EV_PUBLIC, host_id: BOB, title: "Lantern walk", city: "Hoi An", starts_at: "2026-11-01T12:00:00.000Z", state: "open", visibility: "public", cover_url: "https://x/e1.jpg", circle_id: null, trip_id: null, age_min: null, age_max: null, trust_score_min: null, verified_only: false, updated_at: "2026-05-01T00:00:00.000Z" },
      { id: EV_ADULTS, host_id: BOB, title: "Night bar crawl", city: "Hoi An", starts_at: "2026-11-02T20:00:00.000Z", state: "open", visibility: "public", cover_url: null, circle_id: null, trip_id: null, age_min: 18, age_max: null, trust_score_min: null, verified_only: false, updated_at: "2026-05-01T00:00:00.000Z" },
      { id: EV_FRIENDS, host_id: BOB, title: "Friends dinner", city: "Hoi An", starts_at: "2026-11-03T19:00:00.000Z", state: "open", visibility: "friends_only", cover_url: null, circle_id: null, trip_id: null, age_min: null, age_max: null, trust_score_min: null, verified_only: false, updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    // ALICE holds an attendee row on the friends-only event and nothing
    // `canViewEvent` counts (no friendship, no RSVP, no role).
    event_attendees: [{ event_id: EV_FRIENDS, user_id: ALICE }],
    event_roles: [],
    event_rsvps: [],
    user_friendships: [],
    feature_flags: [],
    message_thread_members: [],
    media_assets: [{ id: MEDIA, owner_user_id: BOB, caption: "The alley at dusk", alt_text: null, media_type: "image", thumbnail_url: "https://x/m1t.jpg", public_url: "https://x/m1.jpg", visibility: "public", moderation_status: "approved", processing_status: "ready", updated_at: "2026-05-01T00:00:00.000Z" }],
    profiles: [
      { id: BOB, handle: "bob", name: "Robert Realname", avatar_url: "https://x/bob.jpg", account_status: "active", is_private: false, passport_visibility: "public", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: ALICE, handle: "alice", name: "Alice Realname", avatar_url: "https://x/alice.jpg", account_status: "active", is_private: false, passport_visibility: "public", date_of_birth: "1990-01-01", updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    profile_privacy_settings: [],
    trips: [{ id: TRIP_PUBLIC, owner_id: BOB, title: "Hue in winter", destination_city: "Hue", start_date: FUTURE_START, end_date: "2099-01-20", status: "planning", visibility: "public", cover_url: "https://x/t1.jpg", show_destination_city: true, show_exact_dates: true, show_header_publicly: true, updated_at: "2026-05-01T00:00:00.000Z" }],
    trip_members: [],
    posts: [
      { id: POST_PUBLISHED, author_id: BOB, content: "A bar with no sign", visibility: "public", status: "active", post_status: "published", deleted_at: null, media_urls: [], updated_at: "2026-05-01T00:00:00.000Z" },
      { id: POST_DRAFT, author_id: BOB, content: "Not finished yet", visibility: "public", status: "active", post_status: "draft", deleted_at: null, media_urls: [], updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    route_plans: [
      { id: ROUTE_NO_TRIP, owner_user_id: BOB, trip_id: null, title: "Solo loop", route_style: "walking", status: "active", is_approximated: false, updated_at: "2026-05-01T00:00:00.000Z" },
      { id: ROUTE_ON_TRIP, owner_user_id: BOB, trip_id: TRIP_PUBLIC, title: "Citadel loop", route_style: "walking", status: "active", is_approximated: false, updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    route_plan_members: [{ route_plan_id: ROUTE_NO_TRIP, user_id: ALICE }, { route_plan_id: ROUTE_ON_TRIP, user_id: ALICE }],
    trip_reservations: [{ id: RES, trip_id: TRIP_PUBLIC, user_id: BOB, type: "stay", title: "Riverside guesthouse", starts_at: null, ends_at: null, location_name: "Hue", status: "confirmed", updated_at: "2026-05-01T00:00:00.000Z" }],
    messages: [],
    layover_sessions: [{ id: LAY, user_id: BOB, trip_id: TRIP_PUBLIC, manual_airport_name: "Changi", manual_city: "Singapore", manual_iata: "SIN", arrival_time: "2026-11-01T02:00:00.000Z", departure_time: "2026-11-01T11:00:00.000Z", status: "active", updated_at: "2026-05-01T00:00:00.000Z" }],
  };
}

/** A live PORTAVA_OBJECT message in `thread`, sent by `sender`, referencing `objectId`. */
function shareMessage(sender: string, objectType: TelegraphObjectType, objectId: string, thread = THREAD, over: Row = {}): Row {
  return {
    id: `m-${sender.slice(0, 4)}-${objectId.slice(0, 4)}-${thread.slice(-2)}`,
    thread_id: thread, sender_id: sender, msg_type: "portava_object", subtype: objectType.toLowerCase(),
    deleted_at: null, body: JSON.stringify(buildPortavaObjectBody(objectType, objectId, null)), ...over,
  };
}

/** BOB has shared his layover into THREAD. */
function withLayoverShared(db: Record<string, Row[]>): Record<string, Row[]> {
  db.messages = [shareMessage(BOB, "LAYOVER_PLAN", LAY)];
  return db;
}

/** ALICE as an accepted member of BOB's public trip. */
function withCrew(db: Record<string, Row[]>): Record<string, Row[]> {
  db.trip_members = [{ trip_id: TRIP_PUBLIC, user_id: ALICE, status: "accepted" }];
  return db;
}

/** PostgREST `or=(and(a.eq.x,b.eq.y),...)`, the shape `isBlockedBetween` and `canViewEvent` send. */
function orFilter(expr: string): (r: Row) => boolean {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  const atom = (a: string): ((r: Row) => boolean) => {
    const m = /^([a-z_]+)\.(eq|gte)\.(.*)$/.exec(a.trim());
    if (!m) throw new Error(`fake: or() atom ${a} is not modelled`);
    const [, col, op, raw] = m as unknown as [string, string, string, string];
    // `gte` on timestamps compares instants (the history bound sends one).
    if (op === "gte") return (r) => r[col] != null && Date.parse(String(r[col])) >= Date.parse(raw);
    return (r) => String(r[col]) === raw;
  };
  const clauses = parts.map((p) => {
    const t = p.trim();
    if (t.startsWith("and(") && t.endsWith(")")) {
      const inner = t.slice(4, -1).split(",").map(atom);
      return (r: Row) => inner.every((f) => f(r));
    }
    return atom(t);
  });
  return (r) => clauses.some((f) => f(r));
}

/**
 * `failing` names a table whose every read fails, or `table@column=value` for a
 * failure on only the reads that filter `.eq(column, value)` — one direction of
 * the two `blocks` reads (verifier minor 5). `order` is honoured (verifier minor
 * 8): rows without the column sort last, and `limit` applies after it.
 */
/** Every select list the loaders send, as `table: columns` (the §10 cases read it). */
const selectLog: string[] = [];

function makeClient(db: Record<string, Row[]>, failing: ReadonlySet<string> = new Set()) {
  function from(table: string): Builder {
    const filters: Array<(r: Row) => boolean> = [];
    const eqs: string[] = [];
    let limitN: number | null = null;
    let orderBy: { c: string; asc: boolean } | null = null;
    const run = async (one: boolean): Promise<Result> => {
      if (failing.has(table) || eqs.some((e) => failing.has(`${table}@${e}`))) {
        return { data: null, error: { message: `injected failure on ${table}`, code: "XX000" } };
      }
      let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { c, asc } = orderBy;
        rows = [...rows].sort((x, y) => {
          const a = x[c], z = y[c];
          if (a == null && z == null) return 0;
          if (a == null) return 1;
          if (z == null) return -1;
          return (String(a) < String(z) ? -1 : String(a) > String(z) ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: one ? (rows[0] ?? null) : rows, error: null };
    };
    const b: Builder = {
      select(cols) { selectLog.push(`${table}: ${cols ?? ""}`); return b; },
      eq(c, v) { eqs.push(`${c}=${String(v)}`); filters.push((r) => r[c] === v); return b; },
      neq(c, v) { filters.push((r) => r[c] !== v); return b; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c, op, v) {
        if (op !== "is") throw new Error(`fake: not(${op}) is not implemented`);
        filters.push((r) => (r[c] ?? null) !== v);
        return b;
      },
      or(expr) { filters.push(orFilter(expr)); return b; },
      gte(c, v) { filters.push((r) => r[c] != null && Date.parse(String(r[c])) >= Date.parse(v)); return b; },
      like(c, pattern) {
        // Only the `%needle%` shape the share loaders send.
        if (!/^%[^%_]*%$/.test(pattern)) throw new Error(`fake: like(${pattern}) is not modelled`);
        const needle = pattern.slice(1, -1);
        filters.push((r) => typeof r[c] === "string" && (r[c] as string).includes(needle));
        return b;
      },
      order(c, o) {
        if (c) orderBy = { c, asc: (o as { ascending?: boolean } | undefined)?.ascending !== false };
        return b;
      },
      limit(n) { limitN = n; return b; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(onF, onR) { return run(false).then(onF, onR); },
    };
    return b;
  }
  return { from };
}

async function card(objectType: TelegraphObjectType, objectId: string, db = tables(), failing: ReadonlySet<string> = new Set(), viewer = ALICE) {
  const client = makeClient(db, failing) as unknown as Parameters<typeof resolveShareProjections>[0];
  const [r] = await resolveShareProjections(client, viewer, THREAD, [{ objectType, objectId }]);
  assert.ok(r, "one ref in, one card out");
  return r;
}

describe("Telegraph share card — a Highlight takes the single-Highlight read gate", () => {
  it("an unblocked, live, public Highlight resolves (intended case)", async () => {
    const r = await card("HIGHLIGHT", HL);
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "Sunset from the roof");
  });

  it("the OWNER blocked the viewer: unauthorized, and no caption or media URL", async () => {
    const db = tables();
    db.blocks = [{ blocker_id: BOB, blocked_id: ALICE }];
    const r = await card("HIGHLIGHT", HL, db);
    assert.equal(r.available, false);
    assert.equal(r.reason, "unauthorized");
    assert.equal(r.projection, null);
  });

  it("the VIEWER blocked the owner: unauthorized as well", async () => {
    const db = tables();
    db.blocks = [{ blocker_id: ALICE, blocked_id: BOB }];
    const r = await card("HIGHLIGHT", HL, db);
    assert.equal(r.available, false);
    assert.equal(r.reason, "unauthorized");
    assert.equal(r.projection, null);
  });

  it("an UNREADABLE blocks table is unknown, never a share", async () => {
    const r = await card("HIGHLIGHT", HL, tables(), new Set(["blocks"]));
    assert.equal(r.available, false);
    assert.equal(r.reason, "unknown");
    assert.equal(r.projection, null);
  });
});

describe("Telegraph share card — a Memory takes canReadMemory and a two-way block check", () => {
  it("an unblocked public Memory resolves (intended case)", async () => {
    const r = await card("MEMORY", M_PUBLIC);
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "The old harbour");
  });

  it("a `custom` Memory the viewer is allow-listed on still resolves (intended case)", async () => {
    const r = await card("MEMORY", M_CUSTOM);
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "For a chosen few");
  });

  it("an `only_me` Memory with a STALE allow-list entry is private — no title, no city", async () => {
    const r = await card("MEMORY", M_ONLY_ME_STALE);
    assert.equal(r.available, false);
    assert.equal(r.reason, "private");
    assert.equal(r.projection, null);
  });

  it("the owner blocked the viewer: unauthorized", async () => {
    const db = tables();
    db.blocks = [{ blocker_id: BOB, blocked_id: ALICE }];
    const r = await card("MEMORY", M_PUBLIC, db);
    assert.equal(r.available, false);
    assert.equal(r.reason, "unauthorized");
    assert.equal(r.projection, null);
  });

  it("the VIEWER blocked the owner: unauthorized (the direction this card used to skip)", async () => {
    const db = tables();
    db.blocks = [{ blocker_id: ALICE, blocked_id: BOB }];
    const r = await card("MEMORY", M_PUBLIC, db);
    assert.equal(r.available, false);
    assert.equal(r.reason, "unauthorized");
    assert.equal(r.projection, null);
  });

  it("an UNREADABLE blocks table is unknown", async () => {
    const r = await card("MEMORY", M_PUBLIC, tables(), new Set(["blocks"]));
    assert.equal(r.available, false);
    assert.equal(r.reason, "unknown");
  });

  it("a viewer on the hide list is refused", async () => {
    const r = await card("MEMORY", M_HIDDEN);
    assert.equal(r.available, false);
    assert.equal(r.projection, null);
  });
});

// ── N1 (2026-10-06): every family whose own read route refuses a block ─────────

/**
 * [family, id, the title an unblocked viewer sees, the fixture to start from].
 * RESERVATION and LAYOVER_PLAN are granted through trip crew, so their intended
 * case needs ALICE on BOB's trip.
 */
const BLOCK_GATED: Array<[TelegraphObjectType, string, string, () => Record<string, Row[]>]> = [
  ["STAMP", STAMP, "First river crossing", tables],
  ["EVENT", EV_PUBLIC, "Lantern walk", tables],
  ["MEDIA", MEDIA, "The alley at dusk", tables],
  ["PROFILE", BOB, "@bob", tables],
  ["TRIP", TRIP_PUBLIC, "Hue in winter", tables],
  ["POST", POST_PUBLISHED, "A bar with no sign", tables],
  ["RESERVATION", RES, "Riverside guesthouse", () => withCrew(tables())],
  ["LAYOVER_PLAN", LAY, "Layover in Singapore", () => withLayoverShared(tables())],
];

for (const [family, id, title, start] of BLOCK_GATED) {
  describe(`Telegraph share card — ${family} refuses a block in either direction`, () => {
    it("unblocked: the card resolves (intended case)", async () => {
      const r = await card(family, id, start());
      assert.equal(r.available, true, JSON.stringify(r));
      assert.equal(r.projection?.title, title);
    });

    it("the OWNER blocked the viewer: unauthorized, and nothing of the object", async () => {
      const db = start();
      db.blocks = [{ blocker_id: BOB, blocked_id: ALICE }];
      const r = await card(family, id, db);
      assert.equal(r.available, false);
      assert.equal(r.available === false && r.reason, "unauthorized");
      assert.equal(r.projection, null);
      assert.ok(!JSON.stringify(r).includes(title), "no field of the object rides on a refusal");
    });

    it("the VIEWER blocked the owner: unauthorized as well", async () => {
      const db = start();
      db.blocks = [{ blocker_id: ALICE, blocked_id: BOB }];
      const r = await card(family, id, db);
      assert.equal(r.available, false);
      assert.equal(r.available === false && r.reason, "unauthorized");
      assert.equal(r.projection, null);
    });

    it("an UNREADABLE blocks table is unknown, never a card", async () => {
      const r = await card(family, id, start(), new Set(["blocks"]));
      assert.equal(r.available, false);
      assert.equal(r.available === false && r.reason, "unknown");
      assert.equal(r.projection, null);
    });
  });
}

describe("Telegraph share card — PROFILE takes the universal name rule", () => {
  it("a subject who has NOT opted in is titled by handle; the real name is nowhere in the card", async () => {
    const r = await card("PROFILE", BOB);
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "@bob");
    assert.equal(r.projection?.subtitle, null);
    assert.ok(!JSON.stringify(r).includes("Robert Realname"));
  });

  it("a subject who opted in (show_real_name) is titled by name, handle beneath (intended case)", async () => {
    const db = tables();
    db.profile_privacy_settings = [{ user_id: BOB, show_real_name: true }];
    const r = await card("PROFILE", BOB, db);
    assert.equal(r.projection?.title, "Robert Realname");
    assert.equal(r.projection?.subtitle, "@bob");
  });

  it("an UNREADABLE profile_privacy_settings hides the name (fail closed), the card still resolves by handle", async () => {
    const db = tables();
    db.profile_privacy_settings = [{ user_id: BOB, show_real_name: true }];
    const r = await card("PROFILE", BOB, db, new Set(["profile_privacy_settings"]));
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "@bob");
    assert.ok(!JSON.stringify(r).includes("Robert Realname"));
  });

  it("the viewer's OWN profile shows their own name", async () => {
    const r = await card("PROFILE", ALICE, tables(), new Set(), ALICE);
    assert.equal(r.projection?.title, "Alice Realname");
  });

  it("a PRIVATE profile carries no avatar to anyone but its owner", async () => {
    const db = tables();
    db.profiles = db.profiles!.map((p) => (p.id === BOB ? { ...p, is_private: true } : p));
    const r = await card("PROFILE", BOB, db);
    assert.equal(r.available, true);
    assert.equal(r.projection?.imageUrl, null);
    const pub = await card("PROFILE", BOB);
    assert.equal(pub.projection?.imageUrl, "https://x/bob.jpg", "a public profile keeps its avatar");
  });

  it("a moderation BAN (user_account_states) degrades the card as the route degrades the passport", async () => {
    const db = tables();
    db.profiles = db.profiles!.map((p) => (p.id === BOB ? { ...p, user_account_states: [{ state: "banned", expires_at: null }] } : p));
    const r = await card("PROFILE", BOB, db);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
    assert.equal(r.projection, null);
  });
});

describe("Telegraph share card — TRIP shows a non-member the route's public PREVIEW", () => {
  it("all three toggles on, guard off: city, date and cover (intended case)", async () => {
    const r = await card("TRIP", TRIP_PUBLIC);
    assert.equal(r.projection?.subtitle, `Hue · ${FUTURE_START}`);
    assert.equal(r.projection?.imageUrl, "https://x/t1.jpg");
  });

  for (const [toggle, gone, field] of [
    ["show_destination_city", "Hue", "subtitle"],
    ["show_exact_dates", FUTURE_START, "subtitle"],
    ["show_header_publicly", "https://x/t1.jpg", "imageUrl"],
  ] as const) {
    it(`${toggle} = false withholds it from a non-member`, async () => {
      const db = tables();
      db.trips = db.trips!.map((t) => ({ ...t, [toggle]: false }));
      const r = await card("TRIP", TRIP_PUBLIC, db);
      assert.equal(r.available, true);
      assert.ok(!String(r.projection?.[field] ?? "").includes(gone), `${field} still carries ${gone}`);
    });
  }

  it("the §6.3 absence guard ON withholds a future start from a non-member", async () => {
    const db = tables();
    db.feature_flags = [{ flag: "trip_absence_guard_enabled", enabled: true }];
    const r = await card("TRIP", TRIP_PUBLIC, db);
    assert.equal(r.projection?.subtitle, "Hue");
  });

  it("an accepted MEMBER sees the full trip whatever the toggles and the guard say", async () => {
    const db = withCrew(tables());
    db.trips = db.trips!.map((t) => ({ ...t, show_destination_city: false, show_exact_dates: false, show_header_publicly: false }));
    db.feature_flags = [{ flag: "trip_absence_guard_enabled", enabled: true }];
    const r = await card("TRIP", TRIP_PUBLIC, db);
    assert.equal(r.projection?.subtitle, `Hue · ${FUTURE_START}`);
    assert.equal(r.projection?.imageUrl, "https://x/t1.jpg");
  });
});

describe("Telegraph share card — EVENT takes canViewEvent and checkEventEligibility", () => {
  it("a host's BAN of the viewer refuses the card", async () => {
    const db = tables();
    db.event_roles = [{ event_id: EV_PUBLIC, user_id: ALICE, role: "banned" }];
    const r = await card("EVENT", EV_PUBLIC, db);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unauthorized");
  });

  it("an 18+ event refuses a minor while the trust gates run, and resolves for an adult (intended case)", async () => {
    const db = tables();
    db.feature_flags = [{ flag: "events_trust_gates_enabled", enabled: true }];
    const adult = await card("EVENT", EV_ADULTS, db);
    assert.equal(adult.available, true, JSON.stringify(adult));
    db.profiles = db.profiles!.map((p) => (p.id === ALICE ? { ...p, date_of_birth: "2014-01-01" } : p));
    const minor = await card("EVENT", EV_ADULTS, db);
    assert.equal(minor.available, false);
    assert.equal(minor.available === false && minor.reason, "unauthorized");
    assert.equal(minor.projection, null);
  });

  it("an eligibility input that cannot be read is unknown, not a refusal about the viewer", async () => {
    const db = tables();
    db.feature_flags = [{ flag: "events_trust_gates_enabled", enabled: true }];
    const r = await card("EVENT", EV_ADULTS, db, new Set(["profiles"]));
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });

  it("a friends-only event the viewer only has an attendee row on is private (canViewEvent says no)", async () => {
    const r = await card("EVENT", EV_FRIENDS);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    const db = tables();
    db.user_friendships = [{ user_a: ALICE, user_b: BOB }];
    const friend = await card("EVENT", EV_FRIENDS, db);
    assert.equal(friend.available, true, "a friend of the host holding an attendee row resolves (intended case)");
  });
});

describe("Telegraph share card — POST and ROUTE take the rest of their routes' rules", () => {
  it("a public post that is still a DRAFT is private to anyone but its author", async () => {
    const r = await card("POST", POST_DRAFT);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    assert.ok(!JSON.stringify(r).includes("Not finished yet"));
    const own = await card("POST", POST_DRAFT, tables(), new Set(), BOB);
    assert.equal(own.available, true, "its author still sees it");
  });

  it("a route plan with NO trip is refused to a route member who is not its owner", async () => {
    const r = await card("ROUTE", ROUTE_NO_TRIP);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unauthorized");
  });

  it("a route plan on a trip needs the viewer on the trip as well as on the route", async () => {
    const off = await card("ROUTE", ROUTE_ON_TRIP);
    assert.equal(off.available, false);
    assert.equal(off.available === false && off.reason, "unauthorized");
    const on = await card("ROUTE", ROUTE_ON_TRIP, withCrew(tables()));
    assert.equal(on.available, true, "on both: resolves (intended case)");
    const unread = await card("ROUTE", ROUTE_ON_TRIP, withCrew(tables()), new Set(["trip_members"]));
    assert.equal(unread.available === false && unread.reason, "unknown");
  });
});

describe("Telegraph share card — the Highlight verdict logs through the route's logger (delta N8)", () => {
  it("an unreadable §11 control table: the card is unknown AND the withholding is logged, naming the verdict", async () => {
    const lines: Array<{ obj: unknown; msg: string }> = [];
    const log = { error: (obj: unknown, msg: string) => { lines.push({ obj, msg }); } };
    const client = makeClient(tables(), new Set(["highlight_resurfacing_preferences"])) as unknown as Parameters<typeof resolveShareProjections>[0];
    const [r] = await resolveShareProjections(client, ALICE, THREAD, [{ objectType: "HIGHLIGHT", objectId: HL }], log);
    assert.equal(r?.available, false);
    assert.equal(r?.available === false && r.reason, "unknown");
    assert.ok(
      lines.some((l) => /UNREADABLE/.test(l.msg) && JSON.stringify(l.obj).includes("resolveViewAccess")),
      `the single-Highlight verdict's withholding reached the log: ${JSON.stringify(lines)}`,
    );
  });
});

describe("Telegraph share card — LAYOVER_PLAN resolves only where its traveller shared it (lead ruling D-LAYOVER-SHARE-CREW)", () => {
  const OTHER_THREAD = "dddddddd-0000-4000-8000-0000000000ee";

  it("its OWN traveller resolves it, shared or not", async () => {
    const r = await card("LAYOVER_PLAN", LAY, tables(), new Set(), BOB);
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "Layover in Singapore");
  });

  it("a thread member resolves it where the traveller shared it into THIS thread (intended case)", async () => {
    const r = await card("LAYOVER_PLAN", LAY, withLayoverShared(tables()));
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "Layover in Singapore");
  });

  it("an accepted TRIP-MATE in a thread with no such share is refused — crew alone never grants it", async () => {
    const r = await card("LAYOVER_PLAN", LAY, withCrew(tables()));
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    assert.equal(r.projection, null);
    assert.ok(!JSON.stringify(r).includes("Singapore"));
  });

  it("a non-member of the trip with no share is refused", async () => {
    const r = await card("LAYOVER_PLAN", LAY);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
  });

  it("the traveller's share in ANOTHER thread does not open it here", async () => {
    const db = withCrew(tables());
    db.messages = [shareMessage(BOB, "LAYOVER_PLAN", LAY, OTHER_THREAD)];
    const r = await card("LAYOVER_PLAN", LAY, db);
    assert.equal(r.available, false);
  });

  it("a share sent by someone OTHER than the traveller does not open it", async () => {
    const db = withCrew(tables());
    db.messages = [shareMessage(ALICE, "LAYOVER_PLAN", LAY)];
    const r = await card("LAYOVER_PLAN", LAY, db);
    assert.equal(r.available, false);
  });

  it("a DELETED share message does not open it", async () => {
    const db = tables();
    db.messages = [shareMessage(BOB, "LAYOVER_PLAN", LAY, THREAD, { deleted_at: "2026-10-01T00:00:00.000Z" })];
    const r = await card("LAYOVER_PLAN", LAY, db);
    assert.equal(r.available, false);
  });

  it("the traveller's share of a DIFFERENT layover does not open this one", async () => {
    const db = tables();
    db.messages = [shareMessage(BOB, "LAYOVER_PLAN", "1a110000-0000-4000-8000-0000000000ff", THREAD, {
      // the body names the other layover; the id of this one appears only in a caption
      body: JSON.stringify(buildPortavaObjectBody("LAYOVER_PLAN", "1a110000-0000-4000-8000-0000000000ff", `not ${LAY}`)),
    })];
    const r = await card("LAYOVER_PLAN", LAY, db);
    assert.equal(r.available, false, "the parsed reference decides, not a substring");
  });

  it("an UNREADABLE messages read is unknown, never a card", async () => {
    const r = await card("LAYOVER_PLAN", LAY, withLayoverShared(tables()), new Set(["messages"]));
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
    assert.equal(r.projection, null);
  });
});

// ── 951bf963a verification, R1: the block is read FIRST ────────────────────────

/**
 * [family, id, a fixture where the object is in a REFUSED state the route
 * would never reveal to a blocked viewer, the reason an unblocked viewer gets].
 * A blocked viewer must get `unauthorized` for every one of them — never the
 * state word.
 */
const STATE_REVEALING: Array<[TelegraphObjectType, string, () => Record<string, Row[]>, string]> = [
  ["STAMP", STAMP, () => { const d = tables(); d.user_stamps = d.user_stamps!.map((x) => ({ ...x, is_revoked: true })); return d; }, "deleted"],
  ["EVENT", EV_PUBLIC, () => { const d = tables(); d.events = d.events!.map((x) => ({ ...x, state: "draft" })); return d; }, "deleted"],
  ["MEDIA", MEDIA, () => { const d = tables(); d.media_assets = d.media_assets!.map((x) => ({ ...x, moderation_status: "rejected" })); return d; }, "deleted"],
  ["MEMORY", M_PUBLIC, () => { const d = tables(); d.memories = d.memories!.map((x) => ({ ...x, state: "draft" })); return d; }, "deleted"],
  ["HIGHLIGHT", HL, () => { const d = tables(); d.highlights = d.highlights!.map((x) => ({ ...x, archived_at: "2026-10-01T00:00:00.000Z" })); return d; }, "deleted"],
  ["PROFILE", BOB, () => { const d = tables(); d.profiles = d.profiles!.map((x) => (x.id === BOB ? { ...x, account_status: "suspended" } : x)); return d; }, "deleted"],
  ["POST", POST_PUBLISHED, () => { const d = tables(); d.posts = d.posts!.map((x) => ({ ...x, status: "deleted", deleted_at: "2026-10-01T00:00:00.000Z" })); return d; }, "deleted"],
  ["RESERVATION", RES, () => { const d = withCrew(tables()); d.trip_reservations = d.trip_reservations!.map((x) => ({ ...x, status: "dismissed" })); return d; }, "deleted"],
  ["LAYOVER_PLAN", LAY, () => { const d = withLayoverShared(tables()); d.layover_sessions = d.layover_sessions!.map((x) => ({ ...x, status: "cancelled" })); return d; }, "deleted"],
  ["MEMORY", M_ONLY_ME_STALE, tables, "private"],
];

for (const [family, id, start, unblockedReason] of STATE_REVEALING) {
  describe(`Telegraph share card — ${family}: a blocked viewer learns nothing of the object's state (R1)`, () => {
    it(`unblocked, the card says "${unblockedReason}" (the precondition: the state IS refused)`, async () => {
      const r = await card(family, id, start());
      assert.equal(r.available, false);
      assert.equal(r.available === false && r.reason, unblockedReason);
    });
    for (const [label, row] of [
      ["the owner blocked the viewer", { blocker_id: BOB, blocked_id: ALICE }],
      ["the viewer blocked the owner", { blocker_id: ALICE, blocked_id: BOB }],
    ] as const) {
      it(`${label}: "unauthorized", not "${unblockedReason}"`, async () => {
        const db = start();
        db.blocks = [row];
        const r = await card(family, id, db);
        assert.equal(r.available, false);
        assert.equal(r.available === false && r.reason, "unauthorized");
      });
    }
    it(`an unreadable blocks table: "unknown", not "${unblockedReason}"`, async () => {
      const r = await card(family, id, start(), new Set(["blocks"]));
      assert.equal(r.available === false && r.reason, "unknown");
    });
  });
}

// ── 951bf963a verification, R2 (lead ruling YES): a share the viewer may READ ───

describe("Telegraph share card — LAYOVER_PLAN under the §14.3 history bound (R2)", () => {
  const SHARED_AT = "2026-10-03T10:00:00.000Z";
  const shared = (visibleFrom: string | null, flagOn: boolean) => {
    const db = withLayoverShared(tables());
    db.messages = db.messages!.map((m) => ({ ...m, created_at: SHARED_AT }));
    db.message_thread_members = [{ thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: visibleFrom }];
    db.feature_flags = [{ flag: "telegraph_history_bound_enabled", enabled: flagOn }];
    return db;
  };

  it("bound ON, the viewer joined AFTER the share: they cannot read it, so the card is refused", async () => {
    const r = await card("LAYOVER_PLAN", LAY, shared("2026-10-04T00:00:00.000Z", true));
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
  });

  it("bound ON, the viewer's window opened BEFORE the share: the card resolves (intended case)", async () => {
    const r = await card("LAYOVER_PLAN", LAY, shared("2026-10-01T00:00:00.000Z", true));
    assert.equal(r.available, true);
  });

  it("bound ON with an unbounded membership (visible_from_at NULL): the card resolves", async () => {
    const r = await card("LAYOVER_PLAN", LAY, shared(null, true));
    assert.equal(r.available, true);
  });

  it("bound OFF: the window is not applied, exactly as the thread read does not apply it", async () => {
    const r = await card("LAYOVER_PLAN", LAY, shared("2026-10-04T00:00:00.000Z", false));
    assert.equal(r.available, true);
  });

  it("bound ON and the viewer's membership UNREADABLE: unknown, never a card", async () => {
    const r = await card("LAYOVER_PLAN", LAY, shared("2026-10-01T00:00:00.000Z", true), new Set(["message_thread_members"]));
    assert.equal(r.available === false && r.reason, "unknown");
  });

  it("bound ON and the viewer holds no membership row: refused", async () => {
    const db = shared("2026-10-01T00:00:00.000Z", true);
    db.message_thread_members = [];
    const r = await card("LAYOVER_PLAN", LAY, db);
    assert.equal(r.available, false);
  });
});

describe("Telegraph share card — layover and trip state edges (verifier minors 1 and 4)", () => {
  it("a COMPLETED layover is no longer offered, even where it was shared", async () => {
    const db = withLayoverShared(tables());
    db.layover_sessions = db.layover_sessions!.map((x) => ({ ...x, status: "completed" }));
    const r = await card("LAYOVER_PLAN", LAY, db);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
  });

  it("a PENDING trip member is not a member: a private trip is refused to them, and resolves once accepted", async () => {
    const db = tables();
    db.trips = db.trips!.map((t) => ({ ...t, visibility: "private" }));
    db.trip_members = [{ trip_id: TRIP_PUBLIC, user_id: ALICE, status: "pending" }];
    const pending = await card("TRIP", TRIP_PUBLIC, db);
    assert.equal(pending.available, false);
    assert.equal(pending.available === false && pending.reason, "unauthorized");
    db.trip_members = [{ trip_id: TRIP_PUBLIC, user_id: ALICE, status: "accepted" }];
    const accepted = await card("TRIP", TRIP_PUBLIC, db);
    assert.equal(accepted.available, true);
  });
});

describe("Telegraph share card — one-sided block reads and the share lookup's order (verifier minors 5 and 8)", () => {
  it("only the OWNER-direction blocks read fails: unknown, never a card", async () => {
    const r = await card("MEMORY", M_PUBLIC, tables(), new Set([`blocks@blocker_id=${BOB}`]));
    assert.equal(r.available, false);
    assert.equal(r.reason, "unknown");
    assert.equal(r.projection, null);
  });

  it("only the VIEWER-direction blocks read fails: unknown, never a card", async () => {
    const r = await card("MEMORY", M_PUBLIC, tables(), new Set([`blocks@blocker_id=${ALICE}`]));
    assert.equal(r.available, false);
    assert.equal(r.reason, "unknown");
    assert.equal(r.projection, null);
  });

  it("the traveller's NEWEST share resolves the card behind 20 older shares that also carry its id", async () => {
    const db = withCrew(tables());
    const OTHER = "1a110000-0000-4000-8000-0000000000ff";
    const decoys = Array.from({ length: 20 }, (_, i) =>
      shareMessage(BOB, "LAYOVER_PLAN", OTHER, THREAD, {
        id: `decoy-${i}`,
        created_at: `2026-10-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        body: JSON.stringify(buildPortavaObjectBody("LAYOVER_PLAN", OTHER, `see also ${LAY}`)),
      }),
    );
    db.messages = [...decoys, shareMessage(BOB, "LAYOVER_PLAN", LAY, THREAD, { created_at: "2026-10-02T00:00:00.000Z" })];
    const r = await card("LAYOVER_PLAN", LAY, db);
    assert.equal(r.available, true, "the newest share is among the 20 read");
    assert.equal(r.projection?.objectId, LAY);
  });
});

// ── §10 on the Memory card (lane R recheck, 2026-10-07) ──────────────────────

/** The precision gate in a state, and M_PUBLIC carrying `label` (or no key at all). */
function precisionWorld(gate: boolean | null, label?: unknown): Record<string, Row[]> {
  const db = tables();
  db.feature_flags = gate === null ? [] : [{ flag: "memory_location_precision_enabled", enabled: gate }];
  if (label !== undefined) {
    db.memories = db.memories!.map((m) => (m.id === M_PUBLIC ? { ...m, location_precision: label } : m));
  }
  return db;
}

const memorySelects = () => selectLog.filter((s) => s.startsWith("memories:"));

describe("Telegraph share card — a Memory's city takes the §10 precision gate, and an unreadable gate clamps", () => {
  it("gate ON, owner chose 'city': the card keeps its city and the read names the rung (intended case)", async () => {
    selectLog.length = 0;
    const r = await card("MEMORY", M_PUBLIC, precisionWorld(true, "city"));
    assert.equal(r.available, true);
    assert.equal(r.projection?.subtitle, "Hue");
    assert.ok(memorySelects().every((s) => s.includes("location_precision")), memorySelects().join(" | "));
  });

  it("gate ON, owner chose 'country': the card resolves with NO city", async () => {
    const r = await card("MEMORY", M_PUBLIC, precisionWorld(true, "country"));
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "The old harbour");
    assert.equal(r.projection?.subtitle, null);
  });

  it("gate ON, owner chose 'hidden': no city", async () => {
    const r = await card("MEMORY", M_PUBLIC, precisionWorld(true, "hidden"));
    assert.equal(r.projection?.subtitle, null);
  });

  it("gate ON, an unreadable LABEL (null, or off the ladder) clamps: no city", async () => {
    for (const label of [null, "EXACT", ""]) {
      const r = await card("MEMORY", M_PUBLIC, precisionWorld(true, label));
      assert.equal(r.available, true);
      assert.equal(r.projection?.subtitle, null, `label ${JSON.stringify(label)}`);
    }
  });

  it("gate UNREADABLE: the card still resolves, with NO city, and the read never names the column", async () => {
    selectLog.length = 0;
    const r = await card("MEMORY", M_PUBLIC, precisionWorld(true), new Set(["feature_flags"]));
    assert.equal(r.available, true, "the gate is about where, not whether");
    assert.equal(r.projection?.subtitle, null);
    assert.ok(memorySelects().length > 0 && memorySelects().every((s) => !s.includes("location_precision")), memorySelects().join(" | "));
  });

  it("gate OFF (row false, or no row): the city is served as before 2338", async () => {
    for (const gate of [false, null]) {
      selectLog.length = 0;
      const r = await card("MEMORY", M_PUBLIC, precisionWorld(gate));
      assert.equal(r.projection?.subtitle, "Hue", `gate ${String(gate)}`);
      assert.ok(memorySelects().every((s) => !s.includes("location_precision")));
    }
  });

  it("the OWNER's own card keeps the city whatever the rung", async () => {
    const r = await card("MEMORY", M_PUBLIC, precisionWorld(true, "hidden"), new Set(), BOB);
    assert.equal(r.available, true);
    assert.equal(r.projection?.subtitle, "Hue");
  });
});
