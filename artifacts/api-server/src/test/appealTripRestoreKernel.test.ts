/**
 * Appeal-approved trip restore, through the Trip Kernel
 * (Trips spec §4.1 / §6.1 / §18.3 / §22.4; lib/tripKernel.ts; migration 2450;
 * services/appeals/resolveAppeal.ts case "trip").
 *
 * THE WRITE THIS IS ABOUT
 * =======================
 * resolveAppeal's "trip" case moved trips.status to 'planning' with a direct
 * UPDATE filtered `.eq("id", target_id).eq("owner_id", appellant_id)`. That is
 * canonical Trip aggregate state — trips.status is what every crew member reads
 * and what §3.1's lifecycle rules govern — so it is a KERNEL_COMMAND, not
 * something that can be classified out. UPDATE_TRIP is the command and its
 * `owner` capability is EXACTLY the authorization the legacy `.eq("owner_id",
 * appellant_id)` expressed, so the actor is the appellant.
 *
 * WHAT IS PROVEN HERE
 * ===================
 *   flag OFF   the legacy direct write runs unchanged, byte for byte (table,
 *              verb, payload, filters), the kernel is never called, and
 *              trips.version does not move.
 *   flag ON    the command is issued with the appellant as actor and
 *              actor_role 'user'; the legacy write does NOT run; the trip
 *              reaches 'planning'; exactly ONE trip.updated event and ONE
 *              outbox row exist; the receipt records the trip, the key, the
 *              command type and the actor.
 *   denial     a non-owner appellant is refused TRIP_AUTH_NOT_OWNER, and the
 *              function reports a noop instead of the "trip_restored" the
 *              legacy write reported while matching zero rows.
 *   terminal   a cancelled trip is refused TRIP_LIFECYCLE_INVALID_TRANSITION —
 *              the legacy write walked straight out of a terminal state.
 *   replay     re-resolving the same appeal is idempotent on the APPEAL id: the
 *              second call returns the receipt, and the event count stays at
 *              one. This is the "duplicate => no duplicate transition" of §22.4.
 *   version    the site sends expected_trip_version NULL on purpose, and that
 *              choice is asserted rather than assumed; and a TRIP_VERSION_CONFLICT
 *              from the kernel is surfaced as a noop and does NOT fall through
 *              to the direct write.
 *
 * WHAT THE FAKE IS AND IS NOT
 * ===========================
 * The rpc fake models public.trip_kernel_execute (2450) for UPDATE_TRIP only:
 * receipt-first replay, `owner` capability, expected-version check, §3.1
 * terminal-state refusal, then patch + version bump + event + outbox + receipt.
 * It is a MODEL of the SQL, not the SQL.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/appealTripRestoreKernel.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppeal } from "../services/appeals/resolveAppeal.js";
import { countCanonicalWrites, ungatedOf } from "../scripts/checkTripKernelWriters.js";
import { TRIP_KERNEL_DIRECT_WRITERS } from "../scripts/tripKernelWriterBaseline.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALICE = "aaaaaaaa-0000-0000-0000-000000000001"; // trip owner, the appellant
const MALLORY = "cccccccc-0000-0000-0000-000000000003"; // not the owner
const TRIP = "33333333-0000-0000-0000-000000000001";
const APPEAL = "99999999-0000-0000-0000-000000000001";
const KEY = `appeal:${APPEAL}:trip`;

interface Write { table: string; verb: string; payload: any; filters: Array<[string, any]> }
interface State {
  tables: Record<string, any[]>;
  writes: Write[];
  commands: any[];
  /** When set, the kernel answers this reason once instead of applying. */
  forceReject: string | null;
}

function baseState(kernelOn: boolean, tripStatus = "cancelled"): State {
  return {
    tables: {
      trips: [{ id: TRIP, owner_id: ALICE, version: 4, status: tripStatus, title: "Lisbon", updated_at: "2026-01-01T00:00:00.000Z" }],
      feature_flags: kernelOn ? [{ flag: "trip_kernel_enabled", enabled: true }] : [],
      trip_events: [], trip_outbox: [], trip_command_receipts: [],
    },
    writes: [], commands: [], forceReject: null,
  };
}

function makeFakeClient(state: State) {
  const T = state.tables;
  const src = (t: string) => (T[t] ??= []);

  function from(table: string) {
    const filters: Array<[string, any]> = [];
    const preds: Array<(r: any) => boolean> = [];
    let verb = "select";
    let payload: any = null;
    let single = false;
    let returning = false;
    const b: any = {
      // `.select()` makes the statement RETURNING. Modelling that is not
      // decoration: without it an UPDATE resolves `{ data: null }` whether it
      // matched every row or none, which is the exact blindness the affected-row
      // check in resolveAppeal exists to remove — a fake that cannot express
      // "zero matched, no error" cannot test it.
      select() { returning = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { filters.push([c, v]); preds.push((r) => r[c] === v); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      maybeSingle() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };
    async function run(): Promise<{ data: any; error: any }> {
      const match = () => src(table).filter((r) => preds.every((p) => p(r)));
      if (verb === "select") { const m = match(); return { data: single ? (m[0] ?? null) : m, error: null }; }
      state.writes.push({ table, verb, payload, filters });
      if (verb === "update") {
        const m = match();
        for (const r of m) Object.assign(r, payload);
        return { data: returning ? (single ? (m[0] ?? null) : m) : null, error: null };
      }
      return { data: null, error: null };
    }
    return b;
  }

  // Model of public.trip_kernel_execute (2450), UPDATE_TRIP only.
  async function rpc(name: string, args: any) {
    assert.equal(name, "trip_kernel_execute");
    const c = args.p_command;
    state.commands.push(c);
    const reject = (reason: string, extra: Record<string, unknown> = {}) =>
      ({ data: { ok: false, reason, ...extra, contract_version: 2 }, error: null });
    if (state.forceReject) { const r = state.forceReject; state.forceReject = null; return reject(r, { current_version: 9, expected_version: 4 }); }
    if (c.type !== "UPDATE_TRIP") return reject("TRIP_COMMAND_UNKNOWN_TYPE", { type: c.type });
    if (c.actor_role !== "user") return reject("TRIP_AUTH_ROLE_NOT_PERMITTED");
    const trip = T.trips.find((t) => t.id === c.trip_id);
    if (!trip) return reject("TRIP_NOT_FOUND");

    // Receipt first: a replay of the same key returns the recorded result and
    // makes no second transition (§22.4).
    const receipt = T.trip_command_receipts.find((r) => r.trip_id === c.trip_id && r.idempotency_key === c.idempotency_key);
    if (receipt) {
      if (receipt.actor_user_id !== c.actor_user_id) return reject("TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN");
      return { data: { ok: true, duplicate: true, version: receipt.result_version, event_id: receipt.event_id, result: receipt.result_json, contract_version: 2 }, error: null };
    }
    if (trip.owner_id !== c.actor_user_id) return reject("TRIP_AUTH_NOT_OWNER");
    if (c.expected_trip_version != null && c.expected_trip_version !== trip.version) {
      return reject("TRIP_VERSION_CONFLICT", { current_version: trip.version, expected_version: c.expected_trip_version });
    }
    const patch = c.payload?.patch ?? {};
    const to = patch.status ?? trip.status;
    if (to !== trip.status && ["cancelled", "archived"].includes(trip.status)) {
      return reject("TRIP_LIFECYCLE_INVALID_TRANSITION", { from: trip.status, to });
    }
    Object.assign(trip, patch, { updated_at: c.payload?.updated_at });
    trip.version += 1;
    const event_id = `evt-${T.trip_events.length + 1}`;
    T.trip_events.push({ event_id, trip_id: c.trip_id, aggregate_version: trip.version, type: "trip.updated", actor_user_id: c.actor_user_id, actor_role: c.actor_role });
    T.trip_outbox.push({ event_id, type: "trip.updated" });
    T.trip_command_receipts.push({ trip_id: c.trip_id, idempotency_key: c.idempotency_key, command_id: c.command_id, command_type: c.type, actor_user_id: c.actor_user_id, actor_role: c.actor_role, event_id, result_version: trip.version, result_json: { ...trip } });
    return { data: { ok: true, duplicate: false, version: trip.version, event_id, sequence: T.trip_events.length, result: { ...trip }, contract_version: 2 }, error: null };
  }

  return { from, rpc };
}

const appeal = (over: Partial<{ appellant_id: string }> = {}) => ({
  id: APPEAL, appellant_id: ALICE, target_type: "trip", target_id: TRIP, resolution_note: null, ...over,
});
const canonicalWrites = (s: State) => s.writes.filter((w) => ["trips", "trip_members", "trip_plan_items"].includes(w.table));

// ═════════════════════════════════════════════════════════════════════════════
describe("trip_kernel_enabled = false: the legacy direct write, unchanged", () => {
  it("performs the same UPDATE and never calls the kernel", async () => {
    const s = baseState(false, "cancelled");
    const r = await resolveAppeal(makeFakeClient(s), appeal());
    assert.deepEqual(r, { ok: true, action: "trip_restored" });
    assert.equal(s.commands.length, 0, "the flag-off path must not reach trip_kernel_execute");
    const w = canonicalWrites(s);
    assert.equal(w.length, 1);
    assert.equal(w[0].table, "trips");
    assert.equal(w[0].verb, "update");
    assert.equal(w[0].payload.status, "planning");
    assert.match(w[0].payload.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(w[0].filters, [["id", TRIP], ["owner_id", ALICE]]);
    assert.equal(s.tables.trips[0].version, 4, "the legacy path must not move trips.version");
    assert.equal(s.tables.trip_events.length, 0);
  });
});

describe("trip_kernel_enabled = true: authorized success", () => {
  it("issues UPDATE_TRIP as the appellant and does not run the legacy write", async () => {
    const s = baseState(true, "completed");
    const r = await resolveAppeal(makeFakeClient(s), appeal());
    assert.deepEqual(r, { ok: true, action: "trip_restored" });
    assert.equal(canonicalWrites(s).length, 0, "the legacy write must not run when the kernel handled it");

    assert.equal(s.commands.length, 1);
    const c = s.commands[0];
    assert.equal(c.type, "UPDATE_TRIP");
    assert.equal(c.trip_id, TRIP);
    assert.equal(c.actor_user_id, ALICE, "the actor is the appellant, whose `owner` capability IS the legacy owner_id filter");
    assert.equal(c.actor_role, "user", "this is not an admin command: the admin approved the appeal, the owner's trip is what changes");
    assert.equal(c.idempotency_key, KEY);
    assert.deepEqual(c.payload.patch, { status: "planning" });

    assert.equal(s.tables.trips[0].status, "planning");
    assert.equal(s.tables.trips[0].version, 5, "the aggregate version moves exactly once");
  });

  it("emits EXACTLY one event and one outbox row, and a correct receipt", async () => {
    const s = baseState(true, "completed");
    await resolveAppeal(makeFakeClient(s), appeal());
    assert.equal(s.tables.trip_events.length, 1);
    const e = s.tables.trip_events[0];
    assert.equal(e.type, "trip.updated");
    assert.equal(e.trip_id, TRIP);
    assert.equal(e.aggregate_version, 5, "the event carries the version it produced");
    assert.equal(e.actor_user_id, ALICE);
    assert.equal(e.actor_role, "user");
    assert.equal(s.tables.trip_outbox.length, 1);
    assert.equal(s.tables.trip_outbox[0].event_id, e.event_id);

    assert.equal(s.tables.trip_command_receipts.length, 1);
    const rec = s.tables.trip_command_receipts[0];
    assert.equal(rec.trip_id, TRIP);
    assert.equal(rec.idempotency_key, KEY);
    assert.equal(rec.command_type, "UPDATE_TRIP");
    assert.equal(rec.actor_user_id, ALICE);
    assert.equal(rec.actor_role, "user");
    assert.equal(rec.event_id, e.event_id);
    assert.equal(rec.result_version, 5);
  });
});

describe("unauthorized denial", () => {
  it("refuses a non-owner appellant and reports a noop, where the legacy write reported success over zero rows", async () => {
    const s = baseState(true, "completed");
    const r = await resolveAppeal(makeFakeClient(s), appeal({ appellant_id: MALLORY }));
    assert.deepEqual(r, { ok: false, action: "noop", reason: "trip restore refused: TRIP_AUTH_NOT_OWNER" });
    assert.equal(s.tables.trips[0].status, "completed", "nothing was restored");
    assert.equal(s.tables.trips[0].version, 4);
    assert.equal(s.tables.trip_events.length, 0, "a refused command emits no event");
    assert.equal(canonicalWrites(s).length, 0, "a kernel refusal must NOT fall back to the direct write");
  });

  it("refuses to exit a terminal state, which the legacy write did silently", async () => {
    const s = baseState(true, "cancelled");
    const r = await resolveAppeal(makeFakeClient(s), appeal());
    assert.deepEqual(r, { ok: false, action: "noop", reason: "trip restore refused: TRIP_LIFECYCLE_INVALID_TRANSITION" });
    assert.equal(s.tables.trips[0].status, "cancelled");
    assert.equal(s.tables.trip_events.length, 0);
  });
});

describe("expected version", () => {
  it("sends expected_trip_version NULL on purpose", async () => {
    // An If-Match here would mean "abandon this appeal restore if anyone touched
    // the trip since we read it". Nobody read it: the trigger is an admin
    // approving an appeal out of band, and no client is holding a version. The
    // idempotency key, not the version, is what makes this safe to repeat.
    const s = baseState(true, "completed");
    await resolveAppeal(makeFakeClient(s), appeal());
    assert.equal(s.commands[0].expected_trip_version, null);
  });

  it("surfaces a TRIP_VERSION_CONFLICT as a noop and does not fall back to the direct write", async () => {
    const s = baseState(true, "completed");
    s.forceReject = "TRIP_VERSION_CONFLICT";
    const r = await resolveAppeal(makeFakeClient(s), appeal());
    assert.deepEqual(r, { ok: false, action: "noop", reason: "trip restore refused: TRIP_VERSION_CONFLICT" });
    assert.equal(canonicalWrites(s).length, 0);
    assert.equal(s.tables.trip_events.length, 0);
  });
});

describe("idempotent replay (§22.4)", () => {
  it("re-resolving the same appeal makes no second transition", async () => {
    const s = baseState(true, "completed");
    const sc = makeFakeClient(s);
    const first = await resolveAppeal(sc, appeal());
    const second = await resolveAppeal(sc, appeal());
    assert.deepEqual(first, { ok: true, action: "trip_restored" });
    assert.deepEqual(second, { ok: true, action: "trip_restored" });
    assert.equal(s.commands.length, 2, "both calls issued a command");
    assert.equal(s.commands[0].idempotency_key, s.commands[1].idempotency_key, "the key is the appeal, not the attempt");
    assert.notEqual(s.commands[0].command_id, s.commands[1].command_id, "each attempt is its own command id");
    assert.equal(s.tables.trip_events.length, 1, "EXACTLY one event across both attempts");
    assert.equal(s.tables.trip_outbox.length, 1);
    assert.equal(s.tables.trip_command_receipts.length, 1);
    assert.equal(s.tables.trips[0].version, 5, "the version moved once, not twice");
  });

  it("refuses a replay of the key by a different actor", async () => {
    const s = baseState(true, "completed");
    const sc = makeFakeClient(s);
    await resolveAppeal(sc, appeal());
    const r = await resolveAppeal(sc, appeal({ appellant_id: MALLORY }));
    assert.deepEqual(r, { ok: false, action: "noop", reason: "trip restore refused: TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN" });
    assert.equal(s.tables.trip_events.length, 1);
  });
});

describe("the direct-write ratchet recognises the kernel path", () => {
  it("counts resolveAppeal's trip restore as gated, leaving only trip_membership ungated", () => {
    const c = countCanonicalWrites(readFileSync(join(SRC, "services/appeals/resolveAppeal.ts"), "utf8"));
    assert.equal(c.count, 2, "two canonical writes: the trip restore and the trip_membership restore");
    assert.equal(c.importsKernel, true, "the legacy marker is refused in a file that cannot back it");
    assert.equal(c.gated, 1);
    assert.equal(c.nonAggregate, 0, "neither write is classified out of the aggregate");
    assert.deepEqual(c.refusedNonAggregate, []);
    assert.equal(ungatedOf({ ...c }), 1);
  });

  it("the baseline records that one remaining ungated write", () => {
    assert.deepEqual(TRIP_KERNEL_DIRECT_WRITERS["services/appeals/resolveAppeal.ts"], { direct: 2, ungated: 1 });
  });
});
