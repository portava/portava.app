/**
 * The model of `telegraph_unsend_message_before_seen` must not drift from the
 * function.
 *
 * `telegraphUnsendFunctionFake.ts` is what the route suites decide against. A
 * model that quietly describes the OLD function turns every one of those suites
 * into a green report about behaviour that no longer exists — which is the
 * failure mode this whole lane keeps finding. So the model's outcome order is
 * checked against the SQL of migration 3000 itself, read off disk.
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - Adding, removing or reordering an outcome in the migration without
 *     touching the model (or the reverse).
 *   - The migration losing its FOR UPDATE locks, or the lifecycle_state write,
 *     which is what migration 3000 exists for.
 *   - `planUnsend` and the function disagreeing about any of the fixtures
 *     below. `planUnsend` is documented as "the same rule in TypeScript"; the
 *     last describe() here is what makes that a measurement. It already caught
 *     one real disagreement: `planUnsend` refused a departed sender BEFORE
 *     noticing the message was already gone, and the function answers in the
 *     other order.
 *
 * It does NOT prove the model computes the same ANSWER as the function — only
 * a database can prove that, and the `api-server · kernel SQL executed on a
 * throwaway database` job is where the migration runs for real. It proves the
 * two have not diverged in shape, which is the drift a reader cannot see.
 *
 * Run: node --import tsx/esm --test src/test/telegraphUnsendFunctionFake.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MODELLED_OUTCOME_ORDER,
  makeUnsendFunctionFake,
  type UnsendFakeMember,
  type UnsendFakeRow,
} from "./telegraphUnsendFunctionFake.js";
import { planUnsend, refusalForOutcome } from "../services/telegraph/unsend.js";

const MIGRATION = resolve(
  process.cwd(),
  "src/migrations/3000_telegraph_unsend_authoritative.sql",
);

/** Just the plpgsql body, so the header's prose list is not mistaken for code. */
function functionBody(sql: string): string {
  const start = sql.indexOf("AS $fn$");
  const end = sql.indexOf("$fn$;", start);
  assert.ok(start > 0 && end > start, "could not find the function body in the migration");
  return sql.slice(start, end);
}

describe("the model and the migration agree on the outcomes", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const body = functionBody(sql);

  it("names the same outcomes, in the same order the function decides them", () => {
    const inSql: string[] = [];
    const re = /'outcome',\s*'([a-z_]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) if (!inSql.includes(m[1])) inSql.push(m[1]);

    assert.deepEqual(
      inSql,
      [...MODELLED_OUTCOME_ORDER],
      "the migration and telegraphUnsendFunctionFake.ts disagree — update the model, " +
      "or the route suites are testing a function that no longer exists",
    );
  });

  it("the function still takes the row locks it exists for", () => {
    const locks = body.match(/FOR UPDATE/g) ?? [];
    assert.equal(locks.length, 2,
      "two FOR UPDATE clauses: the message row, then every eligible recipient's receipt");
  });

  it("locks the receipt rows BEFORE it reads last_read_at, which is the guarantee", () => {
    // Counting the clauses is not enough and was measured to be not enough: two
    // FOR UPDATEs placed after the seen-check would satisfy a count and close
    // nothing. The §7.4 guarantee is an ORDER — lock, then read, then write —
    // and the order is what is asserted.
    const lockMessage = body.indexOf("FOR UPDATE");
    const lockReceipts = body.indexOf("FOR UPDATE", lockMessage + 1);
    // `INTO v_seen_count`, not `v_seen_count`: the name's first appearance is
    // its DECLARE, hundreds of characters above any of this, and using it made
    // the assertion fire on a function that is in fact correct.
    const readReceipts = body.indexOf("INTO v_seen_count");
    const write = body.indexOf("UPDATE public.messages");

    assert.ok(lockMessage > 0, "no lock on the message row");
    assert.ok(lockReceipts > lockMessage, "no second lock on the receipt rows");
    assert.ok(
      readReceipts > lockReceipts,
      "last_read_at is read BEFORE the receipt rows are locked — the race is open",
    );
    assert.ok(write > readReceipts, "the write happens before the seen-check");

    // And the second lock must be on the receipts, not a second lock on the
    // message: an index comparison alone cannot tell those apart.
    const between = body.slice(lockMessage, lockReceipts);
    assert.match(
      between.slice(between.indexOf("PERFORM")),
      /public\.message_thread_members/,
      "the second FOR UPDATE is not on message_thread_members",
    );
  });

  it("the function still writes lifecycle_state, which is why 3000 exists", () => {
    assert.match(body, /lifecycle_state\s*=\s*'unsent'/);
  });

  it("the function still sets deleted_at, which is what every reader suppresses on", () => {
    assert.match(body, /deleted_at\s*=\s*v_now/);
  });
});

describe("the model itself", () => {
  const fixture = (): { messages: UnsendFakeRow[]; message_thread_members: UnsendFakeMember[] } => ({
    messages: [
      { id: "m1", thread_id: "t", sender_id: "alice", created_at: "2026-05-02T00:00:00.000Z",
        deleted_at: null, unsent_at: null, body: "hi" },
    ],
    message_thread_members: [
      { thread_id: "t", user_id: "alice", left_at: null, last_read_at: null },
      { thread_id: "t", user_id: "bob", left_at: null, last_read_at: null },
    ],
  });

  const call = (rpc: any, over: Record<string, unknown> = {}) =>
    rpc("telegraph_unsend_message_before_seen", {
      p_message_id: "m1", p_actor_id: "alice", p_thread_id: "t", ...over,
    });

  it("writes all four columns on the happy path, and reports the count", async () => {
    const db = fixture();
    const rpc = makeUnsendFunctionFake(() => db, { unsentAt: "2026-05-04T00:00:00.000Z" });
    const { data } = await call(rpc);
    assert.deepEqual(data, {
      outcome: "unsent", unsentAt: "2026-05-04T00:00:00.000Z", seenBy: 0, recipientCount: 1,
    });
    assert.equal(db.messages[0].unsent_at, "2026-05-04T00:00:00.000Z");
    assert.equal(db.messages[0].deleted_at, "2026-05-04T00:00:00.000Z");
    assert.equal(db.messages[0].lifecycle_state, "unsent");
    assert.equal(db.messages[0].body, "");
  });

  it("a recipient who read PAST the message closes the window", async () => {
    const db = fixture();
    db.message_thread_members[1].last_read_at = "2026-05-03T00:00:00.000Z";
    const { data } = await call(makeUnsendFunctionFake(() => db));
    assert.deepEqual(data, { outcome: "seen", seenBy: 1, recipientCount: 1 });
    assert.equal(db.messages[0].unsent_at, null, "a refused unsend writes nothing");
  });

  it("a DEPARTED member's stale read does not keep the window shut", async () => {
    const db = fixture();
    db.message_thread_members[1].last_read_at = "2026-05-03T00:00:00.000Z";
    db.message_thread_members[1].left_at = "2026-05-03T12:00:00.000Z";
    const { data } = await call(makeUnsendFunctionFake(() => db));
    assert.equal((data as any).outcome, "unsent");
    assert.equal((data as any).recipientCount, 0);
  });

  it("a second unsend says already_unsent, not already_deleted", async () => {
    const db = fixture();
    const rpc = makeUnsendFunctionFake(() => db);
    await call(rpc);
    const { data } = await call(rpc);
    assert.equal((data as any).outcome, "already_unsent");
  });

  it("a throw is reported as a throw, so the caller's catch is exercised", async () => {
    const rpc = makeUnsendFunctionFake(fixture, { throws: true });
    await assert.rejects(() => call(rpc));
  });
});

// ── the TypeScript statement of the rule, against the modelled function ──────

/**
 * `planUnsend` is the rule as a pure function; the model is the rule as the
 * database decides it. They are two copies, so they are driven over the same
 * fixtures and required to agree.
 *
 * Only the OUTCOME is compared, through `refusalForOutcome` — the one mapping
 * both the lifecycle route and this test now use. `planUnsend` does not have a
 * `not_found` (its caller already holds the message) and collapses the two
 * already-gone outcomes into one refusal, which `refusalForOutcome` encodes;
 * everything else must match exactly, including `seenBy` and `recipientCount`.
 */
describe("planUnsend agrees with the function it is a second opinion about", () => {
  const T = "eeeeeeee-0000-4000-8000-00000000000e";
  const SENDER = "aaaaaaaa-0000-4000-8000-000000000001";
  const RECIPIENT = "bbbbbbbb-0000-4000-8000-000000000002";
  const OTHER = "cccccccc-0000-4000-8000-000000000003";
  const MSG = "11110000-0000-4000-8000-00000000000a";
  const SENT = "2026-05-02T00:00:00.000Z";
  const BEFORE = "2026-05-01T00:00:00.000Z";
  const AFTER = "2026-05-03T00:00:00.000Z";

  interface Case {
    name: string;
    actorId: string;
    message: Partial<UnsendFakeRow>;
    members: UnsendFakeMember[];
  }

  const CASES: Case[] = [
    {
      name: "unseen, sender present",
      actorId: SENDER,
      message: {},
      members: [
        { thread_id: T, user_id: SENDER, last_read_at: AFTER },
        { thread_id: T, user_id: RECIPIENT, last_read_at: BEFORE },
      ],
    },
    {
      name: "one of two recipients has read past it",
      actorId: SENDER,
      message: {},
      members: [
        { thread_id: T, user_id: SENDER, last_read_at: AFTER },
        { thread_id: T, user_id: RECIPIENT, last_read_at: AFTER },
        { thread_id: T, user_id: OTHER, last_read_at: BEFORE },
      ],
    },
    {
      name: "someone else's message",
      actorId: RECIPIENT,
      message: {},
      members: [
        { thread_id: T, user_id: SENDER, last_read_at: AFTER },
        { thread_id: T, user_id: RECIPIENT, last_read_at: BEFORE },
      ],
    },
    {
      name: "sender has left the thread",
      actorId: SENDER,
      message: {},
      members: [
        { thread_id: T, user_id: SENDER, last_read_at: AFTER, left_at: AFTER },
        { thread_id: T, user_id: RECIPIENT, last_read_at: BEFORE },
      ],
    },
    {
      name: "already unsent",
      actorId: SENDER,
      message: { unsent_at: AFTER, deleted_at: AFTER, lifecycle_state: "unsent" },
      members: [
        { thread_id: T, user_id: SENDER, last_read_at: AFTER },
        { thread_id: T, user_id: RECIPIENT, last_read_at: BEFORE },
      ],
    },
    {
      name: "already deleted by some other path",
      actorId: SENDER,
      message: { deleted_at: AFTER },
      members: [
        { thread_id: T, user_id: SENDER, last_read_at: AFTER },
        { thread_id: T, user_id: RECIPIENT, last_read_at: BEFORE },
      ],
    },
    {
      // This is the fixture that caught the divergence. Two refusals are true
      // at once and the two copies used to pick different ones.
      name: "already unsent AND the sender has left",
      actorId: SENDER,
      message: { unsent_at: AFTER, deleted_at: AFTER, lifecycle_state: "unsent" },
      members: [
        { thread_id: T, user_id: SENDER, last_read_at: AFTER, left_at: AFTER },
        { thread_id: T, user_id: RECIPIENT, last_read_at: BEFORE },
      ],
    },
    {
      name: "a departed recipient's stale read",
      actorId: SENDER,
      message: {},
      members: [
        { thread_id: T, user_id: SENDER, last_read_at: AFTER },
        { thread_id: T, user_id: RECIPIENT, last_read_at: AFTER, left_at: AFTER },
      ],
    },
  ];

  for (const c of CASES) {
    it(`agrees: ${c.name}`, async () => {
      const message: UnsendFakeRow = {
        id: MSG,
        thread_id: T,
        sender_id: SENDER,
        created_at: SENT,
        deleted_at: null,
        unsent_at: null,
        ...c.message,
      };
      const db = { messages: [message], message_thread_members: c.members };
      // The model WRITES on the success branch, in place, exactly as the
      // function does. `planUnsend` has to see the row as it was BEFORE the
      // call or every successful case reads back as already_gone — which is
      // how this test first failed, and is a real hazard for any caller that
      // reuses a row across an unsend.
      const before: UnsendFakeRow = { ...message };
      const rpc = makeUnsendFunctionFake(() => db, { unsentAt: "2026-05-04T00:00:00.000Z" });
      const { data } = await rpc("telegraph_unsend_message_before_seen", {
        p_message_id: MSG,
        p_actor_id: c.actorId,
        p_thread_id: T,
      });
      const row = data as { outcome: string; seenBy?: number; recipientCount?: number };

      const plan = planUnsend({
        message: { ...before, unsent_at: before.unsent_at ?? null },
        members: c.members.map((m) => ({
          user_id: m.user_id,
          last_read_at: m.last_read_at ?? null,
          left_at: m.left_at ?? null,
        })),
        actorId: c.actorId,
        actorIsActiveMember: c.members.some(
          (m) => m.user_id === c.actorId && m.left_at == null,
        ),
      });

      assert.notEqual(row.outcome, "not_found", "the fixture must reach a real decision");

      if (row.outcome === "unsent") {
        assert.equal(plan.eligible, true, "the function unsent it; planUnsend refused");
      } else {
        assert.equal(plan.eligible, false, "the function refused; planUnsend allowed it");
        assert.equal(
          plan.refusal,
          refusalForOutcome(row.outcome as Exclude<Parameters<typeof refusalForOutcome>[0], never>),
          `the two copies of the rule disagree about "${c.name}"`,
        );
      }
      assert.equal(plan.seenBy, row.seenBy ?? 0, "seenBy");
      assert.equal(plan.recipientCount, row.recipientCount ?? 0, "recipientCount");
    });
  }
});
