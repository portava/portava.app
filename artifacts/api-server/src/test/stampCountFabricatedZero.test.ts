/**
 * stampCountFabricatedZero — a stamp count that could not be READ must not be
 * served as the number 0.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `stampEntity` / `unstampEntity` / `getStampState` / `batchGetStampState` each
 * ended with a head-count read whose `.error` was never bound:
 *
 *     const { count } = await db.from("content_stamps")
 *       .select("id", { count: "exact", head: true })…
 *     return { stampCount: count ?? 0, isStamped: true };
 *
 * supabase-js RESOLVES on a database error, and a `head: true` count read
 * yields `count: null` when it does — so `count ?? 0` published a confident
 * zero. On `stampEntity` that zero is returned in the SAME object as
 * `isStamped: true`, for a stamp that had just succeeded: "nobody stamped this,
 * and you are one of them". On `batchGetStampState` one failed read rewrote the
 * count of EVERY entity on a feed page to zero at once. In all four cases the
 * error was not merely unhandled, it was never observed and never logged.
 *
 * The count IS the claim on these responses — it is the number the UI shows
 * next to the stamp — so a fabricated zero is not degradation, it is a false
 * measurement. `countUnavailable` is the only thing that separates it from a
 * real zero; the number stays 0 because there is no honest number to invent.
 *
 * ── HOW THIS IS MEASURED, NOT ASSUMED ───────────────────────────────────────
 * `makeFailClosedClient` injects the RESOLVED error shape and never throws; a
 * fake that threw would exercise a path production does not take (and would be
 * caught by the route's `try/catch`, which is precisely why this survived).
 *
 * WHAT ELSE COULD MAKE THESE PASS? A seed with no stamps would make "count 0"
 * true for the wrong reason, so every failing case is paired with a HEALTHY
 * control on the SAME seed asserting a NON-ZERO count — the fixture is provably
 * able to produce a real number. And `failWritesOn` is left unset, so the write
 * genuinely succeeds and the contradiction being pinned is real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import {
  stampEntity,
  unstampEntity,
  getStampState,
  batchGetStampState,
} from "../services/stamps/ContentStampService.js";

const USER = "00000000-0000-0000-0000-0000000000a1";
const OTHER = "00000000-0000-0000-0000-0000000000a2";
const POST_A = "10000000-0000-0000-0000-0000000000b1";
const POST_B = "10000000-0000-0000-0000-0000000000b2";

const STAMPS = [
  { id: "cs1", user_id: USER, entity_type: "post", entity_id: POST_A, created_at: "2026-01-01T00:00:00Z" },
  { id: "cs2", user_id: OTHER, entity_type: "post", entity_id: POST_A, created_at: "2026-01-02T00:00:00Z" },
  { id: "cs3", user_id: OTHER, entity_type: "post", entity_id: POST_B, created_at: "2026-01-03T00:00:00Z" },
];

/** `failCount` fails ONLY the head-count read; the row reads stay healthy. */
function client(failCount: boolean) {
  return makeFailClosedClient({
    rows: { content_stamps: STAMPS },
    // A head-count read is the only read here that asks for no columns back;
    // it is identified by the filters it carries plus the absence of a
    // user_id filter, which is what separates it from the "did I stamp this"
    // read on the very same table.
    failOn: (c) =>
      failCount && c.table === "content_stamps" && c.eq("user_id") === undefined
        ? { message: "connection terminated unexpectedly", code: "57P01" }
        : null,
  });
}

test("1. stampEntity: a successful stamp never reports 'nobody stamped this'", async () => {
  // Control — the same seed, healthy: the count is real and non-zero.
  const ok = await stampEntity(client(false), USER, "post", POST_A);
  assert.equal(ok.isStamped, true);
  assert.equal(ok.stampCount, 2, "the fixture WOULD have produced a real, non-zero count");
  assert.equal(ok.countUnavailable, undefined, "a healthy count carries no marker");

  // The defect: the write succeeds, the count read fails.
  const degraded = await stampEntity(client(true), USER, "post", POST_A);
  assert.equal(degraded.isStamped, true, "the stamp itself still succeeded");
  assert.equal(degraded.stampCount, 0, "there is no honest number, so the placeholder stands…");
  assert.equal(
    degraded.countUnavailable, true,
    "…but it must be labelled a placeholder: 'nobody stamped this, and you are one of them' " +
      "is a self-contradiction, and nothing on the response used to say so",
  );
});

test("2. unstampEntity: the same, on the way back down", async () => {
  const ok = await unstampEntity(client(false), USER, "post", POST_A);
  assert.equal(ok.stampCount, 2);
  assert.equal(ok.countUnavailable, undefined);

  const degraded = await unstampEntity(client(true), USER, "post", POST_A);
  assert.equal(degraded.isStamped, false);
  assert.equal(degraded.countUnavailable, true);
});

test("3. getStampState: an unreadable count is not a real zero", async () => {
  const ok = await getStampState(client(false), USER, "post", POST_A);
  assert.equal(ok.stampCount, 2, "the fixture produces a real count");
  assert.equal(ok.isStamped, true, "…and a real viewer state");
  assert.equal(ok.countUnavailable, undefined);

  const degraded = await getStampState(client(true), USER, "post", POST_A);
  assert.equal(degraded.countUnavailable, true);
  // The own-stamp read was NOT failed, so this half is still truthful — which
  // proves the injected failure is scoped to the count and not to the table.
  assert.equal(degraded.isStamped, true, "only the count read was made to fail");
});

test("4. a genuinely unstamped entity is still a truthful zero", async () => {
  const empty = await getStampState(
    makeFailClosedClient({ rows: { content_stamps: [] } }), USER, "post", POST_A,
  );
  assert.equal(empty.stampCount, 0);
  assert.equal(empty.isStamped, false);
  assert.equal(
    empty.countUnavailable, undefined,
    "a real zero must stay indistinguishable from nothing — the marker is the only difference",
  );
});

test("5. batchGetStampState: one failed read must not rewrite a whole page to zero", async () => {
  const ok = await batchGetStampState(client(false), USER, "post", [POST_A, POST_B]);
  assert.equal(ok[POST_A].stampCount, 2, "the fixture produces real per-entity counts");
  assert.equal(ok[POST_B].stampCount, 1);
  assert.equal(ok[POST_A].countUnavailable, undefined);

  const degraded = await batchGetStampState(client(true), USER, "post", [POST_A, POST_B]);
  assert.equal(degraded[POST_A].stampCount, 0);
  assert.equal(degraded[POST_B].stampCount, 0);
  assert.equal(degraded[POST_A].countUnavailable, true, "every entity on the page is marked…");
  assert.equal(degraded[POST_B].countUnavailable, true, "…not just the first one");
  // The per-user read was untouched, so viewer state is still real.
  assert.equal(degraded[POST_A].isStamped, true);
  assert.equal(degraded[POST_B].isStamped, false);
});
