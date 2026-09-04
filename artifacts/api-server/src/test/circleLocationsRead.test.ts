/**
 * circleLocationsRead — the two gates that decide whether a circle member's
 * pin may be drawn AT ALL: is the position recent enough to mean anything, and
 * is the account still in good standing.
 *
 * WHY THESE TWO ARE TESTED HERE RATHER THAN ONLY DIFFERENTIALLY
 * ============================================================
 * src/test/mapProjectionLayers.test.ts proves the endpoint and the gateway
 * AGREE. Agreement is not correctness: both surfaces agreed perfectly while
 * both served a three-month-old pin and both served a suspended member's
 * position. This file pins the behaviour itself — boundaries, fail-closed
 * directions, and the fact that a dropped member leaks NO field, not merely no
 * coordinate.
 *
 * The reader is exercised DIRECTLY (no HTTP): these are decisions, not
 * transport, and the differential suite already covers the wire.
 *
 * Run:
 *   node --import tsx/esm --test src/test/circleLocationsRead.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readCircleLocations } from "../lib/circleLocationsRead.js";
import { freshnessBucket } from "../lib/mapTravelers.js";

// ── ids ───────────────────────────────────────────────────────────────────────

const VIEWER = "viewer-user-id";
const MEM_A = "member-a-id";
const MEM_B = "member-b-id";
const MEM_C = "member-c-id";
const MEM_D = "member-d-id";

/** A distinctive raw position, so a leak is greppable. */
const RAW = { lat: 16.054412, lng: 108.202233 };

/** The bound the reader inherits from lib/mapTravelers' freshnessBucket. */
const MAX_AGE_MS = 60 * 60 * 1000;

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec {
  rows?: any[];
  /** When set, every read of this table returns this error (data null). */
  error?: { message: string };
}

type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

/**
 * A chainable PostgREST-ish query over in-memory rows. Only the operators the
 * reader actually issues are implemented; an unimplemented operator would be a
 * silent no-op that quietly widens a result, so they are omitted on purpose.
 */
function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  const result = () => (err ? { data: null, error: err } : { data: rows, error: null });

  const q: any = {
    select() { return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    or(expr: string) {
      const parts = expr
        .split(",")
        .map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/))
        .filter(Boolean)
        .map((m) => ({ col: (m as RegExpMatchArray)[1], val: (m as RegExpMatchArray)[3] }));
      rows = rows.filter((r) => parts.some(({ col, val }) => String(r[col]) === val));
      return q;
    },
    maybeSingle() {
      return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return q;
}

function makeClient(state: FakeState) {
  return { from: (table: string) => buildQuery(specOf(state, table)) };
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/**
 * A position fix `ageMs` old.
 *
 * `updated_at` and `last_known_at` are set INDEPENDENTLY so the tests can pull
 * them apart — that separation is the whole point of `staleFixFreshRow` below.
 */
function fix(ageMs: number, over: Record<string, unknown> = {}) {
  const iso = new Date(Date.now() - ageMs).toISOString();
  return { updated_at: iso, last_known_at: iso, ...over };
}

/**
 * One consenting, active, freshly-located circle member. Every gate the reader
 * runs BEFORE the two under test is satisfied here, so a zero-length result in
 * these tests can only be the gate named in the test.
 */
function baseState(over: FakeState = {}): FakeState {
  return {
    feature_flags: [],
    blocks: [],
    profile_privacy_settings: [],
    circle_memberships: [{ user_id: VIEWER, other_id: MEM_A }],
    location_preferences: [
      { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby", sharing_paused: false, discovery_visibility: null },
    ],
    user_privacy_settings: [],
    profiles: [
      { id: VIEWER, account_status: "active", name: "Viewer", avatar_url: null },
      { id: MEM_A, account_status: "active", name: "Ada", avatar_url: "https://cdn/a.jpg" },
    ],
    user_location_state: [
      { user_id: MEM_A, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", ...fix(60_000) },
    ],
    ...over,
  };
}

async function read(state: FakeState) {
  return readCircleLocations(makeClient(state) as any, VIEWER);
}

/** Ids served, sorted — the assertion most of these tests want. */
async function servedIds(state: FakeState): Promise<string[]> {
  const r = await read(state);
  assert.equal(r.ok, true, `expected a successful read, got ${JSON.stringify(r)}`);
  return (r.ok ? r.locations : []).map((l) => l.userId).sort();
}

/** Replace MEM_A's location row wholesale. */
function withLocation(over: Record<string, unknown>): FakeState {
  return baseState({
    user_location_state: [
      { user_id: MEM_A, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", ...over },
    ],
  });
}

/** Replace MEM_A's profile row wholesale. */
function withStatus(status: unknown): FakeState {
  const row: Record<string, unknown> = { id: MEM_A, name: "Ada", avatar_url: "https://cdn/a.jpg" };
  if (status !== undefined) row.account_status = status;
  return baseState({
    profiles: [{ id: VIEWER, account_status: "active", name: "Viewer", avatar_url: null }, row],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanity: the fixture itself is not vacuous
// ─────────────────────────────────────────────────────────────────────────────

describe("circleLocationsRead — fixture sanity", () => {
  it("serves the base member, so a 0-length result elsewhere means the gate fired", async () => {
    assert.deepEqual(await servedIds(baseState()), [MEM_A]);
  });

  it("still coarsens: the raw coordinate never survives the reader", async () => {
    const r = await read(baseState());
    assert.ok(r.ok);
    assert.notEqual(r.locations[0].lat, RAW.lat);
    assert.notEqual(r.locations[0].lng, RAW.lng);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 1 — staleness
// ─────────────────────────────────────────────────────────────────────────────

describe("circleLocationsRead — freshness bound (60 min, inclusive)", () => {
  it("serves a position fixed one minute ago", async () => {
    assert.deepEqual(await servedIds(withLocation(fix(60_000))), [MEM_A]);
  });

  it("the boundary is <=, not <: 60 min exactly is served, 60 min + 1 ms is not", () => {
    // Pinned against the cutoff function the reader delegates to, with an
    // INJECTED `now`. The scenario tests below run against the wall clock and
    // must keep a cushion around the boundary or they flake; this one can be
    // exact, so the inclusive-vs-exclusive question is answered here rather
    // than left to a comment.
    const now = Date.UTC(2026, 7, 31, 12, 0, 0);
    assert.equal(freshnessBucket(new Date(now - MAX_AGE_MS).toISOString(), now), "recent");
    assert.equal(freshnessBucket(new Date(now - MAX_AGE_MS - 1).toISOString(), now), null);
  });

  it("serves a position just inside the bound", async () => {
    // freshnessBucket returns 'recent' for `age <= FRESH_MAX_MS`. A 2s cushion
    // absorbs the wall-clock that elapses between building the fixture and the
    // reader taking its own `Date.now()`; without it this test would flake on
    // the wrong side of the very boundary it is pinning.
    assert.deepEqual(await servedIds(withLocation(fix(MAX_AGE_MS - 2_000))), [MEM_A]);
  });

  it("DROPS a position just past the bound", async () => {
    assert.deepEqual(await servedIds(withLocation(fix(MAX_AGE_MS + 2_000))), []);
  });

  it("DROPS a three-month-old position — the pin that says someone is where they are not", async () => {
    assert.deepEqual(await servedIds(withLocation(fix(90 * 24 * 60 * 60 * 1000))), []);
  });

  it("a stale member leaks NO field — not city, not country, not updatedAt", async () => {
    // Dropping the coordinate but keeping the row would still answer "which
    // country is this person in, and when were they last seen" — which is a
    // location. This is the same rule gate 6 (sharing paused / mode off)
    // already enforces, and the reason the choice here is OMIT, not STRIP.
    const r = await read(withLocation(fix(MAX_AGE_MS + 2_000)));
    assert.ok(r.ok);
    assert.deepEqual(r.locations, []);
    const serialized = JSON.stringify(r.locations);
    assert.ok(!serialized.includes("Da Nang"), "city must not survive the staleness gate");
    assert.ok(!serialized.includes("VN"), "country must not survive the staleness gate");
  });

  it("treats a NULL last_known_at as stale (unknown age is not fresh)", async () => {
    // Fail closed. An undated position is exactly the one that must not be
    // drawn: nothing about the row says whether it is a minute or a year old,
    // and the consumer renders a pin either way. lib/mapTravelers takes the
    // same direction — its bbox query excludes rows with a null last_known_at.
    const iso = new Date().toISOString();
    assert.deepEqual(
      await servedIds(withLocation({ updated_at: iso, last_known_at: null })),
      [],
    );
  });

  it("treats a MISSING last_known_at column value as stale", async () => {
    // Pre-migration rows, and any row written by a path that never stamped it.
    const iso = new Date().toISOString();
    assert.deepEqual(await servedIds(withLocation({ updated_at: iso })), []);
  });

  it("treats an UNPARSEABLE last_known_at as stale", async () => {
    assert.deepEqual(
      await servedIds(withLocation({ updated_at: new Date().toISOString(), last_known_at: "not-a-date" })),
      [],
    );
  });

  it("treats a FUTURE last_known_at as stale — a spoofed fix must not pin forever", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    assert.deepEqual(
      await servedIds(withLocation({ updated_at: future, last_known_at: future })),
      [],
    );
  });

  it("gates on last_known_at, NOT updated_at — a settings write does not refresh a stale pin", async () => {
    // THE CASE THAT PICKS THE COLUMN. routes/location.ts stamps `updated_at` on
    // every upsert (a manual city pick, a permission_status change) but writes
    // `last_known_at` only inside `if (lat != null)`. A member who last moved
    // in June and changed a setting a minute ago therefore has a one-minute-old
    // `updated_at` sitting on top of a months-old position. Gating on
    // `updated_at` would serve that pin.
    assert.deepEqual(
      await servedIds(
        withLocation({
          updated_at: new Date(Date.now() - 60_000).toISOString(),
          last_known_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ),
      [],
    );
  });

  it("applies the bound to the viewer's OWN row too", async () => {
    // Gates 4 and 5 are skipped for self because they are CONSENT gates. This
    // one is not: a stale self-pin is the one a user is most likely to trust.
    const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    assert.deepEqual(
      await servedIds(
        baseState({
          circle_memberships: [{ user_id: VIEWER, other_id: VIEWER }],
          location_preferences: [],
          user_location_state: [
            { user_id: VIEWER, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", updated_at: iso, last_known_at: iso },
          ],
        }),
      ),
      [],
    );
  });

  it("drops only the stale member, not the whole circle", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    assert.deepEqual(
      await servedIds(
        baseState({
          circle_memberships: [
            { user_id: VIEWER, other_id: MEM_A },
            { user_id: VIEWER, other_id: MEM_B },
          ],
          location_preferences: [
            { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby" },
            { user_id: MEM_B, trusted_circle_share: true, location_mode: "nearby" },
          ],
          profiles: [
            { id: MEM_A, account_status: "active", name: "Ada", avatar_url: null },
            { id: MEM_B, account_status: "active", name: "Bo", avatar_url: null },
          ],
          user_location_state: [
            { user_id: MEM_A, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", updated_at: fresh, last_known_at: fresh },
            { user_id: MEM_B, lat: 13.75, lng: 100.5, city: "Bangkok", country: "TH", updated_at: old, last_known_at: old },
          ],
        }),
      ),
      [MEM_A],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 2 — account standing
// ─────────────────────────────────────────────────────────────────────────────

describe("circleLocationsRead — account standing", () => {
  it("serves a member in good standing (account_status = 'active')", async () => {
    assert.deepEqual(await servedIds(withStatus("active")), [MEM_A]);
  });

  for (const status of ["suspended", "banned", "deactivated", "pending_deletion", "deleted"]) {
    it(`DROPS a member whose account_status is '${status}'`, async () => {
      // The predicate is the ALLOWLIST `account_status === 'active'`, matching
      // lib/mapTravelers, discoverySearch, follows and compass. A denylist of
      // ['suspended','banned'] would have kept serving the other three.
      assert.deepEqual(await servedIds(withStatus(status)), []);
    });
  }

  it("a suspended member leaks NO field — omitted, not stripped to a nameless row", async () => {
    const r = await read(withStatus("suspended"));
    assert.ok(r.ok);
    assert.deepEqual(r.locations, []);
    const serialized = JSON.stringify(r.locations);
    assert.ok(!serialized.includes("Da Nang"), "city must not survive the standing gate");
    assert.ok(!serialized.includes(MEM_A), "not even the member id may survive");
  });

  it("DROPS a member with no profiles row at all (standing unknown → fail closed)", async () => {
    assert.deepEqual(
      await servedIds(
        baseState({ profiles: [{ id: VIEWER, account_status: "active", name: "Viewer", avatar_url: null }] }),
      ),
      [],
    );
  });

  it("reads a NULL/absent account_status as 'active', matching requireUser", async () => {
    // The column is NOT NULL in the schema, so this only covers pre-migration
    // rows. It is deliberately NOT the fail-closed case: the fail-closed cases
    // are an unreadable profiles table and an absent profiles row, both
    // asserted above/below. lib/http.ts's requireUser resolves the same way
    // (`(profile as any)?.account_status ?? "active"`), and diverging from it
    // would mean a user who can call the endpoint cannot appear on it.
    assert.deepEqual(await servedIds(withStatus(undefined)), [MEM_A]);
    assert.deepEqual(await servedIds(withStatus(null)), [MEM_A]);
  });

  it("FAILS CLOSED when the profiles read errors — no positions, a reported stage", async () => {
    // This read used to be unchecked, degrading to nameless rows. That was a
    // safe direction while it only carried display fields; now it carries
    // account_status, so an unreadable profiles table means unknown standing
    // for everyone and must not answer 200-with-pins.
    const r = await read(baseState({ profiles: { error: { message: "profiles down" } } }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.stage, "profiles");
    assert.ok(r.ok === false && r.message.includes("profiles down"), "the loggable detail must survive");
  });

  it("applies the standing gate to the viewer's OWN row too", async () => {
    // requireUser already refuses every request from a banned or suspended
    // account, so applying this uniformly closes the remaining statuses on the
    // one surface that would otherwise still plot them.
    const iso = new Date(Date.now() - 60_000).toISOString();
    assert.deepEqual(
      await servedIds(
        baseState({
          circle_memberships: [{ user_id: VIEWER, other_id: VIEWER }],
          location_preferences: [],
          profiles: [{ id: VIEWER, account_status: "deactivated", name: "Viewer", avatar_url: null }],
          user_location_state: [
            { user_id: VIEWER, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", updated_at: iso, last_known_at: iso },
          ],
        }),
      ),
      [],
    );
  });

  it("drops only the suspended member, not the whole circle", async () => {
    const iso = new Date(Date.now() - 60_000).toISOString();
    assert.deepEqual(
      await servedIds(
        baseState({
          circle_memberships: [
            { user_id: VIEWER, other_id: MEM_A },
            { user_id: VIEWER, other_id: MEM_B },
          ],
          location_preferences: [
            { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby" },
            { user_id: MEM_B, trusted_circle_share: true, location_mode: "nearby" },
          ],
          profiles: [
            { id: MEM_A, account_status: "active", name: "Ada", avatar_url: null },
            { id: MEM_B, account_status: "suspended", name: "Bo", avatar_url: null },
          ],
          user_location_state: [
            { user_id: MEM_A, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", updated_at: iso, last_known_at: iso },
            { user_id: MEM_B, lat: 13.75, lng: 100.5, city: "Bangkok", country: "TH", updated_at: iso, last_known_at: iso },
          ],
        }),
      ),
      [MEM_A],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One clock read
// ─────────────────────────────────────────────────────────────────────────────

describe("circleLocationsRead — reads the clock once", () => {
  it("does not take a clock read per member", async () => {
    // A Date.now() inside the loop would put two members on opposite sides of
    // "the same" cutoff, and would drift further the larger the circle. Asserting
    // an absolute call count would be brittle (helpers may read the clock too),
    // so this asserts the count does not GROW with the circle — which is the
    // property that actually matters.
    const iso = new Date(Date.now() - 60_000).toISOString();
    const members = [MEM_A, MEM_B, MEM_C, MEM_D];

    function stateFor(ids: string[]): FakeState {
      return baseState({
        circle_memberships: ids.map((id) => ({ user_id: VIEWER, other_id: id })),
        location_preferences: ids.map((id) => ({ user_id: id, trusted_circle_share: true, location_mode: "nearby" })),
        profiles: ids.map((id) => ({ id, account_status: "active", name: id, avatar_url: null })),
        user_location_state: ids.map((id) => ({
          user_id: id, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", updated_at: iso, last_known_at: iso,
        })),
      });
    }

    const realNow = Date.now;
    async function countClockReads(state: FakeState): Promise<number> {
      let n = 0;
      (Date as any).now = () => { n++; return realNow.call(Date); };
      try {
        const r = await readCircleLocations(makeClient(state) as any, VIEWER);
        assert.ok(r.ok, "the scenario must succeed, or the count measures nothing");
        return n;
      } finally {
        (Date as any).now = realNow;
      }
    }

    const one = await countClockReads(stateFor(members.slice(0, 1)));
    const four = await countClockReads(stateFor(members));
    assert.equal(four, one, `clock reads must not scale with circle size (1 member: ${one}, 4 members: ${four})`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gates that were already there must still be there
// ─────────────────────────────────────────────────────────────────────────────

describe("circleLocationsRead — preserved gates", () => {
  it("still honours the emergency stop, engaged and unreadable", async () => {
    assert.deepEqual(
      await servedIds(baseState({ feature_flags: [{ flag: "disable_location_sharing", enabled: true }] })),
      [],
    );
    assert.deepEqual(
      await servedIds(baseState({ feature_flags: { error: { message: "flags down" } } })),
      [],
    );
  });

  it("still treats a missing prefs row as NOT consent", async () => {
    assert.deepEqual(await servedIds(baseState({ location_preferences: [] })), []);
  });

  it("still honours the master switch and both block directions", async () => {
    assert.deepEqual(
      await servedIds(baseState({ user_privacy_settings: [{ user_id: MEM_A, allow_location_sharing: false }] })),
      [],
    );
    assert.deepEqual(await servedIds(baseState({ blocks: [{ blocker_id: VIEWER, blocked_id: MEM_A }] })), []);
    assert.deepEqual(await servedIds(baseState({ blocks: [{ blocker_id: MEM_A, blocked_id: VIEWER }] })), []);
    assert.deepEqual(await servedIds(baseState({ blocks: { error: { message: "blocks down" } } })), []);
  });

  it("still withholds the name unless the member opted into show_real_name", async () => {
    const withheld = await read(baseState());
    assert.ok(withheld.ok && withheld.locations[0].name === null);

    const shown = await read(baseState({ profile_privacy_settings: [{ user_id: MEM_A, show_real_name: true }] }));
    assert.ok(shown.ok && shown.locations[0].name === "Ada");
  });

  it("still emits NOTHING when sharing is paused / off / no_location", async () => {
    for (const prefs of [
      { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby", sharing_paused: true },
      { user_id: MEM_A, trusted_circle_share: true, location_mode: "off" },
      { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby", discovery_visibility: "no_location" },
    ]) {
      assert.deepEqual(await servedIds(baseState({ location_preferences: [prefs] })), []);
    }
  });

  it("still reports the other read stages rather than serving an empty list", async () => {
    for (const [stage, table] of [
      ["circle", "circle_memberships"],
      ["prefs", "location_preferences"],
      ["privacy_settings", "user_privacy_settings"],
      ["location_state", "user_location_state"],
    ] as const) {
      const r = await read(baseState({ [table]: { error: { message: `${table} down` } } }));
      assert.equal(r.ok, false, `${table} failure must not answer ok`);
      assert.equal(r.ok === false && r.stage, stage);
    }
  });
});
