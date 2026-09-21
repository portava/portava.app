/**
 * liveMapCorpus — the fixture corpus for driving the MAP GATEWAY against a real
 * PostgreSQL, and the write latch that keeps it pointed at a disposable one.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Every Map test in this repository until now drove the projection route
 * against a double. A double answers whatever its fixture says, so it can
 * establish that the handler's logic is self-consistent and it can establish
 * nothing about whether the route's reads are ones a real schema would accept.
 * That distinction is not theoretical here: W146 found that EVERY Wall
 * analytics row was being rejected `23514` by the real `rank_events` CHECK while
 * the fake returned `{ error: null }` for all 151 of them.
 *
 * census-map's blocked rows ask for payloads "captured from a seeded CI"
 * precisely so the client's fixtures stop being hand-built to a shape somebody
 * believed the producer emits. This corpus is the seed half of that.
 *
 * ── THE LATCH IS W146'S, DELIBERATELY ────────────────────────────────────────
 * This file does NOT define a second approval mechanism. It reads W146's, via
 * `approvedDisposableTarget()`, and refuses at the top of both write paths when
 * the latch is shut. One latch means one place to reason about, and it means a
 * harness cannot open the gate for the Map corpus while leaving it shut for the
 * Wall's — the approval is a property of the TARGET, not of the fixture family.
 * The gate is on the WRITE, not on the connection: whatever client this module
 * is handed, `seedMapCorpus` and `teardownMapCorpus` throw at their first
 * statement while the latch is shut.
 *
 * ── EVERY ROW CARRIES A MARKER ───────────────────────────────────────────────
 * Teardown does not remember what it created — it DELETES BY MARKER
 * (`mlive-`), so a run that dies halfway cannot leave rows the next run then
 * measures. `seedMapCorpus` calls `teardownMapCorpus` first for that reason.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { approvedDisposableTarget, DisposableTargetError } from "./liveWallCorpus.js";

type AnyClient = SupabaseClient<any, any, any, any, any>;

/** Throw unless W146's write gate was passed. Called before every write path. */
function requireApprovedTarget(op: string): void {
  if (approvedDisposableTarget() === null) {
    throw new DisposableTargetError(
      "missing_configured_target",
      `liveMapCorpus: ${op} was called without an approved disposable target. ` +
        "assertDisposableLocalBenchmarkTarget() must succeed first.",
    );
  }
}

// ── The corpus ───────────────────────────────────────────────────────────────

/** The marker every seeded row carries, in `places.normalized_name`. */
export const MAP_FIXTURE_NS = "mlive";

/**
 * The viewport. Da Nang, the same city the repository's other map fixtures use,
 * at a zoom the aggregation band calls `street` — so objects are served
 * INDIVIDUALLY and a per-object assertion is meaningful. At a coarser zoom the
 * §24 aggregator would fold them into cells and the count under test would be
 * a cell count, which is a different claim.
 */
export const MAP_BBOX = { west: 108.0, south: 15.9, east: 108.4, north: 16.2 } as const;
export const MAP_ZOOM = 16;

/** The two places inside the viewport, and the one outside it. */
export const MAP_PLACES = [
  {
    id: "bb000000-0000-4000-8000-000000000001",
    name: "Mlive Inside A",
    normalized_name: `${MAP_FIXTURE_NS}-inside-a`,
    primary_category: "cafe",
    latitude: 16.05,
    longitude: 108.2,
    status: "active",
  },
  {
    id: "bb000000-0000-4000-8000-000000000002",
    name: "Mlive Inside B",
    normalized_name: `${MAP_FIXTURE_NS}-inside-b`,
    primary_category: "bar",
    latitude: 16.06,
    longitude: 108.21,
    status: "active",
  },
  {
    // OUTSIDE, and far outside — not a boundary case. Its whole job is to fail
    // to appear: without it, "the route returned the seeded places" is also
    // satisfied by a route that returns every place in the table.
    id: "bb000000-0000-4000-8000-000000000003",
    name: "Mlive Outside",
    normalized_name: `${MAP_FIXTURE_NS}-outside`,
    primary_category: "cafe",
    latitude: 10.0,
    longitude: 99.0,
    status: "active",
  },
] as const;

/** The ids expected INSIDE the viewport, as the route spells object ids. */
export const MAP_EXPECTED_OBJECT_IDS = [
  `place:${MAP_PLACES[0].id}`,
  `place:${MAP_PLACES[1].id}`,
];

export const MAP_OUTSIDE_OBJECT_ID = `place:${MAP_PLACES[2].id}`;

// ── Seed / teardown ──────────────────────────────────────────────────────────

export async function teardownMapCorpus(pub: AnyClient): Promise<void> {
  requireApprovedTarget("teardownMapCorpus");
  const { error } = await pub
    .from("places")
    .delete()
    .like("normalized_name", `${MAP_FIXTURE_NS}-%`);
  if (error) throw new Error(`liveMapCorpus: teardown failed — ${error.message}`);
}

export async function seedMapCorpus(pub: AnyClient): Promise<number> {
  requireApprovedTarget("seedMapCorpus");
  // Heal first. A previous run killed mid-flight leaves rows that would
  // otherwise be counted as this run's.
  await teardownMapCorpus(pub);
  const { error } = await pub.from("places").insert(MAP_PLACES as unknown as any[]);
  if (error) throw new Error(`liveMapCorpus: seed failed — ${error.message}`);
  return MAP_PLACES.length;
}

// ── Flags ────────────────────────────────────────────────────────────────────
//
// The flags are read from the REAL `feature_flags` table by the real
// `isFlagEnabled`, which is the point: a double can be told the flag is on, and
// a row can be absent, and `isFlagEnabled` treats an absent row as false. Here
// the difference between "false" and "no row" is observable.

/** Read the current value of a flag, or null when there is NO ROW. */
export async function readFlag(pub: AnyClient, flag: string): Promise<boolean | null> {
  const { data, error } = await pub
    .from("feature_flags")
    .select("enabled")
    .eq("flag", flag)
    .maybeSingle();
  if (error) throw new Error(`liveMapCorpus: could not read ${flag} — ${error.message}`);
  return data ? Boolean((data as { enabled: unknown }).enabled) : null;
}

/** Set a flag that ALREADY EXISTS. Refuses to create one: an absent flag row is
 *  a fact about the database, and inventing one would hide it. */
export async function setExistingFlag(
  pub: AnyClient,
  flag: string,
  enabled: boolean,
): Promise<void> {
  requireApprovedTarget("setExistingFlag");
  const before = await readFlag(pub, flag);
  if (before === null) {
    throw new Error(
      `liveMapCorpus: ${flag} has NO ROW in this database. That is a finding, not something ` +
        "to paper over by inserting one — isFlagEnabled reads an absent row as false, and a " +
        "harness that seeds the row would be testing a database nobody deployed.",
    );
  }
  const { error } = await pub.from("feature_flags").update({ enabled }).eq("flag", flag);
  if (error) throw new Error(`liveMapCorpus: could not set ${flag} — ${error.message}`);
}
