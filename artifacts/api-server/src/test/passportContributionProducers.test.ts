/**
 * §20 contribution ledger — the PRODUCER side.
 *
 * THE DEFECT THIS LOCKS DOWN
 * ==========================
 * `PassportReputationService` derives every §20 number — level, accepted
 * reports, confirmations, hidden gems, top expertise, city expertise — from
 * rows in `passport_contribution_events`. It is fully built and fully tested.
 * But until 2026-09-05 exactly ONE of the eight `ContributionEventType` values
 * had a writer anywhere in the repo (`city_visit_verified`, emitted by the
 * manual-memory route with `metadata` defaulted to `{}`), so:
 *
 *   • `hiddenGems`, `acceptedReports` and four of the five confirmation/other
 *     types were structurally zero for every traveller, forever;
 *   • `topExpertise` and `cityExpertise` were permanently EMPTY, because the
 *     only writer emitted no category and no city to derive them from.
 *
 * The existing `passportContributions.test.ts` passes on fixture rows carrying
 * event types and metadata no producer could ever create — which is exactly why
 * a green suite did not notice. These tests assert on the PRODUCERS.
 *
 * SHRINK-ONLY RATCHET. `UNWIRED` lists the types that still have no verified
 * moment to hang off. The test fails in BOTH directions: wiring one without
 * striking it off fails, and losing a producer for a wired type fails.
 *
 * MUTATION PROOF (each performed, each RED): delete any one of the five
 * `recordContributionIfEnabled` call sites — routes/location.ts,
 * routes/geofence.ts, routes/safeReturn.ts, routes/hiddenGems.ts,
 * routes/trips.ts — and the producer-coverage test names the type that lost it.
 *
 * Run: node --import tsx/esm --test src/test/passportContributionProducers.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordContributionIfEnabled,
  CONTRIBUTION_EVENTS_FLAG,
  type ContributionEventType,
} from "../services/passport/PassportContributionService.js";
import { buildReputationSummary } from "../services/passport/PassportReputationService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ALL_TYPES: ContributionEventType[] = [
  "city_visit_verified",
  "plan_attendance_verified",
  "plan_hosted",
  "hidden_gem_verified",
  "pulse_contribution",
  "safe_return_completed",
  "qr_checkin_validated",
  "trip_crew_participation",
];

/**
 * Types that still have NO producer, each with the reason. This list may only
 * SHRINK. Do not add to it.
 *
 *  • plan_hosted           — "hosted" must mean the plan actually happened;
 *                            creating a meetup is not that moment, and no
 *                            plan-completion transition exists yet.
 *  • pulse_contribution    — routes/pulse.ts has no write endpoint at all, so
 *                            there is nothing to record.
 *  • qr_checkin_validated  — no QR check-in route exists (the only occurrence
 *                            of the string in the repo is a display map in
 *                            routes/passportStamps.ts:832).
 */
const UNWIRED = new Set<string>(["plan_hosted", "pulse_contribution", "qr_checkin_validated"]);

/** Every non-test TypeScript source file under src/. */
function productionSources(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "test" || e.name === "node_modules" || e.name === "migrations") continue;
        walk(p);
      } else if (/\.ts$/.test(e.name)) {
        out.push(p);
      }
    }
  })(SRC);
  return out;
}

/** Files that actually pass a given eventType to a contribution recorder. */
function producersOf(type: string): string[] {
  const hits: string[] = [];
  for (const file of productionSources()) {
    if (file.endsWith("services/passport/PassportContributionService.ts")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (!/recordContribution(IfEnabled)?\s*\(/.test(src)) continue;
    if (new RegExp(`eventType:\\s*"${type}"`).test(src)) hits.push(path.relative(SRC, file));
  }
  return hits;
}

describe("§20 contribution ledger — producer coverage", () => {
  it("every wired ContributionEventType has at least one production writer", () => {
    const missing: string[] = [];
    for (const type of ALL_TYPES) {
      if (UNWIRED.has(type)) continue;
      if (producersOf(type).length === 0) missing.push(type);
    }
    assert.deepEqual(
      missing,
      [],
      `these §20 event types lost their producer: ${missing.join(", ")}. ` +
        `Every count PassportReputationService derives from them silently returns to zero.`,
    );
  });

  it("the unwired list is a shrink-only ratchet — nothing on it has quietly gained a writer", () => {
    const nowWired = [...UNWIRED].filter((t) => producersOf(t).length > 0);
    assert.deepEqual(
      nowWired,
      [],
      `${nowWired.join(", ")} now has a producer — strike it off UNWIRED in this file`,
    );
  });

  it("names the five routes that produce, so a silent move is visible", () => {
    // Not decoration: this is what makes "delete a call site" go RED with a
    // useful message rather than a bare count.
    const expected: Record<string, string> = {
      city_visit_verified: "routes/location.ts",
      plan_attendance_verified: "routes/geofence.ts",
      safe_return_completed: "routes/safeReturn.ts",
      hidden_gem_verified: "routes/hiddenGems.ts",
      trip_crew_participation: "routes/trips.ts",
    };
    for (const [type, file] of Object.entries(expected)) {
      assert.ok(
        producersOf(type).includes(file),
        `${type} is no longer produced by ${file} (found: ${producersOf(type).join(", ") || "nothing"})`,
      );
    }
  });

  it("every producer passes a sourceId — without one the UNIQUE dedup index cannot fire", () => {
    // passport_contribution_events_dedup_idx is UNIQUE (user_id, event_type,
    // source_id) WHERE source_id IS NOT NULL. A producer that omits it
    // double-credits on every repeat of the same real-world action.
    for (const file of ["routes/location.ts", "routes/geofence.ts", "routes/safeReturn.ts", "routes/hiddenGems.ts", "routes/trips.ts"]) {
      const src = fs.readFileSync(path.join(SRC, file), "utf8");
      const calls = src.split("recordContributionIfEnabled(").slice(1);
      assert.ok(calls.length > 0, `${file} no longer calls recordContributionIfEnabled`);
      for (const call of calls) {
        const block = call.slice(0, call.indexOf("});") + 1);
        assert.match(block, /sourceId:/, `a recordContributionIfEnabled call in ${file} omits sourceId`);
      }
    }
  });

  it("the Safe Return producer deliberately records NO city", () => {
    // A Safe Return says where someone was alone. Feeding its city into the
    // ledger would let cityExpertise turn it into a public "Knows <city> well".
    const src = fs.readFileSync(path.join(SRC, "routes/safeReturn.ts"), "utf8");
    const call = src.slice(src.indexOf("recordContributionIfEnabled("));
    const block = call.slice(0, call.indexOf("});") + 1);
    assert.match(block, /eventType: "safe_return_completed"/);
    assert.ok(!/\bcity:/.test(block), "the Safe Return contribution must not carry a city");
  });
});

describe("recordContributionIfEnabled — the producer wrapper", () => {
  const USER = "contrib-user-1";

  function db(flagEnabled: boolean, existing: any[] = []) {
    return makePassportDb({
      feature_flags: [{ flag: CONTRIBUTION_EVENTS_FLAG, enabled: flagEnabled }],
      passport_contribution_events: existing,
    });
  }

  it("writes a row when the flag is ON", async () => {
    const rows: any[] = [];
    const client = db(true, rows);
    assert.equal(
      await recordContributionIfEnabled(client as any, {
        userId: USER, eventType: "hidden_gem_verified",
        sourceType: "hidden_gem_visit", sourceId: "gem-1",
        verificationLevel: "checkin",
        metadata: { city: "Da Nang", category: "hidden_gem" },
      }),
      true,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, "hidden_gem_verified");
    assert.deepEqual(rows[0].metadata, { city: "Da Nang", category: "hidden_gem" });
  });

  it("writes nothing when the flag is OFF — and the control proves the flag is why", async () => {
    const off: any[] = [];
    assert.equal(
      await recordContributionIfEnabled(db(false, off) as any, {
        userId: USER, eventType: "hidden_gem_verified", sourceId: "gem-1",
      }),
      false,
    );
    assert.equal(off.length, 0);

    // POSITIVE CONTROL — identical input, flag flipped.
    const on: any[] = [];
    assert.equal(
      await recordContributionIfEnabled(db(true, on) as any, {
        userId: USER, eventType: "hidden_gem_verified", sourceId: "gem-1",
      }),
      true,
    );
    assert.equal(on.length, 1);
  });

  it("does not double-credit the same source_id", async () => {
    const rows: any[] = [
      { user_id: USER, event_type: "hidden_gem_verified", source_id: "gem-1", metadata: {} },
    ];
    assert.equal(
      await recordContributionIfEnabled(db(true, rows) as any, {
        userId: USER, eventType: "hidden_gem_verified", sourceId: "gem-1",
      }),
      false,
      "a repeat of the same real-world action must not credit twice",
    );
    assert.equal(rows.length, 1);
  });

  it("never throws — a broken ledger cannot fail the action that triggered it", async () => {
    const exploding: any = { from() { throw new Error("boom"); } };
    assert.equal(
      await recordContributionIfEnabled(exploding, { userId: USER, eventType: "plan_hosted" }),
      false,
    );
    assert.equal(await recordContributionIfEnabled(null, { userId: USER, eventType: "plan_hosted" }), false);
  });
});

describe("§20 reputation over rows the PRODUCERS actually emit", () => {
  // The existing suite drives buildReputationSummary from hand-written
  // fixtures. This drives it from the exact metadata shape the five wired
  // producers write, which is what makes cityExpertise/topExpertise reachable
  // at all: the previous sole writer emitted `{}`.
  it("derives city + category expertise from producer-shaped metadata", async () => {
    const USER = "rep-real-1";
    const rows = [
      { user_id: USER, event_type: "city_visit_verified", metadata: { city: "Da Nang", country: "Vietnam", category: "city_visit" }, created_at: "2026-01-01" },
      { user_id: USER, event_type: "hidden_gem_verified", metadata: { city: "Da Nang", country: "Vietnam", category: "hidden_gem" }, created_at: "2026-01-02" },
      { user_id: USER, event_type: "plan_attendance_verified", metadata: { city: "Da Nang", category: "meetup" }, created_at: "2026-01-03" },
      { user_id: USER, event_type: "trip_crew_participation", metadata: { city: "Bangkok", category: "trip" }, created_at: "2026-01-04" },
      { user_id: USER, event_type: "safe_return_completed", metadata: { category: "safe_return" }, created_at: "2026-01-05" },
    ];
    const r = await buildReputationSummary(makePassportDb({ passport_contribution_events: rows }) as any, USER);

    assert.equal(r.confirmations, 2, "city_visit_verified + plan_attendance_verified");
    assert.equal(r.hiddenGems, 1);
    assert.equal(r.totalContributions, 5);
    assert.deepEqual(
      r.cityExpertise,
      ["Da Nang"],
      "three qualified Da Nang contributions clear CITY_EXPERTISE_MIN; Bangkok's one does not",
    );
    assert.ok(r.topExpertise.length >= 3, `expected real categories, got ${JSON.stringify(r.topExpertise)}`);

    // The pre-fix reality: the same five events with `metadata: {}` — which is
    // what the only previous writer emitted — derive NOTHING.
    const blank = rows.map((x) => ({ ...x, metadata: {} }));
    const before = await buildReputationSummary(makePassportDb({ passport_contribution_events: blank }) as any, USER);
    assert.deepEqual(before.cityExpertise, []);
    assert.deepEqual(before.topExpertise, []);
  });
});
