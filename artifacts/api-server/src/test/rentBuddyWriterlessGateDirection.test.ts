/**
 * rentBuddyWriterlessGateDirection — what the Rent-a-Buddy gates whose columns
 * have NO writer actually DO.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * Several `rent_buddy_profiles` columns are read as filters or as booking /
 * eligibility gates and are written by nothing at all — not by a route, not by
 * a migration, not by a trigger, not by `rb_adjust_buddy_counter` (which is
 * hard-restricted to completed_count / cancel_count / no_show_count). Every row
 * therefore carries the DDL default forever, and each such gate silently
 * collapses to a constant.
 *
 * WHICH constant is the whole question. A writerless gate that always DENIES is
 * a dormant capability — annoying, safe. One that always ALLOWS is a control
 * that reads as enforcement and enforces nothing. This suite pins the direction
 * of each, so that:
 *
 *   • nobody "fixes" an always-deny gate by deleting it, believing it inert;
 *   • an always-allow gate cannot be cited as protection it does not provide;
 *   • if a producer is ever added, the test that changes tells you exactly which
 *     behaviour moved.
 *
 * ── FIXTURES COME FROM THE DDL, NOT FROM THIS FILE ──────────────────────────
 * Every boolean/integer default below is parsed out of
 * baseline/20260819_baseline_structure.sql at test time. Hard-coding `false`
 * here would make the suite agree with itself rather than with the database: if
 * someone changed `group_approved` to `DEFAULT true` the gate would flip from
 * always-deny to always-allow and a hard-coded fixture would keep passing.
 *
 * Scope note: this is the pure-function half, exercised through
 * CompatibilityScoreService (no DB, no HTTP). The route-level twins of these
 * gates — POST /rent-a-buddy/packages/:packageId/book's `group_approved` check
 * and POST /rent-a-buddy/bookings' `new_buddy_*` branch — are asserted
 * structurally at the end, against the same DDL defaults.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyWriterlessGateDirection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateCompatibilityScore,
  type BuddyScoringData,
  type MatchPreferences,
} from "../services/rentBuddy/CompatibilityScoreService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "../..");
const BASELINE = readFileSync(resolve(API, "baseline/20260819_baseline_structure.sql"), "utf8");
const SRC = resolve(HERE, "..");

// ── DDL introspection ─────────────────────────────────────────────────────────

const PROFILES_DDL: string = (() => {
  const m = BASELINE.match(/CREATE TABLE public\.rent_buddy_profiles \(([\s\S]*?)\n\);/);
  assert.ok(m, "rent_buddy_profiles DDL not found in the baseline — this suite would assert nothing");
  return m[1];
})();

/** The column's DEFAULT, as a JS value. Throws if the column is missing. */
function ddlDefault(column: string): boolean | number | null {
  const line = PROFILES_DDL.split("\n").find((l) => new RegExp(`^\\s*${column}\\s`).test(l));
  assert.ok(line, `rent_buddy_profiles.${column} is not in the baseline DDL — the gate it feeds may have been dropped`);
  const m = line!.match(/DEFAULT\s+([^\s,]+)/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return null;
}

function ddlBool(column: string): boolean {
  const v = ddlDefault(column);
  assert.equal(typeof v, "boolean", `expected rent_buddy_profiles.${column} to carry a boolean DEFAULT, got ${String(v)}`);
  return v as boolean;
}

// ── Writer detection ──────────────────────────────────────────────────────────
// A column counts as WRITTEN if it appears as an object-literal key, a patch
// assignment, or a dynamic key in runtime code, or on the left of an assignment
// in SQL. src/scripts/ is excluded: the dev seeder is not a production producer,
// and treating it as one is exactly how these columns stayed invisible.

function readTree(dir: string, match: RegExp, skip: RegExp): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        walk(p);
      } else if (match.test(e.name) && !skip.test(p)) {
        out.push([p.slice(API.length + 1), readFileSync(p, "utf8")]);
      }
    }
  };
  walk(dir);
  return out;
}

const RUNTIME_TS = readTree(SRC, /\.ts$/, /\/test\/|\/scripts\/|database\.types\.ts$|\.d\.ts$/);
const ALL_SQL = readTree(resolve(SRC, "migrations"), /\.sql$/, /^$/)
  .map(([, s]) => s)
  .join("\n") + "\n" + BASELINE;

function hasWriter(column: string): boolean {
  const pats = [
    new RegExp(`(^|[{,\\s])${column}\\s*:`, "m"),               // { column: value }
    new RegExp(`\\.${column}\\s*=[^=]`),                         // patch.column = value
    new RegExp(`\\[\\s*["'\`]${column}["'\`]\\s*\\]\\s*=`),      // patch["column"] = value
    new RegExp(`["'\`]${column}["'\`]\\s*\\|`),                  // a CounterColumn-style union
  ];
  if (RUNTIME_TS.some(([, s]) => pats.some((p) => p.test(s)))) return true;
  // SQL: `SET column =`, `NEW.column :=`, or `column = EXCLUDED.…`
  return new RegExp(`SET[\\s\\S]{0,400}?\\b${column}\\s*=|NEW\\.${column}\\s*:?=|\\b${column}\\s*=\\s*EXCLUDED`, "i").test(ALL_SQL);
}

// ── A buddy built entirely from the DDL defaults ──────────────────────────────
// This is the ONLY buddy that can exist in production for these columns, since
// nothing ever writes them. Everything else is set to a plainly-listable buddy
// so that any exclusion the test sees comes from the column under examination.

function defaultBuddy(): BuddyScoringData {
  return {
    buddyProfileId: "b1",
    buddyUserId: "u1",
    city: "Miami",
    categories: ["city", "nightlife", "arrival"],
    languages: ["en"],
    hourlyRateUsd: 30,
    halfDayRateUsd: null,
    fullDayRateUsd: null,
    vibeTagsList: [],
    energyType: null,
    buddyLevel: "elite",           // deliberately NOT "new": promotion must not matter
    averageRating: 4.8,
    reviewCount: 20,
    completedBookings: 30,
    responseTimeH: null,
    verified: ddlBool("verified"),
    featured: ddlBool("featured"),
    cityAmbassador: ddlBool("city_ambassador"),
    availableNow: ddlBool("available_now"),
    femaleOnlyService: ddlBool("female_only_service"),
    publicMeetupOnly: ddlBool("public_meetup_only"),
    groupApproved: ddlBool("group_approved"),
    nightlifeApproved: ddlBool("nightlife_admin_approved"),
    arrivalApproved: ddlBool("arrival_approved"),
    categoryApprovals: {},
    trustScore: 80,
    maxGroupSize: ddlDefault("max_group_size") as number,
    newBuddyPublicOnly: ddlBool("new_buddy_public_only"),
    newBuddyDaytimeOnly: ddlBool("new_buddy_daytime_only"),
    riskHold: ddlBool("risk_hold"),
    adminStatus: "active",
    status: "active",
  };
}

function score(prefs: MatchPreferences, over: Partial<BuddyScoringData> = {}) {
  // (buddy, prefs) — that is the real signature; reversing it silently
  // produces an all-defaults buddy and a suite that proves nothing.
  return calculateCompatibilityScore({ ...defaultBuddy(), ...over }, prefs);
}

// ── Sanity: the columns really are writerless ─────────────────────────────────

const WRITERLESS = [
  "group_approved",
  "female_only_service",
  "arrival_approved",
  "public_meetup_only",
  "new_buddy_public_only",
  "new_buddy_daytime_only",
  "new_buddy_max_hours",
  "nightlife_approved",
  // NOT "verified": the detector below matches a bare column NAME across all
  // runtime files and `verified:` is a field on a dozen unrelated DTOs, so it
  // reads as written no matter what touches rent_buddy_profiles. The finding
  // stands (POST /admin/users/:userId/verify writes `profiles`, a DIFFERENT
  // table, so rent_buddy_profiles.verified has no producer and the
  // `new_verified` section is permanently empty) — it just needs a
  // table-scoped detector to assert, which is out of this change's scope.
] as const;

describe("the columns under test genuinely have no writer", () => {
  for (const col of WRITERLESS) {
    it(`rent_buddy_profiles.${col} is written by nothing in runtime code or SQL`, () => {
      assert.equal(
        hasWriter(col),
        false,
        `rent_buddy_profiles.${col} now HAS a writer. That is good news, not a test failure to silence: `
        + "delete it from WRITERLESS and re-check the gate direction assertions below, which were written for a column stuck at its default.",
      );
    });
  }

  it("the detector is not blind — a column that IS written reads as written", () => {
    // Control. `max_group_size` is written by PATCH /rent-a-buddy/me/profile and
    // by two rentABuddySpec writers; if the detector cannot see that, every
    // assertion above is vacuous.
    assert.equal(hasWriter("max_group_size"), true, "hasWriter() cannot see a known writer — the writerless assertions above prove nothing");
    assert.equal(hasWriter("nightlife_admin_approved"), true, "nightlife_admin_approved IS written by the admin nightlife-approve endpoint");
  });
});

// ── Direction proofs ──────────────────────────────────────────────────────────

describe("ALWAYS-DENY gates (dormant capability, safe direction)", () => {
  it("group_approved: any groupSize > 1 is excluded, for every buddy, at the DDL default", () => {
    assert.equal(ddlBool("group_approved"), false, "the direction below is derived from this default");
    const r = score({ groupSize: 2 });
    assert.equal(r.eligible, false);
    assert.equal(r.ineligibilityReason, "group_not_approved");
  });

  it("group_approved: a solo request is unaffected (the gate is scoped, not a blanket exclusion)", () => {
    const r = score({ groupSize: 1 });
    assert.equal(r.eligible, true, "groupSize 1 must still match — otherwise the exclusion above proves nothing about GROUPS");
  });

  it("female_only_service: the femaleOnly preference excludes every buddy at the DDL default", () => {
    assert.equal(ddlBool("female_only_service"), false);
    const r = score({ femaleOnly: true });
    assert.equal(r.eligible, false);
    assert.equal(r.ineligibilityReason, "female_only_required");
  });

  it("arrival_approved: an arrival request loses half its category score at the DDL default", () => {
    assert.equal(ddlBool("arrival_approved"), false);
    const denied = score({ need: "arrival" });
    const granted = score({ need: "arrival" }, { arrivalApproved: true });
    assert.equal(denied.scoreBreakdown.category, 50);
    assert.equal(granted.scoreBreakdown.category, 100);
    assert.ok(
      denied.score < granted.score,
      "arrival_approved must move the score, or this column is not a gate at all and belongs in the dead-read list",
    );
  });
});

describe("ALWAYS-ALLOW gates (a control that enforces nothing)", () => {
  it("public_meetup_only: the publicOnly preference excludes NOBODY, because new_buddy_public_only is stuck true", () => {
    assert.equal(ddlBool("public_meetup_only"), false, "the buddy's own public-meetup flag is off by default…");
    assert.equal(ddlBool("new_buddy_public_only"), true, "…but the new-buddy flag it is OR'd with is on by default");

    const r = score({ publicOnly: true });
    assert.equal(
      r.eligible, true,
      "the publicOnly preference is expected to be inert here — if this ever fails, a producer appeared for one of the two columns and the safety copy on the preference should be revisited",
    );

    // …and prove it is the OR that neutralises it, not some unrelated pass.
    const both = score({ publicOnly: true }, { publicMeetupOnly: false, newBuddyPublicOnly: false });
    assert.equal(both.eligible, false);
    assert.equal(both.ineligibilityReason, "public_meetup_required");
  });

  it("public_meetup_only: the safety component cannot differentiate either — every buddy scores the same", () => {
    const a = score({ safetyPrefs: {} });
    const b = score({ safetyPrefs: {} }, { publicMeetupOnly: true });
    assert.equal(
      a.scoreBreakdown.safety, b.scoreBreakdown.safety,
      "with new_buddy_public_only stuck true the safety bonus is unconditional; a difference here means a producer landed",
    );
  });
});

describe("the nightlife pair — the one case with a written twin to switch to", () => {
  it("nightlife_admin_approved (the WRITTEN column) drives the nightlife category score", () => {
    const unapproved = score({ need: "nightlife" });
    const approved = score({ need: "nightlife" }, { nightlifeApproved: true });
    assert.equal(unapproved.scoreBreakdown.category, 0);
    assert.equal(approved.scoreBreakdown.category, 100);
  });

  it("the marketplace DTO reads nightlife_admin_approved, never the writerless nightlife_approved", () => {
    const src = readFileSync(resolve(SRC, "routes/rentABuddyMarketplace.ts"), "utf8");
    assert.match(src, /nightlifeApproved:\s*row\.nightlife_admin_approved/, "the scoring DTO must source the column an admin actually writes");
    assert.doesNotMatch(
      src,
      /\brow\.nightlife_approved\b|\.eq\(\s*["']nightlife_approved["']/,
      "nightlife_approved has no writer; reading or filtering on it re-creates the always-empty nightlife section",
    );
  });
});

describe("route-level gates: the same columns, the same direction", () => {
  it("POST /rent-a-buddy/packages/:packageId/book denies group bookings at the group_approved default", () => {
    const src = readFileSync(resolve(SRC, "routes/rentABuddyMarketplace.ts"), "utf8");
    const m = src.match(/if \(groupSize > 1 && !buddy\.group_approved\) return sendError\([^)]*\)/);
    assert.ok(m, "the package-book group gate moved or changed shape — re-derive its direction before editing this test");
    assert.equal(
      ddlBool("group_approved"), false,
      "`!buddy.group_approved` on a NOT NULL DEFAULT false column is a constant true — the gate always denies",
    );
  });

  it("POST /rent-a-buddy/bookings takes the new-buddy branch for every buddy and caps them at the DDL hour limit", () => {
    const src = readFileSync(resolve(SRC, "routes/rentABuddy.ts"), "utf8");
    assert.match(src, /if \(buddyProfile\.new_buddy_public_only\) \{/, "the new-buddy restriction branch moved");
    assert.match(src, /durationH > buddyProfile\.new_buddy_max_hours/, "the new-buddy duration cap moved");
    assert.equal(ddlBool("new_buddy_public_only"), true, "the branch condition is a constant true");
    assert.equal(
      ddlDefault("new_buddy_max_hours"), 2,
      "every buddy is capped at this many hours per booking; if the DDL default changes, so does the cap for the entire platform",
    );
  });

  it("nothing relaxes the new_buddy_* columns when buddy_level changes", () => {
    const rab = readFileSync(resolve(SRC, "routes/rentABuddy.ts"), "utf8");
    const mkt = readFileSync(resolve(SRC, "routes/rentABuddyMarketplace.ts"), "utf8");
    for (const [name, src] of [["rentABuddy.ts", rab], ["rentABuddyMarketplace.ts", mkt]] as const) {
      for (const m of src.matchAll(/\.update\(\s*\{[^}]*buddy_level[^}]*\}/g)) {
        assert.doesNotMatch(
          m[0], /new_buddy_/,
          `${name}: a buddy_level writer now also touches new_buddy_* — good, but the "promotion lifts nothing" finding above is stale and this suite must be updated`,
        );
      }
    }
  });
});
