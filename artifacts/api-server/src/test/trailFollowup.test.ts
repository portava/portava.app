/**
 * IG-06 Trail follow-up — going-next capture, movement inference, and the two
 * gates that make a movement aggregate publishable (privacy threshold + block
 * filter), plus the §14 arrival/outcome derivation.
 *
 * Pure functions run in memory; the capture-service cases run against the same
 * fake client shape intelCapture.test.ts uses. Proves: the trail surface is
 * flag-gated and writes experience.next_move; a next_move is NEVER minted as a
 * single-user claim (must_aggregate); surfaces cannot emit each other's claims;
 * the §13 privacy threshold + 0.65 confidence floor fail closed; ungrouped rows
 * are excluded from the aggregate; and a blocked actor's Trail row is filtered.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapTrailSignal, validateTrailClaimValue, mustAggregate,
  computeMovementStrength, movementPrivacyMet, mayPublishMovement,
  MOVEMENT_CONFIDENCE_FLOOR, aggregateNextMoves, linkTrailOutcomes, visibleTrailRows,
  TRAIL_OUTCOME_VERBS,
  type MovementAggregate, type NextMoveRow, type OutcomeEventRow,
} from "../lib/trailFollowup.js";
import { CANONICAL_EVENT_VERBS } from "../lib/canonicalEvents.js";
import { VERB_FAMILY } from "../lib/eventFamilies.js";

const HERE = dirname(fileURLToPath(import.meta.url));
import { writeObservation, proposeClaim } from "../services/intel/IntelCaptureService.js";
import { INTEL_FLAG_DEPENDENCIES, type IntelFlag } from "../lib/intelContracts.js";

/**
 * Flags for a fixture, DERIVED from the §26 dependency graph rather than typed
 * out: a flag may only be honoured when everything it depends on is also on, so
 * a fixture that hard-codes `{intel_trail_followup: true}` would stop clearing
 * the gate the moment the chain grows and would pass silently as a refusal.
 */
function chainOn(flag: IntelFlag, self = true): Record<string, boolean> {
  const out: Record<string, boolean> = { [flag]: self };
  const frontier = [...INTEL_FLAG_DEPENDENCIES[flag]];
  while (frontier.length) {
    const next = frontier.pop()!;
    if (next in out) continue;
    out[next] = true;
    frontier.push(...INTEL_FLAG_DEPENDENCIES[next]);
  }
  return out;
}

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PLACE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date();
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString();

/** A fake supabase client sufficient for the capture service's chains (mirrors intelCapture.test.ts). */
function makeDb(flags: Record<string, boolean>, opts: { places?: string[] } = {}) {
  const tables: Record<string, any[]> = { intel_observations: [], intel_claims: [], intel_confirmations: [] };
  const places = new Set(opts.places ?? []);
  let seq = 0;
  function from(table: string) {
    let op: "select" | "insert" | "insert_select" | "update" = "select";
    let payload: any = null;
    const filters: [string, any][] = [];
    const match = (row: any) => filters.every(([c, v]) => row[c] === v);
    function run() {
      if (table === "feature_flags") {
        const flag = filters.find(([c]) => c === "flag")?.[1];
        return { data: { enabled: Boolean(flags[flag]) }, error: null };
      }
      if (table === "places") {
        const id = filters.find(([c]) => c === "id")?.[1];
        return { data: places.has(id) ? { id } : null, error: null };
      }
      if (table === "intel_contribution_consent") {
        return { data: { enabled: true, withdrawn_at: null }, error: null }; // consent granted (D4 gate)
      }
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        const row = { id: `row-${++seq}`, schema_version: 1, created_at: NOW.toISOString(), ...payload };
        if (table === "intel_observations" && store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key))
          return { data: null, error: { code: "23505", message: "duplicate observation" } };
        store.push(row);
        return { data: op === "insert_select" ? row : null, error: null };
      }
      if (op === "update") { for (const r of store) if (match(r)) Object.assign(r, payload); return { data: null, error: null }; }
      return { data: store.filter(match)[0] ?? null, error: null };
    }
    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(patch: any) { op = "update"; payload = patch; return b; },
      eq(c: string, v: any) { filters.push([c, v]); return b; },
      maybeSingle() { return Promise.resolve(run()); },
      single() { return Promise.resolve(run()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return { from, _tables: tables };
}

const trailInput = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE,
  captureSurface: "trail" as const,
  claimType: "experience.next_move",
  value: { destinationArea: "soho" },
  observedAt: OBSERVED,
  idempotencyKey: "trail-key-1",
  ...over,
});

describe("IG-06 — option → canonical Trail claim", () => {
  it("maps movement to next_move (coarse area) and exit to a canonical reason", () => {
    assert.deepEqual(mapTrailSignal("movement", "Shoreditch"), { claimType: "experience.next_move", value: { destinationArea: "Shoreditch" } });
    assert.deepEqual(mapTrailSignal("exit", "too crowded"), { claimType: "experience.exit_reason", value: { reason: "too_crowded" } });
    assert.deepEqual(mapTrailSignal("exit", "better option"), { claimType: "experience.exit_reason", value: { reason: "better_option" } });
  });
  it("fails closed on an unrecognised exit option and an over-long destination", () => {
    assert.equal(mapTrailSignal("exit", "made up"), null);
    assert.equal(mapTrailSignal("movement", "x".repeat(121)), null);
    assert.equal(mapTrailSignal("movement", "   "), null);
  });
  it("validates values and rejects malformed ones", () => {
    assert.equal(validateTrailClaimValue("experience.next_move", { destinationArea: "soho", timeWindow: "soon", strength: 0.7 }), true);
    assert.equal(validateTrailClaimValue("experience.next_move", { destinationArea: "soho", timeWindow: "eventually" }), false);
    assert.equal(validateTrailClaimValue("experience.next_move", { destinationArea: "soho", strength: 2 }), false);
    assert.equal(validateTrailClaimValue("experience.exit_reason", { reason: "unsafe" }), true);
    assert.equal(validateTrailClaimValue("experience.exit_reason", { reason: "nope" }), false);
  });
});

describe("IG-06 — the never-single-user movement invariant", () => {
  it("mustAggregate is true only for movement", () => {
    assert.equal(mustAggregate("experience.next_move"), true);
    assert.equal(mustAggregate("experience.exit_reason"), false);
    assert.equal(mustAggregate("crowd.level"), false);
  });

  it("AT-11: captures a next_move on the trail surface but refuses to mint a single-user claim", async () => {
    const db = makeDb(chainOn("intel_trail_followup"), { places: [PLACE] });
    const written = await writeObservation(db as any, ACTOR, trailInput() as any);
    assert.equal(written.ok, true);
    assert.equal((written as any).observation.capture_surface, "trail");
    assert.equal((written as any).observation.claim_type, "experience.next_move");

    const proposed = await proposeClaim(db as any, (written as any).observation);
    assert.equal(proposed.ok, false);
    assert.equal((proposed as any).reason, "must_aggregate");
    assert.equal(db._tables.intel_claims.length, 0, "no single-user movement claim was written");
  });

  it("trail surface is flag-gated (off → inert no-op)", async () => {
    const db = makeDb(chainOn("intel_trail_followup", false), { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, trailInput() as any);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "disabled");
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("the §26 chain is enforced: the trail flag alone does NOT open the write path", async () => {
    // INTEL_FLAG_DEPENDENCIES.intel_trail_followup === ['intel_capture_quick_signal'].
    // Every dependency is turned OFF here while the surface's own flag stays ON,
    // so this asserts the dependency is actually read, not merely declared.
    const deps = INTEL_FLAG_DEPENDENCIES.intel_trail_followup;
    assert.ok(deps.length > 0, "the trail flag must declare at least one dependency for this test to mean anything");
    const flags: Record<string, boolean> = { intel_trail_followup: true };
    for (const d of deps) flags[d] = false;
    const db = makeDb(flags, { places: [PLACE] });
    const r = await writeObservation(db as any, ACTOR, trailInput() as any);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "disabled");
    assert.equal(db._tables.intel_observations.length, 0, "nothing is stored behind an unhonourable flag");
  });
});

describe("IG-06 — surfaces cannot emit each other's claims", () => {
  it("quick_signal cannot emit a movement claim; trail cannot emit a crowd claim", async () => {
    const db = makeDb({ intel_capture_quick_signal: true, intel_trail_followup: true }, { places: [PLACE] });
    const asQuick = await writeObservation(db as any, ACTOR, trailInput({ captureSurface: "quick_signal", idempotencyKey: "x1" }) as any);
    assert.equal((asQuick as any).reason, "invalid_claim_type");
    const asTrail = await writeObservation(db as any, ACTOR, trailInput({ claimType: "crowd.level", value: { level: "busy" }, idempotencyKey: "x2" }) as any);
    assert.equal((asTrail as any).reason, "invalid_claim_type");
    assert.equal(db._tables.intel_observations.length, 0);
  });
});

describe("IG-06 — §13 movement inference math + gates", () => {
  it("computes movement_strength = arrivals + 0.6*heading + 0.25*saves − 0.5*cancellations", () => {
    assert.equal(computeMovementStrength({ verifiedArrivals: 10, headingTo: 20, saves: 8, cancellations: 4 }), 10 + 12 + 2 - 2);
  });

  const ok: MovementAggregate = {
    uniqueActors: 15, groups: 5, maxSingleGroupShare: 0.2,
    timeBucketMinutes: 30, publicationDelayMinutes: 10, sensitiveSubject: false,
  };
  it("AT-11: passes exactly at the threshold and fails just under any single rule", () => {
    assert.equal(movementPrivacyMet(ok), true);
    assert.equal(movementPrivacyMet({ ...ok, uniqueActors: 14 }), false);
    assert.equal(movementPrivacyMet({ ...ok, groups: 4 }), false);
    assert.equal(movementPrivacyMet({ ...ok, maxSingleGroupShare: 0.21 }), false);
    assert.equal(movementPrivacyMet({ ...ok, timeBucketMinutes: 29 }), false);
    assert.equal(movementPrivacyMet({ ...ok, publicationDelayMinutes: 9 }), false);
    assert.equal(movementPrivacyMet({ ...ok, sensitiveSubject: true }), false, "sensitive subjects are always excluded");
  });
  it("publication also needs the confidence floor", () => {
    assert.equal(mayPublishMovement(ok, MOVEMENT_CONFIDENCE_FLOOR), true);
    assert.equal(mayPublishMovement(ok, MOVEMENT_CONFIDENCE_FLOOR - 0.001), false);
    assert.equal(mayPublishMovement({ ...ok, uniqueActors: 1 }, 0.99), false);
  });
});

describe("IG-06 — aggregation excludes ungrouped rows (fail-closed independence)", () => {
  it("buckets by origin→destination, counts actors/groups, drops rows with no group", () => {
    const base = new Date("2026-08-25T22:00:00.000Z").getTime();
    const rows: NextMoveRow[] = [
      { actorId: "a", originId: PLACE, destinationArea: "soho", groupId: "g1", observedAt: new Date(base).toISOString() },
      { actorId: "b", originId: PLACE, destinationArea: "soho", groupId: "g2", observedAt: new Date(base + 60_000).toISOString() },
      { actorId: "c", originId: PLACE, destinationArea: "soho", groupId: null, observedAt: new Date(base + 120_000).toISOString() }, // dropped
    ];
    const [agg] = aggregateNextMoves(rows);
    assert.equal(agg.originId, PLACE);
    assert.equal(agg.destinationArea, "soho");
    assert.equal(agg.uniqueActors, 2);
    assert.equal(agg.groups, 2);
    assert.equal(agg.droppedUngrouped, 1);
    assert.equal(agg.maxSingleGroupShare, 0.5);
  });
});

describe("IG-06 — §14 arrival/outcome link", () => {
  // The fixture verbs below are the REAL outcome family. The previous fixture
  // used 'arrival_confirmed' / 'entry_failed' / 'entry_succeeded' / 'next_stop',
  // none of which canonical_events can hold (CHECK verb IN …, 2120 + 2277), so
  // the assertions were green over values production can never produce.
  it("counts only outcomes at the destination that occur after the declaration", () => {
    const declaredAt = new Date("2026-08-25T22:00:00.000Z").toISOString();
    const outcomes: OutcomeEventRow[] = [
      { verb: "arrival", subjectId: PLACE, observedAt: new Date("2026-08-25T22:10:00Z").toISOString() },
      { verb: "arrival", subjectId: PLACE, observedAt: new Date("2026-08-25T21:50:00Z").toISOString() }, // before → excluded
      { verb: "rejection", subjectId: PLACE, observedAt: new Date("2026-08-25T22:20:00Z").toISOString() },
      { verb: "completion", subjectId: PLACE, observedAt: new Date("2026-08-25T22:25:00Z").toISOString() },
      { verb: "arrival", subjectId: "other", observedAt: new Date("2026-08-25T22:30:00Z").toISOString() }, // elsewhere → excluded
    ];
    const link = linkTrailOutcomes(PLACE, "soho", declaredAt, outcomes);
    assert.equal(link.destinationArea, "soho");
    assert.equal(link.arrivals, 1);
    assert.equal(link.rejections, 1);
    assert.equal(link.completions, 1);
    assert.equal(link.ignoredNonOutcome, 0);
  });

  it("every TRAIL_OUTCOME_VERB is a canonical verb the canonical_events CHECK admits, in family 'outcome'", () => {
    // Derived from lib/eventFamilies (the one verb→family map) AND cross-checked
    // against the migration text, so neither side can drift alone.
    assert.deepEqual(
      [...TRAIL_OUTCOME_VERBS].sort(),
      CANONICAL_EVENT_VERBS.filter((v) => VERB_FAMILY[v] === "outcome").slice().sort(),
    );
    assert.ok(TRAIL_OUTCOME_VERBS.length > 0, "the outcome family must not be empty");
    const migration = readFileSync(join(HERE, "../migrations/2277_intel_outcomes_attribution.sql"), "utf8");
    const check = migration.match(/ADD CONSTRAINT canonical_events_verb_check CHECK \(verb IN \(([\s\S]*?)\)\)/);
    assert.ok(check, "2277 must carry the canonical_events verb CHECK");
    const admitted = new Set([...check![1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    for (const verb of TRAIL_OUTCOME_VERBS)
      assert.ok(admitted.has(verb), `'${verb}' is not admitted by canonical_events_verb_check — a dead literal`);
  });

  it("a verb the canonical_events CHECK cannot hold is reported, never silently counted as an arrival", () => {
    const declaredAt = new Date("2026-08-25T22:00:00.000Z").toISOString();
    const link = linkTrailOutcomes(PLACE, "soho", declaredAt, [
      { verb: "arrival_confirmed", subjectId: PLACE, observedAt: new Date("2026-08-25T22:10:00Z").toISOString() },
      { verb: "entry_succeeded", subjectId: PLACE, observedAt: new Date("2026-08-25T22:11:00Z").toISOString() },
    ]);
    assert.equal(link.arrivals, 0);
    assert.equal(link.completions, 0);
    assert.equal(link.rejections, 0);
    assert.equal(link.ignoredNonOutcome, 2, "phantom vocabulary is surfaced, not swallowed");
  });

  it("an unparseable declaration time matches nothing (fail-closed)", () => {
    const link = linkTrailOutcomes(PLACE, "soho", "not-a-date", [
      { verb: "arrival", subjectId: PLACE, observedAt: new Date("2026-08-25T22:10:00Z").toISOString() },
    ]);
    assert.equal(link.arrivals, 0);
    assert.equal(link.ignoredNonOutcome, 0);
  });
});

describe("IG-06 — AT-10 blocked viewer sees no Trail contribution", () => {
  it("filters rows whose actor is in the viewer's bidirectional blocked set", () => {
    const rows = [{ actorId: "a" }, { actorId: "blocked" }, { actorId: "c" }];
    const visible = visibleTrailRows(rows, new Set(["blocked"]));
    assert.deepEqual(visible.map((r) => r.actorId), ["a", "c"]);
  });
});
