/**
 * placeMomentumDismiss.db.test.ts — census-discovery DV-25 (§61): a dismiss is
 * not interest. `rebuild_place_momentum` (2892, and 3410's body, which owns it
 * since census §58) weighed `outcome = 'dismiss'` like any other outcome (+2),
 * so a place people dismissed GAINED momentum. Migration 3417 replaces 3410's
 * body with a dismiss at weight 0: the served row still counts as the
 * impression it was, and the dismissal adds nothing. Zero is exclusion, not a
 * negative weight. Every case runs on a chain that includes 3410 (asserted).
 *
 *   D1  a dismissed place's stored evidence equals the same place never acted
 *       on — in every window, with saves beside it, and for the trend state
 *   D2  parity: the SQL store equals lib/discoveryTrendState.computeTrendStates
 *       (the SQL store's TypeScript mirror) over the same rows with a dismiss's outcome
 *       weight removed — the exclusion, stated in TypeScript's own kernel
 *   D3  parity on the RAW rows. computeTrendStates' own `weightFor` is lane P8's
 *       file; the same one-line exclusion was routed to the integrator (§61.11,
 *       hunk H1) and is applied (§61.17). D3 now runs unconditionally, so a
 *       revert of H1 turns it RED, never back into a silent `todo`.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, rows, seedUser } from "./localDb.js";
import { computeTrendStates } from "../../lib/discoveryTrendState.js";
import type { MomentumRow } from "../../lib/discoveryLocalMomentum.js";

const TAG = `pmd${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
/** A whole second, a minute in the past, so every row sits strictly inside [prior, now]. */
const NOW_MS = Math.floor(Date.now() / 1000) * 1000 - 60_000;
const P_NOW = new Date(NOW_MS).toISOString();
const iso = (hoursAgo: number) => new Date(NOW_MS - hoursAgo * HOUR).toISOString();
let viewer = "";

type Seed = { place: string; outcome: string; servedHoursAgo: number; outcomeHoursAgo: number | null };
const seeded: Seed[] = [];
const place = (label: string) => `${TAG}-${label}`;

function row(p: string, outcome: string, servedHoursAgo: number, outcomeHoursAgo: number | null = null): void {
  seeded.push({ place: p, outcome, servedHoursAgo, outcomeHoursAgo });
}

/** Two places per case: X with dismisses, X0 with the same served rows never acted on. */
function pair(label: string, served: number[], dismissedAfterHours: number, extra: (p: string) => void = () => {}): [string, string] {
  const x = place(label);
  const x0 = place(`${label}0`);
  for (const h of served) {
    row(x, "dismiss", h, Math.max(0.5, h - dismissedAfterHours));
    row(x0, "impression", h);
  }
  extra(x);
  extra(x0);
  return [x, x0];
}

interface Evidence { place_id: string; recent_rate: number; mid_rate: number; prior_rate: number; total_weight: number; trend_state: string }
const stored = (ids: string[]) => new Map(rows<Evidence>(
  `SELECT place_id, recent_rate, mid_rate, prior_rate, total_weight, trend_state FROM public.place_momentum
    WHERE computed_at = '${P_NOW}' AND place_id IN (${ids.map((i) => `'${i}'`).join(", ")})`).map((r) => [r.place_id, r]));

const asRows = (s: readonly Seed[]): MomentumRow[] => s.map((r) => ({
  item_id: r.place, outcome: r.outcome, served_at: iso(r.servedHoursAgo),
  outcome_at: r.outcomeHoursAgo === null ? null : iso(r.outcomeHoursAgo),
}));

let pairs: Array<[string, string]> = [];

before(() => {
  if (!HAVE_DB) return;
  assert.equal(scalar("SELECT to_regprocedure('public.rebuild_place_momentum(timestamptz)') IS NOT NULL;"), "t", "2892 must be applied");
  assert.equal(scalar("SELECT position('surface = c_surface' IN pg_get_functiondef('public.rebuild_place_momentum(timestamptz)'::regprocedure)) > 0;"), "t",
    "3410 must be in the chain: 3417 is 3410's body with one arm changed");
  viewer = seedUser(`${TAG}v`);
  pairs = [
    pair("recent", [1, 2, 3, 5, 8, 13], 0.5),                                       // a burst of dismisses in the last 48 h
    pair("mid", [60, 80, 100, 120, 150], 2),                                         // dismisses in the 7-day window
    pair("prior", [200, 300, 400, 500], 10),                                         // dismisses in the 30-day window
    pair("saved", [2, 4, 6, 70, 90], 1, (p) => { row(p, "save", 3, 2); row(p, "tap", 30, 29); }), // saves and taps beside them
  ];
  const values = seeded.map((r) =>
    `('${viewer}', '${r.place}', 'place', 0, '{}'::jsonb, '${r.outcome}', '${iso(r.servedHoursAgo)}', ${r.outcomeHoursAgo === null ? "NULL" : `'${iso(r.outcomeHoursAgo)}'`}, 'discovery', 1, 'raw_behavioral_event')`);
  exec(`INSERT INTO public.rank_events (user_id, item_id, item_kind, position, features, outcome, served_at, outcome_at, surface, schema_version, privacy_class)
        VALUES ${values.join(",\n")};`);
  exec(`SET LOCAL ROLE service_role;\nSELECT public.rebuild_place_momentum('${P_NOW}');`, { single: true });
});

after(() => {
  if (!HAVE_DB) return;
  // The rebuild writes a row for EVERY place with activity at P_NOW; all of them are this suite's run.
  exec(`DELETE FROM public.place_momentum WHERE place_id LIKE '${TAG}-%' OR computed_at = '${P_NOW}';`);
  exec(`DELETE FROM public.rank_events WHERE item_id LIKE '${TAG}-%';`);
  exec(`DELETE FROM public.profiles WHERE id = '${viewer}';\nDELETE FROM auth.users WHERE id = '${viewer}';`);
});

const pick = (e: Evidence | undefined) => e && ({
  recent_rate: e.recent_rate, mid_rate: e.mid_rate, prior_rate: e.prior_rate, total_weight: e.total_weight, trend_state: e.trend_state,
});

describe("D — DV-25: a dismiss adds no momentum to the SQL store (3417)", { skip: !HAVE_DB }, () => {
  test("D1. a dismissed place's stored evidence equals the same place never acted on, in every window and beside saves", () => {
    const got = stored(pairs.flat());
    for (const [x, x0] of pairs) {
      assert.ok(got.get(x) && got.get(x0), `${x}: no row was written`);
      assert.deepEqual(pick(got.get(x)), pick(got.get(x0)), `${x}: a dismiss moved the evidence`);
    }
    // Not vacuous: the "saved" pair carries positive outcome weight, so the equality is not two empties.
    const saved = got.get(place("saved"))!;
    assert.ok(saved.total_weight > 5 + 1, `saved total_weight ${saved.total_weight}`);
  });

  test("D2. parity: the SQL store equals computeTrendStates over the same rows with a dismiss's outcome weight removed", () => {
    const got = stored(pairs.flat());
    // A dismissed row, with its outcome weight removed, is an unconverted impression.
    const ts = computeTrendStates(asRows(seeded.map((r) => (r.outcome === "dismiss" ? { ...r, outcome: "impression", outcomeHoursAgo: null } : r))), NOW_MS);
    for (const id of pairs.flat()) {
      const e = ts[id]!.evidence;
      assert.deepEqual(pick(got.get(id)), {
        recent_rate: e.recentRate, mid_rate: e.midRate, prior_rate: e.priorRate, total_weight: e.totalWeight, trend_state: ts[id]!.state,
      }, id);
    }
  });

  // H1 (§61.11, applied §61.17) is lib/discoveryTrendState.weightFor's own `dismiss → 0`; `h1` is asserted inside D3, not used to skip it.
  const h1 = HAVE_DB && computeTrendStates([{ item_id: "h1", outcome: "dismiss", served_at: iso(1), outcome_at: iso(0.5) }], NOW_MS).h1!.evidence.totalWeight === 1;
  test("D3. parity on the RAW rows: computeTrendStates and the SQL store agree about dismisses themselves",
    () => { assert.ok(h1, "H1: computeTrendStates must weigh a dismiss zero (impression 1 + dismiss 0 = 1)");
      const got = stored(pairs.flat());
      const ts = computeTrendStates(asRows(seeded), NOW_MS);
      for (const id of pairs.flat()) {
        const e = ts[id]!.evidence;
        assert.deepEqual(pick(got.get(id)), {
          recent_rate: e.recentRate, mid_rate: e.midRate, prior_rate: e.priorRate, total_weight: e.totalWeight, trend_state: ts[id]!.state,
        }, id);
      }
    });
});
