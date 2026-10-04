/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-112, D-W11X2-113): the structured Compass
 * context never states a capped bookings read as the list, and a failed circle-list read never hides the
 * member-list sentence.
 *
 * B5 (D-W11X2-112): `rent_buddy_bookings` was read UNORDERED with `.limit(5)`, hidden buddies dropped after the
 * limit and `rows.slice(0, 3)` kept with no marker, so /compass/ask's prompt said "Active buddy bookings" over
 * three of the user's four. The read is now ordered (booking date, start time, id) and reads one past its cap;
 * a longer list, or more visible bookings than shown, marks `bookingsTruncated` and the prompt says so.
 *
 * B6 (D-W11X2-113; D-W11X2-98's "S9 equivalent" corrected): with the circle-list read failed (`u.circles`),
 * `get_circle_activity` picked the list sentence alone and `circleListBoundsInfo` returned nothing, and the
 * prompt's `else if (u.circleMembers)` dropped the member line — an owned circle was served with
 * `memberHandles: []` over a failed member read and nothing said the members were unread.
 *
 * The round-13 verifier's probes, copied in unchanged (V13-BK0, BK1, CU0, CU1, CU2), and this lane's:
 *   BK2  the bookings read is ordered and reads one past its cap
 *   BK3  six bookings read (the cap is five) → marked, and the prompt says these are not all of them
 *   BK4  CONTROL: four read, one buddy hidden → three visible, three shown: nothing is marked
 *   BK6  six read, three buddies hidden → two shown, marked (the sixth was past the cap)
 *   CU3  the member read past its cap and the handle read failed → "could not be read", the stronger sentence
 *   CU1b, CU2b  the tool's member sentence is the right one (unread vs shortened); CUc its control
 *   BK5  CONTROL: a failed bookings read keeps its own line and adds no "not all" line
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import { buildStructuredCompassContext, formatStructuredContextLines } from "../compass/CompassStructuredContext.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER, DB_ERR, type Call } from "./helpers/compassReadWorld.js";

const profile = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const limitOf = (calls: Call[]) => { const c = calls.find(([k]) => k === "limit"); return c ? Number(c[1][0]) : Infinity; };
const booking = (i: number) => ({ buddy_id: `bb000000-0000-4000-a000-00000000000${i}`, city: ["Lisbon", "Porto", "Faro", "Braga"][i % 4], booking_date: `2026-10-0${i + 1}`, start_time: "10:00", duration_h: 2, status: "confirmed" });
const bkWorld = (n: number) => compassWorld({ answer: (t, calls) => (t === "rent_buddy_bookings" ? { data: Array.from({ length: n }, (_, i) => booking(i)).slice(0, limitOf(calls)), error: null } : undefined) });

describe("v13: the structured context's bookings section over a capped read", () => {
  it("V13-BK0 CONTROL: two active bookings → both listed", async () => {
    const ctx = await buildStructuredCompassContext(bkWorld(2).client as any, profile);
    assert.equal(ctx.activeBookings.length, 2);
  });
  it("V13-BK1 four active bookings → three listed as the list, with no word that more exist", async () => {
    const ctx = await buildStructuredCompassContext(bkWorld(4).client as any, profile);
    const lines = formatStructuredContextLines(ctx);
    const said = Boolean((ctx as any).unread) || lines.some((l) => /not all|more than|shortened|may be incomplete|could not/i.test(l));
    assert.ok(ctx.activeBookings.length === 4 || said, `4 bookings exist, ${ctx.activeBookings.length} are stated as the list: ${JSON.stringify(lines)}`);
  });
});

const BUDDY_HIDDEN = "bb000000-0000-4000-a000-000000000009";
const hiddenProfile = { userId: VIEWER, blockedUserIds: [BUDDY_HIDDEN], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
function bkWorld2(rows: any[], fail = false) {
  const seen: Call[][] = [];
  const w = compassWorld({ answer: (t, calls) => { if (t !== "rent_buddy_bookings") return undefined; seen.push(calls); return fail ? { data: null, error: DB_ERR } : { data: rows.slice(0, limitOf(calls)), error: null }; } });
  return Object.assign(w, { seen });
}
const NOT_ALL_BOOKINGS = /not all of the user's (active )?buddy bookings/i;
describe("the structured context's bookings read is bounded honestly (§111, D-W11X2-112)", () => {
  it("BK2 the bookings read is ordered and reads one past its cap", async () => {
    const w = bkWorld2([booking(0)]);
    await buildStructuredCompassContext(w.client as any, profile);
    const calls = w.seen[0];
    assert.deepEqual(calls.filter(([k]) => k === "order").map(([, a]) => a[0]), ["booking_date", "start_time", "id"], JSON.stringify(calls));
    assert.equal(limitOf(calls), 6, JSON.stringify(calls));
  });
  it("BK3 six bookings read (past the cap of five) → marked, and the prompt says these are not all", async () => {
    const ctx = await buildStructuredCompassContext(bkWorld2(Array.from({ length: 8 }, (_, i) => booking(i % 4))).client as any, profile);
    assert.equal(ctx.activeBookings.length, 3);
    assert.equal(ctx.unread?.bookingsTruncated, true, JSON.stringify(ctx.unread));
    assert.ok(formatStructuredContextLines(ctx).some((l) => NOT_ALL_BOOKINGS.test(l)), formatStructuredContextLines(ctx).join("\n"));
  });
  it("BK4 CONTROL: four read, one buddy hidden → three visible, three shown, nothing marked", async () => {
    const rows = [booking(0), booking(1), { ...booking(2), buddy_id: BUDDY_HIDDEN }, booking(3)];
    const ctx = await buildStructuredCompassContext(bkWorld2(rows).client as any, hiddenProfile);
    assert.equal(ctx.activeBookings.length, 3);
    assert.equal(ctx.unread, undefined, JSON.stringify(ctx.unread));
    assert.ok(!formatStructuredContextLines(ctx).some((l) => NOT_ALL_BOOKINGS.test(l)));
  });
  it("BK5 CONTROL: a failed bookings read says its own line and no 'not all' line", async () => {
    const ctx = await buildStructuredCompassContext(bkWorld2([], true).client as any, profile);
    const lines = formatStructuredContextLines(ctx);
    assert.ok(lines.some((l) => /bookings could not be read/i.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => NOT_ALL_BOOKINGS.test(l)), lines.join("\n"));
  });
});

const inOf = (calls: Call[], col: string) => (calls.find(([k, a]) => k === "in" && a[0] === col)?.[1][1] ?? null) as string[] | null;
const eqVal = (calls: Call[], col: string) => calls.find(([k, a]) => k === "eq" && a[0] === col)?.[1][1];
const member = (i: number) => `d${String(i).padStart(7, "0")}-0000-4000-a000-000000000000`;

function world(o: { membershipsFail: boolean; memberReadFails: boolean; members: number }) {
  return compassWorld({
    answer: (t, calls) => {
      if (t === "circle_memberships" && eqVal(calls, "other_id") === VIEWER) return o.membershipsFail ? { data: null, error: DB_ERR } : { data: [], error: null };
      if (t === "circles" && eqVal(calls, "owner_id") === VIEWER) return { data: [{ id: "own-1", name: "Porto crew", owner_id: VIEWER }], error: null };
      if (t === "circle_memberships" && inOf(calls, "user_id")) return o.memberReadFails ? { data: null, error: DB_ERR } : { data: Array.from({ length: o.members }, (_, i) => ({ user_id: VIEWER, other_id: member(i), status: "pending" })), error: null };
      const ids = t === "profiles" ? inOf(calls, "id") : null;
      if (ids) return { data: ids.map((id) => ({ id, handle: `h${id.slice(1, 8)}` })), error: null };
      return undefined;
    },
  });
}
const tool = async (w: ReturnType<typeof compassWorld>) => (await executeCompassTool(w.client as any, VIEWER, profile, "get_circle_activity", {})) as { circles: any[]; info?: string };
const prompt = async (w: ReturnType<typeof compassWorld>) => formatStructuredContextLines(await buildStructuredCompassContext(w.client as any, profile)).join("\n");

describe("v13b: a failed circle-list read hides the member-list sentence", () => {
  it("V13-CU0 CONTROL: only the member read fails → the member lists are said unread (tool and prompt)", async () => {
    const w = world({ membershipsFail: false, memberReadFails: true, members: 0 });
    const r = await tool(w);
    assert.match(String(r.info), /member lists/i, JSON.stringify(r));
    assert.match(await prompt(w), /member lists/i);
  });
  it("V13-CU1 the memberships read AND the member read fail → the member lists must still be said unread", async () => {
    const w = world({ membershipsFail: true, memberReadFails: true, members: 0 });
    const r = await tool(w);
    assert.equal(r.circles.length, 1, JSON.stringify(r));
    assert.deepEqual(r.circles[0].memberHandles, []);
    assert.match(String(r.info), /member lists/i, `tool: ${JSON.stringify(r)}`);
    const p = await prompt(w);
    assert.match(p, /member lists/i, `prompt: ${p}`);
  });
  it("V13-CU2 the memberships read fails and the owned circle has 9 members (8 shown) → 'shortened' must be said", async () => {
    const w = world({ membershipsFail: true, memberReadFails: false, members: 9 });
    const r = await tool(w);
    assert.equal(r.circles[0].memberHandles.length, 8, JSON.stringify(r));
    assert.match(String(r.info), /member lists/i, `tool: ${JSON.stringify(r)}`);
    const p = await prompt(w);
    assert.match(p, /member lists/i, `prompt: ${p}`);
  });
});

describe("the member-list sentence beside a failed circle-list read, exactly (§111, D-W11X2-113)", () => {
  it("CU1b the member read failed → the tool says the member lists could not be read, not that they are shortened", async () => {
    const r = await tool(world({ membershipsFail: true, memberReadFails: true, members: 0 }));
    assert.match(String(r.info), /could not be checked right now.*member lists could not be read/i, JSON.stringify(r));
    assert.doesNotMatch(String(r.info), /shortened/i, JSON.stringify(r));
  });
  it("CU2b eight of nine handles shown → the tool says the member lists are shortened, not unread", async () => {
    const r = await tool(world({ membershipsFail: true, memberReadFails: false, members: 9 }));
    assert.match(String(r.info), /could not be checked right now.*member lists are shortened/i, JSON.stringify(r));
    assert.doesNotMatch(String(r.info), /member lists could not be read/i, JSON.stringify(r));
  });
  it("CU3 the member read ran past its cap AND the handle read failed → the stronger sentence: the member lists could not be read", async () => {
    const w = compassWorld({
      answer: (t, calls) => {
        if (t === "circle_memberships" && eqVal(calls, "other_id") === VIEWER) return { data: null, error: DB_ERR };
        if (t === "circles" && eqVal(calls, "owner_id") === VIEWER) return { data: [{ id: "own-1", name: "Porto crew", owner_id: VIEWER }], error: null };
        if (t === "circle_memberships" && inOf(calls, "user_id")) return { data: Array.from({ length: 201 }, (_, i) => ({ user_id: VIEWER, other_id: member(i), status: "pending" })), error: null };
        if (t === "profiles" && inOf(calls, "id")) return { data: null, error: DB_ERR };
        return undefined;
      },
    });
    const ctx = await buildStructuredCompassContext(w.client as any, profile);
    assert.equal(ctx.unread?.circleMembers, true, JSON.stringify(ctx.unread)); assert.equal(ctx.unread?.circleMembersTruncated, true, JSON.stringify(ctx.unread));
    const r = await tool(w);
    assert.match(String(r.info), /member lists could not be read/i, JSON.stringify(r));
  });
  it("CUc CONTROL: only the circle-list read fails, the members are all read and shown → the list sentence alone", async () => {
    const r = await tool(world({ membershipsFail: true, memberReadFails: false, members: 2 }));
    assert.match(String(r.info), /Some of the user's circles could not be checked/i, JSON.stringify(r));
    assert.doesNotMatch(String(r.info), /member lists/i, JSON.stringify(r));
  });
});

describe("a bookings read past its cap with hidden buddies (§111, D-W11X2-112)", () => {
  it("BK6 six read, the first three buddies hidden → two shown, and marked: a sixth, visible, was past the cap", async () => {
    const rows = [0, 1, 2].map((i) => ({ ...booking(i), buddy_id: BUDDY_HIDDEN })).concat([booking(3), booking(0), booking(1)]);
    const ctx = await buildStructuredCompassContext(bkWorld2(rows).client as any, hiddenProfile);
    assert.equal(ctx.activeBookings.length, 2, JSON.stringify(ctx.activeBookings));
    assert.equal(ctx.unread?.bookingsTruncated, true, JSON.stringify(ctx.unread));
  });
});

