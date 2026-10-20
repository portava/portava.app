import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyObjectiveIntent, statedObjectiveTerms, objectiveFactInputSchema, objectiveIntentSchema, type ObjectiveEvidence, type ObjectiveFact } from "../services/airport/layoverObjectiveEvidence.js";
import { orderWithinRatings, type ObjectiveCard } from "../services/airport/layoverObjective.js";
const placeId = "11111111-1111-4111-8111-111111111111", airportId = "22222222-2222-4222-8222-222222222222", now = Date.parse("2026-10-19T12:00:00Z");
const source = { sourceClass: "venue_operator" as const, sourceUrl: "https://example.test/venue", sourceNote: "Explicit test fixture source", observedAt: "2026-10-19T11:00:00Z", expiresAt: "2026-10-19T13:00:00Z", confirmedSource: true as const };
function evidence(): ObjectiveEvidence {
  const values: ObjectiveFact["fact"][] = [
    { kind: "local_distinctiveness", value: { extent: "city_only" } }, { kind: "social_format", value: { format: "interactive" } },
    { kind: "exertion", value: { level: "light" } },
    { kind: "quoted_cost", value: { currency: "SGD", venueMinor: 1000, roundTripTransportMinor: 0, otherRequiredMinor: 0, transportMode: "none", complete: true } },
  ];
  return { nowMs: now, state: "read", intent: { socialPreference: "social", availableEnergy: "high", budget: { currency: "SGD", amountMinor: 5000 }, meaningfulPlaces: [{ placeId, importance: "high" }] }, facts: values.map((fact, i) => ({ id: `fact-${i}`, placeId, airportId, source, fact })) };
}
describe("L78 sourced and explicit objective terms", () => {
  it("each formerly absent term has a stated source; prospective memory is identified honestly", () => {
    const terms = statedObjectiveTerms(placeId, true, evidence());
    for (const term of Object.values(terms)) assert.equal(term.state, "KNOWN");
    assert.match(JSON.stringify(terms.memory_value), /prospective preference, not a past memory/);
    assert.match(JSON.stringify(terms.monetary_cost), /complete quoted out-of-pocket cost=1000 minor SGD/);
  });
  it("no input or unreadable input leaves every new term unknown", () => {
    for (const data of [undefined, { ...evidence(), state: "unreadable" as const }]) {
      assert.ok(Object.values(statedObjectiveTerms(placeId, true, data)).every(t => t.state === "UNKNOWN"));
    }
  });
  it("withdrawing explicit preferences removes matching personal terms", () => {
    const e = evidence(); e.intent = emptyObjectiveIntent();
    const terms = statedObjectiveTerms(placeId, true, e);
    assert.equal(terms.local_uniqueness.state, "KNOWN");
    for (const term of [terms.memory_value, terms.social_value, terms.energy_cost, terms.monetary_cost]) assert.equal(term.state, "UNKNOWN");
  });
  it("expired or conflicting sources do not silently pick the more favorable claim", () => {
    const e = evidence(); e.nowMs = Date.parse(source.expiresAt);
    const expired = statedObjectiveTerms(placeId, true, e);
    assert.equal(expired.local_uniqueness.state, "UNKNOWN"); assert.equal(expired.monetary_cost.state, "UNKNOWN");
    const conflict = evidence(); conflict.facts.push({ ...conflict.facts[0]!, id: "conflict", fact: { kind: "local_distinctiveness", value: { extent: "widely_available" } } });
    assert.equal(statedObjectiveTerms(placeId, true, conflict).local_uniqueness.state, "UNKNOWN");
  });
  it("currency mismatch, incomplete quote and absent required fare remain unknown", () => {
    for (const change of ["currency", "complete", "fare"] as const) {
      const e = evidence(); const quote = e.facts[3]!.fact; assert.equal(quote.kind, "quoted_cost"); if (quote.kind !== "quoted_cost") return;
      if (change === "currency") e.intent.budget!.currency = "USD";
      if (change === "complete") quote.value.complete = false;
      if (change === "fare") quote.value.roundTripTransportMinor = null;
      assert.equal(statedObjectiveTerms(placeId, true, e).monetary_cost.state, "UNKNOWN");
    }
  });
  it("outdoor cost cannot use an airside quote or an unmeasured return mode", () => {
    assert.equal(statedObjectiveTerms(placeId, false, evidence(), null).monetary_cost.state, "UNKNOWN");
  });
  it("raw commercial fields and malformed source/intent data are not accepted by producers", () => {
    const e = evidence();
    assert.equal(objectiveIntentSchema.safeParse({ ...e.intent, commission: 99 }).success, false);
    assert.equal(objectiveFactInputSchema.safeParse({ fact: { kind: "quoted_cost", value: { ...e.facts[3]!.fact.value, revenue: 99 } }, source }).success, false);
    assert.equal(objectiveFactInputSchema.safeParse({ fact: e.facts[0]!.fact, source: { ...source, confirmedSource: false } }).success, false);
  });
  it("positive evidence cannot change safety partition or add/remove a card", () => {
    const card = (key: string, rating: ObjectiveCard["assessment"]["rating"]): ObjectiveCard & { key: string } => ({ key, placeId, insideAirport: true, travelTimeMin: 0, assessment: { rating, statedTravelMin: 0, statedActivityMin: 30, usableMinutes: 100 } });
    const cards = [card("safe", "safe"), card("blocked", "not_recommended")];
    const ordered = orderWithinRatings(cards, { keyOf: c => c.key, evidence: new Map([["blocked", evidence()]]) });
    assert.deepEqual(ordered.served, cards); assert.equal(ordered.refused, null);
  });
});
