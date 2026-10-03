/**
 * inputAssistanceGatewayDegradedCoverage — backlog A1, census-discovery §80.
 *
 * The gateway's dispatch sites took `dispatchSearch`, the bare-array wrapper
 * whose own doc comment says what it drops: "a caller of `dispatchSearch`
 * cannot distinguish a complete answer from a partial one". They now take
 * `dispatchSearchWithCoverage` and push what a type could only PARTLY read into
 * `GatewayCoverage.degradedSources`, alongside the types that could not be read
 * at all.
 *
 * This file pins the half of that which the request path cannot reach yet.
 * `DispatchSearchType` (lib/inputAssistance/entityMap.ts) has no `saved` member
 * and `saved` is the only type assembled from two independently-failing tables,
 * so no policy the gateway can resolve produces a non-empty `degradedSources`
 * today — the end-to-end case is covered where it IS reachable, by
 * inputAssistanceMapSearchPage.test.ts (the `map.search` field, which calls
 * `dispatchSearchWithCoverage("saved")` directly). What is pinned here is the
 * rule the envelope applies when a degraded source does arrive, because that
 * rule is the whole of the fix and the alternative is wiring with no check:
 *
 *   D1  a degraded source ALONE is a refusal, not a complete answer — the
 *       `unreadableTypes.size === 0 ⇒ null` shortcut used to swallow it;
 *   D2  a degraded source is `coverage: "partial"` and NEVER "nothing", even
 *       when every dispatched type reported one: rows did come back;
 *   D3  the two signals coexist and both reach `failedSources`;
 *   D4  identity — a coverage with neither still refuses nothing, and an
 *       eligibility failure still outranks both.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceGatewayDegradedCoverage.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  gatewayCoverageRefusal,
  newGatewayCoverage,
} from "../lib/inputAssistance/gateway.js";

describe("A1 — a degraded source reaches the gateway envelope", () => {
  it("D1: a degraded source alone is a partial refusal naming the table", () => {
    const coverage = newGatewayCoverage();
    coverage.degradedSources.add("wishlist_places");

    const refusal = gatewayCoverageRefusal(coverage, ["places", "events"]);
    assert.ok(refusal, "a serve that could not read one of a type's tables must refuse, not answer complete");
    assert.equal(refusal.class, "transient_db");
    assert.equal(refusal.code, "suggest_sources_unreadable");
    assert.equal(refusal.coverage, "partial");
    assert.deepEqual([...(refusal.failedSources ?? [])], ["wishlist_places"]);
  });

  it("D2: degraded sources are never 'nothing', however many there are", () => {
    const coverage = newGatewayCoverage();
    coverage.degradedSources.add("wishlist_places");
    coverage.degradedSources.add("discovery_place_saves");

    // Every dispatched type is named as a degraded SOURCE and none as an
    // unreadable TYPE: rows came back, so the answer is incomplete, not absent.
    const refusal = gatewayCoverageRefusal(coverage, ["wishlist_places", "discovery_place_saves"]);
    assert.ok(refusal);
    assert.equal(refusal.coverage, "partial");
    assert.deepEqual(
      [...(refusal.failedSources ?? [])],
      ["discovery_place_saves", "wishlist_places"],
      "failedSources is sorted and holds both",
    );
  });

  it("D3: an unreadable type and a degraded source both reach failedSources", () => {
    const coverage = newGatewayCoverage();
    coverage.unreadableTypes.add("events");
    coverage.degradedSources.add("wishlist_places");

    const refusal = gatewayCoverageRefusal(coverage, ["events", "places"]);
    assert.ok(refusal);
    // Not every dispatched type failed totally, so still partial.
    assert.equal(refusal.coverage, "partial");
    assert.deepEqual([...(refusal.failedSources ?? [])], ["events", "wishlist_places"]);
  });

  it("D3b: a thrown read is still 'nothing' when it took every dispatched type", () => {
    // The pre-A1 behaviour, unchanged: `degradedSources` must not dilute it.
    const coverage = newGatewayCoverage();
    coverage.unreadableTypes.add("events");
    coverage.unreadableTypes.add("places");

    const refusal = gatewayCoverageRefusal(coverage, ["events", "places"]);
    assert.ok(refusal);
    assert.equal(refusal.coverage, "nothing");
  });

  it("D4: identity — nothing recorded refuses nothing, and eligibility outranks both", () => {
    assert.equal(gatewayCoverageRefusal(newGatewayCoverage(), ["places"]), null);

    const blind = newGatewayCoverage();
    blind.eligibilityUnreadable = true;
    blind.degradedSources.add("wishlist_places");
    const refusal = gatewayCoverageRefusal(blind, ["places"]);
    assert.ok(refusal);
    assert.equal(refusal.code, "visibility_state_unreadable");
    assert.equal(refusal.coverage, "nothing", "unknown block/age state serves no entity row at all");
  });
});
