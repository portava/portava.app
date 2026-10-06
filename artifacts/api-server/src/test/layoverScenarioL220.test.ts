/**
 * §21.1, census-layover L220 — "4h international, visa allowed → potential
 * landside depending on airport model" — pinned against the spec's own sentence
 * (lane R, 2026-10-06).
 *
 * WHY THIS FILE EXISTS. census-layover §51.3 recorded that the row's stated
 * reason had gone stale — entry permission is representable (`EntryEligibility`
 * reaches the certified record) and at this tree the 4h international pair
 * answers differently at a generic and a curated airport model — and held the
 * row at W "until a test pins the 4h pair against §21.1's sentence". The
 * decision-diff golden carries both decisions byte for byte, but a golden says
 * "unchanged", not "what the spec asks". These cases say the spec's sentence,
 * clause by clause:
 *
 *   4h international   — the session is the same in both scenarios;
 *   visa allowed       — entry is PERMITTED, and a REFUSED corridor refuses;
 *   potential landside — the curated model reaches `tight` (landside, risky),
 *                        never `yes`;
 *   depending on       — the generic model, same session/clock/entry, says `no`.
 *   airport model
 *
 * They run the corpus through `decideScenario`, the same entry point the
 * decision-diff CI runs, so the answer asserted here is the one the engine
 * publishes.
 *
 * WHAT IT DOES NOT CLAIM. Production carries no curated airport today (census
 * header note 2: 0 of 3,206 verified), so every production 4h international
 * layover takes the generic branch. That is census L243's owner decision about
 * buffers, not this row; this row is the engine's §21.1 behaviour.
 *
 * Run: node --import tsx/esm --test src/test/layoverScenarioL220.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOVER_SCENARIOS,
  decideScenario,
  type LayoverScenario,
} from "../services/layover/replay/layoverScenarioCorpus.js";

function scenario(id: string): LayoverScenario {
  const s = LAYOVER_SCENARIOS.find((x) => x.id === id);
  assert.ok(s, `the corpus no longer carries ${id} — retire-and-add, never rename (corpus header)`);
  return s;
}

const GENERIC_4H = "s02-4h-international-permitted-generic";
const CURATED_4H = "s03-4h-international-permitted-curated";

describe("§21.1 L220 — 4h international, visa allowed → potential landside depending on airport model", () => {
  it("the two scenarios differ ONLY in the airport model", () => {
    const g = scenario(GENERIC_4H);
    const c = scenario(CURATED_4H);
    assert.deepEqual(g.session, c.session, "same session");
    assert.equal(g.nowMs, c.nowMs, "same clock");
    assert.deepEqual(g.entry, c.entry, "same entry corridor");
    assert.notDeepEqual(g.airport, c.airport, "different airport model");
    // and the session IS the spec's: four hours, international, entry permitted
    const minutes = (Date.parse(g.session.departureTime) - Date.parse(g.session.arrivalTime)) / 60_000;
    assert.equal(minutes, 240);
    assert.equal(g.session.flightType, "international");
    assert.equal(g.entry && g.entry.state, "permitted");
  });

  it("the curated model reaches POTENTIAL landside — `tight`, never `yes`", () => {
    const d = decideScenario(scenario(CURATED_4H));
    assert.equal(d.result.verdict, "tight");
    assert.equal(d.result.windowRating, "possible_but_risky");
  });

  it("the generic model, same session, clock and entry, does not", () => {
    const d = decideScenario(scenario(GENERIC_4H));
    assert.equal(d.result.verdict, "no");
  });

  it("'visa allowed' is load-bearing: the curated model with a REFUSED corridor says no", () => {
    const c = scenario(CURATED_4H);
    const refused = decideScenario({
      ...c,
      id: "l220-refused-control",
      entry: { state: "refused", corridor: { passportCountry: "XX", destinationCountry: "TW" }, status: "visa_required" },
    });
    assert.equal(refused.result.verdict, "no");
  });

  it("only a PERMITTED corridor is the unqualified answer: an unresolved one carries ENTRY_NOT_CONFIRMED", () => {
    // The engine's L48 rule costs an unconfirmed corridor the clock's `yes`;
    // at the risky band it stays `tight` and SAYS the entry fact is missing.
    // §21.1's "visa allowed" is therefore the case with no such reason.
    const c = scenario(CURATED_4H);
    const permitted = decideScenario(c);
    assert.ok(!permitted.reasonCodes.includes("ENTRY_NOT_CONFIRMED"), JSON.stringify(permitted.reasonCodes));
    const unresolved = decideScenario({ ...c, id: "l220-unresolved-control", entry: { state: "unresolved", reason: "no_data_for_corridor" } });
    assert.ok(unresolved.reasonCodes.includes("ENTRY_NOT_CONFIRMED"), JSON.stringify(unresolved.reasonCodes));
    assert.notEqual(unresolved.result.verdict, "yes");
  });
});
