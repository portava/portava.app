/**
 * census-passport P61 — the Place stamp, under lead ruling D-84
 * (docs/ops/lead-rulings-20261007-media.md):
 *
 *   A. what earns one: a verified check-in at a canonical place, behind
 *      `passport_place_stamps_enabled` (3800, seeded FALSE) — written with
 *      place_id, verification 'checkin', its source (why) and award time (when);
 *   B. one per person per place: a second check-in at the same place mints
 *      nothing; another place in the same city mints a second stamp;
 *   C. never inside a protected zone, and never on an unreadable policy,
 *      flag or visibility preference (fail closed: nothing written);
 *   D. createStamp refuses a Place stamp with no place;
 *   E. the hidden-gem verify-visit is the act that calls it, with the gem's
 *      canonical place; 3800 makes the dedup place-keyed.
 *
 * Run: node --import tsx/esm --test src/test/passportPlaceStamp.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { awardPlaceStampForCheckin, PASSPORT_PLACE_STAMPS_FLAG } from "../services/passport/PlaceStampService.js";
import { createStamp } from "../services/passport/PassportStampService.js";
import { clearProtectedZoneCache } from "../lib/protectedZoneStore.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const USER = "u0000000-0000-4000-8000-000000000001";
const CAFE = "place-cafe";
const BAR = "place-bar";
const AT = { lat: 16.0544, lng: 108.2497 };

type Row = Record<string, any>;
interface Opts { flag?: boolean; zones?: Row[] | "fail"; pref?: Row | null | "fail"; stamps?: Row[] }

function fakeDb(o: Opts = {}) {
  const tables: Record<string, Row[]> = {
    feature_flags: o.flag ? [{ flag: PASSPORT_PLACE_STAMPS_FLAG, enabled: true }] : [],
    protected_zones: o.zones === "fail" ? [] : (o.zones ?? []),
    passport_visibility_preferences: o.pref && o.pref !== "fail" ? [{ user_id: USER, ...o.pref }] : [],
    passport_stamps: o.stamps ?? [],
  };
  const inserts: Array<{ table: string; row: Row }> = [];
  const reads: string[] = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let insertRow: Row | null = null;
    const run = (single: boolean) => {
      if (insertRow) {
        const row = { id: `stamp-${tables.passport_stamps.length + 1}`, ...insertRow };
        inserts.push({ table, row });
        (tables[table] ??= []).push(row);
        return { data: single ? { id: row.id } : [row], error: null };
      }
      reads.push(table);
      if (table === "protected_zones" && o.zones === "fail") return { data: null, error: { message: "timeout" } };
      if (table === "passport_visibility_preferences" && o.pref === "fail") return { data: null, error: { message: "timeout" } };
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const b: any = {
      select() { return b; },
      insert(r: Row) { insertRow = r; return b; },
      update() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      in() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve(run(true)); },
      single() { return Promise.resolve(run(true)); },
      then(onF: any, onR: any) { return Promise.resolve(run(false)).then(onF, onR); },
    };
    return b;
  }
  return { client: { from, rpc: () => Promise.resolve({ data: null, error: null }) } as any, inserts, reads, tables };
}

const checkin = (placeId: string | null, extra: Partial<Parameters<typeof awardPlaceStampForCheckin>[1]> = {}) => ({
  userId: USER, placeId, ...AT, city: "Da Nang", country: "Vietnam", sourceType: "hidden_gem_visit" as const, ...extra,
});
const placeInserts = (db: ReturnType<typeof fakeDb>) => db.inserts.filter((i) => i.table === "passport_stamps" && i.row.stamp_type === "place");

beforeEach(() => clearProtectedZoneCache());

describe("A. a verified check-in at a canonical place earns a Place stamp", () => {
  it("written with the place, 'checkin', its source (why) and its award time (when); visibility is the traveller's own default", async () => {
    const db = fakeDb({ flag: true, pref: { default_stamp_visibility: "friends" } });
    assert.equal(await awardPlaceStampForCheckin(db.client, checkin(CAFE)), "awarded");
    const [ins] = placeInserts(db);
    assert.ok(ins, "one Place stamp written");
    assert.equal(ins!.row.place_id, CAFE);
    assert.equal(ins!.row.verification_level, "checkin");
    assert.equal(ins!.row.source_type, "hidden_gem_visit");
    assert.equal(ins!.row.visibility, "friends");
    assert.ok(Number.isFinite(Date.parse(ins!.row.awarded_at)));
    assert.equal(ins!.row.city, "Da Nang");
  });

  it("the flag OFF (the 3800 seed) writes nothing, and no place means no stamp", async () => {
    const off = fakeDb({ flag: false });
    assert.equal(await awardPlaceStampForCheckin(off.client, checkin(CAFE)), "flag_off");
    assert.equal(placeInserts(off).length, 0);
    const none = fakeDb({ flag: true });
    assert.equal(await awardPlaceStampForCheckin(none.client, checkin(null)), "no_place");
    assert.deepEqual(none.reads, [], "nothing is even read for a check-in with no canonical place");
    assert.equal(await awardPlaceStampForCheckin(null, checkin(CAFE)), "flag_off");
  });
});

describe("B. one Place stamp per person per place", () => {
  it("a second check-in at the same place mints nothing; another place in the same city mints a second", async () => {
    const db = fakeDb({ flag: true });
    assert.equal(await awardPlaceStampForCheckin(db.client, checkin(CAFE)), "awarded");
    assert.equal(await awardPlaceStampForCheckin(db.client, checkin(CAFE)), "already_held");
    assert.equal(await awardPlaceStampForCheckin(db.client, checkin(CAFE, { city: null, country: null })), "already_held", "the place alone keys it: a check-in that carries no city is the same place");
    assert.equal(await awardPlaceStampForCheckin(db.client, checkin(BAR)), "awarded", "a city/country key would have collapsed these two");
    assert.deepEqual(placeInserts(db).map((i) => i.row.place_id), [CAFE, BAR]);
  });
});

describe("C. protected zones and unreadable inputs write nothing", () => {
  it("a check-in inside an active protected zone earns nothing", async () => {
    const zone = { id: "z1", category: "medical_facility", action: null, privacy_floor: null, shape: "circle", center_lat: AT.lat, center_lng: AT.lng, radius_meters: 200, ring: null, jurisdiction: null, policy_ref: null, active: true };
    const db = fakeDb({ flag: true, zones: [zone] });
    assert.equal(await awardPlaceStampForCheckin(db.client, checkin(CAFE)), "protected_zone");
    assert.equal(placeInserts(db).length, 0);
    clearProtectedZoneCache(); // the store caches a successful read for 30 s
    const far = fakeDb({ flag: true, zones: [{ ...zone, center_lat: AT.lat + 1 }] });
    assert.equal(await awardPlaceStampForCheckin(far.client, checkin(CAFE)), "awarded", "a zone elsewhere does not block it");
  });

  it("an unreadable zone policy, or an unreadable visibility preference, writes nothing", async () => {
    const zones = fakeDb({ flag: true, zones: "fail" });
    assert.equal(await awardPlaceStampForCheckin(zones.client, checkin(CAFE)), "zone_policy_unreadable");
    assert.equal(placeInserts(zones).length, 0);
    clearProtectedZoneCache();
    const pref = fakeDb({ flag: true, pref: "fail" });
    assert.equal(await awardPlaceStampForCheckin(pref.client, checkin(CAFE)), "visibility_unreadable");
    assert.equal(placeInserts(pref).length, 0, "createStamp would have fallen back to public; a Place stamp is not written instead");
  });
});

describe("D. createStamp refuses a Place stamp with no place", () => {
  it("returns null and writes nothing", async () => {
    const db = fakeDb({ flag: true });
    assert.equal(await createStamp(db.client, { userId: USER, stampType: "place", city: "Da Nang", visibility: "public" }), null);
    assert.equal(db.inserts.length, 0);
  });
});

describe("E. the act that earns it, and the uniqueness rule under it", () => {
  it("the hidden-gem verify-visit (GPS-verified, not suspicious) passes the gem's canonical place", () => {
    const route = readFileSync(join(SRC, "routes", "hiddenGems.ts"), "utf8");
    assert.match(route, /void awardPlaceStampForCheckin\(sc, \{ userId: user\.id, placeId: \(gem as any\)\.canonical_place_id \?\? null, lat: latitude, lng: longitude,/);
    const verify = route.slice(route.indexOf('router.post("/hidden-gems/:id/verify-visit"'));
    const guard = verify.indexOf("if (result.ok && !result.isSuspicious) {");
    assert.ok(guard > 0 && verify.indexOf("awardPlaceStampForCheckin(sc,") > guard, "only after a verified, non-suspicious visit");
  });

  it("3800 makes the dedup place-keyed: the city index excludes 'place', a (user_id, place_id) index covers it", () => {
    const sql = readFileSync(join(SRC, "migrations", "3800_passport_place_stamps.sql"), "utf8");
    // Verifier N5: the city index is rebuilt with the column list it HAD (plain
    // or COALESCE, both read by exact pg_get_indexdef), plus the predicate.
    assert.match(sql, /EXECUTE 'CREATE UNIQUE INDEX passport_stamps_dedup_idx ON public\.passport_stamps USING btree '\s+\|\| cols \|\| ' WHERE \(stamp_type <> ''place''::text\)';/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS passport_stamps_place_dedup_idx\s+ON public\.passport_stamps USING btree \(user_id, place_id\)\s+WHERE \(stamp_type = 'place'::text\);/);
    assert.match(sql, /CHECK \(stamp_type <> 'place'::text OR place_id IS NOT NULL\)/);
  });
});

describe("F. verifier N5 — 3800 never changes how a NULL-city stamp deduplicates", () => {
  const sql = readFileSync(join(SRC, "migrations", "3800_passport_place_stamps.sql"), "utf8");
  const rollback = readFileSync(join(SRC, "..", "..", "..", "db", "rollback", "2026-10-07-3800-passport-place-stamps-rollback.sql"), "utf8");
  const PLAIN = "CREATE UNIQUE INDEX passport_stamps_dedup_idx ON public.passport_stamps USING btree (user_id, stamp_type, country, city)";
  const COAL = "CREATE UNIQUE INDEX passport_stamps_dedup_idx ON public.passport_stamps USING btree (user_id, stamp_type, COALESCE(country, ''''::text), COALESCE(city, ''''::text))";
  const PRED = " WHERE (stamp_type <> ''place''::text)";
  const pre = sql.slice(sql.indexOf("DO $pre$"), sql.indexOf("END $pre$"));
  const post = sql.slice(sql.indexOf("DO $post$"));
  const rebuild = sql.slice(sql.indexOf("DO $rebuild$"), sql.indexOf("END $rebuild$"));

  it("the precondition accepts exactly the plain and COALESCE forms (and their partial replays), and refuses anything else", () => {
    for (const form of [PLAIN, PLAIN + PRED, COAL, COAL + PRED]) assert.ok(pre.includes(`'${form}'`), form);
    assert.match(pre, /IF def NOT IN \(/);
    assert.match(pre, /RAISE EXCEPTION 'PRECONDITION FAILED \(3800\): passport_stamps_dedup_idx is "%", which is neither/);
  });

  it("the rebuild carries the column list over: COALESCE stays COALESCE, plain stays plain", () => {
    assert.match(rebuild, /IF position\('COALESCE\(country' IN def\) > 0 THEN\s+cols := '\(user_id, stamp_type, COALESCE\(country, ''''::text\), COALESCE\(city, ''''::text\)\)';\s+ELSE\s+cols := '\(user_id, stamp_type, country, city\)';/);
    assert.ok(!/^\s*CREATE UNIQUE INDEX passport_stamps_dedup_idx/m.test(sql), "no hard-coded rebuild statement remains: the only CREATE is the EXECUTE that carries the columns");
  });

  it("the postcondition and the rollback know the same two partial forms", () => {
    for (const form of [PLAIN + PRED, COAL + PRED]) {
      assert.ok(post.includes(`'${form}'`), `postcondition: ${form}`);
      assert.ok(rollback.includes(`'${form}'`), `rollback: ${form}`);
    }
    assert.match(rollback, /RAISE EXCEPTION 'ROLLBACK REFUSED \(3800\): passport_stamps_dedup_idx is "%", not a form 3800 writes/);
  });
});

import { guardStamp, type StampRow } from "../services/passport/PassportPrivacyGuard.js";

describe("G. verifier N1 — guardStamp keeps a Place stamp's venue from everyone but the owner", () => {
  const PLACE = "11111111-2222-4333-8444-555555555555";
  const stamp = (o: Partial<StampRow> = {}): StampRow =>
    ({
      id: "s-1", user_id: "owner-1", stamp_type: "place", country: "VN", city: "Da Nang", neighborhood: "An Thuong",
      place_id: PLACE, source_type: "checkin", verification_level: "verified", visibility: "public",
      earned_at: "2026-10-07T00:00:00.000Z", created_at: "2026-10-07T00:00:00.000Z", ...o,
    }) as StampRow;

  it("the owner keeps place_id", () => {
    assert.equal(guardStamp(stamp(), "owner")?.place_id, PLACE);
  });

  for (const ctx of ["public", "circle", "trip_crew"] as const) {
    it(`a ${ctx} caller gets the stamp, without its place_id`, () => {
      const out = guardStamp(stamp(), ctx);
      assert.ok(out, "a public Place stamp is still shown");
      assert.equal(out!.place_id, null);
      assert.equal(out!.city, "Da Nang", "only the venue is withheld");
    });
  }

  it("a circle-only Place stamp, seen by its circle, still has no place_id", () => {
    assert.equal(guardStamp(stamp({ visibility: "circle_only" }), "circle")?.place_id, null);
  });

  it("the hotel blur still applies to a Place stamp (the new rule does not short-circuit it)", () => {
    const out = guardStamp(stamp({ source_type: "hotel" }), "circle", { hotelBlurEnabled: true });
    assert.equal(out?.place_id, null);
    assert.equal(out?.neighborhood, null);
  });

  it("other stamp types are unchanged: a destination stamp keeps place_id for a circle caller", () => {
    assert.equal(guardStamp(stamp({ stamp_type: "destination" }), "circle")?.place_id, PLACE);
  });
});

