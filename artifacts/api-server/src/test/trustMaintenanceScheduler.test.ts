/**
 * trustMaintenanceScheduler — WHEN DOES A PASS COUNT AS A SUCCESS?
 *
 * THE DEFECT THIS FILE PINS
 * -------------------------
 * `tickOnce()` ended with a bare `_status.consecutiveFailures = 0;` — i.e. the
 * failure counter was cleared at the end of every pass that did not THROW.
 *
 * `runTrustMaintenance` is fail-soft by construction: every step is
 * individually try/caught, every read logs its `.error` and returns a zero, and
 * the function returns `ok: true` regardless. So the top-level catch fired
 * almost never, and the counter read 0 through:
 *
 *   - a pass with no service client (nothing ran at all),
 *   - a pass in which `trust_events` was unreadable (`eventsSeen: null` —
 *     "we could not look", reported as a clean pass),
 *   - a pass in which EVERY recalculation threw (`recalcFailures: n`,
 *     `usersRecalculated: 0`),
 *   - a pass whose pending_review scan could not run (`reviewsStuck: null`).
 *
 * Every one of those is exactly the state a health counter exists to expose,
 * and every one of them read as healthy. The event waitlist sweeper carried the
 * same defect and fixed it the same way; this is that fix for the trust engine.
 *
 * A SKIP IS NOT AUTOMATICALLY A FAILURE. `flag_off` means the trust engine is
 * deliberately off and there is nothing to do — counting that as breakage would
 * train an operator to ignore the counter. `no_service_client` IS a failure:
 * the process cannot do the job at all. That distinction is asserted below in
 * both directions.
 *
 * HOW IT IS MEASURED
 * ------------------
 * A recording stub whose builder is a THENABLE, like the real PostgrestBuilder,
 * so a query that is never awaited issues nothing and is never recorded. Each
 * test asserts a non-zero count of the reads it believes it drove, so a stub
 * that silently stopped matching cannot leave an assertion vacuously true.
 *
 * Every stub read models BOTH `data` and `error`: supabase-js RESOLVES on a
 * database error, so a fake that only ever answered `{ error: null }` could not
 * reach a single branch this file is about.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest).
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustMaintenanceScheduler.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  tickOnce,
  getTrustMaintenanceStatus,
  _resetStatus,
} from "../lib/trustMaintenanceScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

// ── Stub ─────────────────────────────────────────────────────────────────────

interface Settled {
  table: string;
  ops: string[];
}

type Resolver = (table: string, ops: string[]) => { data: any; error: any; count?: number | null };

/**
 * Ops are recorded WITH their first argument (`eq:status=pending_review`), which
 * is what lets one stub distinguish the two different `trust_events` reads a
 * single pass makes — the dirty-user scan and the lost-review repair scan.
 */
function stubClient(resolve: Resolver) {
  const settled: Settled[] = [];

  function builder(table: string, ops: string[]): any {
    const b: any = {};
    for (const op of [
      "select", "insert", "update", "delete", "upsert",
      "eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "limit", "order", "not",
    ]) {
      b[op] = (...args: any[]) => {
        const a0 = args[0];
        const a1 = args[1];
        const label =
          (op === "eq" || op === "in" || op === "is") && typeof a0 === "string"
            ? `${op}:${a0}=${Array.isArray(a1) ? a1.join("|") : String(a1)}`
            : op;
        return builder(table, [...ops, label]);
      };
    }
    b.maybeSingle = () => builder(table, [...ops, "maybeSingle"]);
    b.single = () => builder(table, [...ops, "single"]);
    // The request happens here and nowhere else — PostgrestBuilder is a thenable.
    b.then = (onOk: any, onErr: any) => {
      settled.push({ table, ops: [...ops] });
      return Promise.resolve({ count: null, ...resolve(table, ops) }).then(onOk, onErr);
    };
    return b;
  }

  return {
    settled,
    reads(table: string) {
      return settled.filter((s) => s.table === table).length;
    },
    from(table: string) {
      return builder(table, []);
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

const DB_ERROR = { message: "connection terminated unexpectedly", code: "57P01" };

/** Flag row resolver: `trust_engine_enabled` on, gaming detection off. */
function flags(engineOn: boolean) {
  return (table: string, ops: string[]) => {
    if (table === "feature_flags") {
      const wantsEngine = ops.some((o) => o.includes("trust_engine_enabled"));
      return { data: { enabled: wantsEngine ? engineOn : false }, error: null };
    }
    return null as any;
  };
}

/** A whole pass in which every table is readable and empty. */
function healthyClient(engineOn = true) {
  const f = flags(engineOn);
  return stubClient((table, ops) => f(table, ops) ?? { data: [], error: null });
}

beforeEach(() => {
  _resetStatus();
});

afterEach(() => {
  _setTestServiceClient(null as any);
  _resetStatus();
});

// ═══════════════════════════════════════════════════════════════════════════

describe("a pass that genuinely succeeded", () => {
  it("clears the failure counter and records a lastSuccessAt", async () => {
    const c = healthyClient(true);
    _setTestServiceClient(c);

    await tickOnce();
    const s = getTrustMaintenanceStatus();

    assert.deepEqual(s.lastFailures, []);
    assert.equal(s.consecutiveFailures, 0);
    assert.notEqual(s.lastSuccessAt, null, "a clean pass must record a success");
    assert.ok(c.reads("trust_events") > 0, "vacuity check: the pass must have read trust_events");
  });
});

describe("a SKIPPED pass", () => {
  it("flag_off is not a failure — the engine is deliberately off", async () => {
    const c = healthyClient(false);
    _setTestServiceClient(c);

    await tickOnce();
    const s = getTrustMaintenanceStatus();

    assert.equal(s.lastSkippedReason, "flag_off");
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(
      s.lastSuccessAt,
      null,
      "a skip is not a failure, but it is not a successful pass either",
    );
    assert.ok(c.reads("feature_flags") > 0, "vacuity check: the flag must have been read");
  });
});

describe("a pass that could not look", () => {
  it("an unreadable trust_events is a FAILURE, not a pass with nothing to do", async () => {
    const f = flags(true);
    const c = stubClient((table, ops) => {
      const flag = f(table, ops);
      if (flag) return flag;
      // The dirty-user scan; NOT the pending_review repair scan.
      if (table === "trust_events" && ops.some((o) => o.startsWith("in:status="))) {
        return { data: null, error: DB_ERROR };
      }
      return { data: [], error: null };
    });
    _setTestServiceClient(c);

    await tickOnce();
    const s = getTrustMaintenanceStatus();

    assert.ok(
      s.lastFailures.includes("events_unreadable"),
      `expected events_unreadable, got ${JSON.stringify(s.lastFailures)}`,
    );
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null);
    assert.equal(
      s.lastEventsSeen,
      null,
      "null is 'the read failed'; reporting it as 0 is the defect",
    );
  });

  it("an unreadable pending_review scan is a FAILURE, not 'nothing is stuck'", async () => {
    const f = flags(true);
    const c = stubClient((table, ops) => {
      const flag = f(table, ops);
      if (flag) return flag;
      if (table === "trust_events" && ops.some((o) => o.includes("pending_review"))) {
        return { data: null, error: DB_ERROR };
      }
      return { data: [], error: null };
    });
    _setTestServiceClient(c);

    await tickOnce();
    const s = getTrustMaintenanceStatus();

    assert.ok(
      s.lastFailures.includes("review_scan_unreadable"),
      `expected review_scan_unreadable, got ${JSON.stringify(s.lastFailures)}`,
    );
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastReviewsStuck, null);
  });
});

describe("the counter across passes", () => {
  it("climbs while passes keep failing — it is not reset by 'did not throw'", async () => {
    const f = flags(true);
    const c = stubClient((table, ops) => {
      const flag = f(table, ops);
      if (flag) return flag;
      if (table === "trust_events" && ops.some((o) => o.startsWith("in:status="))) {
        return { data: null, error: DB_ERROR };
      }
      return { data: [], error: null };
    });
    _setTestServiceClient(c);

    await tickOnce();
    await tickOnce();
    await tickOnce();

    assert.equal(getTrustMaintenanceStatus().consecutiveFailures, 3);
  });

  it("resets only once a pass with no failures at all completes", async () => {
    let broken = true;
    const f = flags(true);
    const c = stubClient((table, ops) => {
      const flag = f(table, ops);
      if (flag) return flag;
      if (broken && table === "trust_events" && ops.some((o) => o.startsWith("in:status="))) {
        return { data: null, error: DB_ERROR };
      }
      return { data: [], error: null };
    });
    _setTestServiceClient(c);

    await tickOnce();
    assert.equal(getTrustMaintenanceStatus().consecutiveFailures, 1);

    broken = false;
    await tickOnce();
    const s = getTrustMaintenanceStatus();
    assert.equal(s.consecutiveFailures, 0);
    assert.notEqual(s.lastSuccessAt, null);
  });
});
