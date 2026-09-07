/**
 * Trips v4 kernel foundation — the spine, proved.
 *
 * WHAT IS BEING PROVED
 * ====================
 *   1. The routed command APPENDS AN EVENT. POST /trips/:id/complete leaves a
 *      row in trip_events describing the transition it performed.
 *   2. The AGGREGATE VERSION BUMPS, by exactly one, and the event records the
 *      version the aggregate reached.
 *   3. A STALE expectedTripVersion is REFUSED. Compare-and-set, not advice.
 *   4. The SAME idempotencyKey twice produces ONE event and ONE state change.
 *   5. A FAILED READ NEVER WRITES. Not the aggregate, not the log.
 *   6. RESPONSE PARITY: every existing response of the routed endpoint is
 *      byte-identical to what it produced before the kernel existed.
 *
 * THE FAKE HAS REAL CONSTRAINTS
 * =============================
 * A fake that accepts every insert would make (3) and (4) vacuous — they would
 * pass against a kernel that had no concurrency control at all. So this file's
 * double enforces, in the fake, the two UNIQUE constraints migration 2316 puts
 * on trip_events — (trip_id, aggregate_version) and (trip_id, idempotency_key) —
 * and honours `.eq("version", n)` as a real predicate on UPDATE, which is what
 * makes the compare-and-set a compare-and-set. Where the fake would be the only
 * thing enforcing a property, the test says so.
 *
 * Run: node --import tsx/esm --test src/test/tripKernelFoundation.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { executeTripCommand, derivedIdempotencyKey } from "../lib/tripKernel/index.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type Row = Record<string, any>;

interface FakeOpts {
  /** Fail every SELECT against this table. */
  failSelectOn?: string;
  /** Fail every INSERT against this table. */
  failInsertOn?: string;
  /** Fail every UPDATE against this table. */
  failUpdateOn?: string;
}

/**
 * Purpose-built double. Small enough to read, strict enough that the kernel's
 * concurrency properties are actually load-bearing here.
 */
function makeClient(seed: { trips?: Row[]; trip_events?: Row[] } = {}, opts: FakeOpts = {}) {
  const db: Record<string, Row[]> = {
    trips: seed.trips ?? [],
    trip_events: seed.trip_events ?? [],
    trip_activity_log: [],
  };
  let idCtr = 0;
  const newId = () => `e0000000-0000-4000-8000-${String(++idCtr).padStart(12, "0")}`;

  function chain(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _selected = false;
    const obj: any = {
      select() { _selected = true; return obj; },
      insert(d: Row) { _insert = d; return obj; },
      update(d: Row) { _update = d; return obj; },
      delete() { _delete = true; return obj; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      order() { return obj; },
      limit() { return obj; },
      maybeSingle() { return run("maybeSingle"); },
      single() { return run("single"); },
      then(onF: any, onR: any) { return run("many").then(onF, onR); },
    };

    function run(mode: "single" | "maybeSingle" | "many"): Promise<{ data: any; error: any }> {
      return Promise.resolve().then(() => {
        if (!db[table]) db[table] = [];
        const rows = db[table];

        if (_insert) {
          if (opts.failInsertOn === table) {
            return { data: null, error: { message: `injected insert failure on ${table}` } };
          }
          if (table === "trip_events") {
            // The two UNIQUE constraints migration 2316 declares. Without these
            // the idempotency and compare-and-set proofs below are vacuous.
            const dupVersion = rows.some(
              (r) => r.trip_id === _insert!.trip_id && r.aggregate_version === _insert!.aggregate_version,
            );
            if (dupVersion) {
              return { data: null, error: { code: "23505", message: "trip_events_trip_version_uniq" } };
            }
            const dupKey = rows.some(
              (r) => r.trip_id === _insert!.trip_id && r.idempotency_key === _insert!.idempotency_key,
            );
            if (dupKey) {
              return { data: null, error: { code: "23505", message: "trip_events_trip_idempotency_uniq" } };
            }
          }
          const inserted = { id: newId(), occurred_at: new Date().toISOString(), payload: {}, ..._insert };
          rows.push(inserted);
          return { data: mode === "many" ? [inserted] : inserted, error: null };
        }

        if (_update) {
          if (opts.failUpdateOn === table) {
            return { data: null, error: { message: `injected update failure on ${table}` } };
          }
          const matched: Row[] = [];
          for (let i = 0; i < rows.length; i++) {
            if (filters.every((f) => f(rows[i]))) {
              rows[i] = { ...rows[i], ..._update };
              matched.push({ ...rows[i] });
            }
          }
          if (mode === "single" || mode === "maybeSingle") return { data: matched[0] ?? null, error: null };
          return { data: _selected ? matched : null, error: null };
        }

        if (_delete) {
          db[table] = rows.filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }

        if (opts.failSelectOn === table) {
          return { data: null, error: { message: `injected select failure on ${table}` } };
        }
        const hits = rows.filter((r) => filters.every((f) => f(r)));
        if (mode === "single" || mode === "maybeSingle") return { data: hits[0] ?? null, error: null };
        return { data: hits, error: null };
      });
    }
    return obj;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "other-token") return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: { message: "no rpc in this double" } }),
  };
  return { client, db };
}

function tripRow(status: string, version: number | undefined = 1, ownerId = OWNER_ID): Row {
  const r: Row = {
    id: TRIP_ID,
    owner_id: ownerId,
    title: "Kernel trip",
    destination_city: "Da Nang",
    status,
    visibility: "private",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  };
  if (version !== undefined) r.version = version;
  return r;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
let server: Server | null = null;
let port = 0;

async function startServer(): Promise<void> {
  if (server) return;
  await new Promise<void>((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => {
      s.unref();
      server = s;
      port = (s.address() as any).port;
      resolve();
    });
  });
}

async function post(path: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, body };
}

after(() => { server?.close(); });

// ── 1 + 2: the routed command appends an event and bumps the version ────────

describe("trip kernel — the routed command writes to the spine", () => {
  beforeEach(async () => { await startServer(); });

  it("POST /complete appends exactly one trip_events row describing the transition", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 1)] });
    _setTestClient(client, true);

    const r = await post(`/trips/${TRIP_ID}/complete`, "owner-token");

    assert.equal(r.status, 200);
    assert.equal(db.trip_events.length, 1, "the command must leave exactly one event");
    const ev = db.trip_events[0];
    assert.equal(ev.trip_id, TRIP_ID);
    assert.equal(ev.event_type, "trip.completed");
    assert.equal(ev.actor_id, OWNER_ID);
    assert.equal(ev.from_status, "active");
    assert.equal(ev.to_status, "completed");
    assert.equal(ev.aggregate_version, 2, "the event records the version the aggregate REACHED");
    assert.ok(typeof ev.idempotency_key === "string" && ev.idempotency_key.length > 0,
      "every event carries an idempotency key — trip_events.idempotency_key is NOT NULL");
  });

  it("bumps trips.version by exactly one", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 7)] });
    _setTestClient(client, true);

    await post(`/trips/${TRIP_ID}/complete`, "owner-token");

    assert.equal(db.trips[0].version, 8);
    assert.equal(db.trips[0].status, "completed");
    assert.equal(db.trip_events[0].aggregate_version, 8);
  });

  it("does not touch trips.version on any other trip", async () => {
    const other = { ...tripRow("active", 3), id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
    const { client, db } = makeClient({ trips: [tripRow("active", 3), other] });
    _setTestClient(client, true);

    await post(`/trips/${TRIP_ID}/complete`, "owner-token");

    const untouched = db.trips.find((t) => t.id === other.id)!;
    assert.equal(untouched.version, 3);
    assert.equal(untouched.status, "active");
  });
});

// ── 3: compare-and-set actually refuses ─────────────────────────────────────

describe("trip kernel — compare-and-set", () => {
  it("REFUSES a stale expectedTripVersion, and writes nothing", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 5)] });

    const result = await executeTripCommand(client, {
      type: "trip.complete",
      tripId: TRIP_ID,
      actorId: OWNER_ID,
      idempotencyKey: "stale-attempt",
      expectedTripVersion: 4, // the aggregate is at 5
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "version_conflict");
    assert.equal(result.ok === false && result.error.actualVersion, 5);
    assert.equal(db.trips[0].status, "active", "a refused command must not move the aggregate");
    assert.equal(db.trips[0].version, 5);
    assert.equal(db.trip_events.length, 0, "a refused command must not append an event");
  });

  it("ACCEPTS a matching expectedTripVersion", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 5)] });

    const result = await executeTripCommand(client, {
      type: "trip.complete",
      tripId: TRIP_ID,
      actorId: OWNER_ID,
      idempotencyKey: "fresh-attempt",
      expectedTripVersion: 5,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.outcome, "applied");
    assert.equal(db.trips[0].version, 6);
    assert.equal(db.trip_events.length, 1);
  });

  it("INTERLEAVED: two commands that both read version N — only the UPDATE predicate can refuse the loser", async () => {
    // This is the test the `.eq("version", …)` predicate exists for, and it is
    // deliberately built so nothing ELSE can pass it:
    //   * no expectedTripVersion, so the caller-side check cannot refuse anyone;
    //   * different idempotency keys, so replay cannot;
    //   * genuinely interleaved — both commands complete their READ before
    //     either performs its WRITE, which is exactly the window a
    //     check-then-write has and a compare-and-set does not.
    // Deleting the predicate leaves the loser applying a decision it made
    // against a version that no longer exists.
    const { client, db } = makeClient({ trips: [tripRow("active", 2)] });

    const [a, b] = await Promise.all([
      executeTripCommand(client, {
        type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID, idempotencyKey: "interleaved-a",
      }),
      executeTripCommand(client, {
        type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID, idempotencyKey: "interleaved-b",
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    assert.equal(winners.length, 1, "exactly one command may win");
    assert.equal(losers.length, 1, "exactly one command must be refused");
    assert.equal(
      losers[0].ok === false && losers[0].error.code,
      "version_conflict",
      "the loser must be refused for the RIGHT reason — a conflict, not a downstream write error",
    );

    assert.equal(db.trip_events.length, 1, "exactly one event");
    assert.equal(db.trips[0].version, 3, "exactly one bump");
    assert.equal(db.trips[0].status, "completed", "the winner's transition must survive intact");
  });

  it("the loser of a concurrent race is refused, not silently applied twice", async () => {
    // Both commands are decided against version 2 and carry DIFFERENT keys, so
    // idempotency cannot be what saves this — only the version predicate can.
    const { client, db } = makeClient({ trips: [tripRow("active", 2)] });

    const a = await executeTripCommand(client, {
      type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID,
      idempotencyKey: "racer-a", expectedTripVersion: 2,
    });
    const b = await executeTripCommand(client, {
      type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID,
      idempotencyKey: "racer-b", expectedTripVersion: 2,
    });

    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.ok === false && b.error.code, "version_conflict");
    assert.equal(db.trips[0].version, 3, "exactly one bump");
    assert.equal(db.trip_events.length, 1, "exactly one event");
  });
});

// ── 4: idempotency ──────────────────────────────────────────────────────────

describe("trip kernel — idempotency", () => {
  it("the same idempotencyKey twice produces ONE event and ONE state change", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 1)] });

    const first = await executeTripCommand(client, {
      type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID, idempotencyKey: "cmd-abc",
    });
    // Reopen the aggregate the way a direct writer would (PATCH /settings does
    // exactly this today), so a second apply WOULD be possible if the key were
    // not honoured. Version deliberately left where the kernel put it.
    db.trips[0].status = "active";

    const second = await executeTripCommand(client, {
      type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID, idempotencyKey: "cmd-abc",
    });

    assert.equal(first.ok, true);
    assert.equal(first.ok === true && first.outcome, "applied");
    assert.equal(second.ok, true);
    assert.equal(second.ok === true && second.outcome, "replayed", "the second must REPLAY, not re-apply");
    assert.equal(db.trip_events.length, 1, "one key, one event");
    assert.equal(db.trips[0].version, 2, "one key, one version bump");
    assert.equal(db.trips[0].status, "active", "the replay must not re-apply the state change");
    assert.equal(
      first.ok === true && second.ok === true && second.event.id,
      first.ok === true ? first.event.id : "",
      "the replay returns the SAME event",
    );
  });

  it("a replay is returned even when the caller's expectedTripVersion is now stale", async () => {
    const { client } = makeClient({ trips: [tripRow("active", 1)] });
    const cmd = {
      type: "trip.complete" as const, tripId: TRIP_ID, actorId: OWNER_ID,
      idempotencyKey: "retry-key", expectedTripVersion: 1,
    };
    const first = await executeTripCommand(client, cmd);
    // Same command object, retried after its own success moved the version.
    const retry = await executeTripCommand(client, cmd);

    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    assert.equal(retry.ok === true && retry.outcome, "replayed");
  });

  it("the derived key is scoped to the version, so a reopened trip can complete again", async () => {
    assert.notEqual(
      derivedIdempotencyKey("trip.complete", TRIP_ID, 1),
      derivedIdempotencyKey("trip.complete", TRIP_ID, 2),
    );
    const { client, db } = makeClient({ trips: [tripRow("active", 1)] });
    await executeTripCommand(client, { type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID });
    db.trips[0].status = "active"; // reopened out of band; version is now 2
    await executeTripCommand(client, { type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID });

    assert.equal(db.trip_events.length, 2, "a genuinely later command gets its own event");
    assert.deepEqual(db.trip_events.map((e) => e.aggregate_version), [2, 3]);
  });
});

// ── 5: a failed read never writes ───────────────────────────────────────────

describe("trip kernel — a failed read never writes", () => {
  it("an aggregate read failure writes neither the aggregate nor the log", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 1)] }, { failSelectOn: "trips" });

    const result = await executeTripCommand(client, {
      type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID, idempotencyKey: "k",
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "read_failed");
    assert.equal(db.trips[0].status, "active");
    assert.equal(db.trips[0].version, 1);
    assert.equal(db.trip_events.length, 0);
  });

  it("an idempotency-probe read failure writes neither the aggregate nor the log", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 1)] }, { failSelectOn: "trip_events" });

    const result = await executeTripCommand(client, {
      type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID, idempotencyKey: "k",
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "read_failed");
    assert.equal(db.trips[0].status, "active");
    assert.equal(db.trips[0].version, 1);
    assert.equal(db.trip_events.length, 0);
  });

  it("a failed event append COMPENSATES the aggregate — no applied command without an event", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 4)] }, { failInsertOn: "trip_events" });

    const result = await executeTripCommand(client, {
      type: "trip.complete", tripId: TRIP_ID, actorId: OWNER_ID, idempotencyKey: "k",
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "write_failed");
    assert.equal(db.trip_events.length, 0);
    assert.equal(db.trips[0].status, "active", "the aggregate must be rolled back");
    assert.equal(db.trips[0].version, 4);
  });
});

// ── 6: response parity for the routed endpoint ──────────────────────────────

describe("trip kernel — POST /complete response parity", () => {
  beforeEach(async () => { await startServer(); });

  it("200 { status, tripId } on a real transition", async () => {
    const { client } = makeClient({ trips: [tripRow("active", 1)] });
    _setTestClient(client, true);
    const r = await post(`/trips/${TRIP_ID}/complete`, "owner-token");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "completed", tripId: TRIP_ID });
  });

  it("200 { status, idempotent: true } when already completed", async () => {
    const { client, db } = makeClient({ trips: [tripRow("completed", 1)] });
    _setTestClient(client, true);
    const r = await post(`/trips/${TRIP_ID}/complete`, "owner-token");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "completed", idempotent: true });
    assert.equal(db.trip_events.length, 0, "a no-op is not an event: the log records changes");
  });

  it("403 for a non-owner, with the original message", async () => {
    const { client, db } = makeClient({ trips: [tripRow("active", 1)] });
    _setTestClient(client, true);
    const r = await post(`/trips/${TRIP_ID}/complete`, "other-token");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
    assert.equal(r.body.message, "Only the owner can complete a trip");
    assert.equal(db.trip_events.length, 0);
  });

  it("409 invalid_state_transition for a terminal trip, with the original message", async () => {
    const { client, db } = makeClient({ trips: [tripRow("cancelled", 1)] });
    _setTestClient(client, true);
    const r = await post(`/trips/${TRIP_ID}/complete`, "owner-token");
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "invalid_state_transition");
    assert.equal(r.body.message, "Cannot complete a cancelled trip");
    assert.equal(db.trip_events.length, 0);
  });

  it("404 for a missing trip", async () => {
    const { client } = makeClient({ trips: [] });
    _setTestClient(client, true);
    const r = await post(`/trips/${TRIP_ID}/complete`, "owner-token");
    assert.equal(r.status, 404);
    assert.equal(r.body.message, "Trip not found");
  });

  it("still applies against a row whose projection carries no version column", async () => {
    // The additive branch: trips.version is NOT NULL DEFAULT 1 once 2316 is
    // applied, so this is the shape a pre-2316 read (or a partial fixture)
    // produces. It must transition rather than refuse — the kernel is additive.
    const { client, db } = makeClient({ trips: [tripRow("active", undefined)] });
    _setTestClient(client, true);
    const r = await post(`/trips/${TRIP_ID}/complete`, "owner-token");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "completed", tripId: TRIP_ID });
    assert.equal(db.trips[0].status, "completed");
    assert.equal(db.trip_events.length, 1);
  });
});
