/**
 * census-trust (wave 5, 2026-10-18) — a host cannot undo a moderator's hide.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventHostModerationHold.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT (SAFETY). A moderator's `hide` writes visibility `invite_only`
 * (`remove` also archives). The HOST wrote any other visibility straight back
 * through PATCH /events/:id — no guard, no record — so a moderator's hide held
 * until the host undid it, and a removed event could be widened. POST
 * /events/:id/link-circle wrote visibility the same way. A report's
 * hide-content hid an event with a raw update that recorded nothing, so nothing
 * could even tell it held. From `cancelled` the transition authority lets a
 * host archive, which made a moderator's cancel irreversible (the restore and
 * the appeal refuse a record the event no longer holds).
 * And: the two host cancel routes, PATCH, archive and getEventRole DISCARDED
 * their event reads' errors, so a failed read answered 404 "not found" (or 403
 * "only the host…" through getEventRole).
 *
 * THE FIX (lib/eventModerationClaim.ts THE HOLD; routes/events.ts; routes/admin.ts).
 *   - While the newest moderation of a column still holds — read from the
 *     moderation record (event_activity_log), never from a column the host can
 *     write — the host may not write it: 409 `event_under_moderation`, nothing
 *     written. A moderator's restore or an approved appeal releases it.
 *   - A host's own visibility change on an unheld event is written
 *     conditionally on what it read (a hide landing since wins: 409 conflict)
 *     and recorded (`visibility_changed`, from / to), which the restore's reader
 *     reads as the host's value since — never reversed.
 *   - hide-content's event hide is the moderate route's: claimed, recorded
 *     (admin_hide, from / to, via: report), undone if the record fails.
 *   - A failed event read is 503 `degraded_unavailable`, never 404 / 403.
 *
 * DOUBLES: helpers/adminModerationDouble.ts (schemaStrictSupabase + paging, a
 * row cap, read overrides, increasing insert ids). Its `.order()` keeps only
 * the last key (id): seeded rows have ids that sort as their times do, and
 * every inserted row sorts above them. The real admin and events routers, with
 * the real global error handler (lib/errorEnvelope.ts).
 *
 * Each case says whether it was RED or GREEN on the code before this change
 * (cf5a3c6cd). The new exports are imported as a namespace, so on the old code
 * a missing export fails ITS case, not the file.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import * as claimLib from "../lib/eventModerationClaim.js";
import adminRouter from "../routes/admin.js";
import eventsRouter from "../routes/events.js";
import { sanitize, matchParen } from "../scripts/lib/supabaseCallScan.js";
import { installModerationDouble, isListRead, selectOf, type Call } from "./helpers/adminModerationDouble.js";
import type { Seed, Row } from "./helpers/schemaStrictSupabase.js";

const C: any = claimLib;

const ADMIN  = "a1111111-1111-4111-8111-11111111e0a0";
const HOST   = "a3333333-3333-4333-8333-33333333e0a0";
const COHOST = "a5555555-5555-4555-8555-55555555e0a0";
const EVENT  = "b4444444-4444-4444-8444-44444444e0a0";
const REPORT = "c6666666-6666-4666-8666-66666666e0a0";
const APPEAL = "c9999999-9999-4999-8999-99999999e0a0";
const TOKENS: Record<string, string> = { "admin-token": ADMIN, "host-token": HOST, "cohost-token": COHOST };
const FAIL = { message: "simulated failure", code: "57014" };

const at = (n: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, n)).toISOString();
const rowId = (n: number) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
/** A seeded activity row; `n` orders it (ids and times both increase with n). */
const row = (n: number, action: string, metadata: Record<string, unknown>, actor = ADMIN): Row => ({
  id: rowId(n), event_id: EVENT, actor_id: actor, action, metadata: { reason: null, ...metadata }, created_at: at(100 + n),
});
const vrec = (n: number, action: string, from: string, to: string) => row(n, action, { from_visibility: from, to_visibility: to });

function world(state = "open", visibility = "public", activity: Row[] = []): Seed {
  const person = (id: string, handle: string, role = "user") => ({ id, handle, username: handle, name: handle, display_name: handle, role, account_status: "active", created_at: at(0), expo_push_token: null });
  return {
    profiles: [person(ADMIN, "admin", "admin"), person(HOST, "host"), person(COHOST, "cohost")],
    admin_access_log: [], user_account_states: [], compass_settings: [], moderation_actions: [], event_rsvps: [], event_updates: [], trust_events: [],
    reports: [{ id: REPORT, reporter_id: COHOST, target_type: "event", target_id: EVENT, reason: "spam", severity: "normal", status: "open", created_at: at(5), updated_at: at(5) }],
    report_evidence: [],
    event_roles: [{ event_id: EVENT, user_id: COHOST, role: "co_host", created_at: at(1) }],
    event_activity_log: activity,
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }],
    events: [{ id: EVENT, host_id: HOST, title: "Held event", state, visibility, featured: false, city: "Tokyo", circle_id: null, starts_at: at(9000), created_at: at(15), updated_at: at(15), chat_enabled: false }],
  };
}
const ev = (s: Seed) => s.events!.find((e) => e.id === EVENT)!;
const install = (s: Seed, o: Parameters<typeof installModerationDouble>[1] = {}) => installModerationDouble(s, { tokens: TOKENS, ...o });
const acts = (s: Seed) => s.event_activity_log!.map((a) => ({ action: a.action, from: (a.metadata as any)?.from_visibility, to: (a.metadata as any)?.to_visibility, via: (a.metadata as any)?.via, actor: a.actor_id }));
const eventWrites = (d: ReturnType<typeof install>) => d.strict.writes.filter((w) => w.table === "events").length;
/** The hold's read: the moderation rows of BOTH columns (the restore's own readers each name one). */
const isHoldRead = (calls: Call[]) => isListRead(calls) && calls.some(([m, a]) => m === "in" && a[0] === "action" && (a[1] as string[]).includes("admin_hide") && (a[1] as string[]).includes("admin_cancel"));

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(adminRouter);
  app.use(eventsRouter);
  app.use(globalErrorHandler);
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
  _setTestFetch((async (_u: any, init: any) => new Response(JSON.stringify({ data: JSON.parse(String(init?.body ?? "[]")).map(() => ({ status: "ok" })) }), { status: 200, headers: { "content-type": "application/json" } })) as any);
});
afterEach(() => _setTestFetch(null));

async function call(method: string, path: string, body: unknown, token: string) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const moderate = (action: string) => call("PATCH", `/admin/events/${EVENT}/moderate`, { action }, "admin-token");
const hostPatch = (body: Record<string, unknown>, token = "host-token") => call("PATCH", `/events/${EVENT}`, body, token);
const archive = () => call("POST", `/events/${EVENT}/archive`, {}, "host-token");
const linkCircle = (setCircleVisibility: boolean) => call("POST", `/events/${EVENT}/link-circle`, { circleId: HOST, setCircleVisibility }, "host-token");

/** The refusal every held write answers. */
function assertHeld(r: { status: number; body: any; raw: string }, column: string) {
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.error, "event_under_moderation", r.raw);
  assert.match(r.body.message, new RegExp(`its ${column} cannot be changed until a moderator restores it or an appeal is approved\\. Nothing was changed\\.`));
}

// ══════════════════════════════════════════════════════════════════════════════
// A. The hold — pure
// ══════════════════════════════════════════════════════════════════════════════

describe("A. decideEventModerationHold — from the moderation record, newest first", () => {
  const d = (rows: Row[]) => C.decideEventModerationHold([...rows].reverse());
  const st = (n: number, action: string, from: string, to: string) => row(n, action, { from_state: from, to_state: to });

  it("RED before: a hide or remove holds visibility; a restore releases it; nothing moderated holds nothing", () => {
    assert.equal(typeof C.decideEventModerationHold, "function", "decideEventModerationHold is not exported");
    assert.deepEqual(d([]), { visibility: null, state: null });
    assert.deepEqual(d([vrec(1, "admin_hide", "public", "invite_only")]), { visibility: "admin_hide", state: null });
    assert.deepEqual(d([vrec(1, "admin_hide", "public", "invite_only"), vrec(2, "admin_restore", "invite_only", "public")]), { visibility: null, state: null });
    assert.deepEqual(d([vrec(1, "admin_hide", "public", "invite_only"), vrec(2, "admin_restore", "invite_only", "public"), vrec(3, "admin_hide", "public", "invite_only")]), { visibility: "admin_hide", state: null });
    assert.deepEqual(d([row(1, "admin_feature", {}), row(2, "admin_warn_host", {})]), { visibility: null, state: null }, "feature / warn_host set no column a host writes");
  });

  it("RED before: a hide that CHANGED NOTHING (the host had chosen invite_only) still holds; so does a hide that recorded nothing (it predates the record)", () => {
    assert.deepEqual(d([vrec(1, "admin_hide", "invite_only", "invite_only")]), { visibility: "admin_hide", state: null }, "passed over, the host could widen it the moment after");
    assert.deepEqual(d([row(1, "admin_hide", {})]), { visibility: "admin_hide", state: null });
    assert.deepEqual(d([row(1, "admin_restore", {})]), { visibility: null, state: null }, "a restore releases, recorded or not");
  });

  it("RED before: state — the newest recorded moderation state CHANGE; a cancel or remove holds, a restore releases, a cancel that changed nothing holds nothing", () => {
    assert.deepEqual(d([st(1, "admin_cancel", "open", "cancelled")]), { visibility: null, state: "admin_cancel" });
    assert.deepEqual(d([{ ...st(1, "admin_remove", "open", "archived"), metadata: { from_state: "open", to_state: "archived", from_visibility: "public", to_visibility: "invite_only" } }]), { visibility: "admin_remove", state: "admin_remove" });
    assert.deepEqual(d([st(1, "admin_cancel", "open", "cancelled"), st(2, "admin_restore", "cancelled", "open")]), { visibility: null, state: null });
    assert.deepEqual(d([st(1, "admin_cancel", "cancelled", "cancelled")]), { visibility: null, state: null }, "the host cancelled first: nothing a moderator put there");
    assert.deepEqual(d([st(1, "admin_cancel", "open", "cancelled"), vrec(2, "admin_hide", "public", "invite_only")]), { visibility: "admin_hide", state: "admin_cancel" }, "each column its own newest record");
    assert.deepEqual(d([st(1, "admin_cancel", "open", "cancelled"), { ...st(2, "admin_restore", "cancelled", "open"), metadata: { from_state: "cancelled", to_state: "open" } }, vrec(3, "admin_hide", "public", "invite_only")]), { visibility: "admin_hide", state: null });
  });

  it("RED before: a host's own recorded change never releases a hold, and the hold's read never names it", () => {
    assert.deepEqual(d([vrec(1, "admin_hide", "public", "invite_only"), row(2, "visibility_changed", { from_visibility: "invite_only", to_visibility: "public" }, HOST)]), { visibility: "admin_hide", state: null });
    assert.ok(Array.isArray(C.EVENT_MODERATION_HOLD_ACTIVITY), "EVENT_MODERATION_HOLD_ACTIVITY is not exported");
    assert.deepEqual([...C.EVENT_MODERATION_HOLD_ACTIVITY].sort(), ["admin_cancel", "admin_hide", "admin_remove", "admin_restore"]);
  });

  it("RED before: the restore's decision reads a host's recorded change as the host's own value since — kept, never reversed", () => {
    const keep = C.decideEventVisibilityReversal("invite_only", { kind: "recorded", action: "visibility_changed", from: "public", to: "invite_only" });
    assert.equal(keep.kind, "keep", JSON.stringify(keep));
    assert.match(keep.why, /its host's own/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B. PATCH /events/:id — the host's visibility (and state) while a moderation holds
// ══════════════════════════════════════════════════════════════════════════════

describe("B. PATCH /events/:id — a moderator's hide holds the host off", () => {
  it("RED before: the host cannot un-hide an event a moderator hid (the real moderate route) — 409 event_under_moderation, nothing written", async () => {
    const s = world("open", "friends_only");
    const dbl = install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal(ev(s).visibility, "invite_only");
    const before = eventWrites(dbl);
    for (const to of ["public", "friends_only"]) {
      const r = await hostPatch({ visibility: to });
      assertHeld(r, "visibility");
      assert.match(r.body.message, /A moderator hid this event \(admin_hide\)/);
    }
    assert.equal(ev(s).visibility, "invite_only", "the hide stands");
    assert.equal(eventWrites(dbl), before, "the refused PATCH wrote nothing to events");
    assert.deepEqual(acts(s).map((a) => a.action), ["admin_hide"], "and recorded nothing");
  });

  it("RED before: the host cannot widen a REMOVED event, nor move its state — both held by the remove", async () => {
    const s = world("open", "public");
    const dbl = install(s);
    assert.equal((await moderate("remove")).status, 200);
    assert.equal(ev(s).state, "archived");
    const before = eventWrites(dbl);
    assertHeld(await hostPatch({ visibility: "public" }), "visibility");
    assertHeld(await hostPatch({ state: "open" }), "state");
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "archived", visibility: "invite_only" });
    assert.equal(eventWrites(dbl), before);
  });

  it("RED before: a hide that found the event ALREADY invite_only (it changed nothing) still holds the host off", async () => {
    const s = world("open", "invite_only");
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.deepEqual(acts(s).map((a) => [a.action, a.from, a.to]), [["admin_hide", "invite_only", "invite_only"]]);
    assertHeld(await hostPatch({ visibility: "public" }), "visibility");
    assert.equal(ev(s).visibility, "invite_only");
  });

  it("RED before: a hide that recorded nothing (it predates the record) holds too", async () => {
    const s = world("open", "invite_only", [row(1, "admin_hide", {})]);
    install(s);
    assertHeld(await hostPatch({ visibility: "public" }), "visibility");
    assert.equal(ev(s).visibility, "invite_only");
  });

  it("RED before: on an unmoderated event the host's change is written AND recorded — from, to, by the host", async () => {
    const s = world("open", "public");
    install(s);
    const r = await hostPatch({ visibility: "friends_only" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "friends_only");
    assert.deepEqual(acts(s), [{ action: "visibility_changed", from: "public", to: "friends_only", via: "edit", actor: HOST }]);
  });

  it("RED before: after a moderator's restore the host may change it again (recorded); and the restore put back what the hide found", async () => {
    const s = world("open", "friends_only");
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assertHeld(await hostPatch({ visibility: "public" }), "visibility");
    const restore = await moderate("restore");
    assert.equal(restore.status, 200, restore.raw);
    assert.equal(ev(s).visibility, "friends_only");
    const r = await hostPatch({ visibility: "public" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "public");
    assert.deepEqual(acts(s).map((a) => [a.action, a.from, a.to]), [["admin_hide", "friends_only", "invite_only"], ["admin_restore", "invite_only", "friends_only"], ["visibility_changed", "friends_only", "public"]]);
    assert.equal((await moderate("hide")).status, 200, "a later hide holds again");
    assertHeld(await hostPatch({ visibility: "friends_only" }), "visibility");
  });

  it("RED before: an approved appeal releases the hold as a restore does", async () => {
    const s = world("open", "public");
    const { client } = install(s);
    assert.equal((await moderate("hide")).status, 200);
    assertHeld(await hostPatch({ visibility: "friends_only" }), "visibility");
    const out = await C.reverseModeratedEventOnAppeal(client, { eventId: EVENT, hostId: HOST, actorId: ADMIN, appealId: APPEAL, note: "approved" });
    assert.equal(out.outcome, "restored", JSON.stringify(out));
    assert.equal(ev(s).visibility, "public");
    const r = await hostPatch({ visibility: "friends_only" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "friends_only");
  });

  it("GREEN before (CONTROL): on a hidden event the host's ordinary edits still work — a title, or visibility sent unchanged; nothing is recorded as a visibility change", async () => {
    const s = world("open", "public");
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    const t = await hostPatch({ title: "Renamed" });
    assert.equal(t.status, 200, t.raw);
    const same = await hostPatch({ title: "Renamed again", visibility: "invite_only" });
    assert.equal(same.status, 200, same.raw);
    assert.equal(ev(s).title, "Renamed again");
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(acts(s).map((a) => a.action), ["admin_hide"]);
  });

  it("GREEN before (CONTROL): a co-host still may not change visibility at all (SEC-04)", async () => {
    const s = world("open", "public");
    install(s);
    const r = await hostPatch({ visibility: "friends_only" }, "cohost-token");
    assert.equal(r.status, 403, r.raw);
    assert.equal(ev(s).visibility, "public");
  });

  it("RED before: a record that cannot be read REFUSES the host's change (503), nothing written — unread is not \"free\"", async () => {
    const s = world("open", "invite_only", [vrec(1, "admin_hide", "public", "invite_only")]);
    const dbl = install(s, { overrides: { event_activity_log: (calls) => (isHoldRead(calls) ? { data: null, error: FAIL, count: null } : null) } });
    const r = await hostPatch({ visibility: "public" });
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.match(r.body.message, /moderation record could not be read \(event_activity_log\): .*so nothing was changed/);
    assert.equal(ev(s).visibility, "invite_only");
    assert.equal(eventWrites(dbl), 0);
  });

  it("RED before: a moderator's hide landing between the host's hold read and its write WINS — 409 conflict, the hide stands, nothing recorded for the host", async () => {
    const s = world("open", "public");
    let fired = false;
    install(s, { overrides: { event_activity_log: (calls, run) => {
      if (!isHoldRead(calls) || fired) return null;
      fired = true;
      return run().then((ans) => { // the moderator's claim, after the host read the (empty) record
        s.events = [{ ...ev(s), visibility: "invite_only", updated_at: at(500) }]; // a NEW row object: the double hands the route the stored row itself, which a real read never aliases
        s.event_activity_log!.push(vrec(9, "admin_hide", "public", "invite_only"));
        return ans;
      });
    } } });
    const r = await hostPatch({ visibility: "friends_only" });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "conflict");
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(acts(s).map((a) => a.action), ["admin_hide"]);
  });

  it("RED before: …and so does a hide that CHANGED nothing (it only stamped updated_at) — the write is conditional on the updated_at read too", async () => {
    const s = world("open", "invite_only");
    let fired = false;
    install(s, { overrides: { event_activity_log: (calls, run) => {
      if (!isHoldRead(calls) || fired) return null;
      fired = true;
      return run().then((ans) => { s.events = [{ ...ev(s), updated_at: at(500) }]; s.event_activity_log!.push(vrec(9, "admin_hide", "invite_only", "invite_only")); return ans; });
    } } });
    const r = await hostPatch({ visibility: "public" });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "conflict");
    assert.equal(ev(s).visibility, "invite_only");
  });

  it("RED before: a restore after a hide the HOST had since changed back (recorded) keeps the host's last value — it does not reverse past it", async () => {
    // The hold makes this unreachable from now on; rows from before it (or a race) must still never be reversed past.
    const s = world("open", "invite_only", [
      vrec(1, "admin_hide", "friends_only", "invite_only"),
      row(2, "visibility_changed", { from_visibility: "invite_only", to_visibility: "public", via: "edit" }, HOST),
      row(3, "visibility_changed", { from_visibility: "public", to_visibility: "invite_only", via: "edit" }, HOST),
    ]);
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "invite_only", "the host's own last choice stands; the hide's 'friends_only' is older than it");
    assert.equal(r.body.visibility, undefined);
  });
});

describe("B2. state — a moderator's cancel holds until it is restored", () => {
  const cancelled = () => world("open", "public");

  it("RED before: the host cannot archive a moderator-CANCELLED event (PATCH or POST /archive) — and the restore then still reverses the cancel", async () => {
    const s = cancelled();
    const dbl = install(s);
    assert.equal((await moderate("cancel")).status, 200);
    assert.equal(ev(s).state, "cancelled");
    const before = eventWrites(dbl);
    const p = await hostPatch({ state: "archived" });
    assertHeld(p, "state");
    assert.match(p.body.message, /A moderator cancelled this event \(admin_cancel\)/);
    assertHeld(await archive(), "state");
    assert.equal(ev(s).state, "cancelled");
    assert.equal(eventWrites(dbl), before);
    const restore = await moderate("restore");
    assert.equal(restore.status, 200, `the cancel is still reversible: ${restore.raw}`);
    assert.equal(ev(s).state, "open");
  });

  it("RED before: the hold is read past the row cap — a moderator's cancel under more newer moderation rows than one page still holds", async () => {
    const rows = [row(1, "admin_cancel", { from_state: "open", to_state: "cancelled" })];
    for (let n = 2; n <= 6; n++) rows.push(vrec(n, "admin_hide", "invite_only", "invite_only"));
    const s = world("cancelled", "invite_only", rows);
    install(s, { cap: 3 });
    assertHeld(await archive(), "state");
    assert.equal(ev(s).state, "cancelled");
  });

  it("GREEN before (CONTROL): the host's OWN cancellation (no moderation record) still archives", async () => {
    const s = world("cancelled", "public");
    install(s);
    const r = await archive();
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "archived");
  });

  it("GREEN before (CONTROL): a moderator's cancel of an event the host had ALREADY cancelled put nothing there to hold — the host archives", async () => {
    const s = world("cancelled", "public");
    install(s);
    assert.equal((await moderate("cancel")).status, 200);
    const r = await archive();
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "archived");
  });

  it("GREEN before (CONTROL): a hidden (not cancelled) event's host may still cancel or archive it — the hide holds visibility only", async () => {
    const s = world("open", "public");
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal((await archive()).status, 200);
    assert.equal(ev(s).state, "archived");
    assert.equal(ev(s).visibility, "invite_only");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C. POST /events/:id/link-circle — the other host write of visibility
// ══════════════════════════════════════════════════════════════════════════════

describe("C. POST /events/:id/link-circle — setCircleVisibility is held as PATCH is", () => {
  it("RED before: on a hidden event, setCircleVisibility is refused — 409 event_under_moderation, neither column written", async () => {
    const s = world("open", "public");
    const dbl = install(s);
    assert.equal((await moderate("hide")).status, 200);
    const before = eventWrites(dbl);
    assertHeld(await linkCircle(true), "visibility");
    assert.equal(ev(s).visibility, "invite_only");
    assert.equal(ev(s).circle_id, null);
    assert.equal(eventWrites(dbl), before);
  });

  it("GREEN before (CONTROL): linking the circle WITHOUT setting visibility still works on a hidden event", async () => {
    const s = world("open", "public");
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    const r = await linkCircle(false);
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).circle_id, HOST);
    assert.equal(ev(s).visibility, "invite_only");
  });

  it("RED before: a moderator's hide landing between link-circle's hold read and its write WINS — 409 conflict, neither column written", async () => {
    const s = world("open", "public");
    let fired = false;
    install(s, { overrides: { event_activity_log: (calls, run) => {
      if (!isHoldRead(calls) || fired) return null;
      fired = true;
      return run().then((ans) => { s.events = [{ ...ev(s), visibility: "invite_only", updated_at: at(500) }]; s.event_activity_log!.push(vrec(9, "admin_hide", "public", "invite_only")); return ans; });
    } } });
    const r = await linkCircle(true);
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "conflict");
    assert.deepEqual({ visibility: ev(s).visibility, circle: ev(s).circle_id }, { visibility: "invite_only", circle: null });
  });

  it("RED before: on an unmoderated event, setCircleVisibility is written and RECORDED (via link-circle)", async () => {
    const s = world("open", "public");
    install(s);
    const r = await linkCircle(true);
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "circle");
    assert.deepEqual(acts(s).filter((a) => a.action === "visibility_changed"), [{ action: "visibility_changed", from: "public", to: "circle", via: "link-circle", actor: HOST }]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D. A report's hide-content — now a recorded hide, so it holds
// ══════════════════════════════════════════════════════════════════════════════

describe("D. POST /admin/reports/:id/hide-content on an event — recorded, so it holds, and restore reverses it", () => {
  it("RED before: the hide is recorded (admin_hide, from / to, via report); the host is held off; a restore puts back what it found", async () => {
    const s = world("open", "friends_only");
    install(s);
    const h = await call("POST", `/admin/reports/${REPORT}/hide-content`, { reason: "spam" }, "admin-token");
    assert.equal(h.status, 200, h.raw);
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(acts(s).map((a) => [a.action, a.from, a.to, a.via]), [["admin_hide", "friends_only", "invite_only", "report"]]);
    assertHeld(await hostPatch({ visibility: "public" }), "visibility");
    const restore = await moderate("restore");
    assert.equal(restore.status, 200, restore.raw);
    assert.equal(ev(s).visibility, "friends_only", "back to exactly what the report's hide found");
  });

  it("RED before: when the hide's record cannot be written the hide is UNDONE (500 db_error) — never left standing unrecorded", async () => {
    const s = world("open", "public");
    install(s, { strict: { writeError: { table: "event_activity_log", error: { message: "activity insert refused" } } } });
    const h = await call("POST", `/admin/reports/${REPORT}/hide-content`, { reason: "spam" }, "admin-token");
    assert.equal(h.status, 500, h.raw);
    assert.equal(h.body.error, "db_error");
    assert.match(h.body.message, /activity log could not be written .*restored to what it held when read/);
    assert.equal(ev(s).visibility, "public");
  });

  it("GREEN before (CONTROL): a report naming an event that no longer exists hides nothing and records nothing", async () => {
    const s = world("open", "public");
    s.events = [];
    install(s);
    const h = await call("POST", `/admin/reports/${REPORT}/hide-content`, { reason: "spam" }, "admin-token");
    assert.equal(h.status, 200, h.raw);
    assert.deepEqual(s.event_activity_log, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// E. A failed read is 503 — never "not found" (404) or "not allowed" (403)
// ══════════════════════════════════════════════════════════════════════════════

describe("E. a failed event read answers 503 degraded_unavailable, nothing written", () => {
  /** Fail the one events read whose select list is exactly `sel`. */
  const failEvents = (sel: string) => ({ events: (calls: Call[]) => (selectOf(calls) === sel && !calls.some(([m]) => m === "update") ? { data: null, error: FAIL } : null) });
  const doors: Array<{ name: string; sel: string; go: () => ReturnType<typeof call> }> = [
    { name: "DELETE /events/:id (the event read)", sel: "title, state, starts_at", go: () => call("DELETE", `/events/${EVENT}`, undefined, "host-token") },
    { name: "POST /events/:id/cancel (the event read)", sel: "title, state, starts_at", go: () => call("POST", `/events/${EVENT}/cancel`, { reason: "rain" }, "host-token") },
    { name: "PATCH /events/:id (the current-row read)", sel: "*", go: () => hostPatch({ title: "x" }) },
    { name: "POST /events/:id/archive (the state read)", sel: "state", go: () => archive() },
    { name: "PATCH /events/:id (getEventRole's event read)", sel: "host_id", go: () => hostPatch({ title: "x" }) },
    { name: "POST /events/:id/cancel (getEventRole's event read)", sel: "host_id", go: () => call("POST", `/events/${EVENT}/cancel`, {}, "host-token") },
  ];
  for (const door of doors) {
    it(`RED before: ${door.name} — 503, not 404 / 403`, async () => {
      const s = world("open", "public");
      const dbl = install(s, { overrides: failEvents(door.sel) });
      const r = await door.go();
      assert.equal(r.status, 503, r.raw);
      assert.equal(r.body.error, "degraded_unavailable", r.raw);
      assert.equal(ev(s).state, "open");
      assert.equal(eventWrites(dbl), 0);
    });
  }

  it("RED before: a CO-HOST whose event_roles read fails is not told 403 \"only host or co-host\" — 503", async () => {
    const s = world("open", "public");
    const dbl = install(s, { overrides: { event_roles: (calls) => (selectOf(calls) === "role" ? { data: null, error: FAIL } : null) } });
    const r = await hostPatch({ title: "x" }, "cohost-token");
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.match(r.body.message, /event access input event_roles unavailable/);
    assert.equal(eventWrites(dbl), 0);
  });

  it("GREEN before (CONTROL): a stranger — and a caller of an event that is not there — is still refused 403; only a FAILED read is 503", async () => {
    const s = world("open", "public");
    install(s);
    s.events![0]!.host_id = COHOST; // the host token is now a stranger to it
    s.event_roles = [];
    const r = await call("POST", `/events/${EVENT}/cancel`, {}, "host-token");
    assert.equal(r.status, 403, r.raw);
    s.events = [];
    const gone = await call("POST", `/events/${EVENT}/cancel`, {}, "host-token");
    assert.equal(gone.status, 403, gone.raw);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// F. Structural — every host write of a moderated column passes the hold
// ══════════════════════════════════════════════════════════════════════════════

const SRC = fileURLToPath(new URL("..", import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "test" && n !== "node_modules" && n !== "generated") walk(p, out); }
    else if (/\.tsx?$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}
interface WriteSite { file: string; enclosing: string; arg: string; argCode: string; line: number }
/** Every `.from("events")` statement in the server carrying `.update(` / `.upsert(`, with its balanced argument (comments and string contents blanked first). */
function eventWriteSites(): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const p of walk(SRC)) {
    const text = readFileSync(p, "utf8");
    if (!text.includes("events")) continue;
    const code = sanitize(text);
    const re = /\.from\(\s*["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const q = m.index + m[0].length - 1;
      if (!/^["'`]events["'`]\s*\)/.test(text.slice(q, q + 10))) continue;
      let end = m.index + ".from".length; let depth = 0;
      for (; end < code.length; end++) {
        const ch = code[end];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth < 0) break; }
        else if (ch === ";" && depth === 0) break;
      }
      const stmt = code.slice(q, end);
      const w = stmt.search(/\.(update|upsert)\(/);
      if (w < 0) continue;
      const open = q + w + stmt.slice(w).indexOf("(");
      const close = matchParen(code, open);
      const before = text.slice(0, m.index);
      const fn = [...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*async\b|router\.(?:get|post|patch|put|delete)\(\s*"([^"]+)"/g)].pop();
      sites.push({ file: relative(SRC, p).split("\\").join("/"), enclosing: fn ? (fn[1] ?? fn[2] ?? `route ${fn[3]}`) : "(module)", arg: text.slice(open + 1, close), argCode: code.slice(open + 1, close), line: before.split("\n").length });
    }
  }
  return sites;
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** `text` of a file between two markers, and a matcher that only counts matches starting in CODE (not a comment). */
function region(file: string, fromMarker: string, toMarker: string) {
  const orig = readFileSync(join(SRC, file), "utf8");
  const san = sanitize(orig);
  const a = orig.indexOf(fromMarker);
  assert.ok(a >= 0, `${file}: ${fromMarker} not found`);
  const b = orig.indexOf(toMarker, a + fromMarker.length);
  assert.ok(b > a, `${file}: ${toMarker} not found after ${fromMarker}`);
  const at = (re: RegExp) => { const g = new RegExp(re.source, "g"); let m: RegExpExecArray | null; while ((m = g.exec(orig.slice(a, b))) !== null) if (san[a + m.index] === orig[a + m.index]) return m.index; return -1; };
  return { at, has: (re: RegExp) => at(re) >= 0 };
}

describe("F. structural — no host write of visibility or state skips the hold", () => {
  it("RED before: every events UPDATE that can write `visibility` is the moderation claim (and its undo) or one of the two host writes the hold guards", () => {
    const sites = eventWriteSites();
    assert.ok(sites.length >= 30, `vacuity: ${sites.length} events writes`);
    const visibilityCapable = sites.filter((s) => /\bvisibility\b/.test(s.argCode) || /\.\.\./.test(s.argCode) || !/^\s*\{[\s\S]*\}\s*$/.test(s.argCode));
    const LISTED: Array<{ file: string; enclosing: string; arg: RegExp; why: string }> = [
      { file: "lib/eventModerationClaim.ts", enclosing: "applyEventModeration", arg: /^\{ \.\.\.changes, updated_at: opts\.now \}$/, why: "the moderation claim (hide / remove / restore, the report's hide, the appeal)" },
      { file: "lib/eventModerationClaim.ts", enclosing: "undo", arg: /^\{ \.\.\.prior, updated_at: opts\.now \}$/, why: "the claim's own compensation" },
      { file: "routes/events.ts", enclosing: "writeEventState", arg: /^\{ state: to, updated_at: [^,]+, \.\.\.extraPatch \}$/, why: "state only: every call passes no extraPatch (eventModerationStateAuthority B)" },
      { file: "routes/events.ts", enclosing: "recountEventWaitlist", arg: /^\{ waitlist_count:[^}]*\.\.\.\(extra \?\? \{\}\) \}$/, why: "extra is { updated_at } or nothing (eventModerationStateAuthority B)" },
      { file: "routes/events.ts", enclosing: "route /events/:id", arg: /^patch$/, why: "PATCH: the hold, then a guarded write (below)" },
      { file: "routes/events.ts", enclosing: "route /events/:id/link-circle", arg: /^patch$/, why: "link-circle: the hold, then a guarded write (below)" },
    ];
    const unexpected = visibilityCapable.filter((s) => !LISTED.some((l) => l.file === s.file && l.enclosing === s.enclosing && l.arg.test(norm(s.arg)))).map((s) => `${s.file}:${s.line} (${s.enclosing}) .update(${norm(s.arg).slice(0, 100)})`);
    assert.deepEqual(unexpected, [], `events.visibility may be written past the hold:\n${unexpected.join("\n")}`);
    for (const l of LISTED) assert.equal(visibilityCapable.filter((s) => s.file === l.file && s.enclosing === l.enclosing && l.arg.test(norm(s.arg))).length, 1, `${l.file} ${l.enclosing}: gone or doubled (${l.why})`);
  });

  it("RED before: PATCH and link-circle ask the hold BEFORE any write, and make the visibility write conditional on what they read; archive asks it before its state write", () => {
    const pat = region("routes/events.ts", 'router.patch("/events/:id",', 'router.delete("/events/:id",');
    const hold = pat.at(/await refuseHostWriteUnderModeration\(sc, id, \{ visibility: visTo !== null, stateFrom: stateChanges \? \(current as any\)\.state : null \}\)/);
    assert.ok(hold >= 0, "PATCH does not ask the hold");
    assert.ok(hold < pat.at(/await writeEventState\(/), "PATCH writes state before it asks the hold");
    assert.ok(pat.has(/await guardHostVisibilityWrite\(sc[^]*?\.from\("events"\)\.update\(patch\)\.eq\("id", id\), visGuard\)\.select\("\*"\)\.single\(\)/), "PATCH's write is not guarded");
    assert.ok(pat.has(/await recordHostVisibilityChange\(sc, \{ eventId: id, actorId: user\.id, from: visGuard\.from, to: visTo, via: "edit" \}\)/), "PATCH does not record the host's change");
    const lc = region("routes/events.ts", 'router.post("/events/:id/link-circle",', 'res.json({ ok: true, circleId });');
    const lcHold = lc.at(/await refuseHostWriteUnderModeration\(sc, id, \{ visibility: true, stateFrom: null \}\)/);
    assert.ok(lcHold >= 0 && lcHold < lc.at(/\.update\(patch\)/), "link-circle does not ask the hold before its write");
    assert.ok(lc.has(/await guardHostVisibilityWrite\(sc\.from\("events"\)\.update\(patch\)\.eq\("id", id\), lcGuard\)\.select\("id"\)/), "link-circle's write is not guarded");
    const arch = region("routes/events.ts", 'router.post("/events/:id/archive",', 'router.post("/events/:id/close-rsvps",');
    const aHold = arch.at(/await refuseHostWriteUnderModeration\(sc, id, \{ visibility: false, stateFrom: \(archEv as any\)\.state \}\)/);
    assert.ok(aHold >= 0 && aHold < arch.at(/await writeEventState\(/), "archive does not ask the hold before its state write");
  });

  it("GREEN before (CONTROL): the only writeEventState calls that can move an event OUT of cancelled (to archived) are PATCH and archive — both held; syncEventState never starts from cancelled / archived", () => {
    const events = readFileSync(join(SRC, "routes/events.ts"), "utf8");
    const san = sanitize(events);
    const calls = [...san.matchAll(/writeEventState\(/g)].filter((m) => !/function\s+$/.test(san.slice(Math.max(0, m.index! - 20), m.index!)));
    const toArg = (i: number) => { const open = i + "writeEventState".length; return events.slice(open + 1, matchParen(san, open)).split(",").map((x) => x.trim())[3]; };
    const enclosing = (i: number) => { const fn = [...events.slice(0, i).matchAll(/async\s+function\s+(\w+)\s*\(|router\.(?:get|post|patch|put|delete)\(\s*"([^"]+)"/g)].pop(); return fn ? (fn[1] ?? `route ${fn[2]}`) : "(module)"; };
    const archiving = calls.map((m) => ({ to: toArg(m.index!), where: enclosing(m.index!) })).filter((c) => c.to === '"archived"' || !/^"[a-z]+"$/.test(c.to!));
    assert.deepEqual(archiving.map((c) => `${c.where} ${c.to}`).sort(), ['route /events/:id b.state as EventState', 'route /events/:id/archive "archived"', "syncEventState newState"].sort());
    const sync = region("routes/events.ts", "async function syncEventState(", "const w = await writeEventState(");
    assert.ok(sync.has(/if \(!ev \|\| !\["open", "full", "waitlist"\]\.includes\(\(ev as any\)\.state\)\) return;/), "syncEventState may start from a held state");
  });

  it("RED before: a report's hide-content writes no events row itself — it goes through the claim, which records it", () => {
    const hc = region("routes/admin.ts", 'router.post("/admin/reports/:id/hide-content",', 'if (!contentHidden && ["post", "trip", "event"].includes(target_type))');
    assert.ok(!hc.has(/\.from\("events"\)\s*\.update\(/), "hide-content writes events.visibility unrecorded");
    assert.ok(hc.has(/await applyEventModeration\(sc, req, hEv as ModeratedEventRow, \{ changes: \{ visibility: "invite_only" \}, now, activityAction: "admin_hide",/));
    assert.ok(hc.has(/action: "admin_hide", metadata: \{ reason, via: "report", report_id: req\.params\.id, \.\.\.st \}/));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G. Two events, one log: the hold is read from THIS event's record (pass 6, MB2)
// ══════════════════════════════════════════════════════════════════════════════
//
// readEventModerationHold is scoped to one event by ONE `.eq("event_id", …)`
// (lib/eventModerationClaim.ts). Every case above seeds one event's rows, so a
// mutant dropping that `.eq` survived this suite whole (MB2, independent
// verification pass 6), while a restore of event A let event B's host un-hide B.
// The fixture is helpers/twoEventModerationFixture.ts: A and B, same host,
// interleaved in one log. B was removed by its own recorded remove. A was
// restored by the newest row on the table.
//
// Each case is GREEN on the code as committed and RED under MB2 (the reader with
// the `.eq` dropped). This import sits here, after the cases above, so every
// line above keeps its number; imports are hoisted.
import { seedTwoEventModeration, type TwoEventIds } from "./helpers/twoEventModerationFixture.js";

describe("G. two events in one log — a moderation of one event never holds or releases another", () => {
  const OTHER = "b8888888-8888-4888-8888-88888888e0a0";
  const IDS: TwoEventIds = { a: OTHER, b: EVENT, admin: ADMIN, host: HOST };
  const evA = (s: Seed) => s.events!.find((e) => e.id === OTHER)!;
  const twoEvents = () => seedTwoEventModeration(world("archived", "invite_only"), IDS);
  const moderateEvent = (id: string, action: string) => call("PATCH", `/admin/events/${id}/moderate`, { action }, "admin-token");
  const hostPatchEvent = (id: string, body: Record<string, unknown>) => call("PATCH", `/events/${id}`, body, "host-token");

  it("RED under MB2: A's restore, the newest row on the table, never releases B — B's host is still held on visibility and on state", async () => {
    const s = twoEvents();
    const dbl = install(s);
    assert.deepEqual(await C.readEventModerationHold(dbl.client, EVENT), { ok: true, hold: { visibility: "admin_remove", state: "admin_remove" } }, "B is held by B's remove");
    assert.deepEqual(await C.readEventModerationHold(dbl.client, OTHER), { ok: true, hold: { visibility: null, state: null } }, "A is released by A's restore");
    const before = eventWrites(dbl);
    const v = await hostPatch({ visibility: "public" });
    assertHeld(v, "visibility");
    assert.match(v.body.message, /A moderator removed this event \(admin_remove\)/);
    assertHeld(await hostPatch({ state: "open" }), "state");
    assert.equal(eventWrites(dbl), before, "the refused PATCHes wrote nothing to events");
    // A again, through the real route: hidden (A's host held), restored (A's host released). B stays held.
    assert.equal((await moderateEvent(OTHER, "hide")).status, 200);
    assertHeld(await hostPatchEvent(OTHER, { visibility: "friends_only" }), "visibility");
    assert.equal((await moderateEvent(OTHER, "restore")).status, 200);
    assert.equal(evA(s).visibility, "public");
    const a = await hostPatchEvent(OTHER, { visibility: "friends_only" });
    assert.equal(a.status, 200, a.raw);
    assertHeld(await hostPatch({ visibility: "public" }), "visibility");
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "archived", visibility: "invite_only" }, "B is still removed");
  });

  it("RED under MB2: A's hide holds A, never B — once B is restored, B's host may change B while A stays hidden", async () => {
    const s = twoEvents();
    install(s);
    const rb = await moderate("restore");
    assert.equal(rb.status, 200, rb.raw);
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "open", visibility: "friends_only" }, "B's restore reversed B's own remove");
    assert.equal((await moderateEvent(OTHER, "hide")).status, 200);
    assertHeld(await hostPatchEvent(OTHER, { visibility: "public" }), "visibility");
    const r = await hostPatch({ visibility: "public" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "public");
    assert.equal(evA(s).visibility, "invite_only", "A's hide stands");
    assert.deepEqual(acts(s).at(-1), { action: "visibility_changed", from: "friends_only", to: "public", via: "edit", actor: HOST });
  });

  it("RED under MB2: an approved appeal of A releases A only — B's host is still held", async () => {
    const s = twoEvents();
    const { client } = install(s);
    assert.equal((await moderateEvent(OTHER, "hide")).status, 200);
    const out = await C.reverseModeratedEventOnAppeal(client, { eventId: OTHER, hostId: HOST, actorId: ADMIN, appealId: APPEAL, note: "approved" });
    assert.equal(out.outcome, "restored", JSON.stringify(out));
    assert.equal(evA(s).visibility, "public");
    const a = await hostPatchEvent(OTHER, { visibility: "friends_only" });
    assert.equal(a.status, 200, `A's appeal released A: ${a.raw}`);
    assertHeld(await hostPatch({ visibility: "public" }), "visibility");
    assertHeld(await hostPatch({ state: "open" }), "state");
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "archived", visibility: "invite_only" });
  });
});
