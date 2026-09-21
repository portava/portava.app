/**
 * THE 90-DAY VERIFICATION PURGE, AND THE ROWS IT MUST NEVER TOUCH.
 *
 * verified-foundation-plan.md V-7: "Retention job: purge failed/expired
 * verification rows older than 90 days." There was no such job: nothing in the
 * repository read `identity_verifications` with a date bound, and `expires_at`
 * was written and never acted on.
 *
 * ── THE DANGEROUS DIRECTION ─────────────────────────────────────────────────
 * A retention job is one filter away from revoking every verification on the
 * platform. `verified` rows are not stale data — they are the standing evidence
 * that a government-ID check happened, and `lib/travelerVerification.ts` plus
 * `routes/rentABuddyRollout.ts` gate in-person introductions on the state they
 * produced. A purge written as "delete anything not pending" or "delete
 * anything older than 90 days" would silently un-verify the whole user base on
 * a timer, and it would look like it was working.
 *
 * So the status filter is asserted POSITIVELY here, as a set, rather than by
 * checking that one survivor survived. A negative filter would also sweep in
 * any status added later, including one that means verified.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationRetention.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  purgeExpiredVerificationRecords,
  PURGEABLE_STATUSES,
  VERIFICATION_RETENTION_DAYS,
} from "../services/identityVerification/retention.js";
import { runTrustMaintenance } from "../lib/trustMaintenanceScheduler.js";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");

interface Call { table: string; op: string; filters: Array<[string, string, unknown]> }

function client(opts: { deleted?: any[]; error?: string; flagOn?: boolean } = {}) {
  const calls: Call[] = [];
  function builder(table: string) {
    const filters: Array<[string, string, unknown]> = [];
    let op = "select";
    const q: any = {
      select: () => { if (op === "select") calls.push({ table, op, filters }); return q; },
      delete: () => { op = "delete"; calls.push({ table, op, filters }); return q; },
      update: () => { op = "update"; calls.push({ table, op, filters }); return q; },
      insert: () => { op = "insert"; calls.push({ table, op, filters }); return q; },
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return q; },
      in: (c: string, v: unknown) => { filters.push(["in", c, v]); return q; },
      lt: (c: string, v: unknown) => { filters.push(["lt", c, v]); return q; },
      gt: () => q, gte: () => q, lte: () => q, is: () => q, not: () => q, or: () => q,
      order: () => q, limit: () => q, range: () => q,
      maybeSingle: () =>
        Promise.resolve(
          table === "feature_flags"
            ? { data: { enabled: opts.flagOn ?? true }, error: null }
            : { data: null, error: null },
        ),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any) =>
        Promise.resolve(
          table === "identity_verifications" && op === "delete"
            ? (opts.error ? { data: null, error: { message: opts.error } } : { data: opts.deleted ?? [], error: null })
            : { data: [], error: null },
        ).then(resolve),
    };
    return q;
  }
  return { _calls: calls, from: (t: string) => builder(t) } as any;
}

function purgeCall(c: any): Call | undefined {
  return c._calls.find((x: Call) => x.table === "identity_verifications" && x.op === "delete");
}

describe("verification retention purge", () => {
  it("purges EXACTLY the two statuses the plan names — asserted as a set", async () => {
    const c = client({ deleted: [{ id: "v1" }, { id: "v2" }] });
    await purgeExpiredVerificationRecords(c, { now: NOW });

    const call = purgeCall(c)!;
    const statusFilter = call.filters.find((f) => f[0] === "in" && f[1] === "status");
    assert.ok(statusFilter, "the purge must filter on status; an unfiltered delete empties the table");
    assert.deepEqual(
      [...(statusFilter[2] as string[])].sort(),
      ["expired", "failed"],
      "positively: failed and expired only. 'verified' is standing evidence that gates in-person " +
        "introductions, and 'created'/'pending'/'processing' are live attempts",
    );
    assert.deepEqual([...PURGEABLE_STATUSES].sort(), ["expired", "failed"]);
  });

  it("never names a verified row, by any spelling of the filter", async () => {
    const c = client({ deleted: [] });
    await purgeExpiredVerificationRecords(c, { now: NOW });

    const call = purgeCall(c)!;
    const asText = JSON.stringify(call.filters);
    assert.ok(
      !asText.includes("verified"),
      `no filter on this delete may mention a verified status; got ${asText}`,
    );
  });

  it("uses a 90-day cutoff on updated_at, not created_at", async () => {
    const c = client({ deleted: [] });
    const out = await purgeExpiredVerificationRecords(c, { now: NOW });

    const call = purgeCall(c)!;
    const age = call.filters.find((f) => f[0] === "lt");
    assert.ok(age, "the purge must be bounded by age; without it every failed row goes at once");
    assert.equal(
      age[1],
      "updated_at",
      "age starts when the row reached its terminal state, not when the session was created",
    );
    assert.equal(VERIFICATION_RETENTION_DAYS, 90);
    assert.equal(
      Date.parse(age[2] as string),
      NOW - 90 * 24 * 60 * 60 * 1000,
      "the cutoff must be exactly 90 days before now",
    );
    assert.equal(out.cutoff, age[2]);
  });

  it("counts what it deleted rather than assuming", async () => {
    const c = client({ deleted: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const out = await purgeExpiredVerificationRecords(c, { now: NOW });
    assert.equal(out.purged, 3);
  });

  it("A FAILED PURGE THROWS — it must not look like 'nothing to purge'", async () => {
    const c = client({ error: "permission denied for table identity_verifications" });
    await assert.rejects(
      () => purgeExpiredVerificationRecords(c, { now: NOW }),
      /permission denied/,
      "supabase-js RESOLVES on failure; a retention job that silently stops running is " +
        "indistinguishable from one that is working, forever",
    );
  });
});

describe("the maintenance pass runs the purge", () => {
  it("purges even when the TRUST ENGINE FLAG IS OFF", async () => {
    // The flag governs scoring. Retention is a data-protection obligation and
    // must not be switchable by a scoring feature flag — which it would be if
    // the purge sat after the pass's fail-closed gate.
    const c = client({ deleted: [{ id: "old" }], flagOn: false });

    const out: any = await runTrustMaintenance(c);

    assert.equal(out.skipReason, "flag_off", "the rest of the pass must still be gated");
    assert.ok(
      purgeCall(c),
      "the verification purge must run before the flag gate — GDPR retention is not a trust feature",
    );
    assert.equal(out.verificationRecordsPurged, 1, "and the pass must report what it purged");
  });

  it("purges on a normal pass too", async () => {
    const c = client({ deleted: [{ id: "old" }, { id: "older" }], flagOn: true });
    const out: any = await runTrustMaintenance(c);
    assert.equal(out.verificationRecordsPurged, 2);
  });
});
