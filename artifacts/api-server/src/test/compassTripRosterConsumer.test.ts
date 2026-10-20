import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { executeCompassTool } from "../compass/CompassTools.js";

const VIEWER = "10000000-0000-4000-8000-000000000001";
const MEMBER = "10000000-0000-4000-8000-000000000002";
const HOST = "10000000-0000-4000-8000-000000000003";
const TRIP = "20000000-0000-4000-8000-000000000001";
const memberId = (index: number) => `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type Override = (url: URL) => Response | undefined;
interface GroupResult {
  candidates?: Row[];
  group?: { size: number; label: string; memberHandles?: string[] };
  info?: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function profile(id: string): Row {
  return { id, handle: id === VIEWER ? "viewer" : "member", interests: ["food"], spoken_languages: ["en"],
    budget_style: "budget", verified: true, date_of_birth: "1990-01-01" };
}

function fixture(): Store {
  return {
    trips: [{ id: TRIP, owner_id: VIEWER, title: "Cebu Trip", status: "active", version: 7,
      start_date: "2026-07-01", end_date: "2026-07-30" }],
    trip_members: [{ trip_id: TRIP, user_id: VIEWER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: MEMBER, role: "member", status: "accepted" }],
    profiles: [profile(VIEWER), profile(MEMBER)],
    discovery_places: [{ id: "place", name: "Cafe", category: "food", city: "Cebu", rating: 4,
      saved_count: 12, verified: true, lat: 10, lng: 123 }],
    events: [{ id: "open", title: "Market", host_id: HOST, state: "published", visibility: "public",
      starts_at: "2099-01-01T00:00:00Z", max_attendees: 200, going_count: 0, age_min: null, verified_only: false }],
  };
}

function matches(value: unknown, predicate: string): boolean {
  if (predicate.startsWith("not.")) return !matches(value, predicate.slice(4));
  if (predicate.startsWith("eq.")) return String(value) === predicate.slice(3);
  if (predicate.startsWith("neq.")) return String(value) !== predicate.slice(4);
  if (predicate.startsWith("in.(")) return predicate.slice(4, -1).split(",").map((part) => part.replaceAll('"', "")).includes(String(value));
  if (predicate === "is.null") return value == null;
  if (predicate.startsWith("gte.")) return String(value) >= predicate.slice(4);
  if (predicate.startsWith("lte.")) return String(value) <= predicate.slice(4);
  if (predicate.startsWith("ilike.")) return String(value).toLowerCase() === predicate.slice(6).replaceAll("%", "").toLowerCase();
  throw new Error(`Unsupported fixture predicate: ${predicate}`);
}

function clientFor(store: Store, override?: Override) {
  const requests: URL[] = [];
  const client = createClient("http://127.0.0.1:9", "dummy", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      assert.equal(init?.method ?? "GET", "GET");
      const url = new URL(String(input));
      requests.push(url);
      const replaced = override?.(url);
      if (replaced) return replaced;
      const table = url.pathname.split("/").at(-1)!;
      let rows = [...(store[table] ?? [])];
      for (const [column, predicate] of url.searchParams) {
        if (["select", "order", "limit", "offset"].includes(column)) continue;
        assert.notEqual(column, "or", "add an explicit OR fixture before accepting one");
        rows = rows.filter((row) => matches(row[column], predicate));
      }
      const limit = url.searchParams.get("limit");
      if (limit !== null) rows = rows.slice(0, Number(limit));
      return json(rows);
    } },
  });
  return { client, requests };
}

function isRoster(url: URL): boolean {
  return url.pathname.endsWith("/trip_members") && url.searchParams.get("select") === "user_id,role,status";
}

async function dispatch(store = fixture(), override?: Override, args: Row = {}) {
  const { client, requests } = clientFor(store, override);
  const result = await executeCompassTool(client, VIEWER, null, "get_group_recommendation", args) as GroupResult;
  return { result, requests };
}

describe("CT02 typed trip roster through actual Compass dispatch", () => {
  it("preserves group output and strips coordinates and birth dates", async () => {
    const { result, requests } = await dispatch();
    assert.equal(result.group?.size, 2);
    assert.match(result.group!.label, /Cebu Trip/);
    assert.equal(result.candidates?.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /"lat"|"lng"|date_of_birth|1990-01-01/);
    assert.equal(requests.filter(isRoster).length, 1);
    assert.equal(requests.filter((url) => url.pathname.endsWith("/trips") && url.searchParams.get("select") === "version").length, 1);
  });

  for (const [label, body] of [
    ["null", null], ["object", {}], ["string", "not rows"],
    ["missing member id", [{ role: "member", status: "accepted" }]],
    ["numeric member id", [{ user_id: 42, role: "member", status: "accepted" }]],
    ["missing status", [{ user_id: MEMBER, role: "member" }]],
    ["non-UUID member id", [{ user_id: "not-a-uuid", role: "member", status: "accepted" }]],
    ["padded member id", [{ user_id: ` ${MEMBER} `, role: "member", status: "accepted" }]],
  ] as const) {
    it(`refuses a ${label} roster instead of recommending for a smaller group`, async () => {
      const { result, requests } = await dispatch(fixture(), (url) => isRoster(url) ? json(body) : undefined);
      assert.deepEqual(result.candidates, []);
      assert.equal(result.group, undefined);
      assert.match(result.info!, /member list could not be read/);
      assert.equal(requests.some((url) => url.pathname.endsWith("/profiles") || url.pathname.endsWith("/discovery_places")), false);
    });
  }

  for (const failure of ["returned", "thrown"] as const) {
    it(`refuses a ${failure} roster failure`, async () => {
      const { result } = await dispatch(fixture(), (url) => {
        if (!isRoster(url)) return undefined;
        if (failure === "thrown") throw new Error("fixture transport unavailable");
        return json({ message: "fixture unavailable", code: "XX000" }, 400);
      });
      assert.deepEqual(result.candidates, []);
      assert.match(result.info!, /member list could not be read/);
    });
  }

  it("preserves every role, null status, self inclusion and deduplication without a presence cap", async () => {
    const store = fixture();
    store.trip_members = Array.from({ length: 60 }, (_, index) => ({ trip_id: TRIP, user_id: memberId(index),
      role: ["owner", "co_host", "member", "viewer"][index % 4], status: index % 2 ? null : "accepted" }));
    store.trip_members.push({ ...store.trip_members[0]! });
    for (const [index, status] of ["invited", "declined", "removed", "left"].entries()) {
      store.trip_members.push({ trip_id: TRIP, user_id: memberId(index + 60), role: "member", status });
    }
    store.profiles = [profile(VIEWER), ...store.trip_members.map((row) => profile(String(row.user_id)))];
    const { result, requests } = await dispatch(store);
    assert.equal(result.group?.size, 61);
    const roster = requests.find(isRoster)!;
    assert.equal(roster.searchParams.has("limit"), false);
    assert.equal(requests.some((url) => /presence|location/.test(url.pathname)), false);
  });

  it("a readable empty roster still includes the selected trip's caller", async () => {
    const store = fixture();
    store.trip_members = [];
    assert.equal((await dispatch(store)).result.group?.size, 1);
  });

  it("keeps active-first selection, excludes drafts, and ignores the model's unrelated trip id", async () => {
    const store = fixture();
    store.trips.unshift({ ...store.trips[0]!, id: "draft", title: "Draft", status: "draft" },
      { ...store.trips[0]!, id: "upcoming", title: "Upcoming", status: "upcoming", start_date: "2020-01-01" });
    const { result, requests } = await dispatch(store, undefined, { tripId: "foreign" });
    assert.match(result.group!.label, /Cebu Trip/);
    assert.equal(requests.find(isRoster)?.searchParams.get("trip_id"), `eq.${TRIP}`);
  });

  it("keeps a joined trip selected through the existing membership seam", async () => {
    const store = fixture();
    store.trips[0]!.owner_id = HOST;
    store.trip_members[0]!.role = "member";
    assert.equal((await dispatch(store)).result.group?.size, 2);
  });

  it("never reads a roster when selection is empty or unreadable", async () => {
    for (const unread of [false, true]) {
      const store = fixture();
      store.trips = [];
      store.trip_members = [];
      const { result, requests } = await dispatch(store, (url) => unread && url.pathname.endsWith("/trips") ? json(null) : undefined);
      assert.deepEqual(result.candidates, []);
      assert.equal(requests.some(isRoster), false);
      assert.match(result.info!, unread ? /could not be read/ : /no active or upcoming trip group/i);
    }
  });

  for (const relationship of ["blocked", "blocker", "muted"] as const) {
    it(`retains fresh ${relationship} member exclusions`, async () => {
      const store = fixture();
      if (relationship === "muted") store.user_mutes = [{ muter_id: VIEWER, muted_id: MEMBER }];
      else store.blocks = [{ blocker_id: relationship === "blocked" ? VIEWER : MEMBER,
        blocked_id: relationship === "blocked" ? MEMBER : VIEWER }];
      const { result } = await dispatch(store);
      assert.equal(result.group?.size, 1);
      assert.deepEqual(result.group?.memberHandles, ["@viewer"]);
    });
  }

  it("retains another member's host block and fails closed on an unreadable group block union", async () => {
    const store = fixture();
    store.blocks = [{ blocker_id: MEMBER, blocked_id: HOST }];
    assert.deepEqual((await dispatch(store, undefined, { kind: "events" })).result.candidates, []);
    const { result } = await dispatch(fixture(), (url) => url.pathname.endsWith("/blocks")
      && [...url.searchParams.values()].some((value) => value.startsWith("in."))
      ? json({ message: "unreadable" }, 400) : undefined);
    assert.deepEqual(result.candidates, []);
    assert.match(result.info!, /Group block state could not be read/);
  });

  for (const age of ["adult", "missing", "verified_minor"] as const) {
    it(`retains ${age} age handling for the entire roster`, async () => {
      const store = fixture();
      store.events[0]!.age_min = 18;
      if (age === "missing") store.profiles = [profile(VIEWER)];
      if (age === "verified_minor") store.identity_verifications = [{ user_id: MEMBER, is_over_18: false, created_at: "2026-01-01" }];
      const { result } = await dispatch(store, undefined, { kind: "events" });
      assert.equal(result.group?.size, 2);
      assert.equal(result.candidates?.length, age === "adult" ? 1 : 0);
    });
  }

  for (const status of ["unexpected", " accepted ", ""]) {
    it(`refuses malformed status ${JSON.stringify(status)} instead of silently omitting a verified minor`, async () => {
      const store = fixture();
      store.events[0]!.age_min = 18;
      store.identity_verifications = [{ user_id: MEMBER, is_over_18: false, created_at: "2026-01-01" }];
      const control = await dispatch(store, undefined, { kind: "events" });
      assert.equal(control.result.group?.size, 2);
      assert.deepEqual(control.result.candidates, []);
      const { result, requests } = await dispatch(store, (url) => isRoster(url)
        ? json(store.trip_members.map((row) => row.user_id === MEMBER ? { ...row, status } : row)) : undefined,
      { kind: "events" });
      assert.deepEqual(result.candidates, []);
      assert.equal(result.group, undefined);
      assert.match(result.info!, /member list could not be read/);
      assert.doesNotMatch(result.info!, /every member/);
      assert.equal(requests.some((url) => url.pathname.endsWith("/profiles") || url.pathname.endsWith("/events")), false);
    });
  }

  it("leaves the explicit-circle branch independent of the trip roster", async () => {
    const store = fixture();
    store.circles = [{ id: "circle", owner_id: VIEWER, name: "Circle" }];
    store.circle_memberships = [{ user_id: VIEWER, other_id: MEMBER, status: "accepted" }];
    const { result, requests } = await dispatch(store, undefined, { circleName: "Circle" });
    assert.equal(result.group?.size, 2);
    assert.match(result.group!.label, /Circle/);
    assert.equal(requests.some(isRoster), false);
  });
});
