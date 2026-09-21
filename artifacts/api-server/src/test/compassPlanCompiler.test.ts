/**
 * census-compass CM-02 / census-media MD107 — "convert a Trail / Trip recap /
 * itinerary into an executable Compass plan".
 *
 * Before: `buildDoThisExperiencePlan` produced an ORDERED list of stops from
 * an event or trip experience — no times, and no Trail source. Now
 * `compileExperiencePlan` (services/media/MediaActionResolver) reads a Trail
 * too, and schedules the stops onto a day with start and end times, stating
 * that transit is a default, not a route, and that feasibility was not
 * verified; `compile_plan_from_experience` is the Compass tool over it. It
 * proposes and never writes.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 stops scheduled without transit (all back to back)         → red
 *   M2 an unpublished trail compiled                               → red
 *   M3 a non-place member (a post) admitted as a stop              → red
 *   M4 the tool accepts a malformed day                            → red
 *   M5 the trails probe removed (columns named on an absent table)  → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassPlanCompiler.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compileExperiencePlan,
  PLAN_DEFAULT_DWELL_MINUTES,
  PLAN_DEFAULT_TRANSIT_MINUTES,
  PLAN_DEFAULT_START_HOUR,
} from "../services/media/MediaActionResolver.js";
import { toolCompilePlanFromExperience, COMPASS_TOOL_NAMES } from "../compass/CompassTools.js";

const VIEWER = "aa000000-0000-4000-8000-000000000001";
const TRAIL = "77777777-7777-4777-8777-777777777777";
const viewer = { viewerId: VIEWER, isAdmin: false, blockedIds: new Set<string>(), followingIds: new Set<string>() } as any;

function db(state: { lifecycle?: string; members?: Array<Record<string, unknown>>; unreadable?: string[]; absent?: string[] }) {
  const tables: Record<string, any[]> = {
    trails: [{ id: TRAIL, title: "Old Town Food Walk", lifecycle_status: state.lifecycle ?? "published" }],
    content_trails: state.members ?? [
      { trail_id: TRAIL, source_type: "place", source_id: "place-a", content_state: "published", created_at: "2026-01-01T00:00:00Z" },
      { trail_id: TRAIL, source_type: "post", source_id: "post-x", content_state: "published", created_at: "2026-01-02T00:00:00Z" },
      { trail_id: TRAIL, source_type: "place", source_id: "place-b", content_state: "published", created_at: "2026-01-03T00:00:00Z" },
      { trail_id: TRAIL, source_type: "place", source_id: "place-a", content_state: "published", created_at: "2026-01-04T00:00:00Z" },
    ],
    trip_members: [], trips: [],
  };
  const unreadable = new Set(state.unreadable ?? []);
  // `absent` tables answer as PostgREST does for a table the schema lacks
  // (PGRST205): the shape production gives while 2910 is unapplied there.
  const absent = new Set(state.absent ?? []);
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      let rows = [...(tables[table] ?? [])];
      const err = absent.has(table)
        ? { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` }
        : unreadable.has(table) ? { message: `${table} unreadable` } : null;
      const b: any = {
        select() { return b; },
        eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return b; },
        in() { return b; }, order() { return b; }, limit() { return b; }, is() { return b; },
        maybeSingle() { return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }); },
        then(res: any) { res(err ? { data: null, error: err } : { data: rows, error: null }); },
      };
      return b;
    },
  } as any;
}

describe("compileExperiencePlan — a Trail becomes timed stops", () => {
  it("place members in membership order, de-duplicated, non-place members skipped, scheduled with dwell and default transit", async () => {
    const r = await compileExperiencePlan(db({}), viewer, { kind: "trail", id: TRAIL }, { day: "2026-10-03", nowMs: Date.now() });
    assert.ok(r.ok, JSON.stringify(r));
    const plan = r.plan;
    assert.equal(plan.source.title, "Old Town Food Walk");
    assert.deepEqual(plan.stops.map((s) => s.sourceId), ["place-a", "place-b"]);
    assert.deepEqual(plan.stops.map((s) => s.order), [1, 2]);
    assert.equal(plan.stops[0]!.startsAt, `2026-10-03T${String(PLAN_DEFAULT_START_HOUR).padStart(2, "0")}:00:00.000Z`);
    assert.equal(plan.stops[0]!.transitMinutesBefore, 0);
    assert.equal(plan.stops[0]!.transitBasis, "none");
    const gap = (Date.parse(plan.stops[1]!.startsAt) - Date.parse(plan.stops[0]!.endsAt)) / 60_000;
    assert.equal(gap, PLAN_DEFAULT_TRANSIT_MINUTES);
    assert.equal(plan.stops[1]!.transitBasis, "default");
    assert.equal((Date.parse(plan.stops[1]!.endsAt) - Date.parse(plan.stops[1]!.startsAt)) / 60_000, PLAN_DEFAULT_DWELL_MINUTES);
    assert.equal(plan.feasibility, "not_verified");
    assert.equal(plan.targetEndpoint, "/api/trips/:tripId/plan/items");
  });

  it("a caller's start hour is honoured and clamped", async () => {
    const r = await compileExperiencePlan(db({}), viewer, { kind: "trail", id: TRAIL }, { day: "2026-10-03", startHour: 30, nowMs: Date.now() });
    assert.ok(r.ok);
    assert.equal(r.plan.stops[0]!.startsAt, "2026-10-03T23:00:00.000Z");
  });

  it("an unpublished trail is not eligible; an unknown one is unknown; an unreadable store is said to be unreadable", async () => {
    assert.deepEqual(await compileExperiencePlan(db({ lifecycle: "draft" }), viewer, { kind: "trail", id: TRAIL }, { day: "2026-10-03", nowMs: 0 }), { ok: false, reason: "not_eligible" });
    assert.deepEqual(await compileExperiencePlan(db({}), viewer, { kind: "trail", id: "nope" }, { day: "2026-10-03", nowMs: 0 }), { ok: false, reason: "unknown_source" });
    assert.deepEqual(await compileExperiencePlan(db({ unreadable: ["content_trails"] }), viewer, { kind: "trail", id: TRAIL }, { day: "2026-10-03", nowMs: 0 }), { ok: false, reason: "source_unreadable" });
    assert.deepEqual(await compileExperiencePlan(db({ members: [] }), viewer, { kind: "trail", id: TRAIL }, { day: "2026-10-03", nowMs: 0 }), { ok: false, reason: "no_stops" });
  });

  it("an absent trails schema (production before 2910) is refused source_unavailable by a probe, before content_trails is named", async () => {
    const d = db({ absent: ["trails"] });
    assert.deepEqual(await compileExperiencePlan(d, viewer, { kind: "trail", id: TRAIL }, { day: "2026-10-03", nowMs: 0 }), { ok: false, reason: "source_unavailable" });
    assert.deepEqual(d.reads, ["trails"], "one probe read and nothing else — content_trails must not be named on an absent schema");
  });
});

describe("compile_plan_from_experience — the tool", () => {
  it("is declared", () => {
    assert.ok(COMPASS_TOOL_NAMES.has("compile_plan_from_experience"));
  });

  it("refuses a malformed request before reading anything", async () => {
    const never = { from() { throw new Error("must not be read"); } } as any;
    assert.match(String((await toolCompilePlanFromExperience(never, VIEWER, { sourceKind: "trail", sourceId: TRAIL, day: "tomorrow" }) as any).error), /YYYY-MM-DD/);
    assert.match(String((await toolCompilePlanFromExperience(never, VIEWER, { sourceKind: "recap", sourceId: TRAIL, day: "2026-10-03" }) as any).error), /sourceKind/);
    assert.match(String((await toolCompilePlanFromExperience(never, VIEWER, { sourceKind: "trail", day: "2026-10-03" }) as any).error), /sourceId/);
  });
});
