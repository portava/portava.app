/**
 * IDF-25 / IDF-27 — a provider-verified MINOR must not pass an 18+ gate on the
 * birthday they typed.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * Both real adapters normalize a provider result whose failure reason is
 * `underage` to `isOver18 = false`
 * (`services/identityVerification/stripeIdentity.ts`, `.../persona.ts`), and
 * `routes/verification.ts` persists that boolean on EVERY result state — the
 * patch object carrying `is_over_18` is applied before the
 * `status === "verified"` branch, so a `failed` / `underage` result writes
 * `is_over_18 = false` to `identity_verifications`.
 *
 * Nothing read it. A repository-wide search for `is_over_18` outside tests and
 * generated types returned the write, the status route's SELECT list, and the
 * client's display mapping. ZERO gates. Every 18+ gate instead derives age from
 * `profiles.date_of_birth`, which the user types and which `routes/profile.ts`
 * validates only for format, past-ness and a CLAIMED age of 18.
 *
 * So a user whose government document proves they are a minor kept the adult
 * birthday they had typed and passed every 18+ gate — including the
 * Rent-a-Buddy booking gate, which pairs strangers in person. The product held
 * proof of the contradiction and did nothing with it.
 *
 * ── WHY THIS IS DECIDED, NOT BLOCKED ────────────────────────────────────────
 * This is a CONTRADICTION rule, not a source-of-truth rule, so it holds under
 * both directions of the open `D-DOB` question: if `is_over_18` becomes the
 * gate, a `false` refuses; if the self-asserted DOB is ratified as the gate, a
 * provider-verified contradiction of a self-assertion must still win, or the
 * ratification means the product ignores evidence it paid a vendor for.
 *
 * What happens to the user BEYOND the refusal — suspension, age-restriction,
 * clearing the DOB — is IDF-26, is blocked on `D-MINOR`, and is deliberately
 * NOT built or asserted here.
 *
 * ── WHERE THE RULE LIVES, AND WHY ───────────────────────────────────────────
 * `lib/travelerVerification.ts`, the one helper that answers "is this TRAVELLER
 * verified?". Its four consumers (the Rent-a-Buddy booking gate, the
 * /me/eligibility endpoint, the MVP-mode rollout gate and the rentABuddySpec
 * alias) all reach it, so the rule is one change rather than four that can
 * drift apart again — which is the bug that helper's own header says it was
 * created to end.
 *
 * `routes/rentABuddy.ts` additionally refuses a known minor BEFORE the
 * launch-control branch, so the refusal does not depend on a launch control
 * existing for the location, on `requireIdVerification` being on, or on the
 * error message being about a missing date of birth.
 *
 * ── WHAT WOULD TURN THIS RED ────────────────────────────────────────────────
 *   • deleting the `is_over_18` clause from `verifiedAgeSignalFromRows`
 *   • `applyVerifiedAgeSignal` passing the self-asserted age through
 *   • deleting the `refuseKnownMinorTraveler` call from
 *     `enforceBookingCreationGates`
 *   • `readVerifiedAgeSignal` treating a read error as "no rows"
 *
 * Run: node --import tsx --test src/test/verifiedMinorGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  loadTravelerIdentity,
  travelerIdentityFromProfile,
  verifiedAgeSignalFromRows,
  applyVerifiedAgeSignal,
} from "../lib/travelerVerification.js";
import { enforceBookingCreationGates } from "../routes/rentABuddy.js";

const TRAVELER = "11111111-1111-4111-8111-111111111111";
const BUDDY_USER = "22222222-2222-4222-8222-222222222222";

/** A date of birth that is comfortably adult, so nothing here passes by accident. */
const ADULT_DOB = "1990-04-01";

function adultProfileRow(extra: Record<string, any> = {}) {
  return {
    id: TRAVELER,
    date_of_birth: ADULT_DOB,
    phone_verified_at: "2026-01-01T00:00:00Z",
    id_verified_at: null,
    verification_level: "id_verified",
    verification_status: "verified",
    verified: true,
    ...extra,
  };
}

/** The row a provider result of `underage` leaves behind. */
function underageVerificationRow(createdAt = "2026-05-01T00:00:00Z") {
  return {
    id: "iv-underage-1",
    user_id: TRAVELER,
    provider: "stripe",
    status: "failed",
    failure_reason: "underage",
    is_over_18: false,
    created_at: createdAt,
  };
}

// ── Fake Supabase client ─────────────────────────────────────────────────────
//
// Tables are plain arrays. `errorTables` makes ONE table answer with a resolved
// `{ data: null, error }` — the shape supabase-js actually returns on a database
// error, which is the shape every fail-closed reader in this codebase is written
// against.

interface FakeState {
  profiles: any[];
  identity_verifications: any[];
  rent_buddy_launch_controls: any[];
  rent_buddy_city_restrictions: any[];
  blocks: any[];
  rent_buddy_profiles: any[];
}

function emptyState(): FakeState {
  return {
    profiles: [],
    identity_verifications: [],
    rent_buddy_launch_controls: [],
    rent_buddy_city_restrictions: [],
    blocks: [],
    rent_buddy_profiles: [],
  };
}

function makeClient(state: FakeState, errorTables: string[] = []) {
  function table(name: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let single = false;

    const rows = () => {
      let out = ((state as any)[name] ?? []).filter((r: any) => filters.every((f) => f(r)));
      if (orderCol) {
        out = [...out].sort((a, b) =>
          orderAsc
            ? String(a[orderCol!] ?? "").localeCompare(String(b[orderCol!] ?? ""))
            : String(b[orderCol!] ?? "").localeCompare(String(a[orderCol!] ?? "")),
        );
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };

    const settle = () => {
      if (errorTables.includes(name)) {
        return { data: null, error: { message: `${name} unreadable (injected)`, code: "57014" }, count: null };
      }
      const out = rows();
      return single
        ? { data: out[0] ?? null, error: null }
        : { data: out, error: null, count: out.length };
    };

    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      neq(c: string, v: any) { filters.push((r) => (r[c] ?? null) !== v); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      // PostgREST's `.not(col, "is", null)` — what the §31 follow-up read uses to
      // find the newest DECIDED row past the scan window.
      not(c: string, op: string, v: any) {
        if (op === "is" && v === null) filters.push((r) => (r[c] ?? null) !== null);
        else filters.push((r) => (r[c] ?? null) !== v);
        return b;
      },
      or() { return b; },
      ilike(c: string, v: any) {
        filters.push((r) => String(r[c] ?? "").toLowerCase() === String(v).toLowerCase());
        return b;
      },
      order(c: string, o?: any) { orderCol = c; orderAsc = o?.ascending !== false; return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { single = true; return Promise.resolve(settle()); },
      single() { single = true; return Promise.resolve(settle()); },
      then(onF: any, onR: any) { return Promise.resolve(settle()).then(onF, onR); },
    };
    return b;
  }
  return { from: (t: string) => table(t) } as any;
}

/** Minimal Express `res` double that records the terminal status + payload. */
function makeRes() {
  const captured: { status: number | null; body: any } = { status: null, body: null };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: any) { captured.body = payload; return res; },
    captured,
  };
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The rule itself — pure, so the decision is readable without a database
// ═══════════════════════════════════════════════════════════════════════════

describe("IDF-25: the contradiction rule", () => {
  it("a stored is_over_18=false is a verified-minor signal", () => {
    const signal = verifiedAgeSignalFromRows([underageVerificationRow()], null);
    assert.equal(signal.verifiedMinor, true);
    assert.equal(signal.verificationUnreadable, false);
  });

  it("no verification rows is NOT a minor signal — absence of evidence is not evidence", () => {
    const signal = verifiedAgeSignalFromRows([], null);
    assert.equal(signal.verifiedMinor, false);
    assert.equal(signal.verificationUnreadable, false);
  });

  it("rows with a null is_over_18 are ignored — a created/pending session decides nothing", () => {
    const signal = verifiedAgeSignalFromRows(
      [{ user_id: TRAVELER, status: "pending", is_over_18: null, created_at: "2026-06-01T00:00:00Z" }],
      null,
    );
    assert.equal(signal.verifiedMinor, false);
  });

  it("the NEWEST decided row wins, so a user who has since turned 18 is not held a minor forever", () => {
    const signal = verifiedAgeSignalFromRows(
      [
        underageVerificationRow("2024-05-01T00:00:00Z"),
        { user_id: TRAVELER, status: "verified", is_over_18: true, created_at: "2026-05-01T00:00:00Z" },
      ],
      null,
    );
    assert.equal(signal.verifiedMinor, false, "the later adult result supersedes the earlier minor one");
  });

  it("and the newest DECIDED row still wins when a later undecided session exists", () => {
    const signal = verifiedAgeSignalFromRows(
      [
        underageVerificationRow("2026-05-01T00:00:00Z"),
        { user_id: TRAVELER, status: "created", is_over_18: null, created_at: "2026-06-01T00:00:00Z" },
      ],
      null,
    );
    assert.equal(signal.verifiedMinor, true, "starting a new session does not clear the last decided result");
  });

  it("an unreadable identity_verifications is NOT 'no minor signal' — it fails closed", () => {
    const signal = verifiedAgeSignalFromRows(null, { message: "boom" });
    assert.equal(signal.verifiedMinor, false, "an unread table proves nothing about this user");
    assert.equal(signal.verificationUnreadable, true, "but it is reported as unknown, never as clean");
  });

  it("the signal DEFEATS the self-asserted date of birth", () => {
    const selfAsserted = travelerIdentityFromProfile(adultProfileRow());
    assert.ok(
      selfAsserted.age !== null && selfAsserted.age >= 18,
      "fixture precondition: the typed birthday reads as an adult",
    );

    const checked = applyVerifiedAgeSignal(selfAsserted, {
      verifiedMinor: true,
      verificationUnreadable: false,
    });
    assert.equal(checked.age, null, "no age derived from the typed birthday may satisfy an 18+ gate");
    assert.equal(checked.idVerified, false, "a document check that says MINOR is not a passed ID check");
    assert.equal(checked.verifiedMinor, true);
    assert.equal(
      checked.dateOfBirth, ADULT_DOB,
      "the self-assertion itself is preserved — the rule refuses, it does not rewrite the record",
    );
  });

  it("leaves an ordinary adult traveller completely alone", () => {
    const checked = applyVerifiedAgeSignal(travelerIdentityFromProfile(adultProfileRow()), {
      verifiedMinor: false,
      verificationUnreadable: false,
    });
    assert.ok(checked.age !== null && checked.age >= 18, "the adult keeps their age");
    assert.equal(checked.idVerified, true, "and keeps their ID verification");
    assert.equal(checked.verifiedMinor, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The shared helper actually reads the row
// ═══════════════════════════════════════════════════════════════════════════

describe("IDF-25: loadTravelerIdentity reads is_over_18", () => {
  it("a verified minor with an adult birthday on file loads as ageless and unverified", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.identity_verifications.push(underageVerificationRow());

    const identity: any = await loadTravelerIdentity(makeClient(state), TRAVELER);
    assert.equal(identity.verifiedMinor, true);
    assert.equal(identity.age, null, "the typed adult birthday does not survive the contradiction");
    assert.equal(identity.idVerified, false);
  });

  it("the same profile WITHOUT a verification row keeps its self-asserted adult age", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());

    const identity: any = await loadTravelerIdentity(makeClient(state), TRAVELER);
    assert.equal(identity.verifiedMinor, false);
    assert.ok(identity.age !== null && identity.age >= 18, "control: nothing else changed");
    assert.equal(identity.idVerified, true);
  });

  it("an unreadable identity_verifications refuses rather than passing the traveller through", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());

    const identity: any = await loadTravelerIdentity(
      makeClient(state, ["identity_verifications"]),
      TRAVELER,
    );
    assert.equal(identity.verificationUnreadable, true);
    assert.equal(identity.age, null, "a gate cannot be satisfied by an age the check could not corroborate");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. IDF-27 — the Rent-a-Buddy booking gate, the one that pairs strangers
// ═══════════════════════════════════════════════════════════════════════════

const BUDDY_PROFILE = {
  id: "buddy-profile-1",
  user_id: BUDDY_USER,
  country: "FR",
  category_approvals: { city: true },
  verification_status: "verified",
  nightlife_admin_approved: false,
};

function launchControl(extra: Record<string, any> = {}) {
  return {
    id: "lc-1",
    country_code: "FR",
    city: null,
    category: null,
    enabled: true,
    waitlist_only: false,
    require_id_verification: false,
    require_phone_verification: false,
    min_age: 18,
    nightlife_min_age: 21,
    full_payment_required: false,
    ...extra,
  };
}

async function runBookingGate(state: FakeState, errorTables: string[] = []) {
  const res = makeRes();
  const allowed = await enforceBookingCreationGates({
    sc: withVerifiedBookingParties(makeClient(state, errorTables), "everyone"),
    res,
    userId: TRAVELER,
    buddyProfile: BUDDY_PROFILE,
    city: "Paris",
    countryCode: "FR",
    category: "city",
    paymentMode: "full_in_app",
  });
  return { allowed, status: res.captured.status, body: res.captured.body };
}

describe("IDF-27: the Rent-a-Buddy booking gate refuses a verified minor", () => {
  it("refuses even when the launch control does NOT require ID verification", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.identity_verifications.push(underageVerificationRow());
    state.rent_buddy_launch_controls.push(launchControl({ require_id_verification: false }));

    const { allowed, status, body } = await runBookingGate(state);

    assert.equal(allowed, false, "a booking that pairs strangers in person must not be seated");
    assert.equal(status, 403);
    assert.equal(
      body?.error, "age_requirement",
      "the refusal is an AGE refusal, not a 'please verify your ID' nudge the user can satisfy",
    );
    assert.ok(
      !/date of birth/i.test(String(body?.message ?? "")),
      "and not the missing-DOB message: the date of birth is on file and is contradicted",
    );
  });

  it("refuses when NO launch control matches the location at all", async () => {
    // The launch-control branch is where every existing age check lives. With no
    // control row the gate never reaches one, so a rule that lived only inside
    // that branch would leave this path open.
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.identity_verifications.push(underageVerificationRow());

    const { allowed, status, body } = await runBookingGate(state);
    assert.equal(allowed, false);
    assert.equal(status, 403);
    assert.equal(body?.error, "age_requirement");
  });

  it("POSITIVE CONTROL: the same booking is allowed once the minor signal is gone", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.rent_buddy_launch_controls.push(launchControl({ require_id_verification: false }));

    const { allowed, status } = await runBookingGate(state);
    assert.equal(allowed, true, "the gate must not be refusing for some unrelated reason");
    assert.equal(status, null, "nothing was written to the response on the allowed path");
  });

  it("an unreadable identity_verifications refuses THIS booking rather than waving it through", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.rent_buddy_launch_controls.push(launchControl({ require_id_verification: false }));

    const { allowed, status, body } = await runBookingGate(state, ["identity_verifications"]);
    assert.equal(allowed, false);
    assert.equal(status, 503, "an unknown answer is an outage, not a verdict about the user");
    assert.equal(body?.error, "age_verification_unavailable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// census-trust §31 — the decided row must not fall out of the scan window
// ═══════════════════════════════════════════════════════════════════════════
//
// readVerifiedAgeSignal reads the newest VERIFIED_AGE_SCAN_LIMIT (50) rows and
// lets the newest DECIDED one win. Undecided rows (`is_over_18` null: a session
// that was created, abandoned, canceled or expired) are skipped — so a verified
// minor who opened 50 more sessions after the underage result pushed that
// result past the window, the read answered "no contradiction", and every 18+
// gate reverted to the adult birthday they typed. The rate limit (3 sessions a
// day, held in memory per process) bounds how fast that can be done, not
// whether. A full window with no decided row now asks for the newest decided
// row directly; it never reads "nothing found in the first 50" as "nothing".

function undecidedRows(n: number, newestFirstFrom: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `iv-undecided-${i}`,
    user_id: TRAVELER,
    provider: "stripe",
    status: "canceled",
    failure_reason: null,
    is_over_18: null,
    created_at: new Date(Date.UTC(2026, 6, 1) + (newestFirstFrom + i) * 3_600_000).toISOString(),
  }));
}

describe("census-trust §31: a verified-minor result past the 50-row scan window still refuses", () => {
  it("50 NEWER undecided sessions do not bury the underage result — the traveller is still a verified minor", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.identity_verifications.push(underageVerificationRow("2026-05-01T00:00:00Z"));
    state.identity_verifications.push(...undecidedRows(50, 0));

    const identity: any = await loadTravelerIdentity(makeClient(state), TRAVELER);
    assert.equal(identity.verifiedMinor, true, "the underage result past the window must still be found");
    assert.equal(identity.age, null, "the typed adult birthday must not come back");
    assert.equal(identity.verificationUnreadable, false);
  });

  it("CONTROL — 49 newer undecided sessions: the underage result is inside the window and refuses as before", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.identity_verifications.push(underageVerificationRow("2026-05-01T00:00:00Z"));
    state.identity_verifications.push(...undecidedRows(49, 0));

    const identity: any = await loadTravelerIdentity(makeClient(state), TRAVELER);
    assert.equal(identity.verifiedMinor, true);
    assert.equal(identity.age, null);
  });

  it("CONTROL — 60 undecided sessions and NO decided result anywhere is not a minor, and not an outage", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.identity_verifications.push(...undecidedRows(60, 0));

    const identity: any = await loadTravelerIdentity(makeClient(state), TRAVELER);
    assert.equal(identity.verifiedMinor, false);
    assert.equal(identity.verificationUnreadable, false);
    assert.ok(identity.age !== null && identity.age >= 18, "absence of a decided result is not evidence of minority");
  });

  it("a full window whose follow-up read FAILS is an outage (refuses), never 'no contradiction'", async () => {
    const state = emptyState();
    state.profiles.push(adultProfileRow());
    state.identity_verifications.push(underageVerificationRow("2026-05-01T00:00:00Z"));
    state.identity_verifications.push(...undecidedRows(50, 0));
    const base = makeClient(state);
    let calls = 0;
    const client = {
      from(t: string) {
        if (t !== "identity_verifications") return base.from(t);
        calls += 1;
        // The first (window) read answers; the follow-up read fails.
        return calls === 1 ? base.from(t) : makeClient(state, ["identity_verifications"]).from(t);
      },
    };
    const identity: any = await loadTravelerIdentity(client, TRAVELER);
    assert.equal(identity.verificationUnreadable, true);
    assert.equal(identity.age, null);
  });
});

// Both booking parties read as verified adults for the two-sided identity gate
// (lib/rentBuddyIdentityEligibility.ts); the verified-MINOR read this suite is
// about is a different query and reaches the suite's own fake untouched.
import { withVerifiedBookingParties } from "./helpers/verifiedBookingParties.js";
