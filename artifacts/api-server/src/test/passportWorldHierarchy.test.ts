/**
 * Passport §26 My World — the three levels the hierarchy stopped short of
 * (census-passport P126).
 *
 * §26 names SIX levels: `WORLD → Country → City → Trip → Places → Memories /
 * Stamps`. The payload modelled three — it aggregated `passport_stamps` by city
 * and stopped — so Trip, Places and Memories had nowhere to come from. These
 * cases pin the three new ones, and pin the two things that must NOT change
 * while they arrive:
 *
 *   THE PRIVACY ANSWER IS NOT RE-DECIDED HERE. The deeper levels are built out
 *   of stamps that have already been through `filterStamps` and memories that
 *   have already been through `filterMemories`. A public viewer's `place_id`
 *   and `neighborhood` are nulled by the guard BEFORE a Place can be made out
 *   of them, so the Places level cannot become the way a sensitive stamp's
 *   location leaks — and the case below proves that by asking for it.
 *
 *   NOTHING IS DROPPED. A stamp with no `trip_id` still belongs to the city.
 *   It lands in an explicit untripped bucket rather than vanishing because the
 *   payload grew a level it does not have a value for.
 *
 * Run: node --import tsx/esm --test src/test/passportWorldHierarchy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMapPayload } from "../services/passport/PassportMapService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const T_VN = "trip-vn";
const T_VN2 = "trip-vn-2";
const T_VN3 = "trip-vn-3";

function db() {
  return makePassportDb({
    passport_stamps: [
      // Da Nang, trip 1 — two places, one of them twice.
      { id: "s1", user_id: OWNER, stamp_type: "city", country: "Vietnam", city: "Da Nang", neighborhood: "An Hai", place_id: "pl-1", plan_id: null, trip_id: T_VN, source_type: "trips", verification_level: "gps", visibility: "public", awarded_at: "2025-03-05T00:00:00Z", created_at: "2025-03-05T00:00:00Z" },
      { id: "s2", user_id: OWNER, stamp_type: "city", country: "Vietnam", city: "Da Nang", neighborhood: "An Hai", place_id: "pl-1", plan_id: null, trip_id: T_VN, source_type: "trips", verification_level: "checkin", visibility: "public", awarded_at: "2025-03-06T00:00:00Z", created_at: "2025-03-06T00:00:00Z" },
      { id: "s3", user_id: OWNER, stamp_type: "city", country: "Vietnam", city: "Da Nang", neighborhood: "Son Tra", place_id: "pl-2", plan_id: null, trip_id: T_VN, source_type: "trips", verification_level: "gps", visibility: "public", awarded_at: "2025-03-07T00:00:00Z", created_at: "2025-03-07T00:00:00Z" },
      // Same city, a DIFFERENT trip — a city holds more than one journey.
      { id: "s4", user_id: OWNER, stamp_type: "city", country: "Vietnam", city: "Da Nang", neighborhood: null, place_id: null, plan_id: null, trip_id: T_VN2, source_type: "trips", verification_level: "gps", visibility: "public", awarded_at: "2026-01-04T00:00:00Z", created_at: "2026-01-04T00:00:00Z" },
      // Same city, NO trip at all — must not vanish.
      { id: "s5", user_id: OWNER, stamp_type: "city", country: "Vietnam", city: "Da Nang", neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "manual", verification_level: "unverified", visibility: "public", awarded_at: "2024-02-02T00:00:00Z", created_at: "2024-02-02T00:00:00Z" },
      // A DATELESS trip, staged AFTER the untripped stamp on purpose: with no
      // date to sort on it ties with the untripped bucket, so only the rule that
      // sinks "no Trip" below every real one can separate them.
      { id: "s6", user_id: OWNER, stamp_type: "city", country: "Vietnam", city: "Da Nang", neighborhood: "Hai Chau", place_id: null, plan_id: null, trip_id: T_VN3, source_type: "trips", verification_level: "gps", visibility: "public", awarded_at: "2023-05-05T00:00:00Z", created_at: "2023-05-05T00:00:00Z" },
    ],
    trips: [
      { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", start_date: "2025-03-01", end_date: "2025-03-30" },
      { id: T_VN2, owner_id: OWNER, title: "Second Look", start_date: "2026-01-02", end_date: "2026-01-09" },
      { id: T_VN3, owner_id: OWNER, title: "Undated Detour", start_date: null, end_date: null },
    ],
    places: [
      { id: "pl-1", name: "Rooftop Noodle Stall", city: "Da Nang", neighborhood: "An Hai", status: "active", merged_into_place_id: null },
      { id: "pl-2", name: "Monkey Mountain Lookout", city: "Da Nang", neighborhood: "Son Tra", status: "active", merged_into_place_id: null },
    ],
    passport_memories: [
      { id: "m1", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", neighborhood: "An Hai", place_id: "pl-1", trip_id: T_VN, category: "adventure", visibility: "public", earned_at: "2025-03-05T00:00:00Z", created_at: "2025-03-05T00:00:00Z" },
      { id: "m2", user_id: OWNER, status: "active", title: "Private note", city: "Da Nang", country: "Vietnam", neighborhood: "An Hai", place_id: "pl-1", trip_id: T_VN, category: "culture", visibility: "private", earned_at: "2025-03-06T00:00:00Z", created_at: "2025-03-06T00:00:00Z" },
      // A memory in a city with no stamp at all — My World is a STAMP map, so
      // it has no city to hang on and must not invent one.
      { id: "m3", user_id: OWNER, status: "active", title: "Layover snack", city: "Doha", country: "Qatar", neighborhood: null, place_id: null, trip_id: T_VN, category: "food", visibility: "public", earned_at: "2025-03-01T00:00:00Z", created_at: "2025-03-01T00:00:00Z" },
    ],
  });
}

function daNang(payload: Awaited<ReturnType<typeof buildMapPayload>>) {
  return payload.markers.find((m) => m.city === "Da Nang")!;
}

describe("§26 P126 — level 4: Trip", () => {
  it("L4a: a city's stamps are grouped into the Trips they were earned on", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const trips = daNang(p).trips;
    assert.ok(Array.isArray(trips), "marker carries no Trip level at all");
    const byId = new Map(trips.map((t) => [t.tripId, t]));
    assert.ok(byId.has(T_VN), "trip-vn missing");
    assert.ok(byId.has(T_VN2), "a second trip to the same city is its own journey");
    assert.equal(byId.get(T_VN)!.stampCount, 3);
    assert.equal(byId.get(T_VN2)!.stampCount, 1);
  });

  it("L4b: the Trip level carries the Trip's own title and dates, read from `trips`", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const t = daNang(p).trips.find((x) => x.tripId === T_VN)!;
    assert.equal(t.title, "30 Days in Vietnam");
    assert.equal(t.startDate, "2025-03-01");
    assert.equal(t.endDate, "2025-03-30");
  });

  it("L4c: a stamp with no trip_id keeps its city in an explicit untripped bucket", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const untripped = daNang(p).trips.find((x) => x.tripId === null);
    assert.ok(untripped, "an untripped stamp was silently dropped by the new level");
    assert.equal(untripped!.stampCount, 1);
    assert.equal(untripped!.title, null);
  });

  it("L4d: the city's own stampCount still equals the sum of its Trips", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const m = daNang(p);
    assert.equal(m.stampCount, 6);
    assert.equal(m.trips.reduce((n, t) => n + t.stampCount, 0), m.stampCount);
  });

  it("L4e: Trips are ordered newest first, with the untripped bucket last", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const ids = daNang(p).trips.map((t) => t.tripId);
    assert.deepEqual(ids, [T_VN2, T_VN, T_VN3, null], "an undated Trip still outranks 'no Trip at all'");
  });
});

describe("§26 P126 — level 5: Places", () => {
  it("L5a: named places inside a Trip are resolved from `places.name`", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const t = daNang(p).trips.find((x) => x.tripId === T_VN)!;
    const names = t.places.map((x) => x.name).sort();
    assert.deepEqual(names, ["Monkey Mountain Lookout", "Rooftop Noodle Stall"]);
  });

  it("L5b: a place counts each stamp and memory filed against it", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const t = daNang(p).trips.find((x) => x.tripId === T_VN)!;
    const pl1 = t.places.find((x) => x.placeId === "pl-1")!;
    assert.equal(pl1.stampCount, 2);
    assert.equal(pl1.memoryCount, 2, "owner sees both memories at that place");
    const pl2 = t.places.find((x) => x.placeId === "pl-2")!;
    assert.equal(pl2.stampCount, 1);
    assert.equal(pl2.memoryCount, 0);
  });

  it("L5c: a Trip whose stamps name no place has no Places, and still has its stamps", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const t = daNang(p).trips.find((x) => x.tripId === T_VN2)!;
    assert.deepEqual(t.places, []);
    assert.equal(t.stampCount, 1);
  });

  it("L5d: an unresolvable place_id still becomes a Place, labelled by its neighbourhood", async () => {
    const noPlaces = makePassportDb({
      passport_stamps: [
        { id: "s1", user_id: OWNER, stamp_type: "city", country: "Vietnam", city: "Da Nang", neighborhood: "An Hai", place_id: "pl-gone", plan_id: null, trip_id: T_VN, source_type: "trips", verification_level: "gps", visibility: "public", awarded_at: "2025-03-05T00:00:00Z", created_at: "2025-03-05T00:00:00Z" },
      ],
      trips: [{ id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", start_date: "2025-03-01", end_date: "2025-03-30" }],
      places: [],
      passport_memories: [],
    });
    const p = await buildMapPayload(noPlaces as any, OWNER, "owner");
    const t = daNang(p).trips.find((x) => x.tripId === T_VN)!;
    assert.equal(t.places.length, 1);
    assert.equal(t.places[0].name, "An Hai");
  });

  it("L5f: a stamp with NO place_id is still a Place when it names a neighbourhood", async () => {
    // The zone is the finest place Passport has for this stamp, and §26 asks for
    // a Places level, not a place-id level. `T_VN3`'s only stamp carries
    // `place_id: null, neighborhood: "Hai Chau"`.
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const t = daNang(p).trips.find((x) => x.tripId === T_VN3)!;
    assert.equal(t.places.length, 1, "a neighbourhood-only stamp got no Place");
    assert.equal(t.places[0].name, "Hai Chau");
    assert.equal(t.places[0].placeId, null);
    assert.equal(t.places[0].neighborhood, "Hai Chau");
    assert.equal(t.places[0].key, "n:Hai Chau");
  });

  it("L5e: PRIVACY — a public viewer whose guard nulled place_id/neighborhood gets NO Places", async () => {
    // `guardStamp` strips place_id and neighborhood from a public caller's view
    // of a sensitive stamp. The Places level is built from the POST-guard rows,
    // so there is nothing left to name — this is the case that proves the new
    // level cannot become a second route to the same field.
    const sensitive = makePassportDb({
      passport_stamps: [
        { id: "s1", user_id: OWNER, stamp_type: "safe_return", country: "Vietnam", city: "Da Nang", neighborhood: "An Hai", place_id: "pl-1", plan_id: null, trip_id: T_VN, source_type: "trips", verification_level: "safe_return", visibility: "public", awarded_at: "2025-03-05T00:00:00Z", created_at: "2025-03-05T00:00:00Z" },
      ],
      trips: [{ id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", start_date: "2025-03-01", end_date: "2025-03-30" }],
      places: [{ id: "pl-1", name: "Rooftop Noodle Stall", city: "Da Nang", neighborhood: "An Hai", status: "active", merged_into_place_id: null }],
      passport_memories: [],
    });
    const pub = await buildMapPayload(sensitive as any, OWNER, "public");
    const marker = pub.markers.find((m) => m.city === "Da Nang");
    if (marker) {
      const named = marker.trips.flatMap((t) => t.places).map((x) => x.name);
      assert.ok(!named.includes("Rooftop Noodle Stall"), "a sensitive stamp's place was named to a public viewer");
      assert.deepEqual(marker.trips.flatMap((t) => t.places), []);
    }
    // And the owner still sees it — the rule is the guard's, not a blanket off.
    const own = await buildMapPayload(sensitive as any, OWNER, "owner");
    assert.equal(daNang(own).trips[0].places[0].name, "Rooftop Noodle Stall");
  });
});

describe("§26 P126 — level 6: Memories", () => {
  it("L6a: memories are filed under the Trip they belong to", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    const t = daNang(p).trips.find((x) => x.tripId === T_VN)!;
    const ids = t.memories.map((m) => m.id).sort();
    assert.deepEqual(ids, ["m1", "m2"]);
    assert.equal(t.memories.find((m) => m.id === "m1")!.title, "Beach day");
  });

  it("L6b: PRIVACY — a non-owner gets only the memories their own visibility allows", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "public");
    const marker = daNang(p);
    const ids = marker.trips.flatMap((t) => t.memories).map((m) => m.id);
    assert.ok(ids.includes("m1"), "the public memory is still there");
    assert.ok(!ids.includes("m2"), "a private memory reached a public viewer through My World");
  });

  // L6c pins a STRUCTURAL invariant, not a predicate: `markers`, `countries` and
  // `cities` are derived from stamps before the deeper levels are attached and
  // are never added to afterwards. Deleting `bucketFor`'s stampless-city refusal
  // leaves this green (mutation W4, recorded as SURVIVING) because an orphan
  // bucket would simply never be read. The refusal stays as the cheap guard on
  // unbounded bucket growth; this case guards the payload contract.
  it("L6c: a memory in a city My World has no stamp for does not invent a city", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    assert.ok(!p.markers.some((m) => m.city === "Doha"), "My World is a stamp map");
    assert.ok(!p.cities.includes("Doha"));
  });

  it("L6d: an unreadable memories read costs the memories, not the hierarchy", async () => {
    const broken = makePassportDb(
      {
        passport_stamps: [
          { id: "s1", user_id: OWNER, stamp_type: "city", country: "Vietnam", city: "Da Nang", neighborhood: "An Hai", place_id: "pl-1", plan_id: null, trip_id: T_VN, source_type: "trips", verification_level: "gps", visibility: "public", awarded_at: "2025-03-05T00:00:00Z", created_at: "2025-03-05T00:00:00Z" },
        ],
        trips: [{ id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", start_date: "2025-03-01", end_date: "2025-03-30" }],
        places: [{ id: "pl-1", name: "Rooftop Noodle Stall", city: "Da Nang", neighborhood: "An Hai", status: "active", merged_into_place_id: null }],
        passport_memories: [],
      },
      { failReads: { passport_memories: { message: "boom" } } },
    );
    const p = await buildMapPayload(broken as any, OWNER, "owner");
    const t = daNang(p).trips[0];
    assert.equal(t.stampCount, 1);
    assert.equal(t.places.length, 1);
    assert.deepEqual(t.memories, []);
  });
});

describe("§26 P126 — all six levels, end to end", () => {
  it("L7: WORLD → Country → City → Trip → Places → Memories/Stamps is walkable", async () => {
    const p = await buildMapPayload(db() as any, OWNER, "owner");
    // 1 WORLD → 2 Country
    assert.ok(p.countries.includes("Vietnam"));
    const city = p.markers.find((m) => m.country === "Vietnam" && m.city === "Da Nang");
    assert.ok(city, "3 City");
    const trip = city!.trips.find((t) => t.tripId === T_VN);
    assert.ok(trip, "4 Trip");
    const place = trip!.places.find((x) => x.placeId === "pl-1");
    assert.ok(place, "5 Places");
    assert.ok(trip!.memories.some((m) => m.id === "m1"), "6 Memories");
    assert.ok(place!.stampCount > 0, "6 Stamps");
  });

  it("L8: a broken stamps read still returns the documented empty shape", async () => {
    const broken = makePassportDb({ passport_stamps: [] }, { failReads: { passport_stamps: { message: "boom" } } });
    assert.deepEqual(await buildMapPayload(broken as any, OWNER, "owner"), {
      markers: [],
      countries: [],
      cities: [],
    });
  });
});
