/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-95): the Compass circle reads never state
 * a capped read as the whole list.
 *
 * `buildStructuredCompassContext` read the viewer's memberships as an UNORDERED `.limit(10)`, filtered
 * `accepted` after the limit, and kept `allCircles.slice(0, 5)` with nothing marking the truncation, so
 * `get_circle_activity` (and /compass/ask's prompt) could say "The user is not in any circles." or
 * serve five of six circles as the list (§110.1 BK3; D-W11X2-91's "by design" ruling corrected). The
 * reads are now ordered, read one past their cap, and a longer list is said — the circles, the member
 * read (200) and the handles shown per circle (8). `get_group_recommendation`'s circle reads (25) and
 * member read (100) had the same shape: a circle past the cap was "not a member of a circle by that
 * name", and a member list past it was a recommendation over part of the group.
 *
 *   V12-CC0  CONTROL: one accepted membership → the circle is listed                     (verifier probe)
 *   V12-CC1  10 other memberships read before the one named → never "The user is not in any circles."
 *   V12-CC2  the viewer is in 6 circles → not 5 circles served as the whole list
 *   CB1      the reads are ordered and read one past the cap
 *   CB2      11 owned circles → 5 shown, said not to be all of them
 *   CB3      memberships past the cap, none of whose owners has a named circle → never "not in any circles"
 *   CB4      the member read past its cap → the member lists said shortened
 *   CB5      a circle with 9 visible members → 8 handles, said shortened
 *   CB6      the prompt says a shortened circle list and shortened member lists
 *   CB7      get_group_recommendation: 26 memberships, the named circle not among those read → never "not a member …"
 *   CB8      get_group_recommendation: 101 circle members → no recommendation over part of the group
 *   CBc      CONTROL: 5 circles, 2 members each, everything read → no info, no marker, no prompt line
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import { buildStructuredCompassContext, formatStructuredContextLines } from "../compass/CompassStructuredContext.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER, type Call } from "./helpers/compassReadWorld.js";

const profile = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const owner = (i: number) => `c${String(i).padStart(7, "0")}-0000-4000-a000-000000000000`;
const member = (i: number) => `d${String(i).padStart(7, "0")}-0000-4000-a000-000000000000`;
const limitOf = (calls: Call[]) => { const c = calls.find(([k]) => k === "limit"); return c ? Number(c[1][0]) : Infinity; };
const inOf = (calls: Call[], col: string) => (calls.find(([k, a]) => k === "in" && a[0] === col)?.[1][1] ?? null) as string[] | null;
const eqCall = (calls: Call[], col: string) => calls.some(([k, a]) => k === "eq" && a[0] === col);
const NOT_IN_ANY = "The user is not in any circles.";

/** The verifier's world: memberships (other_id = viewer) in table order; a named circle per joined owner. */
function world(memberships: Array<{ owner: string; status: string }>, opts: { owned?: number; members?: (owners: string[]) => any[]; circlesFor?: (o: string) => boolean } = {}) {
  const seen: Record<string, Call[][]> = {};
  const w = compassWorld({
    answer: (t, calls) => {
      (seen[t] ??= []).push(calls);
      if (t === "circle_memberships" && eqCall(calls, "other_id")) {
        return { data: memberships.slice(0, limitOf(calls)).map((m) => ({ user_id: m.owner, other_id: VIEWER, status: m.status })), error: null };
      }
      if (t === "circles" && eqCall(calls, "owner_id")) return { data: Array.from({ length: opts.owned ?? 0 }, (_, i) => ({ id: `own-${String(i).padStart(2, "0")}`, name: `Own ${i}`, owner_id: VIEWER })).slice(0, limitOf(calls)), error: null };
      const owners = t === "circles" ? inOf(calls, "owner_id") : null;
      if (owners) return { data: owners.filter((o) => opts.circlesFor?.(o) ?? true).slice(0, limitOf(calls)).map((o, i) => ({ id: `circle-${i}`, name: `Circle ${o.slice(0, 8)}`, owner_id: o })), error: null };
      const byOwner = t === "circle_memberships" ? (calls.find(([k, a]) => k === "eq" && a[0] === "user_id")?.[1][1] as string | undefined) : undefined;
      if (byOwner) return { data: (opts.members?.([byOwner]) ?? []).slice(0, limitOf(calls)), error: null };
      const memberOwners = t === "circle_memberships" ? inOf(calls, "user_id") : null;
      if (memberOwners) return { data: (opts.members?.(memberOwners) ?? []).slice(0, limitOf(calls)), error: null };
      const ids = t === "profiles" ? inOf(calls, "id") : null;
      if (ids) return { data: ids.map((id) => ({ id, handle: `h${id.slice(1, 8)}` })), error: null };
      return undefined;
    },
  });
  return Object.assign(w, { seen });
}
type Tool = { circles: any[]; info?: string };
const tool = async (w: ReturnType<typeof compassWorld>) => (await executeCompassTool(w.client as any, VIEWER, profile, "get_circle_activity", {})) as Tool;

describe("get_circle_activity over its bounded circle reads (§110, D-W11X2-95)", () => {
  it("V12-CC0 CONTROL: one accepted membership → the circle is listed", async () => {
    const r = await tool(world([{ owner: owner(1), status: "accepted" }]));
    assert.equal(r.circles.length, 1, JSON.stringify(r));
  });
  it("V12-CC1 ten pending invitations read before the accepted membership → must not be 'The user is not in any circles.'", async () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => ({ owner: owner(100 + i), status: "pending" })), { owner: owner(1), status: "accepted" }];
    const r = await tool(world(rows));
    assert.notEqual(r.info, NOT_IN_ANY, `a partial read was stated as a fact: ${JSON.stringify(r)}`);
  });
  it("V12-CC2 the viewer is in 6 circles → not 5 circles served as the whole list", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ owner: owner(i + 1), status: "accepted" }));
    const r = await tool(world(rows));
    assert.ok(r.circles.length === 6 || typeof r.info === "string", `6 circles, ${r.circles.length} served with no incomplete line: ${JSON.stringify(r)}`);
  });

  it("CB1 the reads are ordered and read one past the cap", async () => {
    const w = world([{ owner: owner(1), status: "pending" }], { owned: 1, members: (os) => os.map((o) => ({ user_id: o, other_id: member(1) })) });
    await tool(w);
    const orderedLimit = (calls: Call[], cap: number) => calls.some(([k]) => k === "order") && limitOf(calls) === cap + 1;
    const memberships = w.seen.circle_memberships ?? [];
    assert.ok(memberships.some((c) => eqCall(c, "other_id") && orderedLimit(c, 10)), "the viewer's memberships read");
    assert.ok(memberships.some((c) => inOf(c, "user_id") && orderedLimit(c, 200)), "the members read");
    const circles = w.seen.circles ?? [];
    assert.ok(circles.some((c) => eqCall(c, "owner_id") && orderedLimit(c, 10)), "the owned circles read");
    assert.ok(circles.some((c) => inOf(c, "owner_id") && orderedLimit(c, 10)), "the joined circles read");
  });
  it("CB2 11 owned circles → 5 shown, said not to be all of them", async () => {
    const r = await tool(world([], { owned: 11 }));
    assert.equal(r.circles.length, 5);
    assert.match(String(r.info), /not (the whole list|all of)/i, JSON.stringify(r));
  });
  it("CB3 memberships past the cap, none of whose owners has a named circle → never 'not in any circles'", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ owner: owner(i + 1), status: "pending" }));
    const r = await tool(world(rows, { circlesFor: () => false }));
    assert.deepEqual(r.circles, []);
    assert.notEqual(r.info, NOT_IN_ANY, JSON.stringify(r));
    assert.match(String(r.info), /could not (be )?check/i, JSON.stringify(r));
  });
  it("CB4 the member read past its cap → the member lists said shortened", async () => {
    const r = await tool(world([], { owned: 1, members: (os) => Array.from({ length: 201 }, (_, i) => ({ user_id: os[0], other_id: member(i) })) }));
    assert.equal(r.circles.length, 1);
    assert.match(String(r.info), /member lists/i, JSON.stringify(r));
  });
  it("CB5 a circle with 9 visible members → 8 handles, said shortened", async () => {
    const r = await tool(world([], { owned: 1, members: (os) => Array.from({ length: 9 }, (_, i) => ({ user_id: os[0], other_id: member(i) })) }));
    assert.equal(r.circles[0].memberHandles.length, 8);
    assert.match(String(r.info), /member lists/i, JSON.stringify(r));
  });
  it("CB6 the prompt says a shortened circle list and shortened member lists", async () => {
    const ctx = await buildStructuredCompassContext(world([], { owned: 11, members: (os) => Array.from({ length: 9 }, (_, i) => ({ user_id: os[0], other_id: member(i) })) }).client as any, profile);
    const lines = formatStructuredContextLines(ctx);
    assert.ok(lines.some((l) => /not all of the user's circles/i.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /member lists are shortened/i.test(l)), lines.join("\n"));
  });
  it("CBc CONTROL: 5 circles, 2 members each, everything read → no info, no marker, no prompt line", async () => {
    const w = world([], { owned: 5, members: (os) => os.flatMap((o) => [{ user_id: o, other_id: member(1) }, { user_id: o, other_id: member(2) }]) });
    const r = await tool(w);
    assert.equal(r.circles.length, 5);
    assert.equal(r.info, undefined, JSON.stringify(r));
    const ctx = await buildStructuredCompassContext(w.client as any, profile);
    assert.equal(ctx.unread, undefined, JSON.stringify(ctx.unread));
    assert.equal(formatStructuredContextLines(ctx).filter((l) => !l.startsWith("•") && l !== "Circles (trusted groups):").length, 0);
  });
});

describe("get_group_recommendation over its bounded circle reads (§110, D-W11X2-95)", () => {
  const run = async (w: ReturnType<typeof compassWorld>, args: Record<string, unknown>) => (await executeCompassTool(w.client as any, VIEWER, profile, "get_group_recommendation", args)) as Record<string, any>;
  it("CB7 26 memberships, the named circle not among those read → never 'not a member of a circle by that name'", async () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({ owner: owner(i + 1), status: "pending" }));
    const r = await run(world(rows), { circleName: "Somewhere past the cap" });
    assert.notEqual(r.info, "The user is not a member of a circle by that name.", JSON.stringify(r));
    assert.match(String(r.info), /could not be checked|could not check/i, JSON.stringify(r));
  });
  it("CB8 101 circle members → no recommendation over part of the group", async () => {
    const r = await run(world([], { owned: 1, members: (os) => Array.from({ length: 101 }, (_, i) => ({ user_id: os[0], other_id: member(i) })) }), { circleName: "Own 0" });
    assert.deepEqual(r.candidates, [], JSON.stringify(r));
    assert.match(String(r.info), /part of the group/i, JSON.stringify(r));
  });
});
