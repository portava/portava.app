/**
 * §57 Product Success Metrics — the computation, asserted to exact values.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceMetrics.test.ts
 *
 * WHAT THESE TESTS ARE FOR
 * ------------------------
 * `lib/inputAssistance/metrics.ts` turns the §44 serve log into §57's nine
 * numbers. A metrics module is the easiest place in a codebase to be
 * confidently wrong, because a rate is a plausible number whatever it divides,
 * so every assertion below names an exact expected value over a hand-built row
 * set rather than checking a shape or a range.
 *
 * FOUR OF THE NINE ARE ASSERTED TO BE REFUSED. That is the point of those tests:
 * they fail if someone later "completes the dashboard" by returning 0 for a
 * metric whose event nothing emits. A forever-green zero is worse than a
 * documented hole.
 *
 * WHAT THEY DO NOT CLAIM. Nothing here touches a database. Migration 2950 is
 * applied in hosted but its table holds no rows (census §31, §35), so no
 * production number exists for any of these and none is claimed. These tests prove the DEFINITION is right; the census
 * rows they support are correspondingly marked inert-in-production.
 *
 * EVERY TEST NAMES ITS MUTATION, and each was applied and watched go RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeInputSuccessMetrics,
  toEpisodes,
  percentile,
  type MetricRow,
} from "../lib/inputAssistance/metrics.ts";

const T0 = Date.parse("2026-09-21T10:00:00.000Z");

function row(
  offsetMs: number,
  event_name: string,
  props: Record<string, unknown> = {},
  over: Partial<MetricRow> = {},
): MetricRow {
  return {
    session_id: "s1",
    event_name,
    context: "global_search",
    field_id: "discovery.search",
    occurred_at: new Date(T0 + offsetMs).toISOString(),
    props,
    ...over,
  };
}

describe("§57 percentile — nearest-rank, and a value the system really produced", () => {
  it("returns an OBSERVED value, never an interpolation between two", () => {
    const sample = [10, 20, 30, 40, 100];
    assert.equal(percentile(sample, 50), 30);
    assert.equal(percentile(sample, 95), 100);
    // MUTATION: switching to linear interpolation makes P95 88, a latency the
    // system never served. Asserting 100 is what forbids that.
    assert.ok(sample.includes(percentile(sample, 95) as number));
  });

  it("an empty sample is null, not zero", () => {
    // MUTATION: `return 0` here would report a 0 ms P95 for a field nobody used.
    assert.equal(percentile([], 95), null);
  });

  it("a single observation is its own P50 and P95", () => {
    assert.equal(percentile([7], 50), 7);
    assert.equal(percentile([7], 95), 7);
  });

  it("order of arrival does not change the answer", () => {
    assert.equal(percentile([100, 10, 40, 20, 30], 95), 100);
  });
});

describe("§57 episodes — one interaction with one field", () => {
  it("a second `input_opened` on the same field starts a new episode", () => {
    const eps = toEpisodes([
      row(0, "input_opened"),
      row(10, "suggestion_rendered", { count: 3 }),
      row(20, "input_opened"),
      row(30, "suggestion_rendered", { count: 2 }),
    ]);
    assert.equal(eps.length, 2);
    assert.equal(eps[0].events.length, 2);
    assert.equal(eps[1].events.length, 2);
  });

  it("two fields in one session are never one episode", () => {
    const eps = toEpisodes([
      row(0, "input_opened"),
      row(5, "input_opened", {}, { field_id: "trip.destination", context: "trip_destination" }),
      row(10, "suggestion_selected", { suggestionType: "entity" }),
    ]);
    assert.equal(eps.length, 2);
    // MUTATION: keying episodes on session_id alone puts the selection in the
    // wrong field's episode and silently attributes it to trip.destination.
    const search = eps.find((e) => e.fieldId === "discovery.search");
    assert.ok(search);
    assert.equal(search.events.length, 2);
  });

  it("two sessions on one field are never one episode", () => {
    const eps = toEpisodes([
      row(0, "input_opened"),
      row(10, "input_opened", {}, { session_id: "s2" }),
    ]);
    assert.equal(eps.length, 2);
  });

  it("rows out of chronological order are sorted, not trusted", () => {
    const eps = toEpisodes([
      row(30, "suggestion_selected", { suggestionType: "entity" }),
      row(0, "input_opened"),
      row(10, "suggestion_rendered", { count: 1 }),
    ]);
    // MUTATION: dropping the sort leaves the selection first, which makes it its
    // own leading episode and loses the open→select pair entirely.
    assert.equal(eps.length, 1);
    assert.equal(eps[0].events[0].event_name, "input_opened");
  });

  it("events before any open are kept as a leading episode, not discarded", () => {
    const eps = toEpisodes([row(0, "suggestion_request_completed", { serverMs: 12 })]);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].events.length, 1);
  });
});

describe("§57/G365 time to valid selection", () => {
  it("measures open → FIRST selection, per episode", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(100, "suggestion_rendered", { count: 3 }),
      row(400, "suggestion_selected", { suggestionType: "entity" }),
      row(900, "suggestion_selected", { suggestionType: "entity" }), // a second pick, same episode
      row(1000, "input_opened"),
      row(1200, "suggestion_selected", { suggestionType: "entity" }),
    ]);
    // 400 ms and 200 ms. MUTATION: using the LAST selection makes the first
    // episode 900 and the P95 wrong.
    assert.equal(m.timeToValidSelectionMs.n, 2);
    assert.equal(m.timeToValidSelectionMs.p50, 200);
    assert.equal(m.timeToValidSelectionMs.p95, 400);
  });

  it("an episode that never resolved contributes nothing — it is not a zero", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(100, "suggestion_rendered", { count: 3 }),
      row(500, "manual_value_kept", { length: 9 }),
    ]);
    // MUTATION: counting an unresolved episode as 0 ms would make the headline
    // "time to valid selection" fall as the product got WORSE.
    assert.equal(m.timeToValidSelectionMs.n, 0);
    assert.equal(m.timeToValidSelectionMs.p50, null);
  });

  it("a backwards clock is dropped rather than recorded as a negative duration", () => {
    const m = computeInputSuccessMetrics([
      row(1000, "input_opened"),
      row(0, "suggestion_selected", { suggestionType: "entity" }),
    ]);
    assert.equal(m.timeToValidSelectionMs.n, 0);
  });
});

describe("§57/G366 valid entity resolution rate", () => {
  it("is entity-resolving selections over impressions", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_rendered", { count: 4 }),
      row(20, "suggestion_selected", { suggestionType: "entity" }),
      row(30, "input_opened"),
      row(40, "suggestion_rendered", { count: 2 }),
      row(50, "suggestion_selected", { suggestionType: "recent" }),
      row(60, "input_opened"),
      row(70, "suggestion_rendered", { count: 2 }),
      row(80, "manual_value_kept", { length: 5 }),
      row(90, "input_opened"),
      row(95, "suggestion_rendered", { count: 1 }),
    ]);
    assert.equal(m.validEntityResolutionRate.n, 4, "four impressions");
    assert.equal(m.validEntityResolutionRate.value, 0.5, "two of four resolved to an entity");
  });

  it("a completion, an action and an AI row are NOT entity resolutions", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_rendered", { count: 3 }),
      row(20, "suggestion_selected", { suggestionType: "completion" }),
      row(30, "input_opened"),
      row(40, "suggestion_rendered", { count: 3 }),
      row(50, "suggestion_selected", { suggestionType: "action" }),
      row(60, "input_opened"),
      row(70, "suggestion_rendered", { count: 3 }),
      row(80, "suggestion_selected", { suggestionType: "ai_suggestion" }),
    ]);
    // MUTATION: adding 'completion' or 'action' to ENTITY_RESOLVING makes this
    // 1.0 — a perfect resolution rate for a field that resolved nothing.
    assert.equal(m.validEntityResolutionRate.value, 0);
    assert.equal(m.validEntityResolutionRate.n, 3);
  });

  it("no impressions is null, not zero percent", () => {
    const m = computeInputSuccessMetrics([row(0, "input_opened")]);
    assert.equal(m.validEntityResolutionRate.value, null);
    assert.equal(m.validEntityResolutionRate.n, 0);
  });
});

describe("§57/G367 manual fallback rate", () => {
  it("is manual-ending episodes over episodes that ended either way", () => {
    const m = computeInputSuccessMetrics([
      // 1: assisted
      row(0, "input_opened"),
      row(10, "suggestion_rendered", { count: 3 }),
      row(20, "suggestion_selected", { suggestionType: "entity" }),
      // 2: manual keep
      row(100, "input_opened"),
      row(110, "suggestion_rendered", { count: 3 }),
      row(120, "manual_value_kept", { length: 11 }),
      // 3: raw submit that did NOT go through a suggestion
      row(200, "input_opened"),
      row(210, "suggestion_rendered", { count: 2 }),
      row(220, "raw_search_submitted", { length: 8, viaSuggestion: false }),
      // 4: abandoned — neither manual nor assisted, so in neither bucket
      row(300, "input_opened"),
      row(310, "suggestion_rendered", { count: 2 }),
      row(320, "suggestion_dismissed", { shownCount: 2, reason: "blur" }),
    ]);
    assert.equal(m.manualFallbackRate.n, 3);
    assert.equal(m.manualFallbackRate.value, 2 / 3);
  });

  it("a raw submit made THROUGH a suggestion row is not a fallback", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_rendered", { count: 2 }),
      row(20, "suggestion_selected", { suggestionType: "action" }),
      row(21, "raw_search_submitted", { length: 8, viaSuggestion: true }),
    ]);
    // MUTATION: dropping the `viaSuggestion === false` guard counts the user
    // TAKING a "search for …" row as having fallen back from assistance.
    assert.equal(m.manualFallbackRate.value, 0);
    assert.equal(m.manualFallbackRate.n, 1);
  });

  it("an episode where nothing was ever shown is outside the denominator", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(20, "raw_search_submitted", { length: 8, viaSuggestion: false }),
    ]);
    // MUTATION: dropping the `has(ep, 'suggestion_rendered')` guard makes the
    // rate a function of how often the backend returns nothing.
    assert.equal(m.manualFallbackRate.value, null);
    assert.equal(m.manualFallbackRate.n, 0);
  });

  it("an episode that kept text and then came back and chose counts as resolved", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_rendered", { count: 3 }),
      row(20, "manual_value_kept", { length: 4 }),
      row(30, "suggestion_selected", { suggestionType: "entity" }),
    ]);
    assert.equal(m.manualFallbackRate.value, 0);
  });
});

describe("§57/G369 duplicate creation prevented", () => {
  it("counts only the disambiguation rows that resolved to an EXISTING entity", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened", {}, { context: "hidden_gem_name", field_id: "gem.name" }),
      row(
        10,
        "disambiguation_selected",
        { entityType: "hidden_gem", confidence: 0.7, resolvedExisting: true },
        { context: "hidden_gem_name", field_id: "gem.name" },
      ),
      // A §19 ambiguity, not a §55 duplicate: same event name, different meaning.
      row(20, "disambiguation_selected", { entityType: "city", confidence: 0.6, resolvedExisting: false }),
      // An older client that predates the flag sends no key at all.
      row(30, "disambiguation_selected", { entityType: "city", confidence: 0.6 }),
    ]);
    // MUTATION: counting every `disambiguation_selected` makes this 3, turning
    // "duplicates prevented" into "ambiguities resolved" — a different claim.
    assert.equal(m.duplicateCreationPrevented.value, 1);
  });

  it("is a COUNT, and a count of none is 0 rather than null", () => {
    const m = computeInputSuccessMetrics([row(0, "input_opened")]);
    assert.equal(m.duplicateCreationPrevented.value, 0);
  });
});

describe("§57/G372 suggest latency", () => {
  it("reports the serve's own cost and the device round trip separately", () => {
    const rows = [10, 20, 30, 40, 200].map((ms, i) =>
      row(i * 10, "suggestion_request_completed", { count: 3, serverMs: ms, clientMs: ms + 50 }),
    );
    const m = computeInputSuccessMetrics(rows);
    assert.equal(m.suggestLatencyServerMs.p50, 30);
    assert.equal(m.suggestLatencyServerMs.p95, 200);
    assert.equal(m.suggestLatencyClientMs.p50, 80);
    assert.equal(m.suggestLatencyClientMs.p95, 250);
    // MUTATION: merging the two samples into one metric hides the network, which
    // is the whole reason both are carried.
    assert.notEqual(m.suggestLatencyServerMs.p95, m.suggestLatencyClientMs.p95);
  });

  it("an absent serverMs is omitted, never counted as 0 ms", () => {
    const m = computeInputSuccessMetrics([
      row(0, "suggestion_request_completed", { count: 1, clientMs: 120 }),
      row(10, "suggestion_request_completed", { count: 1, serverMs: 40, clientMs: 90 }),
    ]);
    // MUTATION: `Number(props.serverMs) || 0` would put a 0 in the sample and
    // halve the reported P50 for a deployment that sends no server timing.
    assert.equal(m.suggestLatencyServerMs.n, 1);
    assert.equal(m.suggestLatencyServerMs.p50, 40);
    assert.equal(m.suggestLatencyClientMs.n, 2);
  });

  it("no completions at all is null, not zero latency", () => {
    const m = computeInputSuccessMetrics([row(0, "input_opened")]);
    assert.equal(m.suggestLatencyServerMs.p95, null);
    assert.equal(m.suggestLatencyServerMs.n, 0);
  });
});

describe("§57 — the metrics with no producer are REFUSED, not estimated", () => {
  const m = computeInputSuccessMetrics([
    row(0, "input_opened"),
    row(10, "suggestion_rendered", { count: 3 }),
    row(20, "suggestion_selected", { suggestionType: "entity" }),
  ]);

  it("G368 wrong-selection reversal is NOT refused any more — one kept selection is 0/1, with no blocker", () => {
    // It was refused while no event recorded an un-resolution. `selection_reversed`
    // now exists (3781 admits it), so over these rows — one entity selection,
    // never edited away from — the honest answer is a rate of 0 over 1.
    assert.equal(m.wrongSelectionReversalRate.value, 0);
    assert.equal(m.wrongSelectionReversalRate.n, 1);
    assert.equal(m.wrongSelectionReversalRate.blocked, undefined);
  });

  it("G370 downstream task completion is NOT refused any more — with no task reported it is 0/0, null, and says nothing", () => {
    // It was refused while `downstream_task_completed` had no caller. It now has
    // one and a consent gate, so over rows that report no task the honest answer
    // is an empty denominator, not a blocker and not a zero.
    assert.equal(m.downstreamTaskCompletionRate.value, null);
    assert.equal(m.downstreamTaskCompletionRate.n, 0);
    assert.equal(m.downstreamTaskCompletionRate.blocked, undefined);
  });

  it("G373 offline completion is NOT refused any more — with no degraded serve it is 0/0, null, and says nothing", () => {
    // It was refused while the ingest dropped the `degraded` flag. The flag is
    // now admitted (TELEMETRY_EVENT_PROPS) and read (below), so the honest
    // answer over rows with no degraded serve is an EMPTY denominator, not a
    // blocker and not a zero.
    assert.equal(m.offlineCompletionRate.value, null);
    assert.equal(m.offlineCompletionRate.n, 0);
    assert.equal(m.offlineCompletionRate.blocked, undefined);
  });

  it("G371 privacy incidents is refused BECAUSE the table stores no account id", () => {
    // The strongest form of this assertion: the reason is the privacy property,
    // not a TODO. A future reader who "fixes" this by adding a user_id would be
    // breaking migration 2950's own postcondition.
    assert.equal(m.privacyIncidents.value, null);
    assert.match(m.privacyIncidents.blocked ?? "", /no account id/);
    assert.match(m.privacyIncidents.blocked ?? "", /security\/audit logs/);
  });

  it("every refusal is a string a reader can act on, not an empty flag", () => {
    for (const metric of [
      m.privacyIncidents,
    ]) {
      assert.equal(metric.value, null);
      assert.ok((metric.blocked ?? "").length > 40, "a blocker must say what is missing");
    }
  });
});

describe("§57 G368 wrong-selection reversal rate — per entity-resolving selection, per (session, field) stream", () => {
  it("counts a selection edited away from as reversed, and one kept as kept", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_selected", { suggestionType: "entity" }),
      row(20, "selection_reversed", { suggestionType: "entity", secondsSinceSelect: 0 }),
      row(30, "suggestion_selected", { suggestionType: "entity" }),
    ]);
    // Two resolutions; the first was taken back, the second kept.
    assert.equal(m.wrongSelectionReversalRate.n, 2);
    assert.equal(m.wrongSelectionReversalRate.value, 0.5);
  });

  it("follows the selection ACROSS a re-open of the field — a reversal after refocus is still that selection's", () => {
    // MUTATION: compute per episode instead of per stream and this goes to 0/1,
    // because the reversal lands in the second episode, which has no selection.
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_selected", { suggestionType: "entity" }),
      row(5_000, "input_opened"),
      row(5_010, "selection_reversed", { suggestionType: "entity", secondsSinceSelect: 5 }),
    ]);
    assert.equal(m.wrongSelectionReversalRate.n, 1);
    assert.equal(m.wrongSelectionReversalRate.value, 1);
  });

  it("does not attribute a reversal to a NON-resolving row (a completion or an action resolves nothing)", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_selected", { suggestionType: "completion" }),
      row(20, "selection_reversed", { suggestionType: "completion", secondsSinceSelect: 0 }),
    ]);
    assert.equal(m.wrongSelectionReversalRate.value, null, "no entity resolution happened, so there is no rate");
    assert.equal(m.wrongSelectionReversalRate.n, 0);
  });

  it("counts one reversal per resolution — a second edit with nothing pending is not a second reversal", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_selected", { suggestionType: "recent" }),
      row(20, "selection_reversed", { suggestionType: "recent", secondsSinceSelect: 0 }),
      row(30, "selection_reversed", { suggestionType: "recent", secondsSinceSelect: 0 }),
    ]);
    assert.equal(m.wrongSelectionReversalRate.n, 1);
    assert.equal(m.wrongSelectionReversalRate.value, 1, "a rate above 1 would mean the numerator outran its own denominator");
  });

  it("keeps two fields apart — a reversal on one field never reverses a selection on another", () => {
    const m = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_selected", { suggestionType: "entity" }),
      row(20, "input_opened", {}, { field_id: "trip.destination", context: "global_search" }),
      row(30, "selection_reversed", { suggestionType: "entity", secondsSinceSelect: 0 }, { field_id: "trip.destination", context: "global_search" }),
    ]);
    assert.equal(m.wrongSelectionReversalRate.n, 1);
    assert.equal(m.wrongSelectionReversalRate.value, 0);
  });

  it("0/0 is null with no blocker — an empty sample is not a zero and not a refusal", () => {
    const m = computeInputSuccessMetrics([row(0, "input_opened")]);
    assert.equal(m.wrongSelectionReversalRate.value, null);
    assert.equal(m.wrongSelectionReversalRate.n, 0);
    assert.equal(m.wrongSelectionReversalRate.blocked, undefined);
  });
});

describe("§57 G370 downstream task completion — from the AGGREGATE (3783), opt-in population", () => {
  const cell = (task: string, ok: boolean, count: number, context = "global_search") => ({ day: "2026-10-05", context, task, ok, count });

  it("is successful tasks over reported tasks, summed over the aggregate's cells", () => {
    const m = computeInputSuccessMetrics([], { taskOutcomes: [cell("trip_destinations_saved", true, 2), cell("trip_created", false, 1)] });
    assert.equal(m.downstreamTaskCompletionRate.n, 3);
    assert.equal(m.downstreamTaskCompletionRate.value, 2 / 3);
  });

  it("§44 rows are NOT a source any more — a stray downstream row counts for nothing", () => {
    // The ingest no longer stores per-event outcome rows (verifier finding 5).
    // MUTATION: read rows again and this goes to n=1.
    const m = computeInputSuccessMetrics([row(0, "downstream_task_completed", { task: "trip_created", ok: true })], { taskOutcomes: [] });
    assert.equal(m.downstreamTaskCompletionRate.n, 0);
    assert.equal(m.downstreamTaskCompletionRate.value, null);
  });

  it("scoping to a context applies to the cells too", () => {
    const m = computeInputSuccessMetrics([], {
      contexts: ["trip_destination"],
      taskOutcomes: [cell("trip_created", true, 5, "global_search"), cell("trip_destinations_saved", false, 1, "trip_destination")],
    });
    assert.equal(m.downstreamTaskCompletionRate.n, 1);
    assert.equal(m.downstreamTaskCompletionRate.value, 0);
  });
});

describe("§57 G373 offline completion rate — over episodes that were served DEGRADED", () => {
  // Episode A: a degraded serve (the device's own dictionary answered), then the
  // person picked a row — completed offline. Episode B: degraded, nothing picked.
  // Episode C: an ONLINE serve and a pick — not in this metric at all.
  const rows = [
    row(0, "input_opened", {}, { field_id: "a" }),
    row(10, "suggestion_request_completed", { count: 4, degraded: true }, { field_id: "a" }),
    row(20, "suggestion_selected", { suggestionType: "recent", source: "local" }, { field_id: "a" }),
    row(0, "input_opened", {}, { field_id: "b" }),
    row(10, "suggestion_request_completed", { count: 0, degraded: true }, { field_id: "b" }),
    row(0, "input_opened", {}, { field_id: "c" }),
    row(10, "suggestion_request_completed", { count: 3, serverMs: 40, clientMs: 90 }, { field_id: "c" }),
    row(20, "suggestion_selected", { suggestionType: "entity" }, { field_id: "c" }),
  ];
  const m = computeInputSuccessMetrics(rows);

  it("is completed-degraded episodes over degraded episodes — 1 of 2", () => {
    // MUTATION: counting every episode with a selection as the numerator makes
    // it 2/2; counting every episode as the denominator makes it 1/3.
    assert.deepEqual(m.offlineCompletionRate, { value: 0.5, n: 2 });
  });

  it("a selection made BEFORE the degraded serve does not count as completing it", () => {
    const early = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(5, "suggestion_selected", { suggestionType: "entity" }),
      row(10, "suggestion_request_completed", { count: 2, degraded: true }),
    ]);
    assert.deepEqual(early.offlineCompletionRate, { value: 0, n: 1 });
  });

  it("only a literal `true` marks a serve degraded", () => {
    const loose = computeInputSuccessMetrics([
      row(0, "input_opened"),
      row(10, "suggestion_request_completed", { count: 2, degraded: "true" }),
      row(20, "suggestion_selected", { suggestionType: "entity" }),
    ]);
    assert.deepEqual(loose.offlineCompletionRate, { value: null, n: 0 });
  });

  it("a degraded row never enters G372's latency, even if one carries a round trip", () => {
    // §33.3: a degraded round trip in the P95 drags it toward failures that
    // never touched a network. The client sends none; the reader refuses one anyway.
    const lat = computeInputSuccessMetrics([
      row(0, "suggestion_request_completed", { count: 1, degraded: true, serverMs: 9000, clientMs: 9000 }),
      row(10, "suggestion_request_completed", { count: 1, serverMs: 40, clientMs: 90 }),
    ]);
    assert.equal(lat.suggestLatencyClientMs.n, 1);
    assert.equal(lat.suggestLatencyClientMs.p95, 90);
    assert.equal(lat.suggestLatencyServerMs.p95, 40);
  });
});

describe("§57 — scoping", () => {
  it("restricting to a context excludes every other field's rows", () => {
    const m = computeInputSuccessMetrics(
      [
        row(0, "input_opened"),
        row(10, "suggestion_rendered", { count: 3 }),
        row(20, "suggestion_selected", { suggestionType: "entity" }),
        row(
          30,
          "suggestion_rendered",
          { count: 3 },
          { context: "trip_destination", field_id: "trip.destination" },
        ),
      ],
      { contexts: ["global_search"] },
    );
    // MUTATION: ignoring `contexts` makes the denominator 2 and the rate 0.5 —
    // a recipient picker averaged with a trip title.
    assert.equal(m.rowsRead, 3);
    assert.equal(m.validEntityResolutionRate.n, 1);
    assert.equal(m.validEntityResolutionRate.value, 1);
  });

  it("an empty table produces no numbers at all — which is the state today", () => {
    // 2950 is applied in hosted and its table holds no rows, so this is what a real run
    // reports. It must not look like a measurement of a healthy product.
    const m = computeInputSuccessMetrics([]);
    assert.equal(m.rowsRead, 0);
    assert.equal(m.timeToValidSelectionMs.p95, null);
    assert.equal(m.validEntityResolutionRate.value, null);
    assert.equal(m.manualFallbackRate.value, null);
    assert.equal(m.suggestLatencyServerMs.p50, null);
  });
});
