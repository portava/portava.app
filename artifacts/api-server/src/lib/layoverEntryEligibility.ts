/**
 * layoverEntryEligibility — can this traveller legally stand landside, at THIS
 * airport, on the passport they actually hold?
 *
 * WHY THIS EXISTS
 * ===============
 * `LayoverSafetyEngine.adviseLeaving` answered "can I leave the airport?" using
 * time arithmetic alone. It returned `verdict: "yes"` while listing
 *
 *     "Visa or transit-permit requirements for your nationality"
 *
 * in `unknowns[]` — a prose caveat attached to an affirmative answer. Meanwhile
 * `entry_requirements` and `traveler_passports` (migration 0169) had existed for
 * months and NOTHING under src/routes/airport.ts or src/services/airport/ ever
 * read them. The one surface where being wrong means a denied entry or a missed
 * flight was the one surface not consulting the entry data the product already
 * curates.
 *
 * A caveat is not a gate. This module is the gate.
 *
 * IT INVENTS NOTHING
 * ==================
 * Every input is an existing canonical source:
 *
 *   traveler_passports.issuing_country   the passport the user saved (0169)
 *   airport_profiles.country_code        where the airport actually is (0127)
 *   entry_requirements                   the admin-curated corridor (0169),
 *                                        read through lib/entryRequirements
 *                                        .lookupRequirement — not re-queried here
 *
 * There is no fallback country, no inferred nationality, no default status and
 * no guessed corridor. Anything not answerable from those three is UNRESOLVED,
 * and unresolved is a refusal to affirm — never a quiet pass.
 *
 * ENTRY_REQUIREMENTS IS EMPTY IN PRODUCTION, AND THAT IS THE POINT
 * ===============================================================
 * `entry_requirements` has no INSERT in any migration; 0169 calls this its
 * "HONESTY CONTRACT" — unknown corridors are explicit unknowns, never guessed.
 * So today every real session resolves to `no_data_for_corridor`, and
 * adviseLeaving can no longer say "yes" to anybody. That is the correct
 * behaviour for a system that does not know, and it is a visible product
 * consequence rather than a hidden one: the refusal names its own cause, so
 * curating a corridor row is all it takes to turn the answer back on.
 *
 * WHAT THE STATUS VOCABULARY IS READ TO MEAN
 * ==========================================
 * The six values are 0169's, not ours, and this module only READS them. The one
 * judgement here — which of them clear a SPONTANEOUS airport exit — is stated as
 * data in ENTRY_STATUS_POLICY below so it is reviewable and changeable in one
 * place, rather than being spread through conditionals:
 *
 *   visa_free            entry needs nothing arranged in advance      → permitted
 *   visa_on_arrival      entry is obtainable at the border            → permitted,
 *                        but the process costs time inside the layover window and
 *                        is surfaced as a condition, never hidden
 *   evisa                needs an application before travel           → not permitted
 *   visa_required        needs a visa before travel                   → not permitted
 *   special_authorization needs a permit before travel                → not permitted
 *   entry_restricted     entry is refused                             → not permitted
 *
 * "Not permitted" here means "not permitted to be affirmed by us for an
 * unplanned exit today" — a traveller who already holds the visa is welcome to
 * disregard it, which is what the disclaimer says.
 */
import { lookupRequirement, ENTRY_FLAG, DISCLAIMER } from "./entryRequirements.js";

/**
 * Compile-time tie between the literal passed to isFlagEnabled above and the
 * canonical constant. If ENTRY_FLAG is ever renamed, this assignment fails to
 * typecheck — so the flag-polarity scanner keeps its literal and the codebase
 * keeps its single source of truth.
 */
const ENTRY_FLAG_TIE: typeof ENTRY_FLAG = "passport_entry_intelligence_enabled";
void ENTRY_FLAG_TIE;
import { isFlagEnabled } from "./featureFlags.js";
import { logger as rootLogger } from "./logger.js";

export const entryEligibilityLogger = rootLogger.child({ lib: "layoverEntryEligibility" });

/** Why we could not answer. Each is a distinct, actionable cause — never merged. */
export type EntryUnresolvedReason =
  | "entry_intelligence_disabled"
  | "no_passport_on_file"
  | "airport_country_unknown"
  | "no_data_for_corridor"
  | "lookup_failed";

/** Why entry is not available even though we DID resolve it. */
export type EntryRefusedReason =
  | "requires_advance_authorization"
  | "entry_restricted";

export type EntryEligibility =
  | {
      state: "permitted";
      passportCountry: string;
      destinationCountry: string;
      status: string;
      /** Present when entry is obtainable but costs time/money at the border. */
      condition: string | null;
      officialSourceUrl: string | null;
      lastVerifiedAt: string | null;
      disclaimer: string;
    }
  | {
      state: "not_permitted";
      passportCountry: string;
      destinationCountry: string;
      status: string;
      reason: EntryRefusedReason;
      officialSourceUrl: string | null;
      lastVerifiedAt: string | null;
      disclaimer: string;
    }
  | {
      state: "unresolved";
      reason: EntryUnresolvedReason;
      /** Whatever we did manage to establish, for the UI to explain the gap. */
      passportCountry: string | null;
      destinationCountry: string | null;
      disclaimer: string;
    };

/**
 * The one judgement in this module, as data.
 *
 * `permitted` answers only "may this person cross the border without having
 * arranged something beforehand". It is not a claim that the trip is wise, that
 * the queue is short, or that the flight will wait — those are the time engine's
 * business, and both gates must pass.
 */
export const ENTRY_STATUS_POLICY: Readonly<
  Record<string, { permitted: boolean; condition: string | null; refusal: EntryRefusedReason | null }>
> = {
  visa_free: { permitted: true, condition: null, refusal: null },
  visa_on_arrival: {
    permitted: true,
    condition:
      "Entry is visa-on-arrival: budget queue time and any fee at the border inside your layover window.",
    refusal: null,
  },
  evisa: { permitted: false, condition: null, refusal: "requires_advance_authorization" },
  visa_required: { permitted: false, condition: null, refusal: "requires_advance_authorization" },
  special_authorization: { permitted: false, condition: null, refusal: "requires_advance_authorization" },
  entry_restricted: { permitted: false, condition: null, refusal: "entry_restricted" },
};

/** A status the curated table can hold but this policy has no entry for fails CLOSED. */
export function evaluateEntryStatus(status: unknown): { permitted: boolean; condition: string | null; refusal: EntryRefusedReason } | { permitted: true; condition: string | null } {
  const key = typeof status === "string" ? status : "";
  const row = ENTRY_STATUS_POLICY[key];
  if (!row) {
    // An unrecognised status is not an approval. This is the same fail-closed
    // posture normalizeConflictState uses for an unknown conflict marker: a
    // vocabulary someone widened without teaching this reader about it must
    // never become a green light.
    return { permitted: false, condition: null, refusal: "requires_advance_authorization" };
  }
  if (row.permitted) return { permitted: true, condition: row.condition };
  return { permitted: false, condition: row.condition, refusal: row.refusal ?? "requires_advance_authorization" };
}

export interface ResolveEntryInput {
  /** The traveller. Their own saved passports only — never another user's. */
  userId: string;
  /** ISO2 of the country the airport is in, from airport_profiles.country_code. */
  airportCountryCode: string | null | undefined;
}

const unresolved = (
  reason: EntryUnresolvedReason,
  passportCountry: string | null,
  destinationCountry: string | null,
): EntryEligibility => ({
  state: "unresolved",
  reason,
  passportCountry,
  destinationCountry,
  disclaimer: DISCLAIMER,
});

/**
 * Resolve whether this traveller may enter the country the airport sits in.
 *
 * FAIL-CLOSED THROUGHOUT. Flag off, no passport, unknown airport country, no
 * curated corridor and a failed read are five DIFFERENT unresolved reasons and
 * none of them is an approval. They are kept distinct because "we are not
 * allowed to tell you", "you have not told us your passport" and "we have no
 * data for this corridor" need three different things from the user, and
 * collapsing them into one silent "unknown" is how a gate becomes decorative.
 */
export async function resolveEntryEligibility(
  sc: any,
  input: ResolveEntryInput,
): Promise<EntryEligibility> {
  const destination =
    typeof input.airportCountryCode === "string" && /^[A-Za-z]{2}$/.test(input.airportCountryCode)
      ? input.airportCountryCode.toUpperCase()
      : null;

  if (!sc) return unresolved("lookup_failed", null, destination);

  // The same flag the rest of entry intelligence answers to. Layover does not
  // get a private door into curated entry data.
  let flagOn = false;
  try {
    // The LITERAL, not the imported constant, and deliberately so:
    // check:flag-polarity must be able to tell statically whether a flag is a
    // kill switch, and it refuses an argument it cannot resolve rather than
    // shrugging — "I could not tell which flag this is" and "this flag is fine"
    // must not look the same. ENTRY_FLAG_TIE below makes the two impossible to
    // drift apart: change the constant and this file stops compiling.
    flagOn = await isFlagEnabled(sc, "passport_entry_intelligence_enabled");
  } catch {
    return unresolved("lookup_failed", null, destination);
  }
  if (!flagOn) return unresolved("entry_intelligence_disabled", null, destination);

  // The traveller's own passport. `is_primary` first, then the oldest saved —
  // a deterministic choice, so the verdict does not change between two calls
  // for a user holding several passports.
  let passportCountry: string | null = null;
  try {
    const { data, error } = await sc
      .from("traveler_passports")
      .select("issuing_country, is_primary, created_at")
      .eq("user_id", input.userId)
      .limit(MAX_PASSPORTS_READ);
    if (error) return unresolved("lookup_failed", null, destination);
    const rows = (data as any[]) ?? [];
    const chosen =
      rows.find((r) => r?.is_primary === true) ??
      [...rows].sort((a, b) => String(a?.created_at ?? "").localeCompare(String(b?.created_at ?? "")))[0];
    const code = chosen?.issuing_country;
    passportCountry = typeof code === "string" && /^[A-Z]{2}$/.test(code) ? code : null;
  } catch {
    return unresolved("lookup_failed", null, destination);
  }
  if (!passportCountry) return unresolved("no_passport_on_file", null, destination);

  // Where the airport actually is. An airport row with no country_code cannot
  // anchor a corridor, and guessing one from the city name is exactly the kind
  // of invention this module refuses.
  if (!destination) return unresolved("airport_country_unknown", passportCountry, null);

  const row = await lookupRequirement(sc, passportCountry, destination);
  if (!row) return unresolved("no_data_for_corridor", passportCountry, destination);

  const status = String((row as any).status ?? "");
  const verdict = evaluateEntryStatus(status);
  const officialSourceUrl =
    typeof (row as any).official_source_url === "string" ? (row as any).official_source_url : null;
  const lastVerifiedAt =
    typeof (row as any).last_verified_at === "string" ? (row as any).last_verified_at : null;

  if (!verdict.permitted) {
    return {
      state: "not_permitted",
      passportCountry,
      destinationCountry: destination,
      status,
      reason: (verdict as { refusal: EntryRefusedReason }).refusal,
      officialSourceUrl,
      lastVerifiedAt,
      disclaimer: DISCLAIMER,
    };
  }

  return {
    state: "permitted",
    passportCountry,
    destinationCountry: destination,
    status,
    condition: verdict.condition ?? null,
    officialSourceUrl,
    lastVerifiedAt,
    disclaimer: DISCLAIMER,
  };
}

/** A user holding more passports than this is beyond what one layover call needs. */
const MAX_PASSPORTS_READ = 20;

/** Human-readable cause, for the UI to show instead of an unexplained refusal. */
export function entryEligibilityMessage(e: EntryEligibility): string {
  if (e.state === "permitted") {
    return e.condition ?? "Entry on your saved passport needs nothing arranged in advance.";
  }
  if (e.state === "not_permitted") {
    return e.reason === "entry_restricted"
      ? "Entry on your saved passport is restricted for this country."
      : "Entry on your saved passport needs a visa or permit arranged before travel.";
  }
  switch (e.reason) {
    case "entry_intelligence_disabled":
      return "Entry checks are unavailable right now, so we can't confirm you may leave the airport.";
    case "no_passport_on_file":
      return "Add the passport you're travelling on so we can check whether you may enter.";
    case "airport_country_unknown":
      return "We don't have a country on file for this airport, so we can't check entry rules.";
    case "no_data_for_corridor":
      return "We have no verified entry data for your passport and this country yet.";
    case "lookup_failed":
      return "We couldn't check entry rules just now — treat leaving the airport as unconfirmed.";
  }
}
