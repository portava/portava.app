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
  LayoverCertification,
  LayoverOfflineBundle,
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

export function describeDeadline(
  bundle: LayoverOfflineBundle | null | undefined,
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
