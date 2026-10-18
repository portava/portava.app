/**
 * census-trust (wave 5, 2026-10-18, "event reads", follow-up A) — a restore
 * that keeps the host's state must RECORD that it did.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventRestoreStateKeptRecord.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT. c37a4d7e1 made a restore of a host-cancelled, moderator-hidden
 * event answer 200: the hide is reversed and the host's own state is KEPT
 * (lib/eventModerationClaim.ts keepHostStateOnRestore; `stateKept`). But only
 * the admin route's HTTP answer said so. Every RECORD said "restored":
 *   - an approved appeal closed as plain `{ ok: true, action: "event_restored" }`
 *     (services/appeals/resolveAppeal.ts), and routes/appeals.ts copies that
 *     action into the approval notification's metadata and its own answer
 *     (`reversalAction`) — the appeals row itself holds no outcome column;
 *   - the `admin_restore` event_activity_log row (appeal and route alike)
 *     carried only the visibility change;
 *   - the route's `event_restore` moderation_actions row carried nothing either.
 * So a reviewer reading the appeal, the notification or the moderation log saw
 * "event restored" for an event still cancelled by its host.
 *
 * THE FIX. The appeal answers a distinct action,
 * `event_visibility_restored_state_kept`, with `stateKept` (the reason); every
 * reader of the action passes it through (no switch, no exhaustive union). Both
 * jsonb records (event_activity_log.metadata, moderation_actions.metadata) carry
 * `state_kept` = the same reason — never `from_state` / `to_state`, so the
 * record is never read as a state CHANGE: it releases no moderator's state hold
 * (decideEventModerationHold) and is not what a later restore reverses
 * (readRecordedEventModeration). No schema change.
 *
 * DOUBLE: helpers/adminModerationDouble.ts (schemaStrictSupabase: every column
 * checked against the live schema), the real admin and appeals routers.
 *
 * Each case says whether it was RED or GREEN on the code before this change
 * (fa1ba6a5d). CONTROLS pin what must not move and are GREEN before and after.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import * as claimLib from "../lib/eventModerationClaim.js";
import { resolveAppeal, isDeferred } from "../services/appeals/resolveAppeal.js";
import adminRouter from "../routes/admin.js";
import appealsRouter from "../routes/appeals.js";
import { installModerationDouble, isListRead } from "./helpers/adminModerationDouble.js";
import type { Seed, Row } from "./helpers/schemaStrictSupabase.js";

const C: any = claimLib;

const ADMIN  = "a1111111-1111-4111-8111-11111111d0a0";
const HOST   = "a3333333-3333-4333-8333-33333333d0a0";
const EVENT  = "b4444444-4444-4444-8444-44444444d0a0";
const APPEAL = "c9999999-9999-4999-8999-99999999d0a0";
const TOKENS: Record<string, string> = { "admin-token": ADMIN };
const FAIL = { message: "simulated failure", code: "57014" };
const KEPT_ACTION = "event_visibility_restored_state_kept";
const HOST_KEPT = /^Event is 'cancelled', and no recorded moderation put it there/;
const MOVED_KEPT = /^Event is 'archived', but the newest recorded moderation state change on it is admin_cancel to 'cancelled': something else has moved it since/;

const at = (n: number) => new Date(Date.UTC(2026, 9, 3, 0, 0, n)).toISOString();
const rowId = (n: number) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
/** A seeded activity row; `n` orders it (ids and times both increase with n; inserted rows sort above every one). */
const row = (n: number, action: string, metadata: Record<string, unknown>): Row => ({
  id: rowId(n), event_id: EVENT, actor_id: ADMIN, action, metadata: { reason: null, ...metadata }, created_at: at(100 + n),
});
const hide = (n: number, from = "public") => row(n, "admin_hide", { from_visibility: from, to_visibility: "invite_only" });
const cancel = (n: number, from = "open") => row(n, "admin_cancel", { from_state: from, to_state: "cancelled" });

function world(state: string, visibility: string, log: Row[] = []): Seed {
  return {
    profiles: [
      { id: ADMIN, handle: "admin", username: "admin", name: "admin", display_name: "admin", role: "admin", account_status: "active", created_at: at(0) },
      { id: HOST, handle: "host", username: "host", name: "host", display_name: "host", role: "user", account_status: "active", created_at: at(0) },
    ],
    admin_access_log: [], user_account_states: [], compass_settings: [], moderation_actions: [], reports: [], event_rsvps: [], notifications: [],
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }],
    events: [{ id: EVENT, host_id: HOST, title: "Kept event", state, visibility, featured: false, city: "Manila", starts_at: at(15), created_at: at(15), updated_at: at(15) }],
    event_activity_log: log,
    appeals: [{ id: APPEAL, appellant_id: HOST, target_type: "event", target_id: EVENT, state: "under_review", reason: "The hide was a mistake, please restore it.", evidence_url: null, resolution_note: null, moderator_id: null, created_at: at(50), updated_at: at(50) }],
  };
}
/** A moderator hid the event, then its HOST cancelled it (a host's cancel writes no moderation row). */
const hostCancelledAfterHide = () => world("cancelled", "invite_only", [hide(1)]);
/** A moderator cancelled it, something archived it since (the legacy path), then a moderator hid it. */
const movedSinceCancel = () => world("archived", "invite_only", [cancel(1), hide(2)]);
/** A moderator hid it AND cancelled it: everything a restore can reverse. */
const moderatorHidAndCancelled = () => world("cancelled", "invite_only", [hide(1), cancel(2)]);

const ev = (s: Seed) => s.events!.find((e) => e.id === EVENT)!;
const install = (s: Seed, o: Parameters<typeof installModerationDouble>[1] = {}) => installModerationDouble(s, { tokens: TOKENS, ...o });
const appeal = { id: APPEAL, appellant_id: HOST, target_type: "event", target_id: EVENT, resolution_note: "upheld", moderator_id: ADMIN };
const lastActivity = (s: Seed) => s.event_activity_log!.at(-1)!;
const meta = (r: Row | undefined) => (r?.metadata ?? {}) as Record<string, unknown>;
/** The hold, from the event's activity rows NEWEST FIRST (seeded rows sort below every inserted one). */
const holdOf = (s: Seed) => C.decideEventModerationHold([...s.event_activity_log!].reverse());

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(adminRouter);
  app.use(appealsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => { res.status(500).json({ error: "unhandled", message: String(err?.message ?? err) }); });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
beforeEach(() => {
  _resetRateLimit();
  // Nothing here should push; a push that did would leave the process otherwise.
  _setTestFetch((async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })) as any);
});
afterEach(() => _setTestFetch(null));

async function send(method: string, path: string, body: Record<string, unknown>) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const moderate = (action: string) => send("PATCH", `/admin/events/${EVENT}/moderate`, { action });
const approve = () => send("PATCH", `/appeals/${APPEAL}`, { state: "approved", resolutionNote: "upheld" });

// ══════════════════════════════════════════════════════════════════════════════
// A. The appeal's answer tells a kept state apart from a full restore
// ══════════════════════════════════════════════════════════════════════════════

describe("A. resolveAppeal — a restore that kept the event's state does not close as plain `event_restored`", () => {
  it("RED before: hide, then the HOST cancels — the appeal answers the distinct action and the reason; the hide is reversed, the host's cancel stands", async () => {
    const s = hostCancelledAfterHide();
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(isDeferred(r), false, "the hide WAS reversed: this is not a deferral");
    assert.notEqual(r.action, "event_restored", "a kept state is not a full restore");
    assert.equal(r.action, KEPT_ACTION);
    assert.match(String(r.stateKept), HOST_KEPT);
    assert.doesNotMatch(String(r.stateKept), /Nothing was changed/, "the reason, not a refusal");
    assert.deepEqual(Object.keys(r).sort(), ["action", "ok", "stateKept"]);
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "cancelled", visibility: "public" });
  });

  it("RED before: a moderator's cancel that something moved since (archived) — kept, and the answer says why", async () => {
    const s = movedSinceCancel();
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.action, KEPT_ACTION);
    assert.match(String(r.stateKept), MOVED_KEPT);
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "archived", visibility: "public" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B. The appeal's admin_restore row records the kept state
// ══════════════════════════════════════════════════════════════════════════════

describe("B. the `admin_restore` row an appeal writes records the kept state", () => {
  it("RED before: the row carries `state_kept` (the answer's own reason) beside the visibility record — and no from_state / to_state", async () => {
    const s = hostCancelledAfterHide();
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(s.event_activity_log!.length, 2, "one row written");
    const last = lastActivity(s);
    assert.equal(last.action, "admin_restore");
    assert.match(String(meta(last).state_kept), HOST_KEPT);
    assert.equal(meta(last).state_kept, r.stateKept, "the record and the answer say the same thing");
    assert.deepEqual(meta(last), { via: "appeal", appeal_id: APPEAL, reason: "upheld", from_visibility: "invite_only", to_visibility: "public", state_kept: r.stateKept });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C. What is recorded never looks like a state CHANGE
// ══════════════════════════════════════════════════════════════════════════════

describe("C. the kept-state record never releases a moderator's STATE hold", () => {
  it("RED before: APPEAL — the row records the kept state, and the moderator's cancel still holds the state (host refused), and is still what a restore would reverse", async () => {
    const s = movedSinceCancel();
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.action, KEPT_ACTION, JSON.stringify(r));
    assert.match(String(meta(lastActivity(s)).state_kept), MOVED_KEPT, "the kept state is recorded");
    assert.deepEqual(holdOf(s), { visibility: null, state: "admin_cancel" }, "the restore released the visibility hold ONLY");
    const read = await C.readEventModerationHold(client, EVENT);
    assert.deepEqual(read, { ok: true, hold: { visibility: null, state: "admin_cancel" } });
    const host = await C.refuseHostWriteUnderModeration(client, EVENT, { visibility: false, stateFrom: "archived" });
    assert.equal(host.ok, false, JSON.stringify(host));
    assert.equal(host.code, "event_under_moderation");
    const rec = await C.readRecordedEventModeration(client, EVENT);
    assert.deepEqual(rec, { ok: true, recorded: { action: "admin_cancel", from_state: "open", to_state: "cancelled" } }, "the newest recorded state change is still the moderator's cancel");
  });

  it("RED before: ROUTE — the same: the route's restore records the kept state and releases only the visibility hold", async () => {
    const s = movedSinceCancel();
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.match(String(r.body.stateKept), MOVED_KEPT);
    assert.equal(meta(lastActivity(s)).state_kept, r.body.stateKept, "the kept state is recorded");
    assert.deepEqual(holdOf(s), { visibility: null, state: "admin_cancel" });
    assert.equal(ev(s).state, "archived");
  });

  it("GREEN before (CONTROL): decideEventModerationHold reads a restore row carrying `state_kept` and no from/to as NO state change — a cancel behind it still holds", () => {
    const restoreRow = { action: "admin_restore", metadata: { reason: null, from_visibility: "invite_only", to_visibility: "public", state_kept: "Event is 'archived', but … something else has moved it since" } };
    const cancelRow = { action: "admin_cancel", metadata: { from_state: "open", to_state: "cancelled" } };
    assert.deepEqual(C.decideEventModerationHold([restoreRow, cancelRow]), { visibility: null, state: "admin_cancel" });
    // …and the same row WITH a state change would release it: the rule this record must stay clear of.
    assert.deepEqual(C.decideEventModerationHold([{ ...restoreRow, metadata: { ...restoreRow.metadata, from_state: "cancelled", to_state: "open" } }, cancelRow]), { visibility: null, state: null });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D. The admin route records what its answer already said
// ══════════════════════════════════════════════════════════════════════════════

describe("D. PATCH /admin/events/:eventId/moderate restore — the records carry `stateKept`, not only the HTTP answer", () => {
  it("RED before: the route's `admin_restore` activity row records the kept state (it carried only the visibility change)", async () => {
    const s = hostCancelledAfterHide();
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.match(String(r.body.stateKept), HOST_KEPT);
    const last = lastActivity(s);
    assert.equal(last.action, "admin_restore");
    assert.deepEqual(meta(last), { reason: null, from_visibility: "invite_only", to_visibility: "public", state_kept: r.body.stateKept });
  });

  it("RED before: the route's `event_restore` moderation_actions row records the kept state (it carried only event_id / event_title)", async () => {
    const s = hostCancelledAfterHide();
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(s.moderation_actions!.length, 1);
    const audit = s.moderation_actions![0]!;
    assert.equal(audit.action_type, "event_restore");
    assert.deepEqual(audit.metadata, { event_id: EVENT, event_title: "Kept event", state_kept: r.body.stateKept });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// E. Through routes/appeals.ts: the notification and the admin's answer
// ══════════════════════════════════════════════════════════════════════════════

describe("E. PATCH /appeals/:id approved — the kept state reaches what the appeal route records", () => {
  it("RED before: the approval answer and the appellant's notification metadata carry the distinct reversalAction", async () => {
    const s = hostCancelledAfterHide();
    install(s);
    const r = await approve();
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.state, "approved");
    assert.equal(r.body.reversalAction, KEPT_ACTION);
    assert.equal(r.body.restored, true, "the hide was reversed");
    assert.equal(s.notifications!.length, 1);
    const n = s.notifications![0]!;
    assert.equal((n.metadata as any).reversalAction, KEPT_ACTION);
    assert.equal(s.appeals![0]!.state, "approved");
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "cancelled", visibility: "public" });
  });

  it("GREEN before (CONTROL): a full restore still answers `event_restored` through the route", async () => {
    const s = moderatorHidAndCancelled();
    install(s);
    const r = await approve();
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.reversalAction, "event_restored");
    assert.equal((s.notifications![0]!.metadata as any).reversalAction, "event_restored");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// F. Controls — nothing else moves
// ══════════════════════════════════════════════════════════════════════════════

describe("F. controls — a full restore, a refusal, an unreadable record, a moderator's own cancel", () => {
  it("GREEN before (CONTROL): a moderator's hide AND cancel — fully restored, closes exactly as `event_restored`, records no kept state, releases both holds", async () => {
    const s = moderatorHidAndCancelled();
    const { client } = install(s);
    const r = await resolveAppeal(client, appeal);
    assert.deepEqual(r, { ok: true, action: "event_restored" });
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "open", visibility: "public" });
    assert.deepEqual(meta(lastActivity(s)), { via: "appeal", appeal_id: APPEAL, reason: "upheld", from_state: "cancelled", to_state: "open", from_visibility: "invite_only", to_visibility: "public" });
    assert.deepEqual(holdOf(s), { visibility: null, state: null });
  });

  it("GREEN before (CONTROL): a moderator's own recorded cancel (no hide) is reversed exactly", async () => {
    const s = world("cancelled", "friends_only", [cancel(1, "draft")]);
    const { client } = install(s);
    const r = await resolveAppeal(client, appeal);
    assert.deepEqual(r, { ok: true, action: "event_restored" });
    assert.equal(ev(s).state, "draft");
    assert.equal(ev(s).visibility, "friends_only");
    assert.deepEqual(meta(lastActivity(s)), { via: "appeal", appeal_id: APPEAL, reason: "upheld", from_state: "cancelled", to_state: "draft" });
  });

  it("GREEN before (CONTROL): a host-cancelled event with nothing to reverse still defers to a person — nothing written", async () => {
    const s = world("cancelled", "public");
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(isDeferred(r), true, JSON.stringify(r));
    assert.equal(r.action, "restore_requires_policy");
    assert.match(r.reason, /no recorded moderation put it there.*Nothing was changed or recorded\./);
    assert.deepEqual(s.event_activity_log, []);
    assert.equal(ev(s).state, "cancelled");
  });

  it("GREEN before (CONTROL): an unreadable moderation record still refuses (noop) — nothing written", async () => {
    const s = hostCancelledAfterHide();
    const { client } = install(s, { overrides: { event_activity_log: (calls) => (isListRead(calls) ? { data: null, error: FAIL } : null) } });
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.action, "noop");
    assert.match(r.reason, /could not be read/);
    assert.equal(s.event_activity_log!.length, 1);
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "cancelled", visibility: "invite_only" });
  });

  it("GREEN before (CONTROL): the route's full restore records no kept state on either row", async () => {
    const s = moderatorHidAndCancelled();
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.stateKept, undefined);
    assert.equal("state_kept" in meta(lastActivity(s)), false);
    assert.deepEqual(s.moderation_actions![0]!.metadata, { event_id: EVENT, event_title: "Kept event" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G. The appellant is told the truth: the hide was reversed, the state was not
// ══════════════════════════════════════════════════════════════════════════════

describe("G. the approval notification of a kept-state restore does not say the action was reversed", () => {
  it("RED before: the body says the event is visible again and its status was not changed; the metadata carries stateKept", async () => {
    const s = hostCancelledAfterHide();
    install(s);
    const r = await approve();
    assert.equal(r.status, 200, r.raw);
    const n = s.notifications![0]!;
    assert.doesNotMatch(String(n.body), /has been reversed/);
    assert.equal(String(n.body), "Your appeal was approved. upheld Your event is visible again. Its status was not changed.", "the moderator's note, then the kept state, said whatever the note says");
    const s2 = hostCancelledAfterHide();
    install(s2);
    const r2 = await send("PATCH", `/appeals/${APPEAL}`, { state: "approved" });
    assert.equal(r2.status, 200, r2.raw);
    assert.equal(String(s2.notifications![0]!.body), "Your appeal was approved and your event is visible again. Its status was not changed.", "no note");
    assert.equal(typeof (n.metadata as any).stateKept, "string");
    assert.ok(String((n.metadata as any).stateKept).length > 0);
    assert.equal((n.metadata as any).restored, true, "the hide was reversed");
  });

  it("GREEN before (CONTROL): a full restore still says the action has been reversed, and carries no stateKept", async () => {
    const s = moderatorHidAndCancelled();
    install(s);
    const r = await approve();
    assert.equal(r.status, 200, r.raw);
    const n = s.notifications![0]!;
    assert.equal(String(n.body), "Your appeal was approved. upheld", "a full restore with a note: unchanged");
    assert.equal("stateKept" in (n.metadata as any), false);
    const s2 = moderatorHidAndCancelled();
    install(s2);
    const r2 = await send("PATCH", `/appeals/${APPEAL}`, { state: "approved" });
    assert.equal(r2.status, 200, r2.raw);
    assert.equal(String(s2.notifications![0]!.body), "Your appeal was approved and the action has been reversed.", "a full restore, no note: unchanged");
  });
});
