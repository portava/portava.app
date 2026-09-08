/**
 * suggestionSeenCache — the L2 legs must actually be ISSUED, and a failure must
 * be visible.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * `persistSeenIds` and `clearSeenFromDb` awaited their PostgREST call but never
 * bound `{ error }`, inside an empty `catch`. supabase-js RESOLVES on a database
 * error, so the catch was dead code for the failure that matters: the L2 leg
 * could fail on every request while the process reported nothing. Both sites
 * were on scripts/SILENT_SUPABASE_WRITES_BASELINE.json.
 *
 * The cost is a freshness bug, not a safety one — the module header records the
 * measurement against the only consumer. What makes it worth catching is that a
 * cache which silently never writes is shaped exactly like one that works.
 *
 * ── WHAT THIS FILE MEASURES ──────────────────────────────────────────────────
 * Not "does the code look right": it counts the calls the module makes against a
 * recording double, and asserts the counts are non-zero. A fire-and-forget write
 * that is never issued (PostgrestBuilder is a thenable — a chain nothing
 * continues sends nothing) shows up here as a count of zero, which is the one
 * thing reading the source cannot tell you. The double therefore counts inside
 * `then()`, never inside `.upsert()` — see the note on it below.
 *
 * WHAT THIS FILE DOES NOT PROVE, said plainly: it does not assert that a failed
 * L2 write is LOGGED. Asserting on a log line would test the logger. The
 * observability half is enforced statically instead, by
 * check:silent-supabase-writes, which now reports 0 sites for this module
 * (baselined 2). What is proved here is that the calls are issued at all, that a
 * refused write leaves L1 authoritative and never reaches the caller, and that
 * an unreadable L2 degrades to "nothing seen" rather than to an exception.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoverySuggestionSeenCache.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  getSeenIds,
  markAsSeen,
  clearSeen,
  _clearAllSeen,
} from "../lib/suggestionSeenCache.js";

const USER = "90000000-0000-4000-a000-000000000001";
const A = "90000000-0000-4000-a000-00000000000a";
const B = "90000000-0000-4000-a000-00000000000b";

interface Calls {
  upserts: any[];
  deletes: number;
  selects: number;
}

/**
 * A recording double. `fail` decides what each terminal call RESOLVES with —
 * never a rejection, because supabase-js never rejects on a database error and a
 * test that passed on a thrown error would be exercising a path production does
 * not take.
 */
function recorder(opts: { row?: any; fail?: "read" | "write" | null } = {}) {
  const calls: Calls = { upserts: [], deletes: 0, selects: 0 };
  const readResult = () =>
    opts.fail === "read"
      ? { data: null, error: { code: "57P01", message: "user_suggestion_seen unreadable" }, count: null }
      : { data: opts.row ?? null, error: null, count: null };
  const writeResult = () =>
    opts.fail === "write"
      ? { data: null, error: { code: "57P01", message: "user_suggestion_seen unwritable" }, count: null }
      : { data: null, error: null, count: null };

  const client: any = {
    from() {
      let kind: "select" | "upsert" | "delete" | null = null;
      let staged: any = null;
      // The counters are incremented in `then()` / `maybeSingle()`, NEVER in
      // `.upsert()` / `.delete()`. PostgrestBuilder is a thenable: it builds its
      // headers and calls `_fetch` inside `then()`, so a chain nothing continues
      // sends NOTHING. A double that records eagerly inside `.upsert()` proves
      // the row was CONSTRUCTED and never that it was SENT. Measured: with the
      // eager version this file stayed GREEN when persistSeenIds was
      // hand-reverted to `void sc.from(...).upsert(...)` — the exact defect the
      // counts here are supposed to catch.
      const commitWrite = () => {
        if (kind === "upsert") calls.upserts.push(staged);
        if (kind === "delete") calls.deletes += 1;
      };
      const b: any = {
        select() { kind = "select"; return b; },
        upsert(payload: any) { kind = "upsert"; staged = payload; return b; },
        delete() { kind = "delete"; return b; },
        eq() { return b; },
        maybeSingle() { calls.selects += 1; return Promise.resolve(readResult()); },
        then(onF: any, onR: any) {
          if (kind === "select") calls.selects += 1;
          else commitWrite();
          return Promise.resolve(kind === "select" ? readResult() : writeResult()).then(onF, onR);
        },
      };
      return b;
    },
  };
  return { client, calls };
}

/**
 * markAsSeen / clearSeen are fire-and-forget. Draining them takes real
 * time, not just a few turns: the helpers `await import(...)` twice before they
 * touch the client, and module resolution settles on neither the microtask nor
 * the setImmediate queue. Measured: `setTimeout(0)` and ten `setImmediate`
 * rounds both observed an upsert count of ZERO — indistinguishable from a write
 * that was never issued, which is the very thing this file exists to detect. A
 * timer wide enough for the imports removes that ambiguity.
 */
async function settle(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 50));
}

beforeEach(() => { _clearAllSeen(); });
afterEach(() => { _clearAllSeen(); _setTestServiceClient(null); });

describe("suggestionSeenCache — the L2 write is really sent", () => {
  it("CONTROL: markAsSeen issues exactly one upsert carrying the ids", async () => {
    const { client, calls } = recorder();
    _setTestServiceClient(client);

    markAsSeen(USER, [A, B]);
    await settle();

    assert.equal(calls.upserts.length, 1, "vacuity guard: a never-issued write would be 0 here");
    assert.equal(calls.upserts[0].user_id, USER);
    assert.deepEqual([...calls.upserts[0].seen_ids].sort(), [A, B].sort());
  });

  it("CONTROL: clearSeen issues exactly one delete", async () => {
    const { client, calls } = recorder();
    _setTestServiceClient(client);

    clearSeen(USER);
    await settle();

    assert.equal(calls.deletes, 1, "vacuity guard: a never-issued delete would be 0 here");
  });

  it("markAsSeen with no ids issues nothing at all", async () => {
    const { client, calls } = recorder();
    _setTestServiceClient(client);

    markAsSeen(USER, []);
    await settle();

    assert.equal(calls.upserts.length, 0);
  });

  it("a REFUSED L2 write still leaves L1 correct — the response path is unaffected", async () => {
    const { client, calls } = recorder({ fail: "write" });
    _setTestServiceClient(client);

    markAsSeen(USER, [A]);
    await settle();

    assert.equal(calls.upserts.length, 1, "the write was attempted");
    // L1 is authoritative within the process: the failed persist must not have
    // rolled it back or thrown into the caller.
    assert.deepEqual([...(await getSeenIds(USER))], [A]);
  });
});

describe("suggestionSeenCache — an unreadable L2 is not 'nothing seen yet'", () => {
  it("CONTROL: a readable row rehydrates the seen set after an L1 miss", async () => {
    const { client } = recorder({
      row: { seen_ids: [A, B], expires_at: new Date(Date.now() + 60_000).toISOString() },
    });
    _setTestServiceClient(client);

    const ids = await getSeenIds(USER);
    assert.deepEqual([...ids].sort(), [A, B].sort(), "vacuity guard: L2 really was consulted");
  });

  it("an unreadable table yields an empty set and does not throw into the caller", async () => {
    const { client, calls } = recorder({ fail: "read" });
    _setTestServiceClient(client);

    const ids = await getSeenIds(USER);
    assert.equal(calls.selects, 1, "the read was attempted");
    assert.equal(ids.size, 0);
    // The direction is deliberate and recorded in the module: an empty set only
    // stops the strip DEPRIORITISING candidates it has already shown. It cannot
    // admit anyone the block / already-following filters excluded, so repeats
    // are the whole cost.
  });

  it("an expired row is treated as no seen state and the stale row is deleted", async () => {
    const { client, calls } = recorder({
      row: { seen_ids: [A], expires_at: new Date(Date.now() - 60_000).toISOString() },
    });
    _setTestServiceClient(client);

    const ids = await getSeenIds(USER);
    await settle();
    assert.equal(ids.size, 0);
    assert.equal(calls.deletes, 1, "the expired row is actually cleaned up, not just ignored");
  });
});
