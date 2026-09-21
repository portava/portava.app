/**
 * The crew token must not be withheld because a table could not be read.
 *
 * WHAT WAS WRONG (census-trips §74.3, reported by the census reviewer)
 * ===================================================================
 * `domain/trips/invariants/tripMembership.ts` says in its own header what a
 * wrong `false` on this signal costs:
 *
 *   "15 people each asserting their own solo trip would read as 15 independent
 *    groups — a SPLIT, i.e. the exact leak the crew signal exists to prevent
 *    (NOT a harmless merge)."
 *
 * That module grew two DISCRIMINATING reads for exactly this —
 * `readSharedCrewMembership` and `readAcceptedCrewSize`, which return
 * `{ readable, member }` / `{ readable, size }` so a caller can tell "this
 * person is not on the trip" from "nobody could read the trip". Its own doc
 * comment records the rest as owed work: *"Converting those two callers is the
 * remaining work, and it is recorded as such rather than done here."*
 *
 * `IntelCaptureService` was one of those callers and it had NOT been converted:
 * it called the discarding wrapper `isSharedCrewMember`, which collapses both
 * answers to `false`. And the narrowing that made `readAcceptedCrewSize`
 * correct made this caller WORSE, because the wrong answer went from occasional
 * to unconditional:
 *
 *                      before the narrowing            at HEAD
 *   acceptedCrewSize   owner dropped, members          `tripErr` short-circuits
 *                      still counted -> 2              -> 0
 *   isSharedCrewMember true (token honoured)           false (the crew SPLITS)
 *
 * The narrowing itself was RIGHT. Narrowing is always safe for AUTHORIZATION —
 * nothing is granted on a roster nobody read — and this file does not touch
 * that. It is safe for authorization and wrong for THIS consumer, whose
 * question is not "may they?" but "are these three observations one group or
 * three?", and for that question a fail-closed `false` is an answer invented
 * about data nobody looked at.
 *
 * WHAT A USER SAW. Three people on one trip send a quick signal about the same
 * place during a partial outage. Each one's asserted `partyId` is refused
 * silently, each falls through to the solo/none branch, and the three
 * observations enter the corpus as three INDEPENDENT reports of the same fact.
 * That is the consensus signal being inflated threefold by a database hiccup,
 * written permanently, with nothing on the row to say the group identity was
 * never established.
 *
 * WHAT IS PINNED
 * ==============
 * An asserted `partyId` whose crew membership cannot be READ now REFUSES the
 * capture (`db_error`) instead of writing an observation whose independence is
 * unknown. That is the same treatment the subject lookup twelve lines above
 * already gets — `if (subjErr) return { ok: false, reason: "db_error" }` — and
 * it is the only honest option available: the token cannot be granted (nothing
 * verified the actor is on that trip), and it cannot be silently downgraded
 * (that is the split). A refusal is retryable; a corrupted consensus row is not.
 *
 * X4 and X6 are the cases that keep the fix from being "refuse whenever a
 * partyId is present". X4 is a GENUINE non-crew — a solo trip, readable, really
 * not a shared crew — and it must still fall through to the solo token. X6 has
 * no `partyId` at all and must be unaffected by an unreadable `trips` entirely.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/intelCrewSplitOnDegradedRead.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { writeObservation } from "../services/intel/IntelCaptureService.js";
import { deriveGroupKey } from "../lib/intelGroupKey.js";

const ACTOR = "11111111-1111-1111-1111-111111111111";
const CREWMATE = "33333333-3333-3333-3333-333333333333";
const PLACE = "22222222-2222-2222-2222-222222222222";

/** The active window is computed from the real clock, as writeObservation's is. */
function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const ACTIVE = { start_date: isoDay(-1), end_date: isoDay(1) };

/** A shared crew: ACTOR owns trip-A and CREWMATE is an accepted member. */
const SHARED_CREW = {
  trips: [{ id: "trip-A", owner_id: ACTOR, ...ACTIVE }],
  members: [{ trip_id: "trip-A", user_id: CREWMATE, role: "member", status: "accepted" }],
};

/** A solo trip: ACTOR owns it and nobody else is on it. */
const SOLO_TRIP = {
  trips: [{ id: "trip-solo", owner_id: ACTOR, ...ACTIVE }],
  members: [] as any[],
};

/**
 * The fake from `intelGroupCapture.test.ts`, plus an `errorTables` seam.
 *
 * An unreadable table RESOLVES with `{ data: null, error }` — which is what
 * supabase-js does on a failed read, and the whole reason the defect above
 * exists. A fake that REJECTED would make the bug untestable, because the
 * surrounding try/catch would fire and nobody would learn anything.
 *
 * `feature_flags`, `places` and `intel_contribution_consent` are never made
 * unreadable here: those gates have their own refusals earlier in
 * `writeObservation`, and failing them would short-circuit before the crew
 * resolution this file is about.
 */
function makeDb(cfg: { trips?: any[]; members?: any[]; errorTables?: string[] }) {
  const inserted: any[] = [];
  const bad = new Set(cfg.errorTables ?? []);
  function from(table: string) {
    let op: "select" | "insert" = "select";
    let payload: any = null;
    const eqs: [string, any][] = [];
    const ins: [string, any[]][] = [];
    let lteF: [string, string] | null = null;
    let gteF: [string, string] | null = null;
    let lim = Infinity, orderCol: string | null = null, orderAsc = true;
    const src = (): any[] => (table === "trips" ? cfg.trips ?? [] : table === "trip_members" ? cfg.members ?? [] : []);
    function rows() {
      let r = src().filter(
        (row: any) =>
          eqs.every(([c, v]) => row[c] === v) &&
          ins.every(([c, v]) => v.includes(row[c])) &&
          (!lteF || (row[lteF[0]] != null && row[lteF[0]] <= lteF[1])) &&
          (!gteF || (row[gteF[0]] != null && row[gteF[0]] >= gteF[1])),
      );
      if (orderCol) { const c = orderCol; r = [...r].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (orderAsc ? 1 : -1)); }
      return r.slice(0, lim);
    }
    const failure = () => ({ data: null, error: { message: `simulated unreadable ${table}` } });
    function run() {
      if (table === "feature_flags") return { data: { enabled: true }, error: null };
      if (table === "places") return { data: { id: PLACE }, error: null };
      if (table === "intel_contribution_consent") return { data: { enabled: true, withdrawn_at: null }, error: null };
      if (bad.has(table)) return failure();
      if (op === "insert") { const row = { id: "obs-1", schema_version: 1, ...payload }; inserted.push(row); return { data: row, error: null }; }
      return { data: rows()[0] ?? null, error: null };
    }
    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      lte(c: string, v: string) { lteF = [c, v]; return b; },
      gte(c: string, v: string) { gteF = [c, v]; return b; },
      order(c: string, o: { ascending: boolean }) { orderCol = c; orderAsc = o.ascending; return b; },
      limit(_n: number) { lim = _n; return Promise.resolve(bad.has(table) ? failure() : { data: rows(), error: null }); },
      maybeSingle() { return Promise.resolve(run()); },
      single() { return Promise.resolve(run()); },
      then(res: (r: any) => any) {
        if (bad.has(table) && op !== "insert") return Promise.resolve(failure()).then(res);
        return Promise.resolve(op === "insert" ? run() : { data: rows(), error: null }).then(res);
      },
    };
    return b;
  }
  return { from, _inserted: inserted };
}

const input = (over: Record<string, unknown> = {}) => ({
  subjectId: PLACE, claimType: "crowd.level", value: { level: "busy" },
  observedAt: new Date(Date.now() - 3_600_000).toISOString(), idempotencyKey: "k-1", ...over,
});

// Derived LAZILY: `deriveGroupKey` throws without a secret (privacy-critical,
// no fallback), and the secret is set in `before()`. As module constants these
// killed the file at import time and every case reported as one opaque failure.
const soloKey = () => deriveGroupKey(PLACE, { kind: "solo", actorId: ACTOR });
const crewKey = () => deriveGroupKey(PLACE, { kind: "crew", crewId: "trip-A" });

describe("§74.3 — an unreadable roster must not split the crew it could not read", () => {
  const prev = process.env.SESSION_SECRET;
  before(() => { process.env.SESSION_SECRET = "test-session-secret-please-ignore-0123456789"; });
  after(() => { if (prev === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prev; });

  it("X1 — an asserted partyId with an unreadable `trips` REFUSES, instead of minting a solo token", async () => {
    // The defect in one case. `trips` is unreadable, so `readAcceptedTripMembership`
    // cannot tell whether ACTOR is on trip-A. Before the fix this fell all the way
    // through to `partySize === "just_me"` and wrote the SOLO key — three crew
    // members doing this become three independent reports of one fact.
    const db = makeDb({ ...SHARED_CREW, errorTables: ["trips"] });
    const r = await writeObservation(db as any, ACTOR, input({ partyId: "trip-A", partySize: "just_me" }) as any);
    assert.equal(r.ok, false, `expected a refusal; the capture was written as ${JSON.stringify(db._inserted[0]?.group_key)}`);
    assert.equal((r as any).reason, "db_error");
    assert.equal(
      db._inserted.length, 0,
      "an observation whose group identity was never established must not reach the corpus",
    );
  });

  it("X2 — the same with no partySize: still a refusal, not a null group written as fact", async () => {
    // Without `just_me` the old code wrote `group_key: null`. That is not
    // harmless either: null means "counts as a person, never as a group", so a
    // crew of three still enters the corpus as three separate people.
    const db = makeDb({ ...SHARED_CREW, errorTables: ["trips"] });
    const r = await writeObservation(db as any, ACTOR, input({ partyId: "trip-A" }) as any);
    assert.equal(r.ok, false);
    assert.equal(db._inserted.length, 0);
  });

  it("X3 — an unreadable `trip_members` refuses too: the size is the other half of the read", async () => {
    // Here `trips` reads fine and ACTOR is the owner, so membership is TRUE —
    // but `readAcceptedCrewSize` cannot count the crew, so "is it SHARED?" has
    // no answer. The old code read that missing answer as "solo".
    const db = makeDb({ ...SHARED_CREW, errorTables: ["trip_members"] });
    const r = await writeObservation(db as any, ACTOR, input({ partyId: "trip-A", partySize: "just_me" }) as any);
    assert.equal(r.ok, false);
    assert.equal(db._inserted.length, 0);
  });

  it("X4 CONTROL — a GENUINE non-crew still falls through to the solo token", async () => {
    // The case that distinguishes this fix from "refuse whenever a partyId is
    // present". trip-solo is readable and really is solo: the `false` is a
    // FINDING, and a finding must still be acted on.
    const db = makeDb({ ...SOLO_TRIP });
    const r = await writeObservation(db as any, ACTOR, input({ partyId: "trip-solo", partySize: "just_me" }) as any);
    assert.equal(r.ok, true, "a readable solo trip must not be refused");
    assert.equal(db._inserted.length, 1);
    assert.equal(
      db._inserted[0].group_key, soloKey(),
      "a genuinely solo trip must still mint the per-actor solo token",
    );
  });

  it("X5 CONTROL — a readable SHARED crew still mints the crew token", async () => {
    // Without this, "refuse when unreadable" is satisfied by refusing always.
    const db = makeDb({ ...SHARED_CREW });
    const r = await writeObservation(db as any, ACTOR, input({ partyId: "trip-A", partySize: "just_me" }) as any);
    assert.equal(r.ok, true);
    assert.equal(db._inserted[0].group_key, crewKey(), "the healthy crew path stopped working");
    assert.notEqual(db._inserted[0].group_key, soloKey());
  });

  it("X6 CONTROL — no partyId at all is unaffected by an unreadable `trips`", async () => {
    // The fix is scoped to an ASSERTED partyId. A capture that never claimed a
    // crew has no crew answer to get wrong, and must not start erroring because
    // some other read failed.
    const db = makeDb({ trips: [], members: [], errorTables: ["trips"] });
    const r = await writeObservation(db as any, ACTOR, input({ partySize: "just_me" }) as any);
    assert.equal(r.ok, true, "a capture that asserted no crew was turned into an error");
    assert.equal(db._inserted[0].group_key, soloKey());
  });
});
