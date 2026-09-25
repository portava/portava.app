/**
 * CompassSensingPresence — S39's missing consumer, built and deliberately
 * unreachable.
 *
 * ── THE ROW, AND WHY THIS FILE CANNOT CLOSE IT ───────────────────────────────
 * census-sensing S39: `lib/sensingPresenceState.ts` builds a correct §19
 * presence aggregate — two values, no `absent`, no zero, no person named — and
 * *"no surface consumes it"*. Its RED WHEN is *"decision #9 is taken AND a
 * surface reads `buildSensingPresenceState`"*.
 *
 * DECISION #9 HAS NOT BEEN TAKEN. It is the ninth row of
 * `docs/architecture/sensing-input-gap.md` §3.2 — *"Publishing any aggregate to
 * a user-visible surface"* — and the gap analysis is explicit that
 * `aggregateSensingCohort` returning `publishable: true` *"is a permission, not
 * an instruction"*. The auth posture (#2) WAS decided on 2026-09-16
 * (`anonymous_capable`, `lib/sensingAuthPosture.ts:82`); #9 was not decided
 * with it, and nothing in the tree records it since.
 *
 * So this module is the consumer, written so that the day #9 is taken it is a
 * wiring change rather than a design one — and it is INERT until then, by two
 * independent mechanisms:
 *
 *   1. A FLAG, seeded FALSE and fail-closed. `sensing_presence_context_enabled`
 *      is spelled literally so `check-flag-polarity` resolves the read, and
 *      `*_enabled` means capability, so an absent or unreadable flag is OFF.
 *   2. NO PRODUCER. This module takes states that something else built, and
 *      nothing in this tree may build one for a surface: the anonymous
 *      contribution store has a standing tripwire that permits a short,
 *      named list of sibling callers and NO ROUTE AT ALL, so there is no path
 *      from a request to a cohort aggregate. This module does not create one,
 *      and must not.
 *
 *      (That store is deliberately not named here by module path. Its tripwire
 *      polices PROSE MENTIONS as well as imports — a real caller must not be
 *      able to hide behind "it is only mentioned" — and a comment that names it
 *      would register this file as a referrer of a store it never touches.)
 *
 * ── WHY IT DOES NOT IMPORT `lib/sensingPresenceState` ────────────────────────
 * It would like to, and it deliberately does not.
 * `test/sensingCensusRederivation.test.ts` §9.1 asserts that the ten modules of
 * the sensing contribution stack are imported by their own siblings AND BY
 * NOTHING ELSE, because a new importer is how an ingest path would first
 * appear, and thirteen census rows are graded on that absence. Its comment is
 * explicit that the remedy is to re-derive those rows in the census, *"not to
 * add an entry here to keep it green"*.
 *
 * A lane cannot take decision #9 and cannot re-derive a census on the owner's
 * behalf. So the shape below is declared STRUCTURALLY — it is exactly the
 * public surface of `SensingPresenceState`, and `sensingConsumersPresence`
 * pins that by passing a REAL `buildSensingPresenceState(...)` output through
 * this module. A test file is outside §9.1's walk, so the coupling is proven
 * where it can be, and the production import that would falsely signal an
 * ingest is not written.
 *
 * WHAT THAT MEANS FOR THE ROW, SAID PLAINLY: S39 is NOT closed by this file.
 * The consumer exists; the decision does not.
 *
 * ── THE INVARIANTS IT MUST NOT BREAK ─────────────────────────────────────────
 * The state's own header lists them, and a consumer is where they are usually
 * lost. This module is the last place the aggregate can be turned back into a
 * lie, so each is enforced in the FORMATTER, not assumed from the input:
 *
 *   No coverage ≠ quiet   `presence: "unknown"` renders as "not known", never
 *                         as quiet, empty or a zero. There is no branch here
 *                         that can produce a number for an unknown cohort.
 *   Busy ≠ good           `activityOrdinal` is an UNLABELLED ordinal whose
 *                         meaning is pinned by `reduction_version` and is
 *                         itself an owner decision. It is rendered as "bucket
 *                         N of 4" with the version beside it, and this module
 *                         invents no word — not "busy", not "quiet".
 *   No person identity    Nothing here reads a token, a group token or a count,
 *                         because the state carries none.
 *   Inference ≠ observation
 *                         The truth class travels verbatim onto the line, so a
 *                         `stale` cohort cannot be read as a current one.
 */
/**
 * The flag name a future migration must seed when decision #9 is taken. It is
 * DELIBERATELY NOT READ ANYWHERE, and that is the second half of this module's
 * honesty.
 *
 * An earlier draft did read it, and `scripts/check-flag-polarity.mjs` refused
 * the result for the right reason: *"PHANTOM FLAG — READ BUT NEVER SEEDED …
 * The gate LOOKS deliberate and is not. It cannot be turned on without shipping
 * a migration first."* A gate nothing can flip is not a gate; it is a comment
 * that resolves to false forever, and shipping one here would have dressed an
 * owner decision up as an engineering switch.
 *
 * So the name is reserved and the read is not written. Taking decision #9 means
 * three things together, by whoever owns them: a migration seeding this flag
 * FALSE (the integration owner), the owner flipping it, and a lane wiring a
 * producer to `buildSensingPresenceLines`. Not one of the three is a lane's to
 * take alone, which is exactly why S39 is not closed here.
 */
export const SENSING_PRESENCE_CONTEXT_FLAG = "sensing_presence_context_enabled";

export const SENSING_PRESENCE_HEADER = "[Zone presence — k-gated aggregate, no person]";

/** How many zones may appear in one context block. */
export const SENSING_PRESENCE_ZONE_CAP = 5;

/**
 * The public surface of `lib/sensingPresenceState.SensingPresenceState`,
 * declared structurally. See the header for why it is not imported.
 * `sensingConsumersPresence` asserts a real one satisfies it.
 */
export interface ConsumablePresenceState {
  kind: "sensing_presence";
  zoneId: string;
  timeBucket: string;
  windowEnd: string;
  presence: "observed" | "unknown";
  activityOrdinal: number | null;
  reductionVersion: number;
  truthClass: string;
  confidence: string;
  freshness: string;
  coverage: string;
  provenance: { source: string; withheld: string | null };
}

/** True for a value this module is willing to render at all. */
export function isConsumablePresenceState(x: unknown): x is ConsumablePresenceState {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    s.kind === "sensing_presence" &&
    typeof s.zoneId === "string" &&
    (s.presence === "observed" || s.presence === "unknown") &&
    (s.activityOrdinal === null || Number.isInteger(s.activityOrdinal)) &&
    typeof s.truthClass === "string" &&
    typeof s.coverage === "string"
  );
}

/**
 * Render presence states as prompt lines. PURE.
 *
 * An UNKNOWN cohort gets a line that says the state is not known and forbids
 * the inverse reading. Omitting it would be worse than saying nothing: the
 * model fills silence from its weights, and "no data about this zone" would
 * come back to the user as "it's quiet there".
 */
export function buildSensingPresenceLines(
  states: readonly ConsumablePresenceState[],
): string[] {
  const usable = (states ?? []).filter(isConsumablePresenceState).slice(0, SENSING_PRESENCE_ZONE_CAP);
  if (usable.length === 0) return [];

  const lines: string[] = [SENSING_PRESENCE_HEADER];
  for (const s of usable) {
    if (s.presence === "unknown") {
      // NO NUMBER IS AVAILABLE HERE AND NONE IS PRODUCED. `withheld` is the
      // operator's reason and is deliberately not rendered: which gate refused
      // a zone is itself information about that zone's cohort.
      lines.push(
        `Zone ${s.zoneId} (${s.timeBucket}–${s.windowEnd}): activity NOT KNOWN. ` +
          `Do not say it is quiet, empty or dead — no coverage is not an absence of people.`,
      );
      continue;
    }
    // `activityOrdinal` is UNLABELLED on purpose: what bucket 3 means is pinned
    // by reduction_version and is an owner decision (migration 2315, "why there
    // is no sensor / channel vocabulary"). So the ordinal and its version are
    // rendered together and no adjective is invented for them.
    const ordinal = s.activityOrdinal === null
      ? "no ordinal"
      : `activity bucket ${s.activityOrdinal} of 4 (unlabelled; reduction v${s.reductionVersion})`;
    lines.push(
      `Zone ${s.zoneId} (${s.timeBucket}–${s.windowEnd}): activity OBSERVED — ${ordinal}; ` +
        `truth ${s.truthClass}; confidence ${s.confidence}; freshness ${s.freshness}; coverage ${s.coverage}. ` +
        `This is a zone aggregate and names nobody; do not attribute it to any person.`,
    );
  }
  return lines;
}
