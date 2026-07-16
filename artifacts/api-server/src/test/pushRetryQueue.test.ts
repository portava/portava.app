/**
 * PushRetryQueue unit tests
 *
 * Verifies the retry-queue lifecycle without a live DB or real Expo API.
 * Uses the _setTestFetch hook from push.ts and a purpose-built in-memory
 * fake Supabase client that tracks every insert/update call.
 *
 * Coverage:
 *   1. enqueue() inserts a row with attempt_count=1 and next_retry_at ≈ now+5s
 *   2. enqueue() stores null fields when notificationId/deliveryAttemptId are null
 *   3. processQueue() marks queue row and delivery_attempt "sent" when Expo succeeds
 *   4. processQueue() marks queue row and delivery_attempt "failed" after exhausting all 3 attempts
 *   5. processQueue() re-queues with attempt_count+1 and next_retry_at ≈ now+15s when retry fails
 *
 * Run: node --import tsx/esm --test src/test/pushRetryQueue.test.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { PushRetryQueue } from "../lib/pushRetryQueue.js";
import { _setTestFetch } from "../lib/push.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const USER_ID      = "cc000000-0001-0001-0001-000000000001";
const QUEUE_ROW_ID = "cc000000-0002-0002-0002-000000000002";
const NOTIF_ID     = "cc000000-0003-0003-0003-000000000003";
const ATTEMPT_ID   = "cc000000-0004-0004-0004-000000000004";
const PUSH_TOKEN   = "ExponentPushToken[retryQueueTest01]";

const BASE_PAYLOAD = { title: "Retry Test", body: "Push retry queue unit test" };

// ── Fake Supabase client ───────────────────────────────────────────────────────
//
// Supports the exact query patterns used by PushRetryQueue:
//
//   INSERT  — enqueue()
//   UPDATE … .eq("status","processing") .lt()  .select("id") — recoverStaleProcessing()
//   UPDATE … .eq("status","queued")     .lte() .select()     — claim (returns queueRows)
//   UPDATE … .eq("id", id)                                   — finalise() / re-queue
//
// The claim step is the only UPDATE+select() on push_retry_queue. It returns
// queueRows filtered by the eq("status","queued") filter. stale-recovery's
// eq("status","processing") naturally yields [] because test rows start as "queued".

interface UpdateCall {
  table:    string;
  patch:    Record<string, unknown>;
  filters:  Record<string, unknown>;
  inFilters: Record<string, unknown[]>;
}

interface DeleteCall {
  table:    string;
  filters:  Record<string, unknown>;
  inFilters: Record<string, unknown[]>;
}

function makeFakeClient(queueRows: Record<string, unknown>[] = []) {
  const insertedRows: Record<string, Record<string, unknown>[]> = {};
  const updateCalls:  UpdateCall[] = [];
  const deleteCalls:  DeleteCall[] = [];

  function builder(tableName: string) {
    let pendingInsert: unknown = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let isDelete      = false;
    let hasSelect     = false;
    const eqFilters:  Record<string, unknown>   = {};
    const inFilters:  Record<string, unknown[]>  = {};

    const b: Record<string, unknown> = {
      select(_cols?: string)          { hasSelect = true; return b; },
      insert(row: unknown)            {
        pendingInsert = row;
        (insertedRows[tableName] ??= []).push(
          ...(Array.isArray(row) ? row : [row as Record<string, unknown>])
        );
        return b;
      },
      update(patch: Record<string, unknown>) { pendingUpdate = patch; return b; },
      delete()                        { isDelete = true; return b; },
      eq(col: string, val: unknown)   { eqFilters[col] = val; return b; },
      in(col: string, vals: unknown[]) { inFilters[col] = vals; return b; },
      neq()                           { return b; },
      lt()                            { return b; },
      lte()                           { return b; },
      then(onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) {
        return resolve().then(onF, onR);
      },
    };

    async function resolve(): Promise<{ data: unknown; error: null }> {
      // INSERT
      if (pendingInsert !== null) {
        const row = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
        return { data: { id: `${tableName}-new`, ...(row as object) }, error: null };
      }

      // DELETE
      if (isDelete) {
        deleteCalls.push({ table: tableName, filters: { ...eqFilters }, inFilters: { ...inFilters } });
        return { data: null, error: null };
      }

      // UPDATE
      if (pendingUpdate !== null) {
        updateCalls.push({
          table:    tableName,
          patch:    pendingUpdate,
          filters:  { ...eqFilters },
          inFilters: { ...inFilters },
        });

        // The claim step: UPDATE push_retry_queue … .eq("status","queued") … .select()
        // Returns all queueRows matching the eq filters so processItem() can work on them.
        if (tableName === "push_retry_queue" && hasSelect) {
          const matched = queueRows.filter((r) =>
            Object.entries(eqFilters).every(([k, v]) => r[k] === v)
          );
          return { data: matched, error: null };
        }
        return { data: null, error: null };
      }

      // SELECT (no pending mutation)
      if (tableName === "push_retry_queue") {
        const matched = queueRows.filter((r) =>
          Object.entries(eqFilters).every(([k, v]) => r[k] === v)
        );
        return { data: matched, error: null };
      }
      return { data: [], error: null };
    }

    return b;
  }

  return {
    from: builder as unknown as (t: string) => ReturnType<typeof builder>,
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    /** All rows passed to insert(), keyed by table name. */
    get insertedRows() { return insertedRows; },
    /** Every update() call recorded in order, with patch, eq, and in filters. */
    get updateCalls()  { return updateCalls; },
    /** Every delete() call recorded in order, with eq and in filters. */
    get deleteCalls()  { return deleteCalls; },
  };
}

// ── Fetch mock helpers ─────────────────────────────────────────────────────────

/** Expo push API returns 200 with a single "ok" ticket. */
function expoOkFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({ data: [{ status: "ok", id: "rcpt-ok" }] }),
      { status: 200 },
    ) as unknown as Response;
}

/** Expo push API returns 503 → retryable: true. */
function expo503Fetch(): typeof fetch {
  return async () =>
    new Response("Service Unavailable", { status: 503 }) as unknown as Response;
}

afterEach(() => _setTestFetch(null));

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 2 — enqueue()
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.enqueue()", () => {
  it("inserts a row with attempt_count=1, status=queued, and next_retry_at ≈ now+5s", async () => {
    const client = makeFakeClient();
    const queue  = new PushRetryQueue(client as never);

    const before = Date.now();
    await queue.enqueue({
      notificationId:    NOTIF_ID,
      userId:            USER_ID,
      tokens:            [PUSH_TOKEN],
      payload:           BASE_PAYLOAD,
      deliveryAttemptId: ATTEMPT_ID,
      lastError:         "initial push failed",
    });
    const after = Date.now();

    const rows = client.insertedRows["push_retry_queue"] ?? [];
    assert.equal(rows.length, 1, "exactly one row inserted");

    const row = rows[0];
    assert.equal(row.attempt_count,        1,        "attempt_count must be 1");
    assert.equal(row.max_attempts,         3,        "max_attempts must be 3");
    assert.equal(row.status,               "queued", "status must be queued");
    assert.equal(row.user_id,              USER_ID);
    assert.equal(row.notification_id,      NOTIF_ID);
    assert.equal(row.delivery_attempt_id,  ATTEMPT_ID);
    assert.equal(row.last_error,           "initial push failed");
    assert.deepEqual(row.tokens,           [PUSH_TOKEN]);

    // next_retry_at should be ≈ now + 5 seconds
    const nextMs    = new Date(row.next_retry_at as string).getTime();
    const expectMin = before + 4_800;  // 5s − 200ms tolerance
    const expectMax = after  + 5_300;  // 5s + 300ms tolerance
    assert.ok(
      nextMs >= expectMin && nextMs <= expectMax,
      `next_retry_at ${row.next_retry_at} must be ≈ now+5s (window ${expectMin}–${expectMax})`,
    );
  });

  it("stores null last_error and null FK fields when not provided", async () => {
    const client = makeFakeClient();
    const queue  = new PushRetryQueue(client as never);

    await queue.enqueue({
      notificationId:    null,
      userId:            USER_ID,
      tokens:            [PUSH_TOKEN],
      payload:           BASE_PAYLOAD,
      deliveryAttemptId: null,
      // lastError omitted
    });

    const row = (client.insertedRows["push_retry_queue"] ?? [])[0];
    assert.ok(row,                                     "row must be inserted");
    assert.equal(row.last_error,           null,       "last_error must be null when omitted");
    assert.equal(row.notification_id,      null,       "notification_id must be null");
    assert.equal(row.delivery_attempt_id,  null,       "delivery_attempt_id must be null");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — processQueue() succeeds on retry
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.processQueue() — success on retry", () => {
  it("marks queue row and delivery_attempt as 'sent' when Expo accepts the push", async () => {
    // Row represents attempt 1 having already failed; this processQueue() run is attempt 2.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoOkFetch());
    await queue.processQueue();

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    // finalise() marks the queue row "sent"
    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(sentUpdate,                               "push_retry_queue must be updated to 'sent'");
    assert.equal(sentUpdate.filters.id,  QUEUE_ROW_ID, "update must target the correct row by id");
    assert.equal(sentUpdate.patch.attempt_count, 2,    "attempt_count must be 2 (the retry attempt)");

    // finalise() also marks the delivery_attempt "sent"
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0,                   "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "sent",        "delivery_attempt status must be 'sent'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID,    "delivery_attempt update must target correct id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — processQueue() exhausts all 3 attempts
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.processQueue() — exhaust all attempts", () => {
  it("marks queue row and delivery_attempt 'failed' after attempt 3 with retryable error", async () => {
    // attempt_count=2 means attempts 1+2 already failed; this run is the 3rd and final attempt.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       2,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expo503Fetch());   // Expo 5xx → retryable: true
    await queue.processQueue();

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    // finalise() must mark the row "failed"
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate,                                "push_retry_queue must be updated to 'failed'");
    assert.equal(failedUpdate.filters.id,   QUEUE_ROW_ID, "update must target the correct row by id");
    assert.equal(failedUpdate.patch.attempt_count, 3,     "attempt_count must be 3 (final attempt)");

    // Must NOT re-queue (only finalise, not re-queue)
    // Use filters.id to distinguish from recoverStaleProcessing's patch.status="queued"
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID
    );
    assert.ok(!requeued, "must NOT re-queue the row after exhausting max_attempts");

    // Delivery attempt must also be marked failed
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0,                      "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",         "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID,       "delivery_attempt update must target correct id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — processQueue() re-queues with exponential delay
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.processQueue() — re-queue with exponential delay", () => {
  it("re-queues with attempt_count=2 and next_retry_at ≈ now+15s on second retryable failure", async () => {
    // attempt_count=1 means attempt 1 already failed; this run is attempt 2 (still has attempt 3 left).
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    const before = Date.now();
    _setTestFetch(expo503Fetch());   // Expo 5xx → retryable: true
    await queue.processQueue();
    const after = Date.now();

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    // Must re-queue — identified by filters.id=QUEUE_ROW_ID to distinguish from
    // recoverStaleProcessing's patch.status="queued" (which uses filters.status="processing")
    const requeuedUpdate = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID
    );
    assert.ok(requeuedUpdate,                                        "must re-queue the row on retryable failure with remaining attempts");
    assert.equal(requeuedUpdate.patch.attempt_count, 2,              "attempt_count must increment to 2");
    assert.equal(requeuedUpdate.patch.last_error,    "retryable failure");

    // next_retry_at should be ≈ now + 15s (RETRY_DELAYS_SECONDS[1])
    const nextMs    = new Date(requeuedUpdate.patch.next_retry_at as string).getTime();
    const expectMin = before + 14_700; // 15s − 300ms tolerance
    const expectMax = after  + 15_500; // 15s + 500ms tolerance
    assert.ok(
      nextMs >= expectMin && nextMs <= expectMax,
      `next_retry_at must be ≈ now+15s; got ${requeuedUpdate.patch.next_retry_at} (window ${expectMin}–${expectMax})`,
    );

    // Must NOT mark as failed
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(!failedUpdate, "must NOT mark as failed when attempts remain");

    // Must NOT update notification_delivery_attempts — only finalise() does that
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.equal(ndaUpdates.length, 0, "must NOT update delivery_attempt on re-queue (only on final resolution)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — Dead-token clearing during retries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expo returns a 200 with per-token error tickets for dead tokens.
 * DeviceNotRegistered and InvalidCredentials both mean the token is
 * permanently invalid and must be wiped from the three storage tables.
 */
function expoDeadTokenFetch(errorCode: "DeviceNotRegistered" | "InvalidCredentials"): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: [{
          status:  "error",
          message: `The push notification service reported that the push token is invalid: ${errorCode}`,
          details: { error: errorCode },
        }],
      }),
      { status: 200 },
    ) as unknown as Response;
}

describe("PushRetryQueue.processQueue() — dead-token clearing on retry", () => {
  it("clears DeviceNotRegistered tokens from all three tables and finalises the queue row as 'failed'", async () => {
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoDeadTokenFetch("DeviceNotRegistered"));
    await queue.processQueue();

    // profiles — nulled out via update().in()
    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for dead token");
    assert.deepEqual(
      profileUpdate.inFilters["expo_push_token"],
      [PUSH_TOKEN],
      "profiles update must target the dead token",
    );

    // notification_devices — row deleted via delete().in()
    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices row must be deleted for dead token");
    assert.deepEqual(
      deviceDelete.inFilters["push_token"],
      [PUSH_TOKEN],
      "notification_devices delete must target the dead token",
    );

    // rent_buddy_profiles — nulled out via update().in()
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for dead token");
    assert.deepEqual(
      rentUpdate.inFilters["expo_push_token"],
      [PUSH_TOKEN],
      "rent_buddy_profiles update must target the dead token",
    );

    // Queue row must be finalised as 'failed' (non-retryable — not re-queued)
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed'");
    assert.equal(failedUpdate.filters.id, QUEUE_ROW_ID, "failed update must target the correct row");

    // Must NOT re-queue — token is dead, retrying would be wasteful
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue a row whose token is permanently dead");
  });

  it("clears InvalidCredentials tokens from all three tables and finalises as 'failed'", async () => {
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoDeadTokenFetch("InvalidCredentials"));
    await queue.processQueue();

    // All three tables must have been cleaned up
    assert.ok(
      client.updateCalls.some((c) => c.table === "profiles" && c.patch.expo_push_token === null),
      "profiles.expo_push_token must be cleared for InvalidCredentials token",
    );
    assert.ok(
      client.deleteCalls.some((c) => c.table === "notification_devices"),
      "notification_devices row must be deleted for InvalidCredentials token",
    );
    assert.ok(
      client.updateCalls.some((c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null),
      "rent_buddy_profiles.expo_push_token must be cleared for InvalidCredentials token",
    );

    // Row must be finalised as failed, never re-queued
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    assert.ok(
      prqUpdates.some((c) => c.patch.status === "failed"),
      "push_retry_queue must be finalised as 'failed' for InvalidCredentials",
    );
    assert.ok(
      !prqUpdates.some((c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID),
      "must NOT re-queue a row whose token reported InvalidCredentials",
    );
  });
});
