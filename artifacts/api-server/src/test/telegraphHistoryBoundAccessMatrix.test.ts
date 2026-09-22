/**
 * Telegraph §14.3 group history bounds — THE ACCESS MATRIX.
 *
 * Two suites already exist and this one does not repeat them:
 *   src/test/telegraphHistoryBound.test.ts       the four readers 2400's flag
 *                                                description names.
 *   src/test/telegraphHistoryBoundDoors.test.ts  media bytes, reconnect replay,
 *                                                the group-chat read.
 *
 * What neither drives is the CROSS PRODUCT: every access path a caller can
 * actually reach a message body through, against every MEMBERSHIP STATE a row
 * in message_thread_members can be in. A bound that holds for the newly added
 * member on page 1 and leaks on page 3, or holds in the thread read and not in
 * search, is not a bound. A bound that hides a founding member's own history is
 * not a privacy feature, it is a data-loss bug. Both halves are asserted for
 * every cell below.
 *
 * THE PATHS (all driven as ROUTES over a fixture store, except the media door,
 * which has no route of its own and is driven through its authorizer):
 *   1. GET /threads/:threadId/messages
 *   2. the same route PAGED — ?before walked until exhaustion, so the boundary
 *      is crossed by pagination rather than by a single page's limit
 *   3. GET /telegraph/search, GET /threads/:id/search, GET /threads/:id/ask
 *   4. lib/mediaAccess.ts branch 3c — the bytes behind a message's mediaUrl
 *   5. the quoted-reply context routes/messaging.ts builds from replyToIdMap
 *
 * THE MEMBERSHIP STATES
 *   ALICE  founding member, visible_from_at NULL (the shape EVERY row that
 *          predates 2400 has). NULL is UNBOUNDED, not "bounded at zero", and
 *          getting that backwards would silently hide people's own history.
 *   BOB    added later, visible_from_at = BOB_BOUND. The member 2400 exists for.
 *   CARL   LEFT and REJOINED. 2400's trigger stamps left_at and KEEPS the row;
 *          on rejoin (left_at NOT NULL -> NULL) it opens a NEW window at now().
 *          CARL therefore carries a window that opens AFTER a message he
 *          himself sent in his first stint. See the FINDING below.
 *   DORA   joined_at NULL and visible_from_at NULL — the row where a bound
 *          could not be derived. What the code does with it is RECORDED here,
 *          not assumed.
 *   EVE    not a member at all. The bound narrows access; it must never widen
 *          it, so EVE is refused on every path in both flag states.
 *
 * BOTH FLAG STATES. Every path runs with telegraph_history_bound_enabled OFF
 * (the production seed, and the state of every database today) and ON. OFF must
 * be byte-identical to pre-2400: no reader may NAME visible_from_at and no
 * reader may put a created_at lower bound in the query. That identity is what
 * makes the flag safe to flip.
 *
 * ── FINDING, asserted below rather than argued ───────────────────────────────
 * Migration 2966's POSTCONDITION 3 refuses to ship a row whose window opens
 * after a message that member themselves sent ("refusing to hide a member's own
 * history"). The rejoin branch of telegraph_member_visibility_window() can
 * CREATE exactly that shape after the migration has run: a member who leaves
 * and rejoins gets visible_from_at = now(), and their own first-stint messages
 * fall outside it. `ownMessagesOutsideWindow` below is postcondition 3's
 * predicate, evaluated against this fixture; CARL is a counterexample and the
 * tests state so. The production measurement of "0 own-messages hidden" is a
 * measurement of the BACKFILL (which clamps to LEAST(..., own_first)), not a
 * property the trigger maintains going forward.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphHistoryBoundAccessMatrix.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { authorizeMediaAccess, publicUrlFor, _clearMediaAccessCache } from "../lib/mediaAccess.js";
import messagingRouter from "../routes/messaging.js";
import searchRouter from "../server/telegraph/searchRoute.js";
import { visibleFromOf, withinWindow } from "../services/groupChatHistoryBound.js";
import { makeFakeClient, type FakeClient } from "./telegraphCertificationHarness.js";

/* ──────────────────────────── the cast ──────────────────────────────────── */

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // founding member, NULL bound
const BOB   = "bbbbbbbb-0000-4000-8000-000000000002"; // added later, bounded
const CARL  = "cccccccc-0000-4000-8000-000000000003"; // left and rejoined
const DORA  = "dddddddd-0000-4000-8000-000000000004"; // joined_at NULL, bound NULL
const EVE   = "eeeeeeee-0000-4000-8000-000000000005"; // not a member

const THREAD = "00000000-0000-4000-8000-00000000000a";
const TRIP   = "33333333-0000-4000-8000-000000000003";

/* ──────────────────────────── the timeline ──────────────────────────────── */

const T01 = "2026-01-05T00:00:00.000Z";
const T02 = "2026-01-10T00:00:00.000Z";
const T03 = "2026-01-20T00:00:00.000Z";
const T04 = "2026-02-10T00:00:00.000Z";
const T05 = "2026-02-20T00:00:00.000Z";
const BOB_BOUND = "2026-03-01T00:00:00.000Z";
const T06 = BOB_BOUND;                                 // exactly at the bound
const T07 = "2026-03-05T00:00:00.000Z";
const CARL_REJOIN = "2026-03-08T00:00:00.000Z";
const T08 = "2026-03-10T00:00:00.000Z";
const T09 = "2026-03-12T00:00:00.000Z";

const M01 = "10000000-0000-4000-8000-000000000001";
const M02 = "10000000-0000-4000-8000-000000000002"; // CARL's OWN, first stint
const M03 = "10000000-0000-4000-8000-000000000003";
const M04 = "10000000-0000-4000-8000-000000000004"; // quote target + media, pre-window
const M05 = "10000000-0000-4000-8000-000000000005";
const M06 = "10000000-0000-4000-8000-000000000006"; // exactly at BOB_BOUND
const M07 = "10000000-0000-4000-8000-000000000007"; // replies to M04
const M08 = "10000000-0000-4000-8000-000000000008"; // media, inside every window
const M09 = "10000000-0000-4000-8000-000000000009"; // BOB's OWN

/** The rare token every search case searches for. It appears three times. */
const TOKEN = "zephyr9";

const SECRET_BODY = `the padlock code is ${TOKEN}`;

/**
 * Storage keys for the two message attachments. `post-media` is a PRIVATE
 * bucket, so branch 3c is handing over BYTES, not deciding a thumbnail.
 *
 * Both are owned by ALICE by path prefix and both sit on messages ALICE sent,
 * because branch 3c only DECIDES when the object's owner is the message's
 * sender — a viewer who owns the path is granted by an earlier branch and 3c
 * never runs for them.
 */
const PRE_KEY = `${ALICE}/pre-window.jpg`;
const IN_KEY  = `${ALICE}/in-window.jpg`;

/**
 * Built through the same helper mediaAccess uses to recognise a stored URL, so
 * the two spellings cannot drift — and so this file never names a Supabase
 * credential variable, which `scripts/check-guard-coverage.mjs` reads as "this
 * file can reach a database". It reaches nothing; it hands a fake client in.
 */
const pub = (key: string): string => publicUrlFor("post-media", key) ?? "";

/** The two migrations whose text the rejoin cases below quote. */
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const readMigration = (name: string): string =>
  readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");

/* ──────────────────────────── the fixture ───────────────────────────────── */

interface Fixture {
  /** null/undefined → no feature_flags row at all, which is production today. */
  flag?: boolean | null;
}

function msg(
  id: string,
  sender: string,
  body: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    body,
    created_at: createdAt,
    deleted_at: null,
    edited_at: null,
    original_language: null,
    msg_type: "text",
    subtype: null,
    media_url: null,
    media_type: null,
    media_thumbnail_url: null,
    media_duration_seconds: null,
    reply_to_id: null,
    ...extra,
  };
}

function member(
  user: string,
  joinedAt: string | null,
  visibleFrom: string | null,
  leftAt: string | null = null,
): Record<string, unknown> {
  return {
    thread_id: THREAD,
    user_id: user,
    role: "member",
    joined_at: joinedAt,
    left_at: leftAt,
    last_read_at: null,
    muted_at: null,
    archived_at: null,
    visible_from_at: visibleFrom,
  };
}

function store(f: Fixture = {}): Record<string, any[]> {
  const flagRows =
    f.flag === null || f.flag === undefined
      ? []
      : [{ flag: "telegraph_history_bound_enabled", enabled: f.flag }];
  return {
    feature_flags: flagRows,
    blocks: [],
    posts: [],
    post_media: [],
    media_assets: [],
    media_attachments: [],
    stories: [],
    highlights: [],
    saved_messages: [],
    message_translations: [],
    trips: [{ id: TRIP, title: "Lisbon", destination_city: "Lisbon", created_by: ALICE, owner_id: ALICE }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, status: "accepted", role: "owner" },
      { trip_id: TRIP, user_id: BOB, status: "accepted", role: "member" },
      { trip_id: TRIP, user_id: CARL, status: "accepted", role: "member" },
      { trip_id: TRIP, user_id: DORA, status: "accepted", role: "member" },
    ],
    circle_member_visibility_overrides: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", account_status: null },
      { id: BOB, handle: "bob", name: "Bob", account_status: null },
      { id: CARL, handle: "carl", name: "Carl", account_status: null },
      { id: DORA, handle: "dora", name: "Dora", account_status: null },
      { id: EVE, handle: "eve", name: "Eve", account_status: null },
    ],
    message_threads: [
      {
        id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "T",
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: T09, last_message_at: T09,
      },
    ],
    message_thread_members: [
      // Predates 2400: the column is NULL and NULL means unbounded.
      member(ALICE, "2026-01-01T00:00:00.000Z", null),
      // The member migration 2400 exists because of.
      member(BOB, BOB_BOUND, BOB_BOUND),
      // Left and rejoined. The row was KEPT (left_at stamped, then cleared) and
      // the trigger opened a NEW window at the rejoin instant.
      member(CARL, "2026-01-08T00:00:00.000Z", CARL_REJOIN),
      // No membership timestamp to derive a bound from, and none derived.
      member(DORA, null, null),
      // EVE has no row at all.
    ],
    messages: [
      msg(M01, ALICE, "alpha one", T01),
      msg(M02, CARL, `carl said ${TOKEN} first`, T02),
      msg(M03, ALICE, "alpha two", T03),
      msg(M04, ALICE, SECRET_BODY, T04, {
        msg_type: "media", media_url: pub(PRE_KEY), media_type: "image",
      }),
      msg(M05, ALICE, "alpha three", T05),
      msg(M06, ALICE, "at the bound", T06),
      // The REPLY's own body deliberately shares no word with M04's, so the
      // "no pre-window body anywhere in the payload" assertions below can use
      // the whole response as the haystack instead of one field.
      msg(M07, ALICE, "noted, thanks", T07, { reply_to_id: M04 }),
      msg(M08, ALICE, `welcome aboard ${TOKEN} too`, T08, {
        msg_type: "media", media_url: pub(IN_KEY), media_type: "image",
      }),
      msg(M09, BOB, "bob own words", T09),
    ],
  };
}

/* ───────────────────── postcondition 3, as a predicate ──────────────────── */

/**
 * Migration 2966's POSTCONDITION 3, spelled in TypeScript over the same rows:
 *
 *   SELECT count(*) FROM message_thread_members m JOIN messages msg
 *     ON msg.thread_id = m.thread_id AND msg.sender_id = m.user_id
 *    WHERE m.visible_from_at IS NOT NULL AND msg.created_at < m.visible_from_at;
 *
 * The migration ABORTS when this is non-zero. Evaluating it here is how the
 * rejoin finding is stated as an assertion rather than as a paragraph.
 */
function ownMessagesOutsideWindow(db: Record<string, any[]>, userId: string): string[] {
  const rows = (db["message_thread_members"] ?? []).filter((m: any) => m.user_id === userId);
  const out: string[] = [];
  for (const m of rows) {
    if (m.visible_from_at == null) continue;
    for (const msgRow of db["messages"] ?? []) {
      if (msgRow.thread_id !== m.thread_id) continue;
      if (msgRow.sender_id !== userId) continue;
      if (Date.parse(msgRow.created_at) < Date.parse(m.visible_from_at)) out.push(String(msgRow.id));
    }
  }
  return out;
}

/* ──────────────────────────── the harness ───────────────────────────────── */

let server: Server;
let base = "";

function use(f: Fixture = {}): FakeClient {
  _resetRateLimit();
  _clearMediaAccessCache();
  const c = makeFakeClient(store(f));
  _setTestClient(c as any, true);
  return c;
}

async function get(path: string, asUser: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  // Both surfaces on one app, because they are two doors onto the same rows and
  // a suite that mounted them separately could not compare them.
  app.use("/api", messagingRouter);
  app.use("/api", searchRouter);
  server = createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(async () => {
  _setTestClient(null as any, false);
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => { _resetRateLimit(); _clearMediaAccessCache(); });

/** Message ids from a thread-read response, newest first as the route orders. */
const idsOf = (r: { body: any }): string[] => ((r.body?.messages ?? []) as any[]).map((m) => String(m.id));

/** Message ids in a §21 search response. */
const hitIds = (r: { body: any }): string[] => ((r.body?.hits ?? []) as any[]).map((h) => String(h.messageId));

/** Every membership select this client observed, as the code spelled it. */
const memberSelects = (c: FakeClient): string[] =>
  c._observed.selects.filter((s) => s.table === "message_thread_members").map((s) => s.sel);

/** Every created_at lower bound this client observed on `messages`. */
const messageGtes = (c: FakeClient) =>
  c._observed.gte.filter((g) => g.table === "messages" && g.col === "created_at");

/** OFF must be byte-identical to pre-2400 on both counts. */
function assertPre2400Shape(c: FakeClient, where: string): void {
  for (const sel of memberSelects(c)) {
    assert.ok(!sel.includes("visible_from_at"), `${where}: OFF must not NAME the column — got: ${sel}`);
  }
  assert.deepEqual(
    messageGtes(c), [],
    `${where}: OFF must put no created_at lower bound in any messages query`,
  );
}

/**
 * Walk GET /threads/:id/messages backwards with ?before until it is exhausted.
 * This is the shape of the defect the pagination cell exists to catch: a bound
 * applied to the first page and not to the cursor that walks past it.
 */
async function pageAll(user: string, pageSize: number): Promise<{ pages: string[][]; all: string[] }> {
  const pages: string[][] = [];
  const all: string[] = [];
  let before: string | null = null;
  // Hard stop well above the fixture's row count: a bound that never exhausts
  // is itself a failure, and an unbounded loop would hang the suite instead of
  // reporting it.
  for (let guard = 0; guard < 12; guard += 1) {
    const qs = `?limit=${pageSize}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
    const res = await get(`/threads/${THREAD}/messages${qs}`, user);
    assert.equal(res.status, 200, `page ${guard + 1} for ${user} was ${res.status}`);
    const rows = (res.body.messages ?? []) as any[];
    pages.push(rows.map((m) => String(m.id)));
    for (const m of rows) all.push(String(m.id));
    if (rows.length === 0) return { pages, all };
    before = String(rows[rows.length - 1].createdAt);
  }
  assert.fail(`pagination for ${user} never exhausted — the cursor is not making progress`);
  throw new Error("unreachable");
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PATH 1 — GET /threads/:threadId/messages
 * ═════════════════════════════════════════════════════════════════════════*/

describe("§14.3 path 1: GET /threads/:id/messages × every membership state", () => {
  it("flag OFF: every member reads the whole history and no reader names the column", async () => {
    for (const who of [ALICE, BOB, CARL, DORA]) {
      const c = use({ flag: false });
      const res = await get(`/threads/${THREAD}/messages?limit=100`, who);
      assert.equal(res.status, 200);
      assert.equal(idsOf(res).length, 9, `${who} must read all nine messages with the flag OFF`);
      assertPre2400Shape(c, `thread read as ${who}`);
    }
  });

  it("flag ABSENT (no row at all, which is production today): identical to OFF", async () => {
    const c = use({ flag: null });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    assert.equal(idsOf(res).length, 9);
    assertPre2400Shape(c, "thread read, flag absent");
  });

  it("flag ON: the newly added member (BOB) sees only messages at or after the bound", async () => {
    const c = use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    assert.equal(res.status, 200);
    assert.deepEqual(idsOf(res), [M09, M08, M07, M06]);
    assert.ok(
      memberSelects(c).some((s) => s.includes("visible_from_at")),
      "ON must READ the bound rather than assume one",
    );
    assert.ok(
      messageGtes(c).some((g) => g.val === BOB_BOUND),
      "the bound belongs in the QUERY, not in a post-filter that pagination walks past",
    );
  });

  it("flag ON: M06 sits EXACTLY at the bound and is inside the window (inclusive)", async () => {
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    assert.ok(idsOf(res).includes(M06), "the boundary instant is inclusive, as unread counts are");
  });

  it("flag ON: THE OTHER HALF — the founding member's NULL bound is UNBOUNDED, not zero", async () => {
    const c = use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, ALICE);
    assert.equal(idsOf(res).length, 9, "a NULL visible_from_at must not hide a member's own history");
    assert.deepEqual(
      messageGtes(c), [],
      "an unbounded member's read must carry no lower bound at all",
    );
  });

  it("flag ON: the row with no derivable timestamp (DORA) is RECORDED as unbounded", async () => {
    // RECORDED, not asserted as desirable. visible_from_at NULL means unbounded
    // in every reader, and DORA's row has it NULL because neither joined_at nor
    // 2966's external evidence could supply one. The INSERT trigger COALESCEs
    // to now(), so a row written after 2400 cannot reach this shape — only rows
    // that predate 2400 and have no trip/circle evidence can.
    const c = use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, DORA);
    assert.equal(idsOf(res).length, 9, "an underivable bound reads as unbounded — this is fail-OPEN");
    assert.equal(visibleFromOf({ visible_from_at: null }, true), null);
    assert.deepEqual(messageGtes(c), []);
  });

  it("flag ON: the rejoiner (CARL) is bounded at the REJOIN instant, not the first join", async () => {
    const c = use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, CARL);
    assert.deepEqual(idsOf(res), [M09, M08]);
    assert.ok(messageGtes(c).some((g) => g.val === CARL_REJOIN));
  });

  it("a non-member is refused in BOTH flag states — the bound narrows, it never widens", async () => {
    for (const flag of [false, true]) {
      use({ flag });
      const res = await get(`/threads/${THREAD}/messages`, EVE);
      assert.equal(res.status, 403, `EVE must be refused with the flag ${flag}`);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PATH 2 — PAGINATION. The page-3 leak is the defect this cell exists for.
 * ═════════════════════════════════════════════════════════════════════════*/

describe("§14.3 path 2: paging BACK past the boundary with ?before", () => {
  it("flag OFF: BOB walks the whole thread in five pages of two", async () => {
    const c = use({ flag: false });
    const { pages, all } = await pageAll(BOB, 2);
    assert.deepEqual(pages, [[M09, M08], [M07, M06], [M05, M04], [M03, M02], [M01], []]);
    assert.equal(all.length, 9);
    assertPre2400Shape(c, "paged thread read");
  });

  it("flag ON: the pages STOP at the bound — page 3 is empty, not a leak", async () => {
    use({ flag: true });
    const { pages, all } = await pageAll(BOB, 2);
    assert.deepEqual(pages, [[M09, M08], [M07, M06], []]);
    assert.deepEqual(all, [M09, M08, M07, M06]);
    for (const leaked of [M05, M04, M03, M02, M01]) {
      assert.ok(!all.includes(leaked), `${leaked} is outside BOB's window and was paged into reach`);
    }
  });

  it("flag ON: a cursor handed a value from BEFORE the window returns nothing, not the history behind it", async () => {
    const c = use({ flag: true });
    // The client-supplied cursor is the attack surface: `before` is not
    // validated against the caller's window, so the only thing that can stop it
    // is the `gte` sitting in the same query.
    const res = await get(`/threads/${THREAD}/messages?before=${encodeURIComponent(T03)}`, BOB);
    assert.equal(res.status, 200);
    assert.deepEqual(idsOf(res), [], "a pre-window cursor must yield an empty page, not pre-window rows");
    assert.ok(messageGtes(c).some((g) => g.val === BOB_BOUND));
  });

  it("flag ON: the rejoiner's pages stop at the rejoin instant, two pages in", async () => {
    use({ flag: true });
    const { pages, all } = await pageAll(CARL, 2);
    assert.deepEqual(pages, [[M09, M08], []]);
    assert.deepEqual(all, [M09, M08]);
  });

  it("flag ON: THE OTHER HALF — the founding member still pages through all nine", async () => {
    use({ flag: true });
    const { all } = await pageAll(ALICE, 2);
    assert.deepEqual(all, [M09, M08, M07, M06, M05, M04, M03, M02, M01]);
  });

  it("the route takes NO `after`/cursor parameter, and an invented one is inert rather than widening", async () => {
    // The lane asked for "the cursor and any before/after parameter the route
    // takes". This route takes `before` and `limit` and nothing else
    // (routes/messaging.ts reads only req.query.before and req.query.limit on
    // this handler). An unknown query parameter must not become an escape
    // hatch, so the assertion is that the response is IDENTICAL with and
    // without it — including the case where the invented parameter names an
    // instant far outside the caller's window.
    use({ flag: true });
    const plain = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    const withAfter = await get(
      `/threads/${THREAD}/messages?limit=100&after=${encodeURIComponent(T01)}&cursor=${encodeURIComponent(T01)}`,
      BOB,
    );
    assert.deepEqual(idsOf(withAfter), idsOf(plain));
    assert.deepEqual(idsOf(withAfter), [M09, M08, M07, M06]);
  });

  it("flag ON: a limit large enough for the whole thread still yields only the window", async () => {
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    assert.deepEqual(idsOf(res), [M09, M08, M07, M06]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PATH 3 — §21 SEARCH. A message findable by its text is a message retrieved.
 * ═════════════════════════════════════════════════════════════════════════*/

describe("§14.3 path 3: §21 search (GET /telegraph/search, /threads/:id/search, /threads/:id/ask)", () => {
  it("the token is genuinely in three messages — otherwise every deny below is vacuous", () => {
    const bodies = store().messages
      .filter((m: any) => String(m.body).includes(TOKEN))
      .map((m: any) => String(m.id));
    assert.deepEqual([...bodies].sort(), [M02, M04, M08].sort());
  });

  it("flag OFF: global search finds all three, and the membership query does not name the column", async () => {
    const c = use({ flag: false });
    const res = await get(`/telegraph/search?q=${TOKEN}`, BOB);
    assert.equal(res.status, 200);
    assert.deepEqual(hitIds(res).sort(), [M02, M04, M08].sort());
    assertPre2400Shape(c, "global search");
  });

  it("flag ON: a message outside BOB's window is NOT findable by its text", async () => {
    const c = use({ flag: true });
    const res = await get(`/telegraph/search?q=${TOKEN}`, BOB);
    assert.equal(res.status, 200);
    assert.deepEqual(hitIds(res), [M08]);
    assert.ok(!hitIds(res).includes(M04), "the pre-window secret was retrievable through search");
    assert.ok(
      messageGtes(c).some((g) => g.val === BOB_BOUND),
      "§21 requires access filtering BEFORE retrieval — the bound must be in the query",
    );
  });

  it("flag ON: the snippet of a pre-window message never reaches the response body", async () => {
    use({ flag: true });
    const res = await get(`/telegraph/search?q=${TOKEN}`, BOB);
    assert.ok(
      !JSON.stringify(res.body).includes("padlock"),
      "a snippet is the message body by another name",
    );
  });

  it("flag ON: THE OTHER HALF — the founding member still finds all three", async () => {
    use({ flag: true });
    const res = await get(`/telegraph/search?q=${TOKEN}`, ALICE);
    assert.deepEqual(hitIds(res).sort(), [M02, M04, M08].sort());
  });

  it("flag ON: the underivable-bound row (DORA) searches unbounded — recorded, as above", async () => {
    use({ flag: true });
    const res = await get(`/telegraph/search?q=${TOKEN}`, DORA);
    assert.deepEqual(hitIds(res).sort(), [M02, M04, M08].sort());
  });

  it("flag ON: the thread-scoped search is bounded too, and does not become a 403 oracle", async () => {
    use({ flag: true });
    const bob = await get(`/threads/${THREAD}/search?q=${TOKEN}`, BOB);
    assert.equal(bob.status, 200);
    assert.deepEqual(hitIds(bob), [M08]);

    const eve = await get(`/threads/${THREAD}/search?q=${TOKEN}`, EVE);
    assert.equal(eve.status, 200, "a non-member gets an empty 200, never a thread-existence oracle");
    assert.deepEqual(hitIds(eve), []);
  });

  it("flag ON: 'ask this conversation' answers from the window only", async () => {
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/ask?q=${TOKEN}`, BOB);
    assert.equal(res.status, 200);
    const all = [...(res.body.structured ?? []), ...(res.body.prose ?? [])] as any[];
    assert.deepEqual(all.map((h) => String(h.messageId)), [M08]);
    assert.ok(!JSON.stringify(res.body).includes("padlock"));
  });

  it("flag ON: search reports the bounded split rather than collapsing it", async () => {
    use({ flag: true });
    const res = await get(`/telegraph/search?q=${TOKEN}`, BOB);
    assert.equal(res.body.conversationsSearched, 1);
    assert.equal(res.body.conversationsBounded, 1);
    const alice = await get(`/telegraph/search?q=${TOKEN}`, ALICE);
    assert.equal(alice.body.conversationsBounded, 0, "an unbounded member has no bounded conversations");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PATH 4 — ATTACHMENTS. lib/mediaAccess.ts branch 3c, the bytes.
 * ═════════════════════════════════════════════════════════════════════════*/

describe("§14.3 path 4: a pre-window message must yield no fetchable mediaUrl", () => {
  it("the fixture's keys are real URLs — otherwise branch 3c matches nothing and every deny is vacuous", () => {
    assert.ok(pub(PRE_KEY).endsWith(`/storage/v1/object/public/post-media/${PRE_KEY}`));
    assert.notEqual(pub(PRE_KEY), pub(IN_KEY));
  });

  it("flag OFF: every member can fetch both objects and no membership select names the column", async () => {
    for (const who of [BOB, CARL, DORA]) {
      const c = use({ flag: false });
      assert.equal(await authorizeMediaAccess(c as any, who, "post-media", PRE_KEY), true, `${who} OFF`);
      for (const sel of memberSelects(c)) {
        assert.ok(!sel.includes("visible_from_at"), `media door OFF named the column: ${sel}`);
      }
    }
  });

  it("flag ON: BOB is refused the BYTES of the pre-window message", async () => {
    const c = use({ flag: true });
    assert.equal(await authorizeMediaAccess(c as any, BOB, "post-media", PRE_KEY), false);
    assert.ok(memberSelects(c).some((s) => s.includes("visible_from_at")));
  });

  it("flag ON: the rejoiner is refused the bytes of a message sent between their two stints", async () => {
    const c = use({ flag: true });
    assert.equal(await authorizeMediaAccess(c as any, CARL, "post-media", PRE_KEY), false);
  });

  it("flag ON: THE OTHER HALF — both bounded members still get the in-window object", async () => {
    for (const who of [BOB, CARL]) {
      const c = use({ flag: true });
      assert.equal(
        await authorizeMediaAccess(c as any, who, "post-media", IN_KEY), true,
        `${who} must keep the media of the conversation they are actually in`,
      );
    }
  });

  it("flag ON: the NULL-bound row (DORA) keeps the pre-window object", async () => {
    const c = use({ flag: true });
    assert.equal(
      await authorizeMediaAccess(c as any, DORA, "post-media", PRE_KEY), true,
      "NULL is unbounded at the media door too",
    );
  });

  it("a non-member is refused both objects in both flag states", async () => {
    for (const flag of [false, true]) {
      for (const key of [PRE_KEY, IN_KEY]) {
        const c = use({ flag });
        assert.equal(await authorizeMediaAccess(c as any, EVE, "post-media", key), false);
      }
    }
  });

  it("flag ON: the thread read itself hands BOB no mediaUrl for the pre-window message", async () => {
    // The byte authorizer is the lock; the route is the key ring. A route that
    // still SHIPPED the URL would leave the object one unauthenticated CDN
    // quirk away, so both are asserted.
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    const urls = ((res.body.messages ?? []) as any[]).map((m) => m.mediaUrl).filter(Boolean);
    assert.ok(!urls.includes(pub(PRE_KEY)), "the pre-window object's URL was handed out by the thread read");
    assert.ok(urls.includes(pub(IN_KEY)), "the in-window object's URL must still be delivered");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PATH 5 — THE QUOTE. A quoted body is retrieval by another name.
 * ═════════════════════════════════════════════════════════════════════════*/

describe("§14.3 path 5: quoted-reply context (routes/messaging replyToIdMap)", () => {
  it("M07 really does reply to M04 — otherwise the quote cases prove nothing", () => {
    const m07 = store().messages.find((m: any) => m.id === M07);
    assert.equal(m07?.reply_to_id, M04);
  });

  it("flag OFF: BOB reads M07 WITH the quoted pre-window body, exactly as before 2400", async () => {
    const c = use({ flag: false });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    const m07 = ((res.body.messages ?? []) as any[]).find((m) => m.id === M07);
    assert.equal(m07.replyToId, M04);
    assert.equal(m07.replyToBody, SECRET_BODY);
    assertPre2400Shape(c, "quoted context");
  });

  it("flag ON: the quote does not hand BOB the pre-window body, and does not lie about the link", async () => {
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    const m07 = ((res.body.messages ?? []) as any[]).find((m) => m.id === M07);
    assert.equal(m07.replyToId, M04, "the linkage is a real, readable fact and stays");
    assert.equal(m07.replyToBody, null, "a quoted pre-window body is the same disclosure by another door");
    assert.equal(m07.replyToSenderName, null);
    assert.ok(
      !JSON.stringify(res.body).includes("padlock"),
      "the pre-window body must not appear anywhere in the payload",
    );
  });

  it("flag ON: `null` quote stays distinguishable from a FAILED quote read", async () => {
    // A null body is a real state (outside the window, or deleted). An
    // unreadable quote read is a different state and carries replyContext:
    // 'unavailable'. Collapsing the two would make the bound indistinguishable
    // from an outage.
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    const m07 = ((res.body.messages ?? []) as any[]).find((m) => m.id === M07);
    assert.equal(m07.replyContext, undefined, "a bounded quote is not an unavailable quote");
  });

  it("flag ON: THE OTHER HALF — the founding member still sees the quoted body", async () => {
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, ALICE);
    const m07 = ((res.body.messages ?? []) as any[]).find((m) => m.id === M07);
    assert.equal(m07.replyToBody, SECRET_BODY, "bounding history must not blank an entitled member's quotes");
  });

  it("flag ON: the rejoiner cannot reach M04's body through M07 either — M07 is outside their window too", async () => {
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, CARL);
    assert.deepEqual(idsOf(res), [M09, M08]);
    assert.ok(!JSON.stringify(res.body).includes("padlock"));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MEMBER'S OWN MESSAGES — the half that makes this a privacy feature
 * rather than a data-loss bug.
 * ═════════════════════════════════════════════════════════════════════════*/

describe("§14.3: a member's OWN messages", () => {
  it("BOB's own message is inside his window on every path — the production measurement holds here too", async () => {
    use({ flag: true });
    const read = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    assert.ok(idsOf(read).includes(M09), "BOB's own message must survive the bound in the thread read");

    const paged = await pageAll(BOB, 2);
    assert.ok(paged.all.includes(M09), "and must survive it through pagination");

    use({ flag: true });
    const found = await get(`/telegraph/search?q=own%20words`, BOB);
    assert.deepEqual(hitIds(found), [M09], "and must stay findable by its own text");
  });

  it("no member added forward of 2400 can have an own message outside their window", () => {
    // 2400's INSERT branch is COALESCE(visible_from_at, joined_at, now()), so a
    // window opens at or before the member's first possible message. BOB,
    // ALICE and DORA are all clean under migration 2966's postcondition 3.
    const db = store();
    assert.deepEqual(ownMessagesOutsideWindow(db, BOB), []);
    assert.deepEqual(ownMessagesOutsideWindow(db, ALICE), []);
    assert.deepEqual(ownMessagesOutsideWindow(db, DORA), []);
  });

  it("FINDING — REJOIN hides the rejoiner's OWN first-stint message, the shape 2966 aborts on", async () => {
    // ── This is the defect, stated as the assertion that it is true. ────────
    // Migration 2966 POSTCONDITION 3 raises rather than ship a (member, own
    // message) pair where the message predates the window, and its backfill
    // clamps every derived window to LEAST(..., first own message). The
    // TRIGGER's rejoin branch has no such clamp: left_at NOT NULL -> NULL sets
    // visible_from_at := now(), and the rejoiner's own earlier messages fall
    // outside it. The production "0 own-messages hidden" measurement is a
    // property of the backfill, not one the trigger maintains going forward.
    const db = store();
    assert.deepEqual(
      ownMessagesOutsideWindow(db, CARL), [M02],
      "CARL's own first-stint message sits before his rejoin window — 2966 would have refused this row",
    );

    // And it is not theoretical: the route enforces it.
    use({ flag: true });
    const res = await get(`/threads/${THREAD}/messages?limit=100`, CARL);
    assert.ok(
      !idsOf(res).includes(M02),
      "recorded: after a rejoin, the member cannot read back the message they themselves sent",
    );

    use({ flag: true });
    const found = await get(`/telegraph/search?q=${TOKEN}`, CARL);
    assert.deepEqual(hitIds(found), [M08], "recorded: nor can they find it by its text");
  });

  it("the predicate itself is honest — it finds nothing when the window predates the message", () => {
    const db = store();
    const row = (db["message_thread_members"] as any[]).find((m) => m.user_id === CARL);
    assert.ok(row, "the fixture must carry CARL's row for this to mean anything");
    row.visible_from_at = T01;
    assert.deepEqual(ownMessagesOutsideWindow(db, CARL), []);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * LEAVE AND REJOIN — the row lifecycle 2400/2966 describe.
 * ═════════════════════════════════════════════════════════════════════════*/

describe("§14.3: leave and rejoin", () => {
  it("2400's rejoin branch opens a NEW window rather than restoring the old one", () => {
    // Asserted against the migration text, because the behaviour is the
    // trigger's and no fixture can execute plpgsql. The read-side consequence
    // is asserted through the routes above.
    const sql = readMigration("2400_telegraph_history_bound.sql");
    assert.ok(
      /IF OLD\.left_at IS NOT NULL AND NEW\.left_at IS NULL THEN/.test(sql),
      "the rejoin branch must key off left_at NOT NULL -> NULL",
    );
    assert.ok(
      /NEW\.visible_from_at := now\(\);/.test(sql),
      "and must open the window at the rejoin instant",
    );
  });

  it("2966 refuses to let an UPDATE clear a live window back to unbounded", () => {
    const sql = readMigration("2966_telegraph_history_bound_close.sql");
    assert.ok(
      /OLD\.visible_from_at IS NOT NULL AND NEW\.visible_from_at IS NULL/.test(sql),
      "clearing a window to NULL is the one direction that only ever widens access",
    );
    assert.ok(
      /NEW\.visible_from_at := OLD\.visible_from_at;/.test(sql),
      "and the old window must be put back rather than merely refused",
    );
  });

  it("a member who has LEFT is refused on every path, bound or not", async () => {
    for (const flag of [false, true]) {
      const c = use({ flag });
      (c._store["message_thread_members"] as any[])
        .filter((m) => m.user_id === CARL)
        .forEach((m) => { m.left_at = T09; });

      const read = await get(`/threads/${THREAD}/messages`, CARL);
      assert.equal(read.status, 403, `departed member, flag ${flag}: thread read`);

      const found = await get(`/telegraph/search?q=${TOKEN}`, CARL);
      assert.equal(found.status, 200);
      assert.deepEqual(hitIds(found), [], `departed member, flag ${flag}: search`);

      _clearMediaAccessCache();
      assert.equal(
        await authorizeMediaAccess(c as any, CARL, "post-media", IN_KEY), false,
        `departed member, flag ${flag}: media`,
      );
    }
  });

  it("the rejoined row is the SAME row — left_at cleared, and the window is the rejoin instant", () => {
    const row = (store().message_thread_members as any[]).find((m) => m.user_id === CARL);
    assert.equal(row.left_at, null, "the row is kept on leave and reused on rejoin");
    assert.equal(row.joined_at, "2026-01-08T00:00:00.000Z", "joined_at still records the FIRST stint");
    assert.equal(row.visible_from_at, CARL_REJOIN, "so joined_at and the window disagree, by design");
    assert.ok(Date.parse(row.visible_from_at) > Date.parse(row.joined_at));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FLAG ITSELF
 * ═════════════════════════════════════════════════════════════════════════*/

describe("§14.3: an unreadable flag leaves history exactly as unbounded as it is today", () => {
  it("every path stays wide when feature_flags cannot be read", async () => {
    const c = makeFakeClient(store({ flag: true }), {
      errors: { feature_flags: { message: "flags are down", code: "XX000" } },
    });
    _resetRateLimit();
    _clearMediaAccessCache();
    _setTestClient(c as any, true);

    const read = await get(`/threads/${THREAD}/messages?limit=100`, BOB);
    assert.equal(idsOf(read).length, 9, "a database blip must not hide messages from every member");

    const found = await get(`/telegraph/search?q=${TOKEN}`, BOB);
    assert.deepEqual(hitIds(found).sort(), [M02, M04, M08].sort());

    assert.equal(await authorizeMediaAccess(c as any, BOB, "post-media", PRE_KEY), true);
  });
});

/* ───────────────────────── the pure predicate, once ─────────────────────── */

describe("§14.3: withinWindow, the one predicate every path shares", () => {
  it("a NULL bound admits everything, including a message with no timestamp", () => {
    assert.equal(withinWindow(T01, null), true);
    assert.equal(withinWindow(null, null), true);
  });

  it("the boundary instant is INSIDE the window", () => {
    assert.equal(withinWindow(BOB_BOUND, BOB_BOUND), true);
    assert.equal(withinWindow(T05, BOB_BOUND), false);
    assert.equal(withinWindow(T07, BOB_BOUND), true);
  });

  it("instants, not strings — the two spellings of one instant rank the same", () => {
    assert.equal(withinWindow("2026-03-01T00:00:00+00:00", "2026-03-01T00:00:00.000Z"), true);
  });

  it("an unparseable timestamp falls OUTSIDE the window, never inside it", () => {
    assert.equal(withinWindow("not-a-date", BOB_BOUND), false);
    assert.equal(withinWindow(T07, "not-a-date"), false);
    assert.equal(withinWindow(undefined, BOB_BOUND), false);
  });
});
