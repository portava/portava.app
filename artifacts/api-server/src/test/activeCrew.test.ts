/**
 * activeCrew.resolveActiveCrewId — the server-side "which crew is this observer on
 * right now?" resolver that closes the residual leak (a crew member self-reporting
 * "just me"). Proves it resolves owned and accepted-member trips whose date window
 * contains today, ignores expired / future / dateless trips and pending invites,
 * picks the most recently started when several qualify, and fails soft to null.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveCrewId } from "../lib/activeCrew.js";

const NOW = new Date("2026-08-26T12:00:00.000Z"); // today = 2026-08-26
const ACTIVE = { start_date: "2026-08-25", end_date: "2026-08-27" };
const EXPIRED = { start_date: "2026-08-01", end_date: "2026-08-10" };
const FUTURE = { start_date: "2026-09-01", end_date: "2026-09-05" };
const OPEN_ENDED = { start_date: "2026-08-25", end_date: null };

/** A date-window-aware fake of trips + trip_members. */
function makeDb(cfg: { trips?: any[]; members?: any[]; error?: boolean }) {
  function from(table: string) {
    const eqs: [string, any][] = [];
    let inF: [string, any[]] | null = null;
    let lteF: [string, string] | null = null;
    let gteF: [string, string] | null = null;
    let lim = Infinity;
    let orderCol: string | null = null;
    let orderAsc = true;
    const src = (): any[] => (table === "trips" ? cfg.trips ?? [] : table === "trip_members" ? cfg.members ?? [] : []);
    function run() {
      if (cfg.error) return { data: null, error: { message: "boom" } };
      let rows = src().filter(
        (r: any) =>
          eqs.every(([c, v]) => r[c] === v) &&
          (!inF || inF[1].includes(r[inF[0]])) &&
          (!lteF || (r[lteF[0]] != null && r[lteF[0]] <= lteF[1])) &&
          (!gteF || (r[gteF[0]] != null && r[gteF[0]] >= gteF[1])),
      );
      if (orderCol) {
        const col = orderCol;
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (orderAsc ? 1 : -1));
      }
      return { data: rows.slice(0, lim), error: null };
    }
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { inF = [c, v]; return b; },
      lte(c: string, v: string) { lteF = [c, v]; return b; },
      gte(c: string, v: string) { gteF = [c, v]; return b; },
      order(c: string, o: { ascending: boolean }) { orderCol = c; orderAsc = o.ascending; return b; },
      limit(n: number) { lim = n; return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from };
}

describe("activeCrew.resolveActiveCrewId", () => {
  it("resolves an OWNED active trip", async () => {
    const db = makeDb({ trips: [{ id: "t-own", owner_id: "u1", ...ACTIVE }] });
    assert.equal(await resolveActiveCrewId(db, "u1", NOW), "t-own");
  });

  it("resolves an accepted-MEMBER active trip when none is owned", async () => {
    const db = makeDb({
      trips: [{ id: "t-mem", owner_id: "someone", ...ACTIVE }],
      members: [{ trip_id: "t-mem", user_id: "u2", role: "member" }],
    });
    assert.equal(await resolveActiveCrewId(db, "u2", NOW), "t-mem");
  });

  it("ignores expired, future, and open-ended (null end_date) trips", async () => {
    for (const win of [EXPIRED, FUTURE, OPEN_ENDED]) {
      const db = makeDb({ trips: [{ id: "t", owner_id: "u1", ...win }] });
      assert.equal(await resolveActiveCrewId(db, "u1", NOW), null, `${JSON.stringify(win)} is not active`);
    }
  });

  it("ignores a pending invite (role invited)", async () => {
    const db = makeDb({
      trips: [{ id: "t-mem", owner_id: "someone", ...ACTIVE }],
      members: [{ trip_id: "t-mem", user_id: "u3", role: "invited" }],
    });
    assert.equal(await resolveActiveCrewId(db, "u3", NOW), null);
  });

  it("picks the most recently started when several are active", async () => {
    const db = makeDb({
      trips: [
        { id: "older", owner_id: "u1", start_date: "2026-08-20", end_date: "2026-08-30" },
        { id: "newer", owner_id: "u1", start_date: "2026-08-25", end_date: "2026-08-27" },
      ],
    });
    assert.equal(await resolveActiveCrewId(db, "u1", NOW), "newer");
  });

  it("fails soft to null on a DB error, a missing client, and an empty actor", async () => {
    assert.equal(await resolveActiveCrewId(makeDb({ error: true }), "u1", NOW), null);
    assert.equal(await resolveActiveCrewId(null, "u1", NOW), null);
    assert.equal(await resolveActiveCrewId(makeDb({}), "", NOW), null);
  });
});
