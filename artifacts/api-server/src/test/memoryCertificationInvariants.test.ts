/**
 * §25 hard invariant tests — the nine, run against the real engines.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §25 "Hard invariant tests" (:656-665).
 * CENSUS: H236-H244 (docs/architecture/census-highlights-memories.md §B).
 *
 * WHAT THIS SUITE IS DEFENDING AGAINST
 * ====================================
 *  * An invariant checker that calls "nothing to check" a pass. The status
 *    vocabulary has three values and this suite asserts the EXACT status of
 *    every invariant, so an invariant that quietly stops being evaluated
 *    (NO_SURFACE) fails here instead of continuing to report green.
 *  * A checker that cannot fail. Every invariant below is paired with a direct
 *    assertion on the underlying production function using an input the
 *    invariant would catch, so the invariant and the property are tested
 *    independently rather than the invariant testing itself.
 *  * A pass that hides its ceiling. Every outcome records the surface it was
 *    proved against and whether any route reaches it, and this suite asserts
 *    that the ones known to be unreachable still SAY they are unreachable —
 *    which is how the census keeps scoring them BUILT-BUT-WRONG rather than
 *    correct.
 *
 * ── RED-FIRST: MUTATIONS OF PRODUCTION CODE, MEASURED ────────────────────────
 * Applied to the production file, suite run, mutation reverted. None is a
 * change to a test or to a constant an assertion reads back.
 *
 *  1. src/services/memoryRetrieval/searchMemories.ts, NAMESPACE_PROJECTIONS:
 *     added "MemoryTimelineProjection" to the PUBLIC namespace.
 *     MEASURED: H236 PRIVATE_NOT_IN_PUBLIC_SEARCH -> VIOLATED
 *     ("PUBLIC namespace did not refuse MemoryTimelineProjection"),
 *     check:memory-certification exit 1, and this file went 10 pass / 4 fail
 *     from 14 pass / 0 fail. Reverted; green.
 *  2. src/services/highlights/highlightProjectionPolicy.ts,
 *     clampLocationToPrecision case "CITY": returned `row.location_name` instead
 *     of null.
 *     MEASURED: H241 PUBLIC_PRECISION_WITHIN_OWNER_POLICY -> VIOLATED
 *     ("CITY discloses location_name but the finer rung NEIGHBORHOOD does not"),
 *     and this file went 11 pass / 3 fail. Reverted; green.
 *  3. src/services/memoryProjections/projectionRegistry.ts, CompassMemoryProjection
 *     `build`: renamed the `confidence_note` field so the whitelist dropped it.
 *     MEASURED: H243 HISTORICAL_NOT_CURRENT_AVAILABILITY -> VIOLATED, quoting
 *     the offending row with `"confidence_note":null`. Reverted; green.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryCertificationInvariants.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INVARIANT_IDS,
  listInvariants,
  type InvariantOutcome,
} from "../services/memoryCertification/invariants.js";
import { runAllInvariants } from "../services/memoryCertification/invariants.js";
import {
  NAMESPACE_PROJECTIONS,
  searchMemories,
} from "../services/memoryRetrieval/searchMemories.js";
import {
  LOCATION_PRECISION_LADDER,
  clampLocationToPrecision,
  resolveLocationDisclosure,
} from "../services/highlights/highlightProjectionPolicy.js";
import { getProjectionDefinition } from "../services/memoryProjections/projectionRegistry.js";
import { rebuildProjection } from "../services/memoryProjections/derivativeRegistry.js";
import { certificationClient, tablesFor, certMemory, certWorld } from "../services/memoryCertification/world.js";

const SPEC_PATH = new URL(
  "../../../../docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt",
  import.meta.url,
).pathname;

let outcomes: InvariantOutcome[];
const by = (id: string): InvariantOutcome => {
  const found = outcomes.find((o) => o.id === id);
  assert.ok(found, `no outcome for ${id}`);
  return found;
};

before(async () => {
  outcomes = await runAllInvariants();
});

describe("§25: the invariant list is the spec's list", () => {
  it("has exactly nine invariants, in the spec's order, with the spec's own words", () => {
    const lines = readFileSync(SPEC_PATH, "utf8").split("\n");
    const start = lines.findIndex((l) => l.trim() === "Hard invariant tests");
    const end = lines.findIndex((l) => l.trim() === "Property / chaos testing");
    assert.ok(start > 0 && end > start);
    const sentences = lines.slice(start + 1, end).map((l) => l.trim()).filter(Boolean);
    assert.equal(sentences.length, 9);
    assert.deepEqual(listInvariants().map((i) => i.spec_text), sentences);
    assert.deepEqual(listInvariants().map((i) => i.census_id), [
      "H236", "H237", "H238", "H239", "H240", "H241", "H242", "H243", "H244",
    ]);
  });
});

describe("§25: each invariant reports the status it has actually earned", () => {
  it("evaluates every one of the nine", () => {
    assert.equal(outcomes.length, 9);
    assert.deepEqual(outcomes.map((o) => o.id), [...INVARIANT_IDS]);
  });

  it("violates nothing", () => {
    const violated = outcomes.filter((o) => o.status === "VIOLATED");
    assert.deepEqual(violated.map((o) => `${o.census_id} ${o.id}: ${o.detail}`), []);
  });

  it("holds the eight that have a surface", () => {
    const held = outcomes.filter((o) => o.status === "HELD").map((o) => o.census_id);
    assert.deepEqual(held, ["H236", "H237", "H239", "H240", "H241", "H242", "H243", "H244"]);
  });

  it("reports H238 as NO_SURFACE and does not dress it as a pass", () => {
    const o = by("REJECTED_CANDIDATE_NOT_A_HIGHLIGHT");
    assert.equal(o.status, "NO_SURFACE");
    assert.match(o.detail, /no candidate-to-Highlight path exists/);
    assert.match(o.detail, /2722/, "the outcome must name the missing storage, not just shrug");
  });

  it("says of every outcome whether a route reaches the surface it was proved against", () => {
    for (const o of outcomes) {
      assert.equal(typeof o.reachable_from_a_route, "boolean");
      assert.ok(o.surface.length > 10, `${o.id} does not name the code it was asserted against`);
      if (!o.reachable_from_a_route && o.status === "HELD") {
        assert.match(
          o.detail,
          /CEILING:/,
          `${o.id} held on a surface no route reaches and did not say so — that is how an unreachable guarantee gets read as a shipped one`,
        );
      }
    }
    // Exactly two of the nine sit on code a route imports today.
    const live = outcomes.filter((o) => o.reachable_from_a_route).map((o) => o.census_id);
    assert.deepEqual(live, ["H240", "H241"]);
  });
});

describe("§25 H236: the namespace gate refuses on the way in", () => {
  it("does not list any owner-private projection in the PUBLIC namespace", () => {
    assert.deepEqual([...NAMESPACE_PROJECTIONS.PUBLIC], ["PublicMemoryProjection"]);
    for (const forbidden of ["MemoryTimelineProjection", "CompassMemoryProjection", "MapTrailDerivative"]) {
      assert.ok(
        !NAMESPACE_PROJECTIONS.PUBLIC.includes(forbidden as never),
        `${forbidden} is readable from the PUBLIC namespace`,
      );
    }
  });

  it("refuses a cross-namespace read before it reads anything", async () => {
    // The client fails EVERY table. A pipeline that read first and filtered
    // afterwards would surface the read error; refusing on the way in cannot.
    const client = certificationClient({}, { failTables: new Set(["memories", "memory_derivative_registry"]) });
    const res = await searchMemories(client, {
      ownerId: "owner", viewerId: "stranger", namespace: "PUBLIC",
      authorizedProjection: "MemoryTimelineProjection", now: new Date("2026-06-01T00:00:00.000Z"),
    });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "projection_not_in_namespace");
  });

  it("refuses PRIVATE_PERSONAL to anyone but the owner", async () => {
    const client = certificationClient({});
    const res = await searchMemories(client, {
      ownerId: "owner", viewerId: "someone-else", namespace: "PRIVATE_PERSONAL",
      authorizedProjection: "MemoryTimelineProjection", now: new Date("2026-06-01T00:00:00.000Z"),
    });
    assert.equal(res.ok === false && res.reason, "namespace_violation");
  });

  it("keeps a non-public row out of the public derivative", async () => {
    const world = certWorld({
      memories: [
        certMemory({ id: "pub", visibility: "public", state: "published", title: "public" }),
        certMemory({ id: "priv", visibility: "only_me", state: "published", title: "private" }),
      ],
    });
    const client = certificationClient(tablesFor(world));
    const built = await rebuildProjection(
      client, "PublicMemoryProjection", { owner_id: world.owner_id, viewer_id: null }, new Date(world.now),
    );
    assert.ok(built.ok);
    assert.deepEqual(built.ok && built.value.rows.map((r) => r.memory_id), ["pub"]);
  });
});

describe("§25 H241: the precision ladder can only narrow", () => {
  it("discloses strictly less at each coarser rung", () => {
    const row = { location_name: "Bar Alimentari", location_city: "Bologna", location_country: "Italy" };
    const disclosed = LOCATION_PRECISION_LADDER.map((rung) => {
      const c = clampLocationToPrecision(row, rung);
      return (["location_name", "location_city", "location_country"] as const).filter((k) => c[k] !== null);
    });
    for (let i = 1; i < disclosed.length; i++) {
      for (const field of disclosed[i]!) {
        assert.ok(
          disclosed[i - 1]!.includes(field),
          `${LOCATION_PRECISION_LADDER[i]} discloses ${field} that ${LOCATION_PRECISION_LADDER[i - 1]} withholds`,
        );
      }
    }
    assert.deepEqual(disclosed[disclosed.length - 1], [], "HIDDEN disclosed something");
    assert.ok(disclosed[0]!.length === 3, "EXACT withheld a field, so the ladder has no top");
  });

  it("clamps to HIDDEN when the policy cannot be read or cannot be parsed", () => {
    const row = { location_name: "Hotel Duse", location_city: "Bologna", location_country: "Italy" };
    const unreadable = resolveLocationDisclosure(row, "EXACT", { state: "unreadable", reason: "test" });
    assert.equal(unreadable.precision, "HIDDEN");
    assert.equal(unreadable.location_country, null);
    const garbage = resolveLocationDisclosure(row, { rung: "EXACT" }, { state: "ready" });
    assert.equal(garbage.precision, "HIDDEN");
  });

  it("does NOT invent a rung when the policy table is absent, and says so", () => {
    const row = { location_name: "Hotel Duse", location_city: "Bologna", location_country: "Italy" };
    const absent = resolveLocationDisclosure(row, null, { state: "absent", reason: "2721 not applied" });
    assert.equal(absent.applied, false);
    assert.equal(absent.precision, null);
    assert.equal(absent.location_name, "Hotel Duse");
    assert.match(String(absent.reason), /2721|UNENFORCED/);
  });
});

describe("§25 H243: a Compass fact cannot be read as current truth", () => {
  it("carries no field that names the present", () => {
    const def = getProjectionDefinition("CompassMemoryProjection");
    assert.ok(def);
    for (const field of def!.field_whitelist) {
      assert.doesNotMatch(
        field,
        /^(is_open|open_now|status|availability|currently|hours|is_operational)/,
        `CompassMemoryProjection exposes ${field}`,
      );
    }
    assert.ok(def!.field_whitelist.includes("confidence_note"));
  });
});
