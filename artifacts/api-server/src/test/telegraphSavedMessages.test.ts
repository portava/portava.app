/**
 * Telegraph — the saved-message projection, its prohibitions, and unsave.
 *
 * Spec: §10.2 (explicit save), §14.2 ("read authorization is dynamic"), §14.3
 * (group history bounds), §7.4 (an unsent message leaves projections), §29 (no
 * silent plausible-empty state).
 *
 * THE DECISION THIS FILE PINS
 * ===========================
 * `services/telegraph/savedMessages.ts` decides what happens when a member
 * saves a message and their §14.3 `visible_from_at` LATER MOVES PAST IT — which
 * is what migration 2400's trigger does on a rejoin, because
 * message_thread_members' primary key is (thread_id, user_id) and a rejoin
 * reuses the row. The decision is THE BOUND WINS, and the save is withheld WITH
 * A REASON rather than silently dropped. Three tests hold it down:
 *
 *   - "a save made before the window moved is withheld once it moves"
 *   - "a rejoined member does not read their own pre-departure saves"
 *   - "withholding is named, not silent"
 *
 * If a later change decides the other way, these fail and the header of the
 * module has to be rewritten with the new reason — which is the point.
 *
 * ORDER OF REFUSAL is tested as its own property: a departed member must learn
 * nothing from their saved list about what the sender later did to the message.
 *
 * UNSAVE IS NOT RE-AUTHORIZED, also tested as its own property: the save a
 * caller can no longer read is the one they are most likely to want gone.
 *
 * SHOWN RED before commit (24 pass green), each mutation reverted:
 *   • `authorizeSavedMessage` skipping the `withinWindow` check
 *       -> pass 19 / fail 5 (the three decision tests above, plus "a departed
 *          member learns nothing about the message's fate" and "an unparseable
 *          created_at is OUTSIDE the window")
 *   • `authorizeSavedMessage` judging `deleted_at` BEFORE membership
 *       -> pass 23 / fail 1 ("a departed member learns nothing about the
 *          message's fate")
 *   • `unsaveMessage` reporting a failed delete as `not_saved`
 *       -> pass 22 / fail 2 ("a failed delete is an error, never 'not_saved'",
 *          "a failed delete is a retryable 503, not a success")
 *
 * THAT LAST MUTATION CAUGHT A FALSE GREEN IN THIS FILE, not in the code. The
 * 503 test first injected its database error on EVERY table, so
 * `requireUser`'s own ban-gate read failed and the route answered 503 before
 * reaching the handler — the test passed with the handler mutated. The
 * injection is now scoped to `saved_messages` (see `UnsaveState.errorTable`)
 * and the mutation turns it red.
 *
 * Run: node --import tsx/esm --test src/test/telegraphSavedMessages.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import savedMessagesRouter from "../routes/savedMessages.js";
import {
  SAVED_MESSAGE_SECOND_DOOR_FIELDS,
  assertNoSecondDoor,
  authorizeSavedMessage,
  membershipViewFromRows,
  projectSavedMessage,
  projectSavedMessages,
  unsaveMessage,
  type SavedMessageSource,
} from "../services/telegraph/savedMessages.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";

const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const GONE_THREAD = "dddddddd-0000-4000-8000-00000000000e";

const M_OLD = "11110000-0000-4000-8000-000000000001";
const M_NEW = "11110000-0000-4000-8000-000000000002";
const M_DELETED = "11110000-0000-4000-8000-000000000003";
const M_DEPARTED = "11110000-0000-4000-8000-000000000004";
const M_ABSENT = "11110000-0000-4000-8000-000000000005";

const T = {
  save: "2026-03-01T00:00:00.000Z",
  old: "2026-03-01T10:00:00.000Z",
  rejoin: "2026-03-05T00:00:00.000Z",
  fresh: "2026-03-06T00:00:00.000Z",
};

function src(id: string, over: Partial<SavedMessageSource> = {}): SavedMessageSource {
  return {
    id,
    thread_id: THREAD,
    sender_id: ALICE,
    body: "dinner at 8",
    created_at: T.old,
    deleted_at: null,
    msg_type: "text",
    subtype: null,
    media_url: null,
    media_type: null,
    media_thumbnail_url: null,
    ...over,
  };
}

// ── The projection and the §14.3 decision ────────────────────────────────────

describe("saved messages — §14.2 re-authorization at read", () => {
  it("an active, unbounded member sees their saves, newest save first", () => {
    const out = projectSavedMessages({
      saved: [
        { message_id: M_OLD, saved_at: "2026-03-02T00:00:00.000Z" },
        { message_id: M_NEW, saved_at: "2026-03-04T00:00:00.000Z" },
      ],
      sources: [src(M_OLD), src(M_NEW, { created_at: T.fresh })],
      membershipByThread: { [THREAD]: { active: true, visibleFrom: null } },
    });
    assert.deepEqual(out.items.map((i) => i.messageId), [M_NEW, M_OLD]);
    assert.deepEqual(out.withheld, []);
  });

  it("a departed member's saves stay in the table and stop being served", () => {
    const out = projectSavedMessages({
      saved: [{ message_id: M_DEPARTED, saved_at: T.save }],
      sources: [src(M_DEPARTED, { thread_id: GONE_THREAD })],
      membershipByThread: {},
    });
    assert.deepEqual(out.items, []);
    assert.deepEqual(out.withheld, [{ messageId: M_DEPARTED, savedAt: T.save, reason: "not_a_member" }]);
  });

  it("a save made before the window moved is withheld once it moves", () => {
    // The save is honoured while the member is unbounded...
    const before = projectSavedMessages({
      saved: [{ message_id: M_OLD, saved_at: T.save }],
      sources: [src(M_OLD)],
      membershipByThread: { [THREAD]: { active: true, visibleFrom: null } },
    });
    assert.deepEqual(before.items.map((i) => i.messageId), [M_OLD]);

    // ...and withheld the moment the bound moves past the message.
    const after = projectSavedMessages({
      saved: [{ message_id: M_OLD, saved_at: T.save }],
      sources: [src(M_OLD)],
      membershipByThread: { [THREAD]: { active: true, visibleFrom: T.rejoin } },
    });
    assert.deepEqual(after.items, []);
    assert.equal(after.withheld[0]?.reason, "outside_history_window");
  });

  it("a rejoined member does not read their own pre-departure saves", () => {
    // 2400's trigger: left_at NOT NULL -> NULL re-stamps visible_from_at := now().
    const view = membershipViewFromRows(
      [{ thread_id: THREAD, left_at: null, visible_from_at: T.rejoin }],
      true,
    );
    const out = projectSavedMessages({
      saved: [
        { message_id: M_OLD, saved_at: T.save },
        { message_id: M_NEW, saved_at: T.fresh },
      ],
      sources: [src(M_OLD), src(M_NEW, { created_at: T.fresh })],
      membershipByThread: view,
    });
    assert.deepEqual(out.items.map((i) => i.messageId), [M_NEW],
      "only the message sent inside the NEW membership interval survives");
    assert.deepEqual(out.withheld.map((w) => w.reason), ["outside_history_window"]);
  });

  it("the bound applies only when it is enabled — flag OFF is byte-identical to before 2400", () => {
    const view = membershipViewFromRows(
      [{ thread_id: THREAD, left_at: null, visible_from_at: T.rejoin }],
      false,
    );
    assert.equal(view[THREAD]?.visibleFrom, null);
    const out = projectSavedMessages({
      saved: [{ message_id: M_OLD, saved_at: T.save }],
      sources: [src(M_OLD)],
      membershipByThread: view,
    });
    assert.deepEqual(out.items.map((i) => i.messageId), [M_OLD]);
  });

  it("withholding is named, not silent", () => {
    const out = projectSavedMessages({
      saved: [
        { message_id: M_OLD, saved_at: T.save },
        { message_id: M_ABSENT, saved_at: T.save },
      ],
      sources: [src(M_OLD)],
      membershipByThread: { [THREAD]: { active: true, visibleFrom: T.rejoin } },
    });
    assert.equal(out.items.length, 0);
    assert.equal(out.withheld.length, 2, "every dropped save is accounted for, none vanishes");
    assert.deepEqual(
      out.withheld.map((w) => w.reason).sort(),
      ["outside_history_window", "source_unavailable"],
    );
  });

  it("a deleted source is withheld from a member who is still in the thread (§7.4)", () => {
    const v = authorizeSavedMessage(
      src(M_DELETED, { deleted_at: "2026-03-07T00:00:00.000Z" }),
      { active: true, visibleFrom: null },
    );
    assert.deepEqual(v, { ok: false, reason: "source_deleted" });
  });

  it("a departed member learns nothing about the message's fate", () => {
    // Membership is judged BEFORE deletion: the reason names the caller's own
    // state and never the sender's later act.
    const v = authorizeSavedMessage(
      src(M_DELETED, { deleted_at: "2026-03-07T00:00:00.000Z" }),
      null,
    );
    assert.deepEqual(v, { ok: false, reason: "not_a_member" });

    const w = authorizeSavedMessage(
      src(M_DELETED, { deleted_at: "2026-03-07T00:00:00.000Z" }),
      { active: true, visibleFrom: T.rejoin },
    );
    assert.deepEqual(w, { ok: false, reason: "outside_history_window" });
  });

  it("an unparseable created_at is OUTSIDE the window, never inside it", () => {
    const v = authorizeSavedMessage(src(M_OLD, { created_at: "not a date" }), {
      active: true,
      visibleFrom: T.rejoin,
    });
    assert.deepEqual(v, { ok: false, reason: "outside_history_window" });
  });

  it("membershipViewFromRows judges left_at even when the reader forgot to filter", () => {
    const view = membershipViewFromRows(
      [{ thread_id: THREAD, left_at: "2026-03-04T00:00:00.000Z", visible_from_at: null }],
      true,
    );
    assert.equal(view[THREAD]?.active, false);
  });
});

// ── The prohibition ──────────────────────────────────────────────────────────

describe("saved messages — a saved item is not a second door onto the thread", () => {
  it("the projection carries no field that resolves to something else", () => {
    const item = projectSavedMessage(src(M_OLD), T.save);
    assert.equal(assertNoSecondDoor(item).ok, true);
    for (const field of SAVED_MESSAGE_SECOND_DOOR_FIELDS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(item, field),
        false,
        `projection must not carry "${field}"`,
      );
    }
  });

  it("REFUSES a payload carrying a second door — by name, one field at a time", () => {
    for (const field of SAVED_MESSAGE_SECOND_DOOR_FIELDS) {
      const bad = { ...projectSavedMessage(src(M_OLD), T.save), [field]: "x" };
      const r = assertNoSecondDoor(bad);
      assert.equal(r.ok, false, `"${field}" must be refused`);
      assert.equal(r.ok === false && r.field, field);
    }
  });

  it("the check is a refusal, not a strip", () => {
    const bad: Record<string, unknown> = { messageId: M_OLD, replyToId: "other-message" };
    assert.equal(assertNoSecondDoor(bad).ok, false);
    assert.equal(bad.replyToId, "other-message", "the payload is left alone; the caller is told no");
  });

  it("a reply pointer is the case this exists for", () => {
    const r = assertNoSecondDoor({ messageId: M_OLD, reply_to_id: M_NEW });
    assert.equal(r.ok === false && r.field, "reply_to_id");
  });
});

// ── Unsave ───────────────────────────────────────────────────────────────────

interface UnsaveState {
  rows: Array<{ user_id: string; message_id: string }>;
  /**
   * Scoped to ONE table on purpose. An error injected on every table makes
   * `requireUser`'s own ban-gate read fail too, and the route then answers 503
   * before it reaches the handler — a green test that proves nothing about the
   * branch it names. Found by instrumenting the handler during the red run.
   */
  errorTable?: string;
}

function makeClient(state: UnsaveState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let deleting = false;

    const target: any = {
      select() { return proxy; },
      delete() { deleting = true; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        if (state.errorTable === table) {
          return Promise.resolve({
            data: null,
            error: { message: `injected failure on ${table}`, code: "XX000" },
          }).then(resolve, reject);
        }
        const matched = state.rows.filter((r) => filters.every((f) => f(r)));
        if (deleting) state.rows = state.rows.filter((r) => !matched.includes(r));
        return Promise.resolve({ data: matched.map((r) => ({ message_id: r.message_id })), error: null })
          .then(resolve, reject);
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
    from,
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

describe("unsaveMessage — the caller's own bookmark, removable", () => {
  it("removes the caller's save and reports that it removed one", async () => {
    const state: UnsaveState = { rows: [{ user_id: BOB, message_id: M_OLD }] };
    const out = await unsaveMessage(makeClient(state) as any, BOB, M_OLD);
    assert.deepEqual(out, { status: "unsaved" });
    assert.equal(state.rows.length, 0);
  });

  it("is idempotent: unsaving what is not saved is not an error", async () => {
    const state: UnsaveState = { rows: [] };
    const out = await unsaveMessage(makeClient(state) as any, BOB, M_OLD);
    assert.deepEqual(out, { status: "not_saved" });
  });

  it("reaches no other person's row", async () => {
    const state: UnsaveState = { rows: [{ user_id: ALICE, message_id: M_OLD }] };
    const out = await unsaveMessage(makeClient(state) as any, BOB, M_OLD);
    assert.deepEqual(out, { status: "not_saved" });
    assert.equal(state.rows.length, 1, "Alice's save is untouched");
  });

  it("a failed delete is an error, never 'not_saved'", async () => {
    const state: UnsaveState = { rows: [{ user_id: BOB, message_id: M_OLD }], errorTable: "saved_messages" };
    const out = await unsaveMessage(makeClient(state) as any, BOB, M_OLD);
    assert.equal(out.status, "error");
    assert.equal(state.rows.length, 1, "the row is still there, and the caller is told so");
  });
});

// ── The route ────────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use("/api", savedMessagesRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function del(path: string, asUser: string | null) {
  const headers: Record<string, string> = {};
  if (asUser) headers.authorization = `Bearer ${asUser}`;
  const r = await fetch(`${base}${path}`, { method: "DELETE", headers });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

describe("DELETE /api/me/saved-messages/:messageId", () => {
  it("removes a save and answers 200", async () => {
    const state: UnsaveState = { rows: [{ user_id: BOB, message_id: M_OLD }] };
    _setTestClient(makeClient(state), true);
    const r = await del(`/me/saved-messages/${M_OLD}`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, status: "unsaved" });
  });

  it("is idempotent: a second unsave answers 200 not_saved, not 404", async () => {
    const state: UnsaveState = { rows: [] };
    _setTestClient(makeClient(state), true);
    const r = await del(`/me/saved-messages/${M_OLD}`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, status: "not_saved" });
  });

  it("REMOVES A SAVE THE CALLER CAN NO LONGER READ — unsave is not re-authorized", async () => {
    // No membership anywhere: the read path would withhold this save forever.
    // The owner can still get rid of it, which is the whole point.
    const state: UnsaveState = { rows: [{ user_id: BOB, message_id: M_DEPARTED }] };
    _setTestClient(makeClient(state), true);
    const r = await del(`/me/saved-messages/${M_DEPARTED}`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, status: "unsaved" });
    assert.equal(state.rows.length, 0);
  });

  it("a failed delete is a retryable 503, not a success", async () => {
    const state: UnsaveState = { rows: [{ user_id: BOB, message_id: M_OLD }], errorTable: "saved_messages" };
    _setTestClient(makeClient(state), true);
    const r = await del(`/me/saved-messages/${M_OLD}`, BOB);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
  });

  it("refuses a malformed message id", async () => {
    _setTestClient(makeClient({ rows: [] }), true);
    const r = await del(`/me/saved-messages/not-a-uuid`, BOB);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("requires a caller", async () => {
    _setTestClient(makeClient({ rows: [] }), true);
    const r = await del(`/me/saved-messages/${M_OLD}`, null);
    assert.equal(r.status, 401);
  });
});
