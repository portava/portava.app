/**
 * census-trust (wave 5, 2026-10-18) — a moderator's restore never widens an
 * event's visibility.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventModerationVisibilityRestore.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT (PRIVACY). PATCH /admin/events/:eventId/moderate `hide` writes
 * visibility `invite_only` (and `remove` writes `invite_only` and archives).
 * `restore` wrote `public` over EVERY event, whatever it held before the hide:
 * a friends-only or circle event came back PUBLIC — to every feed, search and
 * the public-read policy. It did so for an event a moderator only CANCELLED
 * (visibility untouched), and for a host's own invite-only event too. An
 * approved event appeal never put visibility back at all.
 *
 * THE FIX (lib/eventModerationClaim.ts). Every action that writes visibility
 * records on its own event_activity_log row the value it found and the value
 * it wrote (metadata.from_visibility / to_visibility). A restore — the route's
 * and the appeal's alike — goes back to EXACTLY the value the newest recorded
 * hide / remove found; with nothing to reverse it leaves visibility as it is;
 * and a hide that never recorded what it found (it predates the record) is
 * REFUSED with nothing written: the event keeps `invite_only`, the most
 * restrictive event_visibility label.
 *
 * DOUBLES: helpers/adminModerationDouble.ts (schemaStrictSupabase + the stated
 * additions: paging, a row cap, read overrides, increasing insert ids). The
 * double's `.order()` keeps only the last key (id): seeded rows have ids that
 * sort as their times do, and every inserted row sorts above them.
 *
 * Each case says whether it was RED or GREEN on the code before this change
 * (6f0eea215). The new exports are imported as a namespace, so on the old code
 * a missing export fails ITS case, not the file.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import * as claimLib from "../lib/eventModerationClaim.js";
import { resolveAppeal } from "../services/appeals/resolveAppeal.js";
import adminRouter from "../routes/admin.js";
import { sanitize } from "../scripts/lib/supabaseCallScan.js";
import { installModerationDouble, isListRead } from "./helpers/adminModerationDouble.js";
import type { Seed, Row } from "./helpers/schemaStrictSupabase.js";

const C: any = claimLib;

const ADMIN  = "a1111111-1111-4111-8111-11111111c0a0";
const HOST   = "a3333333-3333-4333-8333-33333333c0a0";
const EVENT  = "b4444444-4444-4444-8444-44444444c0a0";
const APPEAL = "c9999999-9999-4999-8999-99999999c0a0";
const TOKENS: Record<string, string> = { "admin-token": ADMIN };
const FAIL = { message: "simulated failure", code: "57014" };

const at = (n: number) => new Date(Date.UTC(2026, 9, 2, 0, 0, n)).toISOString();
const rowId = (n: number) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
/** A seeded activity row; `n` orders it (ids and times both increase with n). */
const row = (n: number, action: string, metadata: Record<string, unknown>): Row => ({
  id: rowId(n), event_id: EVENT, actor_id: ADMIN, action, metadata: { reason: null, ...metadata }, created_at: at(100 + n),
});
/** A hide / remove / restore that recorded the visibility it found and wrote. */
const vrec = (n: number, action: string, from: string, to: string, extra: Record<string, unknown> = {}) => row(n, action, { from_visibility: from, to_visibility: to, ...extra });
/** A row written before the visibility record existed: it says nothing about the visibility it found. */
const legacy = (n: number, action: string, extra: Record<string, unknown> = {}) => row(n, action, extra);

function world(state: string, visibility: string): Seed {
  return {
    profiles: [
      { id: ADMIN, handle: "admin", username: "admin", name: "admin", display_name: "admin", role: "admin", account_status: "active", created_at: at(0) },
      { id: HOST, handle: "host", username: "host", name: "host", display_name: "host", role: "user", account_status: "active", created_at: at(0) },
    ],
    admin_access_log: [], user_account_states: [], compass_settings: [], moderation_actions: [], reports: [], event_activity_log: [], event_rsvps: [],
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }],
    events: [{ id: EVENT, host_id: HOST, title: "Visible event", state, visibility, featured: false, city: "Manila", starts_at: at(15), created_at: at(15), updated_at: at(15) }],
  };
}
const ev = (s: Seed) => s.events!.find((e) => e.id === EVENT)!;
const install = (s: Seed, o: Parameters<typeof installModerationDouble>[1] = {}) => installModerationDouble(s, { tokens: TOKENS, ...o });
const visRecords = (s: Seed) => s.event_activity_log!.map((a) => ({ action: a.action, from: (a.metadata as any)?.from_visibility, to: (a.metadata as any)?.to_visibility }));

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(adminRouter);
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

async function moderate(action: string, body: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/admin/events/${EVENT}/moderate`, { method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" }, body: JSON.stringify({ action, ...body }) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}

// ══════════════════════════════════════════════════════════════════════════════
// A. The decision — pure
// ══════════════════════════════════════════════════════════════════════════════

describe("A. decideEventVisibilityReversal — back only to what a recorded hide found", () => {
  it("RED before (a new decision): a recorded hide or remove that still holds goes back to EXACTLY the value it found; nothing else moves, and nothing is ever guessed", () => {
    assert.equal(typeof C.decideEventVisibilityReversal, "function", "decideEventVisibilityReversal is not exported");
    assert.equal(C.EVENT_HIDDEN_VISIBILITY, "invite_only", "the value hide and remove write");
    const d = (cur: string, rec: any) => C.decideEventVisibilityReversal(cur, rec);
    const rec = (action: string, from: string, to: string) => ({ kind: "recorded", action, from, to });
    for (const v of ["public", "friends_only", "circle", "trip"]) {
      assert.deepEqual(d("invite_only", rec("admin_hide", v, "invite_only")), { kind: "reverse", from: "invite_only", to: v }, `a hidden ${v} event goes back to ${v}`);
      assert.deepEqual(d("invite_only", rec("admin_remove", v, "invite_only")), { kind: "reverse", from: "invite_only", to: v }, `a removed ${v} event goes back to ${v}`);
    }
    // Nothing to reverse: the value is the host's own, and it is KEPT.
    const keeps: Array<[string, any]> = [
      ["invite_only", null], ["invite_only", undefined], ["invite_only", { kind: "none" }],
      ["invite_only", rec("admin_restore", "invite_only", "friends_only")],   // already restored; the host chose invite_only since
      ["invite_only", { kind: "unrecorded", action: "admin_restore" }],       // a restore that recorded nothing (or the old one, which wrote public)
      ["friends_only", rec("admin_hide", "public", "invite_only")],           // the host changed it since the hide
      ["friends_only", { kind: "unrecorded", action: "admin_hide" }],
      ["invite_only", rec("admin_hide", "public", "friends_only")],           // a record that does not leave the event where it is
    ];
    for (const [cur, r] of keeps) {
      const out = d(cur, r);
      assert.equal(out.kind, "keep", `${cur} / ${JSON.stringify(r)}: ${JSON.stringify(out)}`);
      assert.match(out.why, /\S/, "a keep says why");
    }
    // A hide that never recorded what it found, still holding: refused — unknowable, and any guess can only widen.
    for (const action of ["admin_hide", "admin_remove"]) {
      const out = d("invite_only", { kind: "unrecorded", action });
      assert.equal(out.kind, "unknown", action);
      assert.match(out.why, /did not record the visibility it found.*will not widen it.*keeps 'invite_only', the most restrictive visibility/);
    }
  });

  it("RED before (a new constant): the route's hide and remove write exactly the value the decision treats as hidden, and the route writes no other visibility literal", () => {
    const src = readFileSync(fileURLToPath(new URL("../routes/admin.ts", import.meta.url)), "utf8");
    const a = src.indexOf('router.patch("/admin/events/:eventId/moderate",');
    const b = src.indexOf("// ── Invite-link slot reconciliation", a);
    assert.ok(a > 0 && b > a, "the moderate route was not found");
    const code = sanitize(src.slice(a, b));
    const literal = [...src.slice(a, b).matchAll(/patch\.visibility\s*=\s*("[^"]*")/g)].filter((m) => code[m.index!] === "p").map((m) => JSON.parse(m[1]!));
    assert.deepEqual(literal, [C.EVENT_HIDDEN_VISIBILITY, C.EVENT_HIDDEN_VISIBILITY], "hide and remove write the hidden value; restore writes no literal (it wrote \"public\")");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B. The moderate route — over the real router
// ══════════════════════════════════════════════════════════════════════════════

describe("B. PATCH /admin/events/:eventId/moderate — restore never widens", () => {
  it("RED before: a FRIENDS-ONLY event hidden then restored is friends-only again — it came back PUBLIC; both rows record the visibility", async () => {
    const s = world("open", "friends_only");
    install(s);
    const h = await moderate("hide", { reason: "spam" });
    assert.equal(h.status, 200, h.raw);
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(visRecords(s), [{ action: "admin_hide", from: "friends_only", to: "invite_only" }], "the hide records what it found");
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "friends_only");
    assert.deepEqual(r.body.visibility, { from: "invite_only", to: "friends_only" }, "the answer names the visibility change");
    assert.deepEqual(visRecords(s).at(-1), { action: "admin_restore", from: "invite_only", to: "friends_only" }, "the restore is itself recorded");
    assert.equal(ev(s).state, "open", "the state was not touched");
  });

  it("RED before: a CIRCLE event hidden then restored is a circle event again — it came back PUBLIC", async () => {
    const s = world("open", "circle");
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "circle");
  });

  it("RED before: hide and restore, again and again, keep coming back to friends-only", async () => {
    const s = world("open", "friends_only");
    install(s);
    for (let i = 0; i < 3; i++) {
      assert.equal((await moderate("hide")).status, 200);
      assert.equal(ev(s).visibility, "invite_only");
      const r = await moderate("restore");
      assert.equal(r.status, 200, r.raw);
      assert.equal(ev(s).visibility, "friends_only", `round ${i + 1}`);
    }
  });

  it("GREEN before (CONTROL): a PUBLIC event hidden then restored is public again", async () => {
    const s = world("open", "public");
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "public");
  });

  it("RED before: a friends-only event REMOVED then restored is open and friends-only again — state and visibility from the one record", async () => {
    const s = world("open", "friends_only");
    install(s);
    const m = await moderate("remove");
    assert.equal(m.status, 200, m.raw);
    assert.equal(ev(s).state, "archived");
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(visRecords(s), [{ action: "admin_remove", from: "friends_only", to: "invite_only" }]);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "open");
    assert.equal(ev(s).visibility, "friends_only");
    assert.deepEqual(r.body.state, { from: "archived", to: "open" });
    assert.deepEqual(r.body.visibility, { from: "invite_only", to: "friends_only" });
  });

  it("RED before: a circle event a moderator only CANCELLED is a circle event after the restore — the restore made it public", async () => {
    const s = world("open", "circle");
    install(s);
    assert.equal((await moderate("cancel")).status, 200);
    assert.equal(ev(s).visibility, "circle", "a cancel does not touch visibility");
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "open");
    assert.equal(ev(s).visibility, "circle");
    assert.equal(r.body.visibility, undefined, "no visibility change is named");
  });

  it("RED before: a host's OWN invite-only event (no moderation record) never becomes public on a restore", async () => {
    const s = world("open", "invite_only");
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "invite_only");
    assert.equal(r.body.visibility, undefined);
  });

  it("RED before: a host's own invite-only event a moderator cancelled comes back open and STILL invite-only", async () => {
    const s = world("open", "invite_only");
    install(s);
    assert.equal((await moderate("cancel")).status, 200);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "open");
    assert.equal(ev(s).visibility, "invite_only");
  });

  it("RED before: an event hidden BEFORE the record (a hide row that says nothing of the visibility it found) is refused — 409, nothing written, never public", async () => {
    const s = world("open", "invite_only");
    s.event_activity_log = [legacy(1, "admin_hide")];
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "invalid_state_transition");
    assert.match(r.body.message, /hidden \('invite_only'\) by an admin_hide that did not record the visibility it found.*will not widen it.*Nothing was changed or recorded\./);
    assert.equal(ev(s).visibility, "invite_only");
    assert.equal(s.event_activity_log!.length, 1, "no row was written");
    assert.deepEqual(s.moderation_actions, []);
  });

  it("RED before: the newest visibility moderation is a restore that recorded nothing (the host chose invite-only since) — the restore keeps invite-only", async () => {
    const s = world("open", "invite_only");
    s.event_activity_log = [vrec(1, "admin_hide", "friends_only", "invite_only"), legacy(2, "admin_restore")];
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "invite_only");
  });

  it("RED before: a hide that changed nothing (it was already hidden) is passed over — the restore reverses the hide that did", async () => {
    const s = world("open", "friends_only");
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal((await moderate("hide")).status, 200);
    assert.deepEqual(visRecords(s).at(-1), { action: "admin_hide", from: "invite_only", to: "invite_only" }, "the second hide records no change");
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "friends_only");
  });

  it("RED before: the record is read PAST the row cap — the deciding hide sits behind more change-less rows than one page answers", async () => {
    const s = world("open", "invite_only");
    s.event_activity_log = [vrec(1, "admin_hide", "friends_only", "invite_only"), ...[2, 3, 4, 5].map((n) => vrec(n, "admin_hide", "invite_only", "invite_only"))];
    install(s, { cap: 3 });
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "friends_only", "an unpaged read sees only change-less rows and keeps invite_only");
  });

  it("RED before: a visibility record that cannot be read is a named 500 — nothing changed, no guess", async () => {
    const s = world("open", "invite_only");
    s.event_activity_log = [vrec(1, "admin_hide", "friends_only", "invite_only")];
    install(s, { overrides: { event_activity_log: (calls) => (isListRead(calls) ? { data: null, error: FAIL, count: null } : null) } });
    const r = await moderate("restore");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
    assert.match(r.body.message, /visibility record could not be read \(event_activity_log\): simulated failure.*Nothing was changed or recorded\./);
    assert.equal(ev(s).visibility, "invite_only");
    assert.equal(s.event_activity_log!.length, 1);
  });

  it("RED before: a restore whose audit row fails is undone (still hidden, its row removed), and the next restore still reverses the hide", async () => {
    const s = world("open", "friends_only");
    s.event_activity_log = [vrec(1, "admin_hide", "friends_only", "invite_only")];
    s.events![0]!.visibility = "invite_only";
    let failAudit = true;
    install(s, { overrides: { moderation_actions: (calls) => (failAudit && calls.some(([m]) => m === "insert") ? { data: null, error: { message: "audit insert refused" } } : null) } });
    const r = await moderate("restore");
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /audit row could not be written.*restored to what it held when read/);
    assert.equal(ev(s).visibility, "invite_only", "undone");
    assert.equal(s.event_activity_log!.length, 1, "the restore's own row was removed");
    failAudit = false;
    const again = await moderate("restore");
    assert.equal(again.status, 200, again.raw);
    assert.equal(ev(s).visibility, "friends_only");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C. The appeal path — services/appeals/resolveAppeal.ts
// ══════════════════════════════════════════════════════════════════════════════

describe("C. an approved event appeal puts back the visibility a recorded hide found — and never guesses", () => {
  const appeal = { id: APPEAL, appellant_id: HOST, target_type: "event", target_id: EVENT, resolution_note: "upheld", moderator_id: ADMIN };

  it("RED before: a hidden FRIENDS-ONLY event is friends-only again, and the reversal is recorded `via: appeal` — the appeal left it hidden", async () => {
    const s = world("open", "invite_only");
    s.event_activity_log = [vrec(1, "admin_hide", "friends_only", "invite_only")];
    const { client } = install(s);
    const r = await resolveAppeal(client, appeal);
    assert.deepEqual(r, { ok: true, action: "event_restored" });
    assert.equal(ev(s).visibility, "friends_only");
    assert.equal(ev(s).state, "open");
    const last = s.event_activity_log!.at(-1)!;
    assert.equal(last.action, "admin_restore");
    assert.deepEqual(last.metadata, { via: "appeal", appeal_id: APPEAL, reason: "upheld", from_visibility: "invite_only", to_visibility: "friends_only" });
  });

  it("RED before: a removed CIRCLE event is open and a circle event again — the appeal reopened it hidden", async () => {
    const s = world("archived", "invite_only");
    s.event_activity_log = [vrec(1, "admin_remove", "circle", "invite_only", { from_state: "open", to_state: "archived" })];
    const { client } = install(s);
    const r = await resolveAppeal(client, appeal);
    assert.deepEqual(r, { ok: true, action: "event_restored" });
    assert.equal(ev(s).state, "open");
    assert.equal(ev(s).visibility, "circle");
  });

  it("RED before: a hide that never recorded what it found is deferred to a person — nothing written, still invite-only", async () => {
    const s = world("open", "invite_only");
    s.event_activity_log = [legacy(1, "admin_hide")];
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.ok, true);
    assert.equal(r.action, "restore_requires_policy");
    assert.equal(r.restored, false);
    assert.match(r.reason, /did not record the visibility it found/);
    assert.equal(ev(s).visibility, "invite_only");
    assert.equal(s.event_activity_log!.length, 1);
  });

  it("RED before: a remove that recorded its state but not the visibility it found is deferred whole — it was reopened, still hidden", async () => {
    const s = world("archived", "invite_only");
    s.event_activity_log = [legacy(1, "admin_remove", { from_state: "open", to_state: "archived" })];
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.action, "restore_requires_policy");
    assert.match(r.reason, /admin_remove that did not record the visibility it found/);
    assert.equal(ev(s).state, "archived");
    assert.equal(ev(s).visibility, "invite_only");
    assert.equal(s.event_activity_log!.length, 1);
  });

  it("GREEN before (CONTROL): a host's own invite-only event with no moderation record is deferred, never made public", async () => {
    const s = world("open", "invite_only");
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.action, "restore_requires_policy");
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(s.event_activity_log, []);
  });

  it("GREEN before (CONTROL): a cancelled friends-only event comes back open and still friends-only", async () => {
    const s = world("cancelled", "friends_only");
    s.event_activity_log = [row(1, "admin_cancel", { from_state: "open", to_state: "cancelled" })];
    const { client } = install(s);
    const r = await resolveAppeal(client, appeal);
    assert.deepEqual(r, { ok: true, action: "event_restored" });
    assert.equal(ev(s).state, "open");
    assert.equal(ev(s).visibility, "friends_only");
  });

  it("RED before: an unreadable visibility record holds the appeal (noop), never a restore on a guess", async () => {
    const s = world("open", "invite_only");
    s.event_activity_log = [vrec(1, "admin_hide", "friends_only", "invite_only")];
    const { client } = install(s, { overrides: { event_activity_log: (calls) => (isListRead(calls) ? { data: null, error: FAIL, count: null } : null) } });
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.ok, false);
    assert.equal(r.action, "noop");
    assert.match(r.reason, /event restore failed: The event's visibility record could not be read/);
    assert.equal(ev(s).visibility, "invite_only");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D. Two events, one log: a restore reads only its own event's record (pass 6, MB)
// ══════════════════════════════════════════════════════════════════════════════
//
// readRecordedEventVisibility is scoped to one event by ONE `.eq("event_id", …)`
// (lib/eventModerationClaim.ts). Every case above seeds one event's rows, so a
// mutant dropping that `.eq` survived this suite whole (MB, independent
// verification pass 6), while it put event B back to PUBLIC on event A's hide.
// The fixture is helpers/twoEventModerationFixture.ts: A and B interleaved in
// one log. B was removed from friends-only by its own recorded remove. A was
// restored to public by the newest row on the table.
//
// Each case is GREEN on the code as committed and RED under MB (the reader with
// the `.eq` dropped). This import sits here, after the cases above, so every
// line above keeps its number; imports are hoisted.
import { seedTwoEventModeration, twoEventRow, TWO_EVENT_STORY, type TwoEventIds } from "./helpers/twoEventModerationFixture.js";

describe("D. two events in one log — a restore reads only its own event's visibility record", () => {
  const OTHER = "b8888888-8888-4888-8888-88888888c0a0";
  const IDS: TwoEventIds = { a: OTHER, b: EVENT, admin: ADMIN, host: HOST };
  const evA = (s: Seed) => s.events!.find((e) => e.id === OTHER)!;
  const twoEvents = () => seedTwoEventModeration(world("archived", "invite_only"), IDS);
  const moderateEvent = async (id: string, action: string) => {
    const r = await fetch(`${base}/admin/events/${id}/moderate`, { method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const raw = await r.text();
    let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    return { status: r.status, body: parsed, raw };
  };

  it("RED under MB: B's own remove decides B — the newest row on the table is A's restore, and B still goes back to friends-only", async () => {
    const s = twoEvents();
    const { client } = install(s);
    assert.deepEqual(await C.readRecordedEventVisibility(client, EVENT), { ok: true, recorded: { kind: "recorded", action: "admin_remove", from: "friends_only", to: "invite_only" } }, "B's record is B's remove");
    assert.deepEqual(await C.readRecordedEventVisibility(client, OTHER), { ok: true, recorded: { kind: "recorded", action: "admin_restore", from: "invite_only", to: "public" } }, "A's record is A's restore");
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "open", visibility: "friends_only" });
    assert.deepEqual(r.body.visibility, { from: "invite_only", to: "friends_only" });
    assert.deepEqual({ state: evA(s).state, visibility: evA(s).visibility }, { state: "open", visibility: "public" }, "A untouched");
  });

  it("RED under MB: another event's NEWER recorded hide is never B's — A hidden from public, then B restored is friends-only, not public; and A's restore then reads A's own hide", async () => {
    const s = twoEvents();
    install(s);
    const h = await moderateEvent(OTHER, "hide");
    assert.equal(h.status, 200, h.raw);
    assert.equal(evA(s).visibility, "invite_only");
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "friends_only", "B must not come back PUBLIC on A's hide");
    assert.equal(evA(s).visibility, "invite_only", "A's hide stands");
    const ra = await moderateEvent(OTHER, "restore");
    assert.equal(ra.status, 200, ra.raw);
    assert.equal(evA(s).visibility, "public", "A's restore reads A's hide, not B's newer restore");
    assert.equal(ev(s).visibility, "friends_only");
  });

  it("RED under MB: a hide of B that recorded nothing is still refused (409, nothing written) — another event's newer RECORDED hide is not what B's hide found", async () => {
    const s = twoEvents();
    s.event_activity_log!.push(twoEventRow(IDS, TWO_EVENT_STORY.length + 1, "b", "admin_hide", {})); // a hide of B that says nothing of what it found, as one written before the record
    install(s);
    assert.equal((await moderateEvent(OTHER, "hide")).status, 200);
    const rows = s.event_activity_log!.length;
    const r = await moderate("restore");
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "invalid_state_transition");
    assert.match(r.body.message, /hidden \('invite_only'\) by an admin_hide that did not record the visibility it found.*will not widen it/);
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "archived", visibility: "invite_only" });
    assert.equal(s.event_activity_log!.length, rows, "no row was written");
    assert.equal(s.moderation_actions!.length, 1, "only A's hide is audited");
  });

  it("RED under MB: an approved appeal of B puts back B's own record — A's newer hide is not B's", async () => {
    const s = twoEvents();
    const { client } = install(s);
    assert.equal((await moderateEvent(OTHER, "hide")).status, 200);
    const r = await resolveAppeal(client, { id: APPEAL, appellant_id: HOST, target_type: "event", target_id: EVENT, resolution_note: "upheld", moderator_id: ADMIN });
    assert.deepEqual(r, { ok: true, action: "event_restored" });
    assert.deepEqual({ state: ev(s).state, visibility: ev(s).visibility }, { state: "open", visibility: "friends_only" });
    assert.equal(evA(s).visibility, "invite_only", "A's hide stands");
  });
});
