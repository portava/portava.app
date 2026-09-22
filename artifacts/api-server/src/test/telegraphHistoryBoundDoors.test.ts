/**
 * Telegraph §14.3 group history bounds — THE OTHER DOORS.
 *
 * src/test/telegraphHistoryBound.test.ts proves the bound on the four readers
 * migration 2400's flag description names: the thread read (and its quoted-reply
 * context), the inbox preview and unread count, the unread badge and the saved
 * messages projection. This file is about the paths that reach the SAME
 * messages without going through any of them, because a bound applied to the
 * text reader and not to these is not a bound:
 *
 *   ATTACHMENTS / MEDIA  lib/mediaAccess.ts branch 3c serves the BYTES of a
 *                        message's media out of a PRIVATE bucket, and its whole
 *                        test was "is this viewer in the thread" — which is
 *                        exactly what syncTripChatMembers makes true for the
 *                        newly added member 2400 exists because of.
 *   RECONNECT / REALTIME routes/telegraphStream.ts replays `message.created`
 *                        frames from a CLIENT-SUPPLIED cursor. The frames carry
 *                        no body, but they carry the id, the sender and the
 *                        timestamp of every message in the window — the
 *                        existence and authorship of pre-membership messages,
 *                        and a handle for every other read.
 *   GROUP CHAT READ      routes/groupChat.ts fetchMessagesForThread returns
 *                        whole message BODIES for a trip or circle thread. Both
 *                        of its routes are currently shadowed by
 *                        routes/messaging.ts (registered first in
 *                        routes/index.ts), which is a mount ORDER, not a
 *                        guarantee.
 *
 * BOTH HALVES ARE ASSERTED EVERYWHERE, and that is the point of the file: every
 * door has a case proving the newly added member is refused AND a case proving
 * a member who is entitled to the same bytes/frames/rows still gets them. A
 * suite that only proved the first would pass if the feature were broken
 * outright.
 *
 * The flag polarity is asserted too: OFF (the production seed) every path is
 * byte-identical to today and the membership select does not even NAME
 * visible_from_at, so a build carrying this code is safe against a database
 * that has not run 2400.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphHistoryBoundDoors.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { authorizeMediaAccess, publicUrlFor, _clearMediaAccessCache } from "../lib/mediaAccess.js";
import telegraphStreamRouter from "../routes/telegraphStream.js";
import groupChatRouter from "../routes/groupChat.js";
import {
  makeFakeClient,
  startRouter,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // founding member, unbounded
const BOB   = "bbbbbbbb-0000-4000-8000-000000000002"; // added later, bounded at BOUND
const CARA  = "cccccccc-0000-4000-8000-000000000003"; // not in the thread at all

const THREAD = "00000000-0000-4000-8000-00000000000a";
const TRIP   = "33333333-0000-4000-8000-000000000003";

const BOUND = "2026-03-01T00:00:00.000Z";
const BEFORE = "2026-02-01T00:00:00.000Z"; // outside Bob's window
const AFTER  = "2026-03-10T00:00:00.000Z"; // inside Bob's window

const OLD_MSG = "11111111-0000-4000-8000-000000000001";
const NEW_MSG = "22222222-0000-4000-8000-000000000002";

/** Alice's storage keys. `post-media` is a PRIVATE bucket; these are the bytes. */
const OLD_KEY = `${ALICE}/before-bob.jpg`;
const NEW_KEY = `${ALICE}/after-bob.jpg`;

/**
 * The message's stored media URL, built by the SAME helper mediaAccess uses to
 * recognise it. Deliberately not spelled out from the environment here:
 * `scripts/check-guard-coverage.mjs` treats a file that NAMES a Supabase
 * credential variable as one that can reach a database and requires it to
 * import the CI guard, and this suite reaches nothing — it hands
 * authorizeMediaAccess a fake client. Going through `publicUrlFor` keeps the
 * two spellings of the URL in one place as well.
 */
const pub = (key: string) => publicUrlFor("post-media", key) ?? "";

interface Fixture {
  /** null → no feature_flags row at all (production today). */
  flag?: boolean | null;
  /** Bob's bound. Defaults to BOUND; null models a pre-2400 / granted row. */
  bobVisibleFrom?: string | null;
  bobLeftAt?: string | null;
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
    trips: [{ id: TRIP, title: "Lisbon", destination_city: "Lisbon", created_by: ALICE, owner_id: ALICE }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, status: "accepted", role: "owner" },
      { trip_id: TRIP, user_id: BOB, status: "accepted", role: "member" },
    ],
    circle_member_visibility_overrides: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", account_status: null },
      { id: BOB, handle: "bob", name: "Bob", account_status: null },
      { id: CARA, handle: "cara", name: "Cara", account_status: null },
    ],
    message_threads: [
      { id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "T",
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: AFTER, last_message_at: AFTER },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, role: "member", joined_at: BOUND,
        left_at: f.bobLeftAt ?? null, last_read_at: null, muted_at: null, archived_at: null,
        visible_from_at: f.bobVisibleFrom === undefined ? BOUND : f.bobVisibleFrom },
    ],
    messages: [
      { id: OLD_MSG, thread_id: THREAD, sender_id: ALICE, body: "before Bob", created_at: BEFORE,
        deleted_at: null, edited_at: null, original_language: null, msg_type: "media", subtype: null,
        media_url: pub(OLD_KEY), media_thumbnail_url: null, media_type: "image",
        media_duration_seconds: null, reply_to_id: null },
      { id: NEW_MSG, thread_id: THREAD, sender_id: ALICE, body: "after Bob", created_at: AFTER,
        deleted_at: null, edited_at: null, original_language: null, msg_type: "media", subtype: null,
        media_url: pub(NEW_KEY), media_thumbnail_url: null, media_type: "image",
        media_duration_seconds: null, reply_to_id: null },
    ],
    message_translations: [],
  };
}

function use(f: Fixture = {}): FakeClient {
  _resetRateLimit();
  _clearMediaAccessCache();
  const c = makeFakeClient(store(f));
  _setTestClient(c, true);
  return c;
}

/** Every membership select this client observed, as the code spelled it. */
const memberSelects = (c: FakeClient) =>
  c._observed.selects.filter((s) => s.table === "message_thread_members").map((s) => s.sel);

/* ══════════════════════════════════════════════════════════════════════════════
 * DOOR 1 — the attachment. lib/mediaAccess.ts branch 3c.
 * ════════════════════════════════════════════════════════════════════════════*/

describe("§14.3 door 1: message media bytes (lib/mediaAccess 3c)", () => {
  beforeEach(() => { _clearMediaAccessCache(); });

  it("the fixture's media URLs are real — otherwise every case below would pass by matching nothing", () => {
    assert.ok(
      pub(OLD_KEY).endsWith(`/storage/v1/object/public/post-media/${OLD_KEY}`),
      "publicUrlFor returned nothing, so branch 3c would never find the message and every deny below would be vacuous",
    );
    assert.notEqual(pub(OLD_KEY), pub(NEW_KEY));
  });

  it("flag OFF (the production seed): the new member still gets the old message's bytes, and the column is never named", async () => {
    const c = use({ flag: false });
    assert.equal(await authorizeMediaAccess(c as any, BOB, "post-media", OLD_KEY), true);
    for (const sel of memberSelects(c)) {
      assert.ok(!sel.includes("visible_from_at"), `OFF must not name the column: ${sel}`);
    }
  });

  it("flag ABSENT (no row at all, which is production today): identical to OFF", async () => {
    const c = use({ flag: null });
    assert.equal(await authorizeMediaAccess(c as any, BOB, "post-media", OLD_KEY), true);
    for (const sel of memberSelects(c)) {
      assert.ok(!sel.includes("visible_from_at"), `absent flag must not name the column: ${sel}`);
    }
  });

  it("flag ON: the newly added member is REFUSED the bytes of a message sent before they joined", async () => {
    const c = use({ flag: true });
    assert.equal(
      await authorizeMediaAccess(c as any, BOB, "post-media", OLD_KEY), false,
      "a media URL reachable without the bound is the same disclosure through another door",
    );
    assert.ok(
      memberSelects(c).some((s) => s.includes("visible_from_at")),
      "ON must read the bound, not assume it",
    );
  });

  it("flag ON: THE OTHER HALF — the same member still gets the bytes of a message sent AFTER they joined", async () => {
    const c = use({ flag: true });
    assert.equal(
      await authorizeMediaAccess(c as any, BOB, "post-media", NEW_KEY), true,
      "bounding history must not take away the media of the conversation the member is actually in",
    );
  });

  it("flag ON: THE OTHER HALF — a member with a NULL bound still gets the old message's bytes", async () => {
    // Alice OWNS OLD_KEY by path prefix, so branch 3c never decides for her.
    // The unbounded case is therefore proved on a member whose row carries
    // visible_from_at NULL — the shape EVERY pre-2400 membership has, and the
    // shape a §14.1 canViewPreMembershipHistory grant would have.
    const c = use({ flag: true, bobVisibleFrom: null });
    assert.equal(
      await authorizeMediaAccess(c as any, BOB, "post-media", OLD_KEY), true,
      "a NULL visible_from_at is UNBOUNDED even when the flag is ON",
    );
  });

  it("flag ON: a non-member is refused either way — the bound narrows access, it never widens it", async () => {
    const c = use({ flag: true });
    assert.equal(await authorizeMediaAccess(c as any, CARA, "post-media", NEW_KEY), false);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(c as any, CARA, "post-media", OLD_KEY), false);
  });

  it("flag ON: a member who has LEFT is refused, as before — membership is still the first gate", async () => {
    const c = use({ flag: true, bobLeftAt: AFTER });
    assert.equal(await authorizeMediaAccess(c as any, BOB, "post-media", NEW_KEY), false);
  });

  it("an UNREADABLE feature_flags leaves the bytes exactly as reachable as they are today", async () => {
    _resetRateLimit();
    _clearMediaAccessCache();
    const c = makeFakeClient(store({ flag: true }), {
      errors: { feature_flags: { message: "flags are down", code: "XX000" } },
    });
    _setTestClient(c, true);
    assert.equal(
      await authorizeMediaAccess(c as any, BOB, "post-media", OLD_KEY), true,
      "isFlagEnabled is FALSE ON ERROR: a database blip must not blank every member's thread photos",
    );
  });

  it("an UNREADABLE message_thread_members still DENIES — this file's own posture is unchanged", async () => {
    _resetRateLimit();
    _clearMediaAccessCache();
    const c = makeFakeClient(store({ flag: true }), {
      errors: { message_thread_members: { message: "membership is down", code: "XX000" } },
    });
    _setTestClient(c, true);
    assert.equal(await authorizeMediaAccess(c as any, BOB, "post-media", NEW_KEY), false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * DOOR 2 — the reconnect replay. routes/telegraphStream.ts.
 * ════════════════════════════════════════════════════════════════════════════*/

let streamHarness: RouterHarness;
before(async () => { streamHarness = await startRouter(telegraphStreamRouter); });
after(async () => { await streamHarness.close(); });
beforeEach(() => { resetFakeIds(); _resetRateLimit(); });

/**
 * Open the SSE stream with a resume cursor, read until `stream.resumed` lands,
 * then abort. The socket is long-lived by design, so the read has to stop on a
 * frame rather than on end-of-body.
 */
async function resume(cursorIso: string, asUser: string): Promise<{
  replayedIds: string[];
  outcome: any;
}> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(
      `${streamHarness.base}/telegraph/stream?token=${encodeURIComponent(asUser)}`,
      { headers: { "last-event-id": cursorIso }, signal: ac.signal },
    );
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let outcome: any = null;
    const replayedIds: string[] = [];
    while (outcome === null) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const frame of buf.split("\n\n")) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let payload: any;
        try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (payload?.type === "message.created" && payload?.payload?.messageId) {
          if (!replayedIds.includes(payload.payload.messageId)) replayedIds.push(payload.payload.messageId);
        }
        if (payload?.type === "stream.resumed") outcome = payload;
      }
    }
    return { replayedIds, outcome };
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

/**
 * A cursor inside the stream's 24h acceptance window that is nevertheless
 * EARLIER than Bob's §14.3 bound. Built from now() because parseCursor refuses
 * anything older than 24 hours, and the fixture's timestamps are fixed dates —
 * so the fixture messages are re-dated relative to now for this door.
 */
function recentStore(f: Fixture, oldOffsetMs: number, newOffsetMs: number): Record<string, any[]> {
  const s = store(f);
  const now = Date.now();
  const oldAt = new Date(now - oldOffsetMs).toISOString();
  const newAt = new Date(now - newOffsetMs).toISOString();
  const bound = new Date(now - (oldOffsetMs + newOffsetMs) / 2).toISOString();
  (s.messages[0] as any).created_at = oldAt;
  (s.messages[1] as any).created_at = newAt;
  const bobRow = s.message_thread_members.find((m: any) => m.user_id === BOB) as any;
  if (f.bobVisibleFrom === undefined) bobRow.visible_from_at = bound;
  return s;
}

describe("§14.3 door 2: reconnect replay (routes/telegraphStream)", () => {
  const SIX_H = 6 * 60 * 60 * 1000;
  const ONE_H = 60 * 60 * 1000;
  const CURSOR_MS = 12 * 60 * 60 * 1000; // 12h ago: inside the 24h window, before both

  it("flag OFF: the replay carries the pre-membership message, and the column is never named", async () => {
    _resetRateLimit();
    const c = makeFakeClient(recentStore({ flag: false }, SIX_H, ONE_H));
    _setTestClient(c, true);
    const { replayedIds, outcome } = await resume(new Date(Date.now() - CURSOR_MS).toISOString(), BOB);
    assert.equal(outcome.resumed, true);
    assert.deepEqual(replayedIds.sort(), [OLD_MSG, NEW_MSG].sort());
    for (const sel of memberSelects(c)) {
      assert.ok(!sel.includes("visible_from_at"), `OFF must not name the column: ${sel}`);
    }
  });

  it("flag ON: a cursor older than the member's window cannot replay what is outside it", async () => {
    _resetRateLimit();
    const c = makeFakeClient(recentStore({ flag: true }, SIX_H, ONE_H));
    _setTestClient(c, true);
    const { replayedIds, outcome } = await resume(new Date(Date.now() - CURSOR_MS).toISOString(), BOB);
    assert.equal(outcome.resumed, true, "the resume still succeeds — it is narrower, not broken");
    assert.deepEqual(
      replayedIds, [NEW_MSG],
      "the cursor is the CLIENT's and the bound is not: a member added an hour ago must not be replayed yesterday",
    );
  });

  it("flag ON: THE OTHER HALF — the founding member's replay is unchanged", async () => {
    _resetRateLimit();
    const c = makeFakeClient(recentStore({ flag: true }, SIX_H, ONE_H));
    _setTestClient(c, true);
    // Alice sent both messages, and a member's own sends are never replayed to
    // them, so her unbounded window is proved on Bob's rows instead: a member
    // with a NULL bound and the same cursor gets everything.
    const c2 = makeFakeClient(recentStore({ flag: true, bobVisibleFrom: null }, SIX_H, ONE_H));
    _setTestClient(c2, true);
    const { replayedIds } = await resume(new Date(Date.now() - CURSOR_MS).toISOString(), BOB);
    assert.deepEqual(replayedIds.sort(), [OLD_MSG, NEW_MSG].sort());
  });

  it("an UNREADABLE feature_flags leaves the replay exactly as wide as it is today", async () => {
    _resetRateLimit();
    const c = makeFakeClient(recentStore({ flag: true }, SIX_H, ONE_H), {
      errors: { feature_flags: { message: "flags are down", code: "XX000" } },
    });
    _setTestClient(c, true);
    const { replayedIds } = await resume(new Date(Date.now() - CURSOR_MS).toISOString(), BOB);
    assert.deepEqual(replayedIds.sort(), [OLD_MSG, NEW_MSG].sort());
  });

  it("an UNREADABLE roster resumes NOTHING and tells the client to poll — unchanged", async () => {
    _resetRateLimit();
    const c = makeFakeClient(recentStore({ flag: true }, SIX_H, ONE_H), {
      errors: { message_thread_members: { message: "roster is down", code: "XX000" } },
    });
    _setTestClient(c, true);
    const { replayedIds, outcome } = await resume(new Date(Date.now() - CURSOR_MS).toISOString(), BOB);
    assert.deepEqual(replayedIds, []);
    assert.equal(outcome.resumed, false);
    assert.equal(outcome.reason, "read_failed");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * THE MIGRATION'S OWN RULINGS, as a contract over 2966's text.
 *
 * These three decisions are the ones a later "simplification" would undo, and
 * none of them is observable from TypeScript: the backfill source, the
 * data-integrity postcondition, and the trigger's refusal to let an UPDATE
 * clear a live window. The DATABASE behaviour behind each was rehearsed against
 * the CI project (hwokxgbmezheskbzskfr) in rolled-back transactions on
 * 2026-09-22; what is asserted here is that the committed file still says it.
 * ════════════════════════════════════════════════════════════════════════════*/

describe("§14.3 — migration 2966 keeps its three rulings", () => {
  const raw = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../migrations/2966_telegraph_history_bound_close.sql"),
    "utf8",
  );
  /**
   * The EXECUTABLE text only. The header argues at length about the backfill
   * source it refuses and about the flag flip being a separate step, so a
   * search over the whole file would find the very strings these cases assert
   * are absent — and would keep passing if the refused statement were then
   * written for real. Comments are evidence about the decision; they are not
   * the decision.
   */
  const sql = raw
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");

  it("RULING 1 — the backfill reads sync-independent evidence, never joined_at alone", () => {
    assert.ok(
      /LEAST\(tm_created, tm_joined, cm_created, mtm_joined, own_first\)/.test(sql),
      "the bound must be the EARLIEST evidence, so a restamped message_thread_members.joined_at can never narrow a window",
    );
    assert.ok(
      /WHERE tm_created IS NOT NULL OR tm_joined IS NOT NULL OR cm_created IS NOT NULL/.test(sql),
      "a row with no EXTERNAL membership evidence must be left NULL (unbounded), never given a guessed timestamp",
    );
    assert.ok(
      !/SET\s+visible_from_at\s*=\s*joined_at/i.test(sql),
      "a straight joined_at backfill is the refused one: production shows up to 2d06h of sync restamp drift on that column",
    );
  });

  it("RULING 2 — the data-integrity postcondition aborts rather than hides a member's own history", () => {
    assert.ok(
      /msg\.sender_id = m\.user_id[\s\S]{0,200}msg\.created_at < m\.visible_from_at/.test(sql),
      "the postcondition must compare each member's OWN messages against their own window",
    );
    assert.ok(
      /RAISE EXCEPTION 'POSTCONDITION FAILED: % \(member, own message\) pair/.test(sql),
      "it must ABORT, not warn — a retroactive hide that ships is not recoverable by rolling the file back",
    );
  });

  it("RULING 3 — an UPDATE cannot clear a live window back to unbounded", () => {
    assert.ok(
      /IF OLD\.visible_from_at IS NOT NULL AND NEW\.visible_from_at IS NULL THEN\s*\n\s*NEW\.visible_from_at := OLD\.visible_from_at;/.test(sql),
      "the only blocked direction is the one that widens access; an earlier timestamp (a §14.1 grant) is still accepted",
    );
    assert.ok(
      /OLD\.left_at IS NOT NULL AND NEW\.left_at IS NULL/.test(sql),
      "the rejoin rule must survive: a returning member gets a NEW interval, not the old window back",
    );
  });

  it("the flag is left OFF — this migration writes data, it does not turn the read on", () => {
    assert.ok(
      !/toggle_feature_flag_with_audit|UPDATE\s+public\.feature_flags/i.test(sql),
      "the apply is the safe half and the flip is the reviewed half; they are two steps",
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * DOOR 3 — the group-chat read. routes/groupChat.ts fetchMessagesForThread.
 *
 * SHADOWED, AND BOUND ANYWAY. routes/index.ts registers messagingRouter (:201)
 * before groupChatRouter (:204), and routes/messaging.ts serves both
 * `GET /trips/:tripId/chat` (:3630) and `GET /circles/:circleOwnerId/chat`
 * (:3699), so Express never reaches these handlers on the mounted app. They are
 * mounted ALONE here, which is the only way to reach them — and the reason to
 * bind them is that "unreachable because of a mount order" is one registration
 * away from reachable, for a read that returns whole message bodies.
 * ════════════════════════════════════════════════════════════════════════════*/

let groupChatHarness: RouterHarness;
before(async () => { groupChatHarness = await startRouter(groupChatRouter); });
after(async () => { await groupChatHarness.close(); });

async function tripChat(asUser: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${groupChatHarness.base}/trips/${TRIP}/chat`, {
    headers: { authorization: `Bearer ${asUser}` },
  });
  const text = await r.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

const bodyIds = (r: { body: any }) => ((r.body?.messages ?? []) as any[]).map((m) => m.id).sort();

describe("§14.3 door 3: the group-chat thread read (routes/groupChat)", () => {
  it("flag OFF: the new member reads the whole history and the column is never named", async () => {
    const c = use({ flag: false });
    const r = await tripChat(BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(bodyIds(r), [OLD_MSG, NEW_MSG].sort());
    for (const sel of memberSelects(c)) {
      assert.ok(!sel.includes("visible_from_at"), `OFF must not name the column: ${sel}`);
    }
    assert.deepEqual(
      c._observed.gte.filter((g) => g.table === "messages"), [],
      "OFF must apply no lower bound",
    );
    assert.deepEqual(
      c._observed.or.filter((o) => o.table === "messages"), [],
      "and no window or() group either — OFF is byte-identical to pre-2400",
    );
  });

  it("flag ON: the newly added member does not receive the pre-membership message BODY", async () => {
    const c = use({ flag: true });
    const r = await tripChat(BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(bodyIds(r), [NEW_MSG]);
    // The bound is still IN the query — the page limit takes the NEWEST rows,
    // so a filter alone would spend the budget on rows the caller may not see.
    // Its SPELLING changed with owner decision Q6: the window now rides in a
    // two-clause `or=` group, so asserting on a plain `.gte` would silently
    // stop checking anything. Asserted WHOLE, which is stricter: the only
    // thing ORed in beside the bound is `sender_id = <this caller>`.
    assert.ok(
      c._observed.or.some((o) => o.table === "messages"
        && o.expr === `created_at.gte.${BOUND},sender_id.eq.${BOB}`),
      `the bound belongs in the QUERY too — observed ${JSON.stringify(c._observed.or)}`,
    );
    const served = JSON.stringify(r.body);
    assert.ok(!served.includes("before Bob"), "the pre-membership message body must not appear anywhere in the payload");
  });

  it("flag ON: THE OTHER HALF — a member with a NULL bound still reads the whole history", async () => {
    use({ flag: true, bobVisibleFrom: null });
    const r = await tripChat(BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(bodyIds(r), [OLD_MSG, NEW_MSG].sort());
  });

  it("an UNREADABLE feature_flags leaves the read exactly as wide as it is today", async () => {
    _resetRateLimit();
    const c = makeFakeClient(store({ flag: true }), {
      errors: { feature_flags: { message: "flags are down", code: "XX000" } },
    });
    _setTestClient(c, true);
    const r = await tripChat(BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(bodyIds(r), [OLD_MSG, NEW_MSG].sort());
  });
});
