/**
 * §24 Observability and Quality Metrics — the counted half.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS
 * -----------------------------------
 * A metrics module is trivially easy to test in a way that proves nothing:
 * increment a counter, read it back, assert it is 1. The tests below are
 * instead aimed at the two ways a §24 metric can be actively harmful:
 *
 *   1. A RATE FABRICATED FROM AN EMPTY DENOMINATOR. `place_correction_rate: 0`
 *      computed from zero commands is indistinguishable, to the operator
 *      reading it, from "nobody corrects places". This repository has already
 *      paid for that exact confusion once — migration 2999 exists because
 *      trust_profiles stored "not measured" as a fabricated neutral 50. The
 *      rate must be `null`, and the raw counts must ride alongside so the
 *      reader can always see what it was computed from.
 *   2. A METRIC CLAIMED AND REFUSED AT THE SAME TIME. `MEMORY_METRICS_NOT_MEASURABLE`
 *      is a promise that those names are NOT emitted. If one appeared in both
 *      sets the module would be asserting and denying the same thing, and a
 *      consumer of either list would be misled.
 *
 * Pure and offline: no database, no network, no clock dependence, no fixed date.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_KERNEL_METRICS,
  MEMORY_METRICS_NOT_MEASURABLE,
  MEMORY_KERNEL_METRICS_ENGINE_VERSION,
  _resetMemoryKernelMetrics,
  countCandidateEvaluation,
  countAcceptedCommand,
  readMemoryKernelMetrics,
  rateOf,
  buildProjectionLagSample,
  recordProjectionLag,
  PROJECTION_LAG,
} from "../services/memory/memoryKernelMetrics.js";

beforeEach(() => { _resetMemoryKernelMetrics(); });

// ── 1. a rate with no denominator ───────────────────────────────────────────

describe("§24 a rate with no denominator is null, never 0", () => {
  it("rateOf refuses an empty denominator", () => {
    assert.equal(rateOf(0, 0), null, "0/0 is not 0 — it is 'nothing was measured'");
    assert.equal(rateOf(5, 0), null);
    assert.equal(rateOf(1, -1), null);
  });

  it("rateOf refuses a non-finite input rather than emitting NaN", () => {
    assert.equal(rateOf(NaN, 10), null);
    assert.equal(rateOf(1, Infinity), null);
  });

  it("every rate is null on a fresh process — nothing has happened yet", () => {
    const m = readMemoryKernelMetrics();
    assert.equal(m.candidate_confirm_rate, null);
    assert.equal(m.candidate_reject_rate, null);
    assert.equal(m.place_correction_rate, null);
    assert.equal(m.participant_correction_rate, null);
    assert.equal(m.explicit_memory_without_candidate_rate, null);
  });

  it("a rate becomes a NUMBER only once its denominator is non-empty", () => {
    countAcceptedCommand("CONFIRM_MEMORY", false);
    const m = readMemoryKernelMetrics();
    assert.equal(m.place_correction_rate, 0, "one command, no place correction ⇒ a measured 0");
    assert.notEqual(m.place_correction_rate, null);
  });

  it("the raw counts ride alongside every rate", () => {
    // Without these an operator cannot tell 0/1 from 0/10000.
    countAcceptedCommand("CHANGE_PLACE", false);
    const m = readMemoryKernelMetrics();
    assert.equal(m.counts.commandsAccepted, 1);
    assert.equal(m.counts.placeCorrections, 1);
    assert.equal(m.place_correction_rate, 1);
  });
});

// ── 2. the correction rates (H215, H216) ────────────────────────────────────

describe("§24 correction rates count the commands §17 actually declares", () => {
  it("place_correction_rate counts CHANGE_PLACE over accepted commands", () => {
    countAcceptedCommand("CHANGE_PLACE", false);
    countAcceptedCommand("CONFIRM_MEMORY", false);
    countAcceptedCommand("ADD_MEDIA", false);
    countAcceptedCommand("ARCHIVE_MEMORY", false);
    assert.equal(readMemoryKernelMetrics().place_correction_rate, 0.25);
  });

  it("participant_correction_rate counts BOTH ADD_PERSON and REMOVE_PERSON", () => {
    // §24 asks about participant CORRECTION, and removing a wrong tag is as
    // much a correction as adding a missing one. Counting only one would
    // halve the figure for the same underlying behaviour.
    countAcceptedCommand("ADD_PERSON", false);
    countAcceptedCommand("REMOVE_PERSON", false);
    countAcceptedCommand("CONFIRM_MEMORY", false);
    countAcceptedCommand("ADD_MEDIA", false);
    assert.equal(readMemoryKernelMetrics().participant_correction_rate, 0.5);
  });

  it("a command that is neither does not move either numerator", () => {
    countAcceptedCommand("UPDATE_MEMORY", false);
    const m = readMemoryKernelMetrics();
    assert.equal(m.counts.placeCorrections, 0);
    assert.equal(m.counts.participantCorrections, 0);
    assert.equal(m.counts.commandsAccepted, 1);
  });
});

// ── 3. candidate rates (H211, H212) ─────────────────────────────────────────

describe("§24 candidate confirm / reject rates", () => {
  it("the two rates are taken from the same denominator and sum to 1", () => {
    countCandidateEvaluation(true);
    countCandidateEvaluation(true);
    countCandidateEvaluation(false);
    const m = readMemoryKernelMetrics();
    assert.equal(m.counts.candidatesEvaluated, 3);
    assert.equal(m.candidate_confirm_rate! + m.candidate_reject_rate!, 1);
  });

  it("an evaluation is counted exactly once, on whichever side it fell", () => {
    countCandidateEvaluation(false);
    const m = readMemoryKernelMetrics();
    assert.equal(m.counts.candidatesConfirmed, 0);
    assert.equal(m.counts.candidatesRejected, 1);
    assert.equal(m.counts.candidatesEvaluated, 1);
  });
});

// ── 4. H218 ─────────────────────────────────────────────────────────────────

describe("§24 explicit_memory_without_candidate_rate", () => {
  it("is measured over CREATE_MEMORY only, not over all commands", () => {
    countAcceptedCommand("CREATE_MEMORY", false);
    countAcceptedCommand("CREATE_MEMORY", true);
    countAcceptedCommand("ARCHIVE_MEMORY", false);   // must not enter either side
    const m = readMemoryKernelMetrics();
    assert.equal(m.counts.explicitMemoriesCreated, 2);
    assert.equal(m.counts.explicitMemoriesWithoutCandidate, 1);
    assert.equal(m.explicit_memory_without_candidate_rate, 0.5);
  });

  it("hadCandidate is ignored for a command that is not CREATE_MEMORY", () => {
    countAcceptedCommand("CHANGE_PLACE", true);
    assert.equal(readMemoryKernelMetrics().counts.explicitMemoriesCreated, 0);
  });
});

// ── 5. the refusals are refusals ────────────────────────────────────────────

describe("§24 metrics this module refuses to emit", () => {
  it("the emitted names and the refused names are DISJOINT", () => {
    // A name in both would be a metric claimed and denied at once.
    const emitted = new Set<string>(Object.values(MEMORY_KERNEL_METRICS));
    for (const refused of Object.keys(MEMORY_METRICS_NOT_MEASURABLE)) {
      assert.ok(!emitted.has(refused),
        `${refused} is listed as not-measurable AND emitted`);
    }
  });

  it("every refusal carries a reason, not an empty string", () => {
    for (const [name, reason] of Object.entries(MEMORY_METRICS_NOT_MEASURABLE)) {
      assert.equal(typeof reason, "string");
      assert.ok(reason.length > 40, `${name}'s refusal must say WHY, in a sentence`);
    }
  });

  it("the sample reports the refused set so a reader is never told a false zero", () => {
    const m = readMemoryKernelMetrics();
    assert.deepEqual([...m.notMeasurable].sort(),
      Object.keys(MEMORY_METRICS_NOT_MEASURABLE).sort());
  });

  it("the four §24 names with no countable event are all refused", () => {
    for (const n of ["candidate_split_rate", "candidate_merge_rate",
                     "false_memory_rate", "do_again_conversion"]) {
      assert.ok(n in MEMORY_METRICS_NOT_MEASURABLE, `${n} must be refused, not faked`);
    }
  });
});

// ── 6. projection_lag (H220) ────────────────────────────────────────────────

describe("§24 projection_lag measures the SLOWER clock", () => {
  const base = {
    eventId: "e1", eventType: "memory.created", memoryId: "m1",
    projectionsRebuilt: 3, projectionsSkipped: 0, projectionsFailed: 0,
    failureClass: null as string | null,
  };

  it("lag is event-enqueued -> rebuild-finished, not the rebuild duration", () => {
    // The whole point: an operator optimising `rebuildMs` is optimising the
    // wrong thing. A projection that sat in the outbox for an hour and rebuilt
    // in 50ms has an hour of lag, not 50ms.
    const s = buildProjectionLagSample({
      ...base, enqueuedAtMs: 1_000_000, startedAtMs: 4_600_000, finishedAtMs: 4_600_050,
    });
    assert.equal(s.rebuildMs, 50);
    assert.equal(s.lagMs, 3_600_050);
    assert.ok(s.lagMs > s.rebuildMs);
  });

  it("lag is never less than the rebuild it contains", () => {
    const s = buildProjectionLagSample({
      ...base, enqueuedAtMs: 9_999_999, startedAtMs: 1_000, finishedAtMs: 2_000,
    });
    assert.ok(s.lagMs >= s.rebuildMs, "a lag shorter than its own rebuild is impossible");
  });

  it("a backwards clock is a zero, not a negative headline", () => {
    const s = buildProjectionLagSample({
      ...base, enqueuedAtMs: 5_000, startedAtMs: 5_000, finishedAtMs: 4_000,
    });
    assert.equal(s.rebuildMs, 0);
    assert.equal(s.lagMs, 0);
  });

  it("an unparseable enqueue time does not produce NaN", () => {
    const s = buildProjectionLagSample({
      ...base, enqueuedAtMs: Number.NaN, startedAtMs: 1_000, finishedAtMs: 1_200,
    });
    assert.ok(Number.isFinite(s.lagMs));
    assert.equal(s.lagMs, 200);
  });

  it("the sample carries §24's own metric name and the engine version", () => {
    const s = buildProjectionLagSample({ ...base, enqueuedAtMs: 1, startedAtMs: 2, finishedAtMs: 3 });
    assert.equal(s.metric, PROJECTION_LAG);
    assert.equal(s.metric, "projection_lag");
    assert.equal(s.engineVersion, MEMORY_KERNEL_METRICS_ENGINE_VERSION);
  });

  it("the sample carries ids and vocabulary, never the Memory's body (§23)", () => {
    const s: Record<string, unknown> = buildProjectionLagSample({
      ...base, enqueuedAtMs: 1, startedAtMs: 2, finishedAtMs: 3,
    }) as any;
    for (const forbidden of ["title", "caption", "location_lat", "location_lng",
                             "media_url", "allowed_user_ids", "hidden_user_ids"]) {
      assert.ok(!(forbidden in s), `a metric sample must not carry ${forbidden}`);
    }
  });
});

describe("§24 emitting the lag sample", () => {
  it("a missing logger is a no-op, never a throw", () => {
    // A projection rebuild must not fail because nobody was listening.
    const s = buildProjectionLagSample({
      eventId: "e", eventType: "memory.created", memoryId: "m",
      enqueuedAtMs: 1, startedAtMs: 2, finishedAtMs: 3,
      projectionsRebuilt: 1, projectionsSkipped: 0, projectionsFailed: 0, failureClass: null,
    });
    assert.doesNotThrow(() => recordProjectionLag(undefined, s));
    assert.doesNotThrow(() => recordProjectionLag({} as any, s));
  });

  it("A PARTIAL REBUILD SAYS SO IN THE MESSAGE — the lag is not 'time until fresh'", () => {
    const lines: Array<{ obj: any; msg: string }> = [];
    const log = { info: (obj: any, msg: string) => { lines.push({ obj, msg }); } };

    recordProjectionLag(log, buildProjectionLagSample({
      eventId: "e", eventType: "memory.created", memoryId: "m",
      enqueuedAtMs: 1, startedAtMs: 2, finishedAtMs: 3,
      projectionsRebuilt: 1, projectionsSkipped: 0, projectionsFailed: 2,
      failureClass: "registry_unavailable",
    }));

    assert.equal(lines.length, 1);
    assert.match(lines[0]!.msg, /did NOT rebuild/,
      "a lag reported from a failed rebuild must not read as a clean measurement");
    assert.equal(lines[0]!.obj.failureClass, "registry_unavailable");
  });

  it("a clean rebuild emits the plain metric line", () => {
    const lines: string[] = [];
    recordProjectionLag({ info: (_o: any, m: string) => { lines.push(m); } },
      buildProjectionLagSample({
        eventId: "e", eventType: "memory.created", memoryId: "m",
        enqueuedAtMs: 1, startedAtMs: 2, finishedAtMs: 3,
        projectionsRebuilt: 1, projectionsSkipped: 0, projectionsFailed: 0, failureClass: null,
      }));
    assert.equal(lines[0], "metrics: projection_lag");
  });
});
