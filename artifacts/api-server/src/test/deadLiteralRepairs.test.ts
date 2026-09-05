/**
 * BEHAVIOURAL proof for the dead-literal repairs — driven by a double that
 * fails the way Postgres fails.
 *
 * WHY THIS EXISTS SEPARATELY FROM enumLiteralGuard.test.ts
 * --------------------------------------------------------
 * That contract is STATIC: it proves no literal in `src/` names a value its
 * column cannot hold, and it goes red on any of the thirty-two repairs being
 * reverted. What it cannot show is the CONSEQUENCE — that the feature was
 * empty, and is not any more.
 *
 * The reason no existing suite could show that is `helpers/enumAwareSupabase`'s
 * whole subject: the repo's fake clients cannot return 22P02, so the dead
 * literal simply filtered nothing and the fixture answered as if the query had
 * worked. Mutating the production literal back with an ordinary double leaves
 * these suites GREEN — that was measured, on all four groups below, before this
 * file existed. With a double that validates literals, each one goes RED for
 * the reason production was broken: the read fails whole and the surface serves
 * nothing.
 *
 * Each test therefore asserts BOTH halves — the repaired predicate returns the
 * row, AND the row is excluded when it should be — so a "fix" that simply
 * dropped the filter would not pass either.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnumAwareClient, vocabulary } from "./helpers/enumAwareSupabase.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { findDuplicateGems, findDuplicateEvents } from "../lib/inputAssistance/duplicateDetection.js";
import { getDuplicateCandidates } from "../services/hiddenGems/HiddenGemModerationService.js";

const HOST = "11111111-1111-1111-1111-111111111111";
const SOON = new Date(Date.now() + 6 * 3600_000).toISOString();

function event(id: string, state: string, title = "Beach Cleanup"): Record<string, any> {
  return {
    id, title, description: "Bring gloves", city: "Da Nang", country: "VN",
    starts_at: SOON, category: "community", host_id: HOST,
    state, visibility: "public",
  };
}

function gem(id: string, status: string, name = "Hidden Waterfall"): Record<string, any> {
  return {
    id, name, description: "Down the trail", city: "Da Nang", country: "VN",
    submitted_by: HOST, category: "nature", created_at: "2026-01-01T00:00:00Z",
    latitude: 16.05, longitude: 108.24, sensitivity_level: null, report_count: 0,
    status,
  };
}

describe("the double itself is not vacuous", () => {
  it("raises 22P02 for an unknown enum label and fails the WHOLE read", async () => {
    const sc = makeEnumAwareClient({ events: [event("e1", "open")] });
    const { data, error } = await sc.from("events").select("id").neq("state", "banned");
    assert.equal(data, null, "an unknown enum literal must not return rows");
    assert.equal((error as any)?.code, "22P02");
    // supabase-js RETURNS this rather than throwing — which is exactly why a
    // surrounding try/catch never fired on any of the thirty-two sites.
    assert.match((error as any)?.message ?? "", /invalid input value for enum event_state/);
  });

  it("stays quiet for an unknown CHECK value — no error, no rows", async () => {
    const sc = makeEnumAwareClient({
      stamp_generation_queue: [{ catalog_id: "c1", status: "generating" }],
    });
    const { data, error } = await sc
      .from("stamp_generation_queue").select("catalog_id").in("status", ["processing"]);
    assert.equal(error, null, "a CHECK column raises nothing — that is why it is quieter");
    assert.deepEqual(data, [], "…and matches nothing, forever");
  });

  it("accepts every real label, so a passing test below is not passing by accident", () => {
    for (const [key, label] of [
      ["events.state", "open"],
      ["trips.status", "active"],
      ["hidden_gems.status", "active"],
      ["posts.status", "active"],
    ] as const) {
      assert.ok(vocabulary().values.get(key)?.has(label), `${key} must permit ${label}`);
    }
  });
});

describe("Compass chat can return an event again (CompassTools.toolSearchEvents)", () => {
  it("serves an open event and still excludes draft / cancelled / archived", async () => {
    const sc = makeEnumAwareClient({
      events: [
        event("e-open", "open"),
        event("e-draft", "draft", "Beach Cleanup Draft"),
        event("e-cancelled", "cancelled", "Beach Cleanup Cancelled"),
        event("e-archived", "archived", "Beach Cleanup Archived"),
      ],
    });
    const res: any = await executeCompassTool(sc as any, HOST, null, "search_events", {
      query: "Beach Cleanup",
    });
    const ids = (res.candidates as any[]).map((c) => c.id);
    // Before the repair the predicate was `.neq("state","deleted")` /
    // `.neq("state","banned")` — labels event_state does not have — so this
    // read died 22P02 and the handler returned
    // "Event search unavailable right now." for every query ever made.
    assert.deepEqual(ids, ["e-open"], `expected only the open event, got ${JSON.stringify(ids)}`);
  });
});

describe("hidden-gem duplicate detection fires again", () => {
  it("findDuplicateGems matches an active gem and ignores pending/hidden/merged", async () => {
    const sc = makeEnumAwareClient({
      hidden_gems: [
        gem("g-active", "active"),
        gem("g-pending", "pending"),
        gem("g-hidden", "hidden"),
        gem("g-merged", "merged"),
      ],
    });
    const matches = await findDuplicateGems(sc as any, {
      name: "Hidden Waterfall", city: "Da Nang", country: "VN",
      lat: 16.05, lng: 108.24, category: "nature",
    });
    // Before the repair the filter was `['approved','active']`; "approved" is
    // not a hidden_gem_status label, so the read died 22P02 and TWO swallows
    // stacked — a traveller submitting an identical gem at identical
    // coordinates was never shown "this may already exist".
    assert.ok(matches.length > 0, "an identical active gem must be surfaced as a duplicate");
    assert.deepEqual([...new Set(matches.map((m) => m.entity.id))], ["g-active"]);
  });

  it("getDuplicateCandidates no longer 500s the admin queue", async () => {
    const sc = makeEnumAwareClient({
      hidden_gems: [gem("g-pending", "pending"), gem("g-active", "active")],
    });
    // This one THREW on its error rather than swallowing it, so
    // GET /admin/hidden-gems/duplicate-candidates returned db_error on every
    // single call. The assertion is that it resolves at all.
    const out = await getDuplicateCandidates(sc as any);
    assert.ok(Array.isArray(out), "the admin duplicate queue must resolve, not throw");
    assert.ok(out.length > 0, "a pending gem identical to an active one is a candidate");
  });

  it("findDuplicateEvents reads through .not(col,'in',…), the form the scanners missed", async () => {
    const sc = makeEnumAwareClient({
      events: [event("e-open", "open"), event("e-cancelled", "cancelled")],
    });
    const matches = await findDuplicateEvents(sc as any, {
      name: "Beach Cleanup", city: "Da Nang", country: "VN",
      lat: null, lng: null, category: "community", startsAt: SOON,
    });
    // The enum cast happens for `.not(col,'in',…)` exactly as for `.neq`, so
    // `(cancelled,deleted,banned)` killed this read too — and no test imported
    // findDuplicateEvents at all.
    assert.deepEqual([...new Set(matches.map((m) => m.entity.id))], ["e-open"]);
  });
});
