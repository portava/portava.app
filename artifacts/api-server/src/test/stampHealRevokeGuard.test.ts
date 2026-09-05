/**
 * StampAwardEngine — the SECOND revoke-resurrection guard (the heal path).
 *
 * WHAT THIS PROTECTS
 * ------------------
 * The engine has two places where it asks "does this user already have this
 * stamp?", and they must answer that question DIFFERENTLY:
 *
 *   step 4  (:294-302, fresh award)  `.eq("is_revoked", false)`
 *           A revoked stamp must NOT block a fresh award — re-earning is legal.
 *
 *   step 3b (:252-287, heal path)    NO is_revoked filter, deliberately
 *           Reached only when a `stamp_award_events` row is already committed
 *           with status='awarded' but the `user_stamps` row is missing. The
 *           heal exists to recover a PARTIAL failure (event committed, stamp
 *           insert crashed). A row that exists but is REVOKED is not that: the
 *           stamp was fully awarded and then an admin revoked it. Filtering
 *           revoked rows out here makes the heal see "no stamp" and insert a
 *           fresh, un-revoked one — silently resurrecting an admin revocation.
 *
 * The step-4 guard has tests (stamps-revoke-restore.test.ts). The heal-path
 * guard had none: the 2026-09-05 architecture audit added `.eq("is_revoked",
 * false)` to it and all 26 tests in the suites covering the engine stayed
 * green. The comment at :251-256 warns about exactly this and nothing enforced
 * it. This file does.
 *
 * The fake used here applies the recorded filters (unlike the one in
 * stampTriggerAudit.test.ts, which answers every user_stamps read with the same
 * canned row) — that is the only way the mutation can be observed.
 *
 * Run: node --import tsx/esm --test src/test/stampHealRevokeGuard.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { awardStamp } from "../services/passport/StampAwardEngine.js";
import { makeEngineFake } from "./stampEngineFake.js";

const USER = "aaaaaaaa-0000-0000-0000-000000000001";
const POST = "bbbbbbbb-0000-0000-0000-000000000001";
const DEF  = "cccccccc-0000-0000-0000-000000000001";

/** The key the engine builds — kept in one place so the fixture cannot drift. */
const idemKey = (sourceType: string, sourceId: string) => `${USER}:${DEF}:${sourceType}:${sourceId}`;

const committedEvent = (sourceType = "posts", sourceId = POST) => ({
  id: "evt-1",
  idempotency_key: idemKey(sourceType, sourceId),
  status: "awarded",
});

const stampRow = (over: Record<string, unknown> = {}) => ({
  id: "existing-stamp-1",
  user_id: USER,
  stamp_definition_id: DEF,
  source_type: "posts",
  source_id: POST,
  is_revoked: false,
  ...over,
});

const award = (fake: ReturnType<typeof makeEngineFake>) =>
  awardStamp(fake.client, {
    userId: USER,
    definitionSlug: "first_post",
    sourceType: "posts",
    sourceId: POST,
  });

describe("heal path does not resurrect a revoked stamp", () => {
  it("a REVOKED stamp for the same event blocks the heal", async () => {
    const fake = makeEngineFake({
      sources: { posts: { status: "active" } },
      awardEvents: [committedEvent()],
      userStamps: [stampRow({ is_revoked: true, revoked_reason: "admin revoked" })],
    });

    const result = await award(fake);

    assert.equal(result.awarded, false,
      "the heal inserted a stamp over an admin revocation — resurrection");
    assert.equal(result.reason, "already_awarded");
    assert.deepEqual(
      fake.inserted.filter((r) => r.table === "user_stamps"), [],
      "no user_stamps row may be inserted when a revoked row already exists for this event",
    );
  });

  it("the heal query carries NO is_revoked filter", async () => {
    const fake = makeEngineFake({
      sources: { posts: { status: "active" } },
      awardEvents: [committedEvent()],
      userStamps: [stampRow({ is_revoked: true })],
    });
    await award(fake);

    const healQuery = fake.userStampQueries[0] ?? [];
    assert.ok(healQuery.length > 0, "the heal path never queried user_stamps");
    assert.deepEqual(
      healQuery.filter(([col]) => col === "is_revoked"), [],
      "the heal-path lookup must match ANY stamp row for the event, revoked or " +
      "not — an is_revoked filter makes it heal over a revocation",
    );
    // It must still be scoped to this event's exact source, or a repeatable
    // stamp from a different source would mask a genuinely missing row.
    assert.deepEqual(
      healQuery.sort(),
      [["source_id", POST], ["source_type", "posts"], ["stamp_definition_id", DEF], ["user_id", USER]].sort(),
    );
  });

  it("a LIVE stamp for the same event also blocks the heal (already_awarded)", async () => {
    const fake = makeEngineFake({
      sources: { posts: { status: "active" } },
      awardEvents: [committedEvent()],
      userStamps: [stampRow()],
    });
    const result = await award(fake);
    assert.equal(result.awarded, false);
    assert.equal(result.reason, "already_awarded");
    assert.deepEqual(fake.inserted.filter((r) => r.table === "user_stamps"), []);
  });

  it("a genuinely missing stamp IS healed — the guard has not sealed the path shut", async () => {
    // The positive control: committed event, no user_stamps row at all. This is
    // the partial failure the heal exists for, and it must still insert.
    const fake = makeEngineFake({
      sources: { posts: { status: "active" } },
      awardEvents: [committedEvent()],
      userStamps: [],
    });
    const result = await award(fake);
    assert.equal(result.awarded, true, `expected the heal to insert, got "${result.reason}"`);
    assert.equal(
      fake.inserted.filter((r) => r.table === "user_stamps").length, 1,
      "the heal must insert exactly one user_stamps row",
    );
    assert.equal(
      fake.inserted.filter((r) => r.table === "stamp_award_events").length, 0,
      "the award event is already committed — the heal must not write a second one",
    );
  });

  it("a stamp from a DIFFERENT source does not mask this event's missing row", async () => {
    // Repeatable-stamp semantics: the heal matches on (source_type, source_id),
    // so an existing stamp earned from another source must not satisfy it.
    const fake = makeEngineFake({
      definition: {
        id: DEF, slug: "first_post", name: "First Post", stamp_type: "achievement",
        is_active: true, is_repeatable: true, max_awards_per_user: null,
        visibility_default: "public", criteria_type: "count", criteria: null,
      },
      sources: { posts: { status: "active" } },
      awardEvents: [committedEvent()],
      userStamps: [stampRow({ id: "other", source_id: "bbbbbbbb-0000-0000-0000-0000000000ff" })],
    });
    const result = await award(fake);
    assert.equal(result.awarded, true, `expected a heal for this event's own source, got "${result.reason}"`);
  });
});

describe("fresh-award path still allows re-earning a revoked stamp", () => {
  it("a revoked stamp does NOT block a fresh award (step 4 keeps its filter)", async () => {
    // No committed award event → the heal path is not taken; step 4 runs, and
    // its `.eq("is_revoked", false)` must exclude the revoked row.
    const fake = makeEngineFake({
      sources: { posts: { status: "active" } },
      awardEvents: [],
      userStamps: [stampRow({ is_revoked: true })],
    });
    const result = await award(fake);
    assert.equal(result.awarded, true, `a revoked stamp must not block re-earning, got "${result.reason}"`);
    assert.equal(fake.inserted.filter((r) => r.table === "stamp_award_events").length, 1);
    assert.equal(fake.inserted.filter((r) => r.table === "user_stamps").length, 1);
  });

  it("a LIVE stamp does block a fresh non-repeatable award (already_earned)", async () => {
    const fake = makeEngineFake({
      sources: { posts: { status: "active" } },
      awardEvents: [],
      userStamps: [stampRow()],
    });
    const result = await award(fake);
    assert.equal(result.awarded, false);
    assert.equal(result.reason, "already_earned");
    assert.deepEqual(fake.inserted, []);
  });
});
