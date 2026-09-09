/**
 * Trip Kernel — §4.4 temporal validation for a PLAN ITEM (census-trips TR54).
 *
 * WHAT WAS MISSING, AND WHAT WAS NOT
 * ==================================
 * The kernel already refuses an inverted range on the TRIP: CREATE_TRIP and
 * UPDATE_TRIP both compare start_date against end_date and return
 * TRIP_TEMPORAL_RANGE_INVERTED, and the UPDATE branch compares the MERGED value
 * rather than the patch's. A plan item's `starts_at` / `ends_at` pair was never
 * checked by anything — not by the kernel, not by a constraint — so ADD_PLAN and
 * the UPDATE family would persist an item that ends before it starts.
 *
 * The fix is deliberately in two places, and this file pins the seam:
 *   • migration 2750 adds a CHECK — the guarantee, for any writer that exists;
 *   • executeTripCommand returns the typed reason — the good error message.
 *
 * The reason code is the one that ALREADY EXISTS. Inventing a second word for
 * one fact is how the display-name rule in this repo reached five spellings, one
 * of which had drifted to a different answer.
 *
 * WHAT THIS FILE DOES NOT CLAIM. The TS check sees only the command, so it can
 * only judge a patch that names BOTH endpoints; a patch naming one is
 * undecidable without the stored row and is deliberately NOT refused here.
 * Guessing would reject legal commands. That case is the constraint's, and the
 * last test pins the non-refusal so nobody "fixes" it into a guess.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tripKernelTemporalOrdering.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { executeTripCommand, type TripCommand } from "../lib/tripKernel.js";

/** A client whose rpc must NEVER be reached when the command is refused early. */
function rpcSpy(result: any = { ok: true, version: 1, event_id: "e1", contract_version: 2 }) {
  const calls: any[] = [];
  return {
    calls,
    rpc: async (_fn: string, args: any) => {
      calls.push(args);
      return { data: result, error: null };
    },
  };
}

const base = (over: Partial<TripCommand>): TripCommand => ({
  commandId: "11111111-1111-4111-8111-111111111111",
  tripId: "22222222-2222-4222-8222-222222222222",
  actorUserId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "k1",
  type: "ADD_PLAN",
  payload: {},
  ...over,
} as TripCommand);

describe("§4.4 — an inverted plan interval is refused before the kernel is called", () => {
  it("ADD_PLAN with ends_at before starts_at is refused, and no RPC is issued", async () => {
    const sc = rpcSpy();
    const r = await executeTripCommand(sc as never, base({
      type: "ADD_PLAN",
      payload: { title: "x", starts_at: "2026-01-02T10:00:00Z", ends_at: "2026-01-02T09:00:00Z" },
    }));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "TRIP_TEMPORAL_RANGE_INVERTED");
    assert.equal(sc.calls.length, 0, "a refused command must not reach the database");
  });

  it("the reason is the EXISTING code, not a new one", async () => {
    // The kernel function already returns TRIP_TEMPORAL_RANGE_INVERTED for the
    // trip-level range. One fact, one word.
    const src = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");
    assert.match(src, /"TRIP_TEMPORAL_RANGE_INVERTED"/);
    assert.equal(/TRIP_TEMPORAL_INVALID|TRIP_INTERVAL_INVERTED|TRIP_PLAN_TEMPORAL/.test(src), false,
      "a second spelling of the same rejection has appeared");
  });

  it("MOVE_PLAN whose patch names BOTH endpoints inverted is refused", async () => {
    const sc = rpcSpy();
    const r = await executeTripCommand(sc as never, base({
      type: "MOVE_PLAN",
      payload: { item_id: "44444444-4444-4444-8444-444444444444",
                 patch: { starts_at: "2026-03-01T12:00:00Z", ends_at: "2026-03-01T11:00:00Z" } },
    }));
    assert.equal((r as any).reason, "TRIP_TEMPORAL_RANGE_INVERTED");
    assert.equal(sc.calls.length, 0);
  });
});

describe("§4.4 — what must still reach the kernel", () => {
  it("an ORDERED interval is passed through", async () => {
    const sc = rpcSpy();
    const r = await executeTripCommand(sc as never, base({
      payload: { title: "x", starts_at: "2026-01-02T09:00:00Z", ends_at: "2026-01-02T10:00:00Z" },
    }));
    assert.equal(r.ok, true);
    assert.equal(sc.calls.length, 1);
  });

  it("a ZERO-LENGTH interval is passed through — a checkpoint is a real thing", async () => {
    const sc = rpcSpy();
    const r = await executeTripCommand(sc as never, base({
      payload: { title: "x", starts_at: "2026-01-02T09:00:00Z", ends_at: "2026-01-02T09:00:00Z" },
    }));
    assert.equal(r.ok, true, "ends_at = starts_at must be allowed");
  });

  it("one endpoint absent is passed through", async () => {
    const sc = rpcSpy();
    await executeTripCommand(sc as never, base({ payload: { title: "x", starts_at: "2026-01-02T09:00:00Z" } }));
    assert.equal(sc.calls.length, 1);
  });

  it("an UNPARSEABLE timestamp is passed through — malformed is the kernel's word, not this one's", async () => {
    const sc = rpcSpy();
    await executeTripCommand(sc as never, base({
      payload: { title: "x", starts_at: "not-a-date", ends_at: "2026-01-02T09:00:00Z" },
    }));
    assert.equal(sc.calls.length, 1, "the function returns TRIP_COMMAND_MALFORMED with the real SQLSTATE");
  });

  it("a PATCH naming only ONE endpoint is NOT refused here — that case is the constraint's", async () => {
    // Undecidable without the stored row. Refusing it would reject legal
    // commands; migration 2750's CHECK catches a genuine inversion at the write.
    // Pinned so nobody turns the honest gap into a guess.
    const sc = rpcSpy();
    await executeTripCommand(sc as never, base({
      type: "MOVE_PLAN",
      payload: { item_id: "44444444-4444-4444-8444-444444444444",
                 patch: { ends_at: "2020-01-01T00:00:00Z" } },
    }));
    assert.equal(sc.calls.length, 1);
  });
});
