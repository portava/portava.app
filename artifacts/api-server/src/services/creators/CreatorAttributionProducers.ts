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
 * A cycle durably fixes its upper UUID before scanning; higher arrivals wait
 * for the next cycle. Only an empty bounded tail clears the cursor and bound.
 * Flag reads and checkpoints are not one transaction: a concurrent OFF toggle
 * after the last flag read may still allow that checkpoint to commit. OFF at
 * entry guarantees no writes; this does not introduce a stronger flag policy.
 */
import { randomUUID } from "node:crypto";
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
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export interface ProducerPassTally {
  scanned: number;
  alreadyAttributed: number;
  attributed: number;
  replayed: number;
  /** A completed booking whose buddy profile could not be read — named, never skipped silently. */
  noBeneficiary: number;
  refused: number;
  /** True when the pass used its scan budget before observing an exhausted tail. */
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
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PRODUCER_PAGE_SIZE ||
      !Number.isSafeInteger(maxScan) || maxScan < 1 || maxScan > PRODUCER_MAX_SCAN) {
    return fail("refused_by_model", "creator scan limits must be positive integers within the producer bounds");
  }
  const { data: head, error: headError } = await sc.from("creator_attribution_scan_cursors")
    .select("after_booking_id, cycle_upper_id, revision").eq("producer", "travel_partner").maybeSingle();
  if (headError) return classifyDbError(headError);
  if (!head) return fail("degraded_unavailable", "travel_partner scan cursor is not installed");
  if (typeof head.revision !== "string" || !UUID.test(head.revision) ||
      (head.after_booking_id !== null && (typeof head.after_booking_id !== "string" || !UUID.test(head.after_booking_id))) ||
      (head.cycle_upper_id !== null && (typeof head.cycle_upper_id !== "string" || !UUID.test(head.cycle_upper_id)))) {
    return fail("db_error", "travel_partner scan cursor is unreadable");
  }
  let afterBookingId: string | null = head.after_booking_id?.toLowerCase() ?? null;
  let cycleUpperId: string | null = head.cycle_upper_id?.toLowerCase() ?? null;
  if (afterBookingId !== null && (cycleUpperId === null || afterBookingId > cycleUpperId)) {
    return fail("db_error", "travel_partner scan cursor is outside its cycle bound");
  }
  let revision: string = head.revision;
  const checkpoint = async (nextBookingId: string | null, nextUpperId: string | null): Promise<CreatorServiceResult<null>> => {
    if (!(await creatorLedgerEnabled(sc))) return fail("disabled");
    const nextRevision = randomUUID();
    const { data: updated, error: updateError } = await sc.from("creator_attribution_scan_cursors")
      .update({ after_booking_id: nextBookingId, cycle_upper_id: nextUpperId, revision: nextRevision })
      .eq("producer", "travel_partner").eq("revision", revision)
      .select("after_booking_id, cycle_upper_id, revision").maybeSingle();
    if (updateError) return classifyDbError(updateError);
    if (!updated) return fail("stale_head", "travel_partner scan cursor advanced in another pass");
    if (updated.revision !== nextRevision || updated.after_booking_id !== nextBookingId || updated.cycle_upper_id !== nextUpperId) {
      return fail("db_error", "travel_partner scan checkpoint was not confirmed");
    }
    afterBookingId = nextBookingId;
    cycleUpperId = nextUpperId;
    revision = nextRevision;
    return { ok: true, value: null };
  };
  const tally: ProducerPassTally = {
    scanned: 0, alreadyAttributed: 0, attributed: 0, replayed: 0,
    noBeneficiary: 0, refused: 0, truncated: false, refusals: [],
  };

  if (cycleUpperId === null) {
    const { data: upperRows, error: upperError } = await sc.from("rent_buddy_bookings")
      .select("id").eq("status", TRAVEL_PARTNER_VERIFIED_STATUS)
      .order("id", { ascending: false }).limit(1);
    if (upperError) return classifyDbError(upperError);
    if (!Array.isArray(upperRows) || upperRows.length > 1 ||
        (upperRows.length === 1 && (!upperRows[0] || typeof upperRows[0].id !== "string" || !UUID.test(upperRows[0].id)))) {
      return fail("db_error", "creator scan upper bound is unreadable");
    }
    if (upperRows.length === 0) return { ok: true, value: tally };
    const started = await checkpoint(null, upperRows[0].id.toLowerCase());
    if (!started.ok) return started;
  }

  for (;;) {
    if (tally.scanned >= maxScan) { tally.truncated = true; break; }
    const requested = Math.min(pageSize, maxScan - tally.scanned);
    let query = sc
      .from("rent_buddy_bookings")
      .select("id, buddy_id, status")
      .eq("status", TRAVEL_PARTNER_VERIFIED_STATUS)
      .lte("id", cycleUpperId)
      .order("id", { ascending: true })
      .limit(requested);
    if (afterBookingId !== null) query = query.gt("id", afterBookingId);
    const { data: bookings, error } = await query;
    if (error) return classifyDbError(error);
    if (!Array.isArray(bookings) || bookings.length > requested) return fail("db_error", "creator booking scan returned an invalid page");
    const page: Array<{ id: string; buddy_id: string }> = [];
    let previousId = afterBookingId;
    for (const booking of bookings) {
      if (!booking || typeof booking.id !== "string" || !UUID.test(booking.id) ||
          typeof booking.buddy_id !== "string" || !UUID.test(booking.buddy_id) || booking.status !== TRAVEL_PARTNER_VERIFIED_STATUS) {
        return fail("db_error", "creator booking scan returned an incomplete or malformed row");
      }
      const bookingId = booking.id.toLowerCase();
      if ((previousId !== null && bookingId <= previousId) || cycleUpperId === null || bookingId > cycleUpperId) {
        return fail("db_error", "creator booking scan did not advance in UUID order within its cycle bound");
      }
      page.push({ id: bookingId, buddy_id: booking.buddy_id.toLowerCase() });
      previousId = bookingId;
    }
    if (page.length === 0) {
      const saved = await checkpoint(null, null);
      if (!saved.ok) return saved;
      break;
    }
    tally.scanned += page.length;

    const ids = page.map((b) => String(b.id));
    const { data: done, error: doneErr } = await sc
      .from("creator_attributions")
      .select("subject_id")
      .eq("creator_type", "travel_partner")
      .in("subject_id", ids);
    if (doneErr) return classifyDbError(doneErr);
    if (!Array.isArray(done) || done.some((row) => !row || typeof row.subject_id !== "string" || !UUID.test(row.subject_id))) {
      return fail("db_error", "creator attribution lookup returned an incomplete or malformed response");
    }
    const attributed = new Set(done.map((row) => row.subject_id.toLowerCase()));

    const todo = page.filter((b) => !attributed.has(String(b.id)));
    tally.alreadyAttributed += page.length - todo.length;
    if (todo.length > 0) {
      const buddyIds = [...new Set(todo.map((b) => String(b.buddy_id)))];
      const { data: buddies, error: buddyErr } = await sc
        .from("rent_buddy_profiles").select("id, user_id").in("id", buddyIds);
      if (buddyErr) return classifyDbError(buddyErr);
      if (!Array.isArray(buddies) || buddies.some((buddy) => !buddy || typeof buddy.id !== "string" || !UUID.test(buddy.id) ||
          (buddy.user_id !== null && (typeof buddy.user_id !== "string" || !UUID.test(buddy.user_id))))) {
        return fail("db_error", "creator beneficiary lookup returned an incomplete or malformed response");
      }
      const userOf = new Map(buddies.map((buddy) => [buddy.id.toLowerCase(), buddy.user_id]));

      for (const b of todo) {
        const beneficiary = userOf.get(String(b.buddy_id)) ?? null;
        if (!beneficiary) { tally.noBeneficiary++; continue; }
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
    const saved = await checkpoint(page[page.length - 1]!.id, cycleUpperId);
    if (!saved.ok) return saved;
  }
  return { ok: true, value: tally };
}
