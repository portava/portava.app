import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  attributeCompletedTravelPartnerBookings,
  PRODUCER_MAX_SCAN,
  PRODUCER_PAGE_SIZE,
} from "../services/creators/CreatorAttributionProducers.js";

const CURSORS = "creator_attribution_scan_cursors";
const BUDDY_USER = "33333333-3333-4333-8333-333333333333";
const BUDDY_PROFILE = "11111111-1111-4111-8111-111111111111";
const MISSING_PROFILE = "22222222-2222-4222-8222-222222222222";
const bookingId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
type Row = Record<string, any>;
type DbError = { code: string; message: string };

function database(count: number) {
  return {
    enabled: true,
    cursor: { producer: "travel_partner", after_booking_id: null as string | null, cycle_upper_id: null as string | null, revision: randomUUID() } as Row | null,
    bookings: Array.from({ length: count }, (_, index) => ({ id: bookingId(index + 1), buddy_id: BUDDY_PROFILE, status: "completed" })),
    profiles: [{ id: BUDDY_PROFILE, user_id: BUDDY_USER }] as Row[],
    attributions: new Map<string, Row>(),
    insertErrors: new Map<string, DbError>(),
    errors: new Map<string, DbError>(),
    replies: new Map<string, unknown>(),
    serverCap: null as number | null,
    calls: [] as Array<{ table: string; operation: string; payload: Row | null }>,
    pages: [] as Array<{ ids: string[]; limit: number | null }>,
    upperReads: [] as string[],
    afterInsert: null as (() => void) | null,
    beforeCheckpoint: null as (() => void) | null,
    checkpointReplyError: null as DbError | null,
  };
}
type Database = ReturnType<typeof database>;

function client(state: Database) {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let operation = "select";
      let payload: Row | null = null;
      let single = false;
      let limit: number | null = null;
      let offset = 0;
      let ordering: { column: string; ascending: boolean } | null = null;
      let selection = "*";
      const run = async () => {
        state.calls.push({ table, operation, payload });
        const error = state.errors.get(`${table}:${operation}`);
        if (error) return { data: null, error };
        const replyKey = table === "rent_buddy_bookings" && selection === "id" ? `${table}:upper` : table;
        if (operation === "select" && state.replies.has(replyKey)) return { data: state.replies.get(replyKey), error: null };
        let rows: Row[];
        if (table === "feature_flags") {
          rows = [{ flag: "creator_attribution_enabled", enabled: state.enabled }];
        } else if (table === CURSORS) {
          if (operation === "update") state.beforeCheckpoint?.();
          rows = state.cursor ? [state.cursor] : [];
        } else if (table === "rent_buddy_bookings") {
          rows = state.bookings;
        } else if (table === "rent_buddy_profiles") {
          rows = state.profiles;
        } else if (table === "creator_rule_versions") {
          rows = [{ creator_type: "travel_partner", rule_version: "creator-rules/travel-partner/v1", params: {}, effective_from: "2026-01-01T00:00:00Z" }];
        } else if (table === "creator_attributions") {
          if (operation === "insert") {
            assert.ok(payload);
            const refusal = state.insertErrors.get(payload.subject_id);
            if (refusal) return { data: null, error: refusal };
            if (state.attributions.has(payload.subject_id)) return { data: null, error: { code: "23505", message: "duplicate attribution" } };
            const inserted = { id: randomUUID(), ...payload };
            state.attributions.set(payload.subject_id, inserted);
            state.afterInsert?.();
            return { data: single ? inserted : [inserted], error: null };
          }
          rows = [...state.attributions.values()];
        } else {
          throw new Error(`unmodelled table ${table}`);
        }
        rows = rows.filter((row) => filters.every((filter) => filter(row)));
        if (ordering) {
          const { column, ascending } = ordering;
          rows.sort((left, right) => (left[column] < right[column] ? -1 : left[column] > right[column] ? 1 : 0) * (ascending ? 1 : -1));
        }
        const effectiveLimit = state.serverCap === null ? limit : Math.min(limit ?? Infinity, state.serverCap);
        rows = rows.slice(offset, effectiveLimit === null ? undefined : offset + effectiveLimit);
        if (operation === "update") {
          assert.equal(table, CURSORS);
          rows.forEach((row) => Object.assign(row, payload));
          if (state.checkpointReplyError) return { data: null, error: state.checkpointReplyError };
        }
        if (table === "rent_buddy_bookings") {
          if (selection === "id") state.upperReads.push(rows[0]?.id ?? "empty");
          else state.pages.push({ ids: rows.map((row) => row.id), limit });
        }
        return { data: single ? (rows[0] ? { ...rows[0] } : null) : rows.map((row) => ({ ...row })), error: null };
      };
      const builder: any = {
        select(columns = "*") { selection = columns; return builder; },
        eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return builder; },
        gt(column: string, value: any) { filters.push((row) => row[column] > value); return builder; },
        lte(column: string, value: any) { filters.push((row) => row[column] <= value); return builder; },
        in(column: string, values: unknown[]) { const allowed = new Set(values); filters.push((row) => allowed.has(row[column])); return builder; },
        order(column: string, opts: { ascending?: boolean }) { ordering = { column, ascending: opts.ascending !== false }; return builder; },
        limit(value: number) { limit = value; return builder; },
        range(start: number, end: number) { offset = start; limit = end - start + 1; return builder; },
        single() { single = true; return builder; },
        maybeSingle() { single = true; return builder; },
        insert(value: Row) { operation = "insert"; payload = value; return builder; },
        update(value: Row) { operation = "update"; payload = value; return builder; },
        then(resolve: any, reject: any) { return Promise.resolve().then(run).then(resolve, reject); },
      };
      return builder;
    },
  };
}

async function pass(state: Database, opts: { pageSize?: number; maxScan?: number } = {}) {
  const result = await attributeCompletedTravelPartnerBookings(client(state), opts);
  if (!result.ok) assert.fail(JSON.stringify(result));
  assert.ok(result.value.scanned <= (opts.maxScan ?? PRODUCER_MAX_SCAN));
  return result.value;
}

test("a persisted cursor crosses an already-attributed prefix larger than 5000 after a client restart", async () => {
  const state = database(6_203);
  for (const booking of state.bookings.slice(0, 5_200)) {
    state.attributions.set(booking.id, { subject_id: booking.id, creator_type: "travel_partner" });
  }
  const first = await pass(state);
  assert.equal(first.alreadyAttributed, 5_000);
  assert.equal(first.truncated, true);
  assert.equal(state.cursor?.after_booking_id, bookingId(5_000));
  assert.equal(state.cursor?.cycle_upper_id, bookingId(6_203));
  const second = await pass(state);
  assert.equal(second.alreadyAttributed, 200);
  assert.equal(second.attributed, 1_003);
  assert.equal(second.truncated, false);
  assert.equal(state.attributions.size, 6_203);
  assert.equal(state.cursor?.after_booking_id, null);
  assert.equal(state.cursor?.cycle_upper_id, null);
  assert.deepEqual(state.upperReads, [bookingId(6_203)]);
  assert.ok(state.pages.every((page) => page.ids.length <= PRODUCER_PAGE_SIZE));
  for (const call of state.calls.filter((entry) => entry.operation !== "select")) {
    assert.ok([CURSORS, "creator_attributions"].includes(call.table));
    if (call.table === "creator_attributions") {
      assert.deepEqual([call.payload?.gross_revenue_minor, call.payload?.provisional_share_minor, call.payload?.settled_minor], [0, 0, 0]);
    }
  }
});

test("more than 5000 pending bookings drain in bounded passes without duplicate writes", async () => {
  const state = database(5_003);
  assert.equal((await pass(state)).attributed, 5_000);
  assert.equal((await pass(state)).attributed, 3);
  assert.equal((await pass(state)).attributed, 0);
  assert.equal(state.attributions.size, 5_003);
  assert.equal(state.calls.filter((entry) => entry.operation === "insert").length, 5_003);
});

test("continuous higher-UUID arrivals cannot starve a lower-ID late completion across restarts", async () => {
  const state = database(10);
  state.serverCap = 1;
  state.bookings[0]!.status = "pending";
  await pass(state, { maxScan: 2 });
  assert.equal(state.cursor?.cycle_upper_id, bookingId(10));
  state.bookings[0]!.status = "completed";
  let nextId = 11;
  let completedByPass: number | null = null;
  for (let attempt = 1; attempt <= 9; attempt++) {
    for (let arrival = 0; arrival < 3; arrival++) {
      state.bookings.push({ id: bookingId(nextId++), buddy_id: BUDDY_PROFILE, status: "completed" });
    }
    await pass(state, { maxScan: 2 });
    if (attempt < 4) assert.equal(state.cursor?.cycle_upper_id, bookingId(10));
    if (attempt === 4) {
      assert.equal(state.cursor?.cycle_upper_id, null);
      assert.equal(state.attributions.has(bookingId(11)), false, "new higher IDs cannot extend the first cycle");
      assert.deepEqual(state.upperReads, [bookingId(10)]);
    }
    if (state.attributions.has(bookingId(1)) && completedByPass === null) completedByPass = attempt;
  }
  assert.ok(completedByPass !== null && completedByPass <= 5, `late completion still starved: ${completedByPass}`);
  await pass(state);
  await pass(state);
  assert.equal(state.attributions.size, state.bookings.length, "higher arrivals are deferred, not dropped");
});

test("a claimed cycle survives an unreadable first page and never widens on restart", async () => {
  const state = database(3);
  state.replies.set("rent_buddy_bookings", null);
  const failed = await attributeCompletedTravelPartnerBookings(client(state));
  assert.equal(!failed.ok && failed.reason, "db_error");
  assert.equal(state.cursor?.after_booking_id, null);
  assert.equal(state.cursor?.cycle_upper_id, bookingId(3));
  assert.equal(state.attributions.size, 0);
  state.replies.clear();
  state.bookings.push({ id: bookingId(4), buddy_id: BUDDY_PROFILE, status: "completed" });
  assert.equal((await pass(state)).attributed, 3);
  assert.deepEqual(state.upperReads, [bookingId(3)]);
  assert.equal(state.attributions.has(bookingId(4)), false);
  assert.equal(state.cursor?.cycle_upper_id, null);
  assert.equal((await pass(state)).attributed, 1);
  assert.deepEqual(state.upperReads, [bookingId(3), bookingId(4)]);
});

test("a failed or ambiguously committed cycle claim never starts attribution before acknowledgement", async () => {
  for (const committed of [false, true]) {
    const state = database(3);
    const error = { code: "08006", message: "cycle claim reply failed" };
    if (committed) state.checkpointReplyError = error;
    else state.errors.set(`${CURSORS}:update`, error);
    const failed = await attributeCompletedTravelPartnerBookings(client(state));
    assert.equal(!failed.ok && failed.reason, "db_error");
    assert.equal(state.attributions.size, 0);
    assert.equal(state.pages.length, 0);
    assert.equal(state.cursor?.cycle_upper_id, committed ? bookingId(3) : null);
    state.errors.clear();
    state.checkpointReplyError = null;
    state.bookings.push({ id: bookingId(4), buddy_id: BUDDY_PROFILE, status: "completed" });
    assert.equal((await pass(state)).attributed, committed ? 3 : 4);
    assert.equal((await pass(state)).attributed, committed ? 1 : 0);
    assert.equal(state.attributions.size, 4);
  }
});

test("concurrent idle workers CAS-claim one durable upper bound before writing attributions", async () => {
  const state = database(6);
  const results = await Promise.all([
    attributeCompletedTravelPartnerBookings(client(state), { maxScan: 3 }),
    attributeCompletedTravelPartnerBookings(client(state), { maxScan: 3 }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "stale_head").length, 1);
  assert.equal(state.cursor?.after_booking_id, bookingId(3));
  assert.equal(state.cursor?.cycle_upper_id, bookingId(6));
  assert.equal(state.calls.filter((call) => call.operation === "insert").length, 3);
});

test("a stale cycle claim cannot replace a newer worker's bound", async () => {
  const state = database(3);
  const winner = { producer: "travel_partner", after_booking_id: null, cycle_upper_id: bookingId(4), revision: randomUUID() };
  state.beforeCheckpoint = () => { state.cursor = { ...winner }; };
  const result = await attributeCompletedTravelPartnerBookings(client(state));
  assert.equal(!result.ok && result.reason, "stale_head");
  assert.deepEqual(state.cursor, winner);
  assert.equal(state.attributions.size, 0);
  assert.equal(state.pages.length, 0);
});

test("an empty bounded tail closes a cycle even if its upper booking was deleted", async () => {
  const state = database(1);
  state.beforeCheckpoint = () => { state.bookings = []; };
  const result = await pass(state);
  assert.equal(result.scanned, 0);
  assert.equal(state.cursor?.after_booking_id, null);
  assert.equal(state.cursor?.cycle_upper_id, null);
  assert.equal(state.calls.filter((call) => call.operation === "update").length, 2);
});

test("malformed or inconsistent durable bounds fail before scanning or writing", async () => {
  for (const fields of [
    { cycle_upper_id: undefined }, { cycle_upper_id: "bad-uuid" },
    { after_booking_id: bookingId(2), cycle_upper_id: null },
    { after_booking_id: bookingId(2), cycle_upper_id: bookingId(1) },
  ]) {
    const state = database(3);
    Object.assign(state.cursor!, fields);
    const result = await attributeCompletedTravelPartnerBookings(client(state));
    assert.equal(!result.ok && result.reason, "db_error");
    assert.equal(state.calls.some((call) => call.table === "rent_buddy_bookings" || call.operation !== "select"), false);
  }
});

test("an unreadable upper-bound query cannot claim a cycle; an empty idle scan writes nothing", async () => {
  for (const reply of [null, {}, [null], [{}], [{ id: "bad-uuid" }], [{ id: bookingId(1) }, { id: bookingId(2) }]]) {
    const state = database(3);
    state.replies.set("rent_buddy_bookings:upper", reply);
    const result = await attributeCompletedTravelPartnerBookings(client(state));
    assert.equal(!result.ok && result.reason, "db_error");
    assert.equal(state.calls.some((call) => call.operation !== "select"), false);
  }
  const empty = database(0);
  assert.equal((await pass(empty)).scanned, 0);
  assert.equal(empty.calls.some((call) => call.operation !== "select"), false);
});

test("a server cap below the requested page size cannot trap the scan in an attributed prefix", async () => {
  const state = database(6_203);
  state.serverCap = 137;
  for (const booking of state.bookings.slice(0, 5_200)) {
    state.attributions.set(booking.id, { subject_id: booking.id, creator_type: "travel_partner" });
  }
  const first = await pass(state);
  assert.deepEqual([first.scanned, first.alreadyAttributed, first.truncated], [5_000, 5_000, true]);
  assert.equal(state.cursor?.after_booking_id, bookingId(5_000));
  assert.equal(state.calls.some((call) => call.operation === "update" && call.payload?.cycle_upper_id === null), false);
  const second = await pass(state);
  assert.deepEqual([second.scanned, second.alreadyAttributed, second.attributed], [1_203, 200, 1_003]);
  assert.equal(state.attributions.size, 6_203);
  assert.equal(state.cursor?.after_booking_id, null);
  assert.ok(state.pages.every((page) => page.ids.length <= 137));
  assert.deepEqual(state.pages.at(-1)?.ids, []);
  const checkpoints = state.calls.filter((call) => call.operation === "update");
  assert.equal(checkpoints.filter((call) => call.payload?.cycle_upper_id === null).length, 1);
  assert.equal(checkpoints.at(-2)?.payload?.after_booking_id, bookingId(6_203));
});

test("one-row server pages continue through refusals and revisit a lower-ID late completion after an empty tail", async () => {
  const state = database(6);
  state.serverCap = 1;
  state.bookings[0]!.status = "pending";
  state.insertErrors.set(bookingId(2), { code: "CL409", message: "refused row" });
  const first = await pass(state, { maxScan: 3 });
  assert.deepEqual([first.scanned, first.refused, first.attributed], [3, 1, 2]);
  assert.equal(state.cursor?.after_booking_id, bookingId(4));
  state.bookings[0]!.status = "completed";
  assert.equal((await pass(state, { maxScan: 3 })).attributed, 2);
  assert.deepEqual(state.pages.at(-1)?.ids, []);
  assert.equal(state.cursor?.after_booking_id, null);
  state.insertErrors.clear();
  assert.equal((await pass(state, { maxScan: 3 })).attributed, 2);
  assert.equal(state.attributions.size, 6);
});

test("malformed, incomplete, duplicate, nonascending or behind-cursor booking pages never advance or write", async () => {
  const valid = { id: bookingId(3), buddy_id: BUDDY_PROFILE, status: "completed" };
  const invalidPages: unknown[] = [
    null, {}, [null], [undefined], [{}],
    [{ ...valid, id: undefined }], [{ ...valid, id: 3 }], [{ ...valid, id: "not-a-uuid" }],
    [{ ...valid, buddy_id: undefined }], [{ ...valid, buddy_id: "" }],
    [{ ...valid, buddy_id: "malformed-buddy-id" }],
    [{ ...valid, status: undefined }], [{ ...valid, status: "pending" }],
    [valid, { ...valid }],
    [{ ...valid, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { ...valid, id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }],
    [{ ...valid, id: bookingId(4) }, valid],
    [{ ...valid, id: bookingId(2) }], [{ ...valid, id: bookingId(1) }],
    [{ ...valid, id: bookingId(6) }],
    [valid, { ...valid, buddy_id: undefined }],
    Array.from({ length: 501 }, () => valid),
  ];
  for (const reply of invalidPages) {
    const state = database(5);
    state.cursor!.after_booking_id = bookingId(2);
    state.cursor!.cycle_upper_id = bookingId(5);
    const before = { ...state.cursor };
    state.replies.set("rent_buddy_bookings", reply);
    const result = await attributeCompletedTravelPartnerBookings(client(state));
    assert.equal(!result.ok && result.reason, "db_error", JSON.stringify(reply));
    assert.deepEqual(state.cursor, before);
    assert.equal(state.calls.some((call) => call.operation !== "select"), false);
    assert.equal(state.calls.some((call) => call.table === "creator_attributions"), false);
  }
});

test("incomplete attribution or beneficiary responses cannot silently advance a completed-booking page", async () => {
  const invalidReplies: Array<[string, unknown]> = [
    ["creator_attributions", null], ["creator_attributions", {}], ["creator_attributions", [null]],
    ["creator_attributions", [{}]], ["creator_attributions", [{ subject_id: "bad-id" }]],
    ["rent_buddy_profiles", null], ["rent_buddy_profiles", {}], ["rent_buddy_profiles", [null]],
    ["rent_buddy_profiles", [{}]], ["rent_buddy_profiles", [{ id: BUDDY_PROFILE }]],
    ["rent_buddy_profiles", [{ id: "malformed-buddy-id", user_id: BUDDY_USER }]],
    ["rent_buddy_profiles", [{ id: BUDDY_PROFILE, user_id: "malformed-user-id" }]],
  ];
  for (const [table, reply] of invalidReplies) {
    const state = database(1);
    state.cursor!.cycle_upper_id = bookingId(1);
    const before = { ...state.cursor };
    state.replies.set(table, reply);
    const result = await attributeCompletedTravelPartnerBookings(client(state));
    assert.equal(!result.ok && result.reason, "db_error", `${table}: ${JSON.stringify(reply)}`);
    assert.deepEqual(state.cursor, before);
    assert.equal(state.calls.some((call) => call.operation !== "select"), false);
  }
});

test("refusals and missing beneficiaries cannot starve the tail and are retried after wrapping", async () => {
  const state = database(5_003);
  state.bookings.slice(0, 2_500).forEach((booking) => { booking.buddy_id = MISSING_PROFILE; });
  state.bookings.slice(2_500, 5_000).forEach((booking) => {
    state.insertErrors.set(booking.id, { code: "CL409", message: "owner refusal" });
  });
  const first = await pass(state);
  assert.deepEqual([first.noBeneficiary, first.refused, first.attributed], [2_500, 2_500, 0]);
  assert.equal((await pass(state)).attributed, 3);
  state.profiles.push({ id: MISSING_PROFILE, user_id: BUDDY_USER });
  state.insertErrors.clear();
  assert.equal((await pass(state)).attributed, 5_000);
  assert.equal(state.attributions.size, 5_003);
});

test("wrapping picks up a late completion below the cursor, even if the cursor booking was deleted", async () => {
  const state = database(6);
  state.bookings[0]!.status = "completed_pending_traveler_confirmation";
  assert.equal((await pass(state, { maxScan: 3 })).attributed, 3);
  assert.equal(state.cursor?.after_booking_id, bookingId(4));
  assert.equal(state.attributions.has(bookingId(1)), false);
  state.bookings[0]!.status = "completed";
  state.bookings = state.bookings.filter((booking) => booking.id !== bookingId(4));
  assert.equal((await pass(state, { maxScan: 3 })).attributed, 2);
  assert.equal(state.cursor?.after_booking_id, null);
  assert.equal((await pass(state, { maxScan: 3 })).attributed, 1);
  assert.equal(state.attributions.has(bookingId(1)), true);
});

test("a fatal row error keeps the failed page retryable while preserving earlier checkpoints", async () => {
  const state = database(5);
  state.insertErrors.set(bookingId(4), { code: "08006", message: "connection failure" });
  const failed = await attributeCompletedTravelPartnerBookings(client(state), { pageSize: 2 });
  assert.equal(!failed.ok && failed.reason, "db_error");
  assert.equal(state.cursor?.after_booking_id, bookingId(2));
  assert.equal(state.attributions.size, 3);
  state.insertErrors.clear();
  const retried = await pass(state, { pageSize: 2 });
  assert.deepEqual([retried.alreadyAttributed, retried.attributed], [1, 2]);
  assert.equal(state.attributions.size, 5);
});

test("a failed checkpoint is safe to retry after writes and a process restart", async () => {
  const state = database(3);
  state.cursor!.cycle_upper_id = bookingId(3);
  state.errors.set(`${CURSORS}:update`, { code: "08006", message: "lost checkpoint connection" });
  const failed = await attributeCompletedTravelPartnerBookings(client(state), { pageSize: 2 });
  assert.equal(!failed.ok && failed.reason, "db_error");
  assert.equal(state.cursor?.after_booking_id, null);
  assert.equal(state.attributions.size, 2);
  state.errors.clear();
  const retried = await pass(state, { pageSize: 2 });
  assert.deepEqual([retried.alreadyAttributed, retried.attributed], [2, 1]);
});

test("a committed checkpoint with a lost reply resumes safely from durable state", async () => {
  const state = database(3);
  state.cursor!.cycle_upper_id = bookingId(3);
  state.checkpointReplyError = { code: "08006", message: "reply lost after commit" };
  const failed = await attributeCompletedTravelPartnerBookings(client(state), { pageSize: 2 });
  assert.equal(!failed.ok && failed.reason, "db_error");
  assert.equal(state.cursor?.after_booking_id, bookingId(2));
  assert.equal(state.attributions.size, 2);
  state.checkpointReplyError = null;
  assert.equal((await pass(state)).attributed, 1);
  assert.equal(state.attributions.size, 3);
});

test("booking, attribution and beneficiary read failures cannot advance the cursor", async () => {
  for (const table of ["rent_buddy_bookings", "creator_attributions", "rent_buddy_profiles"]) {
    const state = database(3);
    state.cursor!.cycle_upper_id = bookingId(3);
    state.errors.set(`${table}:select`, { code: "08006", message: "read failed" });
    const failed = await attributeCompletedTravelPartnerBookings(client(state));
    assert.equal(!failed.ok && failed.reason, "db_error", table);
    assert.equal(state.cursor?.after_booking_id, null, table);
    assert.equal(state.calls.some((call) => call.operation !== "select"), false, table);
    state.errors.clear();
    assert.equal((await pass(state)).attributed, 3);
  }
});

test("concurrent producers cannot overwrite a newer checkpoint or duplicate attributions", async () => {
  const state = database(6);
  state.cursor!.cycle_upper_id = bookingId(6);
  const results = await Promise.all([
    attributeCompletedTravelPartnerBookings(client(state), { pageSize: 2, maxScan: 3 }),
    attributeCompletedTravelPartnerBookings(client(state), { pageSize: 2, maxScan: 3 }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "stale_head").length, 1);
  assert.equal(state.cursor?.after_booking_id, bookingId(3));
  assert.equal(state.attributions.size, 3);
  assert.equal((await pass(state)).attributed, 3);
});

test("empty tails wrap durably and a stale worker cannot undo another worker's wrap", async () => {
  const state = database(2);
  await pass(state, { maxScan: 2 });
  assert.equal(state.cursor?.after_booking_id, bookingId(2));
  const nextRevision = randomUUID();
  state.beforeCheckpoint = () => { state.cursor = { producer: "travel_partner", after_booking_id: null, cycle_upper_id: null, revision: nextRevision }; };
  const stale = await attributeCompletedTravelPartnerBookings(client(state));
  assert.equal(!stale.ok && stale.reason, "stale_head");
  assert.equal(state.cursor?.revision, nextRevision);
  state.beforeCheckpoint = null;
  state.bookings.unshift({ id: bookingId(0), buddy_id: BUDDY_PROFILE, status: "completed" });
  assert.equal((await pass(state)).attributed, 1);
});

test("OFF reads only the flag and performs no attribution or cursor write", async () => {
  const state = database(5_001);
  state.enabled = false;
  const result = await attributeCompletedTravelPartnerBookings(client(state));
  assert.equal(!result.ok && result.reason, "disabled");
  assert.deepEqual(state.calls, [{ table: "feature_flags", operation: "select", payload: null }]);
});

test("disabling mid-page prevents checkpointing the unattempted tail", async () => {
  const state = database(3);
  state.afterInsert = () => { state.enabled = false; };
  const result = await attributeCompletedTravelPartnerBookings(client(state));
  assert.equal(!result.ok && result.reason, "disabled");
  assert.equal(state.cursor?.after_booking_id, null);
  assert.equal(state.attributions.size, 1);
  assert.equal(state.calls.filter((call) => call.table === CURSORS && call.operation === "update").length, 1);
  assert.equal(state.cursor?.cycle_upper_id, bookingId(3));
  state.afterInsert = null;
  state.enabled = true;
  assert.equal((await pass(state)).attributed, 2);
});

test("the flag is checked again before checkpointing even after the final row succeeds", async () => {
  const state = database(1);
  state.afterInsert = () => { state.enabled = false; };
  const result = await attributeCompletedTravelPartnerBookings(client(state));
  assert.equal(!result.ok && result.reason, "disabled");
  assert.equal(state.calls.filter((call) => call.table === CURSORS && call.operation === "update").length, 1);
  assert.equal(state.cursor?.after_booking_id, null);
  assert.equal(state.attributions.size, 1);
});

test("a concurrent OFF after the final flag read may commit the wrap, but a later OFF entry writes nothing", async () => {
  const state = database(1);
  state.beforeCheckpoint = () => {
    if (state.calls.at(-1)?.payload?.cycle_upper_id === null) state.enabled = false;
  };
  assert.equal((await pass(state)).attributed, 1);
  assert.equal(state.enabled, false);
  assert.equal(state.cursor?.after_booking_id, null);
  assert.equal(state.cursor?.cycle_upper_id, null);
  state.calls.length = 0;
  const off = await attributeCompletedTravelPartnerBookings(client(state));
  assert.equal(!off.ok && off.reason, "disabled");
  assert.deepEqual(state.calls, [{ table: "feature_flags", operation: "select", payload: null }]);
});

test("the existing attributed-subject guard keeps held or severed records untouched", async () => {
  const state = database(2);
  const held = { subject_id: bookingId(1), creator_type: "travel_partner", fraud_hold: true, beneficiary_user_id: null };
  state.attributions.set(bookingId(1), held);
  const result = await pass(state);
  assert.deepEqual([result.alreadyAttributed, result.attributed], [1, 1]);
  assert.equal(state.attributions.get(bookingId(1)), held);
  assert.equal(state.calls.filter((call) => call.operation === "insert").length, 1);
});

test("missing or unreadable cursor state fails closed before booking reads or writes", async () => {
  for (const mode of ["missing", "migration", "unreadable", "malformed"] as const) {
    const state = database(1);
    if (mode === "missing") state.cursor = null;
    if (mode === "malformed") state.cursor = { after_booking_id: "bad-id", revision: randomUUID() };
    if (mode === "migration") state.errors.set(`${CURSORS}:select`, { code: "42P01", message: `relation "${CURSORS}" does not exist` });
    if (mode === "unreadable") state.errors.set(`${CURSORS}:select`, { code: "42501", message: "permission denied" });
    const result = await attributeCompletedTravelPartnerBookings(client(state));
    assert.equal(result.ok, false, mode);
    assert.equal(state.calls.some((call) => call.table === "rent_buddy_bookings" || call.operation !== "select"), false, mode);
  }
});

test("page limits respect the remaining scan budget and invalid budgets never start a scan", async () => {
  const state = database(12);
  assert.equal((await pass(state, { pageSize: 4, maxScan: 6 })).scanned, 6);
  assert.deepEqual(state.pages.map((page) => page.ids.length), [4, 2]);
  for (const opts of [{ maxScan: 0 }, { maxScan: Infinity }, { maxScan: 5_001 }, { pageSize: 0 }, { pageSize: 501 }, { pageSize: 1.5 }]) {
    const invalid = database(1);
    const result = await attributeCompletedTravelPartnerBookings(client(invalid), opts);
    assert.equal(result.ok, false, JSON.stringify(opts));
    assert.equal(invalid.calls.some((call) => call.table !== "feature_flags"), false);
  }
});
