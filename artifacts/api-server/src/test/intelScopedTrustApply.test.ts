/**
 * I4a — §15 scoped trust APPLICATION (lib/intelScopedTrustApply) + migration
 * 2278 text pins.
 *
 * Proves:
 *   * the fold applies trust_next = clamp(prev + lr*(score − expected)*weight,
 *     0, 100) per graded row, in (computed_at, id) order, and tracks outcomes /
 *     successes / contradictions / calibration_error honestly (did_not_go moves
 *     nothing but advances the cursor);
 *   * at-most-once per attribution row: a replay folds nothing; a crash between
 *     ledger insert and fold is recovered by the cursor on the next touch; a
 *     concurrent pass that advanced the cursor first wins and the loser skips;
 *   * every graded row is bridged into the EXISTING engine as a trust_events row
 *     under guide_accuracy (dedup'd on the attribution id), and the bridge is a
 *     no-op when trust_engine_enabled is off — never an error;
 *   * getScopedTrust returns badges + the internal number, null for a scope with
 *     no folded outcome, and is NOT consumed by the confidence model;
 *   * 2278 creates intel_scoped_trust deny-default/REVOKE-first/service_role
 *     only, the two domain-event idempotency indexes, and widens
 *     erase_intel_for_actor to the two I4a tables inside the declared erasure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyScopedTrust, foldScopedTrust, emptyScopedTrust, isPastCursor, bridgeEventFor, getScopedTrust,
  scopedTrustApplier, TRUST_BRIDGE_SOURCE_TYPE, MAX_ROWS_PER_CELL,
  type AttributionLedgerRow,
} from "../lib/intelScopedTrustApply.js";
import { DEFAULT_LEARNING_RATE, DEFAULT_SCOPED_TRUST, SCOPED_TRUST_ALGORITHM_VERSION, BADGE_MIN_OUTCOMES } from "../lib/intelScopedTrust.js";
import { ERASED_BY_CASCADE, POST_BASELINE_TABLES } from "../lib/deletionDispositions.js";
import { COVERED_TABLES } from "../lib/dataRights.js";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const SCOPE = "geo=vn:da_nang|fam=crowd|band=evening|mode=solo|season=autumn";
const NOW = new Date("2026-09-04T16:00:00.000Z");
const T1 = "2026-09-04T15:00:00.000Z";
const T2 = "2026-09-04T15:30:00.000Z";

const ledgerRow = (over: Partial<AttributionLedgerRow> = {}): AttributionLedgerRow => ({
  id: "00000000-0000-4000-8000-000000000001", actor_id: ACTOR, scope_key: SCOPE,
  outcome: "same", outcome_score: 1, expected_accuracy: 0.8, weight: 0.7, contradiction: false, computed_at: T1,
  ...over,
});

// ── A fake client covering exactly the chains the applier and the trust
//    engine's recordTrustEvent use. ───────────────────────────────────────────
interface Seed { flags?: Record<string, boolean>; attributions?: any[]; scoped?: any[]; trustEvents?: any[]; errorTable?: string }
function makeDb(seed: Seed) {
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(seed.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled })),
    intel_attributions: [...(seed.attributions ?? [])],
    intel_scoped_trust: [...(seed.scoped ?? [])],
    trust_events: [...(seed.trustEvents ?? [])],
    trust_settings: [],
  };
  let seq = 0;
  const calls: string[] = [];
  function from(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: any = null;
    let lim = Infinity;
    let wantSelect = false;
    const filters: Array<(r: any) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    const match = (r: any) => filters.every((f) => f(r));
    function run() {
      calls.push(`${op}:${table}`);
      if (seed.errorTable === table) return { data: null, error: { message: "boom" } };
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        if (table === "intel_scoped_trust" && rows.some((r) => store.some((s) => s.actor_id === r.actor_id && s.scope_key === r.scope_key))) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const inserted = rows.map((r) => ({ id: `row-${++seq}`, created_at: NOW.toISOString(), ...r }));
        store.push(...inserted);
        return { data: wantSelect ? inserted[0] : null, error: null };
      }
      if (op === "update") {
        const hit = store.filter(match);
        for (const r of hit) Object.assign(r, payload);
        return { data: wantSelect ? hit.map((r) => ({ actor_id: r.actor_id })) : null, error: null };
      }
      let rows = store.filter(match);
      for (const o of [...orders].reverse()) rows = [...rows].sort((a, b) => (a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0) * (o.asc ? 1 : -1));
      return { data: rows.slice(0, lim), error: null };
    }
    const b: any = {
      select() { wantSelect = true; return b; },
      insert(rows: any) { op = "insert"; payload = rows; wantSelect = false; return b; },
      update(patch: any) { op = "update"; payload = patch; wantSelect = false; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      gt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] > v); return b; },
      gte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] >= v); return b; },
      order(c: string, o: { ascending?: boolean } = {}) { orders.push({ col: c, asc: o.ascending !== false }); return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }); },
      single() { const r = run(); const d = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data; return Promise.resolve({ data: d, error: r.error ?? (d ? null : { message: "no rows" }) }); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return { from, _tables: tables, _calls: calls };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("scoped trust fold — the §15 rule, per row, in cursor order", () => {
  it("one graded row moves trust by lr*(score − expected)*weight and tallies it", () => {
    const { next, applied } = foldScopedTrust(emptyScopedTrust(ACTOR, SCOPE), [ledgerRow()]);
    assert.equal(applied.length, 1);
    assert.equal(next.trust, DEFAULT_SCOPED_TRUST + DEFAULT_LEARNING_RATE * (1 - 0.8) * 0.7);
    assert.equal(next.outcomes, 1); assert.equal(next.successes, 1); assert.equal(next.contradictions, 0);
    assert.ok(Math.abs(next.calibration_error! - 0.2) < 1e-12); assert.equal(next.calibration_samples, 1);
    assert.equal(next.last_attribution_id, "00000000-0000-4000-8000-000000000001");
    assert.equal(next.last_attribution_at, T1);
    assert.equal(next.algorithm_version, SCOPED_TRUST_ALGORITHM_VERSION);
  });
  it("a contradiction lowers trust and counts as a contradiction; did_not_go moves nothing but advances the cursor", () => {
    const rows = [
      ledgerRow({ id: "00000000-0000-4000-8000-000000000001", outcome: "worse", outcome_score: 0.1, expected_accuracy: 0.9, weight: 1, contradiction: true }),
      ledgerRow({ id: "00000000-0000-4000-8000-000000000002", outcome: "did_not_go", outcome_score: null, computed_at: T2 }),
    ];
    const { next, applied } = foldScopedTrust(emptyScopedTrust(ACTOR, SCOPE), rows);
    assert.equal(applied.length, 2);
    assert.equal(next.trust, 50 + DEFAULT_LEARNING_RATE * (0.1 - 0.9) * 1);
    assert.equal(next.outcomes, 1, "did_not_go is not a graded outcome");
    assert.equal(next.contradictions, 1); assert.equal(next.successes, 0);
    assert.equal(next.last_attribution_id, "00000000-0000-4000-8000-000000000002", "cursor still advances past the ungraded row");
  });
  it("rows at or before the cursor are skipped; numeric strings (PostgREST numerics) are folded", () => {
    const state = { ...emptyScopedTrust(ACTOR, SCOPE), last_attribution_at: T1, last_attribution_id: "00000000-0000-4000-8000-000000000005" };
    assert.equal(isPastCursor(state, { id: "00000000-0000-4000-8000-000000000004", computed_at: T1 }), false, "same instant, lower id");
    assert.equal(isPastCursor(state, { id: "00000000-0000-4000-8000-000000000006", computed_at: T1 }), true, "same instant, higher id");
    assert.equal(isPastCursor(state, { id: "00000000-0000-4000-8000-000000000001", computed_at: T2 }), true, "later instant");
    assert.equal(isPastCursor(state, { id: "x", computed_at: "garbage" }), false, "undated ⇒ never folded");
    const { next } = foldScopedTrust(state, [ledgerRow({ id: "00000000-0000-4000-8000-000000000009", computed_at: T2, outcome_score: "1", expected_accuracy: "0.5", weight: "0.5" })]);
    assert.equal(next.trust, 50 + DEFAULT_LEARNING_RATE * 0.5 * 0.5);
  });
  it("a graded row with no expected accuracy counts the outcome but cannot move trust (fail-closed)", () => {
    const { next } = foldScopedTrust(emptyScopedTrust(ACTOR, SCOPE), [ledgerRow({ expected_accuracy: null })]);
    assert.equal(next.trust, DEFAULT_SCOPED_TRUST); assert.equal(next.outcomes, 1); assert.equal(next.calibration_samples, 0);
  });
});

describe("the trust_events bridge input", () => {
  it("success ⇒ +1 minor; confident contradiction ⇒ −2 moderate; unsure contradiction ⇒ no bridge; did_not_go ⇒ none", () => {
    assert.deepEqual(bridgeEventFor(ledgerRow()), { eventType: "intel_outcome_success", delta: 1, severity: "minor" });
    assert.deepEqual(bridgeEventFor(ledgerRow({ outcome: "worse", contradiction: true, expected_accuracy: 0.9 })), { eventType: "intel_materially_incorrect_confident", delta: -2, severity: "moderate" });
    assert.equal(bridgeEventFor(ledgerRow({ outcome: "worse", contradiction: true, expected_accuracy: 0.4 })), null, "calibrated_uncertainty has no category-score expression");
    assert.equal(bridgeEventFor(ledgerRow({ outcome: "did_not_go", outcome_score: null })), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("applyScopedTrust — at-most-once per attribution row, replayable, race-safe", () => {
  const seeded = () => makeDb({
    flags: { trust_engine_enabled: true },
    attributions: [
      ledgerRow({ id: "00000000-0000-4000-8000-000000000001" }),
      ledgerRow({ id: "00000000-0000-4000-8000-000000000002", computed_at: T2, outcome: "worse", outcome_score: 0.1, expected_accuracy: 0.9, weight: 0.35, contradiction: true }),
      // another actor in the same scope — untouched unless named
      ledgerRow({ id: "00000000-0000-4000-8000-000000000003", actor_id: OTHER }),
    ],
  });

  it("folds every row past the cursor for the touched cell only, writes the state, bridges graded rows", async () => {
    const db = seeded();
    const r = await applyScopedTrust(db, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW);
    assert.deepEqual(r, { cells: 1, applied: 2, bridged: 2, lostRace: 0 });
    const cell = db._tables.intel_scoped_trust.find((x) => x.actor_id === ACTOR && x.scope_key === SCOPE);
    assert.ok(cell);
    const expected = 50 + DEFAULT_LEARNING_RATE * (1 - 0.8) * 0.7 + DEFAULT_LEARNING_RATE * (0.1 - 0.9) * 0.35;
    assert.ok(Math.abs(cell.trust - expected) < 1e-12, `trust ${cell.trust} ≠ ${expected}`);
    assert.equal(cell.outcomes, 2); assert.equal(cell.successes, 1); assert.equal(cell.contradictions, 1);
    assert.equal(cell.last_attribution_id, "00000000-0000-4000-8000-000000000002");
    assert.equal(cell.last_attribution_at, T2);
    assert.equal(cell.last_updated_at, NOW.toISOString());
    assert.equal(db._tables.intel_scoped_trust.length, 1, "OTHER's cell is not touched");
    const ev = db._tables.trust_events;
    assert.equal(ev.length, 2);
    assert.deepEqual(ev.map((e) => [e.event_type, e.delta, e.category, e.source_type, e.status]).sort(), [
      ["intel_materially_incorrect_confident", -2, "guide_accuracy", TRUST_BRIDGE_SOURCE_TYPE, "applied"],
      ["intel_outcome_success", 1, "guide_accuracy", TRUST_BRIDGE_SOURCE_TYPE, "applied"],
    ]);
    assert.ok(ev.every((e) => e.user_id === ACTOR && e.source_id.startsWith("00000000-0000-4000-8000-")), "keyed on the attribution id");
  });

  it("a replay folds nothing and bridges nothing", async () => {
    const db = seeded();
    await applyScopedTrust(db, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW);
    const trustAfterFirst = db._tables.intel_scoped_trust[0].trust;
    const again = await applyScopedTrust(db, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW);
    assert.deepEqual(again, { cells: 1, applied: 0, bridged: 0, lostRace: 0 });
    assert.equal(db._tables.intel_scoped_trust[0].trust, trustAfterFirst);
    assert.equal(db._tables.trust_events.length, 2);
  });

  it("a missed fold (rows inserted, applier never ran) is recovered by the cursor on the next touch", async () => {
    const db = seeded();
    // First fold sees only row 1; row 2 'arrives' afterwards (simulating a pass that died after inserting it).
    const late = db._tables.intel_attributions.splice(1, 1)[0];
    await applyScopedTrust(db, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW);
    assert.equal(db._tables.intel_scoped_trust[0].outcomes, 1);
    db._tables.intel_attributions.push(late);
    const r = await applyScopedTrust(db, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW);
    assert.equal(r.applied, 1);
    assert.equal(db._tables.intel_scoped_trust[0].outcomes, 2);
    assert.equal(db._tables.intel_scoped_trust[0].contradictions, 1);
  });

  it("a concurrent pass that advanced the cursor first wins; the loser skips without double-folding", async () => {
    const db = seeded();
    // Emulate: our read of the cell saw NO row, but by the time we insert, another
    // pass created it — the fake raises 23505 on the second insert.
    const [a, b] = await Promise.all([
      applyScopedTrust(db, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW),
      applyScopedTrust(db, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW),
    ]);
    assert.equal(a.applied + b.applied, 2, "the two rows are folded exactly once in total");
    assert.equal(a.lostRace + b.lostRace, 1, "the other pass reports the lost race");
    assert.equal(db._tables.intel_scoped_trust.length, 1);
    assert.equal(db._tables.intel_scoped_trust[0].outcomes, 2);
  });

  it("trust engine off ⇒ the fold still happens, the bridge writes nothing, no error", async () => {
    const db = seeded(); db._tables.feature_flags[0].enabled = false;
    const r = await applyScopedTrust(db, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW);
    assert.equal(r.applied, 2); assert.equal(r.bridged, 0);
    assert.equal(db._tables.trust_events.length, 0);
    assert.equal(db._tables.intel_scoped_trust.length, 1);
  });

  it("a ledger read error leaves the cursor unchanged (replays next pass) and is not a silent success", async () => {
    const db = seeded(); db._tables.intel_scoped_trust.push({ ...emptyScopedTrust(ACTOR, SCOPE), last_updated_at: "t0" });
    const errDb = makeDb({ flags: {}, attributions: db._tables.intel_attributions, scoped: db._tables.intel_scoped_trust, errorTable: "intel_attributions" });
    const r = await applyScopedTrust(errDb, [{ actor_id: ACTOR, scope_key: SCOPE }], NOW);
    assert.equal(r.applied, 0);
    assert.equal(errDb._tables.intel_scoped_trust[0].last_attribution_id, null);
    assert.equal(errDb._tables.intel_scoped_trust[0].last_updated_at, "t0");
  });

  it("scopedTrustApplier reports the rows applied (the scheduler's trustApplied tally)", async () => {
    const db = seeded();
    assert.equal(await scopedTrustApplier(db, [{ actor_id: ACTOR, scope_key: SCOPE }] as any, NOW), 2);
    assert.ok(MAX_ROWS_PER_CELL >= 100);
  });
});

describe("getScopedTrust — internal number + public badges; not wired into confidence", () => {
  it("null for a scope with no folded outcome; badges only past the minimum", async () => {
    const db = makeDb({ scoped: [{ actor_id: ACTOR, scope_key: SCOPE, trust: 80, outcomes: BADGE_MIN_OUTCOMES, successes: 9, contradictions: 1, calibration_error: 0.1, calibration_samples: 10, last_attribution_id: null, last_attribution_at: null, algorithm_version: SCOPED_TRUST_ALGORITHM_VERSION }] });
    assert.equal(await getScopedTrust(db, OTHER, SCOPE), null);
    const r = await getScopedTrust(db, ACTOR, SCOPE);
    assert.deepEqual(r, { trust: 80, outcomes: 10, successes: 9, contradictions: 1, calibrationError: 0.1, badges: ["scoped_reliable", "scoped_calibrated"], algorithmVersion: SCOPED_TRUST_ALGORITHM_VERSION });
  });
  it("the confidence model does not import scoped trust (an owner decision, stated in the unit report)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ["intelProjection.ts", "intelProjectionAggregator.ts", "intelConfidence.ts"]) {
      let src = "";
      try { src = readFileSync(join(here, "../lib", f), "utf8"); } catch { continue; }
      assert.ok(!src.includes("intelScopedTrust"), `${f} must not consume scoped trust yet`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
const MIG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../migrations/2278_intel_scoped_trust.sql"), "utf8");

describe("migration 2278 — what it declares", () => {
  it("creates intel_scoped_trust keyed (actor, scope) with the cursor, deny-default, REVOKE-first, service_role only", () => {
    assert.ok(MIG.includes("CREATE TABLE IF NOT EXISTS public.intel_scoped_trust"));
    assert.ok(MIG.includes("PRIMARY KEY (actor_id, scope_key)"));
    for (const c of ["trust", "outcomes", "successes", "contradictions", "calibration_error", "calibration_samples", "last_attribution_id", "last_attribution_at", "algorithm_version"]) {
      assert.match(MIG, new RegExp(`^\\s+${c}\\s+`, "m"), `column ${c}`);
    }
    assert.ok(MIG.includes("ALTER TABLE public.intel_scoped_trust ENABLE ROW LEVEL SECURITY"));
    const revokes = ["PUBLIC", "anon", "authenticated", "service_role"].map((r) => `REVOKE ALL ON public.intel_scoped_trust FROM ${r};`);
    for (const r of revokes) assert.ok(MIG.includes(r), r);
    const grantIdx = MIG.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_scoped_trust TO service_role");
    assert.ok(grantIdx > MIG.indexOf(revokes[3]), "revoke before grant");
    assert.ok(!/GRANT .* ON public\.intel_scoped_trust TO (anon|authenticated)/.test(MIG), "no client grant");
    assert.ok(!/CREATE POLICY[^;]*intel_scoped_trust/.test(MIG), "zero policies — deny-all by design");
    assert.ok(MIG.includes("RAISE EXCEPTION 'POSTCONDITION FAILED"));
  });
  it("makes the two idempotent domain events unique on the spine; intel.state.changed is not constrained", () => {
    assert.ok(MIG.includes("canonical_events_intel_observation_recorded_once"));
    assert.match(MIG, /payload->'intel'->>'observation_id'[\s\S]*WHERE verb = 'intel\.observation\.recorded'/);
    assert.ok(MIG.includes("canonical_events_intel_claim_promoted_once"));
    assert.match(MIG, /payload->'intel'->>'claim_id'[\s\S]*WHERE verb = 'intel\.claim\.promoted'/);
    assert.ok(!/UNIQUE INDEX[^;]*intel\.state\.changed/.test(MIG));
  });
  it("widens erase_intel_for_actor to both I4a tables inside the same declared erasure — still the one entry point", () => {
    const fn = MIG.slice(MIG.indexOf("CREATE OR REPLACE FUNCTION public.erase_intel_for_actor"), MIG.indexOf("REVOKE ALL ON FUNCTION public.erase_intel_for_actor"));
    assert.ok(fn.includes("set_config('portava.erasure_in_progress', 'on', true)"));
    for (const t of ["intel_scoped_trust", "intel_attributions", "intel_evidence", "intel_confirmations", "intel_observations"]) {
      assert.ok(fn.includes(`DELETE FROM public.${t} WHERE actor_id = p_actor_id`), t);
    }
    assert.ok(!fn.includes("DELETE FROM public.intel_claims"), "derived claims are other people's contributions too");
    assert.ok(MIG.includes("GRANT EXECUTE ON FUNCTION public.erase_intel_for_actor(uuid) TO service_role"));
    assert.equal((MIG.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1, "no second erasure entry point");
  });
  it("seeds no flag — the closed loop has one switch (2277, OFF)", () => {
    assert.ok(!MIG.includes("INSERT INTO public.feature_flags"));
  });
  it("both I4a tables are registered for deletion and data rights", () => {
    for (const t of ["intel_attributions", "intel_scoped_trust"]) {
      assert.ok(ERASED_BY_CASCADE.includes(t), `${t} ERASED_BY_CASCADE`);
      assert.ok(POST_BASELINE_TABLES.includes(t), `${t} POST_BASELINE_TABLES`);
      assert.ok(COVERED_TABLES.includes(t), `${t} COVERED_TABLES`);
    }
  });
});
