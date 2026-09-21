/**
 * resolveGemCoords — an unreadable entitlement table must not reveal, and must
 * not be silent about not revealing.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * The three entitlement reads inside `resolveGemCoords` were
 * `const { data } = await …` — `error` never bound. supabase-js RESOLVES on a
 * database error, so an unreadable `hidden_gem_saves` / `trip_members` /
 * `trip_plan_items` came back as `null` and read as "this caller is not
 * entitled". The DIRECTION was already right (withhold), which is why the
 * ledger classified all three FAIL-CLOSED. What was wrong is that it was an
 * accident of shape rather than a decision, and it was invisible: an entitled
 * caller silently receives the neighbourhood centroid and nothing distinguishes
 * that from a caller who genuinely never saved the gem.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
 * Each failure case is paired with a CONTROL that proves the entitlement path
 * still WORKS — otherwise a guard that had simply been broken into never
 * revealing anything would satisfy every failure assertion in this file.
 *
 * `failOn` is scoped to the specific table so the other read in the same path
 * stays healthy; scoping wider would let a case pass because the code never got
 * that far.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/hiddenGemCoordsFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { resolveGemCoords } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";

const GEM    = "80000000-0000-4000-a000-000000000001";
const CALLER = "80000000-0000-4000-a000-000000000002";
const OWNER  = "80000000-0000-4000-a000-000000000003";
const TRIP   = "80000000-0000-4000-a000-000000000004";

const EXACT_LAT = 10.7769;
const EXACT_LNG = 106.7009;
const APPROX_LAT = 10.78;
const APPROX_LNG = 106.7;

function gemRow(level: string) {
  return {
    id: GEM,
    sensitivity_level: level,
    latitude: EXACT_LAT,
    longitude: EXACT_LNG,
    approx_latitude: APPROX_LAT,
    approx_longitude: APPROX_LNG,
  } as any;
}

const down = (table: string) => (ctx: FakeReadContext) =>
  ctx.table === table ? { message: `${table} unavailable`, code: "57P01" } : null;

// ── reveal_after_save ────────────────────────────────────────────────────────

describe("reveal_after_save — an unreadable hidden_gem_saves is not 'not saved'", () => {
  it("CONTROL: a caller WITH a save row gets the exact point", async () => {
    const db = makeFailClosedClient({
      rows: { hidden_gem_saves: [{ gem_id: GEM, user_id: CALLER }] },
    });
    const r = await resolveGemCoords(gemRow("reveal_after_save"), db, CALLER, OWNER, null);
    assert.equal(r.coordsPrecision, "exact", "the entitlement path must still work");
    assert.equal(r.lat, EXACT_LAT, "vacuity guard: it really returned the exact point");
  });

  it("CONTROL: a caller with no save row gets the centroid", async () => {
    const db = makeFailClosedClient({ rows: { hidden_gem_saves: [] } });
    const r = await resolveGemCoords(gemRow("reveal_after_save"), db, CALLER, OWNER, null);
    assert.equal(r.coordsPrecision, "approximate");
    assert.equal(r.lat, APPROX_LAT);
  });

  it("an unreadable hidden_gem_saves withholds the exact point", async () => {
    // The save row IS there. Only the read fails — so a guard that leaked on
    // error would return EXACT here, and nothing else in the fixture could.
    const db = makeFailClosedClient({
      rows: { hidden_gem_saves: [{ gem_id: GEM, user_id: CALLER }] },
      failOn: down("hidden_gem_saves"),
    });
    const r = await resolveGemCoords(gemRow("reveal_after_save"), db, CALLER, OWNER, null);
    assert.notEqual(r.coordsPrecision, "exact", "an unverifiable entitlement must not unlock coordinates");
    assert.notEqual(r.lat, EXACT_LAT);
    assert.equal(r.coordsRevealed, false);
  });
});

// ── reveal_after_acceptance ──────────────────────────────────────────────────

function acceptanceRows() {
  return {
    trip_members: [{ trip_id: TRIP, user_id: CALLER, status: "accepted" }],
    trip_plan_items: [{ id: "pi-1", trip_id: TRIP, source_type: "hidden_gem", source_id: GEM }],
  };
}

describe("reveal_after_acceptance — an unreadable membership or link is not 'not entitled'", () => {
  it("CONTROL: an accepted member on a trip the gem is linked to gets the exact point", async () => {
    const db = makeFailClosedClient({ rows: acceptanceRows() });
    const r = await resolveGemCoords(gemRow("reveal_after_acceptance"), db, CALLER, OWNER, TRIP);
    assert.equal(r.coordsPrecision, "exact", "the dual-check entitlement path must still work");
    assert.equal(r.lat, EXACT_LAT);
  });

  it("CONTROL: an accepted member whose trip does NOT link the gem is refused", async () => {
    const rows = acceptanceRows();
    rows.trip_plan_items = [];
    const db = makeFailClosedClient({ rows });
    const r = await resolveGemCoords(gemRow("reveal_after_acceptance"), db, CALLER, OWNER, TRIP);
    assert.notEqual(r.coordsPrecision, "exact", "membership alone is the over-disclosure vector the dual check closes");
  });

  it("an unreadable trip_members withholds the exact point", async () => {
    const db = makeFailClosedClient({ rows: acceptanceRows(), failOn: down("trip_members") });
    const r = await resolveGemCoords(gemRow("reveal_after_acceptance"), db, CALLER, OWNER, TRIP);
    assert.notEqual(r.coordsPrecision, "exact");
    assert.equal(r.coordsRevealed, false);
  });

  it("an unreadable trip_plan_items withholds the exact point", async () => {
    // Scoped to trip_plan_items ONLY: trip_members still answers "accepted", so
    // this case exercises the gem-to-trip binding leg specifically.
    const db = makeFailClosedClient({ rows: acceptanceRows(), failOn: down("trip_plan_items") });
    const r = await resolveGemCoords(gemRow("reveal_after_acceptance"), db, CALLER, OWNER, TRIP);
    assert.notEqual(r.coordsPrecision, "exact");
    assert.equal(r.coordsRevealed, false);
  });
});

// ── the levels that never consult the database at all ────────────────────────

describe("levels that need no entitlement read are unaffected by an unreadable database", () => {
  it("a public gem still yields exact coordinates with every table down", async () => {
    const db = makeFailClosedClient({ rows: {}, failOn: () => ({ message: "all down", code: "57P01" }) });
    const r = await resolveGemCoords(gemRow("public"), db, CALLER, OWNER, TRIP);
    assert.equal(r.coordsPrecision, "exact", "a public gem's position is not gated on any read");
  });

  it("a protected gem yields nothing even to a healthy database", async () => {
    const db = makeFailClosedClient({ rows: acceptanceRows() });
    const r = await resolveGemCoords(gemRow("protected"), db, CALLER, OWNER, TRIP);
    assert.equal(r.coordsPrecision, "hidden");
    assert.equal(r.lat, null);
  });

  it("an unrecognised sensitivity level falls to hidden, not to exact", async () => {
    const db = makeFailClosedClient({ rows: acceptanceRows() });
    const r = await resolveGemCoords(gemRow("something_new_someone_adds_later"), db, CALLER, OWNER, TRIP);
    assert.equal(r.coordsPrecision, "hidden");
  });

  it("the submitter's own gem is exact regardless of level or database health", async () => {
    const db = makeFailClosedClient({ rows: {}, failOn: () => ({ message: "all down", code: "57P01" }) });
    const r = await resolveGemCoords(gemRow("protected"), db, OWNER, OWNER, TRIP);
    assert.equal(r.coordsPrecision, "exact");
  });
});
