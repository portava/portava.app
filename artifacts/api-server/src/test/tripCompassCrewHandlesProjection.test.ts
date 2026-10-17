import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it, mock } from "node:test";
import { buildTripCompassCrewHandlesProjection, COMPASS_CREW_HANDLES_READ_LIMIT } from "../domain/trips/projections/TripCompassCrewHandlesProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";
import { clientFor, fixture, json, VIEWER, OTHER, TRIP, FOREIGN_TRIP, NOW,
  type Override, type Row } from "./helpers/tripCompassDayCountFixture.js";

const UNAVAILABLE = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" };

afterEach(() => mock.restoreAll());

function member(index: number, values: Row = {}): Row {
  return { trip_id: TRIP, user_id: index === 0 ? VIEWER : index === 1 ? OTHER : `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    role: index === 0 ? "owner" : "member",
    status: "accepted", profiles: { handle: `handle-${index}` }, ...values };
}

function setup(rows = [member(0), member(1)], override?: Override) {
  const store = fixture();
  store.trip_members = rows;
  return clientFor(store, (url) => {
    const replaced = override?.(url);
    if (replaced) return replaced;
    if (!url.pathname.endsWith("/trip_members")) return undefined;
    const selected = rows.filter((row) => `eq.${row.trip_id}` === url.searchParams.get("trip_id")
      && `eq.${row.status}` === url.searchParams.get("status")).slice(0, Number(url.searchParams.get("limit")));
    return json(selected.map((row) => ({ profiles: row.profiles == null ? row.profiles : { handle: (row.profiles as Row).handle },
      role: row.role, status: row.status })));
  });
}

describe("TripCompassCrewHandlesProjection bounded request contract", () => {
  it("reads version before the exact unordered eight-row join and exports only the scoped handle contract", async () => {
    const { client, requests } = setup();
    const result = await buildTripCompassCrewHandlesProjection(client, TRIP, VIEWER, { now: new Date(NOW) });
    assert.deepEqual(result, { ok: true, projection: {
      tripId: TRIP, viewerId: VIEWER, handles: ["handle-0", "handle-1"],
      handleBasis: "nonempty_profile_handles_in_capped_accepted_rows", readLimit: 8,
      generatedAt: new Date(NOW).toISOString(), sourceTripVersion: 7, projectionSchemaVersion: 1, freshness: "live",
    } });
    assert.equal(COMPASS_CREW_HANDLES_READ_LIMIT, 8);
    assert.deepEqual(requests.map(({ url, method }) => [url.pathname, method]), [["/rest/v1/trips", "GET"], ["/rest/v1/trip_members", "GET"]]);
    assert.deepEqual(Object.fromEntries(requests[0]!.url.searchParams), { select: "version", id: `eq.${TRIP}` });
    assert.deepEqual(Object.fromEntries(requests[1]!.url.searchParams), {
      select: "profiles(handle),role,status", trip_id: `eq.${TRIP}`, status: "eq.accepted", limit: "8",
    });
  });

  it("preserves trip/status predicates before the cap without adding role or viewer filters", async () => {
    const rows = [member(0, { trip_id: FOREIGN_TRIP }), ...[null, "invited", "declined", "removed", "left"].map((status, index) => member(index + 20, { status })),
      ...Array.from({ length: 9 }, (_, index) => member(index, { role: ["owner", "member", "co_host", "viewer"][index % 4] }))];
    const result = await buildTripCompassCrewHandlesProjection(setup(rows).client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.handles, Array.from({ length: 8 }, (_, index) => `handle-${index}`));
  });

  it("caps raw rows before empty joined profiles without refill or sorting", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => member(index, {
      profiles: index === 8 ? { handle: "NINTH-FORBIDDEN" } : index % 2 === 0 ? null : { handle: "" },
    }));
    const { client, requests } = setup(rows);
    const result = await buildTripCompassCrewHandlesProjection(client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.handles, []);
    assert.equal(requests.length, 2);
  });

  it("preserves duplicate handles, whitespace and existing at-prefixes without normalizing", async () => {
    const handles = ["z-last", "repeat", "repeat", "@already", " padded ", " ", "", 42];
    const result = await buildTripCompassCrewHandlesProjection(setup(handles.map((handle, index) => member(index, { profiles: { handle } }))).client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.handles, handles.slice(0, 6));
  });

  it("does not synthesize self or export member/profile extras from an overbroad transport payload", async () => {
    const { client } = setup([member(1)], (url) => url.pathname.endsWith("/trip_members") ? json([
      { ...member(1), profiles: { handle: "other", private_note: "FORBIDDEN", location: [1, 2] }, user_id: OTHER, last_seen: "FORBIDDEN" },
    ]) : undefined);
    const result = await buildTripCompassCrewHandlesProjection(client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.handles, ["other"]);
    assert.doesNotMatch(JSON.stringify(result), /FORBIDDEN|private_note|location|last_seen|user_id/);
    assert.equal(result.projection.viewerId, VIEWER);
  });

  for (const value of [[], null, [{}, { profiles: null }, { profiles: [] }, { profiles: { handle: false } }]]) {
    it(`preserves empty legacy handle filtering for ${JSON.stringify(value)}`, async () => {
      const { client } = setup(undefined, (url) => url.pathname.endsWith("/trip_members") ? json(value) : undefined);
      const result = await buildTripCompassCrewHandlesProjection(client, TRIP, VIEWER);
      assert.ok(result.ok);
      assert.deepEqual(result.projection.handles, []);
      assert.equal(result.projection.handleBasis, "nonempty_profile_handles_in_capped_accepted_rows");
    });
  }

  for (const value of [{ profiles: { handle: "not-an-array" } }, [null]]) {
    it(`preserves genuine shaping failure for ${JSON.stringify(value)} rather than inventing a roster`, async () => {
      const { client } = setup(undefined, (url) => url.pathname.endsWith("/trip_members") ? json(value) : undefined);
      await assert.rejects(buildTripCompassCrewHandlesProjection(client, TRIP, VIEWER), TypeError);
    });
  }

  it("returns unavailable for a returned crew error without exporting a successful prefix", async () => {
    const { client, requests } = setup(undefined, (url) => url.pathname.endsWith("/trip_members")
      ? json({ code: "XX000", message: "crew unread" }, 400) : undefined);
    assert.deepEqual(await buildTripCompassCrewHandlesProjection(client, TRIP, VIEWER), UNAVAILABLE);
    assert.equal(requests.length, 2);
  });

  it("lets genuine crew query construction throw to the existing consumer total fail-soft", async () => {
    const { client } = setup();
    const from = client.from.bind(client);
    mock.method(client, "from", (table: string) => {
      if (table === "trip_members") throw new Error("crew construction failed");
      return from(table);
    });
    await assert.rejects(buildTripCompassCrewHandlesProjection(client, TRIP, VIEWER), /crew construction failed/);
  });

  for (const failure of ["absent", "error", "throw", "nonnumeric"]) {
    it(`keeps a ${failure} version null/unattributable under the existing acceptance rule`, async () => {
      const { client, requests } = setup(undefined, (url) => {
        if (!url.pathname.endsWith("/trips")) return undefined;
        return failure === "error" ? json({ code: "XX000", message: "version unread" }, 400)
          : json(failure === "nonnumeric" ? { version: "7" } : null);
      });
      if (failure === "throw") {
        const from = client.from.bind(client);
        mock.method(client, "from", (table: string) => {
          if (table === "trips") throw new Error("version construction failed");
          return from(table);
        });
      }
      const result = await buildTripCompassCrewHandlesProjection(client, TRIP, VIEWER, { now: new Date(NOW) });
      assert.ok(result.ok);
      assert.equal(result.projection.sourceTripVersion, null);
      assert.equal(result.projection.freshness, "unattributable");
      assert.deepEqual(result.projection.handles, ["handle-0", "handle-1"]);
      assert.equal(acceptTripProjection(result.projection, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, now: NOW }).accepted, true);
      assert.equal(requests.filter(({ url }) => url.pathname.endsWith("/trip_members")).length, 1);
    });
  }

  it("does not depend on Compass, presence, policy, client flags or a second roster engine", () => {
    const source = readFileSync(new URL("../domain/trips/projections/TripCompassCrewHandlesProjection.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*compass\//i);
    assert.doesNotMatch(source, /getCrewMap|TripCompassRosterProjection|feature_flags|privateAnchor|\.order\(|\.range\(|\.rpc\(/);
  });
});
