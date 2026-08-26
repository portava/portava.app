/**
 * activeCrew.resolveActiveCrewId — the server-side "which crew is this observer on
 * right now?" resolver that closes the residual leak (a crew member self-reporting
 * "just me"). Proves: only a SHARED crew (≥2 accepted members) resolves — a
 * solo-owned trip (a personal decoy) yields null so it cannot split a real crew;
 * a member of a real crew who also owns a decoy still resolves the CREW; the ±1-day
 * window tolerates a trip whose local day leads/lags UTC; expired/future/dateless
 * trips and pending invites are ignored; and it fails soft to null.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveCrewId } from "../lib/activeCrew.js";

const NOW = new Date("2026-08-26T12:00:00.000Z"); // today = 2026-08-26
const ACTIVE = { start_date: "2026-08-25", end_date: "2026-08-27" };
const EXPIRED = { start_date: "2026-08-01", end_date: "2026-08-10" };
const FUTURE = { start_date: "2026-09-01", end_date: "2026-09-05" };
const OPEN_ENDED = { start_date: "2026-08-25", end_date: null };
// Starts "tomorrow" in UTC but is active for an east-of-UTC traveller now — the
// ±1-day widen must resolve it.
const TZ_LEAD = { start_date: "2026-08-27", end_date: "2026-08-30" };

/** A fake of trips + trip_members supporting eq / in (multiple) / lte / gte. */
function makeDb(cfg: { trips?: any[]; members?: any[]; error?: boolean }) {
  function from(table: string) {
    const eqs: [string, any][] = [];
    const ins: [string, any[]][] = [];
    let lteF: [string, string] | null = null;
    let gteF: [string, string] | null = null;
    const src = (): any[] => (table === "trips" ? cfg.trips ?? [] : table === "trip_members" ? cfg.members ?? [] : []);
    function run() {
      if (cfg.error) return { data: null, error: { message: "boom" } };
      const rows = src().filter(
        (r: any) =>
          eqs.every(([c, v]) => r[c] === v) &&
          ins.every(([c, v]) => v.includes(r[c])) &&
          (!lteF || (r[lteF[0]] != null && r[lteF[0]] <= lteF[1])) &&
          (!gteF || (r[gteF[0]] != null && r[gteF[0]] >= gteF[1])),
      );
      return { data: rows, error: null };
    }
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      lte(c: string, v: string) { lteF = [c, v]; return b; },
      gte(c: string, v: string) { gteF = [c, v]; return b; },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from };
}

/** A shared crew: owner + one accepted member. */
function sharedCrew(id: string, owner: string, member: string, win = ACTIVE) {
  return { trips: [{ id, owner_id: owner, ...win }], members: [{ trip_id: id, user_id: member, role: "member" }] };
}

describe("activeCrew.resolveActiveCrewId", () => {
  it("resolves an OWNED active SHARED trip (owner + a member = 2)", async () => {
    const db = makeDb(sharedCrew("t-own", "u1", "u2"));
    assert.equal(await resolveActiveCrewId(db, "u1", NOW), "t-own");
  });

  it("resolves an accepted-MEMBER active shared trip", async () => {
    const db = makeDb(sharedCrew("t-mem", "owner", "u2"));
    assert.equal(await resolveActiveCrewId(db, "u2", NOW), "t-mem");
  });

  it("a SOLO-owned trip (owner only, no other members) → null — cannot be a decoy crew", async () => {
    const db = makeDb({ trips: [{ id: "solo", owner_id: "u1", ...ACTIVE }], members: [] });
    assert.equal(await resolveActiveCrewId(db, "u1", NOW), null);
  });

  it("a crew member who ALSO owns a solo decoy resolves the CREW, not the decoy", async () => {
    const db = makeDb({
      trips: [
        { id: "decoy", owner_id: "u2", start_date: "2026-08-26", end_date: "2026-08-26" }, // solo, most recent start
        { id: "crew", owner_id: "owner", ...ACTIVE },                                       // shared, u2 is a member
      ],
      members: [{ trip_id: "crew", user_id: "u2", role: "member" }],
    });
    // decoy has the most recent start_date but only 1 member → skipped; crew wins.
    assert.equal(await resolveActiveCrewId(db, "u2", NOW), "crew");
  });

  it("the ±1-day window resolves a trip whose local day leads UTC (starts 'tomorrow')", async () => {
    const db = makeDb(sharedCrew("t-tz", "u1", "u2", TZ_LEAD));
    assert.equal(await resolveActiveCrewId(db, "u1", NOW), "t-tz", "widened window covers a UTC-tomorrow start");
  });

  it("ignores expired, far-future, and open-ended (null end_date) trips", async () => {
    for (const win of [EXPIRED, FUTURE, OPEN_ENDED]) {
      const db = makeDb(sharedCrew("t", "u1", "u2", win as any));
      assert.equal(await resolveActiveCrewId(db, "u1", NOW), null, `${JSON.stringify(win)} is not active`);
    }
  });

  it("a pending invite (role invited) is not a member and does not make a crew", async () => {
    const db = makeDb({ trips: [{ id: "t", owner_id: "owner", ...ACTIVE }], members: [{ trip_id: "t", user_id: "u3", role: "invited" }] });
    assert.equal(await resolveActiveCrewId(db, "u3", NOW), null, "invitee is not a member");
    // and the owner alone is not ≥2 members either
    assert.equal(await resolveActiveCrewId(db, "owner", NOW), null, "owner + only a pending invite = 1 member");
  });

  it("fails soft to null on a DB error, a missing client, and an empty actor", async () => {
    assert.equal(await resolveActiveCrewId(makeDb({ error: true }), "u1", NOW), null);
    assert.equal(await resolveActiveCrewId(null, "u1", NOW), null);
    assert.equal(await resolveActiveCrewId(makeDb({}), "", NOW), null);
  });
});
