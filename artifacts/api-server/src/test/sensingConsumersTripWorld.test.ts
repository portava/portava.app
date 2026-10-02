/**
 * S83 — `TripWorldContext` carries the five named parts.
 *
 * The census: *"`compass/CompassTripContext.ts` still exports exactly one
 * function, `buildTripContextLines`, and it is trip grounding — no world state,
 * no opportunities, no disruptions, no sessions. RED WHEN S54
 * (`ExperienceSession`) exists and a `TripWorldContext` projection carries the
 * five named parts."* The five, from the row's own title: current world state,
 * nearby opportunities, disruptions, ExperienceSessions, crew context.
 *
 * The hardest assertion here is not that the parts exist. It is that a part
 * whose source FAILED is reported as unavailable rather than as empty — the
 * failure `buildTripContextLines` documents at length ("an unreadable
 * trip_plan_items produced zero rows … and the assistant then told the user
 * their day was empty"), which this projection must not reintroduce four more
 * times.
 *
 * Watched red: neither `buildTripWorldContext` nor `formatTripWorldContextLines`
 * exists at e46fe054a, where the module exports exactly one function.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRIP_DISRUPTION_CLAIM_TYPES,
  TRIP_WORLD_CONTEXT_HEADER,
  TRIP_WORLD_PARTS,
  buildTripWorldContext,
  formatTripWorldContextLines,
  type TripWorldContext,
} from "../compass/CompassTripContext.js";
import { closeExperienceSession, openExperienceSession } from "../lib/experienceSession.js";

const NOW = new Date("2026-09-20T21:00:00.000Z");
const NOW_MS = NOW.getTime();
const USER = "11111111-aaaa-4aaa-8aaa-111111111111";
const TRIP = "99999999-9999-4999-8999-999999999999";
const PLACE = "22222222-bbbb-4bbb-8bbb-222222222222";
const SESSION = "33333333-cccc-4ccc-8ccc-333333333333";

/** A chainable, thenable Supabase stand-in driven by a per-table resolver. */
function stubClient(resolve: (table: string) => { data: unknown; error: unknown }) {
  return {
    from(table: string) {
      const self: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gt", "gte", "lt", "order", "limit", "is", "neq"]) {
        self[m] = () => self;
      }
      const run = () => resolve(table);
      self.maybeSingle = async () => run();
      self.single = async () => run();
      self.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(onOk, onErr);
      return self;
    },
  };
}

const TRIP_ROW = {
  id: TRIP,
  title: "Lisbon week",
  destination_city: "Lisbon",
  destination_country: "Portugal",
  start_date: "2026-09-18",
  end_date: "2026-09-25",
  status: "active",
  timezone: "UTC",
};

/** The open session event, as the spine stores it. */
function openSessionRow() {
  const r = openExperienceSession(
    USER,
    { sessionId: SESSION, subjectId: PLACE, opportunityKind: "go_now", claimRefs: ["snap-1"] },
    NOW_MS - 30 * 60 * 1000,
  );
  assert.ok(r.ok);
  return { payload: { experience_session: r.envelope }, occurred_at: r.envelope.opened_at };
}

const KERNEL = {
  world: {
    subjects: [
      { subjectId: PLACE, readable: true, crowd: { density: "busy" }, forecast: { expectedDensity: "very_busy" }, truth: { truthClass: "observed" } },
    ],
  },
} as never;

describe("S83 — the projection carries all five named parts", () => {
  it("names exactly the five the row names", () => {
    assert.deepEqual([...TRIP_WORLD_PARTS], [
      "world_state", "opportunities", "disruptions", "sessions", "crew",
    ]);
  });

  it("builds all five from their existing owners", async () => {
    const sc = stubClient((table) => {
      switch (table) {
        case "trip_members":
          // Serves both resolveUserTrips (trip_id/role) and the crew read.
          return { data: [{ trip_id: TRIP, role: "owner", status: "accepted", profiles: { handle: "ana" } }], error: null };
        case "trips":
          return { data: [TRIP_ROW], error: null };
        case "trip_plan_items":
          return { data: [{ id: "item-1", title: "Fado at Tasca", place_id: PLACE, status: "confirmed" }], error: null };
        case "canonical_events":
          return { data: [openSessionRow()], error: null };
        default:
          // Flags and snapshots unreadable ⇒ live reads fail closed to [].
          return { data: null, error: { message: "unavailable" } };
      }
    });

    const ctx = await buildTripWorldContext(sc, USER, {
      now: NOW,
      kernel: KERNEL,
      opportunities: [{ kind: "go_now", subjectId: PLACE, truth: { truthClass: "observed" } } as never],
    });

    // 1. current world state — taken from the kernel, not recomputed.
    assert.deepEqual(ctx.worldState, [
      { subjectId: PLACE, density: "busy", forecast: "very_busy", truthClass: "observed", readable: true },
    ]);
    // 2. nearby opportunities — the admitted projection, carried through.
    assert.equal(ctx.opportunities?.length, 1);
    // 4. ExperienceSessions — the one open session the S54 seam offers.
    assert.equal(ctx.sessions.length, 1);
    assert.equal(ctx.sessions[0].sessionId, SESSION);
    assert.equal(ctx.sessions[0].state, "open");
    assert.equal(ctx.sessions[0].opportunityKind, "go_now");
    // 5. crew context — handles only.
    assert.deepEqual(ctx.crew, ["@ana"]);
    // 3. disruptions — the read ran (the plan table answered) and the live
    //    gates refused, so there is nothing to report and nothing is claimed.
    assert.deepEqual(ctx.disruptions, []);

    assert.equal(ctx.tripId, TRIP);
    assert.match(String(ctx.tripTitle), /Lisbon week/);
  });

  it("a closed session is not an open one", async () => {
    const opened = openExperienceSession(
      USER, { sessionId: SESSION, subjectId: PLACE, opportunityKind: "go_now", claimRefs: [] }, NOW_MS - 30 * 60 * 1000,
    );
    assert.ok(opened.ok);
    const closed = closeExperienceSession(opened.envelope, USER, { outcome: "better" }, NOW_MS - 60 * 1000);
    assert.ok(closed.ok);
    const sc = stubClient((table) => {
      if (table === "trip_members") return { data: [{ trip_id: TRIP, role: "owner", status: "accepted", profiles: { handle: "ana" } }], error: null };
      if (table === "trips") return { data: [TRIP_ROW], error: null };
      if (table === "trip_plan_items") return { data: [], error: null };
      if (table === "canonical_events") {
        return {
          data: [
            { payload: { experience_session: opened.envelope }, occurred_at: opened.envelope.opened_at },
            { payload: { experience_session: closed.envelope }, occurred_at: closed.envelope.closed_at },
          ],
          error: null,
        };
      }
      return { data: null, error: { message: "unavailable" } };
    });
    const ctx = await buildTripWorldContext(sc, USER, { now: NOW, kernel: KERNEL });
    assert.deepEqual(ctx.sessions, []);
    assert.deepEqual(ctx.unavailable, []);
  });

  it("disruption claim types are the ones that say a planned thing may not happen", () => {
    assert.deepEqual([...TRIP_DISRUPTION_CLAIM_TYPES], ["transit.condition", "closure.state", "event.status"]);
    // A busy bar is not a disruption.
    assert.equal(TRIP_DISRUPTION_CLAIM_TYPES.includes("crowd.level"), false);
  });
});

describe("S83 — an unreadable source is UNAVAILABLE, never empty", () => {
  it("marks each failed part rather than reporting it as nothing", async () => {
    // `trip_members` is read twice — once to resolve the trip, once for the
    // crew — so the first call succeeds and the second fails, which is what a
    // transient failure actually looks like and the only way to exercise the
    // crew branch without also losing the trip.
    let memberReads = 0;
    const sc = stubClient((table) => {
      if (table === "trip_members") {
        memberReads += 1;
        return memberReads === 1
          ? { data: [{ trip_id: TRIP, role: "owner" }], error: null }
          : { data: null, error: { message: "boom" } };
      }
      if (table === "trips") return { data: [TRIP_ROW], error: null };
      // Plan items and the session spine fail too.
      return { data: null, error: { message: "boom" } };
    });
    const ctx = await buildTripWorldContext(sc, USER, { now: NOW, kernel: KERNEL });
    for (const part of ["disruptions", "sessions", "crew"] as const) {
      assert.ok(ctx.unavailable.includes(part), `${part} not marked unavailable`);
    }
    // And no part invents content it did not read.
    assert.deepEqual(ctx.disruptions, []);
    assert.deepEqual(ctx.sessions, []);
    assert.deepEqual(ctx.crew, []);
  });

  it("no kernel is 'could not read the world', not 'the world is empty'", async () => {
    const sc = stubClient(() => ({ data: null, error: { message: "boom" } }));
    const ctx = await buildTripWorldContext(sc, USER, { now: NOW, kernel: null });
    assert.ok(ctx.unavailable.includes("world_state"));
  });

  it("an unrun opportunity engine stays `undefined`, distinct from 'promoted nothing'", async () => {
    const sc = stubClient((table) => {
      if (table === "trip_members") return { data: [], error: null };
      if (table === "trips") return { data: [TRIP_ROW], error: null };
      if (table === "trip_plan_items") return { data: [], error: null };
      if (table === "canonical_events") return { data: [], error: null };
      return { data: null, error: { message: "unavailable" } };
    });
    const notRun = await buildTripWorldContext(sc, USER, { now: NOW, kernel: KERNEL });
    assert.equal(notRun.opportunities, undefined);

    const ranAndPromotedNothing = await buildTripWorldContext(sc, USER, { now: NOW, kernel: KERNEL, opportunities: [] });
    assert.deepEqual(ranAndPromotedNothing.opportunities, []);
  });
});

describe("S83 — the rendered block says which sentence is true", () => {
  const base: TripWorldContext = {
    tripId: TRIP, tripTitle: "Lisbon week", city: "Lisbon",
    worldState: [{ subjectId: PLACE, density: "busy", forecast: null, truthClass: "observed", readable: true }],
    opportunities: [], disruptions: [], sessions: [], crew: [], unavailable: [],
  };

  it("every part gets a line even when it is empty", () => {
    const lines = formatTripWorldContextLines(base);
    assert.equal(lines[0], TRIP_WORLD_CONTEXT_HEADER);
    const blob = lines.join("\n");
    assert.match(blob, /World .*crowd busy/);
    assert.match(blob, /Opportunities: none promoted/);
    assert.match(blob, /Disruptions: none reported/);
    assert.match(blob, /Experience sessions: none open/);
    assert.match(blob, /Crew: travelling solo/);
  });

  it("'could not check' never renders as 'the day is clear'", () => {
    const blob = formatTripWorldContextLines({
      ...base,
      unavailable: ["disruptions", "sessions", "crew", "world_state"],
    }).join("\n");
    assert.match(blob, /Disruptions: could not be checked — do not say the day is clear/);
    assert.equal(blob.includes("Disruptions: none reported"), false);
    assert.match(blob, /Experience sessions: could not be read/);
    assert.match(blob, /Crew: could not be read/);
    assert.match(blob, /World state: could not be read/);
  });

  it("an unrun opportunity engine reads differently from an empty one", () => {
    assert.match(
      formatTripWorldContextLines({ ...base, opportunities: undefined }).join("\n"),
      /Opportunities: not evaluated this turn/,
    );
  });

  it("an empty projection renders nothing at all", () => {
    assert.deepEqual(
      formatTripWorldContextLines({
        tripId: null, tripTitle: null, city: null, worldState: [],
        opportunities: undefined, disruptions: [], sessions: [], crew: [], unavailable: [],
      }),
      [],
    );
  });

  it("no coordinate is ever selected for this block", () => {
    const rendered = formatTripWorldContextLines({
      ...base,
      disruptions: [{
        subjectId: PLACE, planTitle: "Fado at Tasca", claimType: "closure.state",
        value: "closed", truthClass: "observed", confidence: "live", band: "live",
      }],
    }).join("\n");
    assert.match(rendered, /Disruption affecting Fado at Tasca: closure\.state="closed"/);
    for (const leak of ["lat", "lng", "latitude", "longitude"]) {
      assert.ok(!rendered.includes(leak), `rendered block leaked ${leak}`);
    }
  });
});
