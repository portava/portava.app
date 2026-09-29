/**
 * census-discovery §109 (DV-83 round 12, lane W11-X2, D-W11X2-88): `get_circle_activity` and the
 * structured Compass context never state a failed read as a fact.
 *
 * `buildStructuredCompassContext` read `circles`, `circle_memberships` and the member handles as
 * `{ data }` alone and caught every failure as "no circle context", so the tool answered the model
 * "The user is not in any circles." over a failed read (§109.1 BK2) — the `get_whos_around` defect
 * (§107/§108) on the sibling tool. The booking and stamp reads had the same shape, and /compass/ask's
 * prompt simply omitted a section it could not read. Each read's `.error` is now checked; the
 * context carries an `unread` marker (present only when a read failed, so a healthy context is
 * byte-identical), the tool says membership could not be checked, and the prompt says which
 * sections could not be read.
 *
 *   V11-CA0  CONTROL: the viewer owns "Porto crew" → the circle is listed, with no info and no marker
 *   V11-CA1  the `circles` read fails → never "The user is not in any circles."
 *   V11-CA2  the `circle_memberships` read fails (the viewer only JOINED a circle) → never "not in any circles"
 *   CA3      an owned circle is read, the joined-circles read fails → the owned circle kept, the list said incomplete
 *   CA4      the circle members read fails → the circle kept, its member list said incomplete
 *   CA5      the member handles read fails → the same
 *   CA6      the client throws → circle membership could not be checked
 *   CA7      the prompt: an unread circles, bookings or stamps read is said; a healthy context adds no line
 *   CA8      the booking and stamp reads: a failed read is marked, never an empty section alone
 *   CAc      CONTROL: a viewer in no circles, every read healthy → "The user is not in any circles." and no marker
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import { buildStructuredCompassContext, formatStructuredContextLines } from "../compass/CompassStructuredContext.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER, DB_ERR, type Call } from "./helpers/compassReadWorld.js";

const OWNER = "a7000000-0000-4000-a000-000000000007";
const MEMBER = "a7000000-0000-4000-a000-000000000008";
const profile = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const NOT_IN_ANY = "The user is not in any circles.";

type Tool = { circles: Array<{ name: string; memberHandles: string[]; isOwner: boolean }>; info?: string };
const tool = async (w: ReturnType<typeof compassWorld>) => (await executeCompassTool(w.client as any, VIEWER, profile, "get_circle_activity", {})) as Tool;

const inCall = (calls: Call[], column: string) => calls.some(([k, a]) => k === "in" && a[0] === column);
const eqCall = (calls: Call[], column: string) => calls.some(([k, a]) => k === "eq" && a[0] === column);
const ok = (data: unknown) => ({ data, error: null });
const failed = { data: null, error: DB_ERR };

/** A viewer who owns "Porto crew" (with MEMBER in it) and joined OWNER's "Joined". */
function circleWorld(fail: { owned?: boolean; memberships?: boolean; joined?: boolean; members?: boolean; handles?: boolean } = {}) {
  return compassWorld({
    answer: (t, calls) => {
      if (t === "circles" && eqCall(calls, "owner_id")) return fail.owned ? failed : ok([{ id: "c1", name: "Porto crew", owner_id: VIEWER }]);
      if (t === "circles" && inCall(calls, "owner_id")) return fail.joined ? failed : ok([{ id: "c2", name: "Joined", owner_id: OWNER }]);
      if (t === "circle_memberships" && eqCall(calls, "other_id")) return fail.memberships ? failed : ok([{ user_id: OWNER, other_id: VIEWER, status: "accepted" }]);
      if (t === "circle_memberships" && inCall(calls, "user_id")) return fail.members ? failed : ok([{ user_id: VIEWER, other_id: MEMBER, status: "accepted" }]);
      if (t === "profiles" && inCall(calls, "id")) return fail.handles ? failed : ok([{ id: MEMBER, handle: "marta" }]);
      return undefined;
    },
  });
}

describe("get_circle_activity over failed circle reads (§109, D-W11X2-88)", () => {
  it("V11-CA0 CONTROL: the viewer owns a circle → it is listed", async () => {
    const r = await tool(compassWorld({ answer: (t) => (t === "circles" ? { data: [{ id: "c1", name: "Porto crew", owner_id: VIEWER }], error: null } : undefined) }));
    assert.equal(r.circles.length, 1, JSON.stringify(r));
    assert.equal(r.info, undefined, JSON.stringify(r));
  });

  it("V11-CA1 the circles read fails → must not answer 'The user is not in any circles.'", async () => {
    const r = await tool(compassWorld({ failTables: ["circles"] }));
    assert.notEqual(r.info, NOT_IN_ANY, `a failed read was stated as a fact: ${JSON.stringify(r)}`);
    assert.match(r.info ?? "", /could not be checked/i);
    assert.deepEqual(r.circles, []);
  });

  it("V11-CA2 the circle_memberships read fails (the viewer only joined a circle) → must not answer 'not in any circles'", async () => {
    const r = await tool(compassWorld({ failTables: ["circle_memberships"], answer: (t, calls) => (t === "circles" && calls.some(([k, a]) => k === "in" && a[0] === "owner_id") ? { data: [{ id: "c2", name: "Joined", owner_id: OWNER }], error: null } : undefined) }));
    assert.notEqual(r.info, NOT_IN_ANY, `a failed read was stated as a fact: ${JSON.stringify(r)}`);
    assert.match(r.info ?? "", /could not be checked/i);
  });

  it("CA3 an owned circle is read and the joined-circles read fails → the owned circle kept, the list said incomplete", async () => {
    const r = await tool(circleWorld({ joined: true }));
    assert.deepEqual(r.circles.map((c) => c.isOwner), [true], JSON.stringify(r));
    assert.match(r.info ?? "", /may be incomplete/i, JSON.stringify(r));
    assert.doesNotMatch(r.info ?? "", /member list/i);
  });

  it("CA4 the circle members read fails → the circles kept, the member list said incomplete", async () => {
    const r = await tool(circleWorld({ members: true }));
    assert.equal(r.circles.length, 2, JSON.stringify(r));
    assert.match(r.info ?? "", /member list/i, JSON.stringify(r));
  });

  it("CA5 the member handles read fails → the circles kept, the member list said incomplete", async () => {
    const r = await tool(circleWorld({ handles: true }));
    assert.equal(r.circles.length, 2, JSON.stringify(r));
    assert.deepEqual(r.circles.flatMap((c) => c.memberHandles), []);
    assert.match(r.info ?? "", /member list/i, JSON.stringify(r));
  });

  it("CA6 the client throws → circle membership could not be checked", async () => {
    const throwing = { from: () => { throw new Error("db down"); } };
    const r = (await executeCompassTool(throwing as any, VIEWER, profile, "get_circle_activity", {})) as Tool;
    assert.notEqual(r.info, NOT_IN_ANY, JSON.stringify(r));
    assert.match(r.info ?? "", /could not be checked/i);
  });

  it("CA7 the prompt says an unread circles, bookings or stamps read; a healthy context adds no line", async () => {
    const healthy = await buildStructuredCompassContext(circleWorld().client as any, profile);
    assert.equal(healthy.unread, undefined);
    assert.ok(!formatStructuredContextLines(healthy).some((l) => /could not be read/i.test(l)));

    const ctx = await buildStructuredCompassContext(compassWorld({ failTables: ["circles", "rent_buddy_bookings", "user_stamps"] }).client as any, profile);
    const lines = formatStructuredContextLines(ctx).join("\n");
    assert.match(lines, /circle membership could not be read/i, lines);
    assert.match(lines, /buddy bookings could not be read/i, lines);
    assert.match(lines, /passport history could not be read/i, lines);
  });

  it("CA8 the booking and stamp reads: a failed read is marked, never an empty section alone", async () => {
    const b = await buildStructuredCompassContext(compassWorld({ failTables: ["rent_buddy_bookings"] }).client as any, profile);
    assert.deepEqual(b.activeBookings, []);
    assert.deepEqual(b.unread, { bookings: true });
    const s = await buildStructuredCompassContext(compassWorld({ failTables: ["user_stamps"] }).client as any, profile);
    assert.deepEqual(s.recentStamps, []);
    assert.deepEqual(s.unread, { stamps: true });
  });

  it("CAc CONTROL: a viewer in no circles, every read healthy → 'The user is not in any circles.' and no marker", async () => {
    const w = compassWorld();
    const r = await tool(w);
    assert.deepEqual(r, { circles: [], info: NOT_IN_ANY });
    const ctx = await buildStructuredCompassContext(compassWorld().client as any, profile);
    assert.deepEqual(ctx, { circles: [], activeBookings: [], recentStamps: [] });
  });
});
