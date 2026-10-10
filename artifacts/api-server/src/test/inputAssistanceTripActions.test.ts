/**
 * §21 Trip smart actions (census-input-intelligence G135): add stop, reorder
 * plan, add destination, invite Crew — PROPOSE-ONLY rows in the search field.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceTripActions.test.ts
 *
 * Through the REAL gateway (only the database's wire is faked). Behind
 * `input_trip_actions_enabled` (3692, seeded FALSE). Each case names the
 * mutation that turns it red.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import { parseTripAction, INPUT_TRIP_ACTIONS_FLAG } from "../lib/inputAssistance/tripActions.js";
import { searchKey, normalizeLocationName } from "../lib/canonicalLocations.js";

const ME   = "aa000000-0000-4000-a000-000000000001";
const BOB  = "bb000000-0000-4000-a000-000000000002";
const CARL = "cc000000-0000-4000-a000-000000000003";

interface FakeState { [key: string]: any[] | undefined }

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  const errorFns = ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"];
  for (const fn of errorFns) errorBuilder[fn] = () => errorBuilder;
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);

  return {
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;

      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      let profileCols: string[] | null = null;
      function project(rowsIn: any[]): any[] {
        if (table !== "profiles" || !profileCols) return rowsIn;
        return rowsIn.map((r) => Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])));
      }

      const builder: any = {
        select(cols?: string) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
          return builder;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[col] ?? "")));
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/);
            if (!m) return null;
            return { col: m[1]!, op: m[2]!.toLowerCase(), val: m[3]! };
          }).filter(Boolean) as { col: string; op: string; val: string }[];
          filters.push((r) =>
            parts.some(({ col, op, val }) => {
              const cellStr = String(r[col] ?? "");
              if (op === "ilike") {
                const re = new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
                return re.test(cellStr);
              }
              if (op === "eq") return cellStr === val;
              return false;
            }),
          );
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = project(sourceRows.filter((r) => filters.every((f) => f(r))));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = project(sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined));
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

function profile(id: string, handle: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, handle, username: handle, name, avatar_url: null, is_private: false,
    home_city: null, home_country: null, account_status: "active",
    verified: false, is_official: false, show_profile_picture_publicly: true, ...extra,
  };
}


const HUE = {
  id: "canon-hue", kind: "city", name: "Hue", normalized_name: normalizeLocationName("Hue"), search_key: searchKey("Hue"),
  display_name: "Hue, Vietnam", city: null, region: null, country: "Vietnam", country_code: "VN",
  postal_code: null, lat: 16.46, lng: 107.59, provider_ids: {}, aliases: [],
};
const state = (over: FakeState = {}): FakeState => ({
  feature_flags: [{ flag: INPUT_TRIP_ACTIONS_FLAG, enabled: true }],
  profiles: [profile(ME, "me_me", "Me"), profile(BOB, "bobtraveler", "Bob"), profile(CARL, "carlhiker", "Carl")],
  profile_privacy_settings: [
    { user_id: BOB, show_real_name: true, allow_profile_discovery: true },
    { user_id: CARL, show_real_name: true, allow_profile_discovery: true },
  ],
  blocks: [{ blocker_id: CARL, blocked_id: ME }], user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
  canonical_locations: [HUE], trip_members: [], trips: [], input_selection_history: [],
  ...over,
});

async function serve(sc: any, text: string) {
  const policy = resolvePolicy("global_search")!;
  return generateSuggestions(sc, { context: "global_search", policy, text, userId: ME, limit: policy.maxSuggestions, lat: null, lng: null, city: null });
}
const tripRows = (out: any[]) => out.filter((s) => s.action?.type === "trip_action" || (s.action?.type === "add_to_trip" && String(s.id).endsWith(":stop")));

describe("G135 — parseTripAction (whole-text commands only)", () => {
  it("recognises the four phrasings and nothing that merely contains the words", () => {
    assert.deepEqual(parseTripAction("invite @Bob_Traveler to my trip"), { kind: "invite_crew", handle: "bob_traveler" });
    assert.deepEqual(parseTripAction("reorder my trip"), { kind: "reorder_plan" });
    assert.deepEqual(parseTripAction("rearrange our stops"), { kind: "reorder_plan" });
    assert.deepEqual(parseTripAction("add a stop in Hue"), { kind: "add_stop", destinationText: "Hue" });
    assert.deepEqual(parseTripAction("add Hue as a stop on my trip"), { kind: "add_stop", destinationText: "Hue" });
    // MUTATION: drop the ^…$ anchors → a search that contains the words becomes a command → RED.
    assert.equal(parseTripAction("how to invite bob to my trip safely"), null);
    assert.equal(parseTripAction("best way to reorder my trip photos"), null);
    assert.equal(parseTripAction("invite to my trip"), null);
    assert.equal(parseTripAction("why did you invite bob to my trip"), null);
    assert.equal(parseTripAction("how do i reorder my trip"), null);
  });
});

describe("G135 — served in global_search, propose-only", () => {
  it("invite_crew: an EXACT handle the people gate admits → a trip_action row carrying the user, and no Trip", async () => {
    // MUTATION: drop the buildTripActionRows call from gateway.ts → RED.
    const out = tripRows(await serve(makeFakeClient(state()), "invite @bobtraveler to my trip"));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].action, { type: "trip_action", action: "invite_crew", entityType: "user", entityId: BOB });
    assert.ok(!("tripId" in out[0].action), "the row never names a Trip — the person picks their own");
  });

  it("invite_crew: a person who BLOCKED the viewer is never proposed; a fuzzy match is never proposed", async () => {
    // MUTATION: use the mention row without the exact-handle check → "bob" proposes bobtraveler → RED.
    assert.equal(tripRows(await serve(makeFakeClient(state()), "invite @carlhiker to my trip")).length, 0);
    assert.equal(tripRows(await serve(makeFakeClient(state()), "invite @bob to my trip")).length, 0);
  });

  it("invite_crew: an unreadable block list proposes no one (fail-closed)", async () => {
    assert.equal(tripRows(await serve(makeFakeClient(state(), new Set(["blocks"])), "invite @bobtraveler to my trip")).length, 0);
  });

  it("reorder_plan: a trip_action row with nothing in it but the action", async () => {
    const out = tripRows(await serve(makeFakeClient(state()), "reorder my trip"));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].action, { type: "trip_action", action: "reorder_plan" });
  });

  it("add stop: the city resolves canonically and rides the existing add_to_trip action", async () => {
    const out = tripRows(await serve(makeFakeClient(state()), "add a stop in Hue"));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].action, { type: "add_to_trip", entityId: "canon-hue" });
  });

  it("add stop: a place the registry cannot resolve proposes NOTHING (never a guessed destination)", async () => {
    const out = await serve(makeFakeClient(state()), "add a stop in Atlantis");
    assert.equal(out.filter((s: any) => s.action?.type === "add_to_trip").length, 0);
  });

  it("FLAG OFF or absent (the seed): no Trip action row", async () => {
    // MUTATION: drop the isFlagEnabled gate → RED.
    for (const flags of [[], [{ flag: INPUT_TRIP_ACTIONS_FLAG, enabled: false }]]) {
      for (const text of ["invite @bobtraveler to my trip", "reorder my trip", "add a stop in Hue"]) {
        assert.equal(tripRows(await serve(makeFakeClient(state({ feature_flags: flags })), text)).length, 0, text);
      }
    }
  });
});
