/**
 * The fire-and-forget tails of `_awardStampCore` must not read a database error
 * as data.
 *
 * ── HOW THESE THREE WERE FOUND ───────────────────────────────────────────────
 * Not by hand. `check-unchecked-supabase-reads` gained a fifth tier —
 * `write-precondition`: an unchecked read of table T inside a function that also
 * INSERTs/UPSERTs T, i.e. a read whose answer decides whether an irreversible
 * write happens. That tier was added to catch the three write-path eligibility
 * reads in `_awardStampCore` (covered by stampAwardWritePathFailClosed.test.ts)
 * and immediately surfaced three MORE in the same function that a manual pass
 * had missed. This file pins those three.
 *
 * "Fire-and-forget" bounds the blast radius to progress and milestones; it does
 * not make the classification correct. Each of these turns an unreadable table
 * into a confident false statement:
 *
 *   stamp_progress.maybeSingle  → error reads as "no progress row", and the
 *                                 UPSERT two lines later writes progress_count
 *                                 = 1 over a row that said 47. This is not a
 *                                 lost increment; it is a DESTROYED count.
 *   user_stamps count           → error resolves with count = null, and
 *                                 `count ?? 0` reads as "this user has zero
 *                                 stamps". Direction is safe (no milestone
 *                                 fires) but silent — and permanent: the next
 *                                 award sees the higher total, finds the level
 *                                 below already recorded, and breaks.
 *   stamp_milestones.maybeSingle→ error reads as "this milestone is new", so the
 *                                 loop INSERTs a milestone row and pushes a
 *                                 congratulation the user may already have had.
 *
 * ── WHY EACH CASE HAS A CONTROL ──────────────────────────────────────────────
 * A fix that bailed out unconditionally would pass all three failure cases and
 * silently disable progress and milestones for ever. The controls below prove
 * the healthy path still increments and still records.
 *
 * ── WHY THE TESTS FLUSH ──────────────────────────────────────────────────────
 * Both tails run in `Promise.resolve().then(async () => …)` that `awardStamp`
 * does not await, so asserting immediately after the call measures nothing.
 * `flush()` drains the microtask/immediate queue first; every case also asserts
 * a POSITIVE fact in its control, so a flush that stopped working would show up
 * as a failing control rather than as three vacuous passes.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/stampPostAwardReadsFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { awardStamp } from "../services/passport/StampAwardEngine.js";

const USER = "44444444-0000-4000-a000-000000000001";
const DEF_ID = "55555555-0000-4000-a000-000000000002";
const SOURCE = "66666666-0000-4000-a000-000000000003";

const REPEATABLE = {
  id: DEF_ID,
  code: "test_repeatable",
  slug: "test_repeatable",
  name: "Test Repeatable",
  is_active: true,
  is_repeatable: true,
  max_awards_per_user: null,
  category: "trips",
  requires_source: false,
};

/** Enough live stamps that the 100 milestone is crossed. */
const hundredStamps = () =>
  Array.from({ length: 100 }, (_, i) => ({
    id: `s-${i}`,
    user_id: USER,
    stamp_definition_id: `other-${i}`,
    is_revoked: false,
  }));

function baseRows(extra: Record<string, any[]> = {}) {
  return {
    feature_flags: [
      { flag: "stamp_system_v2_enabled", enabled: true },
      { flag: "passport_stamps_enabled", enabled: true },
      { flag: "trust_engine_enabled", enabled: false },
      { flag: "push_notifications_enabled", enabled: false },
    ],
    stamp_definitions: [REPEATABLE],
    stamp_award_events: [],
    user_stamps: [],
    stamp_progress: [],
    stamp_milestones: [],
    profiles: [{ id: USER, expo_push_token: null }],
    trips: [{ id: SOURCE, status: "completed" }],
    ...extra,
  };
}

const input = () => ({
  userId: USER,
  definitionSlug: "test_repeatable",
  sourceType: "trips" as const,
  sourceId: SOURCE,
  awardSource: "verified" as const,
});

/** Drain the un-awaited tails. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

/**
 * The legacy read-modify-write progress path is only reached when the atomic
 * RPC reports PGRST202 (migration 2071 absent). The shared fake's `rpc` always
 * succeeds, so each progress case overrides it locally rather than editing the
 * shared helper.
 */
function withMissingProgressRpc(sc: any) {
  sc.rpc = async (fn: string) =>
    fn === "increment_stamp_progress"
      ? { data: null, error: { message: "function not found", code: "PGRST202" } }
      : { data: null, error: null };
  return sc;
}

describe("stamp_progress fallback — an unreadable count is not zero", () => {
  it("CONTROL: a readable count of 47 increments to 48", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = withMissingProgressRpc(
      makeFailClosedClient({
        rows: baseRows({
          stamp_progress: [{ user_id: USER, stamp_definition_id: DEF_ID, progress_count: 47 }],
        }),
        inserted,
      }),
    );
    const r = await awardStamp(sc, input() as any, noopLog as any);
    assert.equal(r.awarded, true, `expected an award, got ${r.reason}`);
    await flush();

    const writes = inserted["stamp_progress"] ?? [];
    assert.equal(writes.length, 1, "the legacy fallback must still write progress");
    assert.equal(writes[0].progress_count, 48);
  });

  it("an unreadable stamp_progress does NOT overwrite the stored count with 1", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = withMissingProgressRpc(
      makeFailClosedClient({
        rows: baseRows({
          stamp_progress: [{ user_id: USER, stamp_definition_id: DEF_ID, progress_count: 47 }],
        }),
        // Only the READ fails; the upsert is a write and still lands if reached.
        // That is what makes this case non-vacuous: without the fix the upsert
        // really does execute and really does write 1.
        failOn: (ctx: FakeReadContext) =>
          ctx.table === "stamp_progress" ? { message: "stamp_progress unavailable", code: "57P01" } : null,
        inserted,
      }),
    );
    const r = await awardStamp(sc, input() as any, noopLog as any);
    assert.equal(r.awarded, true, "the award itself is unaffected — this tail is non-fatal by design");
    await flush();

    const writes = inserted["stamp_progress"] ?? [];
    assert.equal(writes.length, 0, "a progress count that could not be read must not be rewritten as 1");
  });
});

describe("stamp milestones — an unreadable table is not 'nothing recorded'", () => {
  it("CONTROL: crossing 100 with a readable table records the milestone", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: baseRows({ user_stamps: hundredStamps() }),
      inserted,
    });
    const r = await awardStamp(sc, input() as any, noopLog as any);
    assert.equal(r.awarded, true, `expected an award, got ${r.reason}`);
    await flush();

    const ms = inserted["stamp_milestones"] ?? [];
    assert.equal(ms.length, 1, "the 100 milestone must be recorded on the happy path");
    assert.equal(ms[0].milestone_level, 100);
  });

  it("an unreadable stamp_milestones does NOT re-record a milestone", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: baseRows({
        user_stamps: hundredStamps(),
        // The milestone IS already recorded. An unchecked error makes it
        // invisible, and the code then congratulates the user a second time.
        stamp_milestones: [{ user_id: USER, milestone_level: 100 }],
      }),
      failOn: (ctx: FakeReadContext) =>
        ctx.table === "stamp_milestones" ? { message: "stamp_milestones unavailable", code: "57P01" } : null,
      inserted,
    });
    const r = await awardStamp(sc, input() as any, noopLog as any);
    assert.equal(r.awarded, true);
    await flush();

    assert.equal(
      (inserted["stamp_milestones"] ?? []).length,
      0,
      "an unreadable milestone table must not be read as 'this milestone is new'",
    );
  });

  it("an unreadable stamp COUNT does NOT silently proceed as zero stamps", async () => {
    const inserted: Record<string, any[]> = {};
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    const sc = makeFailClosedClient({
      rows: baseRows({ user_stamps: hundredStamps() }),
      // Scope the failure to the milestone COUNT read: it filters user_id and
      // is_revoked but NOT stamp_definition_id, unlike the eligibility reads
      // earlier in the award. Failing every user_stamps read would abort the
      // award before this tail ran, and the case would prove nothing.
      failOn: (ctx: FakeReadContext) =>
        ctx.table === "user_stamps" &&
        ctx.filters.some((f) => f.col === "is_revoked") &&
        !ctx.filters.some((f) => f.col === "stamp_definition_id")
          ? { message: "user_stamps unavailable", code: "57P01" }
          : null,
      inserted,
    });
    let r;
    try {
      r = await awardStamp(sc, input() as any, noopLog as any);
      await flush();
    } finally {
      console.error = realError;
    }
    assert.equal(r.awarded, true);

    assert.equal((inserted["stamp_milestones"] ?? []).length, 0);

    // The row-level outcome alone would be VACUOUS here: `count ?? 0` also
    // records nothing, so asserting "no milestone written" is true with the fix
    // REMOVED. The fix's whole content is that the miss stops being invisible,
    // so that is what this case must measure.
    assert.ok(
      logged.some((l) => l.includes("stamp.milestone.count_failed")),
      `an unreadable stamp count must be reported, not silently treated as zero. Saw: ${JSON.stringify(logged)}`,
    );
    // …and it must not be reported as some other, wrong thing.
    assert.ok(!logged.some((l) => l.includes("stamp.milestone.read_failed")));
  });
});
