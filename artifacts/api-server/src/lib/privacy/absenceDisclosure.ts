/**
 * Trips spec §6.3 — the public preview "must not leak future absence from
 * home" (census-trips TR119). PURE: no I/O, no clock of its own.
 *
 * WHAT LEAKS. A public trip's preview carried `startDate` / `endDate`
 * whenever the host's `show_exact_dates` toggle was not false — and the
 * toggle defaults TRUE (0077) and the client sends it as true when unset.
 * So by default a public trip announced, to anyone, the dates its owner
 * would be away from home. That is the disclosure §6.3 names.
 *
 * THE RULE. While `trip_absence_guard_enabled` is on, a trip whose start
 * date is still ahead withholds both dates from the non-member preview,
 * whatever the toggle says (the toggle cannot tell "opted in" from "never
 * asked"), and the preview says so: `datesWithheld: "future_absence"`. A
 * trip already underway or past is not a future absence; its dates keep
 * following the toggle. With the guard off the preview is what it was, and
 * the decision says which flag would change that.
 *
 * "Today" is the UTC calendar date of `now`. A trip starting today is not
 * withheld: the absence has begun. Dates are compared as `YYYY-MM-DD`
 * strings, which is what `trips.start_date` is.
 */
export const ABSENCE_GUARD_FLAG = "trip_absence_guard_enabled";

export interface AbsenceDisclosureInput {
  start_date?: string | null;
  end_date?: string | null;
  show_exact_dates?: boolean | null;
}

export interface AbsenceDisclosure {
  /** True when the preview must carry no dates. */
  withholdDates: boolean;
  /** Appendix B reason, when withheld. */
  reason: "TRIP_PRIVACY_FUTURE_ABSENCE" | null;
  /** Why, in one sentence, for the ledger and the test. */
  detail: string;
}

export function absenceDisclosure(trip: AbsenceDisclosureInput, now: number, guardEnabled: boolean): AbsenceDisclosure {
  if (!guardEnabled) {
    return { withholdDates: false, reason: null, detail: `${ABSENCE_GUARD_FLAG} is off; dates follow show_exact_dates` };
  }
  const start = typeof trip.start_date === "string" ? trip.start_date.slice(0, 10) : null;
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return { withholdDates: false, reason: null, detail: "no start date: there is no absence to announce" };
  }
  const today = new Date(now).toISOString().slice(0, 10);
  if (start > today) {
    return {
      withholdDates: true,
      reason: "TRIP_PRIVACY_FUTURE_ABSENCE",
      detail: `the trip starts ${start}, after today (${today}): a public preview does not announce when the host will be away from home (§6.3)`,
    };
  }
  return { withholdDates: false, reason: null, detail: `the trip started ${start}, on or before today (${today}): not a future absence; dates follow show_exact_dates` };
}
