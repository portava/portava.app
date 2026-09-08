/**
 * `_awardStampCore` — the WRITE path's own eligibility reads must fail closed.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM checkEligibility ─────────────────────────
 * `checkEligibility` is the DRY-RUN endpoint and its three reads were already
 * made fail-closed. `_awardStampCore` — the path that actually writes a stamp —
 * carries its own copies of the same questions, and they were still discarding
 * `error`. They were also invisible to `check-unchecked-supabase-reads`, whose
 * scope rule attributes a read to its enclosing function name and matches
 * nothing called `_awardStampCore`. So the ledger read 0 FAIL-OPEN while the
 * write path had three.
 *
 * supabase-js RESOLVES on a database error, so each of these produced the same
 * `null` for "no such record" and for "the table could not be read":
 *
 *   stamp_award_events (idempotency)  → "this award has not happened yet"
 *   user_stamps (heal path)           → "no stamp row" → INSERT one
 *   user_stamps (non-repeatable)      → "not earned yet" → award it again
 *
 * ── THE CONSTRAINT IS A BACKSTOP, NOT AN EXCUSE ─────────────────────────────
 * Production carries `stamp_award_events_idempotency_key_key` UNIQUE and
 * `user_stamps_live_award_unique` UNIQUE (verified against the live database),
 * so a duplicate could not actually land. That bounds the DAMAGE; it does not
 * make the CLASSIFICATION correct. "The database could not answer" is not "there
 * is no record", and answering either `already_awarded` or `awarded` is a false
 * statement about the user's passport. The distinction also matters because a
 * constraint can be dropped, and then nothing else is holding the line.
 *
 * ── THE FOUR CASES P1 ASKS TO SEPARATE ──────────────────────────────────────
 *   genuine absence  → award proceeds
 *   duplicate award  → already_awarded / already_earned
 *   unique race      → 23505 on INSERT → already_awarded (unchanged, still right)
 *   database failure → eligibility_unavailable  ← the one that was missing
 *
 * `eligibility_unavailable` is deliberately the same word `checkEligibility`
 * uses, so the dry-run and the write path cannot drift apart in how they name
 * the same fact.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/stampAwardWritePathFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { awardStamp } from "../services/passport/StampAwardEngine.js";

const USER = "11111111-0000-4000-a000-000000000001";
const DEF_ID = "22222222-0000-4000-a000-000000000002";
const SOURCE = "33333333-0000-4000-a000-000000000003";

const DEFINITION = {
  id: DEF_ID,
  slug: "test_stamp",
  name: "Test Stamp",
  is_active: true,
  is_repeatable: false,
  max_awards_per_user: null,
  category: "trips",
  requires_source: false,
};

function baseRows(extra: Record<string, any[]> = {}) {
  return {
    feature_flags: [
      { flag: "stamp_system_v2_enabled", enabled: true },
      { flag: "passport_stamps_enabled", enabled: true },
      { flag: "trust_engine_enabled", enabled: false }, // Trust emission off: this file is about the award path
    ],
    stamp_definitions: [DEFINITION],
    stamp_award_events: [],
    user_stamps: [],
    stamp_progress: [],
    // The engine validates the source row before awarding (INVALID_TRIP_STATUSES),
    // so a fixture without it gets `source_not_found` and every case below would
    // "pass" for a reason that has nothing to do with the reads under test.
    trips: [{ id: SOURCE, status: "completed" }],
    ...extra,
  };
}

const input = () => ({
  userId: USER,
  definitionSlug: "test_stamp",
  sourceType: "trips" as const,
  sourceId: SOURCE,
  awardSource: "verified" as const,
});

/** Fail exactly one table, leaving every sibling read healthy. */
const failTable = (table: string) => (ctx: FakeReadContext) =>
  ctx.table === table ? { message: `${table} unavailable`, code: "57P01" } : null;

describe("_awardStampCore — genuine absence still awards (the control)", () => {
  it("awards when every read succeeds and nothing exists yet", async () => {
    // Without this, a fix that returned eligibility_unavailable unconditionally
    // would pass every failure case below while making stamps impossible.
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({ rows: baseRows(), inserted });
    const r = await awardStamp(sc, input() as any, noopLog as any);
    assert.equal(r.awarded, true, `expected an award, got ${r.reason}`);
    assert.ok((inserted["user_stamps"] ?? []).length >= 1, "a stamp row must be written");
  });
});

describe("_awardStampCore — a database failure is not a duplicate and not an award", () => {
  it("stamp_award_events unreadable → eligibility_unavailable, NOT already_awarded, NOT awarded", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: baseRows(),
      failOn: failTable("stamp_award_events"),
      inserted,
    });
    const r = await awardStamp(sc, input() as any, noopLog as any);

    assert.equal(r.awarded, false);
    assert.equal(r.reason, "eligibility_unavailable");
    // Both of these would be false statements about the user's passport.
    assert.notEqual(r.reason, "already_awarded");
    assert.notEqual(r.reason, "awarded");
    // And nothing may be written on an unread precondition.
    assert.equal((inserted["user_stamps"] ?? []).length, 0);
    assert.equal((inserted["stamp_award_events"] ?? []).length, 0);
  });

  it("user_stamps unreadable on the non-repeatable check → eligibility_unavailable, no second stamp", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: baseRows(),
      failOn: failTable("user_stamps"),
      inserted,
    });
    const r = await awardStamp(sc, input() as any, noopLog as any);

    assert.equal(r.awarded, false);
    assert.equal(r.reason, "eligibility_unavailable");
    assert.notEqual(r.reason, "already_earned");
    assert.equal((inserted["user_stamps"] ?? []).length, 0, "a non-repeatable stamp must not be re-awarded on an unread check");
  });

  it("user_stamps unreadable on the HEAL path → eligibility_unavailable, no stamp manufactured", async () => {
    // The heal path is the dangerous one: the award EVENT is already committed,
    // so the code is primed to insert a stamp. An unreadable user_stamps made it
    // insert one for an award that may already have had it.
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: baseRows({
        stamp_award_events: [{
          id: "evt-1",
          user_id: USER,
          stamp_definition_id: DEF_ID,
          source_type: "trips",
          source_id: SOURCE,
          // MUST equal buildIdempotencyKey(userId, definitionId, sourceType, sourceId).
          // The first version of this fixture used a placeholder, so the
          // idempotency lookup found nothing, the heal branch was never entered,
          // and the case was actually exercising the NON-REPEATABLE check —
          // which is why removing the heal fix changed nothing (# fail 0).
          idempotency_key: `${USER}:${DEF_ID}:trips:${SOURCE}`,
          status: "awarded",
        }],
      }),
      // Fail the LOOKUP only, not the insert's returning read.
      //
      // The first version of this case used failTable("user_stamps"), which
      // failed every user_stamps operation INCLUDING the write's own returning
      // select — so the request stopped either way and the case passed with the
      // fix REMOVED (hand-revert: # fail 0). It asserted a true statement about
      // an outcome that the fix had no part in producing.
      //
      // The heal lookup carries filters; the insert's returning read does not.
      // Failing only the filtered read lets the write proceed, so WITHOUT the
      // fix a stamp is actually manufactured and the case fails as it should.
      failOn: (ctx: FakeReadContext) =>
        ctx.table === "user_stamps" && ctx.filters.length > 0
          ? { message: "user_stamps unavailable", code: "57P01" }
          : null,
      inserted,
    });
    const r = await awardStamp(sc, input() as any, noopLog as any);

    assert.equal(r.awarded, false);
    assert.equal(r.reason, "eligibility_unavailable");
    assert.equal((inserted["user_stamps"] ?? []).length, 0, "the heal must not manufacture a stamp from an unread table");
  });
});

describe("_awardStampCore — the duplicate and race cases still resolve correctly", () => {
  it("an existing non-revoked stamp is already_earned, not eligibility_unavailable", async () => {
    // A real duplicate must keep its own distinct answer — the fix must not
    // collapse "already earned" into "could not tell".
    const sc = makeFailClosedClient({
      rows: baseRows({
        user_stamps: [{
          id: "st-1", user_id: USER, stamp_definition_id: DEF_ID,
          is_revoked: false, source_type: "trips", source_id: SOURCE,
        }],
      }),
    });
    const r = await awardStamp(sc, input() as any, noopLog as any);
    assert.equal(r.awarded, false);
    assert.equal(r.reason, "already_earned");
  });

  it("a 23505 unique race on the award-event INSERT is already_awarded, not a failure", async () => {
    // The unique index doing its job is a legitimate duplicate, and it must stay
    // distinguishable from a read failure.
    const sc = makeFailClosedClient({
      rows: baseRows(),
      failWritesOn: (t: string) =>
        t === "stamp_award_events"
          ? { message: "duplicate key value violates unique constraint", code: "23505" }
          : null,
    });
    const r = await awardStamp(sc, input() as any, noopLog as any);
    assert.equal(r.awarded, false);
    assert.equal(r.reason, "already_awarded");
    assert.notEqual(r.reason, "eligibility_unavailable");
  });
});
