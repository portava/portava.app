/**
 * moderationAudit — "no accountable owner exists" must not be said about a
 * table that could not be read.
 *
 * `auditReportAction` used to call the thin `resolveContentOwner`, whose null
 * means any of four things (resolved-to-nothing, unowned by design, not found,
 * or THE LOOKUP COULD NOT RUN). It answered `skipped_no_owner` for all of them.
 * routes/admin.ts `/reports/:id/dismiss` hands that string to a human operator
 * as `audit`, so an unreadable `posts` table told a moderator, in as many
 * words, that the reported content has no owner.
 *
 * supabase-js RESOLVES on a database error, so the failing case here injects a
 * resolved `{ data: null, error }` exactly as the real client delivers one — a
 * `try/catch` around such a read is dead code and would prove nothing.
 *
 * PAIRING: `lookup_failed` and a genuinely-missing content row produce the same
 * `ownerUserId: null` and used to produce the same answer, so every failure case
 * below is paired with the readable cases it must be distinguishable from — the
 * row PRESENT, the row ABSENT, and `place` (unowned by design).
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/moderationAuditOwnerLookupFailed.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { auditReportAction } from "../lib/moderationAudit.js";

const REPORT_ID = "40000000-0000-0000-0000-000000000040";
const POST_ID = "10000000-0000-0000-0000-000000000010";
const AUTHOR_ID = "b0000000-0000-0000-0000-000000000002";
const ADMIN_ID = "a0000000-0000-0000-0000-000000000001";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

type Row = Record<string, any>;

/**
 * PostgREST double with a per-table error channel and a record of every insert,
 * so "the audit row was skipped" is asserted against what was actually written
 * rather than against the return value alone.
 */
function makeClient(rows: Record<string, Row[]>, errors: Record<string, any> = {}) {
  const inserts: Array<{ table: string; row: Row }> = [];
  const client = {
    inserts,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let insertRow: Row | null = null;
      const err = errors[table] ?? null;
      const b: any = {
        select: () => b,
        insert: (r: Row) => { insertRow = r; return b; },
        update: () => b,
        delete: () => b,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
        limit: () => b,
        order: () => b,
        async maybeSingle() {
          if (insertRow) { inserts.push({ table, row: insertRow }); return { data: { id: "audit-1" }, error: null }; }
          if (err) return { data: null, error: err };
          return { data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null };
        },
        async single() { return b.maybeSingle(); },
        then(onF: any, onR: any) {
          if (insertRow) { inserts.push({ table, row: insertRow }); return Promise.resolve({ data: [{ id: "audit-1" }], error: null }).then(onF, onR); }
          if (err) return Promise.resolve({ data: null, error: err }).then(onF, onR);
          return Promise.resolve({ data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(onF, onR);
        },
      };
      return b;
    },
  };
  return client;
}

/** Captures the level each message was logged at — the operator signal is the deliverable. */
function makeReq() {
  const logged: Array<{ level: string; msg: string }> = [];
  const cap = (level: string) => (_o: unknown, msg?: string) => { logged.push({ level, msg: String(msg ?? _o) }); };
  return { logged, log: { error: cap("error"), warn: cap("warn"), info: cap("info"), debug: cap("debug") } };
}

const opts = (targetType: string, targetId: string) => ({
  reportId: REPORT_ID,
  targetType,
  targetId,
  adminUserId: ADMIN_ID,
  actionType: "report_dismissed",
  reason: null,
});

let calls = 0;
async function audit(rows: Record<string, Row[]>, errors: Record<string, any>, targetType = "post", targetId = POST_ID) {
  const sc = makeClient(rows, errors);
  const req = makeReq();
  calls++;
  const r = await auditReportAction(sc as any, req, opts(targetType, targetId));
  return { r: r as any, req, sc };
}

describe("owner lookup FAILED", () => {
  it("returns skipped_owner_lookup_failed — NOT skipped_no_owner", async () => {
    const { r } = await audit({}, { posts: DB_ERROR });
    assert.equal(r.ok, true);
    assert.equal(r.audit, "skipped_owner_lookup_failed",
      "an unreadable posts table must not report that the content has no accountable owner");
    assert.equal(r.ownerUserId, null);
  });

  it("sets metadata.owner_lookup_failed, the declared field nothing used to set", async () => {
    const { r } = await audit({}, { posts: DB_ERROR });
    assert.equal(r.metadata.owner_lookup_failed, true);
    assert.notEqual(r.metadata.owner_unresolved, true,
      "owner_unresolved is a claim about the content and must NOT be set for an outage");
  });

  it("logs at ERROR, not WARN — an unreadable database is an operations event", async () => {
    const { req } = await audit({}, { posts: DB_ERROR });
    const hit = req.logged.find((l) => l.msg.includes("COULD NOT RUN"));
    assert.ok(hit, `expected an explicit lookup-failure log; got ${JSON.stringify(req.logged)}`);
    assert.equal(hit!.level, "error");
  });

  it("writes NO moderation_actions row", async () => {
    const { sc } = await audit({}, { posts: DB_ERROR });
    assert.equal(sc.inserts.length, 0);
  });
});

describe("PAIRED readable cases — what the failure must be distinguishable from", () => {
  it("content row ABSENT → skipped_no_owner, owner_unresolved, WARN", async () => {
    const { r, req, sc } = await audit({ posts: [] }, {});
    assert.equal(r.audit, "skipped_no_owner");
    assert.equal(r.metadata.owner_unresolved, true);
    assert.notEqual(r.metadata.owner_lookup_failed, true);
    assert.equal(sc.inserts.length, 0);
    const hit = req.logged.find((l) => l.msg.includes("no accountable user"));
    assert.ok(hit);
    assert.equal(hit!.level, "warn", "a genuinely unowned item is not an outage");
  });

  it("content row PRESENT → recorded, and the audit row names the author", async () => {
    // Proves the failure cases above are not simply "this helper never records".
    const { r, sc } = await audit({ posts: [{ id: POST_ID, author_id: AUTHOR_ID }] }, {});
    assert.equal(r.audit, "recorded");
    assert.equal(r.ownerUserId, AUTHOR_ID);
    assert.equal(sc.inserts.length, 1);
    assert.equal(sc.inserts[0].table, "moderation_actions");
    assert.equal(sc.inserts[0].row.target_user_id, AUTHOR_ID);
    assert.equal(sc.inserts[0].row.metadata.report_id, REPORT_ID);
    assert.notEqual(sc.inserts[0].row.metadata.owner_lookup_failed, true);
  });

  it("`place` → skipped_no_owner (unowned BY DESIGN), never lookup_failed", async () => {
    const { r } = await audit({}, { posts: DB_ERROR }, "place", POST_ID);
    assert.equal(r.audit, "skipped_no_owner",
      "a place is unowned by design — that is a real answer, not a failed lookup");
    assert.notEqual(r.metadata.owner_lookup_failed, true);
  });
});

describe("the recorded contract other code depends on is unchanged", () => {
  it("still answers exactly \"recorded\" — src/scripts/verifyModerationFkE2E.ts:218 asserts this", async () => {
    const { r } = await audit({ posts: [{ id: POST_ID, author_id: AUTHOR_ID }] }, {});
    assert.equal(r.audit, "recorded");
    assert.equal(typeof r.ownerUserId, "string");
  });
});

describe("vacuity", () => {
  it("every case above actually invoked auditReportAction", () => {
    assert.ok(calls >= 8, `expected >= 8 invocations, got ${calls}`);
  });
});
