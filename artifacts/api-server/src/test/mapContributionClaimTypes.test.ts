/**
 * The four §22 map-contribution claim types — the contract, end to end.
 *
 * WHAT THIS FILE IS FOR
 * =====================
 * `POST /api/map/observations` used to accept three of §22's eight prompts and
 * REFUSE the other five, each with a written reason. Four of those refusals are
 * now lifted, and lifting a refusal is exactly the kind of change that goes
 * wrong quietly: a claim type added to a validator but not to the registry is
 * capturable and never expires; a claim type added to the registry but not to a
 * migration is capturable and never live; a prompt mapped onto a claim type
 * that already exists publishes an inference nobody made. So the assertions
 * here are about the SEAMS, in the order they would hurt:
 *
 *   1. every new claim type has a TTL, a validator and a seeded policy row —
 *      all three, or the chain is broken somewhere invisible;
 *   2. the server's value domain is EXACTLY the client's, in both directions;
 *   3. crowd_direction did not become crowd.trajectory;
 *   4. a photo is still refused, and for the right reason;
 *   5. none of the §22 gates (consent, clamp, idempotency, strict schema, the
 *      double flag gate) was loosened to let the new prompts through.
 *
 * Everything runs in memory against a fake supabase client. Nothing on the path
 * under test is mocked: writeObservation, hasValidIntelConsent and the real
 * validators are the shipping implementations.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CLAIM_TYPES,
  CLAIM_TYPE_LIVE_LABEL_RULING,
  CLOSURE_STATES,
  CROWD_DIRECTIONS,
  EVENT_STATUS_STATES,
  LEGACY_CLAIM_TYPES,
  MAP_CONTRIBUTION_CLAIM_TYPES,
  NEVER_LIVE_CLAIM_VALUES,
  PHASE1_CLAIM_TYPES,
  STRUCTURAL_CLOSURE_STATES,
  TRAJECTORIES,
  VIBE_STATES,
  claimTypeLiveLabelRuling,
} from "../lib/intelContracts.js";
import { PHASE1_CAPTURE_CLAIM_TYPES, VALUE_VALIDATORS, validateClaimValue } from "../lib/quickSignal.js";
import {
  MAP_CONTRIBUTION_KINDS,
  SUPPORTED_CONTRIBUTION_KINDS,
  UNSUPPORTED_CONTRIBUTION_KINDS,
  ingestMapContribution,
  mapContributionSchema,
  mapContributionToClaim,
} from "../routes/mapObservations.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_2253 = readFileSync(join(HERE, "../migrations/2253_map_contribution_claim_types.sql"), "utf8");
const MIGRATION_2128 = readFileSync(join(HERE, "../migrations/2128_intel_contracts_seed.sql"), "utf8");
/**
 * The CLIENT's vocabulary, read as TEXT. The server cannot import the React
 * Native module, and restating the arrays in this test would only prove the
 * test agrees with itself. Reading the source is the only way this assertion
 * can actually catch a drift.
 */
const CLIENT_LIVE_TRUTH = readFileSync(
  join(HERE, "../../../../travel-buddy-standalone/src/features/map/truth/liveTruth.ts"),
  "utf8",
);

/** The four claim types this unit introduced. */
const NEW_CLAIM_TYPES = ["crowd.direction", "vibe.state", "event.status", "closure.state"] as const;

/** Prompt → (claim type, value key, the option list). The whole contract, as data. */
//
// `objectKind` is the kind that legally takes the prompt (KIND_PROMPTS), and
// there is deliberately no single kind that takes all four: a place cannot have
// an event lifecycle, an event cannot "close" (that is `cancelled`), and the
// zone kinds that take crowd_direction are not rows in `places` at all, so a
// zone contribution resolves to `unknown_subject`. Today crowd_direction is
// therefore reachable in practice only on an event-shaped place.
const PROMPT_CONTRACT = [
  { kind: "vibe", objectKind: "place", claimType: "vibe.state", key: "state", options: VIBE_STATES, clientConst: "VIBE_STATES" },
  { kind: "event_status", objectKind: "event", claimType: "event.status", key: "status", options: EVENT_STATUS_STATES, clientConst: "EVENT_STATUS_STATES" },
  { kind: "closure", objectKind: "place", claimType: "closure.state", key: "state", options: CLOSURE_STATES, clientConst: "CLOSURE_STATES" },
  { kind: "crowd_direction", objectKind: "event", claimType: "crowd.direction", key: "direction", options: CROWD_DIRECTIONS, clientConst: "CROWD_DIRECTIONS" },
] as const;

// ── 1. The registry / validator / migration chain ─────────────────────────────

describe("every new claim type has a TTL, a validator and a policy row", () => {
  it("declares exactly the four the map prompts need", () => {
    assert.deepEqual(MAP_CONTRIBUTION_CLAIM_TYPES.map((c) => c.claimType).sort(), [...NEW_CLAIM_TYPES].sort());
  });

  it("is spliced into CLAIM_TYPES — the list ttlFor() and the projection ceiling read", () => {
    // A claim type absent from CLAIM_TYPES captures fine and then gets NO
    // expires_at and NO hard-expiry ceiling. That is the silent failure.
    assert.equal(CLAIM_TYPES.length, PHASE1_CLAIM_TYPES.length + MAP_CONTRIBUTION_CLAIM_TYPES.length);
    for (const c of MAP_CONTRIBUTION_CLAIM_TYPES) {
      assert.ok(CLAIM_TYPES.some((x) => x.claimType === c.claimType), `${c.claimType} missing from CLAIM_TYPES`);
    }
    const names = CLAIM_TYPES.map((c) => c.claimType);
    assert.equal(new Set(names).size, names.length, "a claim type is declared twice");
  });

  it("has a value validator for each, which makes the capture surface admit it", () => {
    for (const c of NEW_CLAIM_TYPES) {
      assert.equal(typeof VALUE_VALIDATORS[c], "function", `${c} has no validator`);
      assert.ok(PHASE1_CAPTURE_CLAIM_TYPES.includes(c), `${c} is not emittable by the capture surface`);
    }
  });

  it("keeps a coherent, dotted, positive TTL with a ceiling above it", () => {
    for (const c of MAP_CONTRIBUTION_CLAIM_TYPES) {
      assert.match(c.claimType, /^[a-z_]+\.[a-z_]+$/, `'${c.claimType}' is not a dotted key`);
      assert.ok(c.ttlSeconds > 0, `${c.claimType} ttl must be positive`);
      assert.ok(c.hardExpirySeconds >= c.ttlSeconds, `${c.claimType} ceiling is below its ttl`);
      assert.ok(c.note.length > 20, `${c.claimType} needs a real note`);
    }
  });

  it("did not default everything to fifteen minutes — each TTL is sized to its fact", () => {
    const ttl = (t: string) => CLAIM_TYPES.find((c) => c.claimType === t)!.ttlSeconds;

    // Flow is strictly more volatile than intensity: 'arriving' is what stops
    // the moment everyone has arrived. It must not outlive crowd.level.
    assert.ok(ttl("crowd.direction") < ttl("crowd.level"),
      "a crowd DIRECTION report must not outlive a crowd LEVEL report");

    // Atmosphere changes over a sitting, not over a song: the blueprint's own
    // 30-minute answer, kept rather than re-litigated.
    assert.equal(ttl("vibe.state"), 1800);

    // An event phase, and a closure, both outlive a crowd reading by a wide
    // margin — that is the whole point of not defaulting to the crowd TTL.
    assert.ok(ttl("event.status") > ttl("crowd.level"));
    assert.ok(ttl("closure.state") > ttl("event.status"));

    // But a closure is NOT structural. The flat 'structural' policy is 180 days
    // and is for owner/official hours-of-operation; a stranger's single tap must
    // decay within a day so the map stops asserting rather than repeats it.
    assert.ok(ttl("closure.state") <= 86400, "a crowd-sourced closure must decay within a day");
    assert.ok(
      CLAIM_TYPES.find((c) => c.claimType === "closure.state")!.hardExpirySeconds <= 86400,
      "and its ceiling must too",
    );

    // Four different facts, four different clocks.
    assert.equal(new Set(MAP_CONTRIBUTION_CLAIM_TYPES.map((c) => c.ttlSeconds)).size, 4);
  });
});

describe("migration 2220 mirrors the module, and owns only its own rows", () => {
  it("seeds every declared type with its declared TTL and ceiling", () => {
    for (const c of MAP_CONTRIBUTION_CLAIM_TYPES) {
      const row = new RegExp(
        `\\('${c.claimType.replace(".", "\\.")}',\\s*${c.ttlSeconds},\\s*${c.hardExpirySeconds},`,
      );
      assert.match(MIGRATION_2253, row, `2220 does not seed ${c.claimType} at ${c.ttlSeconds}/${c.hardExpirySeconds}`);
    }
  });

  it("seeds nothing else — every quoted claim type in the INSERT is declared", () => {
    const insert = MIGRATION_2253.slice(MIGRATION_2253.indexOf("INSERT INTO"));
    const body = insert.slice(0, insert.indexOf("ON CONFLICT"));
    const quoted = [...body.matchAll(/\('([a-z_.]+)',/g)].map((m) => m[1]);
    assert.ok(quoted.length > 0, "no rows found — the assertion would be vacuous");
    const declared = new Set<string>(MAP_CONTRIBUTION_CLAIM_TYPES.map((c) => c.claimType));
    for (const q of quoted) assert.ok(declared.has(q), `2220 seeds undeclared claim type '${q}'`);
    assert.equal(quoted.length, MAP_CONTRIBUTION_CLAIM_TYPES.length);
  });

  it("does not touch 2128's Phase-1 rows or 2122's flat rows", () => {
    // Three seed sites, deliberately disjoint. A merge here would make it
    // impossible to say which migration owed which row.
    for (const c of PHASE1_CLAIM_TYPES) {
      assert.equal(MIGRATION_2253.includes(`('${c.claimType}',`), false,
        `2220 re-seeds 2128's ${c.claimType}`);
    }
    for (const flat of LEGACY_CLAIM_TYPES) {
      assert.equal(MIGRATION_2253.includes(`('${flat}',`), false, `2220 re-seeds 2122's flat '${flat}'`);
    }
    for (const c of MAP_CONTRIBUTION_CLAIM_TYPES) {
      assert.equal(MIGRATION_2128.includes(`'${c.claimType}'`), false,
        `${c.claimType} is seeded by 2128 as well — the split is broken`);
    }
  });

  it("cannot clobber an owner-tuned TTL on re-apply", () => {
    const insert = MIGRATION_2253.slice(MIGRATION_2253.indexOf("INSERT INTO"));
    assert.match(insert, /ON CONFLICT[\s\S]*DO NOTHING/);
    assert.doesNotMatch(insert, /DO UPDATE/, "DO UPDATE reintroduces the 2122 clobber defect");
  });

  it("is additive — it drops no table and deletes no rows", () => {
    const body = MIGRATION_2253.split("-- REVERSAL")[0];
    assert.doesNotMatch(body, /\bDROP TABLE\b/i);
    assert.doesNotMatch(body, /\bDELETE FROM\b/i);
    assert.doesNotMatch(body, /\bTRUNCATE\b/i);
  });

  it("seeds no feature-flag row (a flag with no reader is dead config)", () => {
    assert.doesNotMatch(MIGRATION_2253, /INSERT INTO public\.feature_flags/);
  });
});

// ── 2. The value domain is exactly the client's ───────────────────────────────

describe("the server accepts exactly what the client can send", () => {
  it("declares the same option list the client's liveTruth.ts declares", () => {
    // Read from the client source, not restated here — a test that restates the
    // arrays only proves it agrees with itself.
    for (const { clientConst, options } of PROMPT_CONTRACT) {
      const m = new RegExp(`export const ${clientConst} = \\[([\\s\\S]*?)\\] as const;`).exec(CLIENT_LIVE_TRUTH);
      assert.ok(m, `could not find ${clientConst} in the client's liveTruth.ts`);
      const clientValues = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      assert.deepEqual(clientValues, [...options],
        `${clientConst} differs between client and server — the round trip is broken`);
    }
  });

  it("validates every client option, under the key that names the fact", () => {
    for (const { claimType, key, options } of PROMPT_CONTRACT) {
      for (const value of options) {
        assert.equal(validateClaimValue(claimType, { [key]: value }), true,
          `${claimType} rejected its own option '${value}'`);
      }
    }
  });

  it("refuses anything outside it — a foreign value, a wrong key, a missing key, a non-object", () => {
    for (const { claimType, key, options } of PROMPT_CONTRACT) {
      assert.equal(validateClaimValue(claimType, { [key]: "not_a_real_option" }), false, `${claimType} foreign value`);
      assert.equal(validateClaimValue(claimType, { wrong_key: options[0] }), false, `${claimType} wrong key`);
      assert.equal(validateClaimValue(claimType, {}), false, `${claimType} empty`);
      assert.equal(validateClaimValue(claimType, options[0]), false, `${claimType} bare string`);
      assert.equal(validateClaimValue(claimType, null), false, `${claimType} null`);
      assert.equal(validateClaimValue(claimType, [options[0]]), false, `${claimType} array`);
    }
  });

  it("does not let one prompt's vocabulary satisfy another's claim", () => {
    // The keys differ, so this is structural rather than a rule to remember —
    // but assert it, because the failure it prevents (a vibe stored as a
    // closure) is unrecoverable in an append-only store.
    for (const a of PROMPT_CONTRACT) {
      for (const b of PROMPT_CONTRACT) {
        if (a.claimType === b.claimType) continue;
        const crossed = validateClaimValue(b.claimType, { [a.key]: a.options[0] });
        if (a.key === b.key) {
          // same key name (state/state): the VALUE vocabulary must still refuse.
          assert.equal(crossed, false, `${a.claimType}'s '${a.options[0]}' validated as ${b.claimType}`);
        } else {
          assert.equal(crossed, false, `${a.claimType} value validated as ${b.claimType}`);
        }
      }
    }
  });
});

// ── 3. crowd_direction is not crowd.trajectory ────────────────────────────────

describe("a crowd DIRECTION is never a crowd TRAJECTORY", () => {
  it("uses its own claim type and its own value key", () => {
    for (const direction of CROWD_DIRECTIONS) {
      const mapped = mapContributionToClaim("crowd_direction", direction)!;
      assert.equal(mapped.claimType, "crowd.direction");
      assert.deepEqual(mapped.value, { direction });
    }
  });

  it("shares no value with the trajectory vocabulary, so neither validator accepts the other", () => {
    for (const direction of CROWD_DIRECTIONS) {
      assert.equal((TRAJECTORIES as readonly string[]).includes(direction), false);
      assert.equal(validateClaimValue("crowd.trajectory", { direction }), false);
      assert.equal(validateClaimValue("crowd.trajectory", { trajectory: direction }), false,
        `'${direction}' must not be accepted as a trajectory`);
    }
    for (const trajectory of TRAJECTORIES) {
      assert.equal(validateClaimValue("crowd.direction", { direction: trajectory }), false,
        `'${trajectory}' must not be accepted as a direction`);
    }
  });

  it("gets a shorter TTL than trajectory, because flow changes faster than intensity", () => {
    const ttl = (t: string) => CLAIM_TYPES.find((c) => c.claimType === t)!.ttlSeconds;
    assert.ok(ttl("crowd.direction") < ttl("crowd.trajectory"));
  });
});

// ── 4. Live-label eligibility ─────────────────────────────────────────────────

describe("being capturable is not being publishable", () => {
  it("bars a closure from ever carrying a live label, at every value", () => {
    for (const state of CLOSURE_STATES) {
      assert.equal(claimTypeLiveLabelRuling("closure.state", { state }), "never", state);
    }
    assert.equal(CLAIM_TYPE_LIVE_LABEL_RULING["closure.state"], "never");
    // The irreversible value is additionally named, because a TTL cannot make
    // it safe: unlike every other value here it does not decay.
    assert.deepEqual([...STRUCTURAL_CLOSURE_STATES], ["permanently_closed"]);
  });

  it("bars the one event value that asserts non-availability, and no other", () => {
    for (const status of EVENT_STATUS_STATES) {
      const expected = status === "cancelled" ? "never" : "eligible";
      assert.equal(claimTypeLiveLabelRuling("event.status", { status }), expected, status);
    }
    assert.deepEqual(NEVER_LIVE_CLAIM_VALUES["event.status"], ["cancelled"]);
  });

  it("leaves vibe and direction eligible — subjectivity and volatility are the score's job", () => {
    for (const state of VIBE_STATES) {
      assert.equal(claimTypeLiveLabelRuling("vibe.state", { state }), "eligible", state);
    }
    for (const direction of CROWD_DIRECTIONS) {
      assert.equal(claimTypeLiveLabelRuling("crowd.direction", { direction }), "eligible", direction);
    }
  });

  it("says 'unruled' for the claim types this unit did not rule on, rather than guessing", () => {
    // crowd.level ships a live label today, gated by intel_live_label_crowd.
    // Answering 'never' here would silently re-rule it; answering 'eligible'
    // would rule on twelve types this unit never examined.
    for (const c of PHASE1_CLAIM_TYPES) {
      assert.equal(claimTypeLiveLabelRuling(c.claimType, {}), "unruled", c.claimType);
    }
    assert.equal(claimTypeLiveLabelRuling("made.up", {}), "unruled");
  });

  it("bars a value even when the caller passes it bare or omits it", () => {
    assert.equal(claimTypeLiveLabelRuling("closure.state"), "never");
    assert.equal(claimTypeLiveLabelRuling("event.status", "cancelled"), "never");
    // An event.status with no readable value cannot be barred by value, so it
    // falls back to the type's ruling. The bar that matters — closure — is at
    // type level precisely so no value inspection is needed to enforce it.
    assert.equal(claimTypeLiveLabelRuling("event.status", undefined), "eligible");
  });
});

// ── 5. media stays refused ────────────────────────────────────────────────────

describe("a photo is evidence, not a claim", () => {
  it("is the only §22 prompt still refused, and the partition is total", () => {
    assert.deepEqual(Object.keys(UNSUPPORTED_CONTRIBUTION_KINDS), ["media"]);
    const supported = new Set<string>(SUPPORTED_CONTRIBUTION_KINDS);
    const refused = new Set(Object.keys(UNSUPPORTED_CONTRIBUTION_KINDS));
    for (const kind of MAP_CONTRIBUTION_KINDS) {
      assert.equal(supported.has(kind) !== refused.has(kind), true, `${kind} is in neither or both`);
    }
    assert.equal(supported.size + refused.size, MAP_CONTRIBUTION_KINDS.length);
  });

  it("gives the refusal a reason that says WHY, not 'not yet'", () => {
    const why = UNSUPPORTED_CONTRIBUTION_KINDS.media;
    assert.match(why, /evidence/i, "the reason must state the ruling, not a phase");
    assert.match(why, /intel_evidence/, "and name the table that is the right home");
    assert.doesNotMatch(why, /Phase-1 cut/, "'not in the Phase-1 cut' is a schedule, not a reason");
  });

  it("mints no claim type for media, and no mapping to one", () => {
    for (const c of CLAIM_TYPES) {
      assert.doesNotMatch(c.claimType, /^media\./, `${c.claimType} invents a claim for an asset`);
    }
    assert.equal(Object.keys(VALUE_VALIDATORS).some((k) => k.startsWith("media.")), false);
    for (const value of ["photo", "video"]) {
      assert.equal(mapContributionToClaim("media", value), null, `media/${value} must not map`);
    }
  });

  it("still REQUIRES the asset on the payload — the contract stays honest, the refusal stays loud", () => {
    const base = {
      objectId: PLACE, objectKind: "place" as const, kind: "media" as const,
      value: "photo" as const, observedAt: OBSERVED,
    };
    assert.equal(mapContributionSchema.safeParse(base).success, false, "mediaUri is not optional");
    assert.equal(mapContributionSchema.safeParse({ ...base, mediaUri: "file:///x.jpg" }).success, true);
  });
});

// ── 6. Nothing was loosened to let the new prompts through ────────────────────

const ACTOR = "44444444-4444-4444-8444-444444444441";
const PLACE = "55555555-5555-4555-8555-555555555551";
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString();

interface FakeOpts {
  places?: string[];
  consent?: Record<string, boolean | "withdrawn">;
}

/** The fake store, filters applied generically so an unanticipated query cannot
 *  accidentally be answered "correctly". */
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
      claim_type: c.claimType, ttl_seconds: c.ttlSeconds, note: c.note,
    })),
    intel_observations: [],
    intel_claims: [],
  };
  const writes: Record<string, number> = {};
  let seq = 0;

  function from(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
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
        const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...payload };
        if (table === "intel_observations" &&
            store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        store.push(row);
        writes[table] = (writes[table] ?? 0) + 1;
        return { data: op === "insert_select" ? row : null, error: null };
      }
      return { data: store.filter(match), error: null };
    }

    const first = () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    };

    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
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

  return { from, _tables: tables, _writes: writes };
}

const openDb = () =>
  makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: true },
    { places: [PLACE], consent: { [ACTOR]: true } });

/** One contribution per newly supported prompt, at its first option. */
const NEW_BODIES = PROMPT_CONTRACT.map(({ kind, objectKind, options }) => ({
  objectId: PLACE,
  objectKind,
  kind,
  value: options[0],
  observedAt: OBSERVED,
}));

describe("the new prompts pass through the SAME gates, not around them", () => {
  it("records each one as an observation with the claim type and value it declared", async () => {
    for (const body of NEW_BODIES) {
      const db = openDb();
      const r = await ingestMapContribution(db, ACTOR, body);
      assert.equal(r.ok, true, `${body.kind}: ${JSON.stringify(r)}`);
      const row = db._tables.intel_observations[0];
      const contract = PROMPT_CONTRACT.find((p) => p.kind === body.kind)!;
      assert.equal(row.claim_type, contract.claimType);
      assert.deepEqual(row.value, { [contract.key]: body.value });
      assert.deepEqual(Object.keys(db._writes), ["intel_observations"],
        "the ingest must still write ONLY the observation store");
    }
  });

  it("stamps expires_at from the claim type's OWN TTL, not a shared default", async () => {
    for (const body of NEW_BODIES) {
      const db = openDb();
      await ingestMapContribution(db, ACTOR, body);
      const row = db._tables.intel_observations[0];
      const spec = CLAIM_TYPES.find((c) => c.claimType === row.claim_type)!;
      assert.ok(row.expires_at, `${body.kind} stored no expiry — the TTL lookup missed`);
      assert.equal(
        new Date(row.expires_at).getTime() - new Date(row.observed_at).getTime(),
        spec.ttlSeconds * 1000,
        `${body.kind} did not expire at its own TTL`,
      );
    }
  });

  it("keeps the fail-closed defaults that stop one tap reading as truth", async () => {
    for (const body of NEW_BODIES) {
      const db = openDb();
      await ingestMapContribution(db, ACTOR, body);
      const row = db._tables.intel_observations[0];
      assert.equal(row.visibility, "private", `${body.kind}: a map tap is not consent to publish`);
      assert.equal(row.presence_level, "P0", `${body.kind}: no proximity proof in a §22 payload`);
      assert.equal(row.source_class, "firsthand_unverified");
      assert.equal(row.moderation_state, "pending");
      assert.equal(row.commercial_disclosure, "none");
      assert.equal(row.group_key, null);
      assert.equal(db._tables.intel_claims.length, 0, `${body.kind}: an observation is not a claim`);
    }
  });

  it("still refuses without consent, on either flag being off, and on a future time", async () => {
    for (const body of NEW_BODIES) {
      const noConsent = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: true },
        { places: [PLACE], consent: {} });
      assert.equal(((await ingestMapContribution(noConsent, ACTOR, body)) as any).reason, "consent_required", body.kind);
      assert.equal(noConsent._tables.intel_observations.length, 0);

      const mapOff = makeDb({ map_contributions_enabled: false, intel_capture_quick_signal: true },
        { places: [PLACE], consent: { [ACTOR]: true } });
      assert.equal(((await ingestMapContribution(mapOff, ACTOR, body)) as any).reason, "feature_disabled", body.kind);

      const captureOff = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: false },
        { places: [PLACE], consent: { [ACTOR]: true } });
      assert.equal(((await ingestMapContribution(captureOff, ACTOR, body)) as any).reason, "disabled", body.kind);

      const future = openDb();
      const r = await ingestMapContribution(future, ACTOR, {
        ...body, observedAt: new Date(Date.now() + 600_000).toISOString(),
      });
      assert.equal((r as any).reason, "invalid_observed_at", body.kind);
      assert.equal(future._tables.intel_observations.length, 0);
    }
  });

  it("still REFUSES a body carrying an actor or a reward field", async () => {
    for (const body of NEW_BODIES) {
      for (const smuggled of ["actorId", "userId", "reward", "paid", "sponsored"]) {
        const db = openDb();
        const r = await ingestMapContribution(db, ACTOR, { ...body, [smuggled]: "x" });
        assert.equal(r.ok, false, `${body.kind} + ${smuggled} must be refused`);
        assert.equal((r as any).reason, "invalid_payload");
        assert.equal(db._tables.intel_observations.length, 0);
      }
    }
  });

  it("still dedupes a double-tap and still records a correction as a new observation", async () => {
    const db = openDb();
    const body = NEW_BODIES.find((b) => b.kind === "closure")!;
    await ingestMapContribution(db, ACTOR, body);
    const replay = await ingestMapContribution(db, ACTOR, body);
    assert.equal((replay as any).deduped, true);
    assert.equal(db._tables.intel_observations.length, 1);

    const corrected = await ingestMapContribution(db, ACTOR, { ...body, value: "temporarily_closed" });
    assert.equal(corrected.ok, true);
    assert.equal((corrected as any).deduped, false, "a corrected answer must not be swallowed as a replay");
    assert.equal(db._tables.intel_observations.length, 2);
  });

  it("still refuses a prompt the object kind cannot take", async () => {
    const db = openDb();
    // §22 / KIND_PROMPTS: an event cannot be 'closed' — an event that is off is
    // `cancelled`, which event_status already says. Two ways to state one fact
    // would produce contradicting claims about it.
    const r = await ingestMapContribution(db, ACTOR, {
      objectId: PLACE, objectKind: "event", kind: "closure", value: "open", observedAt: OBSERVED,
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "prompt_not_allowed");
    assert.equal(db._tables.intel_observations.length, 0);
  });

  it("still surfaces a non-place subject as a clean refusal, never an FK 500", async () => {
    const db = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: true },
      { places: [], consent: { [ACTOR]: true } });
    const r = await ingestMapContribution(db, ACTOR, NEW_BODIES[0]);
    assert.equal((r as any).reason, "unknown_subject");
    assert.equal((r as any).code, "not_found");
  });
});
