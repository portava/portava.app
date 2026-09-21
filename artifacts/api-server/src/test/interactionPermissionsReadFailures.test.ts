/**
 * interactionPermissions — a FAILED read is not an ANSWER.
 *
 * `resolveInteractionPermissions` is the permission engine 15+ routes call. Its
 * reads all resolve through `Promise.allSettled` into `{ data, error }`, and
 * supabase-js RESOLVES on a database error — so for every one of them
 * `data: null` meant EITHER "no such row" OR "the read failed", and nothing
 * downstream could tell the two apart. Three defect shapes were live:
 *
 *   user_restrictions   `.error` WAS bound and read, and then thrown away into
 *                       `? false` — "this viewer is not restricted", said about
 *                       a table that could not be read. Fail-OPEN.
 *   relationship reads  `Boolean(res.data)` with `.error` never read at all, on
 *                       user_friendships / friend_requests / user_follows.
 *   context queries     `const { data: vTrips } = await …` (data-only) wrapped
 *                       in `.catch(() => false)`, which is DEAD CODE for a
 *                       database error and answered `false` silently anyway.
 *
 * THE PAIRING THAT MAKES THIS FILE MEAN SOMETHING
 * -----------------------------------------------
 * A viewer who genuinely has no restriction and a `user_restrictions` table
 * that cannot be READ used to produce the identical verdict, so a test written
 * only against the failure case passes for the wrong reason. Every failure case
 * below is therefore paired with the readable case it must be distinguishable
 * from — the row PRESENT and readable, and the row ABSENT and readable — run on
 * the same fixture, differing only in whether the read succeeds.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest). The verdict is the exit
 * code. Calls the service directly: there is no route, no req.log shim, and so
 * no way for a crash-500 to masquerade as a fail-closed answer.
 *
 * Run: node --import tsx/esm --test src/test/interactionPermissionsReadFailures.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveInteractionPermissions } from "../services/interactionPermissions.js";

const VIEWER = "aaaaaaaa-0000-0000-0000-0000000000a1";
const TARGET = "bbbbbbbb-0000-0000-0000-0000000000b2";
const TRIP_A = "f0f0f0f0-0000-0000-0000-0000000000f1";

/** A real PostgREST-shaped failure. NOT 42P01 — that means "table not migrated". */
const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };
/** The Phase 2 "table does not exist yet" error, which is a real answer. */
const TABLE_MISSING = { code: "42P01", message: 'relation "x" does not exist' };

type Rows = Record<string, any[]>;
type Errors = Record<string, { code: string; message: string }>;

/**
 * Minimal PostgREST double.
 *
 * Deliberately NOT a `{ error: null }`-only stub: the whole subject of this file
 * is the error channel, so `errors[table]` injects a resolved (never thrown)
 * failure exactly the way supabase-js delivers one. `.or()` is really parsed so
 * the fixtures are matched by the same keys the engine computes, rather than
 * being waved through by a no-op filter.
 */
function makeClient(rows: Rows = {}, errors: Errors = {}) {
  const db: Rows = {
    profiles: [], blocks: [], trust_restrictions: [], moderation_actions: [],
    user_account_states: [], user_privacy_settings: [], profile_privacy_settings: [],
    user_friendships: [], friend_requests: [], user_follows: [],
    user_message_settings: [], user_interaction_cooldowns: [], user_mutes: [],
    user_restrictions: [], trip_members: [], circle_memberships: [],
    rent_buddy_bookings: [],
    ...rows,
  };

  function splitTopLevel(s: string): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      else if (s[i] === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out;
  }

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limit: number | null = null;

    const err = errors[table] ?? null;
    const fail = () => ({ data: null, error: err });

    const matched = (): any[] => {
      let src = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (limit !== null) src = src.slice(0, limit);
      return src;
    };

    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not() { return b; },
      gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      order() { return b; }, range() { return b; }, ilike() { return b; },
      limit(n: number) { limit = n; return b; },
      or(expr: string) {
        const ms: Array<(r: any) => boolean> = [];
        for (const clause of splitTopLevel(expr)) {
          const and = clause.match(/^and\((.+)\)$/s);
          const terms = and ? and[1].split(",") : [clause];
          const subs = terms.map((t) => {
            const m = t.match(/^(\w+)\.(eq|neq)\.(.+)$/);
            if (!m) return null;
            const [, col, op, val] = m;
            return (r: any) => (op === "eq" ? String(r[col]) === val : String(r[col]) !== val);
          });
          // A clause this double cannot express (`expires_at.is.null`, `.gt.`)
          // must not silently become "matches nothing" — skip it entirely.
          if (subs.some((s) => s === null)) continue;
          ms.push((r: any) => subs.every((s) => s!(r)));
        }
        if (ms.length > 0) filters.push((r: any) => ms.some((f) => f(r)));
        return b;
      },
      async maybeSingle() { return err ? fail() : { data: matched()[0] ?? null, error: null }; },
      async single() {
        if (err) return fail();
        const m = matched();
        return m.length ? { data: m[0], error: null } : { data: null, error: { message: "not found" } };
      },
      then(onF: any, onR: any) {
        return Promise.resolve(err ? fail() : { data: matched(), error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return { from } as any;
}

/** Baseline: both profiles exist, nothing else. Every case starts from this. */
function baseRows(extra: Rows = {}): Rows {
  return {
    profiles: [
      { id: VIEWER, is_private: false, tag_permission: "everyone" },
      { id: TARGET, is_private: false, tag_permission: "everyone" },
    ],
    ...extra,
  };
}

const resolve = (rows: Rows, errors: Errors = {}) =>
  resolveInteractionPermissions(makeClient(rows, errors), VIEWER, TARGET);

/** Counted so a vacuous run (zero scenarios exercised) cannot read as green. */
let scenarios = 0;
const ran = <T>(v: T): T => { scenarios++; return v; };

// ===========================================================================
// user_restrictions — the fail-open the unchecked-reads guard cannot see
// ===========================================================================

describe("user_restrictions: an unreadable restriction is not 'no restriction'", () => {
  it("UNREADABLE → assumes the viewer IS restricted, and says the verdict is degraded", async () => {
    const p = ran(await resolve(baseRows(), { user_restrictions: DB_ERROR }));
    assert.equal(p.context.readReceiptsHidden, true,
      "an unreadable user_restrictions must not report 'not restricted'");
    assert.ok(p.safetyWarnings.includes("read_receipts_hidden"));
    assert.equal(p.degraded, true, "the caller must be told this flag is a precaution, not an observation");
    assert.ok(p.degradedReads?.includes("user_restrictions"),
      `degradedReads must name the failed read; got ${JSON.stringify(p.degradedReads)}`);
  });

  it("PAIR — readable and ABSENT → not restricted, and NOT degraded", async () => {
    const p = ran(await resolve(baseRows()));
    assert.equal(p.context.readReceiptsHidden, false);
    assert.equal(p.safetyWarnings.includes("read_receipts_hidden"), false);
    assert.notEqual(p.degraded, true, "a clean read must not be reported as degraded");
  });

  it("PAIR — readable and PRESENT → restricted, and NOT degraded", async () => {
    // Without this case the failure case above passes for the same reason a
    // genuine restriction does, and proves nothing.
    const p = ran(await resolve(baseRows({
      user_restrictions: [{ restrictor_id: TARGET, restricted_id: VIEWER }],
    })));
    assert.equal(p.context.readReceiptsHidden, true);
    assert.notEqual(p.degraded, true,
      "a real restriction read cleanly is NOT degraded — this is what separates it from the outage");
  });

  it("42P01 table-missing → still 'no restriction', and NOT degraded (Phase 2 table)", async () => {
    const p = ran(await resolve(baseRows(), { user_restrictions: TABLE_MISSING }));
    assert.equal(p.context.readReceiptsHidden, false,
      "an unmigrated table genuinely means nobody has a restriction");
    assert.notEqual(p.degraded, true);
  });
});

// ===========================================================================
// Relationship reads — inclusion signals, so safe but silent
// ===========================================================================

describe("relationship reads: a failed read is named, not swallowed", () => {
  it("user_friendships UNREADABLE → label falls back to stranger AND is marked degraded", async () => {
    const p = ran(await resolve(baseRows(), { user_friendships: DB_ERROR }));
    assert.equal(p.relationshipLabel, "stranger");
    assert.equal(p.degraded, true);
    assert.ok(p.degradedReads?.includes("user_friendships"),
      `got ${JSON.stringify(p.degradedReads)}`);
  });

  it("PAIR — user_friendships readable WITH a row → friend, and NOT degraded", async () => {
    const [ua, ub] = VIEWER < TARGET ? [VIEWER, TARGET] : [TARGET, VIEWER];
    const p = ran(await resolve(baseRows({ user_friendships: [{ user_a: ua, user_b: ub }] })));
    assert.equal(p.relationshipLabel, "friend");
    assert.notEqual(p.degraded, true);
  });

  it("PAIR — user_friendships readable with NO row → stranger, and NOT degraded", async () => {
    // Same verdict as the failure case. Only `degraded` separates them, which
    // is exactly why the marker had to exist.
    const p = ran(await resolve(baseRows()));
    assert.equal(p.relationshipLabel, "stranger");
    assert.notEqual(p.degraded, true);
  });

  it("user_follows UNREADABLE → both directions named in degradedReads", async () => {
    const p = ran(await resolve(baseRows(), { user_follows: DB_ERROR }));
    assert.equal(p.degraded, true);
    assert.ok(p.degradedReads?.some((r) => r.startsWith("user_follows")),
      `got ${JSON.stringify(p.degradedReads)}`);
  });

  it("profiles UNREADABLE → reason is target_lookup_failed, NOT target_not_found", async () => {
    const p = ran(await resolve(baseRows(), { profiles: DB_ERROR }));
    assert.ok(p.reasonCodes.includes("target_lookup_failed"),
      `an unreadable profiles table must not claim the target does not exist; got ${JSON.stringify(p.reasonCodes)}`);
    assert.equal(p.reasonCodes.includes("target_not_found"), false);
    assert.equal(p.degraded, true);
  });

  it("PAIR — profiles readable, target genuinely absent → target_not_found, NOT degraded", async () => {
    const p = ran(await resolve({ profiles: [{ id: VIEWER, is_private: false, tag_permission: "everyone" }] }));
    assert.ok(p.reasonCodes.includes("target_not_found"));
    assert.equal(p.reasonCodes.includes("target_lookup_failed"), false);
    assert.notEqual(p.degraded, true);
  });
});

// ===========================================================================
// Context queries — data-only reads under a dead `.catch`
// ===========================================================================

describe("context queries: sharedTrip / sharedCircle / rabPreBooking", () => {
  it("trip_members UNREADABLE → sharedTrip stays false (direction kept) but is now DECLARED", async () => {
    const p = ran(await resolve(baseRows(), { trip_members: DB_ERROR }));
    assert.equal(p.context.sharedTrip, false,
      "a shared trip ELEVATES permission, so a failed read resolving to false is the safe direction");
    assert.equal(p.degraded, true, "…but it may no longer do so silently");
    assert.ok(p.degradedReads?.some((r) => r.startsWith("trip_members")),
      `got ${JSON.stringify(p.degradedReads)}`);
  });

  it("PAIR — trip_members readable WITH a shared trip → sharedTrip true, NOT degraded", async () => {
    const p = ran(await resolve(baseRows({
      trip_members: [
        { trip_id: TRIP_A, user_id: VIEWER, role: "owner" },
        { trip_id: TRIP_A, user_id: TARGET, role: "member" },
      ],
    })));
    assert.equal(p.context.sharedTrip, true);
    assert.notEqual(p.degraded, true);
  });

  it("PAIR — trip_members readable with NO shared trip → false, NOT degraded", async () => {
    const p = ran(await resolve(baseRows({
      trip_members: [{ trip_id: TRIP_A, user_id: VIEWER, role: "owner" }],
    })));
    assert.equal(p.context.sharedTrip, false);
    assert.notEqual(p.degraded, true);
  });

  it("circle_memberships UNREADABLE → sharedCircle false and declared", async () => {
    const p = ran(await resolve(baseRows(), { circle_memberships: DB_ERROR }));
    assert.equal(p.context.sharedCircle, false);
    assert.equal(p.degraded, true);
    assert.ok(p.degradedReads?.includes("circle_memberships"),
      `got ${JSON.stringify(p.degradedReads)}`);
  });

  it("PAIR — circle_memberships readable WITH a row → sharedCircle true, NOT degraded", async () => {
    const p = ran(await resolve(baseRows({
      circle_memberships: [{ user_id: TARGET, other_id: VIEWER }],
    })));
    assert.equal(p.context.sharedCircle, true);
    assert.notEqual(p.degraded, true);
  });

  it("rent_buddy_bookings UNREADABLE → the safety warning is RAISED, not suppressed", async () => {
    // The one direction this pass changed: `false` here is the PERMISSIVE
    // answer (no warning shown), so suppressing it on an unreadable table was
    // fail-open for a safety warning.
    const p = ran(await resolve(baseRows(), { rent_buddy_bookings: DB_ERROR }));
    assert.equal(p.context.rabPreBooking, true);
    assert.ok(p.safetyWarnings.includes("rab_off_app_payment_risk"));
    assert.equal(p.degraded, true);
    assert.ok(p.degradedReads?.includes("rent_buddy_bookings"),
      `got ${JSON.stringify(p.degradedReads)}`);
  });

  it("PAIR — rent_buddy_bookings readable with NO booking → no warning, NOT degraded", async () => {
    const p = ran(await resolve(baseRows()));
    assert.equal(p.context.rabPreBooking, false);
    assert.equal(p.safetyWarnings.includes("rab_off_app_payment_risk"), false);
    assert.notEqual(p.degraded, true);
  });
});

// ===========================================================================
// Vacuity
// ===========================================================================

describe("vacuity", () => {
  it("every scenario above actually ran a resolution", () => {
    assert.ok(scenarios >= 15, `expected >= 15 resolutions exercised, got ${scenarios}`);
  });
});
