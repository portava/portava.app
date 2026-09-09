/**
 * rabLifecycleKillSwitch — Rent-a-Buddy global controls and restriction flags
 * must FAIL CLOSED, and a fail-closed value must never be cached.
 *
 * THE DEFECT (rentABuddyRollout.ts:89 getGlobalControls, :114 getFlag)
 * ───────────────────────────────────────────────────────────────────
 * `rent_buddy_global_controls` holds Rent-a-Buddy's six platform-wide kill
 * switches. Each INVERTS the meaning of its value — `all_bookings_paused =
 * true` means STOP — so a reader that returns "all false" on a failed read does
 * not degrade safely: it DISENGAGES every switch at exactly the moment the
 * database is unhealthy. `getGlobalControls` destructured only `data`, could
 * therefore not tell "row absent" from "read failed", and then wrote that
 * all-false fallback into `_gcCache` with a 30 s TTL — so ONE failed read held
 * every Rent-a-Buddy kill switch off platform-wide for thirty seconds, long
 * after the database recovered.
 *
 * `getFlag` had the same swallow. For the capability flags (rent_buddy_enabled,
 * …_NIGHTLIFE_ENABLED, …) false-on-error is the safe answer. For the three
 * RESTRICTION flags it is the unsafe one: RENT_BUDDY_ADMIN_ONLY_MODE,
 * RENT_BUDDY_MVP_MODE and RENT_BUDDY_BETA_ONLY_MODE all LIFT when they read
 * false, so one unreadable `feature_flags` opened the whole surface to
 * everybody.
 *
 * Each test below fails on the pre-fix code (see the report's hand-revert
 * table) and passes on the fixed reader.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { checkRentBuddyAccess, invalidateGcCache } from "../routes/rentABuddyRollout.js";

const USER = "11111111-1111-4111-8111-111111111111";

interface FakeOpts {
  /** feature_flags rows, by flag name. A flag not present reads as absent. */
  flags?: Record<string, boolean>;
  /** When set, every feature_flags read fails with this message. */
  flagsError?: string | null;
  /** The rent_buddy_global_controls singleton, or null for "no row". */
  controlsRow?: Record<string, unknown> | null;
  /** When set, every rent_buddy_global_controls read fails. */
  controlsError?: string | null;
  /** rent_buddy_city_rollouts rows. */
  cityRows?: Array<{ city: string; status: string }>;
  /** profiles.role for USER. */
  role?: string;
}

/** Counts the reads each table actually received, so caching can be observed. */
interface FakeClient {
  reads: Record<string, number>;
  from(table: string): any;
}

/**
 * A minimal supabase-js-shaped fake. Every terminal (`maybeSingle`) RESOLVES —
 * including on error — because that is what supabase-js does, and reading the
 * `error` field is the entire subject of this file.
 */
function makeFake(opts: FakeOpts): FakeClient {
  const {
    flags = {}, flagsError = null,
    controlsRow = null, controlsError = null,
    cityRows = [], role = "user",
  } = opts;

  const reads: Record<string, number> = {};

  function builder(table: string): any {
    reads[table] = (reads[table] ?? 0) + 1;
    const filters: Record<string, any> = {};
    const self: any = {
      select: () => self,
      eq: (col: string, val: any) => { filters[col] = val; return self; },
      ilike: (col: string, val: any) => { filters[col] = val; return self; },
      limit: () => self,
      order: () => self,
      maybeSingle: async () => {
        if (table === "feature_flags") {
          if (flagsError) return { data: null, error: { message: flagsError } };
          const flag = filters["flag"];
          if (!(flag in flags)) return { data: null, error: null };
          return { data: { enabled: flags[flag] }, error: null };
        }
        if (table === "rent_buddy_global_controls") {
          if (controlsError) return { data: null, error: { message: controlsError } };
          return { data: controlsRow, error: null };
        }
        if (table === "rent_buddy_city_rollouts") {
          const want = String(filters["city"] ?? "").toLowerCase();
          const row = cityRows.find((r) => r.city.toLowerCase() === want) ?? null;
          return { data: row, error: null };
        }
        if (table === "profiles") return { data: { role }, error: null };
        if (table === "rent_buddy_beta_access") return { data: null, error: null };
        return { data: null, error: null };
      },
    };
    return self;
  }

  return { reads, from: builder };
}

/** All six switches OFF — a configured, fully open platform. */
const CONTROLS_ALL_OPEN = {
  id: 1,
  all_bookings_paused: false,
  applications_paused: false,
  cash_balance_paused: false,
  nightlife_paused: false,
  force_full_in_app: false,
  force_public_meetup: false,
};

const OPEN_FLAGS = { rent_buddy_enabled: true };
const OPEN_CITY = [{ city: "Cebu", status: "public_mvp" }];

describe("A: an unreadable rent_buddy_global_controls PAUSES, it does not open", () => {
  beforeEach(() => invalidateGcCache());

  it("action:book is refused with globally_paused / 503 when the controls row cannot be read", async () => {
    const fc = makeFake({
      flags: OPEN_FLAGS,
      controlsError: "connection terminated unexpectedly",
      cityRows: OPEN_CITY,
    });
    const d: any = await checkRentBuddyAccess({ sc: fc, userId: USER, city: "Cebu", category: "city", action: "book" });
    assert.equal(d.allowed, false, "an unreadable kill-switch row must not allow a booking");
    assert.equal(d.code, "globally_paused");
    assert.equal(d.httpStatus, 503);
  });

  it("action:apply is refused with applications_paused / 503", async () => {
    const fc = makeFake({ flags: OPEN_FLAGS, controlsError: "boom", cityRows: OPEN_CITY });
    const d: any = await checkRentBuddyAccess({ sc: fc, userId: USER, city: "Cebu", action: "apply" });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "applications_paused");
    assert.equal(d.httpStatus, 503);
  });

  it("nightlife is refused even with RENT_BUDDY_NIGHTLIFE_ENABLED true, because nightlife_paused engages", async () => {
    const fc = makeFake({
      flags: { rent_buddy_enabled: true, RENT_BUDDY_NIGHTLIFE_ENABLED: true },
      controlsError: "boom",
      cityRows: OPEN_CITY,
    });
    const d: any = await checkRentBuddyAccess({ sc: fc, userId: USER, city: "Cebu", category: "nightlife", action: "read" });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "nightlife_disabled");
    assert.equal(d.httpStatus, 403);
  });

  it("an ABSENT controls row is still 'nothing configured' — it must NOT pause the platform", async () => {
    // The other half of the polarity. A missing singleton means no operator has
    // set a control; making that an outage would break every fresh project.
    const fc = makeFake({ flags: OPEN_FLAGS, controlsRow: null, cityRows: OPEN_CITY });
    const d: any = await checkRentBuddyAccess({ sc: fc, userId: USER, city: "Cebu", category: "city", action: "book" });
    assert.equal(d.allowed, true, `an unconfigured controls row must not pause bookings: ${JSON.stringify(d)}`);
  });
});

describe("B: the fail-closed controls object is NEVER cached", () => {
  beforeEach(() => invalidateGcCache());

  it("a single failed read does not hold the pause over a later healthy read", async () => {
    // Pass 1: the row is unreadable → paused.
    const bad = makeFake({ flags: OPEN_FLAGS, controlsError: "boom", cityRows: OPEN_CITY });
    const d1: any = await checkRentBuddyAccess({ sc: bad, userId: USER, city: "Cebu", category: "city", action: "book" });
    assert.equal(d1.allowed, false);
    assert.equal(d1.code, "globally_paused");

    // Pass 2, immediately after and WITHOUT invalidating: the database is
    // healthy again. Before the fix the all-false fallback had been written into
    // _gcCache with a 30 s TTL, so this call never re-read the row at all — the
    // symmetric failure being that the CACHED value was the fail-OPEN one. The
    // fixed reader caches only a value it actually read.
    const good = makeFake({ flags: OPEN_FLAGS, controlsRow: CONTROLS_ALL_OPEN, cityRows: OPEN_CITY });
    const d2: any = await checkRentBuddyAccess({ sc: good, userId: USER, city: "Cebu", category: "city", action: "book" });
    assert.equal(d2.allowed, true, `recovery must be immediate, got ${JSON.stringify(d2)}`);
    assert.equal(
      good.reads["rent_buddy_global_controls"] ?? 0, 1,
      "the healthy read must actually reach the table — a cached fallback would have short-circuited it",
    );
  });

  it("a healthy read IS cached, so the TTL still does its job", async () => {
    const first = makeFake({ flags: OPEN_FLAGS, controlsRow: CONTROLS_ALL_OPEN, cityRows: OPEN_CITY });
    await checkRentBuddyAccess({ sc: first, userId: USER, city: "Cebu", category: "city", action: "book" });
    assert.equal(first.reads["rent_buddy_global_controls"], 1);

    const second = makeFake({ flags: OPEN_FLAGS, controlsRow: CONTROLS_ALL_OPEN, cityRows: OPEN_CITY });
    await checkRentBuddyAccess({ sc: second, userId: USER, city: "Cebu", category: "city", action: "book" });
    assert.equal(
      second.reads["rent_buddy_global_controls"] ?? 0, 0,
      "a successfully read controls row must still be served from the 30s cache",
    );
  });
});

describe("C: restriction flags engage when feature_flags is unreadable", () => {
  beforeEach(() => invalidateGcCache());

  it("an unreadable feature_flags denies at step 1 (the capability flag stays shut)", async () => {
    // rent_buddy_enabled is a CAPABILITY flag: false-on-error is correct, and is
    // the first thing checkRentBuddyAccess asks. This pins that polarity so the
    // restriction change below cannot be mistaken for a change to this one.
    const fc = makeFake({ flagsError: "relation \"feature_flags\" does not exist", controlsRow: CONTROLS_ALL_OPEN, cityRows: OPEN_CITY });
    const d: any = await checkRentBuddyAccess({ sc: fc, userId: USER, city: "Cebu", action: "read" });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "feature_disabled");
    assert.equal(d.httpStatus, 403);
  });

  it("RENT_BUDDY_ADMIN_ONLY_MODE engages for a non-admin when its own row is unreadable", async () => {
    // The master flag is readable and true; only the ADMIN_ONLY_MODE row errors.
    // Pre-fix that read produced `false` and admin-only mode silently lifted.
    let calls = 0;
    const base = makeFake({ flags: OPEN_FLAGS, controlsRow: CONTROLS_ALL_OPEN, cityRows: OPEN_CITY, role: "user" });
    const fc: any = {
      from(table: string) {
        if (table !== "feature_flags") return base.from(table);
        calls += 1;
        const filters: Record<string, any> = {};
        const self: any = {
          select: () => self,
          eq: (c: string, v: any) => { filters[c] = v; return self; },
          maybeSingle: async () => {
            if (filters["flag"] === "RENT_BUDDY_ADMIN_ONLY_MODE") {
              return { data: null, error: { message: "statement timeout" } };
            }
            if (filters["flag"] === "rent_buddy_enabled") return { data: { enabled: true }, error: null };
            return { data: null, error: null };
          },
        };
        return self;
      },
    };
    const d: any = await checkRentBuddyAccess({ sc: fc, userId: USER, city: "Cebu", action: "read" });
    assert.ok(calls >= 2, "the admin-only flag must actually be read");
    assert.equal(d.allowed, false, "an unreadable admin-only switch must not admit a non-admin");
    assert.equal(d.code, "admin_only");
    assert.equal(d.httpStatus, 403);
  });

  it("an ABSENT restriction-flag row is still 'not configured' — it must not lock everyone out", async () => {
    // Same distinction as the controls row: absent ≠ unreadable. No flag rows
    // exist here except the master, and access is granted.
    const fc = makeFake({ flags: OPEN_FLAGS, controlsRow: CONTROLS_ALL_OPEN, cityRows: OPEN_CITY });
    const d: any = await checkRentBuddyAccess({ sc: fc, userId: USER, city: "Cebu", action: "read" });
    assert.equal(d.allowed, true, `unconfigured restriction flags must not deny: ${JSON.stringify(d)}`);
  });
});
