/**
 * census-layover §85 (lifecycle audit, 2026-10-24, A5) — which Layover doors require an account in good standing.
 *
 * A door that NAMES or LOCATES another person (a crew card, an offered crew, the mutual roster, a presence-roster card,
 * a crew location share) publishes that person only while their account is in good standing:
 * `publishableInGoodStanding`, or `withAccountStanding` on the cards it shows. A door that publishes nobody keeps the
 * consent-only `publishableUserIds`:
 *   - a COUNT names nobody;
 *   - a notice RECIPIENT is not published to anyone, and an account not in good standing cannot sign in to read it;
 *   - the viewer's own publishability is the caller's own (requireUser has already refused a banned caller).
 *
 * 1. STRUCTURE: every call in the Layover surface is enumerated with its class, so a new door fails here until it is
 *    classified (and an identity door switched back to consent-only fails too).
 * 2. BEHAVIOUR (cityPresence, a fake database): a deactivated account is COUNTED but gets no card; an unreadable
 *    standing costs the cards, never the count; an active account gets its card (control). The crew card and the
 *    location share are proved on the real chain in test/db/layoverLifecycleAudit.db.test.ts (A5, A5-ban).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/layoverStandingDoors.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeLayoverDb, sessionRow } from "./helpers/fakeLayoverDb.js";
import { cityPresence } from "../routes/airport.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Exact call counts per file. `identity` doors use the standing variant; `consent` doors publish nobody. */
const EXPECTED: Record<string, { identity: number; consent: number; why: string }> = {
  "routes/airport.ts": {
    identity: 1, consent: 2,
    why: "identity: crew cards (publishedCrewSolution's visibleIds). consent: the presence roster's member set, which is its " +
      "COUNT (its cards are standing-filtered by withAccountStanding on the cards shown), and the city population a COUNT is taken over.",
  },
  "routes/layoverCrewLocation.ts": {
    identity: 1, consent: 1,
    why: "identity: other crewmates' location shares. consent: the viewer's own publishability (the caller).",
  },
  "services/layover/LayoverDiscoveryConsent.ts": {
    identity: 2, consent: 0,
    why: "identity: the mutual roster and the incoming requests both carry cards.",
  },
  "services/layover/LayoverCrewAbortNotice.ts": {
    identity: 0, consent: 2,
    why: "consent: notice RECIPIENTS, who are told and not published.",
  },
  "services/layover/LayoverBuddyAbortNotice.ts": {
    identity: 0, consent: 1,
    why: "consent: the buddy notice's RECIPIENTS.",
  },
};

function count(src: string, fn: string): number {
  return (src.match(new RegExp(`\\b${fn}\\(`, "g")) ?? []).length;
}

describe("census-layover §85 A5 — every Layover publish door is classified", () => {
  for (const [file, want] of Object.entries(EXPECTED)) {
    it(`${file}: ${want.identity} identity door(s) in good standing, ${want.consent} consent-only`, () => {
      const src = readFileSync(SRC + file, "utf8");
      assert.equal(count(src, "publishableInGoodStanding"), want.identity, `${file}: identity doors changed. ${want.why}`);
      assert.equal(count(src, "publishableUserIds"), want.consent, `${file}: consent-only doors changed. ${want.why}`);
    });
  }

  it("the presence-roster cards are standing-filtered before any card is read", () => {
    const src = readFileSync(SRC + "routes/airport.ts", "utf8");
    assert.match(src, /const standing = await withAccountStanding\(sc, visible\.slice\(0, 6\), \[\]\); const shown = standing\.kind === "read" \? standing\.value\.allowed : \[\];/);
  });

  it("no other file in the Layover surface calls either function", () => {
    const guard = readFileSync(SRC + "services/airport/LayoverPrivacyGuard.ts", "utf8");
    assert.equal(count(guard, "publishableUserIds"), 2, "the guard: the definition and publishableInGoodStanding's own call");
    assert.equal(count(guard, "publishableInGoodStanding"), 1, "the guard: the definition");
  });
});

const traveller = (account_status: string) => ({
  layover_sessions: [sessionRow({ id: "session-2", user_id: "user-2", share_city_status: true, manual_city: "Taoyuan", airport_id: null })],
  blocks: [], location_preferences: [],
  profiles: [{ id: "user-2", handle: "two", name: "Two", avatar_url: null, account_status }],
});
type CityDb = Parameters<typeof cityPresence>[0];

describe("census-layover §85 A5 — presence-roster cards name only an account in good standing; the count names nobody", () => {
  it("control: an active account is counted AND gets its card", async () => {
    const r = await cityPresence(makeLayoverDb(traveller("active"), {}) as unknown as CityDb, "user-1", "Taoyuan");
    assert.equal(r.kind, "read", JSON.stringify(r));
    if (r.kind !== "read") return;
    assert.equal(r.value.count, 1);
    assert.deepEqual(r.value.travelers.map((t) => t.id), ["user-2"]);
  });

  for (const status of ["deactivated", "pending_deletion", "deleted"]) {
    it(`a ${status} account is counted but gets NO card`, async () => {
      const r = await cityPresence(makeLayoverDb(traveller(status), {}) as unknown as CityDb, "user-1", "Taoyuan");
      assert.equal(r.kind, "read", JSON.stringify(r));
      if (r.kind !== "read") return;
      assert.equal(r.value.count, 1, "the count names nobody, so standing does not change it");
      assert.deepEqual(r.value.travelers, [], `a ${status} account was given a card`);
    });
  }

  it("an unreadable standing costs the cards, never the count, and says so", async () => {
    const db = makeLayoverDb(traveller("active"), { failures: { "profiles:select": { message: "relation unavailable" } } });
    const r = await cityPresence(db as unknown as CityDb, "user-1", "Taoyuan");
    assert.equal(r.kind, "degraded", JSON.stringify(r));
    if (r.kind !== "degraded") return;
    assert.equal(r.fallback.count, 1);
    assert.deepEqual(r.fallback.travelers, []);
    assert.deepEqual(r.reasons, ["traveller_cards_unreadable"]);
  });
});
