/**
 * census-compass CPV2-11 — "Revocation follows lineage".
 *
 * Before: compass_outcome_events.recommendation_id had no foreign key to
 * compass_served_recommendations, the served row had no revocation state, the
 * ranking nudge kept no per-outcome provenance, and no revoke path existed —
 * "no lineage to follow even in principle". Now (2997, applied to portava-ci,
 * rehearsed rolled-back first; NOT on production): the FK exists and is
 * validated (0 orphans on both databases), the served row carries
 * revoked_at / revocation_reason, each outcome records the signed nudge it
 * applied, and `revokeServedRecommendation` walks the lineage: outcomes
 * removed, nudges reversed by exactly what they recorded, served row marked.
 * A revoked recommendation accrues nothing afterwards.
 *
 * Everything runs over a fake that answers by TABLE, so a database without
 * 2997 (`probe_absent`) makes the path REFUSE with `schema_not_applied`
 * rather than pretend.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 revocation reverses no nudge (weights untouched)             → red
 *   M2 outcomes kept after revocation                                → red
 *   M3 a revoked recommendation still records outcomes               → red
 *   M4 revocation proceeds without the schema (probe ignored)        → red
 *   M5 weight_nudge not recorded on the outcome                      → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassRecommendationLineage.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recordOutcome, revokeServedRecommendation, FIT_DELTA_THRESHOLD, REVOCATION_REASONS } from "../compass/CompassOutcomeEngine.js";
import { resetSchemaCapabilityMemo } from "../lib/capability/schemaCapability.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER = "aa000000-0000-4000-8000-000000000001";
const REC = "rec-token-1";

type Row = Record<string, any>;
interface Store { served: Row[]; outcomes: Row[]; prefs: Row[]; }

/** A table fake with the operators the engine and the probe use; `absent` drops 2997's columns from every read. */
function makeDb(store: Store, opts: { absent?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    compass_served_recommendations: store.served,
    compass_outcome_events: store.outcomes,
    compass_user_preferences: store.prefs,
    compass_conversations: [{ id: "c", trip_id: null, status: "active" }],
  };
  const NEW_COLS = new Set(["revoked_at", "revocation_reason", "weight_nudge"]);
  const from = (table: string) => {
    let rows = tables[table] ?? [];
    let selected: string[] | null = null;
    let op: { kind: "update" | "delete"; patch?: Row } | null = null;
    // In `absent` mode a read or write that NAMES a 2997 column fails 42703
    // wherever the chain ends, exactly as PostgREST would.
    let failure: { code: string; message: string } | null = null;
    const b: any = {
      select(cols?: string) {
        selected = cols ? cols.split(",").map((c) => c.trim()) : null;
        if (opts.absent && selected?.some((c) => NEW_COLS.has(c))) {
          const missing = selected.find((c) => NEW_COLS.has(c));
          failure = { code: "42703", message: `column ${table}.${missing} does not exist` };
        }
        return b;
      },
      eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return b; },
      gte() { return b; }, order() { return b; }, limit(n: number) { rows = rows.slice(0, n); return b; },
      maybeSingle() { return Promise.resolve(failure ? { data: null, error: failure } : { data: rows[0] ?? null, error: null }); },
      then(res: any) {
        if (failure) { res({ data: null, error: failure }); return; }
        if (op?.kind === "update") { for (const r of rows) Object.assign(r, op.patch); res({ data: null, error: null }); return; }
        if (op?.kind === "delete") { tables[table] = tables[table]!.filter((r) => !rows.includes(r)); (store as any)[table === "compass_outcome_events" ? "outcomes" : "served"] = tables[table]!; res({ data: null, error: null }); return; }
        res({ data: rows, error: null });
      },
      insert(row: Row) {
        if (opts.absent && Object.keys(row).some((k) => NEW_COLS.has(k))) return Promise.resolve({ error: { code: "42703", message: "no such column" } });
        tables[table]!.push({ id: `r${tables[table]!.length + 1}`, ...row }); return Promise.resolve({ error: null });
      },
      update(patch: Row) {
        if (opts.absent && Object.keys(patch).some((k) => NEW_COLS.has(k))) failure = { code: "42703", message: "no such column" };
        op = { kind: "update", patch }; return b;
      },
      delete() { op = { kind: "delete" }; return b; },
      upsert(row: Row) {
        const i = tables[table]!.findIndex((r) => r.user_id === row.user_id);
        if (i >= 0) Object.assign(tables[table]![i], row); else tables[table]!.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return b;
  };
  return { from } as any;
}

function served(over: Row = {}): Row {
  return { id: "s1", user_id: USER, recommendation_id: REC, item_id: "place-1", item_type: "nightlife", ranking_factors: { compassMatch: 90 }, created_at: new Date().toISOString(), revoked_at: null, revocation_reason: null, ...over };
}

describe("lineage — the vocabulary and the schema", () => {
  it("the revocation reasons are the migration's CHECK vocabulary, verbatim", () => {
    assert.deepEqual([...REVOCATION_REASONS], ["user_withdrawn", "consent_withdrawn", "place_unavailable", "operator"]);
    const sql = readFileSync(join(SRC, "migrations", "2997_compass_recommendation_lineage.sql"), "utf8");
    for (const r of REVOCATION_REASONS) assert.ok(sql.includes(`'${r}'`), r);
    assert.match(sql, /FOREIGN KEY \(recommendation_id\) REFERENCES public\.compass_served_recommendations\(recommendation_id\)\s+ON DELETE CASCADE NOT VALID/);
    assert.match(sql, /VALIDATE CONSTRAINT compass_outcome_events_recommendation_id_fkey/);
  });
});

describe("lineage — recording carries provenance, revocation follows it", () => {
  let store: Store;
  beforeEach(() => {
    resetSchemaCapabilityMemo();
    store = { served: [served()], outcomes: [], prefs: [{ user_id: USER, category_weights: { nightlife: 0 } }] };
  });

  it("an outcome whose prediction error nudges the weight RECORDS the signed step on the row", async () => {
    // predicted 90, realized viewed (15): delta -75 ⇒ nudge down by one step.
    const r = await recordOutcome(makeDb(store), USER, { recommendationId: REC, stage: "viewed", source: "test" });
    assert.equal(r.recorded, true);
    assert.equal((r as any).weightAdjusted, true);
    assert.ok(Math.abs((r as any).fitDelta) >= FIT_DELTA_THRESHOLD);
    assert.equal(store.outcomes.length, 1);
    assert.equal(store.outcomes[0]!.weight_nudge, -1);
    assert.equal(store.prefs[0]!.category_weights.nightlife, -1);
  });

  it("revocation removes the outcomes, reverses EXACTLY the recorded nudges, and marks the served row", async () => {
    await recordOutcome(makeDb(store), USER, { recommendationId: REC, stage: "viewed" });
    await recordOutcome(makeDb(store), USER, { recommendationId: REC, stage: "saved" });
    assert.equal(store.prefs[0]!.category_weights.nightlife, -2);
    const res = await revokeServedRecommendation(makeDb(store), USER, REC, "consent_withdrawn", "2026-09-20T12:00:00.000Z");
    assert.deepEqual(res, { revoked: true, recommendationId: REC, outcomesRemoved: 2, weightsReversed: { nightlife: 2 } });
    assert.equal(store.outcomes.length, 0);
    assert.equal(store.prefs[0]!.category_weights.nightlife, 0);
    assert.equal(store.served[0]!.revoked_at, "2026-09-20T12:00:00.000Z");
    assert.equal(store.served[0]!.revocation_reason, "consent_withdrawn");
  });

  it("an outcome that recorded NO nudge (null) reverses nothing — never a guessed step", async () => {
    store.outcomes.push({ id: "o0", user_id: USER, recommendation_id: REC, item_id: "place-1", item_type: "nightlife", stage: "went", weight_nudge: null });
    const res = await revokeServedRecommendation(makeDb(store), USER, REC, "user_withdrawn");
    assert.deepEqual(res, { revoked: true, recommendationId: REC, outcomesRemoved: 1, weightsReversed: {} });
    assert.equal(store.prefs[0]!.category_weights.nightlife, 0);
  });

  it("a revoked recommendation accrues nothing: recording refuses with `revoked`", async () => {
    store.served[0]!.revoked_at = "2026-09-20T12:00:00.000Z";
    const r = await recordOutcome(makeDb(store), USER, { recommendationId: REC, stage: "went" });
    assert.deepEqual(r, { recorded: false, reason: "revoked", recommendationId: REC });
    assert.equal(store.outcomes.length, 0);
  });

  it("revoking twice, someone else's, or an unknown id is refused by name", async () => {
    store.served[0]!.revoked_at = "2026-09-20T12:00:00.000Z";
    assert.deepEqual(await revokeServedRecommendation(makeDb(store), USER, REC, "operator"), { revoked: false, reason: "already_revoked" });
    assert.deepEqual(await revokeServedRecommendation(makeDb(store), "bb000000-0000-4000-8000-000000000002", REC, "operator"), { revoked: false, reason: "no_recommendation" });
    assert.deepEqual(await revokeServedRecommendation(makeDb(store), USER, "nope", "operator"), { revoked: false, reason: "no_recommendation" });
    assert.deepEqual(await revokeServedRecommendation(null, USER, REC, "operator"), { revoked: false, reason: "db_unavailable" });
  });

  it("where 2997 is ABSENT (production today) revocation refuses, and recording still works the legacy way — no lineage column named", async () => {
    resetSchemaCapabilityMemo();
    const db = makeDb(store, { absent: true });
    assert.deepEqual(await revokeServedRecommendation(db, USER, REC, "operator"), { revoked: false, reason: "schema_not_applied" });
    const r = await recordOutcome(db, USER, { recommendationId: REC, stage: "viewed" });
    assert.equal(r.recorded, true, JSON.stringify(r));
    assert.equal(store.outcomes.length, 1);
    assert.equal("weight_nudge" in store.outcomes[0]!, false, "the legacy path must not name weight_nudge");
  });
});
