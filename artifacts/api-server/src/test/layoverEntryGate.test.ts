/**
 * Layover entry gate — the border, not just the clock (census-layover L48).
 *
 * node:test + node:assert (NOT vitest). Pure functions and a fake table-backed
 * client; no server, no network.
 *
 * THE DEFECT. `adviseLeaving` answered "can I leave the airport?" from the
 * clock alone. It returned `verdict: "yes"` to a traveller with ninety spare
 * minutes while listing *"Visa or transit-permit requirements for your
 * nationality"* in `unknowns[]` — an affirmative and a disclaimer about the
 * same act, in the same response — and emitted `ENTRY_NOT_CONFIRMED` on every
 * session because nothing under `services/airport/` read `entry_requirements`
 * or `traveler_passports`, both present since migration 0169.
 *
 * WHAT IS PINNED HERE, in the four cases the work was asked to cover:
 *
 *   confirmed    a curated row says this corridor is open. The ONLY state that
 *                lets the clock's "yes" stand, and the only one that drops the
 *                standing visa unknown.
 *   unconfirmed  a curated row says entry needs something a layover cannot
 *                produce. Overrides the clock outright, at any amount of time.
 *   unknown      no row, no passport, no country, no flag — four different
 *                unknowns that stay four, because each is fixable by a
 *                different person.
 *   failed read  a read that ERRORED. supabase-js resolves `{ data, error }`,
 *                so an unreadable table arrives in almost the same shape as an
 *                uncurated corridor; these tests are what keeps them apart.
 *
 * And the direction property underneath all of it: the gate can only ever
 * WITHHOLD a yes. It never turns a "no" into a "tight", never a "tight" into a
 * "yes", and never invents caution on a branch that was not a confident yes.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverEntryGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveLayoverEntry,
  layoverAirportCountry,
  type EntryEligibility,
  type EntryUnresolvedReason,
} from "../services/airport/layoverEntryGate.js";
import { readCorridor } from "../lib/entryRequirements.js";
import {
  adviseLeaving,
  computeWindow,
  ENTRY_UNCONFIRMED_UNKNOWN,
  type LayoverWindow,
  type LeaveAdvice,
  type SafetyRating,
} from "../services/airport/LayoverSafetyEngine.js";
import {
  certifySessionFeasibility,
  feasibilityInputs,
  feasibilityInputHash,
} from "../services/airport/LayoverFeasibility.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

// ── a fake client that records what was asked ────────────────────────────────
//
// Behaviour per table: rows to return, an `error` to return alongside null
// data (what supabase-js does on a database error — it RESOLVES), or `throws`
// for the client blowing up before it can answer. The three are different
// failures and the gate has to survive all three.

interface Behaviour {
  rows?: any[];
  error?: { message: string } | null;
  throws?: boolean;
}
interface Call {
  table: string;
  filters: Array<[string, any]>;
  orders: Array<[string, boolean | undefined]>;
  limit: number | null;
}

function fakeClient(spec: Record<string, Behaviour>, log: Call[] = []) {
  return {
    log,
    from(table: string) {
      const b: Behaviour = spec[table] ?? { rows: [] };
      const call: Call = { table, filters: [], orders: [], limit: null };
      async function run(): Promise<{ data: any; error: any }> {
        log.push(call);
        if (b.throws) throw new Error(`${table} exploded`);
        if (b.error) return { data: null, error: b.error };
        return { data: b.rows ?? [], error: null };
      }
      const api: any = {
        select: () => api,
        eq: (col: string, val: any) => { call.filters.push([col, val]); return api; },
        order: (col: string, opts?: { ascending?: boolean }) => { call.orders.push([col, opts?.ascending]); return api; },
        limit: (n: number) => { call.limit = n; return api; },
        async maybeSingle() {
          const r = await run();
          if (r.error) return r;
          const rows = (r.data as any[]) ?? [];
          return { data: rows[0] ?? null, error: null };
        },
        then: (res: any, rej: any) => run().then(res, rej),
      };
      return api;
    },
  };
}

const FLAG_ON = { rows: [{ enabled: true }] };
const FLAG_OFF = { rows: [{ enabled: false }] };
const NZ_PASSPORT = { rows: [{ issuing_country: "NZ", is_primary: true, created_at: "2024-01-01T00:00:00Z" }] };
const USER = "user-1";

function corridor(status: string | null) {
  return { rows: [{ passport_country: "NZ", destination_country: "TW", status }] };
}

// ── resolveLayoverEntry: the four cases, one reason each ─────────────────────

describe("resolveLayoverEntry — which corridor, and whether we could read it", () => {
  it("CONFIRMED: a curated open corridor is permitted, and says which corridor", async () => {
    const sc = fakeClient({
      feature_flags: FLAG_ON,
      traveler_passports: NZ_PASSPORT,
      entry_requirements: corridor("visa_free"),
    });
    const e = await resolveLayoverEntry(sc, USER, "TW");
    assert.equal(e.state, "permitted");
    assert.deepEqual(
      e.state === "permitted" ? e.corridor : null,
      { passportCountry: "NZ", destinationCountry: "TW" },
    );
    assert.equal(e.state === "permitted" ? e.status : null, "visa_free");
  });

  it("CONFIRMED: all three permitting statuses permit, and nothing else does", async () => {
    for (const status of ["visa_free", "visa_on_arrival", "transit_visa_free"]) {
      const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: corridor(status) });
      assert.equal((await resolveLayoverEntry(sc, USER, "TW")).state, "permitted", status);
    }
  });

  it("UNCONFIRMED: a curated closed corridor is refused, and an UNSEEN status is refused too", async () => {
    // The allow-list is the point. A new vocabulary entry, a typo or a NULL is
    // not "probably fine": wrongly refusing costs an afternoon, wrongly
    // permitting costs a denied entry at a foreign border.
    for (const status of ["visa_required", "eta_required", "transit_visa_required", "banned", "esta_requried", "", null]) {
      const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: corridor(status) });
      assert.equal((await resolveLayoverEntry(sc, USER, "TW")).state, "refused", String(status));
    }
  });

  it("UNKNOWN: the flag being off is its own reason, not a refusal", async () => {
    const sc = fakeClient({ feature_flags: FLAG_OFF, traveler_passports: NZ_PASSPORT, entry_requirements: corridor("visa_free") });
    const e = await resolveLayoverEntry(sc, USER, "TW");
    assert.deepEqual(e, { state: "unresolved", reason: "entry_intelligence_disabled" });
  });

  it("UNKNOWN: an unreadable flag table lands on the same reason — isFlagEnabled is fail-closed", async () => {
    // Deliberately NOT `corridor_unreadable`: the traveller is told entry
    // intelligence is not answering, which is what actually happened, and
    // nothing downstream retries a corridor we never got as far as asking for.
    const sc = fakeClient({ feature_flags: { error: { message: "down" } } });
    const e = await resolveLayoverEntry(sc, USER, "TW");
    assert.deepEqual(e, { state: "unresolved", reason: "entry_intelligence_disabled" });
  });

  it("UNKNOWN: no country for the airport is a curator's problem, named as such", async () => {
    for (const code of [null, undefined, "", "Neverland", "ZZ"]) {
      const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: corridor("visa_free") });
      const e = await resolveLayoverEntry(sc, USER, code as any);
      assert.deepEqual(e, { state: "unresolved", reason: "airport_country_unknown" }, String(code));
    }
  });

  it("UNKNOWN: no passport on file is the traveller's to fix, and says so distinctly", async () => {
    const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: { rows: [] }, entry_requirements: corridor("visa_free") });
    const e = await resolveLayoverEntry(sc, USER, "TW");
    assert.deepEqual(e, { state: "unresolved", reason: "no_passport_on_file" });
  });

  it("UNKNOWN: a passport row whose country we cannot resolve is also no_passport_on_file", async () => {
    const sc = fakeClient({
      feature_flags: FLAG_ON,
      traveler_passports: { rows: [{ issuing_country: "Wakanda", is_primary: true, created_at: "2024-01-01T00:00:00Z" }] },
      entry_requirements: corridor("visa_free"),
    });
    assert.deepEqual(await resolveLayoverEntry(sc, USER, "TW"), { state: "unresolved", reason: "no_passport_on_file" });
  });

  it("UNKNOWN: an uncurated corridor is an unknown, never a no", async () => {
    // `entry_requirements` has no INSERT in any migration — 0169 calls that its
    // honesty contract — so this is the state EVERY real corridor is in until
    // somebody curates one. Reading it as a refusal would ground every
    // traveller on the app.
    const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: { rows: [] } });
    assert.deepEqual(await resolveLayoverEntry(sc, USER, "TW"), { state: "unresolved", reason: "no_data_for_corridor" });
  });

  it("FAILED READ: an errored passport read is not 'this traveller has no passport'", async () => {
    const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: { error: { message: "timeout" } }, entry_requirements: corridor("visa_free") });
    assert.deepEqual(await resolveLayoverEntry(sc, USER, "TW"), { state: "unresolved", reason: "corridor_unreadable" });
  });

  it("FAILED READ: a THROWN passport read is the same fact as a returned error", async () => {
    const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: { throws: true }, entry_requirements: corridor("visa_free") });
    assert.deepEqual(await resolveLayoverEntry(sc, USER, "TW"), { state: "unresolved", reason: "corridor_unreadable" });
  });

  it("FAILED READ: an errored corridor read is not 'nobody has curated this corridor'", async () => {
    const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: { error: { message: "timeout" } } });
    assert.deepEqual(await resolveLayoverEntry(sc, USER, "TW"), { state: "unresolved", reason: "corridor_unreadable" });
  });

  it("FAILED READ: a THROWN corridor read is unreadable too", async () => {
    const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: { throws: true } });
    assert.deepEqual(await resolveLayoverEntry(sc, USER, "TW"), { state: "unresolved", reason: "corridor_unreadable" });
  });

  it("the passport picked is the primary, else the oldest — never the most convenient", async () => {
    const log: Call[] = [];
    const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: corridor("visa_free") }, log);
    await resolveLayoverEntry(sc, USER, "TW");
    const read = log.find((c) => c.table === "traveler_passports");
    assert.ok(read, "the passport table was never read");
    assert.deepEqual(read.filters, [["user_id", USER]]);
    // is_primary DESC first, then created_at ASC: the marked passport wins, and
    // the tie-break is the oldest rather than whichever row comes back first.
    assert.deepEqual(read.orders, [["is_primary", false], ["created_at", true]]);
    assert.equal(read.limit, 1);
  });

  it("the corridor asked for is the traveller's passport into the airport's country, by ISO2", async () => {
    const log: Call[] = [];
    const sc = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: corridor("visa_free") }, log);
    // A country NAME resolves to the same corridor as its code — the airport
    // table stores either.
    await resolveLayoverEntry(sc, USER, "Taiwan");
    const read = log.find((c) => c.table === "entry_requirements");
    assert.ok(read, "the corridor table was never read");
    assert.deepEqual(read.filters, [["passport_country", "NZ"], ["destination_country", "TW"]]);
  });

  it("nothing is read once an earlier step has already answered", async () => {
    // A flag that is off must not cost a passport read, and a missing country
    // must not cost a corridor read. Cheap to get wrong, and the reason the
    // order of the checks is what it is.
    const log: Call[] = [];
    const off = fakeClient({ feature_flags: FLAG_OFF, traveler_passports: NZ_PASSPORT, entry_requirements: corridor("visa_free") }, log);
    await resolveLayoverEntry(off, USER, "TW");
    assert.deepEqual(log.map((c) => c.table), ["feature_flags"]);

    const log2: Call[] = [];
    const noCountry = fakeClient({ feature_flags: FLAG_ON, traveler_passports: NZ_PASSPORT, entry_requirements: corridor("visa_free") }, log2);
    await resolveLayoverEntry(noCountry, USER, null);
    assert.deepEqual(log2.map((c) => c.table), ["feature_flags"]);
  });
});

// ── readCorridor: the three-state read the gate is built on ──────────────────

describe("readCorridor — absent and unreadable are not the same answer", () => {
  it("found / absent / unreadable are three states, and lookupRequirement still collapses two", async () => {
    const found = await readCorridor(fakeClient({ entry_requirements: corridor("visa_free") }), "NZ", "TW");
    assert.equal(found.state, "found");
    assert.ok(found.row);

    const absent = await readCorridor(fakeClient({ entry_requirements: { rows: [] } }), "NZ", "TW");
    assert.deepEqual(absent, { state: "absent", row: null });

    // `message` carries the CAUSE, so the caller can log why it refused rather
    // than only that it refused — App C2's other half.
    const errored = await readCorridor(fakeClient({ entry_requirements: { error: { message: "down" } } }), "NZ", "TW");
    assert.deepEqual(errored, { state: "unreadable", row: null, message: "down" });

    const threw = await readCorridor(fakeClient({ entry_requirements: { throws: true } }), "NZ", "TW");
    assert.equal(threw.state, "unreadable");
    assert.match(threw.state === "unreadable" ? threw.message : "", /exploded/);
  });
});

// ── adviseLeaving: what each state does to the verdict ───────────────────────

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

function session(hours: number, over: Partial<LayoverSession> = {}): LayoverSession {
  const now = Date.now();
  return {
    id: "session-1", userId: USER, airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + hours * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: Math.round(hours * 60),
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...over,
  };
}

const PERMITTED: EntryEligibility = {
  state: "permitted", corridor: { passportCountry: "NZ", destinationCountry: "TW" }, status: "visa_free",
};
const REFUSED: EntryEligibility = {
  state: "refused", corridor: { passportCountry: "NZ", destinationCountry: "TW" }, status: "visa_required",
};
const REASONS: EntryUnresolvedReason[] = [
  "entry_intelligence_disabled",
  "no_passport_on_file",
  "airport_country_unknown",
  "no_data_for_corridor",
  "corridor_unreadable",
];

/**
 * A window with the usable minutes STATED rather than computed.
 *
 * `computeWindow` is a function of the wall clock — the return buffer carries a
 * time-of-day extra — so a fixture pinned to "eleven hours from now" lands in a
 * different band in the evening than in the morning. census-layover 19.4 names
 * exactly that failure in another lane's suite. `adviseLeaving` reads only
 * `usableMinutes` and `returnState` off the window, so the rest is a real
 * envelope and the one number the branches turn on is fixed here.
 */
function windowOf(usableMinutes: number): LayoverWindow {
  const s = session(11);
  return { ...computeWindow(AIRPORT, s), usableMinutes };
}

/** The three sides of the engine's 90 / 45 thresholds. */
const ROOMY = 200;
const TIGHT = 60;
const SHORT = 20;

/** A layover long enough that the clock alone would say yes. */
function roomy(entry?: EntryEligibility | null) {
  return adviseLeaving(AIRPORT, session(11), windowOf(ROOMY), { entry });
}

describe("adviseLeaving — the entry gate withholds a yes and nothing else", () => {
  it("the clock alone still says yes: the ungated window is the control", () => {
    const advice = roomy(PERMITTED);
    assert.equal(advice.verdict, "yes");
  });

  it("CONFIRMED: the yes stands, the standing unknown goes, and the code is not emitted", () => {
    const advice = roomy(PERMITTED);
    assert.equal(advice.verdict, "yes");
    assert.ok(
      !advice.unknowns.includes(ENTRY_UNCONFIRMED_UNKNOWN),
      `a confirmed corridor still disclaimed it: ${JSON.stringify(advice.unknowns)}`,
    );
    assert.ok(
      !advice.reasonCodes.includes("ENTRY_NOT_CONFIRMED"),
      "ENTRY_NOT_CONFIRMED was emitted on a confirmed corridor",
    );
  });

  it("UNCONFIRMED: a refusal beats the clock outright, however much time there is", () => {
    const advice = roomy(REFUSED);
    assert.equal(advice.verdict, "no");
    assert.ok(advice.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
    // Names both ends of the corridor, so the traveller can see which fact is
    // being asserted about them rather than a bare refusal.
    assert.ok(advice.reasons.some((r) => r.includes("TW") && r.includes("NZ")), JSON.stringify(advice.reasons));
    // INSUFFICIENT_USABLE_TIME is a CLOCK code. Emitting it here would tell a
    // traveller with ten spare hours they were short of time.
    assert.ok(!advice.reasonCodes.includes("INSUFFICIENT_USABLE_TIME"), JSON.stringify(advice.reasonCodes));
  });

  it("UNCONFIRMED: a status the copy table has never seen refuses without printing the raw column", () => {
    const advice = roomy({ ...REFUSED, status: "quantum_visa" });
    assert.equal(advice.verdict, "no");
    assert.ok(!advice.reasons.join(" ").includes("quantum_visa"), JSON.stringify(advice.reasons));
  });

  it("UNKNOWN and FAILED READ: each of the five reasons yields entry_unverified, not yes", () => {
    for (const reason of REASONS) {
      const advice = roomy({ state: "unresolved", reason });
      assert.equal(advice.verdict, "entry_unverified", reason);
      assert.ok(advice.reasonCodes.includes("ENTRY_NOT_CONFIRMED"), reason);
      assert.ok(advice.unknowns.includes(ENTRY_UNCONFIRMED_UNKNOWN), reason);
    }
  });

  it("the five reasons say five different things — collapsing them is the defect one level down", () => {
    const lines = REASONS.map((reason) => {
      const advice = roomy({ state: "unresolved", reason });
      const line = advice.reasons[advice.reasons.length - 1];
      assert.ok(line && line.length > 0, reason);
      return line;
    });
    assert.equal(new Set(lines).size, REASONS.length, `two reasons print the same sentence: ${JSON.stringify(lines)}`);
    // The one the traveller can fix themselves has to say so, or keeping the
    // five apart bought nothing.
    const passportLine = lines[REASONS.indexOf("no_passport_on_file")];
    assert.ok(/passport/i.test(passportLine), passportLine);
  });

  it("an ABSENT entry fact is unresolved, never permitted — a caller that forgets gets the cautious answer", () => {
    for (const missing of [undefined, null]) {
      const advice = roomy(missing);
      assert.equal(advice.verdict, "entry_unverified", String(missing));
      assert.ok(advice.reasonCodes.includes("ENTRY_NOT_CONFIRMED"), String(missing));
      assert.ok(advice.unknowns.includes(ENTRY_UNCONFIRMED_UNKNOWN), String(missing));
    }
  });

  it("DIRECTION: the gate never improves a verdict, on any window", () => {
    // Three windows on the three sides of the engine's thresholds, crossed with
    // every entry state. A confident yes is the only thing the gate may take
    // away; nothing here may hand one out.
    const states: Array<EntryEligibility | null> = [
      PERMITTED, REFUSED, null,
      ...REASONS.map((reason) => ({ state: "unresolved", reason }) as EntryEligibility),
    ];
    const s = session(11);
    for (const usable of [ROOMY, TIGHT, SHORT]) {
      const w = windowOf(usable);
      const control: LeaveAdvice["verdict"] = adviseLeaving(AIRPORT, s, w, { entry: PERMITTED }).verdict;
      for (const entry of states) {
        const v = adviseLeaving(AIRPORT, s, w, { entry }).verdict;
        if (entry === PERMITTED) { assert.equal(v, control, `${usable} min`); continue; }
        // Anything other than a confirmed corridor may only hold the control
        // where it was not a yes, or replace a yes with a withheld one.
        if (control === "yes") {
          assert.ok(v === "entry_unverified" || v === "no", `${usable} min ${JSON.stringify(entry)} -> ${v}`);
        } else {
          assert.ok(v === control || v === "no", `${usable} min ${JSON.stringify(entry)} -> ${v} (control ${control})`);
        }
        assert.notEqual(v, "yes", `${usable} min ${JSON.stringify(entry)} was upgraded to yes`);
      }
    }
  });

  it("a tight window stays tight when entry is unconfirmed — no invented extra caution", () => {
    // "tight" and "no" were never a confident yes, so the gate leaves them
    // alone. Downgrading them further would be the gate asserting something
    // about the CLOCK, which it knows nothing about.
    const s = session(11);
    const w = windowOf(TIGHT);
    assert.equal(adviseLeaving(AIRPORT, s, w, { entry: PERMITTED }).verdict, "tight");
    for (const reason of REASONS) {
      assert.equal(adviseLeaving(AIRPORT, s, w, { entry: { state: "unresolved", reason } }).verdict, "tight", reason);
    }
    // And the short band is a clock "no" that stays a clock "no": the
    // INSUFFICIENT_USABLE_TIME code is still the one that explains it.
    const short = adviseLeaving(AIRPORT, s, windowOf(SHORT), { entry: { state: "unresolved", reason: "no_data_for_corridor" } });
    assert.equal(short.verdict, "no");
    assert.ok(short.reasonCodes.includes("INSUFFICIENT_USABLE_TIME"));
  });

  it("a traveller staying airside is not told about a border they are not crossing", () => {
    const s = session(11, { wantsToLeave: false });
    const advice = adviseLeaving(AIRPORT, s, windowOf(ROOMY), { entry: REFUSED });
    assert.equal(advice.verdict, "stay_airside");
  });
});

// ── the certified record: entry is a NAMED input, so it is in the hash ───────

describe("certifyFeasibility — entry travels inside inputHash, like every other fact", () => {
  /**
   * PINNED TO AN INSTANT, both ends. `certifySessionFeasibility` takes `nowMs`,
   * but a session built from `Date.now()` drifts against it, and the return
   * buffer carries a time-of-day extra — so a fixture that fixes only one of
   * the two lands in a different band depending on the hour the suite runs.
   * census-layover 19.4 names that failure in another lane's file.
   */
  const NOW = Date.parse("2026-09-22T00:00:00Z");
  function fixed(hours: number, over: Partial<LayoverSession> = {}): LayoverSession {
    return {
      ...session(hours, over),
      arrivalTime: new Date(NOW + 5 * 60_000).toISOString(),
      departureTime: new Date(NOW + hours * 3_600_000).toISOString(),
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    };
  }
  function certify(entry?: EntryEligibility | null, hours = 11) {
    return certifySessionFeasibility(AIRPORT, fixed(hours), { nowMs: NOW, entry });
  }

  it("the verdict a record certifies is the gated one", () => {
    assert.equal(certify(PERMITTED).verdict, "yes");
    assert.equal(certify({ state: "unresolved", reason: "no_data_for_corridor" }).verdict, "entry_unverified");
    assert.equal(certify(REFUSED).verdict, "no");
    assert.equal(certify().verdict, "entry_unverified");
  });

  it("two records that differ only in entry do not share an inputHash", () => {
    // Otherwise `replayFeasibility` would reproduce one record from the other's
    // inputs and the hash would stop being an identity.
    const hashes = [
      certify(PERMITTED).inputHash,
      certify(REFUSED).inputHash,
      certify({ state: "unresolved", reason: "no_data_for_corridor" }).inputHash,
      certify({ state: "unresolved", reason: "corridor_unreadable" }).inputHash,
      certify(null).inputHash,
    ];
    assert.equal(new Set(hashes).size, hashes.length, "two different entry facts hashed the same");
  });

  it("entry is projected field by field, so an extra key on the caller's object cannot move the hash", () => {
    const s = fixed(11);
    const base = { nowMs: NOW };
    const clean = feasibilityInputHash(feasibilityInputs(AIRPORT, s, { ...base, entry: PERMITTED }));
    const dirty = feasibilityInputHash(
      feasibilityInputs(AIRPORT, s, { ...base, entry: { ...PERMITTED, sourceUrl: "https://example.test" } as any }),
    );
    assert.equal(clean, dirty);
  });

  it("an omitted entry is recorded as null, not as an absent key", () => {
    const s = fixed(11);
    const inputs = feasibilityInputs(AIRPORT, s, { nowMs: NOW });
    assert.equal(inputs.entry, null);
    assert.ok("entry" in inputs);
  });
});

// ── which country a layover is asking about ─────────────────────────────────

describe("layoverAirportCountry — a placeholder code is not a country", () => {
  it("a real profile answers with its code", () => {
    assert.equal(layoverAirportCountry({ countryCode: "TW", country: "Taiwan" }), "TW");
  });

  it("a manually entered airport falls back to the country the traveller typed", () => {
    // `buildFallbackProfile` stamps "XX" on every manual airport. Reading it as
    // a country would report the corridor unknown for a session that names its
    // country perfectly well.
    assert.equal(layoverAirportCountry({ countryCode: "XX", country: "Japan" }), "Japan");
  });

  it("a manual airport with no country at all resolves to nothing", () => {
    assert.equal(layoverAirportCountry({ countryCode: "XX", country: "Unknown" }), "Unknown");
    // ...and "Unknown" is not a country, so the gate reports it as one of the
    // five reasons rather than inventing a corridor.
    assert.equal(layoverAirportCountry({ countryCode: null, country: null }), null);
  });
});

// ── the route layer asks, once per request, for the traveller's own corridor ─

const HERE = dirname(fileURLToPath(import.meta.url));

describe("routes/airport.ts — every own-session certification carries the entry fact", () => {
  const src = readFileSync(join(HERE, "..", "routes", "airport.ts"), "utf8");

  it("all but one certification site supplies entry, and the one that does not is the crew wrapper", () => {
    // Wiring SOME sites would be worse than wiring none: two endpoints would
    // publish different verdicts for the same session, and a traveller would
    // see the overview say one thing and the safety card another.
    const calls = (src.match(/certifySessionFeasibility\s*\(/g) ?? []).length;
    assert.ok(calls > 0, "no certification site found — this test is reading the wrong file");
    const wired = (src.match(/entry:\s*await sessionEntry\(/g) ?? []).length;
    assert.equal(
      wired, calls - 1,
      `${calls} certification site(s), ${wired} of them supplying entry — every site but the crew wrapper must`,
    );

    // The unwired one is the crew wrapper, ON PURPOSE: it certifies OTHER
    // people's sessions, and a crewmate's passport corridor is not something
    // this surface may read or publish.
    const at = src.indexOf("function certifyCrewMemberRecord");
    assert.ok(at > 0, "the crew wrapper is gone — re-decide where entry is resolved");
    const body = src.slice(at, src.indexOf("}", src.indexOf("return certifySessionFeasibility", at)));
    assert.ok(!body.includes("sessionEntry"), "the crew wrapper started resolving other travellers' corridors");
  });

  it("the corridor asked for is the SESSION OWNER's, into the airport's own country", () => {
    // Non-vacuity for the count above: it would pass just as happily if
    // `sessionEntry` resolved the wrong traveller.
    assert.match(
      src,
      /resolveLayoverEntry\(sc, session\.userId, layoverAirportCountry\(airport\)\)/,
      "sessionEntry no longer resolves the session owner's corridor for this airport",
    );
  });
});

// ── the record cannot affirm and disclaim the same act ───────────────────────

describe("certifyFeasibility — one response cannot say two things", () => {
  const NOW = Date.parse("2026-09-22T00:00:00Z");
  function fixedSession(hours: number, over: Partial<LayoverSession> = {}): LayoverSession {
    return {
      ...session(hours, over),
      arrivalTime: new Date(NOW + 5 * 60_000).toISOString(),
      departureTime: new Date(NOW + hours * 3_600_000).toISOString(),
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    };
  }
  const record = (entry: EntryEligibility | null, hours: number) =>
    certifySessionFeasibility(AIRPORT, fixedSession(hours), { nowMs: NOW, entry });

  const UNRESOLVED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };

  it("a roomy window with a confirmed corridor is safe AND yes", () => {
    const r = record(PERMITTED, 11);
    assert.equal(r.verdict, "yes");
    assert.equal(r.windowOnly.rating, "safe");
  });

  it("the same window with an unconfirmed corridor is NOT safe beside entry_unverified", () => {
    // `GET /:id/safety` serves `windowOnly.rating` as `overallRating` next to
    // `advice.verdict`. Left alone, a traveller would read "safe" above "we
    // could not confirm you may enter this country" — the L48 finding put back
    // one level down, in the one response.
    const r = record(UNRESOLVED, 11);
    assert.equal(r.verdict, "entry_unverified");
    assert.equal(r.windowOnly.rating, "possible_but_risky");
    assert.ok(
      (r.windowOnly.warningReason ?? "").length > 0,
      "a demoted rating with no reason is a refusal nobody can explain",
    );
  });

  it("the demotion only ever moves DOWN, and only off safe", () => {
    // A tight window is already `possible_but_risky` and a short one already
    // `not_recommended`: the gate has nothing to say about a clock, so it must
    // leave both where they are rather than invent a further step.
    for (const hours of [11, 4.4, 2.6]) {
      // Annotated because `assert.equal` takes both sides as `unknown` and the
      // two locals end up inferring through each other; the annotation is the
      // type the engine already declares, not a widening.
      const clock: SafetyRating = record(PERMITTED, hours).windowOnly.rating;
      const gated: SafetyRating = record(UNRESOLVED, hours).windowOnly.rating;
      if (clock === "safe") assert.equal(gated, "possible_but_risky", `${hours}h`);
      else assert.equal(gated, clock, `${hours}h`);
    }
  });

  it("a refusal is a refusal on both fields, whatever the clock says", () => {
    // The cap is over the WHOLE verdict union, not a special case for
    // `entry_unverified`. A refused corridor on a ten-hour layover would
    // otherwise publish `overallRating: "safe"` beside `verdict: "no"`, which
    // is the same defect wearing the other verdict.
    const r = record(REFUSED, 11);
    assert.equal(r.verdict, "no");
    assert.equal(r.windowOnly.rating, "not_recommended");
    assert.ok(r.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
    assert.ok((r.windowOnly.warningReason ?? "").includes("NZ"), r.windowOnly.warningReason ?? "");
  });

  it("a traveller staying airside keeps their own rating, which is not on the scale", () => {
    // `airport_only` is not a judgement about whether leaving is safe. It is
    // the traveller having said they are not leaving, and a rank comparison
    // would quietly turn it into one.
    const r = record(PERMITTED, 11);
    assert.equal(r.windowOnly.rating, "safe");
    const stay = certifySessionFeasibility(AIRPORT, fixedSession(11, { wantsToLeave: false }), { nowMs: NOW, entry: REFUSED });
    assert.equal(stay.verdict, "stay_airside");
    assert.equal(stay.windowOnly.rating, "airport_only");
  });
});
