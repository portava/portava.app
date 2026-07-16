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

import { PushRetryQueue, _setTestClearDeadTokens } from "../lib/pushRetryQueue.js";
import { _setTestFetch } from "../lib/push.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const USER_ID      = "cc000000-0001-0001-0001-000000000001";
const QUEUE_ROW_ID = "cc000000-0002-0002-0002-000000000002";
const NOTIF_ID     = "cc000000-0003-0003-0003-000000000003";
const ATTEMPT_ID   = "cc000000-0004-0004-0004-000000000004";
const PUSH_TOKEN    = "ExponentPushToken[retryQueueTest01]";
const LIVE_TOKEN_B  = "ExponentPushToken[retryQueueTest02]";
const DEAD_TOKEN    = "ExponentPushToken[retryQueueTestDead]";
const DEAD_TOKEN_IC = "ExponentPushToken[retryQueueTestDeadIC]";

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
  table:     string;
  patch:     Record<string, unknown>;
  filters:   Record<string, unknown>;
  inFilters: Record<string, unknown[]>;
  ltFilters: Record<string, unknown>;
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
    const lteFilters: Record<string, unknown>   = {};
    const ltFilters:  Record<string, unknown>   = {};

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
      lt(col: string, val: unknown)   { ltFilters[col]  = val; return b; },
      lte(col: string, val: unknown)  { lteFilters[col] = val; return b; },
      then(onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) {
        return resolve().then(onF, onR);
      },
    };

    /** Apply all recorded filters (eq, lte, lt) to a row — used for SELECT and UPDATE+select. */
    function matchesFilters(r: Record<string, unknown>): boolean {
      for (const [k, v] of Object.entries(eqFilters)) {
        if (r[k] !== v) return false;
      }
      for (const [k, v] of Object.entries(lteFilters)) {
        // ISO timestamp strings compare correctly with JS string ordering.
        if (!((r[k] as string) <= (v as string))) return false;
      }
      for (const [k, v] of Object.entries(ltFilters)) {
        if (!((r[k] as string) < (v as string))) return false;
      }
      return true;
    }

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
          table:     tableName,
          patch:     pendingUpdate,
          filters:   { ...eqFilters },
          inFilters: { ...inFilters },
          ltFilters: { ...ltFilters },
        });

        // The claim step: UPDATE push_retry_queue … .eq("status","queued") .lte("next_retry_at",now) … .select()
        // Returns only queueRows that pass all filters (eq + lte + lt) so processItem() works on
        // the correct set — rows with a future next_retry_at are excluded.
        if (tableName === "push_retry_queue" && hasSelect) {
          const matched = queueRows.filter(matchesFilters);
          return { data: matched, error: null };
        }
        return { data: null, error: null };
      }

      // SELECT (no pending mutation)
      if (tableName === "push_retry_queue") {
        const matched = queueRows.filter(matchesFilters);
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

afterEach(() => {
  _setTestFetch(null);
  _setTestClearDeadTokens(null);
});

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
    // error_message must mirror last_error — a regression in finalise() would leave it null
    assert.equal(
      ndaUpdate.patch.error_message,
      "failed after 3 attempts",
      "delivery_attempt error_message must match the queue row last_error ('failed after 3 attempts')",
    );
  });

  it("sets last_error to 'failed after 3 attempts' when attempt_count=2 and Expo returns 503 (retryable)", async () => {
    // attempt_count=2 means attempts 1 and 2 already failed; this run is the 3rd and final attempt.
    // Expo returns 503 (retryable: true).  Because max_attempts is exhausted, the row must be
    // finalised as 'failed' with last_error === "failed after 3 attempts" — not empty, not the
    // generic "non-retryable error" message, and not left as the prior re-queue error.
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

    // The finalise() call must mark the row 'failed'
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' when retryable error exhausts all attempts");
    assert.equal(failedUpdate.filters.id,      QUEUE_ROW_ID, "failed update must target the correct queue row");
    assert.equal(failedUpdate.patch.attempt_count, 3,        "attempt_count must be 3 (the final attempt number)");

    // last_error must be exactly the retryable-exhaustion message
    assert.equal(
      failedUpdate.patch.last_error,
      "failed after 3 attempts",
      "last_error must be 'failed after 3 attempts' when a retryable error exhausts all retries",
    );

    // Must NOT re-queue — max_attempts reached
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue the row after all attempts are exhausted");
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

/**
 * Expo returns a 200 with two tickets: the first token delivered ('ok'),
 * the second is DeviceNotRegistered (dead).  Used to exercise the partial-
 * success path where dead-token cleanup must still run even though sent > 0.
 */
function expoPartialSuccessFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          { status: "ok", id: "rcpt-partial-ok" },
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
            details: { error: "DeviceNotRegistered" },
          },
        ],
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
    assert.equal(
      failedUpdate.patch.last_error,
      "DeviceNotRegistered \u00d7 1",
      "last_error must name the specific dead-token error code and count",
    );

    // Must NOT re-queue — token is dead, retrying would be wasteful
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue a row whose token is permanently dead");
  });

  it("records DeviceNotRegistered in last_error when dead token is found on the final attempt (attempt_count=2)", async () => {
    // attempt_count=2 means two prior failures; this run is attempt 3 — the final attempt.
    // Expo returns DeviceNotRegistered, which is non-retryable regardless of remaining attempts.
    // last_error on the finalised 'failed' row must name the dead-token code, not be empty.
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

    _setTestFetch(expoDeadTokenFetch("DeviceNotRegistered"));
    await queue.processQueue();

    // ── Dead-token cleanup must run even on the final attempt ─────────────────

    // profiles.expo_push_token nulled via update().in([PUSH_TOKEN])
    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for dead token on final attempt");
    assert.deepEqual(
      profileUpdate.inFilters["expo_push_token"],
      [PUSH_TOKEN],
      "profiles update must target the dead token",
    );

    // notification_devices row deleted via delete().in([PUSH_TOKEN])
    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices row must be deleted for dead token on final attempt");
    assert.deepEqual(
      deviceDelete.inFilters["push_token"],
      [PUSH_TOKEN],
      "notification_devices delete must target the dead token",
    );

    // rent_buddy_profiles.expo_push_token nulled via update().in([PUSH_TOKEN])
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for dead token on final attempt");
    assert.deepEqual(
      rentUpdate.inFilters["expo_push_token"],
      [PUSH_TOKEN],
      "rent_buddy_profiles update must target the dead token",
    );

    // ── Queue row must be finalised as 'failed' with last_error naming the code ─

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' on final attempt with dead token");
    assert.equal(failedUpdate.filters.id, QUEUE_ROW_ID, "failed update must target the correct queue row");
    assert.equal(failedUpdate.patch.attempt_count, 3, "attempt_count must be 3 (the final attempt)");

    // last_error must be non-empty and name the dead-token error code
    const lastError = failedUpdate.patch.last_error as string;
    assert.ok(lastError && lastError.length > 0, "last_error must be non-empty when a dead token is found");
    assert.ok(
      lastError.includes("DeviceNotRegistered"),
      `last_error must name the dead-token error code; got: ${lastError}`,
    );
    assert.equal(
      lastError,
      "DeviceNotRegistered \u00d7 1",
      "last_error must be exactly 'DeviceNotRegistered × 1'",
    );

    // Must NOT be re-queued — token is dead and max_attempts reached
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue when the token is dead and max_attempts is reached");

    // ── Delivery attempt must also be finalised as 'failed' ───────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated on final-attempt dead token");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
    // error_message must mirror last_error — a regression in finalise() would leave it null
    assert.equal(
      ndaUpdate.patch.error_message,
      "DeviceNotRegistered \u00d7 1",
      "delivery_attempt error_message must match last_error ('DeviceNotRegistered × 1') on dead-token final attempt",
    );
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
    const failedUpdateIC = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(
      failedUpdateIC,
      "push_retry_queue must be finalised as 'failed' for InvalidCredentials",
    );
    assert.equal(
      failedUpdateIC.patch.last_error,
      "InvalidCredentials \u00d7 1",
      "last_error must name the specific dead-token error code and count",
    );
    assert.ok(
      !prqUpdates.some((c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID),
      "must NOT re-queue a row whose token reported InvalidCredentials",
    );
  });

  it("records InvalidCredentials in last_error when dead token is found on the final attempt (attempt_count=2)", async () => {
    // attempt_count=2 means two prior failures; this run is attempt 3 — the final attempt.
    // Expo returns InvalidCredentials, which is non-retryable regardless of remaining attempts.
    // last_error on the finalised 'failed' row must name the dead-token code ("InvalidCredentials × 1"),
    // not be empty or swallowed.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [DEAD_TOKEN_IC],
      payload:             BASE_PAYLOAD,
      attempt_count:       2,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoDeadTokenFetch("InvalidCredentials"));
    await queue.processQueue();

    // ── Queue row must be finalised as 'failed' with last_error naming the code ─

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' on final attempt with InvalidCredentials");
    assert.equal(failedUpdate.filters.id,      QUEUE_ROW_ID, "failed update must target the correct queue row");
    assert.equal(failedUpdate.patch.attempt_count, 3,        "attempt_count must be 3 (the final attempt)");

    // last_error must be exactly "InvalidCredentials × 1" — not empty, not swallowed
    assert.equal(
      failedUpdate.patch.last_error,
      "InvalidCredentials \u00d7 1",
      "last_error must be 'InvalidCredentials × 1' when InvalidCredentials token is found on the final attempt",
    );

    // Must NOT be re-queued — token is permanently dead and max_attempts reached
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue when the token is InvalidCredentials and max_attempts is reached");

    // ── Delivery attempt must also be finalised as 'failed' ───────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated on final-attempt InvalidCredentials");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
    // error_message must mirror last_error — a regression in finalise() would leave it null
    assert.equal(
      ndaUpdate.patch.error_message,
      "InvalidCredentials \u00d7 1",
      "delivery_attempt error_message must match last_error ('InvalidCredentials × 1') on dead-token final attempt",
    );
  });

  /**
   * Expo returns a 200 with two error tickets: the first token is
   * DeviceNotRegistered and the second is InvalidCredentials.  This exercises
   * the grouping logic that must name BOTH codes (with counts) in last_error.
   */
  function expoMixedDeadTokenFetch(): typeof fetch {
    return async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              status:  "error",
              message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
              details: { error: "DeviceNotRegistered" },
            },
            {
              status:  "error",
              message: "The push notification service reported that the push token is invalid: InvalidCredentials",
              details: { error: "InvalidCredentials" },
            },
          ],
        }),
        { status: 200 },
      ) as unknown as Response;
  }

  it("names both DeviceNotRegistered and InvalidCredentials codes in last_error for a mixed-failure batch", async () => {
    // Two tokens in the batch; Expo reports one DeviceNotRegistered (PUSH_TOKEN)
    // and one InvalidCredentials (DEAD_TOKEN).  Both are non-retryable dead tokens,
    // so: both wiped from all three tables, row finalised 'failed', NOT re-queued,
    // and last_error must contain both codes with their counts.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoMixedDeadTokenFetch());
    await queue.processQueue();

    // ── Both tokens must be wiped from all three tables ───────────────────────

    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for both dead tokens");
    assert.deepEqual(
      [...(profileUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN].sort(),
      "profiles update must target both dead tokens",
    );

    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows must be deleted for both dead tokens");
    assert.deepEqual(
      [...(deviceDelete.inFilters["push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN].sort(),
      "notification_devices delete must target both dead tokens",
    );

    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for both dead tokens");
    assert.deepEqual(
      [...(rentUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN].sort(),
      "rent_buddy_profiles update must target both dead tokens",
    );

    // ── Queue row must be finalised as 'failed' — never re-queued ─────────────
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' for mixed dead-token batch");
    assert.equal(failedUpdate.filters.id, QUEUE_ROW_ID, "failed update must target the correct queue row");

    // last_error must name both codes with their respective counts.
    // The grouping preserves insertion order: DeviceNotRegistered first, then InvalidCredentials.
    const lastError = failedUpdate.patch.last_error as string;
    assert.ok(
      lastError.includes("DeviceNotRegistered \u00d7 1"),
      `last_error must include "DeviceNotRegistered × 1"; got: ${lastError}`,
    );
    assert.ok(
      lastError.includes("InvalidCredentials \u00d7 1"),
      `last_error must include "InvalidCredentials × 1"; got: ${lastError}`,
    );

    // Must NOT be re-queued — all tokens are permanently dead
    assert.ok(
      !prqUpdates.some((c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID),
      "must NOT re-queue a row where all tokens are permanently dead (mixed error codes)",
    );

    // ── Delivery attempt must also be finalised as 'failed' ───────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });

  it("mirrors both dead-token codes in delivery_attempt error_message on a non-final attempt (attempt_count=1)", async () => {
    // attempt_count=1 means this is the second attempt (newAttemptCount=2) — a re-queue would
    // still be possible by attempt count alone.  But dead tokens are non-retryable regardless,
    // so the row is finalised immediately.  This test confirms that finalise() copies last_error
    // into notification_delivery_attempts.error_message even in this mixed-code, non-final case.
    // A regression in finalise() would leave error_message null and silently hide both codes.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [DEAD_TOKEN, DEAD_TOKEN_IC],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoMixedDeadTokenFetch());
    await queue.processQueue();

    // ── Queue row must be finalised as 'failed' — never re-queued ─────────────
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' for mixed dead-token batch at attempt_count=1");
    assert.equal(failedUpdate.filters.id, QUEUE_ROW_ID, "failed update must target the correct queue row");

    // last_error must name both codes
    const lastError = failedUpdate.patch.last_error as string;
    assert.ok(
      lastError && lastError.includes("DeviceNotRegistered \u00d7 1"),
      `last_error must include "DeviceNotRegistered × 1"; got: ${lastError}`,
    );
    assert.ok(
      lastError.includes("InvalidCredentials \u00d7 1"),
      `last_error must include "InvalidCredentials × 1"; got: ${lastError}`,
    );

    // Must NOT be re-queued — dead tokens are non-retryable regardless of remaining attempts
    assert.ok(
      !prqUpdates.some((c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID),
      "must NOT re-queue a row where all tokens are permanently dead (mixed error codes, non-final attempt)",
    );

    // ── Delivery attempt error_message must mirror last_error ─────────────────
    // This is the core regression guard: finalise() must copy last_error into error_message.
    // If it does not, error_message will be null and both codes will be silently lost.
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated for mixed dead-token batch");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
    const ndaErrorMsg = ndaUpdate.patch.error_message as string;
    assert.ok(
      ndaErrorMsg && ndaErrorMsg.includes("DeviceNotRegistered \u00d7 1"),
      `delivery_attempt error_message must include "DeviceNotRegistered × 1"; got: ${ndaErrorMsg}`,
    );
    assert.ok(
      ndaErrorMsg.includes("InvalidCredentials \u00d7 1"),
      `delivery_attempt error_message must include "InvalidCredentials × 1"; got: ${ndaErrorMsg}`,
    );
  });

  it("names both DeviceNotRegistered and InvalidCredentials in last_error on the final attempt (attempt_count=2)", async () => {
    // attempt_count=2 means two prior failures; this run is attempt 3 — the final attempt.
    // Two tokens: one DeviceNotRegistered (DEAD_TOKEN), one InvalidCredentials (DEAD_TOKEN_IC).
    // Both are non-retryable dead-token codes, so:
    //   • both wiped from all three storage tables
    //   • queue row finalised as 'failed' (not re-queued)
    //   • last_error must contain BOTH "DeviceNotRegistered × 1" and "InvalidCredentials × 1"
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [DEAD_TOKEN, DEAD_TOKEN_IC],
      payload:             BASE_PAYLOAD,
      attempt_count:       2,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoMixedDeadTokenFetch());
    await queue.processQueue();

    // ── Both tokens must be wiped from all three tables ───────────────────────

    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for both dead tokens on final attempt");
    assert.deepEqual(
      [...(profileUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "profiles update must target both dead tokens",
    );

    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows must be deleted for both dead tokens on final attempt");
    assert.deepEqual(
      [...(deviceDelete.inFilters["push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "notification_devices delete must target both dead tokens",
    );

    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for both dead tokens on final attempt");
    assert.deepEqual(
      [...(rentUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "rent_buddy_profiles update must target both dead tokens",
    );

    // ── Queue row must be finalised as 'failed' — NOT re-queued ──────────────

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' on final attempt with mixed dead tokens");
    assert.equal(failedUpdate.filters.id,      QUEUE_ROW_ID, "failed update must target the correct queue row");
    assert.equal(failedUpdate.patch.attempt_count, 3,        "attempt_count must be 3 (the final attempt)");

    // last_error must name BOTH codes with their respective counts.
    const lastError = failedUpdate.patch.last_error as string;
    assert.ok(
      lastError && lastError.length > 0,
      "last_error must be non-empty on final attempt with mixed dead tokens",
    );
    assert.ok(
      lastError.includes("DeviceNotRegistered \u00d7 1"),
      `last_error must include "DeviceNotRegistered × 1"; got: ${lastError}`,
    );
    assert.ok(
      lastError.includes("InvalidCredentials \u00d7 1"),
      `last_error must include "InvalidCredentials × 1"; got: ${lastError}`,
    );

    // Must NOT be re-queued — max_attempts reached and all tokens are permanently dead
    assert.ok(
      !prqUpdates.some((c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID),
      "must NOT re-queue on final attempt when all tokens are permanently dead (mixed error codes)",
    );

    // ── Delivery attempt must also be finalised as 'failed' ───────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated on final mixed dead-token attempt");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
    // error_message must mirror last_error — both codes must appear there too
    const ndaErrorMsg = ndaUpdate.patch.error_message as string;
    assert.ok(
      ndaErrorMsg && ndaErrorMsg.includes("DeviceNotRegistered \u00d7 1"),
      `delivery_attempt error_message must include "DeviceNotRegistered × 1"; got: ${ndaErrorMsg}`,
    );
    assert.ok(
      ndaErrorMsg.includes("InvalidCredentials \u00d7 1"),
      `delivery_attempt error_message must include "InvalidCredentials × 1"; got: ${ndaErrorMsg}`,
    );
  });

  /**
   * Expo returns a 200 with two tickets, both DeviceNotRegistered.
   * The reduce accumulator must aggregate them into a single count of 2,
   * producing "DeviceNotRegistered × 2" — not "DeviceNotRegistered × 1, DeviceNotRegistered × 1".
   */
  function expoDualSameDeadTokenFetch(): typeof fetch {
    return async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              status:  "error",
              message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
              details: { error: "DeviceNotRegistered" },
            },
            {
              status:  "error",
              message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
              details: { error: "DeviceNotRegistered" },
            },
          ],
        }),
        { status: 200 },
      ) as unknown as Response;
  }

  it("aggregates two DeviceNotRegistered tickets into 'DeviceNotRegistered × 2' — not × 1 twice", async () => {
    // Two tokens in the batch; Expo reports DeviceNotRegistered for BOTH.
    // The reduce accumulator must merge them into a single entry with count 2,
    // so last_error is exactly "DeviceNotRegistered × 2".
    // This exercises the same-code-multiple-occurrences path in the lastErr formatter.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, LIVE_TOKEN_B],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoDualSameDeadTokenFetch());
    await queue.processQueue();

    // ── Queue row must be finalised as 'failed' with the aggregated count ─────
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' when all tokens are dead");
    assert.equal(failedUpdate.filters.id, QUEUE_ROW_ID, "failed update must target the correct queue row");

    // The critical assertion: two occurrences of the same code must be merged into × 2
    assert.equal(
      failedUpdate.patch.last_error,
      "DeviceNotRegistered \u00d7 2",
      "last_error must be 'DeviceNotRegistered × 2' when two tokens share the same dead-token code",
    );

    // Must NOT be re-queued — dead tokens are non-retryable regardless of remaining attempts
    assert.ok(
      !prqUpdates.some((c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID),
      "must NOT re-queue a row where all tokens are permanently dead (same error code)",
    );

    // ── Delivery attempt must also be finalised as 'failed' with the same message ─
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
    assert.equal(
      ndaUpdate.patch.error_message,
      "DeviceNotRegistered \u00d7 2",
      "delivery_attempt error_message must mirror last_error ('DeviceNotRegistered × 2')",
    );
  });

  /**
   * Expo returns a 200 with three tickets: the first token delivers ('ok'),
   * the second is DeviceNotRegistered, and the third is InvalidCredentials.
   * result.sent > 0, so the queue row must finalise as 'sent' — not 'failed'.
   * Both dead tokens must still be wiped from all three storage tables.
   */
  function expoMixedPartialSuccessFetch(): typeof fetch {
    return async () =>
      new Response(
        JSON.stringify({
          data: [
            { status: "ok", id: "rcpt-mixed-partial-ok" },
            {
              status:  "error",
              message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
              details: { error: "DeviceNotRegistered" },
            },
            {
              status:  "error",
              message: "The push notification service reported that the push token is invalid: InvalidCredentials",
              details: { error: "InvalidCredentials" },
            },
          ],
        }),
        { status: 200 },
      ) as unknown as Response;
  }

  it("finalises as 'sent' — not 'failed' — when one token delivers and two others are dead (DeviceNotRegistered + InvalidCredentials)", async () => {
    // Three tokens in the batch:
    //   PUSH_TOKEN    → "ok" (delivered)
    //   DEAD_TOKEN    → DeviceNotRegistered (permanently dead)
    //   DEAD_TOKEN_IC → InvalidCredentials  (permanently dead)
    //
    // Because result.sent > 0 the queue row must finalise as 'sent'.
    // The dead-token clearing path must still wipe both dead tokens from
    // all three storage tables before the 'sent' finalisation.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN, DEAD_TOKEN_IC],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoMixedPartialSuccessFetch());
    await queue.processQueue();

    // ── Both dead tokens must be wiped from all three tables ──────────────────

    // profiles.expo_push_token nulled via update().in([DEAD_TOKEN, DEAD_TOKEN_IC])
    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for both dead tokens");
    assert.deepEqual(
      [...(profileUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "profiles update must target both dead tokens — not the live one",
    );

    // notification_devices rows deleted via delete().in([DEAD_TOKEN, DEAD_TOKEN_IC])
    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows must be deleted for both dead tokens");
    assert.deepEqual(
      [...(deviceDelete.inFilters["push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "notification_devices delete must target both dead tokens — not the live one",
    );

    // rent_buddy_profiles.expo_push_token nulled via update().in([DEAD_TOKEN, DEAD_TOKEN_IC])
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for both dead tokens");
    assert.deepEqual(
      [...(rentUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "rent_buddy_profiles update must target both dead tokens — not the live one",
    );

    // ── Queue row must be finalised as 'sent', not 'failed' ───────────────────
    // sent > 0 (PUSH_TOKEN delivered ok) takes priority over the dead-token errors.

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(sentUpdate, "push_retry_queue must be finalised as 'sent' when at least one token delivered");
    assert.equal(sentUpdate.filters.id, QUEUE_ROW_ID, "sent update must target the correct queue row");
    assert.equal(sentUpdate.patch.attempt_count, 2, "attempt_count must be 2 (the retry attempt)");

    // Must NOT be marked 'failed' — dead-token grouping logic must not override 'sent'
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(!failedUpdate, "must NOT mark the queue row 'failed' when partial delivery succeeded");

    // Must NOT be re-queued — partial success is a terminal outcome
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue the row when partial delivery succeeded");

    // ── Delivery attempt must also be marked 'sent' ───────────────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "sent",    "delivery_attempt status must be 'sent'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });

  it("finalises as 'sent' on the FINAL allowed attempt when one token delivers and two others are dead (attempt_count=2)", async () => {
    // attempt_count=2 means two prior failures; this run is attempt 3 — the final attempt.
    // Three tokens: PUSH_TOKEN delivers ok, DEAD_TOKEN is DeviceNotRegistered,
    // DEAD_TOKEN_IC is InvalidCredentials.
    //
    // The critical path: newAttemptCount (3) === maxAttempts (3), so
    // `newAttemptCount < maxAttempts` is false — the row would fall through to
    // "failed" if result.sent > 0 were not checked first.
    // Assert: both dead tokens wiped; row → 'sent'; NOT 'failed'; NOT re-queued;
    //         delivery_attempt → 'sent'; attempt_count === 3.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN, DEAD_TOKEN_IC],
      payload:             BASE_PAYLOAD,
      attempt_count:       2,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoMixedPartialSuccessFetch());
    await queue.processQueue();

    // ── Both dead tokens must be wiped from all three tables ──────────────────

    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for both dead tokens on final attempt");
    assert.deepEqual(
      [...(profileUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "profiles update must target both dead tokens — not the live one",
    );

    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows must be deleted for both dead tokens on final attempt");
    assert.deepEqual(
      [...(deviceDelete.inFilters["push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "notification_devices delete must target both dead tokens — not the live one",
    );

    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for both dead tokens on final attempt");
    assert.deepEqual(
      [...(rentUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "rent_buddy_profiles update must target both dead tokens — not the live one",
    );

    // ── Queue row must be finalised as 'sent' — NOT 'failed', NOT re-queued ───

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(sentUpdate, "push_retry_queue must be finalised as 'sent' when at least one token delivered (final attempt)");
    assert.equal(sentUpdate.filters.id,      QUEUE_ROW_ID, "sent update must target the correct queue row");
    assert.equal(sentUpdate.patch.attempt_count, 3,        "attempt_count must be 3 (the final attempt)");

    // Must NOT be marked 'failed' — result.sent > 0 takes priority even on the final attempt
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(!failedUpdate, "must NOT mark the queue row 'failed' when partial delivery succeeded on the final attempt");

    // Must NOT be re-queued — newAttemptCount === maxAttempts, so re-queue guard is false
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue the row on the final attempt when partial delivery succeeded");

    // ── Delivery attempt must also be marked 'sent' ───────────────────────────
    const ndaUpdates2 = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates2.length > 0, "notification_delivery_attempts must be updated on final-attempt partial success");
    const ndaUpdate2 = ndaUpdates2[ndaUpdates2.length - 1];
    assert.equal(ndaUpdate2.patch.status, "sent",    "delivery_attempt status must be 'sent' on final-attempt partial success");
    assert.equal(ndaUpdate2.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });

  it("finalises as 'sent' on the FINAL allowed attempt when one of two tokens delivers and the other is dead (attempt_count=2)", async () => {
    // attempt_count=2 means two prior failures; this run is attempt 3 — the final attempt.
    // Two tokens: PUSH_TOKEN delivers ok, DEAD_TOKEN is DeviceNotRegistered.
    //
    // This is the simpler two-token partial-success case. The critical path:
    // newAttemptCount (3) === maxAttempts (3), so `newAttemptCount < maxAttempts`
    // is false — the row would fall through to 'failed' if result.sent > 0 were
    // not checked first.
    // Assert: DEAD_TOKEN wiped from all three tables; row → 'sent'; NOT 'failed';
    //         NOT re-queued; delivery_attempt → 'sent'; attempt_count === 3.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       2,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    // expoPartialSuccessFetch(): ticket[0] = ok (PUSH_TOKEN), ticket[1] = DeviceNotRegistered (DEAD_TOKEN)
    _setTestFetch(expoPartialSuccessFetch());
    await queue.processQueue();

    // ── DEAD_TOKEN must be wiped from all three tables ────────────────────────

    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for the dead token on final attempt");
    assert.deepEqual(
      profileUpdate.inFilters["expo_push_token"],
      [DEAD_TOKEN],
      "profiles update must target only the dead token — not the live one",
    );

    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows must be deleted for the dead token on final attempt");
    assert.deepEqual(
      deviceDelete.inFilters["push_token"],
      [DEAD_TOKEN],
      "notification_devices delete must target only the dead token — not the live one",
    );

    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for the dead token on final attempt");
    assert.deepEqual(
      rentUpdate.inFilters["expo_push_token"],
      [DEAD_TOKEN],
      "rent_buddy_profiles update must target only the dead token — not the live one",
    );

    // ── Queue row must be finalised as 'sent' — NOT 'failed', NOT re-queued ───

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(sentUpdate, "push_retry_queue must be finalised as 'sent' when at least one token delivered (two-token, final attempt)");
    assert.equal(sentUpdate.filters.id,        QUEUE_ROW_ID, "sent update must target the correct queue row");
    assert.equal(sentUpdate.patch.attempt_count, 3,          "attempt_count must be 3 (the final attempt)");

    // Must NOT be marked 'failed' — result.sent > 0 takes priority even on the final attempt
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(!failedUpdate, "must NOT mark the queue row 'failed' when partial delivery succeeded on the final attempt");

    // Must NOT be re-queued — newAttemptCount === maxAttempts, so re-queue guard is false
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue the row on the final attempt when partial delivery succeeded");

    // ── Delivery attempt must also be marked 'sent' ───────────────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated on final-attempt two-token partial success");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "sent",     "delivery_attempt status must be 'sent' on final-attempt partial success");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 — Partial-success: one token delivers, one is dead
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.processQueue() — partial success (one ok, one dead)", () => {
  it("clears the dead token from all three tables and finalises the queue row as 'sent'", async () => {
    // The batch has two tokens. PUSH_TOKEN delivers; DEAD_TOKEN is DeviceNotRegistered.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    // Expo: first ticket ok (PUSH_TOKEN), second ticket DeviceNotRegistered (DEAD_TOKEN)
    _setTestFetch(expoPartialSuccessFetch());
    await queue.processQueue();

    // ── Dead-token cleanup must have run for DEAD_TOKEN only ──────────────────

    // profiles.expo_push_token nulled via update().in([DEAD_TOKEN])
    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for the dead token");
    assert.deepEqual(
      profileUpdate.inFilters["expo_push_token"],
      [DEAD_TOKEN],
      "profiles update must target only the dead token, not the live one",
    );

    // notification_devices row deleted via delete().in([DEAD_TOKEN])
    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices row must be deleted for the dead token");
    assert.deepEqual(
      deviceDelete.inFilters["push_token"],
      [DEAD_TOKEN],
      "notification_devices delete must target only the dead token",
    );

    // rent_buddy_profiles.expo_push_token nulled via update().in([DEAD_TOKEN])
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for the dead token");
    assert.deepEqual(
      rentUpdate.inFilters["expo_push_token"],
      [DEAD_TOKEN],
      "rent_buddy_profiles update must target only the dead token",
    );

    // ── Queue row must be finalised as 'sent', not 'failed' ───────────────────
    // sent > 0 (PUSH_TOKEN delivered) overrides the dead-token error.

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(sentUpdate, "push_retry_queue must be finalised as 'sent' when at least one token delivered");
    assert.equal(sentUpdate.filters.id, QUEUE_ROW_ID, "sent update must target the correct queue row");

    // Must NOT be marked failed or re-queued
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(!failedUpdate, "must NOT mark the queue row 'failed' when partial delivery succeeded");

    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue the row when partial delivery succeeded");

    // ── Delivery attempt must also be marked 'sent' ───────────────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "sent",   "delivery_attempt status must be 'sent'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 — Partial-success on the FINAL attempt: must not re-queue
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.processQueue() — partial success on final attempt", () => {
  it("clears dead token, finalises as 'sent', and does NOT re-queue when attempt_count=2 (final)", async () => {
    // attempt_count=2 means two prior failures; this run is attempt 3 (= max_attempts).
    // Expo returns one ok (PUSH_TOKEN) and one DeviceNotRegistered (DEAD_TOKEN).
    // Expected: dead-token cleanup runs, queue row → 'sent', NOT re-queued.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       2,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    // Expo: first ticket ok (PUSH_TOKEN), second ticket DeviceNotRegistered (DEAD_TOKEN)
    _setTestFetch(expoPartialSuccessFetch());
    await queue.processQueue();

    // ── Dead-token cleanup must run for DEAD_TOKEN ────────────────────────────

    // profiles.expo_push_token nulled via update().in([DEAD_TOKEN])
    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for the dead token on final attempt");
    assert.deepEqual(
      profileUpdate.inFilters["expo_push_token"],
      [DEAD_TOKEN],
      "profiles update must target only the dead token",
    );

    // notification_devices row deleted via delete().in([DEAD_TOKEN])
    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices row must be deleted for the dead token on final attempt");
    assert.deepEqual(
      deviceDelete.inFilters["push_token"],
      [DEAD_TOKEN],
      "notification_devices delete must target only the dead token",
    );

    // rent_buddy_profiles.expo_push_token nulled via update().in([DEAD_TOKEN])
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for the dead token on final attempt");
    assert.deepEqual(
      rentUpdate.inFilters["expo_push_token"],
      [DEAD_TOKEN],
      "rent_buddy_profiles update must target only the dead token",
    );

    // ── Queue row must be finalised as 'sent' (partial delivery counts) ───────

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(sentUpdate, "push_retry_queue must be finalised as 'sent' when at least one token delivered on final attempt");
    assert.equal(sentUpdate.filters.id,      QUEUE_ROW_ID, "sent update must target the correct queue row");
    assert.equal(sentUpdate.patch.attempt_count, 3,        "attempt_count must be 3 (the final attempt)");

    // Must NOT be marked failed
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(!failedUpdate, "must NOT mark the queue row 'failed' when partial delivery succeeded on final attempt");

    // ── MUST NOT re-queue — this was the last allowed attempt ─────────────────
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue the row after the final attempt, even for partial success");

    // ── Delivery attempt must also be marked 'sent' ───────────────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated on final-attempt partial success");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "sent",    "delivery_attempt status must be 'sent'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
    assert.deepEqual(
      ndaUpdate.patch.metadata,
      { retryAttempts: 3 },
      "delivery_attempt metadata.retryAttempts must be 3 (the post-increment attempt count) — not the pre-increment value 2",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 — All-dead batch: every token returns DeviceNotRegistered
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expo returns a 200 with two error tickets, one per token — both are
 * DeviceNotRegistered.  This exercises the all-dead path where result.sent===0
 * and every ticket is a permanent failure.
 */
function expoAllDeadFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
            details: { error: "DeviceNotRegistered" },
          },
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
            details: { error: "DeviceNotRegistered" },
          },
        ],
      }),
      { status: 200 },
    ) as unknown as Response;
}

describe("PushRetryQueue.processQueue() — all-dead batch (every token DeviceNotRegistered)", () => {
  it("wipes both dead tokens from all three tables and finalises the queue row as 'failed'", async () => {
    // Queue row carries two tokens; Expo will report DeviceNotRegistered for both.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoAllDeadFetch());
    await queue.processQueue();

    // ── Both tokens must be wiped from all three tables ───────────────────────

    // profiles.expo_push_token nulled via update().in([PUSH_TOKEN, DEAD_TOKEN])
    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for dead tokens");
    assert.deepEqual(
      [...(profileUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN].sort(),
      "profiles update must target both dead tokens",
    );

    // notification_devices rows deleted via delete().in([PUSH_TOKEN, DEAD_TOKEN])
    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows must be deleted for dead tokens");
    assert.deepEqual(
      [...(deviceDelete.inFilters["push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN].sort(),
      "notification_devices delete must target both dead tokens",
    );

    // rent_buddy_profiles.expo_push_token nulled via update().in([PUSH_TOKEN, DEAD_TOKEN])
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for dead tokens");
    assert.deepEqual(
      [...(rentUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN].sort(),
      "rent_buddy_profiles update must target both dead tokens",
    );

    // ── Queue row must be finalised as 'failed' — never re-queued ─────────────
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' when all tokens are dead");
    assert.equal(failedUpdate.filters.id, QUEUE_ROW_ID, "failed update must target the correct queue row");
    assert.equal(
      failedUpdate.patch.last_error,
      "DeviceNotRegistered \u00d7 2",
      "last_error must name the error code and total count of dead tokens",
    );

    // Must NOT be re-queued — dead tokens are permanent, retrying is wasteful
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue a row where every token is permanently dead");

    // ── Delivery attempt must also be finalised as 'failed' ───────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 — Stale 'processing' recovery: attempt_count must not change
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.recoverStaleProcessing() — stale row reset", () => {
  it("resets a stale 'processing' row to 'queued' without touching attempt_count", async () => {
    // No queued rows to process — we only want to exercise recoverStaleProcessing().
    // The fake client has no rows to claim so processQueue() returns early after recovery.
    const client = makeFakeClient([]);
    const queue  = new PushRetryQueue(client as never);

    const before = Date.now();
    await queue.processQueue();
    const after = Date.now();

    // recoverStaleProcessing() issues an UPDATE … .eq("status","processing")
    // The fake client records every update call regardless of whether real rows matched.
    const recoveryUpdate = client.updateCalls.find(
      (c) => c.table === "push_retry_queue" && c.filters["status"] === "processing",
    );
    assert.ok(
      recoveryUpdate,
      "recoverStaleProcessing must issue an UPDATE on push_retry_queue with eq('status','processing')",
    );

    // The patch must flip status back to 'queued'
    assert.equal(
      recoveryUpdate.patch.status,
      "queued",
      "recovery patch must set status='queued'",
    );

    // next_retry_at must be ≈ now so the row is picked up immediately on the next tick
    const nextMs    = new Date(recoveryUpdate.patch.next_retry_at as string).getTime();
    const expectMin = before - 100;  // tiny clock-skew tolerance
    const expectMax = after  + 500;  // generous upper bound
    assert.ok(
      nextMs >= expectMin && nextMs <= expectMax,
      `next_retry_at must be ≈ now for crash recovery; got ${recoveryUpdate.patch.next_retry_at} (window ${expectMin}–${expectMax})`,
    );

    // attempt_count must NOT be present in the patch — stale recovery must never
    // consume a retry attempt; incrementing here would exhaust the budget one attempt early.
    assert.equal(
      recoveryUpdate.patch["attempt_count"],
      undefined,
      "recovery patch must NOT include attempt_count — stale row reset must not consume a retry attempt",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10b — Stale 'processing' recovery: within-threshold row must NOT be reset
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.recoverStaleProcessing() — within-threshold row left alone", () => {
  it("applies lt('updated_at', staleThreshold) with a cutoff ≈ now − 2 min, leaving a 30-second-old row untouched", async () => {
    // We only want to verify the cutoff timestamp passed to .lt(); no queued
    // rows are needed because we are not testing the claim/process path.
    const client = makeFakeClient([]);
    const queue  = new PushRetryQueue(client as never);

    const before = Date.now();
    await queue.processQueue();
    const after  = Date.now();

    // recoverStaleProcessing() must issue an UPDATE with eq("status","processing")
    const recoveryUpdate = client.updateCalls.find(
      (c) => c.table === "push_retry_queue" && c.filters["status"] === "processing",
    );
    assert.ok(
      recoveryUpdate,
      "recoverStaleProcessing must issue an UPDATE on push_retry_queue filtered by status='processing'",
    );

    // The lt("updated_at", staleThreshold) filter must be present and carry
    // a cutoff of approximately now − 2 minutes (STALE_PROCESSING_THRESHOLD_MS).
    const cutoffRaw = recoveryUpdate.ltFilters["updated_at"];
    assert.ok(
      cutoffRaw !== undefined,
      "recoverStaleProcessing must pass an lt('updated_at', ...) filter so fresh rows are excluded",
    );

    const cutoffMs = new Date(cutoffRaw as string).getTime();

    // The cutoff must be ≈ (now − 2 min).  Allow ±500 ms clock slop.
    const THRESHOLD_MS = 2 * 60 * 1_000;
    const expectedMin  = before - THRESHOLD_MS - 500;
    const expectedMax  = after  - THRESHOLD_MS + 500;

    assert.ok(
      cutoffMs >= expectedMin && cutoffMs <= expectedMax,
      `lt cutoff must be ≈ now−2min; got ${cutoffRaw} ` +
      `(expected range ${new Date(expectedMin).toISOString()}–${new Date(expectedMax).toISOString()})`,
    );

    // Demonstrate what the filter means: a row updated only 30 seconds ago
    // has updated_at > cutoff, so lt("updated_at", cutoff) would NOT match it.
    const thirtySecondsAgoMs = Date.now() - 30_000;
    assert.ok(
      thirtySecondsAgoMs > cutoffMs,
      "a row updated 30 seconds ago must be newer than the stale cutoff — lt() would not match it",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11 — Surgical precision: three-token batch, only one dead
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expo returns a 200 with three tickets: PUSH_TOKEN ok, LIVE_TOKEN_B ok,
 * DEAD_TOKEN DeviceNotRegistered.  Verifies clearDeadTokens targets exactly
 * the dead token — the two live tokens must not appear in any cleanup call.
 */
function expoTwoOkOneDeadFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          { status: "ok", id: "rcpt-ok-1" },
          { status: "ok", id: "rcpt-ok-2" },
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
            details: { error: "DeviceNotRegistered" },
          },
        ],
      }),
      { status: 200 },
    ) as unknown as Response;
}

describe("PushRetryQueue.processQueue() — three-token batch, only the dead token wiped", () => {
  it("clears only the dead token and leaves both live tokens untouched in all three tables", async () => {
    // Queue row carries three tokens; Expo will deliver two and report one dead.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, LIVE_TOKEN_B, DEAD_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoTwoOkOneDeadFetch());
    await queue.processQueue();

    // ── Dead-token cleanup must target exactly DEAD_TOKEN ─────────────────────

    // profiles.expo_push_token nulled via update().in([DEAD_TOKEN])
    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for the dead token");
    assert.deepEqual(
      profileUpdate.inFilters["expo_push_token"],
      [DEAD_TOKEN],
      "profiles update must target only DEAD_TOKEN — not PUSH_TOKEN or LIVE_TOKEN_B",
    );
    assert.ok(
      !(profileUpdate.inFilters["expo_push_token"] as string[]).includes(PUSH_TOKEN),
      "PUSH_TOKEN must NOT appear in the profiles dead-token cleanup",
    );
    assert.ok(
      !(profileUpdate.inFilters["expo_push_token"] as string[]).includes(LIVE_TOKEN_B),
      "LIVE_TOKEN_B must NOT appear in the profiles dead-token cleanup",
    );

    // notification_devices row deleted via delete().in([DEAD_TOKEN])
    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices row must be deleted for the dead token");
    assert.deepEqual(
      deviceDelete.inFilters["push_token"],
      [DEAD_TOKEN],
      "notification_devices delete must target only DEAD_TOKEN",
    );
    assert.ok(
      !(deviceDelete.inFilters["push_token"] as string[]).includes(PUSH_TOKEN),
      "PUSH_TOKEN must NOT appear in the notification_devices dead-token delete",
    );
    assert.ok(
      !(deviceDelete.inFilters["push_token"] as string[]).includes(LIVE_TOKEN_B),
      "LIVE_TOKEN_B must NOT appear in the notification_devices dead-token delete",
    );

    // rent_buddy_profiles.expo_push_token nulled via update().in([DEAD_TOKEN])
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for the dead token");
    assert.deepEqual(
      rentUpdate.inFilters["expo_push_token"],
      [DEAD_TOKEN],
      "rent_buddy_profiles update must target only DEAD_TOKEN",
    );
    assert.ok(
      !(rentUpdate.inFilters["expo_push_token"] as string[]).includes(PUSH_TOKEN),
      "PUSH_TOKEN must NOT appear in the rent_buddy_profiles dead-token cleanup",
    );
    assert.ok(
      !(rentUpdate.inFilters["expo_push_token"] as string[]).includes(LIVE_TOKEN_B),
      "LIVE_TOKEN_B must NOT appear in the rent_buddy_profiles dead-token cleanup",
    );

    // ── Queue row must be finalised as 'sent' (two tokens delivered) ──────────
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(sentUpdate, "push_retry_queue must be finalised as 'sent' when two of three tokens delivered");
    assert.equal(sentUpdate.filters.id, QUEUE_ROW_ID, "sent update must target the correct queue row");

    // Must NOT be marked failed or re-queued
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(!failedUpdate, "must NOT mark the queue row 'failed' when two tokens delivered successfully");

    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue the row when partial delivery succeeded");

    // ── Delivery attempt must also be marked 'sent' ───────────────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "sent",    "delivery_attempt status must be 'sent'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12 — Mixed four-token batch: two live, one DeviceNotRegistered, one InvalidCredentials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expo returns a 200 with four tickets:
 *   PUSH_TOKEN    → ok
 *   LIVE_TOKEN_B  → ok
 *   DEAD_TOKEN    → DeviceNotRegistered
 *   DEAD_TOKEN_IC → InvalidCredentials
 *
 * Both dead-token error codes must be collected into a single
 * clearDeadTokens call. The two live tokens must not appear in any
 * in-filter across profiles / notification_devices / rent_buddy_profiles.
 */
function expoTwoOkTwoDeadMixedFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          { status: "ok", id: "rcpt-ok-1" },
          { status: "ok", id: "rcpt-ok-2" },
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
            details: { error: "DeviceNotRegistered" },
          },
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: InvalidCredentials",
            details: { error: "InvalidCredentials" },
          },
        ],
      }),
      { status: 200 },
    ) as unknown as Response;
}

describe("PushRetryQueue.processQueue() — mixed four-token batch (two live, one DeviceNotRegistered, one InvalidCredentials)", () => {
  it("wipes only the two dead tokens from all three tables and leaves both live tokens untouched", async () => {
    // Four tokens: PUSH_TOKEN and LIVE_TOKEN_B are live; DEAD_TOKEN is
    // DeviceNotRegistered, DEAD_TOKEN_IC is InvalidCredentials.
    // Expo delivers two ok tickets and two error tickets (one each code).
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, LIVE_TOKEN_B, DEAD_TOKEN, DEAD_TOKEN_IC],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoTwoOkTwoDeadMixedFetch());
    await queue.processQueue();

    // ── Dead-token cleanup must target exactly the two dead tokens ────────────

    // profiles.expo_push_token nulled via update().in([DEAD_TOKEN, DEAD_TOKEN_IC])
    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for dead tokens");
    const profileTokens = [...(profileUpdate.inFilters["expo_push_token"] as string[])].sort();
    assert.deepEqual(
      profileTokens,
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "profiles update must target exactly the two dead tokens",
    );
    assert.ok(
      !profileTokens.includes(PUSH_TOKEN),
      "PUSH_TOKEN (live) must NOT appear in profiles dead-token cleanup",
    );
    assert.ok(
      !profileTokens.includes(LIVE_TOKEN_B),
      "LIVE_TOKEN_B (live) must NOT appear in profiles dead-token cleanup",
    );

    // notification_devices rows deleted via delete().in([DEAD_TOKEN, DEAD_TOKEN_IC])
    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows must be deleted for dead tokens");
    const deviceTokens = [...(deviceDelete.inFilters["push_token"] as string[])].sort();
    assert.deepEqual(
      deviceTokens,
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "notification_devices delete must target exactly the two dead tokens",
    );
    assert.ok(
      !deviceTokens.includes(PUSH_TOKEN),
      "PUSH_TOKEN (live) must NOT appear in notification_devices dead-token delete",
    );
    assert.ok(
      !deviceTokens.includes(LIVE_TOKEN_B),
      "LIVE_TOKEN_B (live) must NOT appear in notification_devices dead-token delete",
    );

    // rent_buddy_profiles.expo_push_token nulled via update().in([DEAD_TOKEN, DEAD_TOKEN_IC])
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for dead tokens");
    const rentTokens = [...(rentUpdate.inFilters["expo_push_token"] as string[])].sort();
    assert.deepEqual(
      rentTokens,
      [DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "rent_buddy_profiles update must target exactly the two dead tokens",
    );
    assert.ok(
      !rentTokens.includes(PUSH_TOKEN),
      "PUSH_TOKEN (live) must NOT appear in rent_buddy_profiles dead-token cleanup",
    );
    assert.ok(
      !rentTokens.includes(LIVE_TOKEN_B),
      "LIVE_TOKEN_B (live) must NOT appear in rent_buddy_profiles dead-token cleanup",
    );

    // ── clearDeadTokens must have been called exactly once (one batch) ────────
    // Verified indirectly: exactly one nulling update per table means both dead
    // tokens were passed in a single clearDeadTokens call, not two separate ones.
    const profileDeadUpdates = client.updateCalls.filter(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.equal(
      profileDeadUpdates.length,
      1,
      "clearDeadTokens must be called exactly once — both dead tokens in a single batch",
    );

    const deviceDeadDeletes = client.deleteCalls.filter((c) => c.table === "notification_devices");
    assert.equal(
      deviceDeadDeletes.length,
      1,
      "notification_devices delete must occur exactly once — both dead tokens in a single batch",
    );

    const rentDeadUpdates = client.updateCalls.filter(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.equal(
      rentDeadUpdates.length,
      1,
      "rent_buddy_profiles update must occur exactly once — both dead tokens in a single batch",
    );

    // ── Queue row must be finalised as 'sent' (two tokens delivered) ──────────
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(sentUpdate, "push_retry_queue must be finalised as 'sent' when two of four tokens delivered");
    assert.equal(sentUpdate.filters.id, QUEUE_ROW_ID, "sent update must target the correct queue row");

    // Must NOT be marked failed or re-queued
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(!failedUpdate, "must NOT mark the queue row 'failed' when two tokens delivered successfully");

    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(!requeued, "must NOT re-queue the row when partial delivery succeeded");

    // ── Delivery attempt must also be marked 'sent' ───────────────────────────
    const ndaUpdates2 = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates2.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate2 = ndaUpdates2[ndaUpdates2.length - 1];
    assert.equal(ndaUpdate2.patch.status, "sent",    "delivery_attempt status must be 'sent'");
    assert.equal(ndaUpdate2.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13 — Duplicate error code: 2× DeviceNotRegistered + 1× InvalidCredentials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expo returns a 200 with three error tickets:
 *   PUSH_TOKEN    → DeviceNotRegistered (dead)
 *   DEAD_TOKEN    → DeviceNotRegistered (dead)
 *   DEAD_TOKEN_IC → InvalidCredentials  (dead)
 *
 * The grouping reduce must accumulate the repeated DeviceNotRegistered code
 * to produce "DeviceNotRegistered × 2" — not "DeviceNotRegistered × 1" twice.
 */
function expoDuplicateErrorCodeFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
            details: { error: "DeviceNotRegistered" },
          },
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
            details: { error: "DeviceNotRegistered" },
          },
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: InvalidCredentials",
            details: { error: "InvalidCredentials" },
          },
        ],
      }),
      { status: 200 },
    ) as unknown as Response;
}

describe("PushRetryQueue.processQueue() — duplicate error code (2× DeviceNotRegistered + 1× InvalidCredentials)", () => {
  it("produces 'DeviceNotRegistered × 2' and 'InvalidCredentials × 1' in last_error and wipes all three tokens", async () => {
    // Three tokens; Expo reports DeviceNotRegistered for the first two and
    // InvalidCredentials for the third.  The reduce accumulator must count the
    // repeated DeviceNotRegistered as 2 rather than resetting to 1 on each entry.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN, DEAD_TOKEN_IC],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoDuplicateErrorCodeFetch());
    await queue.processQueue();

    // ── All three tokens must be wiped from all three tables ──────────────────

    const profileUpdate = client.updateCalls.find(
      (c) => c.table === "profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(profileUpdate, "profiles.expo_push_token must be nulled for all three dead tokens");
    assert.deepEqual(
      [...(profileUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "profiles update must target all three dead tokens",
    );

    const deviceDelete = client.deleteCalls.find((c) => c.table === "notification_devices");
    assert.ok(deviceDelete, "notification_devices rows must be deleted for all three dead tokens");
    assert.deepEqual(
      [...(deviceDelete.inFilters["push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "notification_devices delete must target all three dead tokens",
    );

    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(rentUpdate, "rent_buddy_profiles.expo_push_token must be nulled for all three dead tokens");
    assert.deepEqual(
      [...(rentUpdate.inFilters["expo_push_token"] as string[])].sort(),
      [PUSH_TOKEN, DEAD_TOKEN, DEAD_TOKEN_IC].sort(),
      "rent_buddy_profiles update must target all three dead tokens",
    );

    // ── Queue row must be finalised as 'failed' — never re-queued ─────────────
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' for all-dead batch");
    assert.equal(failedUpdate.filters.id, QUEUE_ROW_ID, "failed update must target the correct queue row");

    // last_error must reflect the accumulated counts:
    //   DeviceNotRegistered appears twice → "DeviceNotRegistered × 2"
    //   InvalidCredentials appears once  → "InvalidCredentials × 1"
    const lastError = failedUpdate.patch.last_error as string;
    assert.ok(
      lastError.includes("DeviceNotRegistered \u00d7 2"),
      `last_error must contain "DeviceNotRegistered × 2" to prove the accumulator counted correctly; got: ${lastError}`,
    );
    assert.ok(
      lastError.includes("InvalidCredentials \u00d7 1"),
      `last_error must contain "InvalidCredentials × 1"; got: ${lastError}`,
    );
    // Must NOT contain a stale "DeviceNotRegistered × 1" (which would indicate the
    // accumulator reset instead of incrementing on the second occurrence)
    assert.ok(
      !lastError.includes("DeviceNotRegistered \u00d7 1"),
      `last_error must NOT contain "DeviceNotRegistered × 1" — the count must be accumulated to 2; got: ${lastError}`,
    );

    // Must NOT be re-queued — dead tokens are permanently invalid
    assert.ok(
      !prqUpdates.some((c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID),
      "must NOT re-queue a row where all tokens are permanently dead",
    );

    // ── Delivery attempt must also be finalised as 'failed' ───────────────────
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14 — Mixed dead-token codes on the FINAL attempt produce two distinct entries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two tokens with different dead-token codes on the FINAL attempt
 * (attempt_count=2, max_attempts=3).
 *
 * The reduce block that builds last_error must accumulate each code separately:
 *   DEAD_TOKEN    → DeviceNotRegistered × 1
 *   DEAD_TOKEN_IC → InvalidCredentials  × 1
 *
 * A regression that resets the accumulator between tokens on the last attempt
 * would collapse both into a single entry or drop one code entirely.
 */
function expoTwoDeadTokensMixedFinalFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: DeviceNotRegistered",
            details: { error: "DeviceNotRegistered" },
          },
          {
            status:  "error",
            message: "The push notification service reported that the push token is invalid: InvalidCredentials",
            details: { error: "InvalidCredentials" },
          },
        ],
      }),
      { status: 200 },
    ) as unknown as Response;
}

describe("PushRetryQueue.processQueue() — mixed dead-token codes on the final attempt (attempt_count=2)", () => {
  it("produces 'DeviceNotRegistered × 1, InvalidCredentials × 1' in last_error — not merged or dropped", async () => {
    // attempt_count=2, max_attempts=3 → this is the final (3rd) attempt.
    // Two tokens: DEAD_TOKEN → DeviceNotRegistered, DEAD_TOKEN_IC → InvalidCredentials.
    // The reduce accumulator must produce two distinct entries with count 1 each.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [DEAD_TOKEN, DEAD_TOKEN_IC],
      payload:             BASE_PAYLOAD,
      attempt_count:       2,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoTwoDeadTokensMixedFinalFetch());
    await queue.processQueue();

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    // Must be finalised as 'failed' — final attempt, both tokens permanently dead
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(failedUpdate, "push_retry_queue must be finalised as 'failed' on the final attempt");
    assert.equal(failedUpdate.filters.id,       QUEUE_ROW_ID, "failed update must target the correct queue row");
    assert.equal(failedUpdate.patch.attempt_count, 3,          "attempt_count must be 3 (the final attempt)");

    // last_error must contain one entry per error code — each with count 1
    const lastError = failedUpdate.patch.last_error as string;
    assert.ok(
      lastError.includes("DeviceNotRegistered \u00d7 1"),
      `last_error must contain "DeviceNotRegistered × 1"; got: ${lastError}`,
    );
    assert.ok(
      lastError.includes("InvalidCredentials \u00d7 1"),
      `last_error must contain "InvalidCredentials × 1"; got: ${lastError}`,
    );

    // Must NOT be re-queued on the final attempt
    assert.ok(
      !prqUpdates.some((c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID),
      "must NOT re-queue after the final attempt",
    );

    // Delivery attempt must also be finalised as 'failed' with the same last_error
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated on final failure");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
    assert.equal(
      ndaUpdate.patch.error_message,
      lastError,
      "delivery_attempt error_message must mirror push_retry_queue last_error",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15 — Transient 5xx during retry must not touch rent_buddy_profiles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When Expo returns a transient 5xx (retryable: true) during a retry attempt,
 * the row should be re-queued — identical to the initial-send path.  No token
 * is permanently dead, so rent_buddy_profiles must NOT be updated.
 *
 * This mirrors the transient-failure guard already confirmed for the
 * NotificationRouter initial-send path (notificationRouterCredentials.test.ts)
 * and verifies the retry branch obeys the same rule.
 */
describe("PushRetryQueue.processQueue() — transient 5xx must not touch rent_buddy_profiles", () => {
  it("does not null rent_buddy_profiles.expo_push_token on a transient 5xx during retry", async () => {
    // attempt_count=1 means this is the second attempt — attempts remain, so the
    // row will be re-queued rather than finalised as failed.
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

    _setTestFetch(expo503Fetch());   // Expo 5xx → retryable: true
    await queue.processQueue();

    // rent_buddy_profiles must NOT be touched — the token is not permanently dead
    const rentUpdate = client.updateCalls.find(
      (c) => c.table === "rent_buddy_profiles" && c.patch.expo_push_token === null,
    );
    assert.ok(
      !rentUpdate,
      "transient 5xx during retry must NOT null rent_buddy_profiles.expo_push_token",
    );

    // Confirm the row was re-queued (not silently dropped or finalised)
    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");
    const requeuedUpdate = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(requeuedUpdate, "row must be re-queued on transient 5xx when attempts remain");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15 — Recovered row (next_retry_at = just past due) is claimed in the same
//       processQueue() call; a not-yet-due row is excluded
// ─────────────────────────────────────────────────────────────────────────────

/**
 * recoverStaleProcessing() resets a stale 'processing' row back to 'queued'
 * with next_retry_at = now.  The subsequent claim step inside the same
 * processQueue() call uses .lte("next_retry_at", now).  This test confirms:
 *
 *   A) A row whose next_retry_at is 1 ms in the past IS claimed and processed.
 *   B) A control row whose next_retry_at is 60 s in the future is NOT claimed.
 *
 * The fake client's lte() filter is now enforced during UPDATE+select matching
 * (ISO string ordering is identical to timestamp ordering), so the test
 * genuinely validates the filter — not just that any queued row runs.
 *
 * Both rows start as status='queued', simulating what recoverStaleProcessing()
 * would produce after resetting a stale 'processing' row.
 */

const FUTURE_ROW_ID = "cc000000-ffff-ffff-ffff-000000000099";

describe("PushRetryQueue.processQueue() — recovered row (next_retry_at just past due) is claimed; not-yet-due row is skipped", () => {
  it("picks up a row 1 ms past due and leaves a row 60 s in the future untouched", async () => {
    // Row A — simulates what recoverStaleProcessing() produces: next_retry_at = just now.
    const pastDueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1).toISOString(), // 1 ms in the past
    };

    // Row B — control: next_retry_at is well in the future; must NOT be claimed.
    const futureRow = {
      id:                  FUTURE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [LIVE_TOKEN_B],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: null,
      status:              "queued",
      next_retry_at:       new Date(Date.now() + 60_000).toISOString(), // 60 s in the future
    };

    const client = makeFakeClient([pastDueRow, futureRow]);
    const queue  = new PushRetryQueue(client as never);

    _setTestFetch(expoOkFetch()); // Expo returns success for any token
    await queue.processQueue();

    // ── Row A must be finalised as 'sent' ────────────────────────────────────
    const finaliseCall = client.updateCalls.find(
      (c) =>
        c.table === "push_retry_queue" &&
        c.patch.status === "sent" &&
        c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(
      finaliseCall,
      "past-due row must be finalised as 'sent' — lte filter must include a next_retry_at 1 ms in the past",
    );

    // ── Row B must never be touched (not claimed, not finalised) ─────────────
    const futureRowTouched = client.updateCalls.some(
      (c) => c.table === "push_retry_queue" && c.filters.id === FUTURE_ROW_ID,
    );
    assert.ok(
      !futureRowTouched,
      "not-yet-due row (next_retry_at 60 s in the future) must NOT be claimed or modified",
    );

    // ── Delivery attempt for Row A must also be updated to 'sent' ────────────
    const ndaUpdate = client.updateCalls.find(
      (c) =>
        c.table === "notification_delivery_attempts" &&
        c.patch.status === "sent" &&
        c.filters.id === ATTEMPT_ID,
    );
    assert.ok(
      ndaUpdate,
      "notification_delivery_attempts must be updated to 'sent' after the recovered row succeeds",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14 — clearDeadTokens throws during partial success
// ─────────────────────────────────────────────────────────────────────────────

describe("PushRetryQueue.processQueue() — clearDeadTokens throws during partial success", () => {
  it("still finalises as 'sent' — not re-queued — when clearDeadTokens throws and result.sent > 0", async () => {
    // Scenario: Expo delivers to PUSH_TOKEN (ok) but reports DEAD_TOKEN as
    // DeviceNotRegistered.  clearDeadTokens is mocked to throw a transient DB
    // error.  Because result.sent > 0 the queue row must STILL finalise as
    // 'sent' — it must NOT be re-queued or marked 'failed' just because the
    // dead-token cleanup blew up.
    //
    // This guards the bug where clearDeadTokens was awaited inside the outer
    // try/catch in processItem: a throw there previously caused the catch block
    // to run, re-queuing an already-delivered notification.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    // Expo: first ticket ok (PUSH_TOKEN), second ticket DeviceNotRegistered (DEAD_TOKEN)
    _setTestFetch(expoPartialSuccessFetch());

    // clearDeadTokens mock that throws a transient DB error
    _setTestClearDeadTokens(async (_db, _tokens) => {
      throw new Error("transient DB error during dead-token cleanup");
    });

    await queue.processQueue();

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    // Must be finalised as 'sent' — the successful delivery took place; the
    // dead-token cleanup failure must not override the outcome.
    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(
      sentUpdate,
      "push_retry_queue must be finalised as 'sent' even when clearDeadTokens throws",
    );
    assert.equal(sentUpdate.filters.id,      QUEUE_ROW_ID, "sent update must target the correct queue row");
    assert.equal(sentUpdate.patch.attempt_count, 2,        "attempt_count must be 2 (the retry attempt)");

    // Must NOT be re-queued — a cleanup error is not a delivery failure
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(
      !requeued,
      "must NOT re-queue the row when clearDeadTokens throws but result.sent > 0",
    );

    // Must NOT be marked failed
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(
      !failedUpdate,
      "must NOT mark the row 'failed' when clearDeadTokens throws but partial delivery succeeded",
    );

    // Delivery attempt must also be marked 'sent'
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "sent",    "delivery_attempt status must be 'sent'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });

  it("still finalises as 'sent' on the FINAL attempt — not re-queued — when clearDeadTokens throws and result.sent > 0", async () => {
    // Scenario: attempt_count=2, max_attempts=3 — this is the FINAL attempt (attempt 3).
    // Expo delivers to PUSH_TOKEN (ok) but reports DEAD_TOKEN as DeviceNotRegistered.
    // clearDeadTokens is mocked to throw.  Because result.sent > 0 the queue row must
    // STILL finalise as 'sent' — it must NOT be re-queued or marked 'failed'.
    //
    // The exhausted-attempts branch runs slightly different logic from the mid-sequence
    // path (newAttemptCount >= maxAttempts), so isolation must be confirmed here too.
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN, DEAD_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       2,        // final attempt: newAttemptCount will be 3 === maxAttempts
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    // Expo: first ticket ok (PUSH_TOKEN), second ticket DeviceNotRegistered (DEAD_TOKEN)
    _setTestFetch(expoPartialSuccessFetch());

    // clearDeadTokens mock that throws a transient DB error
    _setTestClearDeadTokens(async (_db, _tokens) => {
      throw new Error("transient DB error during dead-token cleanup — final attempt");
    });

    await queue.processQueue();

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    // Must be finalised as 'sent' — delivery succeeded; cleanup failure must not override it
    const sentUpdate = prqUpdates.find((c) => c.patch.status === "sent");
    assert.ok(
      sentUpdate,
      "push_retry_queue must be finalised as 'sent' on the final attempt even when clearDeadTokens throws",
    );
    assert.equal(sentUpdate.filters.id,          QUEUE_ROW_ID, "sent update must target the correct queue row");
    assert.equal(sentUpdate.patch.attempt_count, 3,            "attempt_count must be 3 (the final attempt)");

    // Must NOT be re-queued — no attempts remain and delivery succeeded
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(
      !requeued,
      "must NOT re-queue the row on the final attempt when clearDeadTokens throws but result.sent > 0",
    );

    // Must NOT be marked failed
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(
      !failedUpdate,
      "must NOT mark the row 'failed' when clearDeadTokens throws but partial delivery succeeded on the final attempt",
    );

    // Delivery attempt must also be marked 'sent'
    const ndaUpdates2 = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates2.length > 0, "notification_delivery_attempts must be updated");
    const ndaUpdate2 = ndaUpdates2[ndaUpdates2.length - 1];
    assert.equal(ndaUpdate2.patch.status, "sent",    "delivery_attempt status must be 'sent'");
    assert.equal(ndaUpdate2.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
  });

  it("mid-sequence all-dead-token attempt finalises as 'failed' — not re-queued — when clearDeadTokens throws", async () => {
    // attempt_count=1, max_attempts=3 → mid-sequence (attempt 2 would be possible for retryable errors).
    // BUT all tokens are DeviceNotRegistered, which is non-retryable regardless of remaining attempts.
    // clearDeadTokens is configured to throw to confirm the isolated try/catch swallows the error
    // and does NOT cause the item to fall into the outer catch block's re-queue path.
    //
    // Expected outcome:
    //   - push_retry_queue row → 'failed' (non-retryable dead tokens are never re-queued)
    //   - Must NOT be re-queued (status='queued' with filters.id=QUEUE_ROW_ID absent)
    //   - notification_delivery_attempts → 'failed' with error_message = "DeviceNotRegistered × 1"
    const queueRow = {
      id:                  QUEUE_ROW_ID,
      user_id:             USER_ID,
      notification_id:     NOTIF_ID,
      tokens:              [PUSH_TOKEN],
      payload:             BASE_PAYLOAD,
      attempt_count:       1,        // mid-sequence: attempt 2 is still possible for retryable errors
      max_attempts:        3,
      delivery_attempt_id: ATTEMPT_ID,
      status:              "queued",
      next_retry_at:       new Date(Date.now() - 1_000).toISOString(),
    };

    const client = makeFakeClient([queueRow]);
    const queue  = new PushRetryQueue(client as never);

    // All tokens are DeviceNotRegistered → non-retryable, result.sent === 0
    _setTestFetch(expoDeadTokenFetch("DeviceNotRegistered"));

    // clearDeadTokens throws — must be swallowed by the inner isolated try/catch,
    // NOT surface into the outer catch that triggers re-queue logic
    _setTestClearDeadTokens(async (_db, _tokens) => {
      throw new Error("transient DB error during dead-token cleanup — mid-sequence all-dead");
    });

    await queue.processQueue();

    const prqUpdates = client.updateCalls.filter((c) => c.table === "push_retry_queue");

    // Must be finalised as 'failed' — DeviceNotRegistered is non-retryable; cleanup error must not change this
    const failedUpdate = prqUpdates.find((c) => c.patch.status === "failed");
    assert.ok(
      failedUpdate,
      "push_retry_queue must be finalised as 'failed' when all tokens are DeviceNotRegistered, even when clearDeadTokens throws",
    );
    assert.equal(failedUpdate.filters.id, QUEUE_ROW_ID, "failed update must target the correct queue row");
    assert.equal(failedUpdate.patch.attempt_count, 2,   "attempt_count must be 2 (the mid-sequence attempt number)");
    assert.equal(
      failedUpdate.patch.last_error,
      "DeviceNotRegistered \u00d7 1",
      "last_error must name the dead-token error code and count",
    );

    // Must NOT be re-queued — the cleanup throw must stay inside the inner catch
    const requeued = prqUpdates.find(
      (c) => c.patch.status === "queued" && c.filters.id === QUEUE_ROW_ID,
    );
    assert.ok(
      !requeued,
      "must NOT re-queue a mid-sequence row whose only token is DeviceNotRegistered — even when clearDeadTokens throws",
    );

    // Delivery attempt must also be finalised as 'failed' with the dead-token error
    const ndaUpdates = client.updateCalls.filter((c) => c.table === "notification_delivery_attempts");
    assert.ok(ndaUpdates.length > 0, "notification_delivery_attempts must be updated on non-retryable dead-token failure");
    const ndaUpdate = ndaUpdates[ndaUpdates.length - 1];
    assert.equal(ndaUpdate.patch.status, "failed",   "delivery_attempt status must be 'failed'");
    assert.equal(ndaUpdate.filters.id,   ATTEMPT_ID, "delivery_attempt update must target the correct id");
    assert.equal(
      ndaUpdate.patch.error_message,
      "DeviceNotRegistered \u00d7 1",
      "delivery_attempt error_message must mirror last_error ('DeviceNotRegistered × 1')",
    );
  });
});

