/**
 * Passport Reputation / Contributions — §20 (TABLE 21).
 *
 * Exercises `buildReputationSummary` (the read behind GET
 * /passport/:userId/contributions and the client ContributionCard):
 *   • aggregates accepted reports / confirmations / hidden gems from the
 *     contribution ledger, derives a contributor level + label, and surfaces the
 *     top expertise categories;
 *   • §20 privacy rule 1 — PAID / SPONSORED contributions never inflate the
 *     factual counts or the level;
 *   • an empty ledger yields an all-zero, Level 1 summary (never an error).
 *
 * Run: node --import tsx/esm --test src/test/passportContributions.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReputationSummary } from "../services/passport/PassportReputationService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const USER = "user-rep-1";

describe("buildReputationSummary — §20 reputation projection", () => {
  it("aggregates counts, derives level, and ranks top expertise", async () => {
    const db = makePassportDb({
      passport_contribution_events: [
        { user_id: USER, event_type: "pulse_contribution", metadata: { category: "nightlife" }, created_at: "2026-01-01" },
        { user_id: USER, event_type: "pulse_contribution", metadata: { category: "nightlife" }, created_at: "2026-01-02" },
        { user_id: USER, event_type: "pulse_contribution", metadata: { category: "nightlife" }, created_at: "2026-01-03" },
        { user_id: USER, event_type: "city_visit_verified", metadata: { category: "food" }, created_at: "2026-01-04" },
        { user_id: USER, event_type: "plan_attendance_verified", metadata: { category: "food" }, created_at: "2026-01-05" },
        { user_id: USER, event_type: "hidden_gem_verified", metadata: { category: "events" }, created_at: "2026-01-06" },
        { user_id: USER, event_type: "plan_hosted", metadata: {}, created_at: "2026-01-07" },
        // Another user's events must never bleed in.
        { user_id: "someone-else", event_type: "pulse_contribution", metadata: { category: "food" }, created_at: "2026-01-08" },
      ],
    });
    const r = await buildReputationSummary(db, USER);
    assert.equal(r.acceptedReports, 3);
    assert.equal(r.confirmations, 2);
    assert.equal(r.hiddenGems, 1);
    assert.equal(r.totalContributions, 7, "3 + 2 + 1 + 1 plan_hosted");
    assert.equal(r.level, 2);
    assert.equal(r.levelLabel, "Rising Contributor");
    assert.deepEqual(r.topExpertise, ["Nightlife", "Food", "Events"]);
  });

  it("never lets PAID/SPONSORED contributions inflate factual confidence (§20)", async () => {
    const db = makePassportDb({
      passport_contribution_events: [
        { user_id: USER, event_type: "pulse_contribution", metadata: { category: "food" }, created_at: "2026-02-01" },
        { user_id: USER, event_type: "pulse_contribution", metadata: { category: "food" }, created_at: "2026-02-02" },
        // These three are paid/sponsored and MUST be excluded from every count.
        { user_id: USER, event_type: "pulse_contribution", metadata: { paid: true, category: "food" }, created_at: "2026-02-03" },
        { user_id: USER, event_type: "pulse_contribution", metadata: { sponsored: true, category: "food" }, created_at: "2026-02-04" },
        { user_id: USER, event_type: "pulse_contribution", metadata: { source: "paid", category: "food" }, created_at: "2026-02-05" },
      ],
    });
    const r = await buildReputationSummary(db, USER);
    assert.equal(r.acceptedReports, 2, "paid reports excluded from accepted count");
    assert.equal(r.totalContributions, 2, "paid contributions never raise the total/level");
    assert.equal(r.level, 1);
  });

  it("returns an all-zero Level 1 summary for an empty ledger", async () => {
    const db = makePassportDb({ passport_contribution_events: [] });
    const r = await buildReputationSummary(db, USER);
    assert.equal(r.acceptedReports, 0);
    assert.equal(r.confirmations, 0);
    assert.equal(r.hiddenGems, 0);
    assert.equal(r.totalContributions, 0);
    assert.equal(r.level, 1);
    assert.equal(r.levelLabel, "New Contributor");
    assert.deepEqual(r.topExpertise, []);
    assert.deepEqual(r.cityExpertise, []);
  });

  it("derives 'Knows <city> well' only from repeated qualified contributions (§20)", async () => {
    const db = makePassportDb({
      passport_contribution_events: [
        // 3 qualified contributions in Bangkok → clears the threshold.
        { user_id: USER, event_type: "pulse_contribution", metadata: { city: "Bangkok" }, created_at: "2026-03-01" },
        { user_id: USER, event_type: "city_visit_verified", metadata: { city: "Bangkok" }, created_at: "2026-03-02" },
        { user_id: USER, event_type: "hidden_gem_verified", metadata: { city: "Bangkok" }, created_at: "2026-03-03" },
        // Only 1 qualified contribution in Tokyo → below threshold, not surfaced.
        { user_id: USER, event_type: "pulse_contribution", metadata: { city: "Tokyo" }, created_at: "2026-03-04" },
        // Da Nang would clear the threshold BUT the events are paid → excluded.
        { user_id: USER, event_type: "pulse_contribution", metadata: { city: "Da Nang", paid: true }, created_at: "2026-03-05" },
        { user_id: USER, event_type: "pulse_contribution", metadata: { city: "Da Nang", sponsored: true }, created_at: "2026-03-06" },
        { user_id: USER, event_type: "pulse_contribution", metadata: { city: "Da Nang", source: "paid" }, created_at: "2026-03-07" },
      ],
    });
    const r = await buildReputationSummary(db, USER);
    assert.deepEqual(r.cityExpertise, ["Bangkok"], "only Bangkok clears the qualified threshold");
    assert.ok(!r.cityExpertise.includes("Tokyo"), "a single visit is not expertise");
    assert.ok(!r.cityExpertise.includes("Da Nang"), "paid contributions never confer expertise");
  });
});
