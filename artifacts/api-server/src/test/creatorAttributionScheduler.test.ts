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
 *   SC4  an ERASED buddy (tombstone profile, account_status 'deleted') is never
 *        attributed: the booking is counted as erasedBeneficiary and nothing is
 *        written, while a live buddy's booking in the same pass still is
 *        (C-11 answer B, 3600 (4b) — review of PR #592)
 *   SC5  the beneficiaries' account state is read fail-closed: an error, or no
 *        rows and no error, stops the pass with nothing written; a profile row
 *        that is missing is counted noBeneficiary, never attributed
 *
 * Run: node --import tsx/esm --test src/test/creatorAttributionScheduler.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setTestClient, runCreatorAttributionTick } from "../lib/creatorAttributionScheduler.js";

const BUDDY_USER = "33333333-3333-4333-8333-333333333333";

type ProfilesAnswer = { data: any; error: any };
const ACTIVE: ProfilesAnswer = { data: [{ id: BUDDY_USER, account_status: "active" }], error: null };

function fake(opts: { flagOn: boolean; slowFlag?: boolean; bookings?: any[]; buddies?: any[]; profiles?: ProfilesAnswer }) {
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
          const all = opts.bookings ?? [{ id: "bk-done", buddy_id: "bp-1", status: "completed" }];
          return res({ data: all.filter((b) => b.status === status), error: null });
        }
        if (t === "rent_buddy_profiles") return res({ data: opts.buddies ?? [{ id: "bp-1", user_id: BUDDY_USER }], error: null });
        if (t === "profiles") return res(opts.profiles ?? ACTIVE);
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

  it("SC4. an ERASED buddy is never attributed: counted erasedBeneficiary, nothing written; a live buddy in the same pass still is", async () => {
    const ERASED_USER = "44444444-4444-4444-8444-444444444444";
    const f = fake({
      flagOn: true,
      bookings: [
        { id: "bk-erased", buddy_id: "bp-erased", status: "completed" },
        { id: "bk-live", buddy_id: "bp-1", status: "completed" },
      ],
      buddies: [{ id: "bp-erased", user_id: ERASED_USER }, { id: "bp-1", user_id: BUDDY_USER }],
      profiles: { data: [{ id: ERASED_USER, account_status: "deleted" }, { id: BUDDY_USER, account_status: "active" }], error: null },
    });
    _setTestClient(f.client);
    const t = await runCreatorAttributionTick();
    assert.equal(t.status === "ran" && t.outcome.ok, true, JSON.stringify(t));
    if (t.status !== "ran" || !t.outcome.ok) return;
    assert.equal(t.outcome.value.erasedBeneficiary, 1, "the erased buddy's booking is named, not silently dropped");
    assert.equal(t.outcome.value.attributed, 1, "the live buddy's booking is still attributed");
    const rows = f.writes.filter((w) => w.table === "creator_attributions").map((w) => w.payload);
    assert.deepEqual(rows.map((r) => r.subject_id), ["bk-live"]);
    assert.ok(!JSON.stringify(f.writes).includes(ERASED_USER), "the erased id is written nowhere");
  });

  it("SC5. the account-state read is fail-closed: an error or an unanswered read stops the pass, a missing row is never attributed", async () => {
    for (const [profiles, says] of [
      [{ data: null, error: { code: "42501", message: "permission denied for table profiles" } }, /permission denied for table profiles/],
      [{ data: null, error: null }, /no rows and no error/],
    ] as const) {
      const f = fake({ flagOn: true, profiles });
      _setTestClient(f.client);
      const t = await runCreatorAttributionTick();
      assert.equal(t.status, "ran");
      if (t.status === "ran") {
        assert.deepEqual([t.outcome.ok, !t.outcome.ok && t.outcome.reason], [false, "db_error"], JSON.stringify(profiles));
        assert.match((!t.outcome.ok && t.outcome.detail) || "", says, "the refusal says which read failed and how");
      }
      assert.deepEqual(f.writes, [], `nothing is written when the account state is unreadable: ${JSON.stringify(profiles)}`);
      _setTestClient(null);
    }
    const missing = fake({ flagOn: true, profiles: { data: [], error: null } });
    _setTestClient(missing.client);
    const t = await runCreatorAttributionTick();
    assert.equal(t.status === "ran" && t.outcome.ok, true);
    if (t.status === "ran" && t.outcome.ok) {
      assert.equal(t.outcome.value.noBeneficiary, 1, "no readable account state is counted, not assumed active");
      assert.equal(t.outcome.value.attributed, 0);
    }
    assert.deepEqual(missing.writes, []);
  });

  it("SC3. an overlapping tick is skipped, so a pass never runs twice at once", async () => {
    const f = fake({ flagOn: false, slowFlag: true });
    _setTestClient(f.client);
    const [a, b] = await Promise.all([runCreatorAttributionTick(), runCreatorAttributionTick()]);
    assert.deepEqual([a.status, b.status].sort(), ["ran", "skipped"]);
  });
});
