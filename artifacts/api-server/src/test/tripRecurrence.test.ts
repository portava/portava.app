/**
 * Trips spec §23 certification scenario "Long-stay 45 days" —
 * "Recurring commitments, routine-aware context, no bloated itinerary model"
 * (census-trips TR427).
 *
 * WHAT THIS FILE PROVES AND WHAT IT CANNOT
 * ========================================
 * domain/trips/invariants/TripRecurrence.ts is PURE, so everything in it can be
 * executed here with no database and no fixture: the local-wall-clock
 * arithmetic, the two DST cases, the bounds, and the routine summary. That is
 * the whole of the read side's hard part.
 *
 * What it cannot reach is the WRITE side — the 2798 kernel branches are plpgsql
 * and are executed by db/harness/probe_recurrence_family.sql, whose run is the
 * evidence for them. src/test/tripKernelRecurrenceFamily.test.ts pins the
 * contract between the two halves (names, events, reasons); this file pins the
 * behaviour of the half that is JavaScript.
 *
 * The DST assertions use Europe/Lisbon 2026, whose transitions are 2026-03-29
 * 01:00 UTC (01:00 → 02:00 local) and 2026-10-25 01:00 UTC (02:00 → 01:00
 * local). They are asserted as INSTANTS, so a test failure means the
 * arithmetic moved, not that a zone database was updated.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_HORIZON_DAYS, MAX_OCCURRENCES,
  RecurrenceHorizonError,
  expandRecurrences, habitualFreeHours, isKnownTimeZone, isoWeekdayOf,
  nextOccurrenceAfter, routineAttentionEvent, summariseRoutine, zonedLocalDate, zonedLocalToInstant,
  type RecurrenceRule,
} from "../domain/trips/invariants/TripRecurrence.js";
import { decideAttention } from "../domain/trips/policies/TripAttentionPolicy.js";
import { buildTripRoutineContext, intervalToMinutes, readTripRecurrences, rowToRule } from "../domain/trips/services/TripRoutineContext.js";

/** The scenario's own example: a 45-day stay with a standing weekday class. */
const WEEKDAY_CLASS: RecurrenceRule = {
  id: "r1", type: "event", label: "Vietnamese class",
  timezone: "Europe/Lisbon", freq: "weekly", intervalCount: 1,
  byWeekday: [1, 2, 3, 4, 5], localTime: "09:00",
  durationMinutes: 90, arrivalLeadMinutes: 10, prepMinutes: 20, latenessToleranceMinutes: 5,
  effectiveFrom: "2026-10-01", effectiveUntil: "2026-11-14", skipDates: [],
};
const STAY_START = new Date("2026-10-01T00:00:00Z");
const STAY_END = new Date("2026-11-15T00:00:00Z");

describe("§23 — a rule in local wall-clock time survives a DST transition", () => {
  it("09:00 stays 09:00 LOCAL across the clock change, which means the INSTANT moves", () => {
    const before = zonedLocalToInstant("2026-10-23", "09:00", "Europe/Lisbon");
    const after = zonedLocalToInstant("2026-10-26", "09:00", "Europe/Lisbon");
    // Friday before the change: Lisbon is UTC+1. Monday after: UTC+0.
    assert.equal(before.instant.toISOString(), "2026-10-23T08:00:00.000Z");
    assert.equal(after.instant.toISOString(), "2026-10-26T09:00:00.000Z");
    assert.equal(before.dst, "normal");
    assert.equal(after.dst, "normal");
    // THE POINT, stated as the test it is: a model that stored the instant plus
    // an interval would have produced 08:00Z on the Monday too — 08:00 local,
    // an hour early, for the remaining 19 days of the stay.
  });

  it("a wall clock that does not exist is shifted forward by the gap, and says so", () => {
    const gap = zonedLocalToInstant("2026-03-29", "01:30", "Europe/Lisbon");
    assert.equal(gap.dst, "skipped_forward");
    // 01:30 local does not exist; 02:30 local does, and 02:30 local is 01:30Z.
    assert.equal(gap.instant.toISOString(), "2026-03-29T01:30:00.000Z");
    assert.equal(zonedLocalDate(gap.instant, "Europe/Lisbon"), "2026-03-29");
  });

  it("a wall clock that happens twice resolves to the EARLIER one, and says so", () => {
    const amb = zonedLocalToInstant("2026-10-25", "01:30", "Europe/Lisbon");
    assert.equal(amb.dst, "ambiguous");
    // The first 01:30 (still UTC+1) is 00:30Z; the second is 01:30Z.
    assert.equal(amb.instant.toISOString(), "2026-10-25T00:30:00.000Z");
  });

  it("an ordinary hour is never reported as a DST case", () => {
    for (const d of ["2026-10-01", "2026-10-15", "2026-11-14"]) {
      assert.equal(zonedLocalToInstant(d, "09:00", "Europe/Lisbon").dst, "normal", d);
    }
  });

  it("a zone the platform does not know is refusable, and an offset is not a zone", () => {
    assert.equal(isKnownTimeZone("Asia/Ho_Chi_Minh"), true);
    assert.equal(isKnownTimeZone("Europe/Lisbob"), false);
    assert.equal(isKnownTimeZone("+07"), false);
    assert.equal(isKnownTimeZone(""), false);
  });
});

describe("§23 — 45 days of a weekday routine is one rule and no rows", () => {
  it("expands to exactly the weekdays in range, in arrival order", () => {
    const r = expandRecurrences([WEEKDAY_CLASS], STAY_START, STAY_END);
    // 2026-10-01 is a Thursday. Oct: 22 weekdays from the 1st. Nov 2–13: 10.
    assert.equal(r.occurrences.length, 32);
    assert.equal(r.truncated, false);
    assert.equal(r.horizonDays, 45);
    assert.deepEqual(r.rejected, []);
    for (let i = 1; i < r.occurrences.length; i += 1) {
      assert.ok(r.occurrences[i - 1]!.requiredArrivalAt <= r.occurrences[i]!.requiredArrivalAt,
        "occurrences are not in arrival order");
    }
    for (const o of r.occurrences) assert.ok(isoWeekdayOf(o.localDate) <= 5, `${o.localDate} is a weekend`);
  });

  it("the §7.1 fields are derived per occurrence, not copied from the rule verbatim", () => {
    const [first] = expandRecurrences([WEEKDAY_CLASS], STAY_START, STAY_END).occurrences;
    assert.ok(first);
    assert.equal(first.startsAt.toISOString(), "2026-10-01T08:00:00.000Z");
    // arrival_lead 10 minutes BEFORE the start; that is what §7.1's
    // requiredArrivalAt means and a rule can only express it relatively.
    assert.equal(first.requiredArrivalAt.toISOString(), "2026-10-01T07:50:00.000Z");
    assert.equal(first.endsAt?.toISOString(), "2026-10-01T09:30:00.000Z");
    assert.equal(first.prepMinutes, 20);
    assert.equal(first.latenessToleranceMinutes, 5);
  });

  it("an occurrence id is deterministic and is NOT a commitment id", () => {
    const a = expandRecurrences([WEEKDAY_CLASS], STAY_START, STAY_END).occurrences[0]!;
    const b = expandRecurrences([WEEKDAY_CLASS], STAY_START, STAY_END).occurrences[0]!;
    assert.equal(a.id, b.id, "two reads disagreed about the same occurrence's identity");
    assert.equal(a.id, "rec:r1:2026-10-01");
    // A uuid is 8-4-4-4-12 hex. An occurrence id must not be mistakable for one,
    // because UPDATE_COMMITMENT would then accept it and there is no row.
    assert.ok(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.id));
  });

  it("a skipped date is the exception mechanism and simply is not there", () => {
    const withSkip = { ...WEEKDAY_CLASS, skipDates: ["2026-10-15", "2026-10-16"] };
    const r = expandRecurrences([withSkip], STAY_START, STAY_END);
    assert.equal(r.occurrences.length, 30);
    assert.ok(!r.occurrences.some((o) => o.localDate === "2026-10-15"));
    assert.ok(!r.occurrences.some((o) => o.localDate === "2026-10-16"));
  });

  it("the effective range bounds the expansion even when the caller's range is wider", () => {
    const r = expandRecurrences([WEEKDAY_CLASS], new Date("2026-09-01T00:00:00Z"), new Date("2026-11-30T00:00:00Z"));
    assert.equal(r.occurrences[0]!.localDate, "2026-10-01");
    assert.equal(r.occurrences.at(-1)!.localDate, "2026-11-13");
  });

  it("daily and every-N patterns count from the rule's own start", () => {
    const daily: RecurrenceRule = { ...WEEKDAY_CLASS, id: "d", freq: "daily", byWeekday: null, intervalCount: 1 };
    assert.equal(expandRecurrences([daily], STAY_START, STAY_END).occurrences.length, 45);

    const everyOther: RecurrenceRule = { ...daily, id: "d2", intervalCount: 2 };
    assert.equal(expandRecurrences([everyOther], STAY_START, STAY_END).occurrences.length, 23);

    // "every other Tuesday", anchored on the week the rule starts — not on an
    // epoch, and not on the day of the week the rule happens to begin.
    const fortnightly: RecurrenceRule = { ...WEEKDAY_CLASS, id: "f", byWeekday: [2], intervalCount: 2 };
    const got = expandRecurrences([fortnightly], STAY_START, STAY_END).occurrences.map((o) => o.localDate);
    assert.deepEqual(got, ["2026-10-06", "2026-10-20", "2026-11-03"]);
  });

  it("a malformed rule is REJECTED by name, never silently expanded to nothing", () => {
    const cases: [Partial<RecurrenceRule>, string][] = [
      [{ timezone: "Europe/Lisbob" }, "UNKNOWN_TIMEZONE"],
      [{ localTime: "tea time" }, "MALFORMED_LOCAL_TIME"],
      [{ effectiveUntil: "2026-09-01" }, "MALFORMED_DATE_RANGE"],
      [{ freq: "monthly" as never }, "UNKNOWN_FREQ"],
      [{ byWeekday: [] }, "WEEKLY_WITHOUT_WEEKDAYS"],
      [{ intervalCount: 0 }, "INTERVAL_OUT_OF_RANGE"],
      [{ intervalCount: 53 }, "INTERVAL_OUT_OF_RANGE"],
    ];
    for (const [patch, reason] of cases) {
      const r = expandRecurrences([{ ...WEEKDAY_CLASS, ...patch }], STAY_START, STAY_END);
      assert.equal(r.occurrences.length, 0);
      assert.deepEqual(r.rejected, [{ ruleId: "r1", reason }], JSON.stringify(patch));
    }
  });

  it("a rule that produces nothing in range says which rule, rather than vanishing", () => {
    const past: RecurrenceRule = { ...WEEKDAY_CLASS, id: "old", effectiveFrom: "2026-01-01", effectiveUntil: "2026-01-31" };
    const r = expandRecurrences([past], STAY_START, STAY_END);
    assert.deepEqual(r.inactiveRuleIds, ["old"]);
    assert.deepEqual(r.rejected, []);
  });
});

describe("§23 — 'no bloated itinerary model' is enforced, not promised", () => {
  it("a horizon longer than the maximum is REFUSED, not served", () => {
    const tooLong = new Date(STAY_START.getTime() + (MAX_HORIZON_DAYS + 1) * 86_400_000);
    assert.throws(() => expandRecurrences([WEEKDAY_CLASS], STAY_START, tooLong), RecurrenceHorizonError);
    // And the boundary itself is served, so the cap is a cap and not an
    // off-by-one that quietly narrows every caller.
    const atLimit = new Date(STAY_START.getTime() + MAX_HORIZON_DAYS * 86_400_000);
    assert.doesNotThrow(() => expandRecurrences([WEEKDAY_CLASS], STAY_START, atLimit));
  });

  it("the occurrence cap stops the expansion and SAYS it was truncated", () => {
    // Enough daily rules to exceed MAX_OCCURRENCES over a 120-day horizon.
    const rules: RecurrenceRule[] = [];
    for (let i = 0; i < 12; i += 1) {
      rules.push({ ...WEEKDAY_CLASS, id: `r${i}`, freq: "daily", byWeekday: null, effectiveUntil: "2027-01-28" });
    }
    const r = expandRecurrences(rules, STAY_START, new Date(STAY_START.getTime() + MAX_HORIZON_DAYS * 86_400_000));
    assert.equal(r.truncated, true);
    assert.equal(r.occurrences.length, MAX_OCCURRENCES);
  });

  it("Today's question is answered without expanding a horizon at all", () => {
    const next = nextOccurrenceAfter([WEEKDAY_CLASS], new Date("2026-10-19T12:00:00Z"));
    assert.ok(next);
    // Monday 19th's class is past at 12:00; the next is Tuesday the 20th.
    assert.equal(next.localDate, "2026-10-20");
    assert.equal(next.requiredArrivalAt.toISOString(), "2026-10-20T07:50:00.000Z");

    // Over a weekend it skips to Monday rather than inventing a Saturday.
    assert.equal(nextOccurrenceAfter([WEEKDAY_CLASS], new Date("2026-10-24T12:00:00Z"))?.localDate, "2026-10-26");
    // Past the rule's end there is no next, and that is null rather than a
    // stale last occurrence.
    assert.equal(nextOccurrenceAfter([WEEKDAY_CLASS], new Date("2026-12-01T00:00:00Z")), null);
  });
});

describe("§23 — routine-aware context is derived from the RULES, not their expansion", () => {
  const summary = summariseRoutine([WEEKDAY_CLASS], new Date("2026-10-20T12:00:00Z"));

  it("says the cadence in words a surface can print once instead of 32 times", () => {
    assert.equal(summary.entries.length, 1);
    assert.equal(summary.entries[0]!.cadence, "every weekday at 09:00");
    assert.equal(summary.entries[0]!.active, true);
    assert.equal(summary.occurrencesPerWeek, 5);
    assert.equal(summary.hasDailyRhythm, true);
    assert.equal(summary.timezone, "Europe/Lisbon");
  });

  it("names the hours the routine CLAIMS, including prep and arrival lead", () => {
    // 09:00 start, 20m prep + 10m lead => claimed from 08:30; 90m duration => to 10:30.
    assert.deepEqual(summary.claimedHoursByWeekday[1], [8, 9, 10]);
    assert.deepEqual(summary.claimedHoursByWeekday[6], []);
    assert.deepEqual(habitualFreeHours(summary, 1).slice(0, 9), [0, 1, 2, 3, 4, 5, 6, 7, 11]);
    assert.equal(habitualFreeHours(summary, 6).length, 24, "a Saturday with no rule is entirely free");
  });

  it("a rule outside its own dates is listed and marked inactive, not dropped", () => {
    const s = summariseRoutine([WEEKDAY_CLASS], new Date("2026-12-20T12:00:00Z"));
    assert.equal(s.entries[0]!.active, false);
    assert.equal(s.occurrencesPerWeek, 0, "an inactive rule must not claim time");
    assert.equal(s.hasDailyRhythm, false);
  });

  it("cadence reads correctly for the other shapes", () => {
    const say = (r: Partial<RecurrenceRule>): string =>
      summariseRoutine([{ ...WEEKDAY_CLASS, ...r }], new Date("2026-10-20T12:00:00Z")).entries[0]!.cadence;
    assert.equal(say({ freq: "daily", byWeekday: null }), "every day at 09:00");
    assert.equal(say({ freq: "daily", byWeekday: null, intervalCount: 3 }), "every 3 days at 09:00");
    assert.equal(say({ byWeekday: [6, 7] }), "every weekend day at 09:00");
    assert.equal(say({ byWeekday: [2, 4] }), "every Tue, Thu at 09:00");
    assert.equal(say({ byWeekday: [2, 4], intervalCount: 2 }), "every 2 weeks on Tue, Thu at 09:00");
  });

  it("two zones disagreeing is reported as no single zone rather than as one of them", () => {
    const other: RecurrenceRule = { ...WEEKDAY_CLASS, id: "r2", timezone: "Asia/Ho_Chi_Minh" };
    assert.equal(summariseRoutine([WEEKDAY_CLASS, other], new Date("2026-10-20T12:00:00Z")).timezone, null);
  });
});

describe("§11.4 — a routine occurrence is not news", () => {
  const ctx = { now: Date.parse("2026-10-20T07:00:00Z"), mode: "NORMAL" as const, recentNotifyCount: 0, quietHours: false };
  const occ = expandRecurrences([WEEKDAY_CLASS], STAY_START, STAY_END).occurrences
    .find((o) => o.localDate === "2026-10-20")!;

  it("an ON-PATTERN occurrence never reaches a push", () => {
    const decision = decideAttention(routineAttentionEvent(occ), ctx);
    assert.ok(!["NOTIFY", "INTERRUPT"].includes(decision.level),
      `a standing obligation produced ${decision.level}; 32 of them would be 32 pushes`);
  });

  it("a DST-moved occurrence is worth more attention than an on-pattern one", () => {
    const moved = { ...occ, dst: "skipped_forward" as const };
    const plain = routineAttentionEvent(occ);
    const shifted = routineAttentionEvent(moved);
    assert.equal(plain.significance, "none");
    assert.equal(plain.actionable, false);
    assert.equal(shifted.significance, "medium");
    assert.equal(shifted.actionable, true);
    const order = ["IGNORE", "PASSIVE", "SURFACE", "NOTIFY", "INTERRUPT"];
    assert.ok(order.indexOf(decideAttention(shifted, ctx).level) >= order.indexOf(decideAttention(plain, ctx).level));
  });
});

describe("the read is THREE-VALUED: no routine, no table and a failed read differ", () => {
  // The whole reason this read does not refuse the projection the way the
  // commitment read does: 2797 is on no database yet, so "the table is not
  // there" is the ordinary state of every deployment for now, and an empty
  // list must not be able to mean three different things.
  const client = (answer: { data?: unknown; error?: { code?: string; message?: string } | null }) => ({
    from: () => ({ select: () => ({ eq: async () => answer }) }),
  });

  it("rows present → ok", async () => {
    const layer = await readTripRecurrences(client({ data: [{
      id: "r1", type: "event", timezone: "Europe/Lisbon", freq: "daily", interval_count: 1,
      local_time: "09:00:00", effective_from: "2026-10-01", effective_until: "2026-10-10",
    }], error: null }), "t1");
    assert.equal(layer.status, "ok");
    assert.equal(layer.status === "ok" ? layer.items.length : -1, 1);
  });

  it("no rows → ok and EMPTY, which means 'this traveller has no routine'", async () => {
    const layer = await readTripRecurrences(client({ data: [], error: null }), "t1");
    assert.equal(layer.status, "ok");
    assert.deepEqual(layer.status === "ok" ? layer.items : null, []);
  });

  it("the table does not exist → no_source, with the migration named", async () => {
    for (const err of [{ code: "42P01", message: 'relation "trip_commitment_recurrences" does not exist' },
                       { code: "PGRST205", message: "Could not find the table 'public.trip_commitment_recurrences'" }]) {
      const layer = await readTripRecurrences(client({ data: null, error: err }), "t1");
      assert.equal(layer.status, "no_source", err.code);
      assert.match(layer.status === "no_source" ? layer.reason : "", /2797_trip_commitment_recurrences\.sql/);
    }
  });

  it("any other failure → unread, which is retryable and is NOT 'no routine'", async () => {
    const layer = await readTripRecurrences(client({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }), "t1");
    assert.equal(layer.status, "unread");
  });

  it("a thrown read is caught and classified the same way", async () => {
    const thrower = { from: () => ({ select: () => ({ eq: async () => { throw Object.assign(new Error("relation \"trip_commitment_recurrences\" does not exist"), { code: "42P01" }); } }) }) };
    assert.equal((await readTripRecurrences(thrower, "t1")).status, "no_source");
  });

  it("a horizon the expander refuses leaves the SUMMARY intact and says what was lost", async () => {
    const ctx = await buildTripRoutineContext(client({ data: [{
      id: "r1", type: "event", timezone: "Europe/Lisbon", freq: "weekly", interval_count: 1,
      by_weekday: [1, 2, 3, 4, 5], local_time: "09:00:00",
      effective_from: "2026-10-01", effective_until: "2027-06-01",
    }], error: null }), "t1", STAY_START, new Date(STAY_START.getTime() + (MAX_HORIZON_DAYS + 30) * 86_400_000));
    assert.equal(ctx.occurrences.length, 0);
    assert.match(String(ctx.horizonRefused), /exceeds the 120-day maximum/);
    // The PATTERN is still answerable without expanding anything — which is the
    // point of deriving the summary from the rules.
    assert.equal(ctx.summary?.entries[0]?.cadence, "every weekday at 09:00");
  });
});

describe("the row → rule adapter", () => {
  it("reads 2797's columns, in either interval spelling", () => {
    const rule = rowToRule({
      id: "r1", trip_id: "t1", stage_id: null, type: "event", label: "Class",
      timezone: "Europe/Lisbon", freq: "weekly", interval_count: 1,
      by_weekday: [1, 2, 3, 4, 5], local_time: "09:00:00",
      duration: "PT1H30M", arrival_lead: "00:10:00", lateness_tolerance: null, prep_duration: "20 minutes",
      place_id: null, flexibility: "fixed", confidence: "0.90",
      effective_from: "2026-10-01", effective_until: "2026-11-14", skip_dates: ["2026-10-15"],
    });
    assert.equal(rule.durationMinutes, 90);
    assert.equal(rule.arrivalLeadMinutes, 10);
    assert.equal(rule.prepMinutes, 20);
    assert.equal(rule.latenessToleranceMinutes, null, "an absent interval is null, not zero");
    assert.equal(rule.confidence, 0.9);
    assert.deepEqual(rule.byWeekday, [1, 2, 3, 4, 5]);
    assert.deepEqual(rule.skipDates, ["2026-10-15"]);
    assert.equal(expandRecurrences([rule], STAY_START, STAY_END).occurrences.length, 31);
  });

  it("parses PostgreSQL array literals, which some drivers do not unpack", () => {
    const rule = rowToRule({
      id: "r1", type: "event", timezone: "Europe/Lisbon", freq: "weekly", interval_count: 1,
      by_weekday: "{1,3,5}", local_time: "09:00:00", skip_dates: "{2026-10-15}",
      effective_from: "2026-10-01", effective_until: "2026-11-14",
    });
    assert.deepEqual(rule.byWeekday, [1, 3, 5]);
    assert.deepEqual(rule.skipDates, ["2026-10-15"]);
  });

  it("an unparseable interval is null — 'the rule does not say', never zero", () => {
    assert.equal(intervalToMinutes("whenever"), null);
    assert.equal(intervalToMinutes(null), null);
    assert.equal(intervalToMinutes("PT45M"), 45);
    assert.equal(intervalToMinutes("01:30:00"), 90);
    assert.equal(intervalToMinutes("2 hours"), 120);
  });
});
