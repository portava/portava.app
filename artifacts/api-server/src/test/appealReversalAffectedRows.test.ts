/**
 * Appeal reversals — every case must READ the affected-row count
 * (services/appeals/resolveAppeal.ts)
 *
 * THE CLASS
 * =========
 * Every reversal in resolveAppeal is an UPDATE scoped by TWO filters: the
 * target id and an ownership column (`author_id`, `owner_id`, `user_id`,
 * `host_id`, `reviewer_id`). The second filter is AUTHORIZATION expressed as a
 * WHERE clause — and a WHERE clause that excludes every row is not an error in
 * PostgREST. supabase-js resolves it as `{ data: null, error: null }`, the same
 * shape a successful update returns. Reading only `error` therefore cannot tell
 *
 *     "the appellant's post was un-deleted"
 * from
 *     "that post belongs to somebody else, or no longer exists"
 *
 * and the function answered `{ ok: true, action: "post_restored" }` for both.
 * The appeal then reached the terminal 'approved' state and the appellant was
 * notified that the moderation had been reversed. Nothing had been.
 *
 * `.select()` makes each statement RETURNING, so `data` is the rows it actually
 * touched, and every case now checks it. Two cases are special because removal
 * DELETES the row rather than flagging it, so no UPDATE can ever restore it:
 * `event_membership` (event_rsvps) and `trip_membership` (trip_members) report
 * `restore_requires_policy` with `restored: false` instead of inventing an
 * INSERT — see appealTripMembershipRestore.test.ts for the trip half.
 *
 * THE FAKE
 * ========
 * Rows are real and filters are really applied, so an UPDATE resolves to the
 * rows it MATCHED — an empty array when it matched none. A fake that echoed the
 * update payload back as `data`, or that only ever produced `error: null`,
 * could not express the failure under test and every assertion here would pass
 * against the unfixed code.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/appealReversalAffectedRows.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAppeal, isDeferred } from "../services/appeals/resolveAppeal.js";

const OWNER = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER = "bbbbbbbb-0000-0000-0000-000000000002";
const TARGET = "dddddddd-0000-0000-0000-000000000004";
const APPEAL = "99999999-0000-0000-0000-000000000009";

type Row = Record<string, any>;
interface Spec { tables: Record<string, Row[]>; writes: Array<{ table: string; verb: string; matched: number }> }

function makeClient(tables: Record<string, Row[]>): Spec & { client: any } {
  const spec: Spec = { tables, writes: [] };
  const src = (t: string) => (spec.tables[t] ??= []);

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let returning = false;
    let single = false;
    const b: any = {
      select() { returning = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };
    const match = () => src(table).filter((r) => preds.every((p) => p(r)));
    async function run(): Promise<{ data: any; error: any }> {
      if (verb === "select") { const m = match(); return { data: single ? (m[0] ?? null) : m, error: null }; }
      if (verb === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        src(table).push(...rows);
        spec.writes.push({ table, verb, matched: rows.length });
        return { data: single ? rows[0] : rows, error: null };
      }
      const m = match();
      if (verb === "update") for (const r of m) Object.assign(r, payload);
      else spec.tables[table] = src(table).filter((r) => !m.includes(r));
      spec.writes.push({ table, verb, matched: m.length });
      // RETURNING only when `.select()` was chained.
      return { data: returning ? (single ? (m[0] ?? null) : m) : null, error: null };
    }
    return b;
  }

  return { ...spec, tables: spec.tables, writes: spec.writes, client: { from, rpc: async () => ({ data: null, error: null }) } };
}

function appealOf(targetType: string, appellant = OWNER) {
  return { id: APPEAL, appellant_id: appellant, target_type: targetType, target_id: TARGET, resolution_note: null };
}

/**
 * Every content-restoration case: the row exists but belongs to somebody else,
 * so the ownership filter matches nothing and NOTHING is reversed.
 */
const CONTENT_CASES: Array<{
  targetType: string; table: string; ownerCol: string; row: Row; restoredAction: string; assertRestored: (r: Row) => void;
}> = [
  {
    targetType: "post", table: "posts", ownerCol: "author_id",
    row: { id: TARGET, deleted_at: "2026-01-01T00:00:00Z" },
    restoredAction: "post_restored",
    assertRestored: (r) => assert.equal(r.deleted_at, null),
  },
  {
    targetType: "memory", table: "memories", ownerCol: "owner_id",
    row: { id: TARGET, state: "removed" },
    restoredAction: "memory_restored",
    assertRestored: (r) => assert.equal(r.state, "published"),
  },
  {
    targetType: "highlight", table: "highlights", ownerCol: "owner_id",
    row: { id: TARGET, deleted_at: "2026-01-01T00:00:00Z" },
    restoredAction: "highlight_restored",
    assertRestored: (r) => assert.equal(r.deleted_at, null),
  },
  {
    targetType: "event", table: "events", ownerCol: "host_id",
    row: { id: TARGET, state: "removed" },
    restoredAction: "event_restored",
    assertRestored: (r) => assert.equal(r.state, "open"),
  },
  {
    targetType: "review", table: "reviews", ownerCol: "reviewer_id",
    row: { id: TARGET, state: "removed" },
    restoredAction: "review_restored",
    assertRestored: (r) => assert.equal(r.state, "published"),
  },
];

describe("resolveAppeal — the ownership filter must not fail silently", () => {
  for (const c of CONTENT_CASES) {
    it(`${c.targetType}: a target owned by someone else is a noop, never ${c.restoredAction}`, async () => {
      const s = makeClient({ [c.table]: [{ ...c.row, [c.ownerCol]: OTHER }] });
      const r = await resolveAppeal(s.client, appealOf(c.targetType));

      assert.equal(r.ok, false, `${c.targetType}: nothing was reversed, so the appeal must not approve`);
      assert.equal(r.action, "noop");
      assert.notEqual(r.action, c.restoredAction);
      assert.match(String((r as any).reason), /matched no row/);
      // The other user's row is untouched.
      assert.deepEqual(s.tables[c.table][0], { ...c.row, [c.ownerCol]: OTHER });
    });

    it(`${c.targetType}: a missing target is a noop, never ${c.restoredAction}`, async () => {
      const s = makeClient({ [c.table]: [] });
      const r = await resolveAppeal(s.client, appealOf(c.targetType));
      assert.equal(r.ok, false);
      assert.equal(r.action, "noop");
    });

    it(`${c.targetType}: the appellant's own target really is restored`, async () => {
      const s = makeClient({ [c.table]: [{ ...c.row, [c.ownerCol]: OWNER }] });
      const r = await resolveAppeal(s.client, appealOf(c.targetType));
      assert.equal(r.ok, true, `expected a restore; got ${JSON.stringify(r)}`);
      assert.equal(r.action, c.restoredAction);
      c.assertRestored(s.tables[c.table][0]);
    });
  }
});

describe("resolveAppeal trust_score_event — a dismissal that matched nothing must not pay out", () => {
  it("someone else's trust event: noop, and NO compensating +2 is recorded", async () => {
    const s = makeClient({ trust_events: [{ id: TARGET, user_id: OTHER, status: "active" }] });
    const r = await resolveAppeal(s.client, appealOf("trust_score_event"));

    assert.equal(r.ok, false);
    assert.equal(r.action, "noop");
    assert.notEqual(r.action, "trust_event_dismissed");
    assert.equal(s.tables.trust_events[0].status, "active", "the other user's event must stay active");
    // recordTrustEvent inserts into trust_events; a reversal that reversed
    // nothing must not hand the appellant a positive trust delta.
    assert.equal(
      s.writes.filter((w) => w.verb === "insert").length,
      0,
      "no counter-event may be awarded for an offence that was never dismissed",
    );
  });

  it("the appellant's own trust event is dismissed", async () => {
    const s = makeClient({ trust_events: [{ id: TARGET, user_id: OWNER, status: "active" }] });
    const r = await resolveAppeal(s.client, appealOf("trust_score_event"));
    assert.equal(r.ok, true);
    assert.equal(r.action, "trust_event_dismissed");
    assert.equal(s.tables.trust_events[0].status, "dismissed");
  });
});

describe("resolveAppeal no_show — nothing to clear is not a clear", () => {
  it("no attendee-state row: noop, never no_show_cleared", async () => {
    const s = makeClient({ event_attendee_states: [] });
    const r = await resolveAppeal(s.client, appealOf("no_show"));
    assert.equal(r.ok, false);
    assert.equal(r.action, "noop");
    assert.notEqual(r.action, "no_show_cleared");
  });

  it("an existing no-show is cleared", async () => {
    const s = makeClient({
      event_attendee_states: [{ event_id: TARGET, user_id: OWNER, no_show_at: "2026-01-01T00:00:00Z", no_show_by: OTHER }],
    });
    const r = await resolveAppeal(s.client, appealOf("no_show"));
    assert.equal(r.ok, true);
    assert.equal(r.action, "no_show_cleared");
    assert.equal(s.tables.event_attendee_states[0].no_show_at, null);
  });
});

describe("resolveAppeal event_membership — the RSVP row is DELETED on removal", () => {
  it("no RSVP row: restore_requires_policy, restored:false, and no RSVP is conjured", async () => {
    const s = makeClient({ event_rsvps: [] });
    const r = await resolveAppeal(s.client, appealOf("event_membership"));

    assert.equal(r.ok, true, "the appeal is upheld; the restoration is what could not be done");
    assert.equal(r.action, "restore_requires_policy");
    assert.ok(isDeferred(r));
    assert.equal((r as any).restored, false);
    assert.notEqual(r.action, "event_membership_restored");
    assert.match(String((r as any).reason), /capacity and waitlist/);
    const ev = (r as any).evidence;
    assert.equal(ev.appealId, APPEAL);
    assert.equal(ev.targetId, TARGET);
    assert.equal(ev.userId, OWNER);
    assert.equal(s.tables.event_rsvps.length, 0, "no RSVP may be inserted on a guess");
    assert.equal(s.writes.filter((w) => w.verb === "insert").length, 0);
  });

  it("an RSVP that is merely flagged is genuinely restored to attending", async () => {
    const s = makeClient({ event_rsvps: [{ event_id: TARGET, user_id: OWNER, status: "removed" }] });
    const r = await resolveAppeal(s.client, appealOf("event_membership"));
    assert.equal(r.ok, true);
    assert.equal(r.action, "event_membership_restored");
    assert.equal(isDeferred(r), false);
    assert.equal(s.tables.event_rsvps[0].status, "attending");
  });
});

describe("resolveAppeal trip (kernel flag OFF) — the legacy twin must refuse a non-owner too", () => {
  it("a trip owned by someone else is a noop, never trip_restored", async () => {
    const s = makeClient({ trips: [{ id: TARGET, owner_id: OTHER, status: "cancelled" }], feature_flags: [] });
    const r = await resolveAppeal(s.client, appealOf("trip"));

    assert.equal(r.ok, false, "the kernel path answers TRIP_AUTH_NOT_OWNER; the legacy path must not answer success");
    assert.equal(r.action, "noop");
    assert.notEqual(r.action, "trip_restored");
    assert.equal(s.tables.trips[0].status, "cancelled");
  });
});

describe("resolveAppeal — untouched contracts", () => {
  it("account_warning is an acknowledgement, not a mutation", async () => {
    const s = makeClient({});
    const r = await resolveAppeal(s.client, appealOf("account_warning"));
    assert.equal(r.ok, true);
    assert.equal(r.action, "account_warning_acknowledged");
    assert.deepEqual(s.writes, [], "an acknowledgement writes nothing");
  });

  it("an unknown target_type is still a noop and still never throws", async () => {
    const s = makeClient({});
    const r = await resolveAppeal(s.client, appealOf("something_new"));
    assert.equal(r.ok, false);
    assert.equal(r.action, "noop");
    assert.match(String((r as any).reason), /unknown target_type/);
  });
});
