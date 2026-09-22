/**
 * layoverEntryGate.ts — may this traveller legally enter the country they would
 * be leaving the airport into?
 *
 * WHY THIS EXISTS
 * ===============
 *
 * `adviseLeaving` answered "can I leave the airport?" from the CLOCK alone. It
 * returned `verdict: "yes"` to a traveller with ninety spare minutes while
 * listing *"Visa or transit-permit requirements for your nationality"* in
 * `unknowns[]` — a confident yes and a disclaimed unknown about the same act,
 * in the same response. Nothing under `services/airport/` ever read
 * `entry_requirements` or `traveler_passports`, both present since migration
 * 0169, so the caveat was the whole of the answer.
 *
 * NOT A SECOND ELIGIBILITY MECHANISM. Every fact here comes from
 * `lib/entryRequirements.ts` — the same curated corridor table, the same
 * `ENTRY_FLAG`, the same honesty contract — read through its own
 * `readCorridor`. This module resolves WHICH corridor a layover is asking
 * about (traveller's passport → airport's country); it does not hold, default
 * or infer corridor data of its own, and there is no second source to disagree
 * with the first.
 *
 * HOW IT REACHES THE ADVICE. As a fact on `LeaveAdviceFacts`, like
 * `travelTimeSource` and `liveConditions` before it. `adviseLeaving` stays the
 * one place a verdict is decided; this module only supplies what it could not
 * observe.
 */

import { ENTRY_FLAG, readCorridor } from "../../lib/entryRequirements.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { toCountryCode } from "../../lib/countryCodes.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "layoverEntryGate" });

/**
 * Why a corridor could not be resolved. FIVE distinct reasons, because each
 * needs something different from a different person: the flag needs an
 * operator, the passport needs this traveller, the airport country needs a
 * curator, the corridor row needs a curator with different data, and a failed
 * read needs nobody — it needs to be retried.
 *
 * Collapsing them would be the usual defect one level down: "we don't know"
 * printed identically whether the cause is fixable by the traveller in ten
 * seconds or not fixable by them at all.
 */
export type EntryUnresolvedReason =
  | "entry_intelligence_disabled"
  | "no_passport_on_file"
  | "airport_country_unknown"
  | "no_data_for_corridor"
  | "corridor_unreadable";

/**
 * The gate's answer.
 *
 *   permitted   a curated row says this passport may enter this country
 *               without a prior visa. The ONLY state that lets the clock's
 *               "yes" stand.
 *   refused     a curated row says entry needs something this traveller cannot
 *               obtain during a layover. Overrides any amount of spare time.
 *   unresolved  everything else, with the reason above. Never an assumption in
 *               the traveller's favour.
 */
export type EntryEligibility =
  | { state: "permitted"; corridor: { passportCountry: string; destinationCountry: string }; status: string }
  | { state: "refused"; corridor: { passportCountry: string; destinationCountry: string }; status: string }
  | { state: "unresolved"; reason: EntryUnresolvedReason };

/**
 * Corridor statuses that let a traveller walk out of the airport on the day.
 *
 * DELIBERATELY AN ALLOW-LIST. A status this module has never seen — a new
 * vocabulary entry, a typo, a NULL — is not permitted, because the failure
 * modes are not symmetric: wrongly refusing costs a traveller an afternoon,
 * wrongly permitting costs them a denied entry at a foreign border.
 */
const PERMITTED_STATUSES = new Set(["visa_free", "visa_on_arrival", "transit_visa_free"]);

/**
 * The country a layover's airport is IN, as something `toCountryCode` can
 * resolve — the code when the profile has a real one, otherwise the country
 * name.
 *
 * `buildFallbackProfile` gives a manually entered airport the placeholder code
 * `"XX"`, which is not a country and must not be read as one. The country NAME
 * on the same profile is the traveller's own `manual_country` and is real, so
 * a manual airport in Japan resolves its corridor rather than reporting the
 * country unknown. A manual session with no country at all carries the literal
 * "Unknown", which resolves to nothing — which is the right answer.
 */
export function layoverAirportCountry(
  airport: { countryCode?: string | null; country?: string | null },
): string | null {
  const code = airport.countryCode && airport.countryCode !== "XX" ? airport.countryCode : null;
  return code ?? airport.country ?? null;
}

/**
 * Resolve the entry corridor for a layover: this traveller's passport into the
 * country the airport sits in.
 *
 * `passportCountry` is the traveller's own passport, read from
 * `traveler_passports` — their primary if they marked one, otherwise their
 * oldest. A layover has no trip, so there is no `trip_traveler_passports`
 * selection to honour; picking the primary is the closest thing to the choice
 * they already made, and having several passports never silently picks the
 * most convenient one.
 */
export async function resolveLayoverEntry(
  sc: any,
  userId: string,
  airportCountryCode: string | null | undefined,
): Promise<EntryEligibility> {
  if (!(await isFlagEnabled(sc, ENTRY_FLAG))) {
    // isFlagEnabled is fail-closed, so an unreadable feature_flags table lands
    // here too. Both mean entry intelligence is not answering.
    return { state: "unresolved", reason: "entry_intelligence_disabled" };
  }

  const destinationCountry = toCountryCode(airportCountryCode ?? null);
  if (!destinationCountry) {
    return { state: "unresolved", reason: "airport_country_unknown" };
  }

  let passportCountry: string | null = null;
  try {
    const { data, error } = await sc
      .from("traveler_passports")
      .select("issuing_country, is_primary, created_at")
      .eq("user_id", userId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1);
    // A failed read is NOT "this traveller has no passport". One is fixable by
    // the traveller in the app; the other is not about them at all.
    //
    // App C2 wants BOTH halves: the traveller is told the corridor could not be
    // read, and an operator can find out why. A refusal nobody can explain is
    // only half of it, so the error is carried into the log rather than tested
    // and dropped.
    if (error) {
      logger.warn({ err: error, userId }, "traveler_passports unreadable — entry corridor unresolved");
      return { state: "unresolved", reason: "corridor_unreadable" };
    }
    passportCountry = toCountryCode((data as any[])?.[0]?.issuing_country ?? null);
  } catch (err) {
    logger.warn({ err, userId }, "traveler_passports read threw — entry corridor unresolved");
    return { state: "unresolved", reason: "corridor_unreadable" };
  }
  if (!passportCountry) {
    return { state: "unresolved", reason: "no_passport_on_file" };
  }

  const corridor = { passportCountry, destinationCountry };
  const read = await readCorridor(sc, passportCountry, destinationCountry);
  if (read.state === "unreadable") {
    logger.warn(
      { err: read.message, passportCountry, destinationCountry },
      "entry_requirements unreadable — entry corridor unresolved",
    );
    return { state: "unresolved", reason: "corridor_unreadable" };
  }
  if (read.state === "absent") {
    // `entry_requirements` has no INSERT in any migration — 0169 calls that its
    // honesty contract. So this is the state every real corridor is in until
    // somebody curates it, and it is an unknown, not a no.
    return { state: "unresolved", reason: "no_data_for_corridor" };
  }

  const status = String((read.row as any).status ?? "");
  return PERMITTED_STATUSES.has(status)
    ? { state: "permitted", corridor, status }
    : { state: "refused", corridor, status };
}
