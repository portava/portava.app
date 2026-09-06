/**
 * StampAwardEngine source-state guard vs. ENUM TRUTH.
 *
 * `validateSource` rejects an award whose triggering trip / post / event is in
 * an ineligible state. It does that with three JS `Set`s of status literals —
 * so unlike a PostgREST filter, a wrong literal raises nothing at all. It just
 * never matches, and the guard waves the source through.
 *
 * Three of the ten literals could never match any row:
 *
 *   INVALID_TRIP_STATUSES  had "deleted"  — trip_status has no such label
 *   INVALID_EVENT_STATUSES had "deleted"  — event_state has no such label
 *   INVALID_POST_STATUSES  had "draft", "removed", "revoked" — post_status is
 *                          active | hidden | reported | deleted, so only
 *                          "deleted" of its four literals was ever real
 *
 * and the sets simultaneously omitted states that ARE ineligible: `archived`
 * trips and events, and `hidden` / `reported` posts (routes/posts.ts:1100
 * already states that a live post is `status = "active"` and that deleted,
 * hidden and reported posts are not).
 *
 * The contract enforced here is stronger than "no fictional literal": the
 * eligible and ineligible sets must PARTITION the enum, so a future migration
 * that adds a label cannot leave it silently unclassified.
 *
 * Enum labels are parsed from baseline/20260819_baseline_structure.sql — never
 * from src/lib/database.types.ts, which is generated and has been wrong.
 *
 * Run: node --import tsx/esm --test src/test/stampSourceStatusTruth.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { awardStamp } from "../services/passport/StampAwardEngine.js";
import {
  INVALID_TRIP_STATUSES,
  INVALID_POST_STATUSES,
  INVALID_EVENT_STATUSES,
} from "../services/passport/StampAwardEngine.js";
import { makeEngineFake } from "./stampEngineFake.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(__dir, "../../baseline/20260819_baseline_structure.sql");

/** `CREATE TYPE public.<name> AS ENUM ( 'a', 'b', … );` → the label list. */
function enumLabels(name: string): string[] {
  const sql = readFileSync(BASELINE, "utf8");
  const re = new RegExp(`CREATE TYPE public\\.${name} AS ENUM \\(([^)]*)\\);`, "m");
  const m = re.exec(sql);
  assert.ok(m, `enum public.${name} not found in the baseline dump`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const TRIP_STATUS  = enumLabels("trip_status");
const POST_STATUS  = enumLabels("post_status");
const EVENT_STATE  = enumLabels("event_state");

/**
 * The award-ELIGIBLE half of each enum. Together with the engine's INVALID_*
 * set this must cover the enum exactly — that is the whole point of the test.
 */
const ELIGIBLE_TRIP_STATUSES  = ["planning", "upcoming", "active", "completed"];
const ELIGIBLE_POST_STATUSES  = ["active"];
const ELIGIBLE_EVENT_STATES   = ["open", "full", "waitlist", "started", "completed"];

const CASES = [
  { label: "trip_status", enumLabelsList: TRIP_STATUS,  invalid: INVALID_TRIP_STATUSES,  eligible: ELIGIBLE_TRIP_STATUSES },
  { label: "post_status", enumLabelsList: POST_STATUS,  invalid: INVALID_POST_STATUSES,  eligible: ELIGIBLE_POST_STATUSES },
  { label: "event_state", enumLabelsList: EVENT_STATE,  invalid: INVALID_EVENT_STATUSES, eligible: ELIGIBLE_EVENT_STATES },
] as const;

describe("source-state guard literals are real enum labels", () => {
  it("the baseline parse found all three enums (guard against a vacuous run)", () => {
    assert.ok(TRIP_STATUS.length >= 6, `trip_status parsed as ${TRIP_STATUS.join("|")}`);
    assert.ok(POST_STATUS.length >= 4, `post_status parsed as ${POST_STATUS.join("|")}`);
    assert.ok(EVENT_STATE.length >= 8, `event_state parsed as ${EVENT_STATE.join("|")}`);
  });

  for (const c of CASES) {
    it(`every INVALID literal for ${c.label} is a label the column can hold`, () => {
      const fictional = [...c.invalid].filter((s) => !c.enumLabelsList.includes(s));
      assert.deepEqual(
        fictional, [],
        `${c.label}: these literals can never match a row, so the guard is dead ` +
        `for them — ${fictional.join(", ")}. Real labels: ${c.enumLabelsList.join(" | ")}`,
      );
    });

    it(`eligible + invalid partition ${c.label} exactly`, () => {
      const classified = [...c.eligible, ...c.invalid].sort();
      assert.deepEqual(
        classified, [...c.enumLabelsList].sort(),
        `${c.label}: every label must be classified as award-eligible or not. ` +
        "A new label added by a migration lands here first, not in production.",
      );
      const overlap = c.eligible.filter((s) => c.invalid.has(s));
      assert.deepEqual(overlap, [], `${c.label}: a label is both eligible and invalid`);
    });
  }
});

// ── The guard actually fires ─────────────────────────────────────────────────

const USER = "aaaaaaaa-0000-0000-0000-000000000001";
const SRC  = "bbbbbbbb-0000-0000-0000-000000000001";

async function awardFrom(sourceType: "trips" | "posts" | "events", row: Record<string, unknown> | null) {
  const fake = makeEngineFake({ sources: { [sourceType]: row } as any });
  const result = await awardStamp(fake.client, {
    userId: USER, definitionSlug: "first_post", sourceType, sourceId: SRC,
  });
  return { result, fake };
}

describe("validateSource rejects every ineligible source state", () => {
  it("rejects every INVALID trip status and accepts every eligible one", async () => {
    for (const status of INVALID_TRIP_STATUSES) {
      const { result, fake } = await awardFrom("trips", { status });
      assert.equal(result.awarded, false, `trip status '${status}' must not award`);
      assert.equal(result.reason, `source_invalid_status:${status}`);
      assert.deepEqual(fake.inserted, [], `trip status '${status}' wrote rows`);
    }
    for (const status of ELIGIBLE_TRIP_STATUSES) {
      const { result } = await awardFrom("trips", { status });
      assert.equal(result.awarded, true, `trip status '${status}' must award, got "${result.reason}"`);
    }
  });

  it("rejects every INVALID post status and accepts every eligible one", async () => {
    for (const status of INVALID_POST_STATUSES) {
      const { result, fake } = await awardFrom("posts", { status });
      assert.equal(result.awarded, false, `post status '${status}' must not award`);
      assert.equal(result.reason, `source_invalid_status:${status}`);
      assert.deepEqual(fake.inserted, [], `post status '${status}' wrote rows`);
    }
    for (const status of ELIGIBLE_POST_STATUSES) {
      const { result } = await awardFrom("posts", { status });
      assert.equal(result.awarded, true, `post status '${status}' must award, got "${result.reason}"`);
    }
  });

  it("rejects every INVALID event state and accepts every eligible one", async () => {
    for (const state of INVALID_EVENT_STATUSES) {
      const { result, fake } = await awardFrom("events", { state });
      assert.equal(result.awarded, false, `event state '${state}' must not award`);
      assert.equal(result.reason, `source_invalid_status:${state}`);
      assert.deepEqual(fake.inserted, [], `event state '${state}' wrote rows`);
    }
    for (const state of ELIGIBLE_EVENT_STATES) {
      const { result } = await awardFrom("events", { state });
      assert.equal(result.awarded, true, `event state '${state}' must award, got "${result.reason}"`);
    }
  });

  it("a missing source row is rejected (source_not_found)", async () => {
    const { result } = await awardFrom("posts", null);
    assert.equal(result.awarded, false);
    assert.equal(result.reason, "source_not_found");
  });
});
