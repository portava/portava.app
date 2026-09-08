/**
 * A serious trust finding must reach the admin queue — and must reach it ONCE.
 *
 * ── THE DURABILITY GAP ───────────────────────────────────────────────────────
 * `recordTrustEvent` writes a serious/severe event with status='pending_review',
 * then inserts a `trust_reviews` row so an admin can adjudicate it. That second
 * insert is deliberately NON-FATAL — the event is the evidence and is already
 * committed, so a failed queue insert should delay adjudication rather than lose
 * it.
 *
 * Non-fatal with no retry is AT-MOST-ONCE. The event then sits in
 * `pending_review`, which is excluded from the score by design (`loadEvents`
 * counts only applied/confirmed) AND absent from the queue an admin can list. An
 * unattended serious finding — an impossible-speed GPS trace, a host no-show — is
 * invisible in both directions at once, and the only trace is a log line from
 * whenever it happened.
 *
 * ── AT-LEAST-ONCE MUST NOT BECOME MORE-THAN-ONCE ─────────────────────────────
 * The repair sweep re-queues those events, which makes delivery at-least-once.
 * On its own that is a NEW defect: the same finding queued twice, adjudicated
 * twice, and closed by TrustAdminService.confirmEvent / dismissEvent — which
 * close `trust_reviews WHERE source_event_id = :id` and so already assume at most
 * one row.
 *
 * Migration 2650 is what closes it: a partial unique index on
 * `trust_reviews (source_event_id) WHERE source_event_id IS NOT NULL`, applied to
 * production 2026-09-08 and proved there by a rolled-back functional smoke test
 * (a second review for one event was REFUSED; source-less reviews still coexist).
 * A re-queue of an already-queued event is refused with 23505, which both the
 * emitter and the sweep read as "already delivered".
 *
 * Retry + a uniqueness backstop = exactly-once EFFECT. This file pins both
 * halves, because either alone is wrong.
 *
 * ── AND "COULD NOT LOOK" IS NOT "NOTHING THERE" ──────────────────────────────
 * The stuck count is `null` when the scan could not run. Reporting that as 0
 * would be the same substitution the rest of this subsystem exists to refuse.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustReviewDeliveryDurability.test.ts
 */
process.env["TRUST_MAINTENANCE_MAX_USERS"] = "50";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { runTrustMaintenance, MAX_REVIEW_REPAIRS_PER_PASS } = await import("../lib/trustMaintenanceScheduler.js");

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const USER = "user-serious-finding";

type Store = Record<string, any[]>;

/**
 * Store-backed fake. `uniqueSourceEvent` models migration 2650: a second
 * trust_reviews row naming an event that already has one resolves with 23505,
 * exactly as PostgREST reports the index refusing the write.
 */
function makeClient(
  tables: Store,
  opts: { failTables?: ReadonlySet<string>; uniqueSourceEvent?: boolean; failWrites?: ReadonlySet<string> } = {},
) {
  const failTables = opts.failTables ?? new Set<string>();
  const failWrites = opts.failWrites ?? new Set<string>();
  const unique = opts.uniqueSourceEvent !== false;
  let seq = 1;

  function from(table: string) {
    const store = (tables[table] ??= []);
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let limitN: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    let insertConflict: any = null;

    const fail = () =>
      Promise.resolve({ data: null, error: { message: `${table} unavailable`, code: "57014" }, count: null });

    const builder: any = {
      select() { return builder; },
      insert(row: any) {
        if (failWrites.has(table)) {
          insertConflict = { message: `${table} write failed`, code: "57P01" };
          return builder;
        }
        if (unique && table === "trust_reviews" && row?.source_event_id != null &&
            store.some((r) => r.source_event_id === row.source_event_id)) {
          insertConflict = {
            message: 'duplicate key value violates unique constraint "trust_reviews_source_event_unique"',
            code: "23505",
          };
          return builder;
        }
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); pendingInsert = r; return builder;
      },
      upsert(row: any, o?: any) {
        const key = o?.onConflict ?? "user_id";
        const i = store.findIndex((r) => r[key] === row[key]);
        if (i >= 0) { store[i] = { ...store[i], ...row }; pendingInsert = store[i]; }
        else { const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row }; store.push(r); pendingInsert = r; }
        return builder;
      },
      update(patch: any) { pendingUpdate = patch; return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return builder; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
      gt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] > v); return builder; },
      lt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] < v); return builder; },
      or() { return builder; },
      order(c: string, o?: any) { orderBy = { col: c, asc: o?.ascending !== false }; return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return failTables.has(table) ? fail() : one(); },
      single() { return failTables.has(table) ? fail() : one(); },
      then(f: any, r: any) { return settle().then(f, r); },
    };

    function settle() {
      if (insertConflict) return Promise.resolve({ data: null, error: insertConflict, count: null });
      if (failTables.has(table) && !pendingInsert && !pendingUpdate) return fail();
      return list();
    }
    function matched() {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function one() {
      if (pendingInsert && !pendingUpdate) return { data: pendingInsert, error: null };
      const rows = matched();
      if (pendingUpdate) rows.forEach((r) => Object.assign(r, pendingUpdate));
      return { data: rows[0] ?? null, error: null };
    }
    async function list() {
      if (pendingInsert && !pendingUpdate) return { data: [pendingInsert], error: null, count: 1 };
      const rows = matched();
      if (pendingUpdate) rows.forEach((r) => Object.assign(r, pendingUpdate));
      return { data: rows, error: null, count: rows.length };
    }
    return builder;
  }
  return { from } as any;
}

const SETTINGS_ROW = {
  id: 1,
  weight_plan_attendance: 0.18, weight_host_quality: 0.12, weight_communication: 0.10,
  weight_respect_safety: 0.15, weight_location_honesty: 0.13, weight_content_quality: 0.08,
  weight_community_value: 0.08, weight_guide_accuracy: 0.08, weight_passport_auth: 0.08,
  decay_half_life_days: 90,
  level_building_trust: 35, level_reliable: 50, level_trusted: 65,
  level_highly_trusted: 78, level_city_trusted: 90,
  gaming_checkin_cluster_limit: 5, gaming_mutual_rate_threshold: 0.8, gaming_rapid_jump_points: 100_000,
};

function tables(extra: Partial<Store> = {}): Store {
  return {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: false },
    ],
    trust_settings: [{ ...SETTINGS_ROW }],
    trust_events: [],
    trust_caps: [],
    trust_profiles: [],
    trust_reviews: [],
    trust_restrictions: [],
    ...extra,
  } as Store;
}

const seriousEvent = (id: string, overrides: Record<string, any> = {}) => ({
  id, user_id: USER, event_type: "host_no_show", category: "host_quality",
  delta: -8, severity: "serious", status: "pending_review",
  source_type: "system", created_at: daysAgo(3), ...overrides,
});

describe("a pending_review event whose queue row was lost", () => {
  it("re-queues it, and reports the repair", async () => {
    const t = tables();
    t["trust_events"].push(seriousEvent("evt-lost"));

    const r = await runTrustMaintenance(makeClient(t));
    assert.equal(r.ok, true);
    assert.equal(r.reviewsRepaired, 1, "the lost review must be re-queued");
    assert.equal(r.reviewsStuck, 0);

    const rows = t["trust_reviews"];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_event_id, "evt-lost");
    assert.equal(rows[0].review_type, "event_review");
    assert.equal(rows[0].status, "open");
    assert.equal(rows[0].metadata.requeued_by, "trust_maintenance_repair");
  });

  it("does NOT even ATTEMPT a re-queue for an event already on the queue", async () => {
    // The control that stops the repair from being a queue-flooder.
    //
    // Asserting only "there is still one review row" would be VACUOUS: with the
    // already-queued check deleted, migration 2650's unique index refuses the
    // duplicate anyway, the sweep reads that 23505 as delivery, and the row count
    // is still 1. That mutation was run and the case passed — so the case has to
    // measure the thing the check actually buys, which is that no write is
    // ATTEMPTED. At 200 pending events per pass, an index doing the deduplicating
    // is 200 refused writes a minute, for ever.
    const t = tables();
    t["trust_events"].push(seriousEvent("evt-queued"));
    t["trust_reviews"].push({ id: "rev-1", user_id: USER, review_type: "event_review", source_event_id: "evt-queued", status: "open" });

    const client = makeClient(t);
    let insertAttempts = 0;
    const origFrom = client.from;
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table !== "trust_reviews") return b;
      const insert = b.insert.bind(b);
      b.insert = (row: any) => { insertAttempts += 1; return insert(row); };
      return b;
    };

    const r = await runTrustMaintenance(client);
    assert.equal(r.reviewsRepaired, 0);
    assert.equal(r.reviewsStuck, 0);
    assert.equal(insertAttempts, 0, "the sweep must read the queue first, not write and let the index refuse");
    assert.equal(t["trust_reviews"].length, 1, "an already-queued event must not gain a second review");
  });

  it("running the pass TWICE produces exactly one review (at-least-once, once in effect)", async () => {
    const t = tables();
    t["trust_events"].push(seriousEvent("evt-twice"));

    const c = makeClient(t);
    const first = await runTrustMaintenance(c);
    const second = await runTrustMaintenance(c);

    assert.equal(first.reviewsRepaired, 1);
    assert.equal(second.reviewsRepaired, 0, "the second pass must find it already delivered");
    assert.equal(t["trust_reviews"].length, 1, "retry must not produce a more-than-once EFFECT");
  });

  it("treats migration 2650's 23505 as delivery, not as a stuck event", async () => {
    // The race the index exists for: another emitter queues the event between
    // this pass's read and its write. The unique index refuses the second write,
    // and that refusal is DELIVERY — counting it as stuck would send an operator
    // hunting for a review that is sitting in front of them.
    const t = tables();
    t["trust_events"].push(seriousEvent("evt-race"));
    const client = makeClient(t);

    // Make the read see an empty queue, then let the row appear before the write.
    const origFrom = client.from;
    let armed = false;
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table !== "trust_reviews") return b;
      const insert = b.insert.bind(b);
      b.insert = (row: any) => {
        if (!armed && row?.source_event_id === "evt-race") {
          armed = true;
          t["trust_reviews"].push({ id: "rev-race", user_id: USER, review_type: "event_review", source_event_id: "evt-race", status: "open" });
        }
        return insert(row);
      };
      return b;
    };

    const r = await runTrustMaintenance(client);
    assert.equal(r.reviewsStuck, 0, "a 23505 from the unique index is delivery, not a stuck event");
    assert.equal(r.reviewsRepaired, 0);
    assert.equal(t["trust_reviews"].length, 1);
  });

  it("reports a re-queue that genuinely FAILED as stuck", async () => {
    // Anything the sweep could not deliver has to stay visible, or the repair
    // becomes a way of quietly declaring the queue clean.
    const t = tables();
    t["trust_events"].push(seriousEvent("evt-stuck"));

    const r = await runTrustMaintenance(makeClient(t, { failWrites: new Set(["trust_reviews"]) }));
    assert.equal(r.reviewsRepaired, 0);
    assert.equal(r.reviewsStuck, 1, "an undeliverable finding must be counted, not swallowed");
    assert.equal(t["trust_reviews"].length, 0);
  });

  it("reports the stuck count as NULL — not 0 — when it could not look", async () => {
    // "We could not look" reported as "there is nothing there" is the exact
    // substitution this subsystem exists to refuse.
    const t = tables();
    t["trust_events"].push(seriousEvent("evt-unknown"));

    const r = await runTrustMaintenance(makeClient(t, { failTables: new Set(["trust_reviews"]) }));
    assert.equal(r.reviewsStuck, null, "an unreadable queue means UNKNOWN, never zero");
    assert.equal(r.reviewsRepaired, 0);
    assert.equal(t["trust_reviews"].length, 0, "and nothing may be written on an unread queue");
  });

  it("says so when the scan hit its per-pass cap — a bounded look is not a clean queue", async () => {
    // "We could not look" can hide inside a BOUND as easily as inside an error.
    // The scan reads at most MAX_REVIEW_REPAIRS_PER_PASS pending events; a
    // larger backlog is examined one page at a time, and reporting
    // `reviewsStuck: 0` for that page reads as "nothing is stuck" while the
    // rest sit unadjudicated and unmentioned. `truncated` on the result is
    // about DIRTY USERS and says nothing about this scan.
    const t = tables();
    const backlog = MAX_REVIEW_REPAIRS_PER_PASS + 25;
    for (let i = 0; i < backlog; i++) t["trust_events"]!.push(seriousEvent(`evt-bulk-${i}`));

    const r = await runTrustMaintenance(makeClient(t));
    assert.equal(
      r.reviewsScanTruncated, true,
      "a saturated scan must declare itself; its stuck count is a floor, not a total",
    );
    assert.equal(
      t["trust_reviews"]!.length, MAX_REVIEW_REPAIRS_PER_PASS,
      "exactly one page was repaired, so the remainder really was left unexamined",
    );
    assert.equal(r.reviewsRepaired, MAX_REVIEW_REPAIRS_PER_PASS);
    assert.ok(backlog > MAX_REVIEW_REPAIRS_PER_PASS, "the fixture must exceed the cap or this proves nothing");
  });

  it("does NOT claim truncation for a backlog that fits inside one pass", async () => {
    // The control: the flag must mean something. A queue the pass saw in full
    // reports a stuck count that IS a total.
    const t = tables();
    for (let i = 0; i < 3; i++) t["trust_events"]!.push(seriousEvent(`evt-small-${i}`));

    const r = await runTrustMaintenance(makeClient(t));
    assert.equal(r.reviewsScanTruncated, false);
    assert.equal(r.reviewsRepaired, 3);
    assert.equal(r.reviewsStuck, 0);
  });

  it("leaves an applied (non-serious) event alone", async () => {
    // Only pending_review events belong on the review queue; scoring events must
    // not be dragged onto an admin's desk.
    const t = tables();
    t["trust_events"].push(seriousEvent("evt-applied", { severity: "positive", status: "applied", delta: 5 }));

    const r = await runTrustMaintenance(makeClient(t));
    assert.equal(r.reviewsRepaired, 0);
    assert.equal(t["trust_reviews"].length, 0);
  });
});
