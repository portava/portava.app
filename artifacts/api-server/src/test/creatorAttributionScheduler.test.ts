/**
 * DV-56 — the scheduler that drives the travel_partner attribution producer
 * (census-discovery §52). §17.2's bar was "a call site on a route or scheduler";
 * this pins what that call site does on every deployment today, where the flag
 * is seeded FALSE: it reads ONE flag row and nothing else, and writes nothing.
 *
 *   SC1  flag off: the tick reads feature_flags only, writes nothing, and
 *        reports `disabled` without logging it as a fault
 *   SC2  flag on: the tick runs the producer — completed bookings only — and
 *        writes one attribution per unattributed booking
 *   SC3  overlapping ticks do not run the pass twice
 *
 * Run: node --import tsx/esm --test src/test/creatorAttributionScheduler.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setTestClient, runCreatorAttributionTick } from "../lib/creatorAttributionScheduler.js";

const BUDDY_USER = "33333333-3333-4333-8333-333333333333";

function fake(opts: { flagOn: boolean; slowFlag?: boolean }) {
  const reads: string[] = [];
  const writes: Array<{ table: string; payload: any }> = [];
  const from = (t: string) => {
    const s: any = {
      _f: [] as any[], _p: null as any, _single: false,
      select() { return s; }, eq(c: string, v: any) { s._f.push([c, v]); return s; }, in() { return s; },
      order() { return s; }, lte() { return s; }, limit() { return s; },
      insert(p: any) { s._p = p; writes.push({ table: t, payload: p }); return s; },
      single() { s._single = true; return s; }, maybeSingle() { s._single = true; return s; },
      range() { return s; },
      async then(res: any) {
        reads.push(t);
        if (t === "feature_flags") {
          if (opts.slowFlag) await new Promise((r) => setTimeout(r, 50));
          return res({ data: opts.flagOn ? { enabled: true } : null, error: null });
        }
        if (s._p) return res({ data: { id: "new-row", ...s._p }, error: null });
        if (t === "rent_buddy_bookings") {
          const status = s._f.find(([c]: any) => c === "status")?.[1];
          const all = [{ id: "bk-done", buddy_id: "bp-1", status: "completed" }];
          return res({ data: all.filter((b) => b.status === status), error: null });
        }
        if (t === "rent_buddy_profiles") return res({ data: [{ id: "bp-1", user_id: BUDDY_USER }], error: null });
        if (t === "creator_rule_versions") {
          return res({ data: [{ creator_type: "travel_partner", rule_version: "creator-rules/travel-partner/v1", params: {}, effective_from: "2026-01-01T00:00:00Z" }], error: null });
        }
        return res({ data: [], error: null });
      },
    };
    return s;
  };
  return { client: { from }, reads, writes };
}

afterEach(() => _setTestClient(null));

describe("SC — the attribution scheduler's tick", () => {
  it("SC1. flag off: one flag read, no other read, no write, `disabled`", async () => {
    const f = fake({ flagOn: false });
    _setTestClient(f.client);
    const t = await runCreatorAttributionTick();
    assert.equal(t.status, "ran");
    if (t.status === "ran") assert.deepEqual([t.outcome.ok, !t.outcome.ok && t.outcome.reason], [false, "disabled"]);
    assert.deepEqual(f.reads, ["feature_flags"]);
    assert.deepEqual(f.writes, []);
  });

  it("SC2. flag on: completed bookings are attributed to the buddy's profile, weight 1, no money on the row", async () => {
    const f = fake({ flagOn: true });
    _setTestClient(f.client);
    const t = await runCreatorAttributionTick();
    assert.equal(t.status === "ran" && t.outcome.ok, true, JSON.stringify(t));
    const rows = f.writes.filter((w) => w.table === "creator_attributions").map((w) => w.payload);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].creator_type, rows[0].subject_kind, rows[0].subject_id, rows[0].value_event_id, rows[0].beneficiary_user_id,
       rows[0].weight, rows[0].gross_revenue_minor, rows[0].provisional_share_minor, rows[0].settled_minor],
      ["travel_partner", "booking", "bk-done", "bk-done", BUDDY_USER, 1, 0, 0, 0],
    );
  });

  it("SC3. an overlapping tick is skipped, so a pass never runs twice at once", async () => {
    const f = fake({ flagOn: false, slowFlag: true });
    _setTestClient(f.client);
    const [a, b] = await Promise.all([runCreatorAttributionTick(), runCreatorAttributionTick()]);
    assert.deepEqual([a.status, b.status].sort(), ["ran", "skipped"]);
  });
});
