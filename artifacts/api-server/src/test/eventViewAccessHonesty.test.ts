import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canViewEvent } from "../routes/events.js";
import { shareableFor } from "../services/telegraph/shareables.js";
import { readEventViewAccess } from "../lib/eventViewAccess.js";

const viewerId = "aaaaaaaa-0000-4000-8000-000000000001";
const hostId = "bbbbbbbb-0000-4000-8000-000000000002";
const eventId = "cccccccc-0000-4000-8000-000000000003";
const event = { id: eventId, host_id: hostId, state: "open", visibility: "circle", circle_id: hostId, trip_id: eventId, title: "Private itinerary" };
type Row = Record<string, unknown>;

function clientFor(visibility: string, failedTable?: string, failure = "error", grants: Record<string, Row> = {}) {
  const rows: Record<string, Row | null> = {
    events: { ...event, visibility },
    event_attendees: { user_id: viewerId },
    event_roles: null,
    circle_memberships: { other_id: viewerId },
    trip_members: { role: "member", status: "accepted" },
    user_friendships: { user_a: viewerId },
    event_rsvps: { status: "going" },
    ...grants,
  };
  return {
    from(table: string) {
      const result = (single: boolean) => {
        if (table === failedTable) {
          if (failure === "throw") throw new Error("Synthetic unavailable read");
          if (failure === "missing") return undefined;
          if (failure === "malformed") return { data: [], error: null };
          return { data: failure === "stale" ? rows[table] : null, error: { message: "Synthetic unavailable read" } };
        }
        return { data: single ? rows[table] ?? null : [], error: null };
      };
      const query: any = {
        select() { return query; }, eq() { return query; }, or() { return query; }, in() { return query; }, is() { return query; }, limit() { return query; },
        maybeSingle: async () => result(true),
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(() => result(false)).then(resolve, reject);
        },
      };
      return query;
    },
  } as any;
}

describe("event authorization distinguishes unreadable evidence from denial", () => {
  for (const [visibility, table] of [["public", "event_roles"], ["friends_only", "user_friendships"], ["circle", "circle_memberships"], ["trip", "trip_members"], ["invite_only", "event_rsvps"]]) {
    for (const failure of ["error", "stale", "throw", "missing", "malformed"]) {
      it(`${visibility}: ${failure} ${table} read withholds access without claiming a known denial`, async () => {
        const client = clientFor(visibility, table, failure);
        assert.equal(await canViewEvent(client, { ...event, visibility }, viewerId), false);
        const state = await shareableFor(client, "EVENT", eventId)!.getCurrentState(viewerId);
        assert.equal(state.available, false);
        assert.equal(state.reason, "unknown");
      });
    }
  }

  for (const visibility of ["public", "friends_only", "circle", "trip", "invite_only"]) {
    it(`preserves valid ${visibility} access`, async () => {
      assert.equal(await canViewEvent(clientFor(visibility), { ...event, visibility }, viewerId), true);
    });
  }

  for (const status of [undefined, null, 0, {}, [], ""]) {
    it(`classifies malformed trip status ${JSON.stringify(status)} as unavailable`, async () => {
      const client = clientFor("trip", undefined, undefined, { trip_members: { role: "member", status } });
      assert.equal(await readEventViewAccess(client, { ...event, visibility: "trip" }, viewerId), "unavailable");
      assert.equal((await shareableFor(client, "EVENT", eventId)!.getCurrentState(viewerId)).reason, "unknown");
    });
  }

  for (const status of ["invited", "declined", "removed", "left"]) {
    it(`keeps ${status} trip membership as a known denial`, async () => {
      const client = clientFor("trip", undefined, undefined, { trip_members: { role: "member", status } });
      assert.equal(await readEventViewAccess(client, { ...event, visibility: "trip" }, viewerId), "denied");
      assert.equal((await shareableFor(client, "EVENT", eventId)!.getCurrentState(viewerId)).reason, "private");
    });
  }

  for (const state of ["draft", "cancelled", "archived"]) {
    it(`does not reopen ${state} events to non-host attendees`, async () => {
      assert.equal(await canViewEvent(clientFor("public"), { ...event, state, visibility: "public" }, viewerId), false);
    });
  }

  it("retains host access without requiring another authorization read", async () => {
    const client = { from() { throw new Error("Should not read"); } };
    assert.equal(await canViewEvent(client, event, hostId), true);
  });

  it("keeps genuine absent circle membership as private rather than unknown", async () => {
    const client = clientFor("circle", undefined, undefined, { circle_memberships: null as unknown as Row });
    assert.equal(await canViewEvent(client, event, viewerId), false);
    assert.equal((await shareableFor(client, "EVENT", eventId)!.getCurrentState(viewerId)).reason, "private");
  });
});
