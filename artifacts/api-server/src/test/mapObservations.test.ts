/**
 * §22 Map Contributions ingest — the rules, in the order they would hurt.
 *
 * The route (src/routes/mapObservations.ts) is a façade: it translates a client
 * `MapContribution` into a `CaptureInput` and hands it to the ONE capture
 * pipeline. So these tests are not about storage mechanics — they are about the
 * four ways a capture surface goes wrong:
 *
 *   1. it writes truth instead of evidence,
 *   2. a reward makes something look more true,
 *   3. it captures without consent,
 *   4. it believes the body about who is contributing.
 *
 * Everything runs in memory against a fake supabase client (the shape used by
 * intelCapture.test.ts, widened to return arrays for list selects so the REAL
 * projection aggregator can be driven through it). Nothing is mocked out of the
 * path under test: writeObservation, hasValidIntelConsent, assembleClaimInput,
 * deriveComponents, scoreConfidence and recordEarnedReward are all the shipping
 * implementations.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_TO_CROWD_LEVEL,
  CLOSURE_STATES,
  CROWD_DIRECTIONS,
  ENTRY_ACCESS_STATES,
  EVENT_STATUS_STATES,
  KIND_PROMPTS,
  MAP_CONTRIBUTION_KINDS,
  MEDIA_KINDS,
  QUEUE_LEVELS,
  SUPPORTED_CONTRIBUTION_KINDS,
  UNSUPPORTED_CONTRIBUTION_KINDS,
  VIBE_STATES,
  deriveIdempotencyKey,
  ingestMapContribution,
  isPromptAllowed,
  mapContributionSchema,
  mapContributionToClaim,
} from "../routes/mapObservations.js";
import { ACTIVITY_LEVELS, MAP_OBJECT_KINDS } from "../lib/mapObjects.js";
import {
  CLAIM_TYPES,
  CROWD_LEVELS,
  TRAJECTORIES,
  claimTypeLiveLabelRuling,
  IDEMPOTENCY_KEY_PATTERN,
  SPECIALIST_ONLY_CROWD_LEVELS,
} from "../lib/intelContracts.js";
import { PHASE1_CAPTURE_CLAIM_TYPES, validateClaimValue } from "../lib/quickSignal.js";
import { assembleClaimInput } from "../lib/intelProjectionAggregator.js";
import { scoreConfidence } from "../lib/confidenceScore.js";
import { invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { recordEarnedReward } from "../services/intel/RewardService.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ACTOR_B = "11111111-1111-4111-8111-111111111112";
const ACTOR_C = "11111111-1111-4111-8111-111111111113";
const PLACE = "22222222-2222-4222-8222-222222222222";
const PLACE_2 = "22222222-2222-4222-8222-222222222223";
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString();

// ── Fake supabase client ──────────────────────────────────────────────────────
//
// Rows are real rows in real tables; the filters are applied generically rather
// than special-cased per caller, so a query the route did not anticipate cannot
// accidentally be answered "correctly". `writes` records every table an insert
// touched — the "an observation is not a claim" test asserts against it.

interface FakeOpts {
  places?: string[];
  /** actor -> consent state. Absent actor = NO consent row (fail-closed). */
  consent?: Record<string, boolean | "withdrawn">;
}

function makeDb(flags: Record<string, boolean>, opts: FakeOpts = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled })),
    places: (opts.places ?? []).map((id) => ({ id })),
    intel_contribution_consent: Object.entries(opts.consent ?? {}).map(([user_id, state]) => ({
      user_id,
      enabled: state !== false,
      withdrawn_at: state === "withdrawn" ? new Date().toISOString() : null,
    })),
    freshness_policies: CLAIM_TYPES.map((c) => ({
      claim_type: c.claimType,
      ttl_seconds: c.ttlSeconds,
      note: c.note,
    })),
    intel_observations: [],
    intel_claims: [],
    intel_confirmations: [],
    intel_reward_ledger: [],
  };
  const writes: Record<string, number> = {};
  let seq = 0;

  function from(table: string) {
    let op: "select" | "insert" | "insert_select" | "update" | "update_select" = "select";
    let payload: any = null;
    const filters: Array<{ col: string; val: any; kind: string }> = [];

    const match = (row: any) =>
      filters.every((f) => {
        const cell = row[f.col];
        switch (f.kind) {
          case "in": return (f.val as any[]).includes(cell);
          case "is": return (cell ?? null) === f.val;
          case "lte": return String(cell ?? "") <= String(f.val);
          case "gte": return String(cell ?? "") >= String(f.val);
          default: return cell === f.val;
        }
      });

    function run(): { data: any; error: any } {
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        const row = { id: `row-${++seq}`, schema_version: 1, created_at: new Date().toISOString(), ...payload };
        // The real unique indexes, emulated: (actor_id, idempotency_key) on both
        // the observation store and the reward ledger.
        const dup =
          (table === "intel_observations" &&
            store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key)) ||
          (table === "intel_reward_ledger" &&
            row.idempotency_key != null &&
            store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key));
        if (dup) return { data: null, error: { code: "23505", message: "duplicate key" } };
        store.push(row);
        writes[table] = (writes[table] ?? 0) + 1;
        return { data: op === "insert_select" ? row : null, error: null };
      }
      if (op === "update" || op === "update_select") {
        const updated: any[] = [];
        for (const r of store) if (match(r)) { Object.assign(r, payload); updated.push(r); }
        return { data: op === "update_select" ? updated : null, error: null };
      }
      return { data: store.filter(match), error: null };
    }

    /** A list select resolves to rows; single/maybeSingle to the first row or null. */
    const first = () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    };

    const b: any = {
      select() { op = op === "insert" ? "insert_select" : op === "update" ? "update_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(patch: any) { op = "update"; payload = patch; return b; },
      eq(col: string, val: any) { filters.push({ col, val, kind: "eq" }); return b; },
      in(col: string, val: any[]) { filters.push({ col, val, kind: "in" }); return b; },
      is(col: string, val: any) { filters.push({ col, val, kind: "is" }); return b; },
      lte(col: string, val: any) { filters.push({ col, val, kind: "lte" }); return b; },
      gte(col: string, val: any) { filters.push({ col, val, kind: "gte" }); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return Promise.resolve(first()); },
      single() { return Promise.resolve(first()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }

  return { from, _tables: tables, _writes: writes } as unknown as SupabaseClient & { _tables: typeof tables; _writes: typeof writes };
}

/** Every gate open: both flags on, the place exists, consent granted. */
function openDb(actors: string[] = [ACTOR], places: string[] = [PLACE]) {
  const consent: Record<string, boolean | "withdrawn"> = {};
  for (const a of actors) consent[a] = true;
  return makeDb(
    { map_contributions_enabled: true, intel_capture_quick_signal: true, intel_rewards: true },
    { places, consent },
  );
}

const contribution = (over: Record<string, unknown> = {}) => ({
  objectId: PLACE,
  objectKind: "place",
  kind: "crowd_level",
  value: "busy",
  observedAt: OBSERVED,
  ...over,
});

// ── A. The §22 prompt set ─────────────────────────────────────────────────────

describe("the §22 prompt set", () => {
  it("is exactly the eight prompts the spec names, in the spec's order", () => {
    assert.deepEqual([...MAP_CONTRIBUTION_KINDS], [
      "crowd_level", "queue", "entry_access", "vibe",
      "event_status", "closure", "crowd_direction", "media",
    ]);
  });

  it("partitions cleanly into supported and refused — no prompt is unaccounted for", () => {
    const supported = new Set<string>(SUPPORTED_CONTRIBUTION_KINDS);
    const refused = new Set(Object.keys(UNSUPPORTED_CONTRIBUTION_KINDS));
    for (const kind of MAP_CONTRIBUTION_KINDS) {
      assert.equal(
        supported.has(kind) !== refused.has(kind),
        true,
        `${kind} must be exactly one of supported / refused — a prompt in neither is a silent hole`,
      );
    }
    assert.equal(supported.size + refused.size, MAP_CONTRIBUTION_KINDS.length);
  });

  it("gives every refusal a written reason", () => {
    for (const [kind, why] of Object.entries(UNSUPPORTED_CONTRIBUTION_KINDS)) {
      assert.ok(why.length > 20, `${kind} needs a real reason, not a placeholder`);
    }
  });
});

// ── B. Prompt → canonical claim ───────────────────────────────────────────────

describe("prompt → canonical claim", () => {
  it("only ever emits a Phase-1 capture claim type", () => {
    for (const kind of SUPPORTED_CONTRIBUTION_KINDS) {
      for (const value of optionsFor(kind)) {
        const mapped = mapContributionToClaim(kind, value);
        assert.ok(mapped, `${kind}/${value} must map`);
        assert.ok(
          PHASE1_CAPTURE_CLAIM_TYPES.includes(mapped!.claimType),
          `${mapped!.claimType} is not a claim type the capture surface may emit`,
        );
      }
    }
  });

  it("produces values the CANONICAL validator accepts — the route invents no vocabulary", () => {
    for (const kind of SUPPORTED_CONTRIBUTION_KINDS) {
      for (const value of optionsFor(kind)) {
        const mapped = mapContributionToClaim(kind, value)!;
        assert.equal(
          validateClaimValue(mapped.claimType, mapped.value),
          true,
          `${kind}/${value} → ${mapped.claimType} ${JSON.stringify(mapped.value)} failed lib/quickSignal's validator`,
        );
      }
    }
  });

  it("maps crowd_level order-preservingly and can never reach unsafe_density", () => {
    const rank = (l: string) => CROWD_LEVELS.indexOf(l as any);
    let previous = -1;
    for (const level of ACTIVITY_LEVELS) {
      const mapped = ACTIVITY_TO_CROWD_LEVEL[level];
      assert.ok(CROWD_LEVELS.includes(mapped), `${level} → ${mapped} is not a canonical crowd level`);
      assert.equal(
        SPECIALIST_ONLY_CROWD_LEVELS.includes(mapped),
        false,
        "a specialist-only safety level must be unreachable from a one-tap map prompt",
      );
      assert.ok(rank(mapped) >= previous, `${level} broke the ordering`);
      previous = rank(mapped);
    }
  });

  it("keeps queue bands contiguous and open-ended at the top", () => {
    assert.deepEqual(mapContributionToClaim("queue", "none")!.value, { minMinutes: 0, maxMinutes: 0 });
    assert.deepEqual(mapContributionToClaim("queue", "over_30m")!.value, { minMinutes: 30, maxMinutes: null });
    let edge = 0;
    for (const band of QUEUE_LEVELS.slice(1)) {
      const v = mapContributionToClaim("queue", band)!.value as { minMinutes: number; maxMinutes: number | null };
      assert.equal(v.minMinutes, edge, `${band} does not continue from the previous band`);
      edge = v.maxMinutes ?? edge;
    }
  });

  it("treats a line at the door as walk-in ACCEPTED, and the three refusals as not", () => {
    const accepted = (s: string) => (mapContributionToClaim("entry_access", s)!.value as any).accepted;
    assert.equal(accepted("walk_straight_in"), true);
    assert.equal(accepted("line_at_door"), true); // a queue is not a refusal; queue.wait says how long
    assert.equal(accepted("guest_list_only"), false);
    assert.equal(accepted("at_capacity"), false);
    assert.equal(accepted("entry_closed"), false);
  });

  it("refuses every prompt with no canonical claim rather than inventing one", () => {
    // Today that is `media` alone, and the refusal is a ruling (a photo asserts
    // no proposition), not a gap waiting to be filled. This loop is written over
    // the constant so it keeps testing whatever the refusal set actually is.
    assert.ok(Object.keys(UNSUPPORTED_CONTRIBUTION_KINDS).length > 0,
      "an empty refusal set would make this assertion vacuous");
    for (const kind of Object.keys(UNSUPPORTED_CONTRIBUTION_KINDS)) {
      for (const value of optionsFor(kind)) {
        assert.equal(mapContributionToClaim(kind, value), null, `${kind}/${value} must not map`);
      }
    }
  });

  it("never turns a crowd DIRECTION into a crowd TRAJECTORY", () => {
    // Direction of flow and trajectory of intensity are different facts. Storing
    // 'arriving' as 'building' would publish an inference nobody made. The
    // prompt is now supported — but under its OWN claim type, with its own value
    // key, so the two claims cannot be confused by a reader or a query.
    for (const direction of CROWD_DIRECTIONS) {
      const mapped = mapContributionToClaim("crowd_direction", direction);
      assert.ok(mapped, `${direction} must map`);
      assert.equal(mapped!.claimType, "crowd.direction");
      assert.notEqual(mapped!.claimType, "crowd.trajectory");
      assert.deepEqual(mapped!.value, { direction });
      assert.equal((mapped!.value as any).trajectory, undefined,
        "a direction claim must not carry a trajectory key");
      // And no direction is a TRAJECTORIES value wearing a different label.
      assert.equal((TRAJECTORIES as readonly string[]).includes(direction), false,
        `'${direction}' must not be a trajectory value`);
    }
  });

  it("gives each newly supported prompt its own claim type and its own value key", () => {
    // One prompt, one claim type, one key naming the fact. Two prompts sharing a
    // claim type would make their answers contradict each other about one fact.
    const expected: Record<string, { claimType: string; key: string }> = {
      vibe: { claimType: "vibe.state", key: "state" },
      event_status: { claimType: "event.status", key: "status" },
      closure: { claimType: "closure.state", key: "state" },
      crowd_direction: { claimType: "crowd.direction", key: "direction" },
    };
    const seen = new Set<string>();
    for (const [kind, { claimType, key }] of Object.entries(expected)) {
      assert.ok(SUPPORTED_CONTRIBUTION_KINDS.includes(kind as any), `${kind} must be supported`);
      for (const value of optionsFor(kind)) {
        const mapped = mapContributionToClaim(kind, value)!;
        assert.equal(mapped.claimType, claimType, `${kind}/${value}`);
        assert.deepEqual(Object.keys(mapped.value), [key], `${kind} must carry exactly { ${key} }`);
        assert.equal((mapped.value as any)[key], value, "the option IS the value — nothing is translated");
      }
      assert.equal(seen.has(claimType), false, `${claimType} is claimed by two prompts`);
      seen.add(claimType);
    }
  });

  it("accepts a permanent-closure report but never lets it render live", () => {
    // Refusing the value would break the client round trip and lose a real
    // report; rendering it live would let one stranger's tap take a living
    // business off the map. Capture it, bar the label.
    const mapped = mapContributionToClaim("closure", "permanently_closed")!;
    assert.equal(mapped.claimType, "closure.state");
    assert.deepEqual(mapped.value, { state: "permanently_closed" });
    for (const state of CLOSURE_STATES) {
      assert.equal(claimTypeLiveLabelRuling("closure.state", { state }), "never", state);
    }
    assert.equal(claimTypeLiveLabelRuling("event.status", { status: "cancelled" }), "never");
    assert.equal(claimTypeLiveLabelRuling("event.status", { status: "under_way" }), "eligible");
    assert.equal(claimTypeLiveLabelRuling("vibe.state", { state: "going_off" }), "eligible");
    assert.equal(claimTypeLiveLabelRuling("crowd.direction", { direction: "arriving" }), "eligible");
  });

  it("refuses an option outside the prompt's vocabulary", () => {
    assert.equal(mapContributionToClaim("crowd_level", "apocalyptic"), null);
    assert.equal(mapContributionToClaim("queue", "forever"), null);
    assert.equal(mapContributionToClaim("not_a_prompt", "busy"), null);
  });
});

function optionsFor(kind: string): readonly string[] {
  switch (kind) {
    case "crowd_level": return ACTIVITY_LEVELS;
    case "queue": return QUEUE_LEVELS;
    case "entry_access": return ENTRY_ACCESS_STATES;
    case "vibe": return VIBE_STATES;
    case "event_status": return EVENT_STATUS_STATES;
    case "closure": return CLOSURE_STATES;
    case "crowd_direction": return CROWD_DIRECTIONS;
    case "media": return MEDIA_KINDS;
    default: return [];
  }
}

// ── C. Prompt eligibility ─────────────────────────────────────────────────────

describe("prompt eligibility per object kind", () => {
  it("covers every map object kind — a new kind cannot default to permitted", () => {
    for (const kind of MAP_OBJECT_KINDS) {
      assert.ok(Array.isArray(KIND_PROMPTS[kind]), `${kind} has no prompt rule`);
    }
  });

  it("allows nothing on people, safety, memory or a forecast", () => {
    for (const objectKind of ["crew_member", "buddy_zone", "safety_notice", "memory", "prediction"] as const) {
      for (const prompt of MAP_CONTRIBUTION_KINDS) {
        assert.equal(isPromptAllowed(objectKind, prompt), false, `${prompt} must not be offered on a ${objectKind}`);
      }
    }
  });

  it("refuses door-and-queue prompts on an area", () => {
    assert.equal(isPromptAllowed("activity_zone", "queue"), false);
    assert.equal(isPromptAllowed("activity_zone", "entry_access"), false);
    assert.equal(isPromptAllowed("crowd_flow", "crowd_level"), false);
    assert.equal(isPromptAllowed("place", "queue"), true);
  });
});

// ── D. Idempotency ────────────────────────────────────────────────────────────

describe("derived idempotency key", () => {
  it("conforms to the contract's pattern despite the prompt vocabulary's underscores", () => {
    for (const kind of SUPPORTED_CONTRIBUTION_KINDS) {
      for (const value of optionsFor(kind)) {
        const key = deriveIdempotencyKey(PLACE, kind, value, OBSERVED);
        assert.match(key, IDEMPOTENCY_KEY_PATTERN, `${kind}/${value} produced an invalid key: ${key}`);
        assert.ok(key.length <= 128);
      }
    }
  });

  it("is stable for a double-tap of the same answer, and different for a corrected one", () => {
    const a = deriveIdempotencyKey(PLACE, "crowd_level", "busy", OBSERVED);
    const b = deriveIdempotencyKey(PLACE, "crowd_level", "busy", OBSERVED);
    const corrected = deriveIdempotencyKey(PLACE, "crowd_level", "peak", OBSERVED);
    assert.equal(a, b, "a double-tap must dedupe");
    assert.notEqual(a, corrected, "a corrected answer must NOT be swallowed as a replay");
  });

  it("is per-object", () => {
    assert.notEqual(
      deriveIdempotencyKey(PLACE, "crowd_level", "busy", OBSERVED),
      deriveIdempotencyKey(PLACE_2, "crowd_level", "busy", OBSERVED),
    );
  });
});

// ── E. The gate chain ─────────────────────────────────────────────────────────

describe("ingest — the flag gates, and neither of them alone is enough", () => {
  it("map flag OFF is an inert no-op", async () => {
    const db = makeDb({ map_contributions_enabled: false, intel_capture_quick_signal: true },
      { places: [PLACE], consent: { [ACTOR]: true } });
    const r = await ingestMapContribution(db, ACTOR, contribution());
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "feature_disabled");
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("cannot bypass the intel capture gate by arriving from the map", async () => {
    // map_contributions_enabled ON, intel_capture_quick_signal OFF. If the map
    // route had its own storage path this would store a row; it must not.
    const db = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: false },
      { places: [PLACE], consent: { [ACTOR]: true } });
    const r = await ingestMapContribution(db, ACTOR, contribution());
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "disabled");
    assert.equal(db._tables.intel_observations.length, 0);
  });
});

describe("ingest — consent gates capture, fail-closed", () => {
  it("refuses with no consent row at all", async () => {
    const db = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: true },
      { places: [PLACE], consent: {} });
    const r = await ingestMapContribution(db, ACTOR, contribution());
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "consent_required");
    assert.equal((r as any).code, "forbidden"); // 403, the D4 lawful-basis refusal
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("refuses a disabled consent row", async () => {
    const db = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: true },
      { places: [PLACE], consent: { [ACTOR]: false } });
    assert.equal(((await ingestMapContribution(db, ACTOR, contribution())) as any).reason, "consent_required");
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("refuses a WITHDRAWN consent — withdrawal takes effect on the next capture", async () => {
    const db = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: true },
      { places: [PLACE], consent: { [ACTOR]: "withdrawn" } });
    assert.equal(((await ingestMapContribution(db, ACTOR, contribution())) as any).reason, "consent_required");
    assert.equal(db._tables.intel_observations.length, 0);
  });
});

describe("ingest — the actor comes from the token", () => {
  it("REFUSES a body that carries an actor field rather than silently stripping it", async () => {
    const db = openDb();
    for (const smuggled of ["actorId", "userId", "user_id", "contributorId", "actor"]) {
      const r = await ingestMapContribution(db, ACTOR, contribution({ [smuggled]: ACTOR_B }));
      assert.equal(r.ok, false, `${smuggled} must be refused`);
      assert.equal((r as any).reason, "invalid_payload");
    }
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("REFUSES a body that carries a reward, payment or sponsorship field", async () => {
    const db = openDb();
    for (const smuggled of ["reward", "paid", "sponsored", "credits", "commercial_disclosure"]) {
      const r = await ingestMapContribution(db, ACTOR, contribution({ [smuggled]: true }));
      assert.equal(r.ok, false, `${smuggled} must be refused`);
    }
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("stamps the row with the caller's id", async () => {
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, contribution());
    assert.equal(r.ok, true);
    assert.equal(db._tables.intel_observations[0].actor_id, ACTOR);
  });
});

describe("ingest — payload validation", () => {
  it("rejects a kind the client does not define", async () => {
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, contribution({ kind: "rating", value: "5" }));
    assert.equal(r.ok, false);
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("rejects an off-vocabulary value", async () => {
    const db = openDb();
    assert.equal((await ingestMapContribution(db, ACTOR, contribution({ value: "apocalyptic" }))).ok, false);
  });

  it("rejects a prompt that is not applicable to the object", async () => {
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, contribution({ objectKind: "safety_notice" }));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "prompt_not_allowed");
  });

  it("refuses a media contribution instead of opening a second media path", async () => {
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, {
      objectId: PLACE, objectKind: "place", kind: "media", value: "photo",
      mediaUri: "file:///tmp/x.jpg", observedAt: OBSERVED,
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unsupported_kind");
    assert.equal(db._tables.intel_observations.length, 0);
    // And nothing resembling the asset was stored anywhere.
    assert.equal(JSON.stringify(db._tables).includes("file:///tmp/x.jpg"), false);
  });

  it("rejects a future observed_at through the contract's clamp", async () => {
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, contribution({ observedAt: new Date(Date.now() + 600_000).toISOString() }));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "invalid_observed_at");
  });

  it("surfaces a subject that is not a place as a clean refusal, never an FK 500", async () => {
    const db = openDb([ACTOR], []); // places empty, as production is today
    const r = await ingestMapContribution(db, ACTOR, contribution());
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unknown_subject");
    assert.equal((r as any).code, "not_found");
  });
});

// ── The load-bearing invariant ────────────────────────────────────────────────

describe("an observation is NOT a claim", () => {
  it("writes exactly one observation and touches no other table", async () => {
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, contribution());
    assert.equal(r.ok, true);

    assert.deepEqual(Object.keys(db._writes), ["intel_observations"],
      "the ingest must write ONLY the observation store — a claim, a snapshot or a ledger entry here would be the defect");
    assert.equal(db._tables.intel_observations.length, 1);
    assert.equal(db._tables.intel_claims.length, 0);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
    assert.equal(db._tables.intel_state_snapshot, undefined, "the projection is the sole snapshot writer");
  });

  it("stores no confidence, band, score or live value on the row", async () => {
    const db = openDb();
    await ingestMapContribution(db, ACTOR, contribution());
    const row = db._tables.intel_observations[0];
    for (const key of Object.keys(row)) {
      assert.doesNotMatch(key, /confidence|band|score|live|published|truth/i,
        `an observation row must not carry ${key}`);
    }
  });

  it("carries the fail-closed defaults that keep one tap from reading as truth", async () => {
    const db = openDb();
    await ingestMapContribution(db, ACTOR, contribution());
    const row = db._tables.intel_observations[0];
    assert.equal(row.capture_surface, "quick_signal");
    assert.equal(row.visibility, "private", "a map tap is not consent to publish");
    assert.equal(row.presence_level, "P0", "no proximity proof in a §22 payload ⇒ presence scores 0");
    assert.equal(row.source_class, "firsthand_unverified");
    assert.equal(row.moderation_state, "pending");
    assert.equal(row.commercial_disclosure, "none");
    assert.equal(row.group_key, null, "no party attestation ⇒ counts as a person, never an independent group");
    assert.ok(row.expires_at, "the claim TTL bounds the observation's life");
  });

  it("returns an envelope that never claims the map now says this", async () => {
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, contribution());
    assert.equal(r.ok, true);
    const obs = (r as any).observation;
    assert.equal(obs.claim_type, "crowd.level");
    assert.deepEqual(obs.value, { level: "busy" });
    assert.equal((obs as any).confidence, undefined);
  });

  it("dedupes a double-tap and does not append a second observation", async () => {
    const db = openDb();
    await ingestMapContribution(db, ACTOR, contribution());
    const again = await ingestMapContribution(db, ACTOR, contribution());
    assert.equal(again.ok, true);
    assert.equal((again as any).deduped, true);
    assert.equal(db._tables.intel_observations.length, 1);
  });

  it("records a CORRECTED answer as a new observation, not a rewrite", async () => {
    const db = openDb();
    await ingestMapContribution(db, ACTOR, contribution({ value: "busy" }));
    const corrected = await ingestMapContribution(db, ACTOR, contribution({ value: "peak" }));
    assert.equal(corrected.ok, true);
    assert.equal((corrected as any).deduped, false);
    assert.equal(db._tables.intel_observations.length, 2);
    assert.deepEqual(db._tables.intel_observations.map((o: any) => o.value.level), ["busy", "packed"]);
  });
});

// ── F. Rewards must never raise confidence ────────────────────────────────────
//
// §22 / §37: "Rewards may incentivize participation but must never increase
// factual confidence merely because the contribution was paid."
//
// The proof is a comparison, not an assertion about intent. Two places receive
// the SAME evidence — three contributors, same answer, same instant, same
// presence. Every contributor to one of them is then paid a large reward into
// intel_reward_ledger. Both are scored through the shipping aggregator and the
// shipping confidence formula. The components and the score must be identical.

describe("rewards cannot raise confidence", () => {
  /** Contribute the same crowd_level from three actors to one place. */
  async function contributeTo(db: any, place: string, actors: string[]) {
    for (const actor of actors) {
      const r = await ingestMapContribution(db, actor, contribution({ objectId: place, value: "busy" }));
      assert.equal(r.ok, true, `contribution by ${actor} to ${place} failed: ${JSON.stringify(r)}`);
    }
  }

  /** Book a large non-cash reward for each actor. */
  async function payAll(db: any, actors: string[]) {
    for (const actor of actors) {
      const paid = await recordEarnedReward(db, actor, {
        qiu: 1,
        source: "outcome",
        ledgerVersion: "v1",
        idempotencyKey: `map-reward-${actor}`,
        eligibility: {
          commercialUsePermission: true,
          fundingSourceKnown: true,
          ledgerVersion: "v1",
          fraudHold: false,
          outcomeFinalized: true,
        },
      });
      assert.equal(paid.ok, true, `the reward must actually be booked, or this test is vacuous: ${JSON.stringify(paid)}`);
    }
  }

  const claimFor = (subjectId: string) => ({
    id: `claim-${subjectId}`,
    subject_id: subjectId,
    zone_id: null,
    claim_type: "crowd.level",
    value: { level: "busy" },
    status: "active",
    observed_at: OBSERVED,
  });

  it("a heavily rewarded cohort and an unpaid one score identically", async () => {
    invalidateFreshnessPolicyCache();
    const actors = [ACTOR, ACTOR_B, ACTOR_C];
    const db = openDb(actors, [PLACE, PLACE_2]);

    // PLACE is the paid one, PLACE_2 the unpaid one. Identical evidence.
    await contributeTo(db, PLACE, actors);
    await contributeTo(db, PLACE_2, actors);
    await payAll(db, actors);

    // Vacuity guard: the reward really was booked, and it is a real amount.
    assert.equal(db._tables.intel_reward_ledger.length, 3);
    assert.ok(db._tables.intel_reward_ledger.every((e: any) => e.earned_units > 0));
    assert.ok(db._tables.intel_reward_ledger.every((e: any) => e.cash_amount === 0), "never cash");

    const now = new Date();
    const paidInput = await assembleClaimInput(db, claimFor(PLACE), now);
    const freeInput = await assembleClaimInput(db, claimFor(PLACE_2), now);

    // Vacuity guard: the evidence really was assembled from real observations.
    assert.equal(paidInput.distinctActors, 3);
    assert.equal(freeInput.distinctActors, 3);

    assert.deepEqual(paidInput.components, freeInput.components,
      "a paid contribution produced different evidence components from an identical unpaid one");
    assert.deepEqual(paidInput.penalties, freeInput.penalties);

    const paidScore = scoreConfidence(paidInput.components, paidInput.penalties);
    const freeScore = scoreConfidence(freeInput.components, freeInput.penalties);
    assert.deepEqual(paidScore, freeScore,
      "confidence differed between a rewarded and an unrewarded contribution");
    assert.ok(paidScore.confidence > 0, "a vacuous zero on both sides would prove nothing");
  });

  it("paying MORE changes nothing — there is no channel from the ledger to the score", async () => {
    invalidateFreshnessPolicyCache();
    const actors = [ACTOR, ACTOR_B, ACTOR_C];
    const db = openDb(actors, [PLACE, PLACE_2]);
    await contributeTo(db, PLACE, actors);
    await contributeTo(db, PLACE_2, actors);

    // The SAME `now` for both reads: freshness is a function of the clock, and
    // this test is about the ledger, not about time passing between two calls.
    const now = new Date();
    const before = await assembleClaimInput(db, claimFor(PLACE), now);

    // Book ten large earnings against the paid place's contributors.
    for (let i = 0; i < 10; i++) {
      for (const actor of actors) {
        await recordEarnedReward(db, actor, {
          qiu: 5, source: "mission", ledgerVersion: "v1", idempotencyKey: `bulk-${i}-${actor}`,
          eligibility: {
            commercialUsePermission: true, fundingSourceKnown: true,
            ledgerVersion: "v1", fraudHold: false, outcomeFinalized: true,
          },
        });
      }
    }
    assert.equal(db._tables.intel_reward_ledger.length, 30);

    const after = await assembleClaimInput(db, claimFor(PLACE), now);
    assert.deepEqual(after.components, before.components);
    assert.deepEqual(
      scoreConfidence(after.components, after.penalties).confidence,
      scoreConfidence(before.components, before.penalties).confidence,
    );
  });

  it("the observation row carries no key a reward could travel on", async () => {
    const db = openDb();
    await ingestMapContribution(db, ACTOR, contribution());
    const row = db._tables.intel_observations[0];
    for (const key of Object.keys(row)) {
      assert.doesNotMatch(key, /reward|ledger|paid|payment|cash|credit|sponsor|incentiv/i,
        `an observation must not carry ${key} — that would be the channel §22 forbids`);
    }
  });

  it("the confidence formula has no reward input at all", async () => {
    invalidateFreshnessPolicyCache();
    const db = openDb([ACTOR], [PLACE]);
    await contributeTo(db, PLACE, [ACTOR]);
    const input = await assembleClaimInput(db, claimFor(PLACE), new Date());
    assert.deepEqual(Object.keys(input.components).sort(), [
      "agreement", "evidenceQuality", "freshness", "independence",
      "presence", "sourceReliability", "specificity",
    ]);
  });
});

// ── Schema sanity ─────────────────────────────────────────────────────────────

describe("the payload schema is the client's MapContribution", () => {
  it("accepts every enumerated answer of every prompt", () => {
    for (const kind of MAP_CONTRIBUTION_KINDS) {
      for (const value of optionsFor(kind)) {
        const body: Record<string, unknown> = {
          objectId: PLACE, objectKind: "place", kind, value, observedAt: OBSERVED,
        };
        if (kind === "media") body.mediaUri = "file:///x.jpg";
        assert.equal(mapContributionSchema.safeParse(body).success, true, `${kind}/${value} did not parse`);
      }
    }
  });

  it("requires a media contribution to carry its asset", () => {
    assert.equal(
      mapContributionSchema.safeParse({
        objectId: PLACE, objectKind: "place", kind: "media", value: "photo", observedAt: OBSERVED,
      }).success,
      false,
    );
  });

  it("rejects a non-uuid object id and a non-ISO observed time", () => {
    assert.equal(mapContributionSchema.safeParse(contribution({ objectId: "not-a-uuid" })).success, false);
    assert.equal(mapContributionSchema.safeParse(contribution({ observedAt: "yesterday" })).success, false);
  });
});
