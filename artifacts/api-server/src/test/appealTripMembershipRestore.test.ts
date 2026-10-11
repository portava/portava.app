/**
 * Appeal-approved trip MEMBERSHIP restore, through the Trip Kernel command
 * ADMIN_RESTORE_PARTICIPANT (census-trips §91, rows TR1 / TR435).
 *
 * (services/appeals/resolveAppeal.ts case "trip_membership" and
 *  restoreTripMembershipOnAppeal at its foot; routes/appeals.ts PATCH
 *  /api/appeals/:id; domain/trips/commands/adminRestoreTripParticipant.ts;
 *  migrations 3974 / 3979.)
 *
 * THE OWNER'S RULING (OD-TRIP-1 = APPEAL_RESTORE_SEMANTICS, 2026-10-04,
 * docs/ops/owner-decisions-20261004.md): "If an appeal succeeds, restore the
 * access and permissions removed by that decision. Don't recreate missed live
 * activity or location sharing; if a trip has ended, restore access to its
 * retained record only."
 *
 * THE DEFECT THIS FILE NOW GUARDS
 * ===============================
 * The ruling was taken and the kernel command was written (3974, re-issued as
 * 3979), but the trip_membership case still said the command "does not exist",
 * never called it, and kept a direct `UPDATE trip_members SET role='member'` —
 * the Trip Kernel ratchet's last ungated writer. Every upheld removal appeal
 * deferred to "restore by hand".
 *
 * WHAT IS PROVEN
 * ==============
 *   upheld, live trip   ONE ADMIN_RESTORE_PARTICIPANT command, actor = the
 *                       approving admin (actor_role 'admin'), role = the role
 *                       at removal from the kernel's ledger, access
 *                       'membership', keyed by the appeal; the row comes back
 *                       in that role; the surviving location session is
 *                       stopped; resolveAppeal itself writes NOTHING.
 *   upheld, ended trip  access 'retained_record_only'.
 *   replay              re-resolving the same appeal sends no second command
 *                       and reports restored.
 *   command ABSENT      (3979 unapplied: the kernel answers
 *                       TRIP_COMMAND_UNKNOWN_TYPE) — noop, ZERO writes, and the
 *                       route holds the appeal under_review; once the command
 *                       exists the same PATCH restores.
 *   flag off / kernel   noop, zero writes, no command (flag off) — never a
 *   unavailable         direct write.
 *   non-admin           the approver must be an admin: refused before any
 *                       ledger read or command; a non-admin caller of the
 *                       route gets 403 and nothing is written.
 *   nothing restorable  no removal event (a pre-kernel removal) or no recorded
 *                       role: deferred to a person (restore_requires_policy),
 *                       no command, no write.
 *   present rows        'member' -> already_present with NO write (the old
 *                       UPDATE is gone); another role -> deferred, untouched.
 *
 * WHAT THE FAKE IS AND IS NOT
 * ===========================
 * PostgREST with real row matching, plus an rpc model of 3979's
 * ADMIN_RESTORE_PARTICIPANT branch: receipt-first replay, the admin capability
 * (actor_role 'admin' + profiles.role 'admin'), the status/access split, the
 * ledger re-read (this trip, this person, this role, the latest removal), the
 * existing-row refusal, the insert in the role at removal with
 * permissions.restored_by_appeal, the session stop, the event and the receipt.
 * Writes the MODEL makes are tagged `by: "kernel"`; anything else is a write
 * the application issued. It is a MODEL of the SQL, not the SQL —
 * tripKernelAdminRestore.test.ts proves the migration text.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/appealTripMembershipRestore.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { resolveAppeal, isDeferred } from "../services/appeals/resolveAppeal.js";

const APPELLANT = "aaaaaaaa-0000-0000-0000-000000000001";
const HOST      = "bbbbbbbb-0000-0000-0000-000000000002";
const ADMIN     = "cccccccc-0000-0000-0000-000000000003";
const NOT_ADMIN = "dddddddd-0000-0000-0000-000000000004";
const TRIP      = "33333333-0000-0000-0000-000000000001";
const APPEAL    = "99999999-0000-0000-0000-000000000001";
const REMOVAL   = "eeeeeeee-0000-0000-0000-000000000001";
const KEY       = `appeal:${APPEAL}:trip_membership`;

type Row = Record<string, any>;
interface Write { table: string; verb: string; payload: any; matched: number; by: "app" | "kernel" }

interface Spec {
  tables: Record<string, Row[]>;
  writes: Write[];
  commands: any[];
  /** "installed" = 3979 applied; "absent" = it is not (TRIP_COMMAND_UNKNOWN_TYPE); "unavailable" = the rpc errors. */
  kernel: "installed" | "absent" | "unavailable";
  /** One forced refusal, answered before anything else the model does. */
  forceReject?: { reason: string; extra?: Record<string, unknown> } | null;
  /** table -> resolved error for READS on that table. Never a throw. */
  failReadsOn?: Record<string, { message: string; code?: string }>;
}

function makeClient(spec: Spec): any {
  const T = spec.tables;
  const src = (t: string) => (T[t] ??= []);

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: any = null;
    let returning = false;
    let single = false;
    let orderBy: { col: string; asc: boolean } | null = null;
    let lim: number | null = null;

    const b: any = {
      select() { returning = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      upsert(p: any) { verb = "upsert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not(c: string, op: string, v: any) { if (op === "is") preds.push((r) => r[c] !== v); return b; },
      order(c: string, o?: { ascending?: boolean }) { orderBy = { col: c, asc: o?.ascending !== false }; return b; },
      range() { return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    const match = () => src(table).filter((r) => preds.every((p) => p(r)));

    async function run(): Promise<{ data: any; error: any }> {
      if (verb === "select") {
        const e = spec.failReadsOn?.[table];
        if (e) return { data: null, error: e };
        let m = match();
        if (orderBy) {
          const { col, asc } = orderBy;
          m = [...m].sort((x, y) => (x[col] === y[col] ? 0 : (x[col] < y[col] ? -1 : 1) * (asc ? 1 : -1)));
        }
        if (lim != null) m = m.slice(0, lim);
        return { data: single ? (m[0] ?? null) : m, error: null };
      }
      if (verb === "insert" || verb === "upsert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const made = rows.map((r) => ({ id: `gen-${src(table).length + 1}`, ...r }));
        src(table).push(...made);
        spec.writes.push({ table, verb, payload, matched: made.length, by: "app" });
        return { data: single ? (made[0] ?? null) : made, error: null };
      }
      if (verb === "update") {
        const m = match();
        for (const r of m) Object.assign(r, payload);
        spec.writes.push({ table, verb, payload, matched: m.length, by: "app" });
        if (!returning) return { data: null, error: null };
        return { data: single ? (m[0] ?? null) : m, error: null };
      }
      const m = match();
      T[table] = src(table).filter((r) => !m.includes(r));
      spec.writes.push({ table, verb, payload: null, matched: m.length, by: "app" });
      return { data: null, error: null };
    }
    return b;
  }

  // ── Model of 3979's ADMIN_RESTORE_PARTICIPANT branch ────────────────────────
  async function rpc(name: string, args: any) {
    assert.equal(name, "trip_kernel_execute");
    const c = args.p_command;
    spec.commands.push(c);
    if (spec.kernel === "unavailable") return { data: null, error: { message: "connection refused" } };
    const reject = (reason: string, extra: Record<string, unknown> = {}) =>
      ({ data: { ok: false, reason, ...extra, contract_version: 2 }, error: null });
    if (spec.forceReject) { const f = spec.forceReject; spec.forceReject = null; return reject(f.reason, f.extra ?? {}); }
    // 3979 unapplied: the installed function has no such branch. It refuses
    // the type before it touches a row — one transaction, nothing written.
    if (spec.kernel === "absent" || c.type !== "ADMIN_RESTORE_PARTICIPANT") return reject("TRIP_COMMAND_UNKNOWN_TYPE");
    const kw = (table: string, verb: string, payload: any) => spec.writes.push({ table, verb, payload, matched: 1, by: "kernel" });

    const trip = src("trips").find((t) => t.id === c.trip_id);
    if (!trip) return reject("TRIP_NOT_FOUND");
    const receipt = src("trip_command_receipts").find((r) => r.trip_id === c.trip_id && r.idempotency_key === c.idempotency_key);
    if (receipt) {
      if (receipt.actor_user_id !== c.actor_user_id || receipt.actor_role !== c.actor_role) return reject("TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN");
      return { data: { ok: true, duplicate: true, version: receipt.result_version, event_id: receipt.event_id, result: receipt.result_json, contract_version: 2 }, error: null };
    }
    const prof = src("profiles").find((p) => p.id === c.actor_user_id);
    if (c.actor_role !== "admin" || prof?.role !== "admin") return reject("TRIP_AUTH_NOT_ADMIN");
    const p = c.payload;
    if (p.user_id === c.actor_user_id) return reject("TRIP_COMMAND_MALFORMED", { detail: "an admin cannot restore themselves" });
    if (!["member", "co_host", "viewer", "invited"].includes(p.role)) return reject("TRIP_COMMAND_MALFORMED");
    if (["completed", "archived", "cancelled"].includes(trip.status)) {
      if (p.access !== "retained_record_only") return reject("TRIP_RESTORE_ACCESS_MISMATCH");
    } else if (["planning", "active"].includes(trip.status)) {
      if (p.access !== "membership") return reject("TRIP_RESTORE_ACCESS_MISMATCH");
    } else return reject("TRIP_RESTORE_TRIP_STATUS_UNKNOWN");
    const removals = src("trip_events").filter((e) => e.trip_id === c.trip_id && e.type === "trip.participant_removed"
      && e.payload_json?.result?.user_id === p.user_id);
    const ev = removals.find((e) => e.event_id === p.removal_event_id && e.payload_json?.payload?.role_at_removal === p.role);
    if (!ev) return reject("TRIP_RESTORE_REMOVAL_NOT_RECORDED");
    if (removals.some((e) => e.sequence > ev.sequence)) return reject("TRIP_RESTORE_NOT_LATEST_REMOVAL");
    const existing = src("trip_members").find((m) => m.trip_id === c.trip_id && m.user_id === p.user_id);
    if (existing) return reject("TRIP_PARTICIPANT_ALREADY_EXISTS", { current_role: existing.role });

    const row = { trip_id: c.trip_id, user_id: p.user_id, role: p.role, status: p.role === "invited" ? "invited" : "accepted",
                  permissions: { access: p.access, restored_by_appeal: p.appeal_id } };
    src("trip_members").push(row); kw("trip_members", "insert", row);
    let stopped = 0;
    for (const s of src("trip_crew_location_sessions")) {
      if (s.trip_id === c.trip_id && s.user_id === p.user_id && s.status === "active") { s.status = "stopped"; stopped++; }
    }
    if (stopped) kw("trip_crew_location_sessions", "update", { status: "stopped" });
    trip.version += 1;
    const result = { trip_id: c.trip_id, user_id: p.user_id, role: p.role, access: p.access, live_sharing_restored: false, sessions_stopped: stopped };
    const event = { event_id: `evt-${src("trip_events").length + 1}`, trip_id: c.trip_id, sequence: src("trip_events").length + 1,
                    type: "trip.participant_added", payload_json: { payload: { ...p, via: "admin_restore" }, result } };
    src("trip_events").push(event); kw("trip_events", "insert", event);
    src("trip_command_receipts").push({ trip_id: c.trip_id, idempotency_key: c.idempotency_key, actor_user_id: c.actor_user_id,
      actor_role: c.actor_role, command_type: c.type, event_id: event.event_id, result_version: trip.version, result_json: result });
    kw("trip_command_receipts", "insert", null);
    return { data: { ok: true, duplicate: false, version: trip.version, event_id: event.event_id, sequence: event.sequence, result, contract_version: 2 }, error: null };
  }

  return {
    from,
    rpc,
    auth: {
      getUser: async (token: string) => {
        if (token === "appellant-token") return { data: { user: { id: APPELLANT } }, error: null };
        if (token === "admin-token") return { data: { user: { id: ADMIN } }, error: null };
        if (token === "user-token") return { data: { user: { id: NOT_ADMIN } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

/** The kernel's own removal record: REMOVE_PARTICIPANT's trip.participant_removed (2450 writes role_at_removal). */
function removalEvent(role: string | null, over: Row = {}): Row {
  return {
    event_id: REMOVAL, trip_id: TRIP, sequence: 7, type: "trip.participant_removed",
    payload_json: { payload: role == null ? {} : { role_at_removal: role }, result: { trip_id: TRIP, user_id: APPELLANT } },
    ...over,
  };
}

interface SpecOpts {
  members?: Row[];
  tripStatus?: string;
  events?: Row[];
  kernelOn?: boolean;
  kernel?: Spec["kernel"];
  failReadsOn?: Spec["failReadsOn"];
}

function spec(o: SpecOpts = {}): Spec {
  return {
    tables: {
      trip_members: o.members ?? [],
      trips: [{ id: TRIP, owner_id: HOST, status: o.tripStatus ?? "planning", version: 4 }],
      trip_events: o.events ?? [removalEvent("co_host")],
      trip_command_receipts: [],
      trip_crew_location_sessions: [{ trip_id: TRIP, user_id: APPELLANT, status: "active" }],
      feature_flags: o.kernelOn === false ? [] : [{ flag: "trip_kernel_enabled", enabled: true }],
      profiles: [{ id: ADMIN, role: "admin" }, { id: NOT_ADMIN, role: "user" }, { id: APPELLANT, role: "user" }],
    },
    writes: [],
    commands: [],
    kernel: o.kernel ?? "installed",
    failReadsOn: o.failReadsOn,
  };
}

const APPEAL_ROW = {
  id: APPEAL,
  appellant_id: APPELLANT,
  target_type: "trip_membership",
  target_id: TRIP,
  resolution_note: null,
  moderator_id: ADMIN,
};

const appWrites = (s: Spec) => s.writes.filter((w) => w.by === "app");

// ── The unit: resolveAppeal's trip_membership case ───────────────────────────

describe("resolveAppeal trip_membership — an upheld removal is restored through ADMIN_RESTORE_PARTICIPANT", () => {
  it("live trip: ONE kernel command, the role at removal, access 'membership', keyed by the appeal; the app writes nothing", async () => {
    const s = spec();
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });

    assert.deepEqual(r, { ok: true, action: "trip_membership_restored", restored: true });
    assert.equal(s.commands.length, 1);
    const c = s.commands[0];
    assert.equal(c.type, "ADMIN_RESTORE_PARTICIPANT");
    assert.equal(c.actor_user_id, ADMIN, "the actor is the approving admin, never the appellant");
    assert.equal(c.actor_role, "admin");
    assert.equal(c.trip_id, TRIP);
    assert.equal(c.idempotency_key, KEY, "the key is the APPEAL, so a re-drive replays");
    assert.equal(c.expected_trip_version, null);
    assert.equal(c.payload.user_id, APPELLANT);
    assert.equal(c.payload.role, "co_host", "the ruling: the access and permissions REMOVED — a co_host returns as co_host");
    assert.equal(c.payload.access, "membership");
    assert.equal(c.payload.removal_event_id, REMOVAL);
    assert.equal(c.payload.appeal_id, APPEAL);

    const row = s.tables.trip_members.find((m) => m.user_id === APPELLANT)!;
    assert.equal(row.role, "co_host");
    assert.equal(row.permissions.restored_by_appeal, APPEAL);
    assert.equal(s.tables.trip_crew_location_sessions[0].status, "stopped", "missed location sharing is not recreated");
    assert.deepEqual(appWrites(s), [], `resolveAppeal must not write trip tables itself; saw ${JSON.stringify(appWrites(s))}`);
  });

  it("ENDED trip: access to its retained record only", async () => {
    const s = spec({ tripStatus: "completed" });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });

    assert.deepEqual(r, { ok: true, action: "trip_record_access_restored", restored: true });
    assert.equal(s.commands[0].payload.access, "retained_record_only");
    assert.equal(s.tables.trip_members[0].permissions.access, "retained_record_only");
  });

  it("idempotent: re-resolving the same appeal sends no second command and still reports restored", async () => {
    const s = spec();
    const client = makeClient(s);
    const first = await resolveAppeal(client, { ...APPEAL_ROW });
    const second = await resolveAppeal(client, { ...APPEAL_ROW });

    assert.deepEqual(first, second);
    assert.equal(s.commands.length, 1, "the row this appeal restored is recognised; no second command");
    assert.equal(s.tables.trip_members.length, 1);
    assert.equal(s.tables.trip_events.filter((e) => e.type === "trip.participant_added").length, 1);
  });

  it("idempotent at the kernel too: a duplicate receipt is a restore, not a failure", async () => {
    const s = spec();
    await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    // The row is gone again (removed after the restore), the receipt stays:
    // the same key replays the recorded answer and makes no second transition.
    s.tables.trip_members = [];
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.deepEqual(r, { ok: true, action: "trip_membership_restored", restored: true });
    assert.equal(s.commands.length, 2);
    assert.equal(s.tables.trip_events.filter((e) => e.type === "trip.participant_added").length, 1);
  });

  it("command ABSENT (3979 unapplied): a clear noop naming the migration, and ZERO writes of any kind", async () => {
    const s = spec({ kernel: "absent" });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });

    assert.equal(r.ok, false);
    assert.equal(r.action, "noop", "not deferred: the appeal must stay open so it can be re-driven once 3979 is applied");
    assert.match(String((r as any).reason), /TRIP_COMMAND_UNKNOWN_TYPE/);
    assert.match(String((r as any).reason), /3979/);
    assert.equal(s.commands.length, 1);
    assert.deepEqual(s.writes, [], "no partial restore: nothing was written by anyone");
    assert.equal(s.tables.trip_members.length, 0);
    assert.equal(s.tables.trip_crew_location_sessions[0].status, "active", "not even the session stop ran");
  });

  it("trip_kernel_enabled OFF: no command, no direct write, a noop — there is no legacy twin", async () => {
    const s = spec({ kernelOn: false });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });

    assert.equal(r.ok, false);
    assert.match(String((r as any).reason), /TRIP_KERNEL_DISABLED/);
    assert.equal(s.commands.length, 0);
    assert.deepEqual(s.writes, []);
  });

  it("kernel UNAVAILABLE (rpc error): a noop, nothing written", async () => {
    const s = spec({ kernel: "unavailable" });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.equal(r.ok, false);
    assert.match(String((r as any).reason), /TRIP_KERNEL_UNAVAILABLE/);
    assert.deepEqual(s.writes, []);
  });

  it("a NON-ADMIN approver cannot trigger it: refused before any command, nothing written", async () => {
    const s = spec();
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW, moderator_id: NOT_ADMIN });
    assert.equal(r.ok, false);
    assert.match(String((r as any).reason), /not an admin/);
    assert.equal(s.commands.length, 0);
    assert.deepEqual(s.writes, []);

    const none = spec();
    const r2 = await resolveAppeal(makeClient(none), { ...APPEAL_ROW, moderator_id: null });
    assert.equal(r2.ok, false, "an unattributed approval is not an admin");
    assert.equal(none.commands.length, 0);
  });

  it("the kernel's own admin check is honoured too: TRIP_AUTH_NOT_ADMIN is a noop", async () => {
    const s = spec();
    s.forceReject = { reason: "TRIP_AUTH_NOT_ADMIN" };
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.equal(r.ok, false);
    assert.match(String((r as any).reason), /TRIP_AUTH_NOT_ADMIN/);
    assert.deepEqual(s.writes, []);
  });

  it("no removal on the ledger (a pre-kernel removal): deferred to a person, no command, no write", async () => {
    const s = spec({ events: [] });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.equal(r.action, "restore_requires_policy");
    assert.ok(isDeferred(r));
    assert.match(String((r as any).reason), /no_removal_recorded/);
    assert.equal(s.commands.length, 0);
    assert.deepEqual(s.writes, []);
    const ev = (r as any).evidence;
    assert.deepEqual(ev, { appealId: APPEAL, targetType: "trip_membership", targetId: TRIP, userId: APPELLANT });
  });

  it("a removal whose role was never recorded: deferred, never guessed as 'member'", async () => {
    const s = spec({ events: [removalEvent(null)] });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.ok(isDeferred(r));
    assert.match(String((r as any).reason), /role_not_recorded/);
    assert.equal(s.commands.length, 0);
    assert.equal(s.tables.trip_members.length, 0);
  });

  it("an unreadable ledger is a retry (noop), not an answer", async () => {
    const s = spec({ failReadsOn: { trip_events: { message: "statement timeout" } } });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.equal(r.ok, false);
    assert.match(String((r as any).reason), /removal record unreadable/);
    assert.equal(s.commands.length, 0);
  });

  it("a later removal on the ledger (the kernel's re-check) defers; a full crew holds (noop) and names the undecided cap", async () => {
    const s = spec();
    s.forceReject = { reason: "TRIP_RESTORE_NOT_LATEST_REMOVAL", extra: { detail: "a later removal of this person is on record" } };
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.ok(isDeferred(r));
    assert.match(String((r as any).reason), /TRIP_RESTORE_NOT_LATEST_REMOVAL/);

    const full = spec();
    full.forceReject = { reason: "TRIP_PARTICIPANT_CAPACITY_REACHED" };
    const r2 = await resolveAppeal(makeClient(full), { ...APPEAL_ROW });
    assert.equal(r2.ok, false);
    assert.equal(r2.action, "noop");
    assert.match(String((r2 as any).reason), /crew cap/);
    assert.deepEqual(full.writes, []);
  });

  it("a row that appears between the read and the command: judged like a present row, nothing written", async () => {
    const s = spec();
    s.forceReject = { reason: "TRIP_PARTICIPANT_ALREADY_EXISTS", extra: { current_role: "member" } };
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.deepEqual(r, { ok: true, action: "trip_membership_already_present" });
    assert.deepEqual(s.writes, []);
  });

  it("row present as member: already_present, and NO write at all (the old SET role='member' is gone)", async () => {
    const s = spec({ members: [{ trip_id: TRIP, user_id: APPELLANT, role: "member", status: "accepted" }] });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.deepEqual(r, { ok: true, action: "trip_membership_already_present" });
    assert.equal(isDeferred(r), false);
    assert.deepEqual(s.writes, []);
    assert.equal(s.commands.length, 0);
  });

  it("row present as co_host (not restored by this appeal): deferred, and NOT demoted", async () => {
    const s = spec({ members: [{ trip_id: TRIP, user_id: APPELLANT, role: "co_host", status: "accepted" }] });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.equal(r.action, "restore_requires_policy");
    assert.equal(s.tables.trip_members[0].role, "co_host");
    assert.deepEqual(s.writes, []);
    assert.equal(s.commands.length, 0);
  });

  it("member read failure resolves (not throws) as a noop — the appeal must not approve", async () => {
    const s = spec({ failReadsOn: { trip_members: { message: "connection terminated unexpectedly", code: "57P01" } } });
    const r = await resolveAppeal(makeClient(s), { ...APPEAL_ROW });
    assert.equal(r.ok, false);
    assert.equal(r.action, "noop");
    assert.match(String((r as any).reason), /trip member read failed/);
  });
});

// ── The route: what an admin and the appellant are told ──────────────────────

function startServer(client: any): Promise<{ url: string; close: () => Promise<void> }> {
  _setTestClient(client, true);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections?.();
          srv.close((e) => (e ? rej(e) : res()));
        }),
      });
    });
    srv.on("error", reject);
  });
}

function routeSpec(o: SpecOpts = {}): Spec {
  const s = spec(o);
  s.tables.appeals = [{
    id: APPEAL,
    appellant_id: APPELLANT,
    target_type: "trip_membership",
    target_id: TRIP,
    reason: "I was removed from this trip without cause and would like it reviewed.",
    state: "under_review",
    evidence_url: null,
    resolution_note: null,
    moderator_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }];
  s.tables.notifications = [];
  return s;
}

/**
 * What PATCH /api/appeals/:id returns, on the success path and on the refusal
 * path alike. Every field is optional because a 422 `reversal_failed` carries
 * `error` and `message` and none of the rest.
 */
interface PatchAppealBody {
  id?: string;
  state?: string;
  reversalAction?: string;
  restored?: boolean;
  restorationRequired?: string;
  restorationQueue?: string;
  error?: string;
  message?: string;
}

async function approve(url: string, token = "admin-token"): Promise<{ status: number; body: PatchAppealBody }> {
  const res = await fetch(`${url}/api/appeals/${APPEAL}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: "approved" }),
  });
  return { status: res.status, body: (await res.json()) as PatchAppealBody };
}

describe("PATCH /api/appeals/:id — approving a trip_membership appeal whose member was removed", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("restores through the kernel, approves, and tells the appellant the removal was reversed", async () => {
    const s = routeSpec();
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url);

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.state, "approved");
    assert.equal(body.restored, true);
    assert.equal(body.reversalAction, "trip_membership_restored");
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0].actor_user_id, ADMIN, "the actor is the admin from the verified token");
    assert.equal(s.tables.trip_members[0].role, "co_host");
    const notif = s.tables.notifications[0];
    assert.match(String(notif.body), /has been reversed/);
    assert.equal(notif.metadata.restored, true);
  });

  it("command ABSENT: 422, the appeal stays under_review, nothing written; once 3979 is applied the same PATCH restores", async () => {
    const s = routeSpec({ kernel: "absent" });
    const client = makeClient(s);
    server = await startServer(client);

    const first = await approve(server.url);
    assert.equal(first.status, 422, `got ${first.status} ${JSON.stringify(first.body)}`);
    assert.equal(first.body.error, "reversal_failed");
    assert.match(String(first.body.message), /3979/);
    assert.equal(s.tables.appeals[0].state, "under_review", "not closed on a restoration that did not happen");
    assert.equal(s.tables.trip_members.length, 0);
    assert.equal(s.tables.notifications.length, 0, "the appellant is told nothing that is not true");
    assert.deepEqual(s.writes, []);

    s.kernel = "installed"; // the owner applies 3979
    const second = await approve(server.url);
    assert.equal(second.status, 200, `got ${second.status} ${JSON.stringify(second.body)}`);
    assert.equal(second.body.restored, true);
    assert.equal(s.tables.trip_members.length, 1);
  });

  it("nothing restorable on the ledger: the appeal still resolves, restored:false, and the appellant is not told it was reversed", async () => {
    const s = routeSpec({ events: [] });
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url);

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.state, "approved");
    assert.equal(body.restored, false);
    assert.equal(body.reversalAction, "restore_requires_policy");
    assert.match(String(body.restorationRequired), /APPEAL_RESTORE_SEMANTICS/);
    const notif = s.tables.notifications[0];
    assert.doesNotMatch(String(notif.body), /has been reversed/);
    assert.match(String(notif.body), /by hand/);
    assert.equal(notif.metadata.restored, false);
    assert.equal(s.tables.trip_members.length, 0);
  });

  it("a resolved read error holds the appeal under_review (422 reversal_failed), not approved", async () => {
    const s = routeSpec({ failReadsOn: { trip_members: { message: "connection terminated unexpectedly", code: "57P01" } } });
    server = await startServer(makeClient(s));

    const { status, body } = await approve(server.url);

    assert.equal(status, 422, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "reversal_failed");
    assert.equal(s.tables.appeals[0].state, "under_review", "a DB failure must not close the appeal");
  });

  it("a NON-ADMIN caller is refused at the door: 403, no command, nothing written", async () => {
    const s = routeSpec();
    server = await startServer(makeClient(s));

    const { status } = await approve(server.url, "user-token");

    assert.equal(status, 403);
    assert.equal(s.commands.length, 0);
    assert.deepEqual(s.writes, []);
    assert.equal(s.tables.appeals[0].state, "under_review");
  });
});
