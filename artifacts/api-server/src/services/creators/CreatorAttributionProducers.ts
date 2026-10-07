/**
 * CreatorAttributionProducers — the code that turns a recorded value event into
 * a creator attribution. census-discovery DV-56 (`07` §10 "value can be
 * attributed").
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `lib/creatorTypes.ts` names two of `07` §2's six types as having a producer —
 * Travel Partner (`lib/rentBuddyEarningsLedger.ts`) and Local Expert
 * (`services/intel/RewardOracle.ts`) — and census §17.2 measured that NEITHER
 * called `recordCreatorAttribution`. The service's only importer was its own
 * test. "Value can be attributed" was true of the table and false of the
 * product.
 *
 * ── TRAVEL PARTNER: WHAT IS ATTRIBUTED, AND WHEN ────────────────────────────
 * The value event is `verified_booking` (`07` §3). A rent-a-buddy booking
 * reaches `status = 'completed'` only when the TRAVELLER confirms it (or
 * completes it themselves — `routes/rentABuddy.ts`'s traveller-confirm and
 * complete transitions); a booking merely created, or marked complete by the
 * buddy alone (`completed_pending_traveler_confirmation`), is not attributed.
 * That traveller confirmation is the nearest thing the product records to a
 * verified booking. No payment is verified because none is taken (`09` §1;
 * pay-deposit / pay-full are 503 stubs) — whether "verified" should also
 * require a captured payment is an owner question (census §52), and this
 * producer does not answer it by waiting for one.
 *
 * One row per booking:
 *   creator_type travel_partner · subject booking · value_event_id = the booking
 *   beneficiary  the buddy's profile (rent_buddy_profiles.user_id)
 *   weight 1, confidence 1 — the buddy is the booking's provider of record
 *     (rent_buddy_bookings.buddy_id); there is no second party and so no split
 *     for `07` §7's undecided weighting rule to decide.
 *   gross 0, provisional share 0 — deliberately. The booking's money is ALREADY
 *     booked, as signed double-entry legs, in rent_buddy_earnings_entries by the
 *     booking routes (2901), under the owner-configured fee schedule. Restating
 *     it here, or booking it again in creator_earning_entries, would put one
 *     booking's money in two places; 3387 refuses the second and this producer
 *     does not attempt it. The attribution records WHO contributed WHICH value
 *     event; the amount is read from the ledger that holds it
 *     (`lib/creatorLedgerStatus.ts` links the two by booking id).
 *
 * ── LOCAL EXPERT: NOT WIRED, AND WHY ────────────────────────────────────────
 * Its value event is `post_visit_confirmation` on an `intel_claims` subject.
 * The reward pass (`lib/intelRewardScheduler.ts`) books an earning when "a
 * contributor's observation reached the served live state" — which is not a
 * post-visit confirmation, and mapping one onto the other is a product
 * decision; the pass also reads observations, not the intel_claims id the
 * subject must name, and its payee is a contributor TOKEN resolved per pass.
 * The intel stack (2277/2278/3002/3003) cannot be replayed on the local
 * harness, so a wiring could not be proved end to end either. Recorded as a
 * residual in census §52 rather than wired on a guess.
 *
 * FAIL-CLOSED on `creator_attribution_enabled` (2922, seeded FALSE): with it off
 * the pass reads the flag and nothing else, and writes nothing.
 *
 * ── AN ERASED BUDDY IS NEVER ATTRIBUTED (C-11 answer B, migration 3600) ─────
 * Account erasure keeps an anonymised TOMBSTONE profile with the SAME id, and
 * rent_buddy_profiles.user_id still points at it. So a booking the buddy
 * completed before their erasure but that was never attributed — every such
 * booking at once, the day the flag is turned on — would be attributed to the
 * erased id: the identity the erasure removed from the ledger, written back
 * into it (review of PR #592). Before writing, the pass reads the
 * beneficiaries' `profiles.account_status`; a tombstone (`deleted`) is counted
 * as `erasedBeneficiary` and skipped, and a read that fails or comes back with
 * no rows stops the pass rather than reading as "nobody was erased". 3600's
 * frozen guard refuses the same write in the database (CL452
 * `creator_ledger_subject_erased`) for any writer that does not ask first.
 */
import {
  creatorLedgerEnabled,
  classifyDbError,
  fail,
  recordCreatorAttribution,
  type CreatorServiceResult,
} from "./CreatorAttributionService.js";

/** The one booking status a traveller has confirmed. */
export const TRAVEL_PARTNER_VERIFIED_STATUS = "completed";

export const PRODUCER_PAGE_SIZE = 500;
/** Bound on one pass, so a large backlog drains over several ticks rather than one unbounded scan. */
export const PRODUCER_MAX_SCAN = 5_000;

export interface ProducerPassTally {
  scanned: number;
  alreadyAttributed: number;
  attributed: number;
  replayed: number;
  /** A completed booking whose buddy profile could not be read — named, never skipped silently. */
  noBeneficiary: number;
  /** A completed booking whose buddy's account was erased (tombstone profile): never attributed (3600 (4b)). */
  erasedBeneficiary: number;
  refused: number;
  /** True when the scan stopped at PRODUCER_MAX_SCAN with rows left. */
  truncated: boolean;
  refusals: Array<{ bookingId: string; reason: string }>;
}

/**
 * One pass of the Travel Partner producer: every completed booking without an
 * attribution gets one. Idempotent twice over — bookings already attributed are
 * skipped, and a race with another pass replays onto 2920's unique
 * idempotency key rather than writing a second row.
 */
export async function attributeCompletedTravelPartnerBookings(
  sc: any,
  opts: { pageSize?: number; maxScan?: number } = {},
): Promise<CreatorServiceResult<ProducerPassTally>> {
  if (!(await creatorLedgerEnabled(sc))) return fail("disabled");
  const pageSize = opts.pageSize ?? PRODUCER_PAGE_SIZE;
  const maxScan = opts.maxScan ?? PRODUCER_MAX_SCAN;
  const tally: ProducerPassTally = {
    scanned: 0, alreadyAttributed: 0, attributed: 0, replayed: 0,
    noBeneficiary: 0, erasedBeneficiary: 0, refused: 0, truncated: false, refusals: [],
  };

  for (let from = 0; ; from += pageSize) {
    if (tally.scanned >= maxScan) { tally.truncated = true; break; }
    const { data: bookings, error } = await sc
      .from("rent_buddy_bookings")
      .select("id, buddy_id, status")
      .eq("status", TRAVEL_PARTNER_VERIFIED_STATUS)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return classifyDbError(error);
    const page = (Array.isArray(bookings) ? bookings : []) as Array<{ id: string; buddy_id: string }>;
    if (page.length === 0) break;
    tally.scanned += page.length;

    const ids = page.map((b) => String(b.id));
    const { data: done, error: doneErr } = await sc
      .from("creator_attributions")
      .select("subject_id")
      .eq("creator_type", "travel_partner")
      .in("subject_id", ids);
    if (doneErr) return classifyDbError(doneErr);
    const attributed = new Set(((done ?? []) as any[]).map((r) => String(r.subject_id)));

    const todo = page.filter((b) => !attributed.has(String(b.id)));
    tally.alreadyAttributed += page.length - todo.length;
    if (todo.length > 0) {
      const buddyIds = [...new Set(todo.map((b) => String(b.buddy_id)))];
      const { data: buddies, error: buddyErr } = await sc
        .from("rent_buddy_profiles").select("id, user_id").in("id", buddyIds);
      if (buddyErr) return classifyDbError(buddyErr);
      const userOf = new Map(((buddies ?? []) as any[]).map((b) => [String(b.id), b.user_id ? String(b.user_id) : null]));

      // The beneficiaries' account state, so an erased buddy is never written back (header).
      const beneficiaryIds = [...new Set([...userOf.values()].filter((u): u is string => u !== null))];
      const statusOf = new Map<string, string>();
      if (beneficiaryIds.length > 0) {
        const { data: profiles, error: profileErr } = await sc
          .from("profiles").select("id, account_status").in("id", beneficiaryIds);
        if (profileErr) return classifyDbError(profileErr);
        if (!Array.isArray(profiles)) {
          return fail("db_error", "profiles: the beneficiaries' account state came back with no rows and no error; an unanswered read is not \"nobody was erased\"");
        }
        for (const p of profiles as any[]) {
          if (typeof p?.account_status === "string") statusOf.set(String(p.id), p.account_status);
        }
      }

      for (const b of todo) {
        const beneficiary = userOf.get(String(b.buddy_id)) ?? null;
        if (!beneficiary) { tally.noBeneficiary++; continue; }
        const accountStatus = statusOf.get(beneficiary);
        // No readable state for this person is not "active": counted, never attributed.
        if (accountStatus === undefined) { tally.noBeneficiary++; continue; }
        if (accountStatus === "deleted") { tally.erasedBeneficiary++; continue; }
        const r = await recordCreatorAttribution(sc, {
          creatorType: "travel_partner",
          subjectId: String(b.id),
          valueEventId: String(b.id),
          beneficiaryUserId: beneficiary,
          weight: 1,
          confidence: 1,
          grossRevenueMinor: 0,
          provisionalShareMinor: 0,
          fraudHold: false,
          fraudHoldReason: null,
        });
        if (!r.ok) {
          // A refusal that is about the whole pass stops it; one about this row is counted.
          if (r.reason === "disabled" || r.reason === "degraded_unavailable" || r.reason === "db_error") return r;
          tally.refused++;
          tally.refusals.push({ bookingId: String(b.id), reason: r.reason });
          continue;
        }
        if (r.replayed) tally.replayed++; else tally.attributed++;
      }
    }
    if (page.length < pageSize) break;
  }
  return { ok: true, value: tally };
}
