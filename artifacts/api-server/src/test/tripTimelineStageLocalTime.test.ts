/**
 * Trips spec §7 — cross-timezone multi-city: correct instant ordering and
 * stage local-time display (census-trips TR424).
 *
 *   an item's wall clock is its STAGE's zone (2760 trip_stages.timezone): a
 *   Lisbon item at 08:00Z reads 09:00 local, a Tokyo item at 23:30Z reads
 *   08:30 the next day; instants are never changed, only rendered;
 *   instant order is by the instant, whatever zone each item was entered in;
 *   items with no instant go last, in the order given;
 *   outside every stage the trip's own zone is used and the reading says so;
 *   no zone at all, or a zone this runtime does not know, renders nothing and
 *   says why rather than guessing.
 *
 * Run: node --import tsx/esm --test src/test/tripTimelineStageLocalTime.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  stageLocalTime, withStageLocalTimes, orderByInstant, stageContaining, wallClock, buildTripTimeline,
  STAGE_LOCAL_TIME_READINGS, type TimelineStage,
} from "../services/trips/TripTimelineProjection.js";

const LISBON: TimelineStage = { id: "s1", sequence: 1, timezone: "Europe/Lisbon", startsAt: "2026-09-13T00:00:00Z", endsAt: "2026-09-17T00:00:00Z" };
const TOKYO: TimelineStage = { id: "s2", sequence: 2, timezone: "Asia/Tokyo", startsAt: "2026-09-17T00:00:00Z", endsAt: null };
const STAGES = [TOKYO, LISBON];

describe("TR424 — stage local time", () => {
  it("a Lisbon item at 08:00Z reads 09:00 local (WEST); a Tokyo item at 23:30Z reads 08:30 the next day", () => {
    const a = stageLocalTime({ startsAt: "2026-09-13T08:00:00Z", endsAt: "2026-09-13T09:30:00Z" }, STAGES, "Europe/Paris");
    assert.equal(a.stageId, "s1"); assert.equal(a.timezone, "Europe/Lisbon");
    assert.equal(a.localStartsAt, "2026-09-13T09:00"); assert.equal(a.localEndsAt, "2026-09-13T10:30");
    assert.equal(a.reading, STAGE_LOCAL_TIME_READINGS.stage);
    const b = stageLocalTime({ startsAt: "2026-09-20T23:30:00Z" }, STAGES, "Europe/Paris");
    assert.equal(b.stageId, "s2"); assert.equal(b.localStartsAt, "2026-09-21T08:30"); assert.equal(b.localEndsAt, null);
  });
  it("the stage is found by interval, [startsAt, endsAt): the boundary instant belongs to the later stage", () => {
    assert.equal(stageContaining(Date.parse("2026-09-17T00:00:00Z"), STAGES)?.id, "s2");
    assert.equal(stageContaining(Date.parse("2026-09-16T23:59:59Z"), STAGES)?.id, "s1");
    assert.equal(stageContaining(Date.parse("2026-09-01T00:00:00Z"), STAGES), null);
  });
  it("outside every stage: the trip's own zone, and the reading says so", () => {
    const r = stageLocalTime({ startsAt: "2026-09-01T12:00:00Z" }, STAGES, "Europe/Paris");
    assert.equal(r.stageId, null); assert.equal(r.timezone, "Europe/Paris");
    assert.equal(r.localStartsAt, "2026-09-01T14:00");
    assert.equal(r.reading, STAGE_LOCAL_TIME_READINGS.tripZone);
  });
  it("no zone at all: nothing is rendered and the reading says why", () => {
    const r = stageLocalTime({ startsAt: "2026-09-01T12:00:00Z" }, [], null);
    assert.equal(r.localStartsAt, null); assert.equal(r.timezone, null);
    assert.equal(r.reading, STAGE_LOCAL_TIME_READINGS.noZone);
  });
  it("a zone this runtime does not know: nothing is rendered, the zone is named, the reading says why", () => {
    const r = stageLocalTime({ startsAt: "2026-09-13T08:00:00Z" }, [{ ...LISBON, timezone: "Mars/Olympus" }], null);
    assert.equal(r.localStartsAt, null); assert.equal(r.timezone, "Mars/Olympus"); assert.equal(r.stageId, "s1");
    assert.equal(r.reading, STAGE_LOCAL_TIME_READINGS.badZone);
    assert.equal(wallClock(0, "Mars/Olympus"), null);
  });
  it("no start instant: nothing to render", () => {
    assert.equal(stageLocalTime({ startsAt: null }, STAGES, "Europe/Paris").reading, STAGE_LOCAL_TIME_READINGS.noInstant);
    assert.equal(stageLocalTime({ startsAt: "yesterday" }, STAGES, "Europe/Paris").localStartsAt, null);
  });
  it("withStageLocalTimes keeps every field and adds `local`; the instant itself is untouched", () => {
    const items = [{ id: "a", dayDate: "2026-09-13", startsAt: "2026-09-13T08:00:00Z", endsAt: null, title: "Walk" }];
    const out = withStageLocalTimes(items, STAGES, null);
    assert.equal(out[0]!.title, "Walk"); assert.equal(out[0]!.startsAt, "2026-09-13T08:00:00Z");
    assert.equal(out[0]!.local.localStartsAt, "2026-09-13T09:00");
    assert.equal(buildTripTimeline(out, { tripStartDate: "2026-09-13", tripEndDate: "2026-09-13" }).days[0]!.items[0]!.local.timezone, "Europe/Lisbon");
  });
});

describe("TR424 — instant order", () => {
  it("two items entered in two zones order by the instant, not by entry order", () => {
    // 07:00 Tokyo on the 21st is 22:00Z on the 20th; 23:30 Lisbon-typed on the 20th is 22:30Z.
    const later = { id: "tokyo", startsAt: "2026-09-20T22:00:00Z" };
    const earlier = { id: "lisbon", startsAt: "2026-09-20T21:30:00Z" };
    assert.deepEqual(orderByInstant([later, earlier]).map((i) => i.id), ["lisbon", "tokyo"]);
  });
  it("items with no instant go last, in the order given; ties keep entry order", () => {
    const out = orderByInstant([{ id: "n1", startsAt: null }, { id: "b", startsAt: "2026-09-13T10:00:00Z" }, { id: "n2" }, { id: "a", startsAt: "2026-09-13T10:00:00Z" }]);
    assert.deepEqual(out.map((i) => i.id), ["b", "a", "n1", "n2"]);
  });
});
