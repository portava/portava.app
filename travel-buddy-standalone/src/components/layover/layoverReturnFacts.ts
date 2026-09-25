/**
 * Layover §15 / §16 facts — the derivations behind the Safe Return card.
 *
 * ── WHY THIS FILE HAS NO IMPORTS THAT RUN ────────────────────────────────────
 * Everything here is pure and type-only-imported, so it can be exercised by the
 * node:test runner (`pnpm test`, scripts/run-node-tests.mjs) without dragging
 * react-native through esbuild. The staleness rule in particular is the kind of
 * thing that silently never fires, so it must be testable on its own.
 *
 * ── THE CLOCK ────────────────────────────────────────────────────────────────
 * `certifiedAt` and `staleAfter` are ABSOLUTE instants stamped by the server
 * (LayoverDegradedService.buildOfflineBundle). The comparison here is therefore
 * device-now against a server-issued instant, exactly as the server's own
 * `bundleFreshness` does it — not "bundle age measured from when this screen
 * mounted", which is the comparison that would make the stale badge never fire
 * on a bundle that was already old when it arrived.
 *
 * Device clock skew is real and NOT corrected for: there is no server-time
 * header on these responses to correct against, and inventing an offset would
 * be fabricating a freshness claim the server did not make. A device running
 * behind the server reads as "fresher"; that is clamped, not hidden — see
 * `bundleFreshness`.
 */
import type {
  AbortEffect,
  CrewNotifyUnavailableReason,
  LayoverAirportIntelligence,
  LayoverCertification,
  LayoverOfflineBundle,
  OfflineUnavailableReason,
  ReturnNowStatusCapability,
  SafeReturnPosture,
} from '../../services/layover.ts';

// ── §16 offline bundle freshness ──────────────────────────────────────────────

export interface BundleFreshness {
  /** Past `staleAfter`: the deadline in the bundle must be labelled stale. */
  stale: boolean;
  /** Whole minutes since the server certified the bundle. Never negative. */
  ageMinutes: number;
  /** Whole minutes until it goes stale; 0 once it has. */
  freshForMinutes: number;
  /** False when the bundle carries unparseable instants — treat as unknown. */
  known: boolean;
}

/**
 * Mirror of the server's `bundleFreshness` (LayoverDegradedService), including
 * the `>=` boundary: at exactly `staleAfter` the bundle IS stale.
 *
 * `known: false` is not the same as fresh. A bundle whose instants do not parse
 * cannot be claimed fresh, so callers must render it as "age unknown" rather
 * than as a live deadline — which is why staleness defaults to true there.
 */
export function bundleFreshness(
  bundle: Pick<LayoverOfflineBundle, 'certifiedAt' | 'staleAfter'> | null | undefined,
  nowMs: number,
): BundleFreshness {
  const certifiedMs = bundle ? new Date(bundle.certifiedAt).getTime() : NaN;
  const staleMs = bundle ? new Date(bundle.staleAfter).getTime() : NaN;
  if (!Number.isFinite(certifiedMs) || !Number.isFinite(staleMs)) {
    return { stale: true, ageMinutes: 0, freshForMinutes: 0, known: false };
  }
  return {
    stale: nowMs >= staleMs,
    ageMinutes: Math.max(0, Math.round((nowMs - certifiedMs) / 60_000)),
    freshForMinutes: Math.max(0, Math.round((staleMs - nowMs) / 60_000)),
    known: true,
  };
}

/**
 * What a screen is allowed to say about the deadline it is holding.
 *
 * `live` — inside the TTL; the deadline may be presented as current.
 * `stale` — past `staleAfter`; the deadline is the LAST CERTIFIED one and must
 *           be labelled as such, never shown as live truth (§16 L150).
 * `unknown` — the bundle did not parse; same treatment as stale.
 */
export type DeadlineStanding = 'live' | 'stale' | 'unknown';

export interface DeadlineTruth {
  standing: DeadlineStanding;
  freshness: BundleFreshness;
  /** Never null: the deadline survives everything else going dark. */
  hardReturnTime: string;
  /** Airport-local rendering the server sent with the bundle, when it did. */
  hardReturnLocal: string | null;
  /** The caption a stale/unknown deadline MUST carry. Null when live. */
  stalenessNotice: string | null;
}

/**
 * The bundle fields this reads, and only those.
 *
 * Widened from `LayoverOfflineBundle` so that a CACHED deadline
 * (`layoverDeadlineCache.cachedDeadlineAsBundle`) goes through THIS rule rather
 * than a second, gentler one written for the offline path. A whole bundle still
 * satisfies it; a second staleness rule is how a cache ends up presenting an
 * old answer as a current one.
 */
export type DeadlineBundle = Pick<
  LayoverOfflineBundle,
  'certifiedAt' | 'staleAfter' | 'returnDeadline'
>;

export function describeDeadline(
  bundle: DeadlineBundle | null | undefined,
  fallbackHardReturnTime: string,
  nowMs: number,
): DeadlineTruth {
  const freshness = bundleFreshness(bundle, nowMs);
  const hardReturnTime = bundle?.returnDeadline?.hardReturnTime ?? fallbackHardReturnTime;
  const hardReturnLocal = bundle?.returnDeadline?.hardReturnLocal ?? null;

  if (!freshness.known) {
    return {
      standing: 'unknown',
      freshness,
      hardReturnTime,
      hardReturnLocal,
      stalenessNotice: 'Last certified return time — age unknown. Re-check before you rely on it.',
    };
  }
  if (freshness.stale) {
    return {
      standing: 'stale',
      freshness,
      hardReturnTime,
      hardReturnLocal,
      stalenessNotice: `Last certified ${freshness.ageMinutes} min ago — this return time may be out of date.`,
    };
  }
  return { standing: 'live', freshness, hardReturnTime, hardReturnLocal, stalenessNotice: null };
}

// ── §2.1 certification, said plainly ─────────────────────────────────────────

/**
 * The one honest line about WHEN an answer was computed.
 *
 * It states `computedAt` and the versions that produced it. It deliberately
 * does NOT say "up to date", "live", or "just now" — the server publishes an
 * instant, not a freshness claim, and turning one into the other is exactly the
 * fabrication §2.1 forbids. `computedAt` is returned as an ISO instant; the
 * caller formats it in the airport's timezone.
 */
export interface CertificationSummary {
  computedAt: string;
  /** e.g. "engine 2026.09.02-3 · feasibility 2026.09.05-1" */
  versionLine: string;
  /** e.g. "confidence LOW · buffer p90" — the server's own words, lowered. */
  qualityLine: string;
  /** First 8 chars of the input digest — what a support screenshot needs. */
  inputHashShort: string;
}

export function summarizeCertification(cert: LayoverCertification | null | undefined): CertificationSummary | null {
  if (!cert) return null;
  return {
    computedAt: cert.computedAt,
    versionLine: `engine ${cert.engineVersion} · feasibility ${cert.feasibilityVersion}`,
    qualityLine: `confidence ${cert.confidence.toLowerCase()} · buffer ${cert.bufferPercentile}`,
    inputHashShort: cert.inputHash.slice(0, 8),
  };
}

// ── §15 posture, said plainly ────────────────────────────────────────────────

export type PostureTone = 'calm' | 'warn' | 'urgent' | 'critical';

export interface PostureHeadline {
  title: string;
  body: string;
  tone: PostureTone;
  /** Label for the abort control at this state. */
  actionLabel: string;
}

/**
 * The posture is the server's statement of what to do now. This maps it to
 * words and a tone; it never re-derives the state from the clock, because a
 * second derivation is a second answer.
 */
export function postureHeadline(posture: SafeReturnPosture | null | undefined): PostureHeadline {
  const state = posture?.returnState ?? 'NORMAL';
  switch (state) {
    case 'CONNECTION_AT_RISK':
      return {
        title: 'Your connection is at risk',
        body: 'You are past the time you needed to start back. Go to the airport now and talk to your airline.',
        tone: 'critical',
        actionLabel: 'Return to airport',
      };
    case 'RETURN_NOW':
      return {
        title: 'Head back to the airport now',
        body: 'You are at your hard return time. Anything still on the plan will not fit.',
        tone: 'urgent',
        actionLabel: 'Return to airport',
      };
    case 'RETURN_SOON':
      return {
        title: 'Start heading back soon',
        body: 'You are close to your hard return time. Wrap up what you are doing.',
        tone: 'warn',
        actionLabel: 'Return to airport',
      };
    default:
      return {
        title: 'You have time',
        body: 'Tap below any time to cancel the landside plan and head straight back.',
        tone: 'calm',
        actionLabel: 'Return to airport',
      };
  }
}

// ── §15.1 abort effects, said plainly ────────────────────────────────────────

/**
 * What actually happened, from `effects` — reported, never swallowed.
 *
 * Only the effects a traveller can act on or would be misled by are given a
 * line. `crew_notify_unavailable` is always present on this tree and says
 * nothing a traveller can use, so it is dropped rather than dressed up.
 */
export function describeAbortEffects(effects: readonly AbortEffect[]): string[] {
  const lines: string[] = [];
  for (const e of effects) {
    switch (e) {
      case 'itinerary_cancel_failed':
        lines.push('Your landside stops could NOT be cleared — check your plan.');
        break;
      case 'status_write_failed':
        lines.push('This layover could not be marked as returning.');
        break;
      case 'ledger_write_failed':
        lines.push('The abort was not recorded in your layover history.');
        break;
      default:
        break;
    }
  }
  return lines;
}

/**
 * `statusCapability` is an OPERATOR fact, not a traveller one: it says why the
 * session was or was not flipped to "returning". It is surfaced only when the
 * status was NOT applied, and only as an explanation for why the layover still
 * shows as active — never as a failure the traveller could fix.
 */
export function statusCapabilityNote(
  capability: ReturnNowStatusCapability | null | undefined,
  statusApplied: boolean,
): string | null {
  if (statusApplied) return null;
  switch (capability) {
    case 'flag_off':
    case 'flag_on_readers_not_widened':
      return 'Your layover stays open so you keep the countdown.';
    default:
      return null;
  }
}

// ── §16 L154 — the crew meeting point, cached ────────────────────────────────

/**
 * The server's `OfflineUnavailableReason` words, for a traveller.
 *
 * Same shape and same justification as `LayoverCrewSection`'s `REASON_TEXT`:
 * every one of these is a true state of the bundle and none of them is a
 * fault, so showing the raw code would make an honest absence look like a bug.
 *
 * EACH SENTENCE IS ABOUT THE BUNDLE, NOT ABOUT THE WORLD. `no_crew_storage`
 * says nothing is cached here; it does NOT say the traveller has no crew or
 * that their crew has no meeting point. The bundle is not in a position to
 * know either, and the online crew section — which is — answers those.
 */
const OFFLINE_REASON_TEXT: Record<OfflineUnavailableReason, string> = {
  no_routing_provider: 'no route was cached with it',
  no_envelope_geometry: 'no map area was cached with it',
  no_flight_feed: 'no confirmed flight status was cached with it',
  no_crew_storage: 'none was cached with this layover',
  no_phrase_catalogue: 'no phrases were cached with it',
};

export interface CrewMeetingPointFacts {
  /** The server's label, trimmed. Null whenever there is not one to show. */
  label: string | null;
  /** The server's own reason word when it marked the capability unavailable. */
  reason: OfflineUnavailableReason | null;
  /** Never empty — an absent meeting point is still a sentence, not a blank. */
  sentence: string;
}

/**
 * §16 L154 "Crew — cache meeting point", read off the bundle.
 *
 * THREE OUTCOMES AND THE LAST TWO ARE THE POINT.
 *
 *   a label      surfaced verbatim. It is the crew's own
 *                `meeting_point_label`, which a crewmate typed; this does not
 *                reformat, geocode or abbreviate it.
 *   unavailable  the server said so and said why. Named, not blank.
 *   no bundle    nothing was cached at all, which is its own sentence.
 *
 * `available: true` WITH A BLANK VALUE IS TREATED AS NO LABEL. A meeting point
 * of `"   "` on screen is the empty-result failure this tree has already paid
 * for three times today: it looks like an answer and is not one.
 */
export function describeCrewMeetingPoint(
  bundle: LayoverOfflineBundle | null | undefined,
): CrewMeetingPointFacts {
  const cap = bundle?.crewMeetingPoint;
  if (!cap) {
    return {
      label: null,
      reason: null,
      sentence: 'No crew meeting point is saved on this device.',
    };
  }
  const label = typeof cap.value === 'string' ? cap.value.trim() : '';
  if (cap.available && label) {
    return { label, reason: cap.reason ?? null, sentence: `Meet your crew at ${label}.` };
  }
  const why = cap.reason ? OFFLINE_REASON_TEXT[cap.reason] : null;
  return {
    label: null,
    reason: cap.reason ?? null,
    sentence: why
      ? `No crew meeting point saved — ${why}.`
      : 'No crew meeting point is saved on this device.',
  };
}

// ── §15.1 L144 — whether the crew was told ───────────────────────────────────

/**
 * The server's crew-notify reasons, for a traveller.
 *
 * Deliberately NOT exhaustive over a union: `CrewNotifyUnavailableReason` is
 * open because the vocabulary is the server's (see its docblock). A reason this
 * client has not been taught still produces the FACT — the crew was not told —
 * and simply omits the cause, rather than showing a raw code to a traveller or
 * inventing one that sounds plausible.
 */
const CREW_NOTIFY_REASON_TEXT: Record<string, string> = {
  no_crew_storage: 'there is nothing set up to reach them',
};

/**
 * §15.1 L144's CLIENT half — what the traveller is told about their own abort.
 *
 * ── THE BOUNDARY THIS FUNCTION IS CAREFUL ABOUT ──────────────────────────────
 * Notifying a crew that a member aborted is a DISCLOSURE ABOUT THAT MEMBER, and
 * whether it should happen at all is an owner decision that is NOT taken here
 * or anywhere else on this client. Nothing in this file, and nothing that calls
 * it, sends a notification, offers a control that would, or asks the server
 * for one.
 *
 * What it does is the other half, and that half is not optional: when the
 * server reports that the traveller's abort WAS broadcast to other people, the
 * traveller is entitled to know it happened. A surface that silently swallows
 * `crewNotified` is deciding — by omission — that a traveller need not be told
 * who was told about them.
 *
 * ── WHY IT READS THE FIELDS AND NOT `effects` ────────────────────────────────
 * `crew_notify_unavailable` is an effect MARKER that has been unconditionally
 * present on every abort this tree has ever served; `describeAbortEffects`
 * drops it for exactly that reason and two tests pin that it keeps doing so.
 * `crewNotified` and `crewNotifyUnavailableReason` are the VALUES, and a value
 * is what this reads.
 *
 * Returns `null` when the server reported neither — nothing happened, so
 * nothing is said. An empty string would be a sentence-shaped blank.
 */
export function describeCrewNotification(input: {
  crewNotified: readonly string[];
  crewNotifyUnavailableReason: CrewNotifyUnavailableReason | null;
}): string | null {
  const notified = input.crewNotified.length;
  if (notified > 0) {
    return notified === 1
      ? 'One crewmate was told you are heading back.'
      : `${notified} crewmates were told you are heading back.`;
  }
  const reason = input.crewNotifyUnavailableReason;
  if (!reason) return null;
  const why = CREW_NOTIFY_REASON_TEXT[reason];
  return why
    ? `Your crew was not told you are heading back — ${why}.`
    : 'Your crew was not told you are heading back.';
}

// ── §2.1 "degrades VISIBLY" · §22 airport maturity, said plainly ─────────────

/**
 * The traveller-facing sentence for where these minutes came from.
 *
 * Census L9 and L250 are one gap: the fallback ladder has always been real and
 * a traveller could never see which rung they were standing on. This turns the
 * server's derived provenance into words. It does NOT re-derive the provenance
 * — every branch below is keyed on `intel.tier`, which the server computed off
 * the certified record's own estimates.
 *
 * EVERY SENTENCE IS A CLAIM THE TREE CAN SUPPORT.
 *  - GENERIC says nothing about the airport went in, because nothing did.
 *  - AIRPORT_RECORD says addressable-not-curated rather than "configured for
 *    this airport": `airport_profiles`' buffer columns are `NOT NULL DEFAULT
 *    60/90/120/180/30/15/20`, so an uncurated row holds exactly the generic
 *    numbers and claiming otherwise would be the fabrication §2.1 forbids.
 *  - The live line is stated on EVERY rung but the last, because "we have no
 *    live airport conditions" is the half of L9 the ladder could never show.
 */
export type AirportIntelligenceTone = 'generic' | 'partial' | 'curated' | 'live';

export interface AirportIntelligenceSummary {
  tone: AirportIntelligenceTone;
  /** Short label for the rung, e.g. "Generic timings". */
  title: string;
  /** One sentence naming what the minutes are, and what they are not. */
  detail: string;
  /** Stated separately because its absence is the requirement, not a footnote. */
  liveLine: string;
}

export function summarizeAirportIntelligence(
  intel: LayoverAirportIntelligence | null | undefined,
  iataCode: string,
): AirportIntelligenceSummary | null {
  if (!intel) return null;
  const code = iataCode ? iataCode.toUpperCase() : 'this airport';
  const liveLine = intel.liveObserved
    ? 'A current airport observation is folded into these minutes.'
    : 'No live airport conditions — queues and traffic today are not measured.';

  switch (intel.tier) {
    case 'LIVE':
      return { tone: 'live', title: 'Live airport conditions', detail: `A current observation for ${code} is in these minutes.`, liveLine };
    case 'VERIFIED_RECORD':
      return {
        tone: 'curated',
        title: 'Verified airport record',
        detail: `${code} has a verified record and these minutes come from it.`,
        liveLine,
      };
    case 'AIRPORT_RECORD':
      return {
        tone: 'partial',
        title: 'Unverified airport record',
        detail: `${code} has a record of its own, but nobody has verified it — these minutes may simply be the defaults.`,
        liveLine,
      };
    default:
      return {
        tone: 'generic',
        title: 'Generic timings',
        detail: `Nothing about ${code} went into these minutes. They are this app's standard allowances for any airport.`,
        liveLine,
      };
  }
}
