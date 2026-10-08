/**
 * When does a booked service BEGIN? (OD-PAY-5: "Give a full refund for
 * cancellations before service begins.") The booking stores a LOCAL date and
 * time and no zone; the zone comes from the booking's city through the
 * curated city map (compass/CompassGraphEngine.ts cityTimezone). Only where no
 * zone is known does the conservative earliest-possible rule apply.
 *
 * The defect this pins (lane B wave-1 report, §6): every start was read as the
 * earliest instant in any zone (UTC+14), so a traveller cancelling up to 14
 * hours before a Miami start was refused the full refund the owner promised.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyServiceStart.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supabaseBookingPaymentStore } from "../services/payments/bookingPayments/supabaseStore.js";
import { serviceStartInstant } from "../services/payments/bookingPayments/serviceStart.js";
import { decideRefund } from "../services/payments/bookingPayments/refunds.js";

/** A client that answers the two reads loadBooking makes. */
function client(booking: Record<string, unknown>) {
  return {
    from(table: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: table === "rent_buddy_bookings" ? booking : table === "rent_buddy_profiles" ? { user_id: "buddy-user-1" } : null,
          error: null,
        }),
      };
      return q;
    },
  };
}

const row = (o: Record<string, unknown>) => ({
  id: "b-1", status: "confirmed", payment_status: "not_required", traveler_id: "t-1", buddy_id: "bp-1",
  country_code: "US", total_usd: "40.00", booking_date: "2026-08-20", start_time: "15:00:00", city: "Miami",
  completed_at: null, dispute_window_expires_at: null, is_test_booking: false, ...o,
});

describe("a booking's service start is read in its city's zone", () => {
  it("Miami 15:00 local on 2026-08-20 (EDT, UTC-4) begins at 19:00Z — not at the UTC+14 earliest instant", async () => {
    const r = await supabaseBookingPaymentStore(client(row({}))).loadBooking("b-1");
    assert.ok(r.ok && r.value);
    if (!r.ok || !r.value) return;
    assert.equal(r.value.startsAt, "2026-08-20T19:00:00.000Z");
    assert.equal(r.value.startBasis, "city_timezone");
  });

  it("so a traveller cancelling at 14:00 Miami time, one hour before the start, gets the FULL refund", async () => {
    const r = await supabaseBookingPaymentStore(client(row({}))).loadBooking("b-1");
    assert.ok(r.ok && r.value);
    if (!r.ok || !r.value) return;
    const d = decideRefund({
      trigger: "cancelled_before_service", role: "traveler", booking: r.value,
      payment: { amountCapturedMinor: 4400, amountRefundedMinor: 0 }, now: new Date("2026-08-20T18:00:00.000Z"),
    });
    assert.equal(d.ok, true, JSON.stringify(d));
  });

  it("Tokyo 09:30 local (JST, UTC+9, no DST) begins at 00:30Z", () => {
    assert.deepEqual(serviceStartInstant("2026-08-20", "09:30", "Tokyo"), { instant: "2026-08-20T00:30:00.000Z", basis: "city_timezone", timezone: "Asia/Tokyo" });
  });

  it("every launch city resolves to a zone (Fort Lauderdale, Miami, Manila, Tokyo, Da Nang, Bangkok)", () => {
    for (const city of ["Fort Lauderdale", "Miami", "Manila", "Tokyo", "Da Nang", "Bangkok"]) {
      const s = serviceStartInstant("2026-08-20", "12:00", city);
      assert.equal(s?.basis, "city_timezone", city);
    }
  });

  it("DST is honoured: Miami 15:00 in January (EST, UTC-5) begins at 20:00Z", () => {
    assert.equal(serviceStartInstant("2026-01-20", "15:00:00", "Miami")?.instant, "2026-01-20T20:00:00.000Z");
  });

  it("an UNKNOWN city keeps the conservative earliest-possible rule (local read as UTC+14), and says so", () => {
    assert.deepEqual(serviceStartInstant("2026-08-20", "15:00:00", "Nowhere-on-the-map"), { instant: "2026-08-20T01:00:00.000Z", basis: "earliest_possible", timezone: null });
  });

  it("a missing date or time has no start (the refund goes to support)", () => {
    assert.equal(serviceStartInstant("2026-08-20", null, "Miami"), null);
    assert.equal(serviceStartInstant(null, "10:00", "Miami"), null);
  });
});
